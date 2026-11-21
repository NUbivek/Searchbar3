/**
 * @jest-environment node
 *
 * Loose ends of phases 1 and 2 in the shared core (needs-phase1.json / needs-phase2.json): the changes other
 * engineers asked for in finding.js, identity.js, names.js, extract.js, gaps.js, profile.js, profileModel.js,
 * companyFacts.js, report.js, networkLink.js and founderCheck.js.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/llm/providers', () => ({
  chatJson: jest.fn(),
  chatComplete: jest.fn(),
  reportAnswerQuality: jest.fn(async () => {}),
  prepareChain: jest.fn(),
  llmConfigured: () => true,
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: () => true,
}));

const providers = require('../../../src/server/llm/providers');
const { makeFinding, severityFromText } = require('../../../src/server/founder/finding');
const { createSubject, addAnchor, addCompanyAlias, matchSubject, exportAnchors, restoreSubject } = require('../../../src/server/founder/identity');
const { personNameMatcher, companyKeys } = require('../../../src/server/founder/names');
const { profileFromUrl } = require('../../../src/server/founder/extract');
const { findGaps } = require('../../../src/server/founder/gaps');
const { readProfile } = require('../../../src/server/founder/profileModel');
const { buildProfile } = require('../../../src/server/founder/profile');
const { buildReport, cleanScreens } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');
const { validateFounderInput, extractFounderEvidence } = require('../../../src/server/founderCheck');
const { listFinishedChecks } = require('../../../src/server/founder/networkLink');

beforeEach(() => jest.clearAllMocks());

let seq = 0;
const rec = (o) => ({ id: `e${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', severity: 'info', quote: '', match: 'confirmed', matchReasons: [], url: `https://n${seq}.test/a`, ...o });
function state(name, company, findings, extra = {}) {
  const s = startState({ name, company });
  s.findings = findings;
  return Object.assign(s, extra);
}

// ------------------------------------------------------------------ finding.js
describe('finding.js', () => {
  const jane = () => createSubject({ name: 'Jane Okonkwo', company: 'Zeta Robotics' });

  test('a graded record keeps the basis of its grade (needs-phase1 17)', () => {
    const f = makeFinding(jane(), { source: 'news-archive', sourceLabel: 'News', category: 'press', title: 'Jane Okonkwo of Zeta Robotics speaks', url: 'https://a.test/1' });
    expect(f.match).toBe('confirmed');
    expect(f.matchBasis).toEqual(['company']);
  });

  test("a matter's outcome and the person's part are kept in data.outcome (needs-phase2 16, 55)", () => {
    const f = makeFinding(jane(), { source: 'news-archive', sourceLabel: 'News', category: 'litigation', title: 'Jane Okonkwo of Zeta Robotics acquitted of fraud', quote: 'A jury acquitted Jane Okonkwo of all fraud charges.', url: 'https://a.test/2', severity: 'low' });
    expect(f.data.outcome).toEqual(expect.objectContaining({ outcome: 'acquitted' }));
    const plain = makeFinding(jane(), { source: 'news-archive', sourceLabel: 'News', category: 'press', title: 'Jane Okonkwo of Zeta Robotics speaks', url: 'https://a.test/3' });
    expect(plain.data?.outcome).toBeUndefined();
  });

  test('accusations and an attorney general letter are at least medium (needs-phase2 66)', () => {
    expect(['medium', 'high']).toContain(severityFromText('Founder accused of misleading investors'));
    expect(['medium', 'high']).toContain(severityFromText('Attorney General sends letter to Zeta over its billing'));
    expect(['medium', 'high']).toContain(severityFromText('Investors file class action against Zeta'));
    expect(severityFromText('Jane spoke at a conference')).toBe('info');
  });
});

// ------------------------------------------------------------------ identity.js
describe('identity.js: what the second reader proposes (needs-phase2 1)', () => {
  test('a reader company or school is a related anchor: alone it leaves a record possible, never confirmed', () => {
    const s = createSubject({ name: 'Jane Okonkwo', company: '' });
    expect(addAnchor(s, 'companies', 'Paribus', 'reader:f1')).toBe(true);
    expect(addAnchor(s, 'schools', 'Utah Valley University', 'reader:f1')).toBe(true);
    expect(s.anchors.companies.size).toBe(0);
    expect([...s.anchors.related.values()].map((a) => a.as).sort()).toEqual(['companies', 'schools']);
    const alone = matchSubject(s, 'Jane Okonkwo worked at Paribus for years.');
    expect(alone.level).toBe('possible');
    // a second anchor that is not the reader's agrees: likely at most
    addAnchor(s, 'people', 'Karim Atiyeh', 'found:f2');
    const two = matchSubject(s, 'Jane Okonkwo worked at Paribus with Karim Atiyeh.');
    expect(two.level).toBe('likely');
  });

  test('a reader origin never adds a legal name, and schools survive export and restore', () => {
    const s = createSubject({ name: 'Jane Okonkwo', company: 'Zeta Robotics' });
    expect(addCompanyAlias(s, { company: 'Zeta Robotics', alias: 'Zeta Robotics Holdings Inc.', origin: 'reader:f1' })).toBe(false);
    addAnchor(s, 'schools', 'Utah Valley University', 'reader:f1');
    const back = restoreSubject({ name: 'Jane Okonkwo', company: 'Zeta Robotics', anchors: exportAnchors(s) });
    expect([...back.anchors.related.values()].map((a) => a.as)).toEqual(['schools']);
  });
});

// ------------------------------------------------------------------ names.js
describe('names.js', () => {
  test("a namesake's longer name is the weak 'other-given', not the person (needs-phase2 8)", () => {
    const m = personNameMatcher('Elizabeth Holmes');
    expect(m.positions('The trust for Erin Elizabeth Holmes holds the shares.')).toEqual([]);
    expect(m.kind('The trust for Erin Elizabeth Holmes holds the shares.')).toBe('other-given');
    // a headline word or a list before the name is not a given name
    expect(m.positions('Convicted Fraudster Elizabeth Holmes Begins Prison Term')).toHaveLength(1);
    expect(m.positions('Sunny Balwani and Elizabeth Holmes were charged.')).toHaveLength(1);
    expect(personNameMatcher('Erin Elizabeth Holmes').positions('Erin Elizabeth Holmes holds the shares.')).toHaveLength(1);
  });

  test('company keys keep letters of every script (needs-phase2 48)', () => {
    expect(companyKeys('Яндекс')).toEqual(['яндекс']);
    expect(companyKeys('字节跳动')).toEqual(['字节跳动']);
  });
});

// ------------------------------------------------------------------ extract.js
describe('extract.js', () => {
  test('a regional LinkedIn host is one profile (needs-phase2 63)', () => {
    expect(profileFromUrl('https://fr.linkedin.com/in/jane-okonkwo/').url).toBe('https://linkedin.com/in/jane-okonkwo');
    expect(profileFromUrl('https://www.linkedin.com/in/jane-okonkwo').url).toBe('https://linkedin.com/in/jane-okonkwo');
  });
});

// ------------------------------------------------------------------ gaps.js
describe('gaps.js', () => {
  const tied = (i) => ({ id: `g${i}`, source: 'news-archive', sourceLabel: 'News', category: 'press', match: 'confirmed', title: `Trevor Milton of Nikola, story ${i}`, quote: 'Trevor Milton founded Nikola and spoke at length about hydrogen trucks and the plans of the company.' });
  const milton = () => { const s = startState({ name: 'Trevor Milton', company: 'Nikola' }); s.findings = [1, 2, 3].map(tied); return s; };

  test('a reader that did not answer says so (needs-phase2 46)', async () => {
    const out = await findGaps(milton(), { complete: async () => null });
    expect(out.failed).toBe(true);
    const thrown = await findGaps(milton(), { complete: async () => { throw new Error('down'); } });
    expect(thrown.failed).toBe(true);
  });

  test('a reader that answered is scored on how much of it held (needs-phase2 21)', async () => {
    const out = await findGaps(milton(), { complete: async () => ({ provider: 'groq', family: 'llama', data: { companies: [{ name: 'Ford', record: 1 }], schools: [], people: [], searches: [] } }) });
    expect(out.failed).toBeUndefined();
    expect(providers.reportAnswerQuality).toHaveBeenCalledWith(expect.objectContaining({ provider: 'groq' }), 0, 'extract');
  });
});

// ------------------------------------------------------------------ profileModel.js
describe('profileModel.js readProfile', () => {
  test('a fallback is named in trace (needs-phase2 35)', async () => {
    const trace = {};
    await readProfile({ profile: null, sources: [] }, { name: 'Jane Okonkwo', findings: [] }, { trace, complete: async () => null });
    expect(trace.fallback).toBe('no records');
    const f = { id: 'p1', source: 'news-archive', sourceLabel: 'News', category: 'press', match: 'confirmed', title: 'Jane Okonkwo profile', quote: 'Jane Okonkwo is the chief executive of Zeta Robotics, which she founded in 2019 after years at Paribus.' };
    const t2 = {};
    await readProfile({ profile: null, sources: [{ id: 'p1', n: 1 }] }, { name: 'Jane Okonkwo', company: 'Zeta Robotics', findings: [f] }, { trace: t2, complete: async () => null });
    expect(t2.fallback).toBe('no model');
    const t3 = {};
    await readProfile({ profile: null, sources: [{ id: 'p1', n: 1 }] }, { name: 'Jane Okonkwo', company: 'Zeta Robotics', findings: [f] }, { trace: t3, complete: async () => ({ provider: 'groq', model: 'm', family: 'llama', data: { roles: [{ org: 'Nowhere Corp', title: 'CEO', record: 1, quote: 'not in the record' }] } }) });
    expect(t3.fallback).toBe('nothing verified');
    expect(t3.provider).toBe('groq');
    expect(providers.reportAnswerQuality).toHaveBeenCalledWith(expect.objectContaining({ provider: 'groq' }), 0, 'extract');
  });
});

// ------------------------------------------------------------------ profile.js and companyFacts.js
describe('profile.js', () => {
  test('an archived profile snapshot gives roles and degrees as records (needs-phase2 62)', () => {
    const subject = createSubject({ name: 'Jane Okonkwo', company: 'Zeta Robotics' });
    const snap = {
      id: 's1', source: 'web-archive', sourceLabel: 'Web archive', category: 'archive', match: 'likely', date: '2019-05-01',
      title: 'Jane Okonkwo profile as of 2019-05-01', quote: 'Jane Okonkwo. VP Engineering at Paribus.', url: 'https://web.archive.org/web/2019/https://www.crunchbase.com/person/jane-okonkwo',
      data: { kind: 'snapshot', page: 'https://www.crunchbase.com/person/jane-okonkwo', capturedAt: '2019-05-01', claims: { format: 'crunchbase', roles: [{ title: 'VP Engineering', org: 'Paribus', dates: '2015 - 2018' }], education: [{ school: 'Harvard University', degree: 'AB', dates: '2006 - 2010' }] } },
    };
    const p = buildProfile(subject, [snap], []);
    const role = p.resume.roles.find((r) => r.org === 'Paribus');
    expect(role).toEqual(expect.objectContaining({ from: 2015, to: 2018, basis: 'record' }));
    const edu = p.resume.education.find((e) => /Harvard/.test(e.school));
    expect(edu).toEqual(expect.objectContaining({ degree: 'AB', basis: 'record' }));
  });

  test("the site's legal name is a company fact (needs-phase2 62)", () => {
    const subject = createSubject({ name: 'Jane Okonkwo', company: 'Zeta Robotics' });
    const legal = { id: 'l1', source: 'page-reader', sourceLabel: 'Page reader', category: 'corporate', match: 'company', title: 'Legal name on zeta.ai: Zeta Robotics, Inc.', quote: "The site's own footer names the company Zeta Robotics, Inc.", url: 'https://zeta.ai/legal', data: { kind: 'legal-name', company: 'Zeta Robotics', legalName: 'Zeta Robotics, Inc.', domain: 'zeta.ai' } };
    const p = buildProfile(subject, [legal], []);
    expect(p.companyFacts.legalNames.map((x) => x.name)).toContain('Zeta Robotics, Inc.');
    expect(p.companyFacts.domains.map((x) => x.domain)).toContain('zeta.ai');
  });
});

// ------------------------------------------------------------------ report.js
describe('report.js', () => {
  test("the person's own posts are their statements, never red flags (needs-phase2 25)", () => {
    const r = buildReport(state('Jane Okonkwo', 'Zeta', [
      rec({ source: 'bluesky', title: 'Jane Okonkwo: we were sued by a competitor today', severity: 'medium', date: '2024-01-02', data: { ownStatement: true } }),
    ]));
    expect(r.redFlags).toHaveLength(0);
    expect(r.ownStatements.map((x) => x.title)).toEqual(['Jane Okonkwo: we were sued by a competitor today']);
  });

  test('a record tied only through an assumed company is shown "if this is the right person" (needs-phase2 44)', () => {
    const r = buildReport(state('Jane Okonkwo', '', [
      rec({ title: 'Jane Okonkwo of Zeta charged with fraud', severity: 'high', match: 'likely', assumedTie: true, date: '2024-01-02' }),
    ], { identity: { status: 'assumed', company: 'Zeta', note: 'assumed' } }));
    expect(r.redFlags).toHaveLength(0);
    expect(r.ifRightPerson.map((x) => x.title)).toEqual(['Jane Okonkwo of Zeta charged with fraud']);
    expect(r.assumedCompany).toBe('Zeta');
  });

  test("a matter's outcome is shown as words (needs-phase2 56)", () => {
    const r = buildReport(state('Jane Okonkwo', 'Zeta', [
      rec({ title: 'Jane Okonkwo of Zeta charged with fraud', severity: 'high', date: '2024-01-02' }),
      rec({ title: 'Jane Okonkwo of Zeta charged with fraud, then acquitted', severity: 'high', date: '2024-01-20', data: { outcome: { outcome: 'acquitted', role: 'defendant' } } }),
    ]));
    expect(r.redFlags).toHaveLength(1);
    expect(r.redFlags[0].outcome).toEqual(expect.objectContaining({ text: 'acquitted', role: 'defendant' }));
  });

  test('related parties are screened from state.screened; offshore and wanted lists do not count (needs-phase2 30, 43)', () => {
    const s = state('Jane Okonkwo', 'Zeta', [rec({ title: 'Jane Okonkwo of Zeta' })], {
      threads: {
        'associate|karim atiyeh': { kind: 'associate', value: 'Karim Atiyeh', why: 'co-founder', trusted: true },
        'associate|gene lee': { kind: 'associate', value: 'Gene Lee', why: 'co-founder', trusted: true },
      },
      sources: { 'sanctions-lists': { label: 'Sanctions lists', runs: 3, errors: 0, findings: 0 }, 'us-exclusions': { label: 'US exclusions', runs: 3, errors: 1, findings: 0 } },
      screened: {
        'karim atiyeh': { name: 'Karim Atiyeh', ok: ['sanctions-lists'], missed: ['us-exclusions'] },
        'gene lee': { name: 'Gene Lee', ok: ['sanctions-lists', 'us-exclusions'], missed: [] },
      },
    });
    const r = buildReport(s);
    const karim = r.relatedParties.find((p) => p.name === 'Karim Atiyeh');
    const gene = r.relatedParties.find((p) => p.name === 'Gene Lee');
    expect(karim).toEqual(expect.objectContaining({ screened: false, screenedInPart: true, missedScreens: ['US exclusions'] }));
    expect(gene.screened).toBe(true);

    // an old saved check without state.screened: an offshore-leaks lookup is not a screen of an associate
    const old = state('Jane Okonkwo', 'Zeta', [rec({ title: 'Jane Okonkwo of Zeta' })], {
      threads: { 'associate|karim atiyeh': { kind: 'associate', value: 'Karim Atiyeh', why: 'co-founder', trusted: true } },
      sources: { 'offshore-leaks': { label: 'Offshore leaks', runs: 1, errors: 0, findings: 0 } },
      done: ['offshore-leaks|associate|Karim Atiyeh|'],
    });
    delete old.screened;
    expect(buildReport(old).relatedParties[0].screened).toBeUndefined();
  });

  test('lookups not run keep a screen from being clean, and a source never asked is listed (needs-phase2 28, 43)', () => {
    const r = buildReport(state('Jane Okonkwo', 'Zeta', [rec({ title: 'Jane Okonkwo of Zeta' })], {
      sources: {
        'sanctions-lists': { label: 'Sanctions lists', runs: 2, errors: 0, findings: 0, notRun: 1 },
        'us-exclusions': { label: 'US exclusions', runs: 0, errors: 0, findings: 0, notRun: 2 },
      },
    }));
    const items = r.screens.flatMap((g) => g.items);
    expect(items.find((i) => i.id === 'sanctions-lists').status).toBe('partial');
    expect(items.find((i) => i.id === 'us-exclusions').status).toBe('not-run');
    expect(r.coverage.clearScreens).toEqual([]);
    expect(r.coverage.notSearched.map((s) => s.label)).toContain('US exclusions');
    expect(r.coverage.partlyAnswered.map((s) => s.label)).toContain('Sanctions lists');
    expect(cleanScreens({ searched: [{ id: 'sanctions-lists', label: 'Sanctions lists', records: 0, failed: 0, notRun: 1 }] })).toEqual([]);
  });

  test('a record whose text was not read says so; suggested threads, legal names and the search note are shown (needs-phase2 7, 44, 61)', () => {
    const r = buildReport(state('Jane Okonkwo', 'Zeta', [
      rec({ source: 'sec-filings', category: 'corporate', title: 'Form D: Zeta Robotics, Inc. names Jane Okonkwo', data: { unread: true } }),
    ], {
      threads: { 'company|paribus': { kind: 'company', value: 'Paribus', why: 'suggested by the second reading', trusted: true, suggested: true } },
      legalNames: { 'zeta robotics': { name: 'Zeta Robotics, Inc.', of: 'Zeta', origin: 'e1' } },
      spent: { 'web-search:general': 2, 'web-search:headlines': 3, 'web-search:none': 1 },
    }));
    const all = r.sections.flatMap((s) => s.items);
    expect(all[0].textNotRead).toBe(true);
    expect(r.threads[0]).toEqual(expect.objectContaining({ suggested: true, label: 'suggested by the second reader' }));
    expect(r.legalNames).toEqual([expect.objectContaining({ name: 'Zeta Robotics, Inc.' })]);
    expect(r.coverage.searchNote).toMatch(/not searched on the open web/);
  });

  test('the patent summary counts the families tied now (needs-phase2 52-1)', () => {
    const r = buildReport(state('Jane Okonkwo', 'Zeta', [
      rec({ id: 'fam1', source: 'patents', category: 'ip', title: 'Robot arm (Zeta Robotics)', match: 'confirmed' }),
      rec({ id: 'fam2', source: 'patents', category: 'ip', title: 'Robot gripper (Zeta Robotics)', match: 'likely' }),
      rec({ id: 'fam3', source: 'patents', category: 'ip', title: 'Shoe sole (Acme Shoes)', match: 'possible' }),
      rec({ id: 'sum', source: 'patents', category: 'ip', title: 'Jane Okonkwo: named inventor on 3 patent families', match: 'likely', data: { families: 3, tiedToKnownCompany: 0, familyIds: ['fam1', 'fam2', 'fam3'] } }),
    ]));
    const summary = r.sections.flatMap((s) => s.items).find((f) => f.id === 'sum');
    expect(summary.title).toBe('Jane Okonkwo: named inventor on 3 patent families (2 tied to a known company)');
    expect(summary.data.tiedToKnownCompany).toBe(2);
  });

  test('a leak-site claim later confirmed by a breach notice is linked to it (needs-phase2 52-3)', () => {
    const r = buildReport(state('Jane Okonkwo', 'Zeta', [
      rec({ id: 'leak', source: 'leak-sites', category: 'exposure', match: 'company', title: 'Zeta listed on a ransomware leak site', date: '2024-01-10', data: { company: 'Zeta' } }),
      rec({ id: 'notice', source: 'breach-registers', category: 'exposure', match: 'company', title: 'Zeta data breach notice', date: '2024-03-01', data: { company: 'Zeta' } }),
      rec({ id: 'old', source: 'breach-registers', category: 'exposure', match: 'company', title: 'Zeta data breach notice', date: '2021-03-01', data: { company: 'Zeta' }, url: 'https://old.test/x' }),
    ]));
    const all = r.sections.flatMap((s) => s.items);
    const leak = all.find((f) => f.id === 'leak');
    const notice = all.find((f) => f.id === 'notice');
    expect(leak.confirmedBy).toBe(notice.n);
    expect(leak.claimNote).toBe('claimed, later confirmed by notice');
  });

  test('a BrokerCheck firm never raises another record on its own (needs-phase2 69)', () => {
    const bc = (i) => rec({ source: 'finra-brokercheck', sourceLabel: 'BrokerCheck', category: 'regulatory', title: `Jane Okonkwo registration ${i}`, quote: 'Jane Okonkwo: Morgan Keegan (2010 to 2014).', data: { firms: ['Morgan Keegan'] }, url: `https://bc${i}.test/x` });
    const r = buildReport(state('Jane Okonkwo', 'Zeta', [
      bc(1), bc(2),
      rec({ title: 'Jane Okonkwo of Morgan Keegan speaks at a regional bank conference', quote: 'Jane Okonkwo of Morgan Keegan spoke about bonds.', match: 'possible', date: '2012-05-05', url: 'https://mk.test/x' }),
    ]));
    expect(r.sections.flatMap((s) => s.items).find((f) => f.url === 'https://mk.test/x').match).toBe('possible');
  });
});

// ------------------------------------------------------------------ founderCheck.js
describe('founderCheck.js', () => {
  test('the quick brief takes names the deep check takes (needs-phase2 50)', () => {
    expect(validateFounderInput({ name: '张一鸣', company: 'ByteDance' })).toEqual(expect.objectContaining({ ok: true, name: '张一鸣' }));
    expect(validateFounderInput({ name: 'Jane Doe*' }).ok).toBe(false);
  });

  test("a company in a parenthetical about another person is not the person's, nor is a person they joined (needs-phase2 72)", () => {
    const ev = extractFounderEvidence({
      name: 'Jane Okonkwo', company: '',
      results: [{ title: 'Podcast with Jane Okonkwo', snippet: 'In 2021 Jane Okonkwo joined Erik Torenberg (Co-founder of Village Global) on his podcast to talk about payments.', url: 'https://pod.test/1' }],
    });
    const names = [...ev.pastCompanies.map((c) => c.company), ev.currentRole?.company].filter(Boolean);
    expect(names).not.toContain('Village Global');
    expect(names).not.toContain('Erik Torenberg');
  });
});

// ------------------------------------------------------------------ networkLink.js
describe('networkLink.js', () => {
  test('a check older than the retention window is not listed from memory (needs-phase2 47)', async () => {
    const now = Date.now();
    const memory = new Map([
      ['a', { id: 'a', owner: 'u1', status: 'done', name: 'Jane Okonkwo', company: 'Zeta', updatedAt: now - 3600e3, state: { report: { totals: { redFlags: 0 } } } }],
      ['b', { id: 'b', owner: 'u1', status: 'done', name: 'Karim Atiyeh', company: 'Ramp', updatedAt: now - 100 * 3600e3, state: { report: { totals: { redFlags: 0 } } } }],
    ]);
    const list = await listFinishedChecks('u1', { memory });
    expect(list.map((c) => c.id)).toEqual(['a']);
  });
});
