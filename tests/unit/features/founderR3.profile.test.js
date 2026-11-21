/**
 * @jest-environment node
 *
 * Round 3, profile owner: the résumé read from records tied to the person, with no model.
 * Every case here comes from an audit finding (eval/founder/audit-2026-11-20/by-owner/profile.json)
 * or from the graders' notes on the saved Ding (r8) and Glyman (r9) reports.
 */
const fs = require('fs');
const path = require('path');
const { createSubject } = require('../../../src/server/founder/identity');
const { buildProfile, publishProfile, leadsToSomeoneElse, maskSubject } = require('../../../src/server/founder/profile');

let seq = 0;
const rec = (o) => ({ id: `r${(seq += 1)}`, source: 'web-search', sourceLabel: 'Open-web search', category: 'press', severity: 'info', quote: '', match: 'confirmed', url: `https://x.test/${seq}`, date: null, ...o });

/** Every record of a saved report (its sections, red flags and lists hold the full records). */
function saved(file) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../eval/founder/runs', file), 'utf8'));
  const items = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    if (v.id && 'quote' in v && v.source) items.set(v.id, v);
    Object.values(v).forEach(walk);
  };
  walk(d);
  const numberOf = new Map((d.sources || []).map((s) => [s.id, s.n]));
  return { d, findings: [...items.values()], threads: (d.threads || []).map((t) => ({ ...t, trusted: true })), numberOf };
}
const orgs = (list) => list.map((x) => x.org);

describe('critical: a colleague\'s or interviewer\'s job is never the person\'s (profile-colleague-job)', () => {
  const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
  const wrong = [
    ['Eric Glyman co-founded Ramp with Karim Atiyeh, who previously worked at Goldman Sachs.', 'Goldman Sachs'],
    ['Eric Glyman met Karim Atiyeh, a former engineer at Google.', 'Google'],
    ['Eric Glyman was interviewed by Jane Doe, previously at Bloomberg.', 'Bloomberg'],
    ['Eric Glyman said investors include Keith Rabois, formerly at PayPal.', 'PayPal'],
  ];
  test.each(wrong)('%s', (quote, org) => {
    const p = buildProfile(eric, [rec({ title: 'Story', quote })]);
    expect(orgs(p.earlier)).not.toContain(org);
    expect(orgs(p.resume.roles)).not.toContain(org);
  });
  test('a hired person\'s school is not theirs', () => {
    const p = buildProfile(eric, [rec({ title: 'Story', quote: 'Eric Glyman hired Jane Doe, who graduated from Stanford University.' })]);
    expect(p.education).toEqual([]);
    expect(p.resume.education).toEqual([]);
  });
  test('founded, boards and investments of someone else in the sentence are not theirs', () => {
    const p = buildProfile(eric, [rec({ title: 'Story', quote: 'Eric Glyman hired Bob Smith, who founded Initech and sits on the board of Globex. Eric Glyman met Jane Doe, an angel investor in Hooli.' })]);
    expect(orgs(p.resume.founded)).not.toContain('Initech');
    expect(orgs(p.resume.boards)).not.toContain('Globex');
    expect(p.resume.investments.map((x) => x.org)).not.toContain('Hooli');
  });
  test('their own forms are kept: previously, before founding, joint subjects', () => {
    const p = buildProfile(eric, [
      rec({ title: 'A', quote: 'Eric Glyman previously worked at Goldman Sachs.' }),
      rec({ title: 'B', quote: 'Before founding Ramp, Eric Glyman worked at Millstein & Co.' }),
      rec({ title: 'C', quote: 'Eric Glyman and Karim Atiyeh worked at Capital One.' }),
    ]);
    expect(orgs(p.earlier)).toEqual(expect.arrayContaining(['Goldman Sachs', 'Millstein & Co.', 'Capital One']));
  });
  test('the shared guard is exported', () => {
    expect(leadsToSomeoneElse(eric, maskSubject(eric, 'Eric Glyman co-founded Ramp with Karim Atiyeh, who previously worked at '))).toBe(true);
    expect(leadsToSomeoneElse(eric, maskSubject(eric, 'Eric Glyman previously worked at '))).toBe(false);
  });
});

