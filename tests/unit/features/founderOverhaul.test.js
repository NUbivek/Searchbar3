/**
 * @jest-environment node
 *
 * The 2026-11-20 overhaul: the profile read from tied records, the page reader, the public-record
 * screens checklist, company names several companies share, and the quick brief keeping only pages
 * about this person.
 */
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(), PROVIDERS: [{ id: 'groq' }], providerEnabled: jest.fn(() => false) }));
jest.mock('../../../src/utils/sources/curatedIndex', () => ({
  searchCuratedSources: jest.fn(),
  searchCuratedForEntity: jest.fn(async () => []),
  getCuratedIndexStatus: jest.fn(() => ({ ready: true, itemsAvailable: 1, indexableSources: 1 })),
}));
jest.mock('../../../src/utils/sources/hackernewsAlgolia', () => ({ searchHackerNews: jest.fn() }));

const { createSubject } = require('../../../src/server/founder/identity');
const { buildProfile, bioSentences } = require('../../../src/server/founder/profile');
const { buildReport } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');
const { pageReaderConnector, parseRobots, robotsAllow, readable } = require('../../../src/server/founder/sources/pages');
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { runFounderCheck } = require('../../../src/server/founderCheck');

const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
let seq = 0;
const rec = (o) => ({ id: `r${(seq += 1)}`, source: 'web-search', sourceLabel: 'Open-web search', category: 'press', severity: 'info', quote: '', match: 'confirmed', url: `https://x.test/${seq}`, ...o });

describe('profile', () => {
  const records = [
    rec({ title: 'Jane Roe - Acme | LinkedIn', quote: 'Experience: Acme · Education: Columbia University · Location: New York', category: 'identity' }),
    rec({ title: 'Acme founder story', quote: 'Jane Roe, co-founder and CEO of Acme, previously worked at Credit Suisse and Expanse. She studied computer science at Columbia.' }),
    rec({ title: 'Podcast', quote: 'Jane Roe, Acme CEO & Co-Founder, joins the show.' }),
    rec({ title: 'Namesake', quote: 'Jane Roe graduated from Ohio State University and worked at Initech.', match: 'possible' }),
  ];
  const profile = buildProfile(subject, records, [{ kind: 'url', value: 'https://linkedin.com/in/janeroe', platform: 'linkedin', trusted: true }]);

  test('role, education and earlier employers come from tied records only', () => {
    expect(profile.headline).toBe('Co-Founder and CEO, Acme');
    expect(profile.education.map((e) => e.school)).toEqual(expect.arrayContaining(['Columbia University']));
    expect(profile.education.map((e) => e.school).join(' ')).not.toMatch(/Ohio/);
    expect(profile.earlier.map((e) => e.org)).toEqual(expect.arrayContaining(['Credit Suisse', 'Expanse']));
    expect(profile.earlier.map((e) => e.org)).not.toContain('Initech');
    expect(profile.earlier.map((e) => e.org)).not.toContain('Acme');
    expect(profile.links).toEqual([{ platform: 'linkedin', url: 'https://linkedin.com/in/janeroe' }]);
  });

  test('every line keeps the record it came from', () => {
    for (const e of [...profile.education, ...profile.earlier]) expect(e.ids.length).toBeGreaterThan(0);
  });

  test('a page: sentences naming the person, and the ones that carry on about them', () => {
    const text = 'Welcome to the site. Jane Roe is the co-founder of Acme. She previously worked at Credit Suisse as an analyst. Bob Other founded Initech in 2010. He studied at Yale.';
    const got = bioSentences(subject, text).map((s) => s.text);
    expect(got).toEqual(['Jane Roe is the co-founder of Acme.', 'She previously worked at Credit Suisse as an analyst.']);
  });
});

