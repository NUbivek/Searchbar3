/**
 * Round 3 of the report fixes (audit 2026-11-20): namesakes kept off the person, ordinary-word company
 * noise out of the numbered report, one page one record, honest screens and coverage, red flags ordered
 * by the kind of matter, claims that changed limited to claims about the person, a timeline of real
 * events, every cap stating what it cut, the identity note, and the profile contract with profile.js.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const { buildReport, quotedDeepBrief, writeDeepBrief, cleanScreens, reportProfile, NOT_COVERED } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
const rec = (o) => ({ id: `r${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', severity: 'info', quote: '', match: 'confirmed', matchReasons: [], ...o });
function state(name, company, findings, extra = {}) {
  const s = startState({ name, company });
  s.findings = findings;
  return Object.assign(s, extra);
}
const src = (o) => ({ label: o.label || 'Source', runs: 1, errors: 0, findings: 0, ...o });

describe('namesakes are not pinned on the person through an employer', () => {
  const bio = [
    rec({ title: 'Jane Okonkwo profile', quote: 'Jane Okonkwo worked at Square before founding Zeta.', url: 'https://a.test/1' }),
    rec({ title: 'Jane Okonkwo interview', quote: 'Jane Okonkwo worked at Square before founding Zeta.', url: 'https://b.test/1' }),
    rec({ title: 'Jane Okonkwo at Zeta', quote: 'Jane Okonkwo worked at Google before founding Zeta.', url: 'https://c.test/1' }),
    rec({ title: 'Jane Okonkwo, Zeta', quote: 'Jane Okonkwo worked at Google before founding Zeta.', url: 'https://d.test/1' }),
  ];

  test('a serious name-only record is never raised by an employer, and a very large employer never raises one', () => {
    const report = buildReport(state('Jane Okonkwo', 'Zeta', [
      ...bio,
      rec({ title: 'Jane Okonkwo charged with fraud in Times Square shooting case', url: 'https://e.test/1', match: 'possible', severity: 'high', date: '2023-01-02' }),
      rec({ title: 'Former Square engineer Jane Okonkwo indicted', url: 'https://f.test/1', match: 'possible', severity: 'high', date: '2023-02-02' }),
      rec({ title: 'Jane Okonkwo of Google speaks at a conference', url: 'https://g.test/1', match: 'possible', severity: 'info' }),
    ]));
    expect(report.redFlags).toHaveLength(0);
    const all = report.sections.flatMap((s) => s.items);
    expect(all.find((f) => f.url === 'https://e.test/1').match).toBe('possible');
    expect(all.find((f) => f.url === 'https://f.test/1').match).toBe('possible');
    expect(all.find((f) => f.url === 'https://g.test/1').match).toBe('possible');
  });

  test('a minor record naming the person beside a known employer is likely; a record denying the tie is not', () => {
    const report = buildReport(state('Jane Okonkwo', 'Zeta', [
      ...bio,
      rec({ title: 'Registration', quote: 'Jane Okonkwo, analyst at Square, registered in 2015.', url: 'https://h.test/1', match: 'possible', source: 'finra-brokercheck', category: 'regulatory' }),
      rec({ title: 'Y Combinator lists Square; Jane Okonkwo is not on its founder list', quote: 'Square: Jane Okonkwo is not on its founder list.', url: 'https://i.test/1', match: 'possible', source: 'yc-directory', category: 'corporate' }),
    ]));
    const all = report.sections.flatMap((s) => s.items);
    expect(all.find((f) => f.url === 'https://h.test/1').match).toBe('likely');
    expect(all.find((f) => f.url === 'https://i.test/1').match).toBe('possible');
  });
});

describe('a company named with an ordinary word', () => {
  test('the company as a company stays; the bare word leaves the numbered report with a reason, whatever the case typed', () => {
    const report = buildReport(state('Eric Glyman', 'ramp', [
      rec({ title: 'Ramp raises $500M from investors', url: 'https://n.test/1', match: 'company', source: 'web-search', severity: 'info' }),
      rec({ title: "After a failed partnership, Ramp's backers lobbied Washington to probe rival Airwallex's China ties", url: 'https://n.test/2', match: 'company', source: 'web-search', severity: 'medium', date: '2026-10-27' }),
      rec({ title: 'Company fined after crash at boat ramp', url: 'https://n.test/3', match: 'company', source: 'web-search', severity: 'medium', date: '2026-01-01' }),
      rec({ title: 'Body found near Misty Water Boat Ramp identified', url: 'https://n.test/4', match: 'possible', source: 'web-search', severity: 'medium', data: { companyNamesake: true }, matchReasons: ['the word "Ramp" appears, but not clearly as this company'] }),
      rec({ title: 'Appointment of Liquidators: RAMP & CO LTD.', url: 'https://n.test/5', match: 'possible', source: 'uk-gazette', category: 'corporate', severity: 'medium', data: { companyNamesake: true } }),
      rec({ title: 'Eric Glyman on building Ramp', quote: 'Eric Glyman, CEO of Ramp, said', url: 'https://n.test/6', match: 'confirmed' }),
    ]));
    const urls = report.sources.map((s) => s.url);
    expect(urls).toEqual(expect.arrayContaining(['https://n.test/1', 'https://n.test/2', 'https://n.test/6']));
    expect(urls).not.toContain('https://n.test/3');
    expect(urls).not.toContain('https://n.test/4');
    expect(urls).not.toContain('https://n.test/5');
    expect(report.wordOnly.count).toBe(3);
    expect(report.wordOnly.items.every((x) => x.reason)).toBe(true);
    expect(report.companyMatters.map((m) => m.url)).toContain('https://n.test/2');
    expect(report.possibleNamesake.map((m) => m.url)).not.toContain('https://n.test/5');
  });

  test('a two-word name whose key is an ordinary word ("Merge Labs") keeps "Merge raises"', () => {
    const report = buildReport(state('Shensi Ding', 'Merge Labs', [
      rec({ title: 'Merge raises $250M in funding', url: 'https://m.test/1', match: 'company', source: 'web-search' }),
    ]));
    expect(report.sources.map((s) => s.url)).toContain('https://m.test/1');
    expect(report.sources[0].match).toBe('company');
  });

  test('a record that names a known legal name of the company stays', () => {
    const s = state('Eric Glyman', 'Ramp', [
      rec({ title: 'Ramp Business Corp: trademark RAMP', url: 'https://t.test/1', match: 'possible', source: 'trademarks', category: 'ip', data: { companyNamesake: true } }),
    ]);
    s.anchors.aliases = [{ value: 'Ramp Business Corp', of: 'ramp', origin: 'sec-1' }];
    const report = buildReport(s);
    expect(report.sources.map((x) => x.url)).toContain('https://t.test/1');
  });
});

test('the brief is passed through the privacy rules', async () => {
  const report = buildReport(state('Elizabeth Holmes', 'Theranos', [
    rec({ title: 'Elizabeth Holmes founded Theranos', url: 'https://p.test/1', category: 'career' }),
  ]));
  const text = '## BOTTOM LINE\nElizabeth Holmes founded Theranos [Source 1]. Holmes has two children [Source 1].\n## RED FLAGS\nNone found in the records searched.\n## WHAT CHECKS OUT\n• Founded Theranos [Source 1]\n## CLAIMS THAT CHANGED OVER TIME\nNone found.\n## RELATED PARTIES\nNone found.\n## CAREER AND EDUCATION\n• Founded Theranos [Source 1]\n## COMPANY\n• Theranos was founded by Elizabeth Holmes [Source 1]\n## PUBLIC-RECORD SCREENS\n• No screen was asked.\n## GAPS AND UNVERIFIED CLAIMS\n• None [Source 1]\n## QUESTIONS FOR THE FOUNDER\n• Ask [Source 1]\nCONFIDENCE: Medium - thin';
  const { brief, briefInfo } = await writeDeepBrief(report, { complete: async (m, o) => (o.accept(text) ? { text, providerLabel: 'G', model: 'm' } : null) });
  expect(briefInfo.mode).toBe('ai');
  expect(brief).not.toMatch(/children/);
  expect(brief).toMatch(/founded Theranos/);
});

describe('related parties are screened only when the screen answered', () => {
  const base = () => {
    const s = state('Eric Glyman', 'Ramp', [rec({ title: 'Eric Glyman, CEO of Ramp', url: 'https://q.test/1' })]);
    s.threads = { a: { kind: 'associate', value: 'Karim Atiyeh', trusted: true, why: 'co-founder' } };
    s.done = ['sanctions-lists|person|Karim Atiyeh|', 'us-exclusions|person|Karim Atiyeh|'];
    return s;
  };
  test('a failed lookup leaves the party not screened', () => {
    const s = base();
    s.sources = { 'sanctions-lists': src({ label: 'Sanctions', runs: 2, errors: 1 }), 'us-exclusions': src({ label: 'Exclusions', runs: 1, errors: 1 }) };
    const party = buildReport(s).relatedParties[0];
    expect(party.screened).not.toBe(true);
  });
  test('screened when every planned watchlist lookup succeeded; in part when some did', () => {
    const s = base();
    s.sources = { 'sanctions-lists': src({ label: 'Sanctions' }), 'us-exclusions': src({ label: 'Exclusions', errors: 1, runs: 2 }) };
    s.screenedOk = ['sanctions-lists|person|Karim Atiyeh|', 'us-exclusions|person|Karim Atiyeh|'];
    expect(buildReport(s).relatedParties[0].screened).toBe(true);
    s.screenedOk = ['sanctions-lists|person|Karim Atiyeh|'];
    const party = buildReport(s).relatedParties[0];
    expect(party.screened).toBe(false);
    expect(party.screenedInPart).toBe(true);
    expect(party.missedScreens).toEqual(['Exclusions']);
  });
});

test('screens with no match are only screens that answered every lookup in full', () => {
  const s = state('Eric Glyman', 'Ramp', [
    rec({ title: 'Form D filed by Ramp Business Corp names Eric Glyman', url: 'https://sec.test/1', source: 'sec-filings', sourceLabel: 'SEC Form D notices', category: 'corporate' }),
  ]);
  s.sources = {
    'sanctions-lists': src({ label: 'Sanctions', waitedOut: 4 }),
    'uk-gazette': src({ label: 'UK Gazette', partial: ['notices'] }),
    'delaware-courts': src({ label: 'Delaware courts', runs: 3 }),
    'court-dockets': src({ label: 'CourtListener', off: true, runs: 0 }),
    'fincen-actions': src({ label: 'FinCEN' }),
    'sec-company': src({ label: 'SEC company filings', runs: 9 }),
    'sec-filings': src({ label: 'SEC Form D notices', findings: 1 }),
  };
  const report = buildReport(s);
  const clean = cleanScreens(report.coverage);
  expect(clean).toEqual(expect.arrayContaining(['Delaware courts', 'FinCEN']));
  expect(clean).not.toContain('Sanctions');
  expect(clean).not.toContain('UK Gazette');
  expect(clean).not.toContain('SEC company filings');
  const sec = report.screens.flatMap((g) => g.items).find((i) => i.id === 'sec-company');
  expect(sec.status).toBe('records');
  // the coverage text never contradicts the screens
  expect(report.coverage.notCovered.join(' ')).not.toMatch(/Court of Chancery/);
  expect(report.coverage.partlyAnswered.map((p) => p.label)).toEqual(expect.arrayContaining(['UK Gazette', 'Sanctions']));
});

test('coverage names US state registers not searched, and every failed lookup', () => {
  expect(NOT_COVERED.join(' ')).toMatch(/Delaware and California/);
  const s = state('Eric Glyman', 'Ramp', []);
  s.sources = { 'web-archive': src({ label: 'Web archive', runs: 25, errors: 3 }), 'court-dockets': src({ label: 'CourtListener', off: true, runs: 0 }) };
  const report = buildReport(s);
  expect(report.coverage.partlyAnswered.find((p) => p.label === 'Web archive').reason).toMatch(/3 of 25/);
  // Delaware was not asked: the Chancery stays in the gap
  expect(report.coverage.notCovered.join(' ')).toMatch(/Delaware Court of Chancery/);
});

test('sanctions, debarment and wanted-list red flags lead, before a resignation', () => {
  const report = buildReport(state('Trevor Milton', 'Nikola', [
    rec({ title: 'Trevor Milton resigns as chairman of Nikola', url: 'https://x.test/1', date: '2020-09-21', severity: 'medium', match: 'confirmed' }),
    rec({ title: 'World Bank debarment: Trevor Milton', url: 'https://x.test/2', date: '2021-01-01', severity: 'high', match: 'likely', source: 'mdb-debarment', category: 'sanctions' }),
    rec({ title: 'Trevor Milton convicted of fraud', url: 'https://x.test/3', date: '2022-10-14', severity: 'high', match: 'confirmed' }),
  ]));
  expect(report.redFlags.map((r) => r.url)).toEqual(['https://x.test/2', 'https://x.test/3', 'https://x.test/1']);
});

test('a matter carries its latest outcome', () => {
  const report = buildReport(state('Trevor Milton', 'Nikola', [
    rec({ title: 'Trevor Milton convicted of fraud', quote: 'United States v. Milton, 1:21-cr-00478', url: 'https://o.test/1', date: '2022-10-14', severity: 'high', source: 'doj-press-releases', category: 'litigation' }),
    rec({ title: 'Trevor Milton fraud case', quote: 'In case 1:21-cr-00478 the president granted a pardon.', url: 'https://o.test/2', date: '2025-03-28', severity: 'high', data: { outcome: 'pardoned' } }),
  ]));
  expect(report.redFlags[0].outcome).toMatchObject({ text: 'pardoned' });
});

test('a record tied only by an event never makes a red flag', () => {
  const report = buildReport(state('Trevor Milton', 'Nikola', [
    rec({ title: 'Trevor Milton sued over truck deal', url: 'https://ev.test/1', date: '2022-01-01', severity: 'medium', match: 'likely', matchReasons: ['names conviction reported in doj-1'] }),
  ]));
  expect(report.redFlags).toHaveLength(0);
});

test('records tied to the person are numbered before company records, and those before name-only ones', () => {
  const report = buildReport(state('Trevor Milton', 'Nikola', [
    rec({ title: 'Trevor Milton sued in Utah', url: 'https://r.test/1', match: 'possible', severity: 'medium' }),
    rec({ title: 'Nikola recall', url: 'https://r.test/2', match: 'company', severity: 'medium', category: 'regulatory' }),
    rec({ title: 'Trevor Milton founded Nikola', url: 'https://r.test/3', match: 'confirmed', severity: 'info', category: 'career' }),
  ]));
  expect(report.sources.map((s) => s.url)).toEqual(['https://r.test/3', 'https://r.test/2', 'https://r.test/1']);
});

test('one page is one record: search result, page reader and archive capture are grouped with the strongest tie', () => {
  const report = buildReport(state('Shensi Ding', 'Merge', [
    rec({ title: 'About Merge', url: 'https://www.merge.dev/about', match: 'possible', source: 'web-search' }),
    rec({ title: 'Merge: about', url: 'https://merge.dev/about/', match: 'confirmed', source: 'page-reader', quote: 'Shensi Ding co-founded Merge.' }),
    rec({ title: 'merge.dev page archived 3 times', url: 'https://web.archive.org/web/2022/https://merge.dev/about', match: 'likely', source: 'web-archive', category: 'archive', data: { kind: 'snapshot', page: 'https://merge.dev/about' } }),
    rec({ title: 'Shensi Ding on Forbes', url: 'https://forbes.com/x', match: 'confirmed' }),
  ]));
  expect(report.totals.records).toBe(2);
  const merged = report.sources.find((s) => /merge\.dev/.test(s.url));
  expect(merged.match).toBe('confirmed');
  const item = report.sections.flatMap((s) => s.items).find((f) => f.n === merged.n);
  expect(item.alsoIn).toHaveLength(2);
});

test("a post under the person's own trusted profile is likely", () => {
  const s = state('Shensi Ding', 'Merge', [
    rec({ title: 'Shensi Ding on X: shipping today', url: 'https://x.com/shensi/status/123', match: 'possible', source: 'web-search' }),
  ]);
  s.threads = { u: { kind: 'url', value: 'https://x.com/shensi', trusted: true, platform: 'X' } };
  expect(buildReport(s).sources[0].match).toBe('likely');
});

test('the timeline holds no archive captures and no domain registered before the company existed', () => {
  const report = buildReport(state('Eric Glyman', 'Ramp', [
    rec({ title: 'Ramp was founded in March 2019 by Eric Glyman', quote: 'Ramp was founded in March 2019 by Eric Glyman and Karim Atiyeh.', url: 'https://tl.test/1', category: 'career', date: '2019-03-01' }),
    rec({ title: 'fortune.com page archived 10 times', url: 'https://web.archive.org/web/*/fortune.com/a', match: 'confirmed', source: 'web-archive', category: 'archive', date: '2026-11-04', data: { kind: 'snapshot' } }),
    rec({ title: 'ramp.com: registered 1994-03-14', url: 'https://rdap.org/domain/ramp.com', match: 'company', source: 'domain-history', category: 'corporate', date: '1994-03-14', data: { domain: 'ramp.com', registered: '1994-03-14' } }),
  ]));
  expect(report.timeline.map((t) => t.title)).toEqual(['Ramp was founded in March 2019 by Eric Glyman']);
  const domain = report.sections.flatMap((s) => s.items).find((f) => f.source === 'domain-history');
  expect(domain.title).toMatch(/earlier holder/);
  expect(quotedDeepBrief(report, 'x').split('## WHAT CHECKS OUT')[1].split('##')[0]).not.toMatch(/ramp\.com/);
});