describe('patterns the tied records state (profile-threads-and-patterns)', () => {
  const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
  test('a venture they co-founded, with its acquirer as the outcome, never as an employer', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman is the co-founder of Ramp. Previously, he co-founded Paribus, which was acquired by Capital One in 2016.' })]);
    const paribus = p.resume.founded.find((x) => x.org === 'Paribus');
    expect(paribus).toBeTruthy();
    expect(paribus.outcome).toMatch(/acquired by Capital One/);
    expect(orgs(p.resume.roles)).not.toContain('Capital One');
  });
  test('"joined X" and "worked at a startup called X"', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman joined Capital One in 2016.' })]);
    expect(orgs(p.earlier)).toContain('Capital One');
    const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const q = buildProfile(shensi, [rec({ source: 'page-reader', data: { kind: 'bio' }, title: 'Shensi Ding — Merge', quote: 'Before leaping into her first startup Shensi worked at a startup called Expanse, and that experience taught her a lot.' })]);
    expect(orgs(q.earlier)).toContain('Expanse');
  });
  test('trusted company and school threads are only a lookup into tied records, never a source', () => {
    const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const p = buildProfile(shensi, [], [{ kind: 'company', value: 'Expanse', trusted: true }, { kind: 'school', value: 'Columbia University', trusted: true }]);
    expect(p.earlier).toEqual([]);
    expect(p.education).toEqual([]);
  });
});

