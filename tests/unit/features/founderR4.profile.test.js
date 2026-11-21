/**
 * @jest-environment node
 *
 * Round 4, profile owner: every finding of eval/founder/review-2026-11-21/by-owner/profile.json, each as a test
 * that failed before its fix, plus the résumé rebuilt for the saved runs (r9, r10) with every line checked
 * against the record it cites.
 */
const fs = require('fs');
const path = require('path');
const { createSubject } = require('../../../src/server/founder/identity');
const { buildProfile, bioSentences, leadsToSomeoneElse, maskSubject } = require('../../../src/server/founder/profile');
const { verifyProfile, mergeProfile } = require('../../../src/server/founder/profileModel');
const { buildCompanyFacts } = require('../../../src/server/founder/companyFacts');
const { companiesFromText } = require('../../../src/server/founder/extract');

let seq = 0;
const rec = (o) => ({ id: `r${(seq += 1)}`, source: 'web-search', sourceLabel: 'Open-web search', category: 'press', severity: 'info', quote: '', match: 'confirmed', url: `https://x.test/${seq}`, date: null, ...o });
const orgs = (list) => list.map((x) => x.org);
const schools = (p) => p.resume.education.map((e) => e.school);

const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });

describe('critical: a "He/She" after another person is never the subject (profile-pronoun-bypass)', () => {
  const holmes = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
  const BALWANI = 'In 2009, Holmes hired Ramesh "Sunny" Balwani as president and chief operating officer of Theranos. He had previously worked at Lotus Development and Microsoft. He earned an MBA from the University of California, Berkeley.';
  const GORDON = 'Stefanie Gordon is the Chief Marketing Officer at Ramp. She previously worked at iQuanti. She earned a BA from the University of Delaware and an MA from NYU.';
  test('the subject\'s own Wikipedia article: Balwani\'s jobs and MBA are not Holmes\'s', () => {
    const p = buildProfile(holmes, [rec({ source: 'wikipedia', category: 'identity', title: 'Elizabeth Holmes', quote: BALWANI })]);
    expect(orgs(p.resume.roles)).not.toEqual(expect.arrayContaining(['Lotus Development']));
    expect(orgs(p.resume.roles).join(' ')).not.toMatch(/Lotus|Microsoft/);
    expect(schools(p).join(' ')).not.toMatch(/Berkeley|California/);
  });
  test('a bio record about a colleague (Stefanie Gordon) gives the subject nothing', () => {
    const p = buildProfile(eric, [rec({ source: 'page-reader', data: { kind: 'bio', page: 'https://ramp.com/blog/team' }, title: 'Career, as told on ramp.com', quote: GORDON })]);
    expect(orgs(p.resume.roles).join(' ')).not.toMatch(/iQuanti/);
    expect(schools(p).join(' ')).not.toMatch(/Delaware|NYU/);
  });
  test('the person\'s own team page holding a colleague\'s bio gives the subject nothing', () => {
    const p = buildProfile(eric, [rec({ source: 'page-reader', url: 'https://ramp.com/team/eric-glyman', title: 'Team', quote: GORDON })]);
    expect(orgs(p.resume.roles).join(' ')).not.toMatch(/iQuanti/);
    expect(schools(p).join(' ')).not.toMatch(/Delaware|NYU/);
  });
  test('a pronoun right after a sentence about the person is still theirs', () => {
    const p = buildProfile(holmes, [rec({ source: 'wikipedia', category: 'identity', title: 'Elizabeth Holmes', quote: 'Holmes founded Theranos in 2003. She previously worked at Acme Labs.' })]);
    expect(orgs(p.resume.roles)).toContain('Acme Labs');
    const q = buildProfile(eric, [rec({ source: 'page-reader', data: { kind: 'bio' }, title: 'Bio', quote: 'Eric Glyman is the co-founder of Ramp. He previously worked at Capital One.' })]);
    expect(orgs(q.resume.roles)).toContain('Capital One');
  });
  test('bioSentences agrees: nothing of the colleague\'s bio is kept', () => {
    expect(bioSentences(eric, GORDON, { aboutThem: true })).toEqual([]);
  });
});