describe('report', () => {
  function state(findings, extra = {}) {
    const s = startState({ name: 'Jane Roe', company: 'Acme' });
    s.findings = findings;
    return Object.assign(s, extra);
  }

  test('a name-only record that names an employer from their own bio is likely theirs, never confirmed', () => {
    // round 3: the employer must come from two of their records (one sentence is too thin); with one, the
    // record stays possible and is shown as a lead to confirm
    const one = buildReport(state([
      rec({ title: 'Founder story', quote: 'Jane Roe, co-founder of Acme, previously worked at Credit Suisse.' }),
      rec({ source: 'finra-brokercheck', category: 'regulatory', match: 'possible', title: 'Jane Roe (CRD 1): no disclosures', quote: 'Jane Roe, CRD 1. Firms: Credit Suisse Securities (USA) LLC (2015 to 2017).' }),
    ]));
    expect(one.sections.find((s) => s.key === 'regulatory').items.map((f) => f.match)).toEqual(['possible']);
    expect(one.profile.leads.map((l) => l.text)).toEqual(['Jane Roe (CRD 1): no disclosures']);
    const report = buildReport(state([
      rec({ title: 'Founder story', quote: 'Jane Roe, co-founder of Acme, previously worked at Credit Suisse.' }),
      rec({ title: 'Founder story 2', quote: 'Jane Roe previously worked at Credit Suisse.' }),
      rec({ source: 'finra-brokercheck', category: 'regulatory', match: 'possible', title: 'Jane Roe (CRD 1): no disclosures', quote: 'Jane Roe, CRD 1. Firms: Credit Suisse Securities (USA) LLC (2015 to 2017).' }),
      rec({ source: 'finra-brokercheck', category: 'regulatory', match: 'possible', title: 'Jane Roe (CRD 2): no disclosures', quote: 'Jane Roe, CRD 2. Firms: Other Bank LLC.' }),
    ]));
    const broker = report.sections.find((s) => s.key === 'regulatory').items;
    expect(broker.map((f) => f.match).sort()).toEqual(['likely', 'possible']);
    expect(report.profile.earlier[0].org).toBe('Credit Suisse');
    expect(report.profile.earlier[0].cites.length).toBeGreaterThan(0);
  });

  test('a company name shared by several registered companies ties nothing by itself', () => {
    const registry = (i) => rec({ source: 'us-state-registries', category: 'corporate', match: 'possible', title: `ACME LLC, register ${i}`, url: `https://reg.test/${i}` });
    const findings = [
      rec({ title: 'Jane Roe, co-founder and CEO of Acme' }),
      registry(1), registry(2), registry(3),
      rec({ source: 'trademarks', category: 'ip', match: 'company', title: 'Trademark ACME, owner Acme LLC (Tennessee)' }),
      rec({ source: 'leak-sites', category: 'exposure', match: 'company', title: 'Acme listed on a leak site', quote: 'Victim: Acme (acme.dev)' }),
    ];
    const threads = { d: { kind: 'domain', value: 'acme.dev', trusted: true } };
    const report = buildReport(state(findings, { threads }));
    expect(report.sharedCompanyName).toBe(true);
    const all = report.sections.flatMap((s) => s.items);
    expect(all.find((f) => f.source === 'trademarks').match).toBe('possible');
    // names their own site: still about their company
    expect(all.find((f) => f.source === 'leak-sites').match).toBe('company');
    // with a distinctive name nothing is downgraded
    const plain = buildReport(state(findings.filter((f) => f.source !== 'us-state-registries'), { threads }));
    expect(plain.sections.flatMap((s) => s.items).find((f) => f.source === 'trademarks').match).toBe('company');
  });

  test('the screens checklist says what each screen was asked and what came back', () => {
    const sources = {
      'sanctions-lists': { label: 'Sanctions lists', runs: 4, errors: 0, findings: 0 },
      'us-exclusions': { label: 'US exclusion lists', runs: 2, errors: 2, findings: 0, lastError: 'down' },
      'finra-brokercheck': { label: 'FINRA BrokerCheck', runs: 1, errors: 0, findings: 1 },
      'court-dockets': { label: 'US federal court dockets', off: true },
      'leak-sites': { label: 'Leak-site listings', runs: 1, errors: 0, findings: 0 },
      'web-search': { label: 'Open-web search', runs: 9, errors: 0, findings: 3 },
    };
    const report = buildReport(state([
      rec({ source: 'finra-brokercheck', category: 'regulatory', match: 'possible', title: 'Jane Roe (CRD 2): no disclosures' }),
    ], { sources }));
    const flat = Object.fromEntries(report.screens.flatMap((g) => g.items).map((s) => [s.id, s.status]));
    expect(flat).toEqual({ 'sanctions-lists': 'clear', 'us-exclusions': 'failed', 'finra-brokercheck': 'name-only', 'court-dockets': 'off', 'leak-sites': 'clear' });
    expect(report.screens.map((g) => g.group)).toContain('Dark-web leak sites and data breaches (company level)');
  });
});