describe('structured fields (profile-wikidata-ignored, profile-structured-data)', () => {
  const milton = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
  const wd = (o) => rec({ source: 'wikidata', sourceLabel: 'Wikidata', ...o });
  test('Wikidata employer, CEO with end time, founded by, educated at', () => {
    const p = buildProfile(milton, [
      wd({ category: 'career', title: 'Trevor Milton at Nikola Corporation: founder; chief executive officer (2014 to 2020-09)', quote: 'Nikola Corporation: founded by Trevor Milton. Nikola Corporation: chief executive officer Trevor Milton (start time 2014; end time 2020-09). Trevor Milton: employer Nikola Corporation (start time 2014; end time 2020)', date: '2014' }),
      wd({ category: 'education', title: 'Trevor Milton: educated at Utah Valley University', quote: 'Trevor Milton: educated at Utah Valley University' }),
    ]);
    const nikola = p.resume.roles.find((r) => r.org === 'Nikola');
    expect(nikola).toEqual(expect.objectContaining({ from: 2014, to: 2020, current: false, basis: 'record' }));
    expect(p.resume.founded.map((f) => f.org)).toContain('Nikola');
    expect(p.resume.education[0]).toEqual(expect.objectContaining({ school: 'Utah Valley University', basis: 'record' }));
  });
  test('Wikidata degree and major, and a board seat', () => {
    const holmes = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const p = buildProfile(holmes, [
      wd({ category: 'education', title: 'Elizabeth Holmes: educated at Stanford University', quote: 'Elizabeth Holmes: educated at Stanford University (academic degree Bachelor of Science; academic major chemical engineering; start time 2002; end time 2004)' }),
      wd({ category: 'career', title: 'Elizabeth Holmes at Foo Corp: board member', quote: 'Foo Corp: board member Elizabeth Holmes (start time 2010)' }),
      wd({ category: 'career', title: 'Elizabeth Holmes at Capital One', quote: 'Elizabeth Holmes: employer Capital One (start time 2001; end time 2002)' }),
    ]);
    expect(p.resume.education[0]).toEqual(expect.objectContaining({ school: 'Stanford University', degree: 'Bachelor of Science', field: 'chemical engineering', from: 2002, to: 2004 }));
    expect(p.resume.boards[0]).toEqual(expect.objectContaining({ org: 'Foo Corp', from: 2010 }));
    expect(p.resume.roles.find((r) => r.org === 'Capital One')).toEqual(expect.objectContaining({ from: 2001, to: 2002, current: false }));
  });
  test('a Wikidata record matched by name only gives nothing', () => {
    const p = buildProfile(milton, [wd({ match: 'possible', quote: 'Trevor Milton: employer Acme Widgets (start time 1990)' })]);
    expect(p.resume.roles).toEqual([]);
  });
  test('schema.org Person data on a page matched to the person', () => {
    const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const p = buildProfile(shensi, [rec({ source: 'page-reader', category: 'career', title: 'Page data', quote: 'Shensi Ding — works for: Merge; Expanse; alumni of: Columbia University.', data: { kind: 'facts', structured: { titles: ['CEO'], employers: ['Merge', 'Expanse'], schools: ['Columbia University'], cofounders: ['Gil Feig'], foundersOf: ['Merge'] } } })]);
    expect(orgs(p.earlier)).toContain('Expanse');
    expect(p.education.map((e) => e.school)).toContain('Columbia University');
    expect(p.resume.founded.find((f) => f.org === 'Merge')).toEqual(expect.objectContaining({ with: ['Gil Feig'] }));
  });
  test('BrokerCheck firms and dates from a tied record are a role; a name-only one whose dates fit a banking bio is a lead', () => {
    const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const broker = (match) => rec({ source: 'finra-brokercheck', category: 'regulatory', match, title: 'Shensi Ding (CRD 6203724): no disclosures on the BrokerCheck record', quote: 'Shensi Ding, CRD 6203724: broker registration inactive. Firms: Credit Suisse Securities (USA) LLC (2015-08-11 to 2017-08-01). No disclosures.', data: { crd: '6203724', firms: ['Credit Suisse Securities (USA) LLC'], disclosures: 0 }, date: '2017-08-01' });
    const tied = buildProfile(shensi, [broker('likely')]);
    expect(tied.resume.roles.find((r) => /Credit Suisse/.test(r.org))).toEqual(expect.objectContaining({ from: 2015, to: 2017, current: false, basis: 'record' }));
    const bio = rec({ source: 'page-reader', data: { kind: 'bio' }, title: 'Podcast', quote: 'In this episode, Shensi Ding, Co-Founder and CEO of Merge, shares her journey from investment banking to leading Merge.' });
    const grad = rec({ source: 'page-reader', data: { kind: 'bio' }, title: 'Accel', quote: 'The journey began in 2015 after Shensi and Gil graduated from Columbia University.' });
    const loose = buildProfile(shensi, [broker('possible'), bio, grad]);
    expect(loose.resume.roles.find((r) => /Credit Suisse/.test(r.org))).toBeUndefined();
    expect(orgs(loose.earlier).join(' ')).not.toMatch(/Credit Suisse/);
    const lead = loose.resume.leads.find((l) => /Credit Suisse/.test(l.text));
    expect(lead).toBeTruthy();
    expect(lead.ids.length).toBeGreaterThanOrEqual(2);
    // without a bio that says banking, nothing
    expect(buildProfile(shensi, [broker('possible')]).resume.leads).toEqual([]);
  });
  test('SEC Form D and insider officer roles; a legal name of the company is the company', () => {
    const p = buildProfile(milton, [
      rec({ source: 'sec-filings', category: 'corporate', title: 'Insider reports: Trevor Milton filed as director and officer (Executive Chairman) of Nikola Corp', quote: 'Reporting owner: Milton Trevor R.; issuer: Nikola Corp (NKLA)', data: { issuer: 'Nikola Corp', roles: ['owner of more than 10%', 'director', 'officer (Executive Chairman)'], firstReport: '2020-06-05', lastReport: '2022-08-24' }, date: '2022-08-24' }),
      rec({ source: 'sec-company', category: 'corporate', title: 'Form D filed by dHybrid, Inc. names Trevor Milton as Executive Officer and Director', quote: 'Issuer: dHybrid, Inc. (Corporation, NEVADA); year of incorporation: 2009; related person: Trevor Robert Milton, Executive Officer and Director', data: { form: 'D', issuer: 'dHybrid, Inc.', relatedPersons: [{ name: 'Trevor Robert Milton', roles: ['Executive Officer', 'Director'] }] }, date: '2011-12-02' }),
    ]);
    expect(p.resume.roles.find((r) => r.org === 'dHybrid, Inc.')).toEqual(expect.objectContaining({ title: 'Executive Officer and Director', basis: 'record' }));
    expect(orgs(p.resume.roles)).not.toContain('Nikola Corp');
    expect(p.resume.roles.find((r) => r.org === 'Nikola').title).toMatch(/Executive Chairman/);
  });
});