describe('high: another person\'s title at the company is not the subject\'s (profile-company-title-other-person)', () => {
  const milton = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
  test.each([
    [eric, 'Ramp CTO Karim Atiyeh and Eric Glyman spoke.', /CTO/],
    [milton, 'Nikola CEO Mark Russell and founder Trevor Milton spoke in 2019.', /CEO/],
    [eric, 'Eric Glyman and Karim Atiyeh, CTO of Ramp, spoke.', /CTO/],
    [milton, 'Trevor Milton, Nikola founder, was sued by Nikola CEO Steve Girsky.', /CEO/],
  ])('%#: %s', (subject, quote, bad) => {
    const p = buildProfile(subject, [rec({ title: 'Story', quote })]);
    expect(String(p.headline || '')).not.toMatch(bad);
  });
  test('their own title by apposition or before their name is kept', () => {
    expect(buildProfile(eric, [rec({ title: 'S', quote: 'Ramp CEO Eric Glyman spoke at the event.' })]).headline).toMatch(/CEO, Ramp/);
    expect(buildProfile(eric, [rec({ title: 'S', quote: 'Eric Glyman, CEO of Ramp, spoke at the event.' })]).headline).toMatch(/CEO, Ramp/);
    expect(buildProfile(milton, [rec({ title: 'S', quote: 'Trevor Milton, Nikola founder, was sued by Nikola CEO Steve Girsky.' })]).headline).toMatch(/Founder/);
  });
});

describe('high: the model merge never brings an ended role back as current (profile-model-merge-current)', () => {
  test('an ended pattern row at the same organisation keeps the model row from being current, and the rows fold', () => {
    const base = { headline: null, roles: [{ org: 'Nikola', title: 'Founder, CEO, Executive Chairman', from: 2014, to: 2020, current: false, cites: [2] }], education: [{ school: 'Harvard University', cites: [3] }] };
    const verified = { roles: [{ org: 'Nikola', title: 'CEO', from: null, to: null, current: true, cites: [1], date: '2019-05-01' }], education: [{ school: 'Harvard College', cites: [1] }] };
    const out = mergeProfile(base, verified);
    const nikola = out.roles.filter((r) => r.org === 'Nikola');
    expect(nikola).toHaveLength(1);
    expect(nikola[0].current).toBe(false);
    expect(nikola[0].cites).toEqual([1, 2]);
    expect(out.headline).toBeNull();
    expect(out.education).toHaveLength(1);
    expect(out.roles[0]).not.toHaveProperty('date');
  });
  test('a model row from a record dated after the end may stay current', () => {
    const base = { roles: [{ org: 'Acme', title: 'CTO', from: 2014, to: 2018, current: false, cites: [2] }] };
    const out = mergeProfile(base, { roles: [{ org: 'Acme', title: 'CEO', current: true, cites: [1], date: '2023-02-01' }] });
    expect(out.roles.find((r) => r.org === 'Acme').current).toBe(true);
  });
  test('verifyProfile carries the record date on a role', () => {
    const milton = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const f = rec({ id: 'm1', date: '2019-03-01', title: 'Story', quote: 'Trevor Milton is the founder and CEO of Nikola, which he leads from Phoenix.' });
    const v = verifyProfile(milton, [f], { roles: [{ org: 'Nikola', title: 'CEO', from: 0, to: 0, current: true, record: 1, quote: 'Trevor Milton is the founder and CEO of Nikola' }] });
    expect(v.roles[0].date).toBe('2019-03-01');
  });
});