test('one liquidation in several gazette notices is one matter', () => {
  const g = (title, id) => rec({ title, url: `https://gz.test/${id}`, quote: 'Name of Company: ZETAFORGE HOLDINGS LTD.', source: 'uk-gazette', category: 'corporate', match: 'possible', severity: 'medium', date: '2024-07-23' });
  const report = buildReport(state('Ann Zetaforge', 'Zetaforge', [
    g('Appointment of Liquidators: ZETAFORGE HOLDINGS LTD.', 1), g('Notices to Creditors: ZETAFORGE HOLDINGS LTD.', 2), g('Resolutions for Winding-up: ZETAFORGE HOLDINGS LTD.', 3),
  ]));
  expect(report.possibleNamesake).toHaveLength(1);
  expect(report.possibleNamesake[0].more).toHaveLength(2);
});

test('claims that changed hold only changes to a claim about the person', () => {
  const ch = (o) => rec({ source: 'web-archive', category: 'archive', severity: 'low', date: '2025-04-18', ...o });
  const report = buildReport(state('Eric Glyman', 'Ramp', [
    ch({ title: 'ramp.com page: title changed', url: 'https://web.archive.org/web/2026/https://ramp.com/authors/eric-glyman', data: { kind: 'change', page: 'https://ramp.com/authors/eric-glyman', field: 'headline', before: 'Co-founder & CEO, Ramp', after: 'Co-Founder & Co-CEO, Ramp' } }),
    ch({ title: 'ramp.com page: bio rewritten', url: 'https://web.archive.org/web/2025/https://ramp.com/blog/eric-glyman-lessons-learned', data: { kind: 'change', page: 'https://ramp.com/blog/eric-glyman-lessons-learned', field: 'bio', before: 'Former Sr. Content Marketing Manager, Ramp. Prior to Ramp, Stefanie worked as a finance reporter at Institutional Investor. She graduated from the University of Delaware in 2015.', after: 'Former Sr. Content Marketing Manager, Ramp' } }),
    ch({ title: 'merge.dev page: bio rewritten', url: 'https://web.archive.org/web/2024/https://merge.dev/about', data: { kind: 'change', page: 'https://merge.dev/about', field: 'bio', before: 'Eric Glyman and his co-founder are former college classmates and current best friends.', after: 'Eric Glyman and his co-founder turned their shared frustration into innovation.' } }),
    ch({ title: 'ramp.com page: bio rewritten 2023', url: 'https://web.archive.org/web/2023/https://ramp.com/authors/eric-glyman', data: { kind: 'change', page: 'https://ramp.com/authors/eric-glyman', field: 'bio', before: 'Eric is the co-founder and CEO of Ramp. He previously co-founded Paribus (acq. in 2016 by Capital One).', after: 'BA in Economics, Harvard University' } }),
  ]));
  expect(report.claimChanges.map((c) => c.title)).toEqual(expect.arrayContaining(['ramp.com page: title changed', 'ramp.com page: bio rewritten 2023']));
  expect(report.claimChanges).toHaveLength(2);
  // the other changes stay in the archive list
  expect(report.sections.find((s) => s.key === 'archive').items).toHaveLength(4);
});