describe('the surname alone in their own encyclopedia article (profile-wikipedia-surname)', () => {
  const holmes = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
  test('career and education sentences that open on the surname', () => {
    const p = buildProfile(holmes, [rec({ source: 'wikipedia', category: 'career', title: 'Elizabeth Holmes: career as described on Wikipedia ("Career")', quote: 'Holmes worked at the Genome Institute of Singapore. In 2003, Holmes founded Real-Time Cures. Holmes studied chemical engineering at Stanford University.' })]);
    expect(orgs(p.earlier)).toContain('Genome Institute of Singapore');
    expect(p.resume.founded.find((f) => f.org === 'Real-Time Cures')).toEqual(expect.objectContaining({ year: 2003 }));
    expect(p.resume.education[0]).toEqual(expect.objectContaining({ school: 'Stanford University', field: 'chemical engineering' }));
  });
  test('not when another person with that surname is named in the record', () => {
    const p = buildProfile(holmes, [rec({ source: 'wikipedia', category: 'career', title: 'Elizabeth Holmes: early life', quote: 'Her father Christian Holmes was an executive. Holmes worked at Enron.' })]);
    expect(orgs(p.earlier)).not.toContain('Enron');
  });
  test('not on another person\'s article', () => {
    const p = buildProfile(holmes, [rec({ source: 'wikipedia', category: 'press', title: 'Sherlock Holmes', quote: 'Holmes worked at Baker Street Detective Agency.' })]);
    expect(p.earlier).toEqual([]);
  });
});

describe('LinkedIn snippet shapes (profile-li-snippet-shapes)', () => {
  const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
  test('headline from "Name - Headline - Company | LinkedIn" and the compact snippet', () => {
    const p = buildProfile(eric, [rec({ category: 'identity', url: 'https://www.linkedin.com/in/eric-glyman', title: 'Eric Glyman - Co-Founder & CEO - Ramp | LinkedIn', quote: 'Eric Glyman. Co-Founder & CEO at Ramp. Ramp Harvard University. New York, New York, United States.' })]);
    expect(p.headline).toBe('Co-Founder and CEO, Ramp');
    expect(p.education.map((e) => e.school)).toContain('Harvard University');
  });
  test('any headline up to 60 characters when no C-suite title is given', () => {
    const keith = createSubject({ name: 'Keith Rabois', company: 'Founders Fund' });
    const p = buildProfile(keith, [rec({ category: 'identity', url: 'https://www.linkedin.com/in/keithrabois', title: 'Keith Rabois - Partner - Founders Fund | LinkedIn', quote: '' })]);
    expect(p.headline).toBe('Partner, Founders Fund');
  });
  test('a snippet on a namesake\'s handle is not read', () => {
    const p = buildProfile(eric, [rec({ category: 'identity', url: 'https://www.linkedin.com/in/someone-else', title: 'Eric Glyman - Partner - Initech | LinkedIn', quote: 'Experience: Initech · Education: Ohio State University' })]);
    expect(orgs(p.earlier)).not.toContain('Initech');
    expect(p.education).toEqual([]);
  });
  test('the Crunchbase "Title, Org (from - to)" and "Education: BA, Field, School" layout', () => {
    const p = buildProfile(eric, [rec({ source: 'web-archive', category: 'archive', match: 'likely', url: 'https://web.archive.org/web/20201102133917/https://www.crunchbase.com/person/eric-glyman', title: 'Crunchbase profile as of 2020-11-02: Co-Founder, CEO, Paribus (? - 2019)', quote: 'Eric Glyman | Experience: Co-Founder, CEO, Paribus (2014 - Feb 2019) | Education: BA, Economics, East Asian Studies, Harvard College', data: { kind: 'snapshot', page: 'https://www.crunchbase.com/person/eric-glyman', capturedAt: '2020-11-02' }, date: '2020-11-02' })]);
    const paribus = p.resume.roles.find((r) => r.org === 'Paribus');
    expect(paribus).toEqual(expect.objectContaining({ title: 'Co-Founder and CEO', from: 2014, to: 2019, current: false }));
    expect(p.resume.founded.find((f) => f.org === 'Paribus')).toEqual(expect.objectContaining({ year: 2014 }));
    expect(p.resume.education[0]).toEqual(expect.objectContaining({ school: 'Harvard College', degree: 'BA', field: 'Economics, East Asian Studies' }));
  });
});