describe('high: money of another company in the sentence is not the company\'s (companyfacts-other-company-money)', () => {
  test('Ramp\'s rival Brex', () => {
    const cf = buildCompanyFacts(eric, [rec({ title: 'Story', quote: "Ramp's rival Brex, valued at $12 billion in 2022, raised $300 million in a Series D led by Greenoaks." })]);
    expect(cf.standing.map((s) => s.text).join(' ')).not.toMatch(/12 billion/);
    expect(cf.funding).toEqual([]);
    expect(cf.investors).toEqual([]);
  });
  test('the founder\'s new startup Alta is not Airwallex', () => {
    const zhang = createSubject({ name: 'Jack Zhang', company: 'Airwallex' });
    const cf = buildCompanyFacts(zhang, [rec({ title: 'News', quote: 'Airwallex co-founder and CEO Jack Zhang has launched a new blockchain infrastructure startup, Alta, which has raised $80 million from investors including Index Ventures, GV, Blackbird and Square Peg.' })]);
    expect(cf.funding).toEqual([]);
    expect(cf.investors).toEqual([]);
  });
  test('the company\'s own rounds are still read', () => {
    const cf = buildCompanyFacts(eric, [rec({ title: 'Story', quote: 'Ramp raised $300 million in a Series D led by Founders Fund, at a valuation of $8 billion.' })]);
    expect(cf.funding.map((f) => f.amount)).toContain('$300 million');
    expect(cf.standing.map((s) => s.text).join(' ')).toMatch(/8 billion/);
  });
});

describe('high: company facts are dated and cited sensibly (live-funding-junk)', () => {
  test('a round dated before the company was founded is dropped', () => {
    const cf = buildCompanyFacts(eric, [
      rec({ title: 'Wiki', quote: 'Ramp was founded in 2019 by Eric Glyman and Karim Atiyeh.' }),
      rec({ title: 'Old', date: '2016-05-18', quote: 'Ramp raised $2B in new funding.' }),
    ]);
    expect(cf.funding.map((f) => f.amount)).not.toContain('$2B');
  });
  test('the same sentence is one standing line, and dated sentences come before headlines', () => {
    const s = 'As of June 2026, Ramp was valued at $44 billion with $1 billion in annualized revenue.';
    const cf = buildCompanyFacts(eric, [rec({ title: 'Ramp CEO Eric Glyman\'s new $13 billion valuation - CNBC', quote: s })]);
    expect(cf.standing.filter((x) => x.text === s)).toHaveLength(1);
    expect(cf.standing[0].text).toBe(s);
    expect(cf.standing.every((x) => x.ids.length)).toBe(true);
  });
});

describe('medium: "worked at X for 2 years" (profile-worked-for-n-years)', () => {
  const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
  test.each([
    [shensi, 'Shensi Ding worked at Credit Suisse for 2 years before founding Merge.', 'Credit Suisse'],
    [eric, 'Eric Glyman previously worked at Lazard for 3 years.', 'Lazard'],
    [eric, 'Eric Glyman worked at Lazard for two years.', 'Lazard'],
    [eric, 'Eric Glyman worked at Lazard for three years as an analyst.', 'Lazard'],
  ])('%#: %s', (subject, quote, org) => {
    const p = buildProfile(subject, [rec({ title: 'Bio', quote })]);
    expect(orgs(p.resume.roles)).toContain(org);
    expect(orgs(p.resume.roles).join('|')).not.toMatch(/for \d|^\d+$|\|\d+\||for (?:two|three)/);
  });
});

describe('medium: true facts after a co-founder or a publisher are kept (profile-guard-too-strict)', () => {
  const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
  test('relative clause about the co-founder closes', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman, who co-founded Ramp with Karim Atiyeh, graduated from Harvard University in 2012.' })]);
    expect(schools(p)).toContain('Harvard University');
    const q = buildProfile(shensi, [rec({ title: 'Bio', quote: 'Shensi Ding, who started Merge with Gil Feig, previously worked at Expanse.' })]);
    expect(orgs(q.resume.roles)).toContain('Expanse');
  });
  test('"and later joined" returns to the person', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman co-founded Paribus with Karim Atiyeh and later joined Capital One.' })]);
    expect(orgs(p.resume.roles)).toContain('Capital One');
  });
  test('a publisher is not a person', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman told Bloomberg he previously worked at Lazard.' })]);
    expect(orgs(p.resume.roles)).toContain('Lazard');
  });
  test('the guard still blocks the co-founder\'s own clause', () => {
    for (const s of [
      'Eric Glyman co-founded Ramp with Karim Atiyeh, who previously worked at ',
      'Eric Glyman co-founded Ramp with Karim Atiyeh, who worked at Goldman and later joined ',
      'Eric Glyman met Karim Atiyeh, a former engineer at ',
      'Eric Glyman met Karim, a former engineer at ',
    ]) expect(leadsToSomeoneElse(eric, maskSubject(eric, s))).toBe(true);
  });
});