test('every cap states what it cut', () => {
  const many = Array.from({ length: 70 }, (_, i) => rec({ title: `Trevor Milton joined board ${i}`, url: `https://cap.test/${i}`, category: 'career', date: `20${String(10 + (i % 10))}-01-01` }));
  const flags = Array.from({ length: 16 }, (_, i) => rec({ title: `Trevor Milton sued by investor group ${i} ${'abcdefghijklmnop'[i]}xx`, url: `https://flag.test/${i}`, severity: 'medium', date: `${2000 + i}-03-15` }));
  const report = buildReport(state('Trevor Milton', 'Nikola', [...many, ...flags]));
  expect(report.omitted.timeline).toBeGreaterThan(0);
  const brief = quotedDeepBrief(report, 'test');
  expect(report.redFlags.length).toBeGreaterThan(14);
  expect(brief).toMatch(new RegExp(`and ${report.redFlags.length - 14} more`));
});

test('when no tied record names the person with the company typed, the report says so', () => {
  const report = buildReport(state('Trevor Milton', 'Nikola', [
    rec({ title: 'Trevor Milton spoke at a rally', url: 'https://id.test/1', match: 'possible' }),
  ]));
  expect(report.identityNote).toMatch(/No record found ties Trevor Milton to Nikola/);
  expect(report.identity.note).toMatch(/No record found ties/);
  expect(quotedDeepBrief(report, 'x')).toMatch(/No record found ties Trevor Milton to Nikola/);
  const tied = buildReport(state('Trevor Milton', 'Nikola', [rec({ title: 'Trevor Milton founded Nikola', url: 'https://id.test/2' })]));
  expect(tied.identityNote).toBeNull();
});