describe('degree, field, boards, investments and recognition (profile-degree-fields)', () => {
  const jane = createSubject({ name: 'Jane Roe', company: 'Acme' });
  test('degree and field beside the school', () => {
    const p = buildProfile(jane, [rec({ title: 'Bio', quote: 'Jane Roe earned a B.A. in Economics from Harvard University in 2012.' })]);
    expect(p.education[0]).toEqual(expect.objectContaining({ school: 'Harvard University', degree: 'BA', field: 'Economics', to: 2012 }));
  });
  test('boards, recognition and investments', () => {
    const p = buildProfile(jane, [
      rec({ title: 'Bio', quote: 'Jane Roe sits on the board of Globex. Jane Roe was named to the Forbes 30 Under 30 list in 2022. Jane Roe is an angel investor in Hooli and Pied Piper.' }),
    ]);
    expect(p.resume.boards[0]).toEqual(expect.objectContaining({ org: 'Globex' }));
    expect(p.resume.recognition[0]).toEqual(expect.objectContaining({ year: 2022 }));
    expect(p.resume.recognition[0].text).toMatch(/Forbes 30 Under 30/);
    expect(p.resume.investments.map((x) => x.org)).toEqual(expect.arrayContaining(['Hooli', 'Pied Piper']));
  });
  test('the privacy rules apply to every profile line', () => {
    const p = buildProfile(jane, [rec({ title: 'Bio', quote: 'Jane Roe previously worked at Stripe while treated for depression. Jane Roe previously worked at Globex.' })]);
    expect(orgs(p.earlier)).toEqual(['Globex']);
  });
});