describe('medium: a school named for another reason is not education (profile-edu-false-positive)', () => {
  test.each([
    'Eric Glyman spoke at Columbia Business School in 2023.',
    'Eric Glyman gave the commencement address at Babson College.',
    'Eric Glyman donated to Stanford University to fund a school of engineering.',
    'Eric Glyman sits on the board of Harvard Business School Club.',
  ])('%s', (quote) => {
    const p = buildProfile(eric, [rec({ title: 'Story', quote })]);
    expect(p.resume.education).toEqual([]);
  });
  test('real education still reads', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman attended Columbia Business School.' })]);
    expect(schools(p)).toContain('Columbia Business School');
  });
});

describe('low: degree after the year, and no period on the school (profile-degree-after-year)', () => {
  test('graduated from Harvard in 2012 with a BA in Economics', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman graduated from Harvard in 2012 with a BA in Economics.' })]);
    expect(p.resume.education[0]).toEqual(expect.objectContaining({ school: 'Harvard', degree: 'BA', field: 'Economics', to: 2012 }));
  });
  test('a sentence-final period stays off the school', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman earned an MBA from the University of California, Berkeley.' })]);
    expect(schools(p)).toEqual(['University of California, Berkeley']);
  });
});

describe('low: "launched a new startup, Alta" (profile-appositive-venture)', () => {
  const zhang = createSubject({ name: 'Jack Zhang', company: 'Airwallex' });
  const NEWS = 'The news: Airwallex co-founder and CEO Jack Zhang has launched a new blockchain infrastructure startup, Alta, which has raised USD80 million from investors including Index Ventures, GV, Blackbird and ...';
  test('the profile lists Alta among companies founded', () => {
    const p = buildProfile(zhang, [rec({ id: 'news-archive-n4csl9', source: 'news-archive', title: 'Airwallex founder Jack Zhang launches blockchain startup with USD80m backing', quote: NEWS })]);
    expect(orgs(p.resume.founded)).toEqual(expect.arrayContaining(['Alta']));
  });
  test('the quick brief extractor reads it too', () => {
    expect(companiesFromText(zhang, 'Jack Zhang has launched a new blockchain infrastructure startup, Alta, which has raised money.').map((c) => c.name)).toContain('Alta');
  });
  test('the quick brief extractor does not carry a pronoun past another person', () => {
    expect(companiesFromText(eric, 'Eric Glyman hired Bob Smith. He previously founded Initech.').map((c) => c.name)).not.toContain('Initech');
    expect(companiesFromText(eric, 'Eric Glyman spoke in New York. He previously founded Paribus.').map((c) => c.name)).toContain('Paribus');
  });
  test('someone else\'s new startup is not theirs', () => {
    const p = buildProfile(zhang, [rec({ title: 'N', quote: 'Jack Zhang hired Bob Smith, who launched a new startup, Hooli.' })]);
    expect(orgs(p.resume.founded)).not.toContain('Hooli');
  });
});