test('a very common name is flagged with counts only', () => {
  const report = buildReport(state('John Smith', 'Zeta', [
    rec({ title: 'John Smith of Acme', url: 'https://cn.test/1', match: 'possible' }),
  ]));
  expect(report.commonName).toMatchObject({ common: true });
});

describe('the profile contract', () => {
  const cite = (ids) => (ids || []).map((id) => Number(String(id).replace(/\D/g, ''))).filter(Boolean);
  test('publishes everything resume and companyFacts carry, with citation numbers', () => {
    const profile = {
      headline: 'Co-Founder and CEO, Ramp', headlineIds: ['f1'], titles: ['Co-Founder', 'CEO'], company: 'Ramp', education: [], earlier: [], about: [], links: [],
      resume: {
        roles: [{ org: 'Ramp', title: 'Co-CEO', from: 2019, to: null, current: true, ids: ['f1'], basis: 'record' }, { org: 'Paribus', title: 'Co-Founder and CEO', from: 2014, to: 2019, current: false, ids: ['f2'], basis: 'text' }],
        education: [{ school: 'Harvard University', degree: 'BA', field: 'Economics', from: null, to: 2012, ids: ['f3'], basis: 'text' }],
        founded: [{ org: 'Paribus', year: 2014, with: ['Karim Atiyeh'], outcome: 'acquired by Capital One in 2016', ids: ['f2'] }],
        boards: [{ org: 'Acme Fund', role: 'board member', from: 2021, to: null, ids: ['f4'] }],
        investments: [{ text: 'angel investor', org: null, ids: ['f5'] }],
        recognition: [{ text: 'Forbes 30 Under 30', year: 2016, ids: ['f6'] }],
        leads: [{ text: 'Financial analyst in New York', why: 'one profile names the firm', ids: ['f7'] }],
      },
      companyFacts: {
        legalNames: [{ name: 'Ramp Business Corporation', ids: ['f8'] }], domains: [{ domain: 'ramp.com', ids: ['f8'] }], founded: { year: 2019, ids: ['f9'] },
        funding: [{ round: 'Series D', amount: '$300M', date: '2025-11', lead: 'Lightspeed', investors: ['Founders Fund'], ids: ['f9'] }], investors: [{ name: 'Founders Fund', ids: ['f9'] }], standing: [{ text: 'about 1,000 staff', ids: ['f9'] }],
      },
    };
    const out = reportProfile(profile, cite);
    expect(out.roles[0]).toMatchObject({ org: 'Ramp', title: 'Co-CEO', current: true, cites: [1], basis: 'record' });
    expect(out.roles[1]).toMatchObject({ org: 'Paribus', from: 2014, to: 2019, cites: [2] });
    expect(out.earlier).toEqual([{ org: 'Paribus', role: 'Co-Founder and CEO', cites: [2] }]);
    expect(out.education[0]).toMatchObject({ school: 'Harvard University', degree: 'BA', field: 'Economics', to: 2012, cites: [3] });
    expect(out.founded[0]).toMatchObject({ org: 'Paribus', year: 2014, cites: [2] });
    expect(out.boards[0]).toMatchObject({ org: 'Acme Fund', cites: [4] });
    expect(out.investments[0]).toMatchObject({ text: 'angel investor', cites: [5] });
    expect(out.recognition[0]).toMatchObject({ text: 'Forbes 30 Under 30', year: 2016, cites: [6] });
    expect(out.leads[0]).toMatchObject({ text: 'Financial analyst in New York', cites: [7] });
    expect(out.readBy).toBe('records');
    const { reportCompanyFacts } = require('../../../src/server/founder/report');
    const facts = reportCompanyFacts(profile.companyFacts, cite);
    expect(facts.legalNames[0]).toEqual({ name: 'Ramp Business Corporation', cites: [8] });
    expect(facts.founded).toEqual({ year: 2019, cites: [9] });
    expect(facts.funding[0]).toMatchObject({ round: 'Series D', lead: 'Lightspeed', cites: [9] });
  });

  test('falls back to the older fields without resume', () => {
    const out = reportProfile({ headline: 'CEO, Zeta', headlineIds: ['f1'], titles: ['CEO'], company: 'Zeta', education: [{ school: 'MIT', ids: ['f2'] }], earlier: [{ org: 'Acme', role: 'engineer', ids: ['f3'] }], about: [], links: [] }, cite);
    expect(out.roles.map((r) => r.org)).toEqual(['Zeta', 'Acme']);
    expect(out.education[0]).toMatchObject({ school: 'MIT', cites: [2] });
    expect(out.leads).toEqual([]);
  });

  test('buildReport publishes companyFacts', () => {
    const report = buildReport(state('Trevor Milton', 'Nikola', [rec({ title: 'Trevor Milton founded Nikola', url: 'https://cf.test/1' })]));
    expect(report).toHaveProperty('companyFacts');
  });
});

test('a page holding only placeholder text leaves the report, counted', () => {
  const report = buildReport(state('Shensi Ding', 'Merge', [
    rec({ title: 'accel.com page as of 2023-01-01', quote: 'This is some text inside of a div block.', url: 'https://web.archive.org/web/2023/https://accel.com/x', source: 'web-archive', category: 'archive', match: 'possible', data: { kind: 'snapshot' } }),
    rec({ title: 'Shensi Ding, CEO of Merge', url: 'https://ph.test/1' }),
  ]));
  expect(report.totals.records).toBe(1);
  expect(report.omitted.placeholder).toBe(1);
});