describe('current roles: newer records outvote older ones; "CEO" is not inside "co-CEO"', () => {
  const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
  test('co-CEO since 2026', () => {
    const p = buildProfile(eric, [
      rec({ title: 'Ramp CEO Eric Glyman on the new round', date: '2025-03-03' }),
      rec({ title: 'Inside Ramp with CEO Eric Glyman', quote: 'Eric Glyman, the CEO of Ramp, spoke.', date: '2026-06-04' }),
      rec({ title: 'Ramp Co-Founder and Co-CEO Eric Glyman on AI adoption', date: '2026-11-04' }),
      rec({ title: 'Eric Glyman, Co-Founder & Co-CEO, Ramp' }),
    ]);
    expect(p.headline).toBe('Co-Founder and Co-CEO, Ramp');
    const ramp = p.resume.roles.find((r) => r.org === 'Ramp');
    expect(ramp).toEqual(expect.objectContaining({ current: true }));
    expect(ramp.title).toMatch(/Co-CEO/);
  });
  test('a founder who resigned holds no role there now (Trevor Milton)', () => {
    const milton = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const p = buildProfile(milton, [
      rec({ title: 'Nikola founder and CEO Trevor Milton unveils truck', date: '2019-04-16' }),
      rec({ title: 'Disgraced Nikola CEO Trevor Milton podcast', date: '2025-05-01' }),
      rec({ source: 'wikipedia', title: 'Trevor Milton (Wikipedia, summary)', quote: 'In 2020, Milton resigned as executive chairman of Nikola following regulatory inquiries.', date: '2020' }),
      rec({ source: 'wikidata', title: 'Trevor Milton at Nikola Corporation', quote: 'Nikola Corporation: founded by Trevor Milton. Nikola Corporation: chief executive officer Trevor Milton (start time 2014; end time 2020-09)', date: '2014' }),
      rec({ source: 'wikipedia', category: 'identity', title: 'Trevor Milton: American businessman (Wikipedia article)', quote: 'Trevor Robert Milton is an American entrepreneur. He was later granted a presidential pardon, and is now the chief executive officer of SyberJet Aircraft, a Utah-based aviation company.' }),
    ]);
    const nikola = p.resume.roles.find((r) => r.org === 'Nikola');
    expect(nikola.current).toBe(false);
    expect(p.headline).toMatch(/^Founder, Nikola/);
    expect(p.headline).toMatch(/former/);
    expect(p.resume.roles.find((r) => r.org === 'SyberJet Aircraft')).toEqual(expect.objectContaining({ current: true }));
  });
});

describe('profile links (profile-link-pick, profile-interviewer-substack)', () => {
  const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
  test('an interviewer\'s newsletter is not their Substack', () => {
    const p = buildProfile(shensi, [], [
      { kind: 'url', value: 'https://notanotherceo.substack.com', why: 'substack profile', platform: 'substack', trusted: true },
      { kind: 'url', value: 'https://x.com/shensi', why: 'x profile', platform: 'x', trusted: true },
    ]);
    expect(p.links.map((l) => l.platform)).toEqual(['x']);
  });
  test('the best-supported link per platform; a second one is "also found"', () => {
    const p = buildProfile(shensi, [], [
      { kind: 'url', value: 'https://linkedin.com/in/shensi-ding-123', why: 'linkedin profile', platform: 'linkedin', trusted: true, evidence: [{ id: 'a' }] },
      { kind: 'url', value: 'https://linkedin.com/in/shensiding', why: 'linkedin profile (Wikidata)', platform: 'linkedin', trusted: true, evidence: [{ id: 'b' }, { id: 'c' }] },
    ]);
    expect(p.links[0]).toEqual(expect.objectContaining({ platform: 'linkedin', url: 'https://linkedin.com/in/shensiding' }));
    expect(p.links[1]).toEqual(expect.objectContaining({ url: 'https://linkedin.com/in/shensi-ding-123', also: true }));
  });
});