describe('high: the structured fields the sources write are read (sources-people-profile-ignores-data-fields)', () => {
  const holmes = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
  test('a likely Wikidata record fills education, roles, boards, awards, memberships and founded', () => {
    const p = buildProfile(holmes, [
      rec({ source: 'wikidata', match: 'likely', category: 'education', title: 'Elizabeth Holmes: educated at Stanford University', quote: 'Elizabeth Holmes: educated at Stanford University', data: { education: [{ school: 'Stanford University', degree: null, field: 'chemical engineering', from: 2002, to: 2004 }] } }),
      rec({ source: 'wikidata', match: 'likely', category: 'career', title: 'Elizabeth Holmes at Theranos', quote: 'Theranos: chief executive officer Elizabeth Holmes', data: { employers: [{ org: 'Theranos', title: 'chief executive officer', from: 2003, to: 2018 }], founded: [{ org: 'Theranos', year: 2003 }], boards: [{ org: 'Foo Corp', role: 'board member', from: 2010, to: null }] } }),
      rec({ source: 'wikidata', match: 'likely', category: 'career', title: 'Elizabeth Holmes: awards', quote: 'awards', data: { awards: [{ text: 'Horatio Alger Award', year: 2015 }] } }),
      rec({ source: 'wikidata', match: 'likely', category: 'career', title: 'Elizabeth Holmes: member of', quote: 'member of', data: { memberships: [{ org: 'Harvard Medical School Board of Fellows', from: 2014, to: null }] } }),
    ]);
    expect(p.resume.education[0]).toEqual(expect.objectContaining({ school: 'Stanford University', field: 'chemical engineering', to: 2004, basis: 'record' }));
    expect(p.resume.roles.find((r) => r.org === 'Theranos')).toEqual(expect.objectContaining({ from: 2003, basis: 'record' }));
    expect(orgs(p.resume.founded)).toContain('Theranos');
    expect(orgs(p.resume.boards)).toEqual(expect.arrayContaining(['Foo Corp', 'Harvard Medical School Board of Fellows']));
    expect(p.resume.recognition.map((r) => r.text)).toContain('Horatio Alger Award');
  });
  test('an OpenAlex dissertation and an ORCID record fill the résumé', () => {
    const ada = createSubject({ name: 'Ada Quistwell', company: 'Quistlabs' });
    const p = buildProfile(ada, [
      rec({ source: 'publications', match: 'likely', category: 'education', title: 'Dissertation: On things (MIT, 2015)', quote: 'Ada Quistwell. On things. Massachusetts Institute of Technology. 2015', data: { registry: 'OpenAlex', kind: 'dissertation', institution: 'Massachusetts Institute of Technology', year: 2015, education: [{ school: 'Massachusetts Institute of Technology', degree: null, field: null, from: null, to: 2015 }] } }),
      rec({ source: 'academic-record', match: 'likely', category: 'career', title: 'ORCID', quote: 'Ada Quistwell: Research Scientist, Initech Labs', data: { registry: 'ORCID', entries: [{ organisation: 'Initech Labs', role: 'Research Scientist', start: '2016' }], employers: [{ org: 'Initech Labs', title: 'Research Scientist', from: 2016, to: 2019 }], positions: [{ title: 'Visiting Fellow', of: 'Globex Institute', from: 2018, to: 2018 }] } }),
    ]);
    expect(schools(p)).toContain('Massachusetts Institute of Technology');
    expect(p.resume.roles.find((r) => r.org === 'Initech Labs')).toEqual(expect.objectContaining({ from: 2016, to: 2019, current: false, basis: 'record' }));
    expect(orgs(p.resume.roles)).toContain('Globex Institute');
  });
  test('a name-only record\'s fields give nothing', () => {
    const p = buildProfile(holmes, [rec({ source: 'wikidata', match: 'possible', category: 'education', title: 'x', quote: 'x', data: { education: [{ school: 'Yale University', from: null, to: 2001 }] } })]);
    expect(p.resume.education).toEqual([]);
  });
});

describe('medium: a thesis in preparation is not a degree (sources-people-thesis-in-prep-as-degree)', () => {
  const ada = createSubject({ name: 'Ada Quistwell', company: 'Quistlabs' });
  test('theses.fr in preparation', () => {
    const p = buildProfile(ada, [rec({ source: 'academic-record', match: 'likely', category: 'education', title: 'Thesis', quote: 'Ada Quistwell. Topic. Doctorat. Université Paris-Saclay.', data: { registry: 'theses.fr', degree: 'Doctorat', defended: false, institution: 'Université Paris-Saclay' } })]);
    expect(p.resume.education.filter((e) => e.degree === 'Doctorat')).toEqual([]);
  });
  test('a defended thesis is', () => {
    const p = buildProfile(ada, [rec({ source: 'academic-record', match: 'likely', category: 'education', title: 'Thesis', quote: 'Ada Quistwell. Topic. Doctorat. Université Paris-Saclay. 2019', data: { registry: 'theses.fr', degree: 'Doctorat', defended: true, institution: 'Université Paris-Saclay', education: [{ school: 'Université Paris-Saclay', degree: 'Doctorat', field: 'Physique', from: null, to: 2019 }] } })]);
    expect(p.resume.education[0]).toEqual(expect.objectContaining({ school: 'Université Paris-Saclay', degree: 'Doctorat', to: 2019 }));
  });
});