describe('page reader', () => {
  const headers = new Map([['content-type', 'text/html']]);
  const answer = (url, status, text) => ({ status, headers, url, text: async () => text });
  const html = '<html><head><title>Jane Roe - Co-Founder, Acme</title></head><body><p>Jane Roe is the co-founder and CEO of Acme. She previously worked at Credit Suisse. She studied computer science at Columbia University.</p></body></html>';
  const ctx = { subject, deadline: Date.now() + 30000, findings: () => [] };
  afterEach(() => { setTransport(); __resetCacheForTests(); });

  test('social networks, people-search sites and files are never opened', () => {
    expect(readable('https://www.linkedin.com/in/janeroe')).toBe(false);
    expect(readable('https://x.com/janeroe')).toBe(false);
    expect(readable('https://rocketreach.co/jane-roe-email_1')).toBe(false);
    expect(readable('https://acme.dev/files/jane.pdf')).toBe(false);
    expect(readable('https://acme.dev/about')).toBe(true);
    expect(pageReaderConnector.plan({ kind: 'url', value: 'https://www.linkedin.com/in/janeroe' })).toEqual([]);
  });

  test('robots.txt: the longest matching rule decides, and our own group wins over the general one', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/press\n\nUser-agent: diligence-research\nDisallow: /team$');
    expect(robotsAllow(parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/press'), '/private/x')).toBe(false);
    expect(robotsAllow(parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/press'), '/private/press/1')).toBe(true);
    expect(robotsAllow(rules, '/team')).toBe(false);
    expect(robotsAllow(rules, '/private/x')).toBe(true);
    expect(robotsAllow(parseRobots('User-agent: *\nDisallow:'), '/anything')).toBe(true);
  });

  test('a page the site closes to automated readers is not opened', async () => {
    const seen = [];
    setTransport(async (url) => { seen.push(url); return url.endsWith('/robots.txt') ? answer(url, 200, 'User-agent: *\nDisallow: /') : answer(url, 200, html); });
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://bio.test/jane-roe', template: 'read' }, ctx);
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/does not allow automated reading/);
    expect(seen).toEqual(['https://bio.test/robots.txt']);
  });

  test('an open page yields career and education records tied to the person, and threads to follow', async () => {
    setTransport(async (url) => (url.endsWith('/robots.txt') ? answer(url, 404, '') : answer(url, 200, html)));
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://bio.test/jane-roe', template: 'read' }, ctx);
    expect(out.findings.map((f) => f.category).sort()).toEqual(['career', 'education']);
    expect(out.findings.every((f) => f.match === 'confirmed')).toBe(true);
    expect(out.findings.find((f) => f.category === 'career').quote).toMatch(/Credit Suisse/);
    expect(out.threads.some((t) => t.kind === 'url')).toBe(false);
    const profile = buildProfile(subject, out.findings);
    expect(profile.earlier.map((e) => e.org)).toContain('Credit Suisse');
    expect(profile.education.map((e) => e.school)).toContain('Columbia University');
  });

  test('a page that does not name the person yields nothing', async () => {
    setTransport(async (url) => (url.endsWith('/robots.txt') ? answer(url, 404, '') : answer(url, 200, '<p>Bob Other founded Initech. He worked at Credit Suisse.</p>')));
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://bio.test/bob', template: 'read' }, ctx);
    expect(out.findings).toEqual([]);
  });
});

describe('quick brief: only pages about this person', () => {
  const R = (o) => ({ content: '', source: 'web', sourceName: 'Web', publishedAt: '2025-01-01T00:00:00Z', ...o });
  const results = [
    R({ title: 'Jane Roe - Acme | LinkedIn', url: 'https://www.linkedin.com/in/janeroe', content: 'Jane Roe. Co-Founder at Acme. Experience: Acme.' }),
    R({ title: 'Bob Other - Acme | LinkedIn', url: 'https://www.linkedin.com/in/bobother', content: 'Proud to work with Jane Roe at Acme.' }),
    R({ title: 'Jane Roe email and phone', url: 'https://rocketreach.co/jane-roe-email_1', content: 'Jane Roe, Acme. Contact details.' }),
    R({ title: 'Jane Roe wins county bake-off', url: 'https://localnews.test/bake', content: 'Jane Roe of Springfield won first prize.' }),
    R({ title: 'Acme raises Series B', url: 'https://news.test/acme', content: 'Jane Roe, co-founder and CEO of Acme, said the round will fund hiring.' }),
  ];
  const searchers = {
    curated: async () => results, hackernews: async () => [], web: async () => [],
    courtlistener: async () => { throw new Error('skipped'); }, webConfigured: () => false,
  };

  test('someone else\'s profile, a contact broker and a namesake without the company are left out', async () => {
    const out = await runFounderCheck({ name: 'Jane Roe', company: 'Acme', useLLM: false }, { searchers });
    const urls = out.sources.map((s) => s.url);
    expect(urls).toEqual(expect.arrayContaining(['https://www.linkedin.com/in/janeroe', 'https://news.test/acme']));
    expect(urls).not.toContain('https://www.linkedin.com/in/bobother');
    expect(urls).not.toContain('https://rocketreach.co/jane-roe-email_1');
    expect(urls).not.toContain('https://localnews.test/bake');
    expect(out.warnings.join(' ')).toMatch(/were left out/);
  });

  test('without a company, pages naming the person are kept (still never a broker or another person\'s profile)', async () => {
    const out = await runFounderCheck({ name: 'Jane Roe', useLLM: false }, { searchers });
    const urls = out.sources.map((s) => s.url);
    expect(urls).toContain('https://localnews.test/bake');
    expect(urls).not.toContain('https://rocketreach.co/jane-roe-email_1');
    expect(urls).not.toContain('https://www.linkedin.com/in/bobother');
  });
});

describe('review fixes: whose career is it', () => {
  test('a colleague\'s or a relative\'s employer and school are never credited to the person', () => {
    const bio = (quote) => rec({ source: 'page-reader', category: 'career', data: { kind: 'bio' }, quote });
    const p = buildProfile(subject, [
      bio('Jane Roe and Bob Smith co-founded Acme in 2020. Previously, Bob Smith was an engineer at Google.'),
      bio('Jane Roe is the co-founder of Acme. Jane Smith, our CFO, previously worked at Deloitte and studied at Yale University.'),
      rec({ title: 'Acme', quote: 'Acme, founded by Jane Roe and Bob Smith, a former engineer at Initech.' }),
      rec({ title: 'News', quote: 'Jane Roe joined Bob Smith at Acme.' }),
    ]);
    expect(p.earlier).toEqual([]);
    expect(p.education).toEqual([]);
    const text = 'Jane Roe is the co-founder of Acme. Her husband, Tom Roe, previously worked at Goldman Sachs. She grew up in Ohio, the daughter of a banker.';
    expect(bioSentences(subject, text, { aboutThem: true }).map((s) => s.text)).toEqual(['Jane Roe is the co-founder of Acme.']);
  });

  test('a "He" after a sentence that brings in someone else is not read as the person (review: pronoun carry)', () => {
    // an article's text (the page reader's own records hold only sentences bioSentences already kept)
    const p = buildProfile(subject, [rec({ title: 'Acme story', quote: 'Jane Roe founded Acme in 2018. She hired Bob Smith as her first engineer. He previously worked at Google from 2012 to 2017.' })]);
    expect(p.earlier.map((e) => e.org)).not.toContain('Google');
    const text = 'Jane Roe founded Acme in 2018. She hired Bob Smith as her first engineer. He previously worked at Google.';
    expect(bioSentences(subject, text, { aboutThem: true }).map((s) => s.text)).not.toContain('He previously worked at Google.');
    // a plain run of "She" sentences still carries, and a place name is not taken for another person
    const q = buildProfile(subject, [rec({ title: 'Acme story', quote: 'Jane Roe founded Acme in 2018. She served in the Israeli Navy. She previously worked at Stripe.' })]);
    expect(q.earlier.map((e) => e.org)).toEqual(['Stripe']);
  });

  test('sentences that open on the person are read, with a capitalised lead-in too', () => {
    const p = buildProfile(subject, [
      rec({ source: 'page-reader', category: 'career', data: { kind: 'bio' }, quote: 'Jane Roe is the CEO of Acme. Prior to Acme, she was a product manager at Stripe. Jane and Bob graduated from Columbia University.' }),
      rec({ title: 'Profile', quote: 'Previously, Jane Roe worked at Credit Suisse.' }),
    ]);
    expect(p.earlier.map((e) => e.org).sort()).toEqual(['Credit Suisse', 'Stripe']);
    expect(p.education.map((e) => e.school)).toEqual(['Columbia University']);
  });

  test('a serious name-only record is not raised on an employer one sentence gives', () => {
    const s = startState({ name: 'Jane Roe', company: 'Acme' });
    s.findings = [
      rec({ title: 'Founder story', quote: 'Jane Roe previously worked at Google.' }),
      rec({ source: 'court-records-open', category: 'litigation', severity: 'high', match: 'possible', title: 'United States v. Jane Roe', quote: 'Jane Roe, a former Google contractor, was charged with wire fraud.' }),
    ];
    const report = buildReport(s);
    expect(report.redFlags).toHaveLength(0);
    expect(report.possibleNamesake).toHaveLength(1);
  });

  test('one company registered in several states is not a shared name', () => {
    const s = startState({ name: 'Jane Roe', company: 'Acme' });
    s.findings = [
      rec({ title: 'Jane Roe, CEO of Acme' }),
      ...['Texas', 'Oregon', 'Ohio'].map((st, i) => rec({ source: 'us-state-registries', category: 'corporate', match: 'possible', title: `${st} register: Acme, Inc.`, quote: 'Acme, Inc. — register number 1 — Formed: 6 July 2017', url: `https://reg.test/s${i}` })),
      rec({ source: 'trademarks', category: 'ip', match: 'company', title: 'Trademark ACME' }),
    ];
    const report = buildReport(s);
    expect(report.sharedCompanyName).toBe(false);
    expect(report.sections.flatMap((x) => x.items).find((f) => f.source === 'trademarks').match).toBe('company');
  });

  test('robots.txt: a group for another reader whose name is part of ours is not ours', () => {
    const rules = parseRobots('User-agent: research\nDisallow: /\n\nUser-agent: *\nAllow: /');
    expect(robotsAllow(rules, '/about')).toBe(true);
  });
});

test('profile lines from search results: the company after "at", fields that end at the next label, one entry per profile', () => {
  const { extractProfiles, nameMatcher } = require('../../../src/server/founderCheck');
  const out = extractProfiles([
    { title: 'Jane Roe - Co-Founder at Acme | The context engine for agents', url: 'https://www.linkedin.com/in/janeroe', snippet: 'Acme is the context engine for agents.' },
    { title: 'Jane Roe', url: 'https://linkedin.com/in/janeroe', snippet: 'Location: New York, New York, United States Experience: 6 years 3 months LinkedIn: www.linkedin.com/in/janeroe Education: Columbia University' },
    { title: 'Jane Roe - Acme | LinkedIn', url: 'https://uk.linkedin.com/in/jane-roe-2', snippet: 'Experience: Acme · Location: London' },
  ], nameMatcher('Jane Roe'));
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual(expect.objectContaining({ role: 'Co-Founder', company: 'Acme', location: 'New York, New York, United States', education: 'Columbia University' }));
  expect(out[1]).toEqual(expect.objectContaining({ role: null, company: 'Acme', location: 'London' }));
});

test('a school is theirs when they are the one who graduated, wherever the sentence starts; a headline says founder once', () => {
  const s2 = createSubject({ name: 'Shensi Ding', company: 'Merge' });
  const p = buildProfile(s2, [
    rec({ source: 'page-reader', category: 'education', data: { kind: 'bio' }, quote: 'The journey began in 2015 after Shensi and Gil graduated from Columbia University.' }),
    rec({ title: 'Shensi Ding, founder of Merge' }), rec({ title: 'Shensi Ding, Co-Founder and CEO of Merge' }), rec({ title: 'Merge CEO & Co-Founder Shensi Ding' }),
    rec({ source: 'page-reader', category: 'career', data: { kind: 'bio' }, quote: 'The firm grew after Gil and Bob Smith graduated from Yale University.' }),
  ]);
  expect(p.education.map((e) => e.school)).toEqual(['Columbia University']);
  expect(p.headline).toBe('Co-Founder and CEO, Merge');
});

test('a one-word company name that is an ordinary word: news about the word is not news about the company', () => {
  const s = startState({ name: 'Eric Glyman', company: 'Ramp' });
  const news = (title, quote = '') => rec({ source: 'news-archive', match: 'company', severity: 'high', title, quote });
  s.findings = [
    rec({ title: 'Eric Glyman, co-founder and CEO of Ramp' }),
    news('Body found near Misty Water Boat Ramp identified, homicide investigation underway'),
    news("Son-in-law of 'The Ramp' church founder fired after admitting abuse"),
    news('Ramp sued by rival fintech over trade secrets', 'The company, valued at $13 billion, denies the claims.'),
  ];
  const report = buildReport(s);
  expect(report.companyMatters.map((m) => m.title)).toEqual(['Ramp sued by rival fintech over trade secrets']);
  expect(report.redFlags).toHaveLength(0);
  // round 3: they leave the numbered report and are counted and listed with the reason
  expect(report.sections.flatMap((x) => x.items).filter((f) => f.match === 'possible')).toHaveLength(0);
  expect(report.wordOnly.count).toBe(2);
});