describe('saved reports as test material', () => {
  test('Eric Glyman / Ramp (r9): Paribus, the degree, co-CEO, angel investing; Capital One is an outcome', () => {
    const { d, findings, threads } = saved('r9/eric-glyman-ramp.json');
    const eric = createSubject({ name: d.name, company: d.company });
    const p = buildProfile(eric, findings, threads);
    expect(p.headline).toMatch(/Co-CEO/);
    expect(p.headline).not.toMatch(/(?<!Co-)CEO/);
    const paribus = p.resume.founded.find((f) => f.org === 'Paribus');
    expect(paribus).toBeTruthy();
    expect(paribus.year).toBe(2014);
    expect(paribus.outcome).toMatch(/Capital One/);
    expect(p.resume.founded.find((f) => f.org === 'Ramp')).toEqual(expect.objectContaining({ year: 2019 }));
    expect(p.resume.founded.find((f) => f.org === 'Ramp').with).toEqual(expect.arrayContaining(['Karim Atiyeh', 'Gene Lee']));
    const harvard = p.resume.education.find((e) => /Harvard/.test(e.school));
    expect(harvard).toEqual(expect.objectContaining({ degree: 'BA', to: 2012 }));
    expect(harvard.field).toMatch(/Economics/);
    expect(p.resume.roles.find((r) => r.org === 'Paribus')).toEqual(expect.objectContaining({ from: 2014, to: 2019, current: false }));
    expect(p.resume.investments.some((x) => /angel/i.test(x.text))).toBe(true);
    const roleOrgs = orgs(p.resume.roles).join(' | ');
    expect(roleOrgs).not.toMatch(/Capital One|Village Global|Torenberg|Goldman/);
    // every line carries the records that state it
    for (const list of Object.values(p.resume)) for (const x of list) expect(x.ids.length).toBeGreaterThan(0);
  });
  test('Shensi Ding / Merge (r8): Expanse, Columbia 2015, Merge 2020 with Gil Feig; no interviewer link', () => {
    const { d, findings, threads } = saved('r8/shensi-ding-merge.json');
    const shensi = createSubject({ name: d.name, company: d.company });
    const p = buildProfile(shensi, findings, threads.filter((t) => !/notanotherceo/.test(t.value) || t.kind !== 'url').concat([{ kind: 'url', value: 'https://notanotherceo.substack.com', why: 'substack profile', platform: 'substack', trusted: true }]));
    expect(orgs(p.earlier)).toContain('Expanse');
    expect(p.headline).toBe('Co-Founder and CEO, Merge');
    expect(p.resume.education.find((e) => e.school === 'Columbia University')).toEqual(expect.objectContaining({ to: 2015 }));
    const merge = p.resume.founded.find((f) => f.org === 'Merge');
    expect(merge).toEqual(expect.objectContaining({ year: 2020 }));
    expect(merge.with).toContain('Gil Feig');
    expect(p.resume.roles.find((r) => r.org === 'Merge')).toEqual(expect.objectContaining({ from: 2020, current: true }));
    expect(p.links.map((l) => l.url).join(' ')).not.toMatch(/notanotherceo/);
    expect(p.resume.leads.some((l) => /Credit Suisse/.test(l.text))).toBe(true);
  });
  test('Trevor Milton / Nikola (r9): founder, no role there since 2020; earlier ventures', () => {
    const { d, findings, threads } = saved('r9/trevor-milton-nikola.json');
    const milton = createSubject({ name: d.name, company: d.company });
    const p = buildProfile(milton, findings, threads);
    expect(p.resume.roles.find((r) => r.org === 'Nikola').current).toBe(false);
    expect(p.headline).toMatch(/former/);
    const founded = p.resume.founded.map((f) => f.org).join(' | ');
    expect(founded).toMatch(/Nikola/);
    expect(founded).toMatch(/dHybrid/);
    expect(founded).toMatch(/St\. George Security and Alarm/);
    expect(p.resume.education.find((e) => e.school === 'Utah Valley University')).toBeTruthy();
  });
});

describe('the published form (design decision 2)', () => {
  test('ids become citation numbers, every list carries cites, old fields stay', () => {
    const jane = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const a = rec({ title: 'Jane Roe, co-founder and CEO of Acme', quote: 'Jane Roe previously worked at Stripe. Jane Roe earned a BS in Computer Science from Columbia University. Jane Roe sits on the board of Globex.' });
    const p = buildProfile(jane, [a]);
    const out = publishProfile(p, (ids) => ids.map(() => 7));
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['headline', 'headlineCites', 'company', 'roles', 'education', 'earlier', 'founded', 'boards', 'investments', 'recognition', 'leads', 'basedIn', 'about', 'links', 'readBy']));
    expect(out.roles.find((r) => r.org === 'Stripe').cites).toEqual([7]);
    expect(out.education[0]).toEqual(expect.objectContaining({ school: 'Columbia University', degree: 'BS', field: 'Computer Science', cites: [7] }));
    expect(out.boards[0].cites).toEqual([7]);
    expect(out.readBy).toBe('patterns');
    expect(out.roles[0].ids).toBeUndefined();
    expect(publishProfile(buildProfile(jane, []), () => [])).toBeNull();
  });
});