describe('medium: an accelerator is never a school (live-education-accelerator)', () => {
  test('Y Combinator in Person data goes with the venture, not education', () => {
    const p = buildProfile(eric, [
      rec({ source: 'page-reader', category: 'career', title: 'Page data', quote: 'Eric Glyman', data: { kind: 'facts', structured: { titles: [], employers: [], schools: ['Harvard University', 'Y Combinator'], foundersOf: [] } } }),
      rec({ title: 'Bio', quote: 'Eric Glyman co-founded Paribus (YC S15, Acq. by Capital One).' }),
    ]);
    expect(schools(p)).toEqual(['Harvard University']);
    expect(p.resume.founded.find((f) => f.org === 'Paribus').program).toMatch(/Y Combinator/);
  });
  test('with no venture to hang it on, it is recognition', () => {
    const p = buildProfile(eric, [rec({ source: 'wikidata', match: 'likely', category: 'education', title: 'x', quote: 'x', data: { education: [{ school: 'Techstars', from: null, to: 2014 }] } })]);
    expect(p.resume.education).toEqual([]);
    expect(p.resume.recognition.map((r) => r.text).join(' ')).toMatch(/Techstars/);
  });
});

describe('high: "studied <field> at <School>" (live-degree-missing-studied-at)', () => {
  const jq = createSubject({ name: 'Jordan Quillfeather', company: 'Lumenfold Robotics' });
  const f = rec({ id: 'q1', source: 'web-search', category: 'press', date: '2023-02-10', title: 'Lumenfold Robotics founder Jordan Quillfeather on warehouse automation', quote: 'Before Lumenfold Robotics, Jordan Quillfeather ran Tidewater Drones and studied mechanical engineering at Harrowgate Institute of Technology. Her brother, Casey Quillfeather, the chief financial officer of Lumenfold Robotics, joined in 2021.' });
  test('patterns', () => {
    const p = buildProfile(jq, [f]);
    expect(p.resume.education[0]).toEqual(expect.objectContaining({ school: 'Harrowgate Institute of Technology', field: 'mechanical engineering' }));
  });
  test('the model line is kept', () => {
    const v = verifyProfile(jq, [f], { education: [{ school: 'Harrowgate Institute of Technology', degree: '', field: 'mechanical engineering', from: 0, to: 0, record: 1, quote: 'Jordan Quillfeather ran Tidewater Drones and studied mechanical engineering at Harrowgate Institute of Technology' }] });
    expect(v.education.map((e) => e.school)).toEqual(['Harrowgate Institute of Technology']);
  });
});

/* ---------------------------------------------------------------- the saved runs, rebuilt */

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
  return { d, findings: [...items.values()], threads: (d.threads || []).map((t) => ({ ...t, trusted: true })) };
}
const flat = (s) => ` ${String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
/** The words of the record a line cites: title, quote and its structured data. */
const recordWords = (f) => flat(`${f.title || ''} ${f.quote || ''} ${JSON.stringify(f.data || {})}`);

describe('the saved runs: every résumé line is stated by a record it cites, tied to the person', () => {
  const runs = [
    ['r10/eric-glyman-ramp.json', 'Eric Glyman', 'Ramp'],
    ['r9/eric-glyman-ramp.json', 'Eric Glyman', 'Ramp'],
    ['r9/jack-zhang-airwallex.json', 'Jack Zhang', 'Airwallex'],
    ['r9/trevor-milton-nikola.json', 'Trevor Milton', 'Nikola'],
  ];
  test.each(runs)('%s', (file, name, company) => {
    const { findings, threads } = saved(file);
    const subject = createSubject({ name, company });
    const p = buildProfile(subject, findings, threads);
    const byId = new Map(findings.map((f) => [f.id, f]));
    const lines = [
      ...p.resume.roles.filter((r) => r.org !== company).map((r) => ({ main: r.org, ids: r.ids })),
      ...p.resume.education.map((e) => ({ main: e.school, ids: e.ids })),
      ...p.resume.founded.filter((x) => x.org !== company).map((x) => ({ main: x.org, ids: x.ids })),
      ...p.resume.boards.map((x) => ({ main: x.org, ids: x.ids })),
      ...p.resume.recognition.map((x) => ({ main: x.text, ids: x.ids })),
    ];
    for (const line of lines) {
      const cited = line.ids.map((id) => byId.get(id)).filter(Boolean);
      expect(cited.length).toBeGreaterThan(0);
      // every cited record is tied to the person
      for (const f of cited) expect(['confirmed', 'likely']).toContain(f.match);
      // at least one cited record names the line's organisation, school or award (the first word is enough
      // for a school written two ways, "Harvard" and "Harvard University")
      const first = flat(line.main).trim().split(' ')[0];
      expect(cited.some((f) => recordWords(f).includes(` ${first} `))).toBe(true);
    }
    // nothing an investor would read as the wrong person's
    expect(schools(p)).not.toContain('Y Combinator');
    const cf = p.companyFacts;
    for (const r of cf.funding) expect(r.ids.length).toBeGreaterThan(0);
    if (cf.founded) for (const r of cf.funding) if (r.date && !/^Form D/.test(r.round || '')) expect(Number(String(r.date).slice(0, 4))).toBeGreaterThanOrEqual(cf.founded.year);
    const texts = cf.standing.map((s) => s.text);
    expect(new Set(texts).size).toBe(texts.length);
  });
  test('Zhang\'s r9 résumé lists Alta, and Airwallex\'s funding holds no Alta round', () => {
    const { findings, threads } = saved('r9/jack-zhang-airwallex.json');
    const p = buildProfile(createSubject({ name: 'Jack Zhang', company: 'Airwallex' }), findings, threads);
    expect(orgs(p.resume.founded)).toContain('Alta');
    expect(p.companyFacts.funding.map((f) => f.amount).join(' ')).not.toMatch(/80/);
  });
});

describe('the pronoun rule is the same for the model and for the page reader\'s split records', () => {
  const jane = createSubject({ name: 'Jane Roe', company: 'Acme' });
  const bio = (quote, title = 'Career, as told on bio.test: Jane Roe - Co-Founder, Acme') => rec({ source: 'page-reader', category: 'education', url: 'https://bio.test/jane-roe', title, quote, data: { kind: 'bio', page: 'https://bio.test/jane-roe' } });
  test('a lone follow-on the reader kept is theirs, for patterns and for the model', () => {
    const f = bio('She studied computer science at Columbia University.');
    expect(schools(buildProfile(jane, [f]))).toContain('Columbia University');
    const v = verifyProfile(jane, [f], { education: [{ school: 'Columbia University', degree: '', field: '', from: 0, to: 0, record: 1, quote: 'She studied computer science at Columbia University' }] });
    expect(v.education).toHaveLength(1);
  });
  test('never when the record names someone else, or not the person', () => {
    const g = bio('Bob Smith is the CTO of Acme. He studied physics at Yale University.');
    expect(schools(buildProfile(jane, [g]))).toEqual([]);
    const v = verifyProfile(jane, [g], { education: [{ school: 'Yale University', degree: '', field: '', from: 0, to: 0, record: 1, quote: 'He studied physics at Yale University' }] });
    expect(v.education).toEqual([]);
    expect(schools(buildProfile(jane, [bio('She studied physics at Yale University.', 'Career, as told on bio.test: Team')]))).toEqual([]);
  });
});

describe('titles written the way profile pages write them (thin profile)', () => {
  test('"was Financial Analyst at", "worked at X as a Senior Director"', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman was Financial Analyst at Millstein & Co. from July 2012 to 2014. Eric Glyman previously worked at Capital One as a Senior Director.' })]);
    expect(p.resume.roles.find((r) => r.org === 'Millstein & Co.')).toEqual(expect.objectContaining({ title: 'Financial Analyst' }));
    expect(p.resume.roles.find((r) => r.org === 'Capital One')).toEqual(expect.objectContaining({ title: 'Senior Director' }));
  });
  test('never a phrase that is no title', () => {
    const p = buildProfile(eric, [rec({ title: 'Bio', quote: 'Eric Glyman was Part of the founding team at Initech.' })]);
    expect(p.resume.roles.find((r) => r.org === 'Initech')?.title || null).toBeNull();
  });
});
