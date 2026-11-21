/**
 * @jest-environment node
 *
 * R3 (audit 2026-11-20), open-web and news sources (web.js, searchEngines.js): the records about other people
 * with the same name, the questions that were never asked, and the lookups that were counted as searched
 * when only headline feeds answered. Test material from the graded reports (Shensi Ding / Merge, Eric Glyman /
 * Ramp) and the public test subjects (Trevor Milton / Nikola, Elizabeth Holmes / Theranos).
 */
jest.mock('../../../src/server/search/retrieve', () => ({
  searchWeb: jest.fn(async () => []),
  webSearchConfigured: jest.fn(() => false),
}));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/founder/sources/searchEngines', () => {
  const actual = jest.requireActual('../../../src/server/founder/sources/searchEngines');
  return { ...actual, keylessSearch: jest.fn(async () => ({ results: [], engine: null, tried: [] })), resolveHeadline: jest.fn(async () => null) };
});

import { createSubject, addAnchor, addCompanyAlias } from '../../../src/server/founder/identity';
import { keylessSearch, resolveHeadline, searchCoverageNote, SEARCH_COUNT_KEYS, REGION } from '../../../src/server/founder/sources/searchEngines';
import {
  webSearchConnector, newsArchiveConnector, webTemplates, newsTemplates, languageHints, companyQueryRef, companyNames, NEEDS_GENERAL, RESOLVE_MAX,
} from '../../../src/server/founder/sources/web';

const spendFor = () => {
  const spent = {};
  return { spent, spend: (key, n = 1, max = Infinity) => { if ((spent[key] || 0) + n > max) return false; spent[key] = (spent[key] || 0) + n; return true; } };
};
const ctxFor = (subject, extra = {}) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => [], ...extra });
const planned = (connector, thread, subject, template) => {
  const t = connector.plan(thread, subject).find((x) => x.template === template);
  if (!t) throw new Error(`no ${template}`);
  return { kind: thread.kind, value: thread.value, template: t.template, params: t.params, prior: t.prior, depth: 0, relation: null };
};
function searchReturns(results, extra = {}) {
  keylessSearch.mockImplementation(async (query, options = {}) => {
    const kept = results.filter((r) => (typeof options.accept === 'function' ? options.accept(r) : true));
    return { results: kept, engine: kept.length ? 'ddg' : null, tried: [], general: true, headlinesOnly: false, ...extra };
  });
}
const queries = (subject, thread = { kind: 'subject', value: subject.name }) => Object.fromEntries(webTemplates(thread, subject).map((t) => [t.template, t.params.query]));

beforeEach(() => { keylessSearch.mockReset(); resolveHeadline.mockReset(); resolveHeadline.mockResolvedValue(null); });

/* ------------------------------------------------------------------ profile-interviewer-substack */

describe('an interviewer\'s newsletter is never the person\'s own', () => {
  const ding = () => createSubject({ name: 'Shensi Ding', company: 'Merge' });

  test('a post on the host\'s Substack that names the guest gives no Substack profile of the guest', async () => {
    const s = ding();
    searchReturns([{ title: 'Shensi Ding - Merge (#74) - by David Politis', snippet: 'Shensi Ding, co-founder and CEO of Merge, joins the show.', url: 'https://notanotherceo.substack.com/p/shensi-ding-merge', date: null }]);
    const { threads } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.interviews'), ctxFor(s));
    // the episode page may be read for what it says, but the newsletter is not hers
    expect(threads.some((t) => t.kind === 'url' && t.value === 'https://notanotherceo.substack.com')).toBe(false);
    expect(threads.some((t) => t.platform === 'substack')).toBe(false);
  });

  test('a Medium post by someone else is not the person\'s Medium; their own profile page is', async () => {
    const s = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    searchReturns([
      { title: 'What Arthur Mensch told us about open models', snippet: 'Arthur Mensch of Mistral AI.', url: 'https://medium.com/@techwriter/what-arthur-mensch-told-us-123', date: null },
      { title: 'Arthur Mensch - Mistral AI | LinkedIn', snippet: 'Co-founder and CEO at Mistral AI.', url: 'https://www.linkedin.com/in/amensch', date: null },
    ]);
    const { threads } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.profile'), ctxFor(s));
    expect(threads.some((t) => t.platform === 'medium')).toBe(false);
    expect(threads.find((t) => t.platform === 'linkedin')).toMatchObject({ value: 'https://linkedin.com/in/amensch' });
  });
});

/* ------------------------------------------------------------------ profile-seed-collection */

describe('the seed asks for what LinkedIn shows', () => {
  test('a company-free LinkedIn question, early-career roles, and org-chart snippets', () => {
    const s = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const q = queries(s);
    expect(q['q.linkedin-any']).toBe('"Shensi Ding" site:linkedin.com/in');
    expect(q['q.roles']).toMatch(/^"Shensi Ding" \(analyst OR associate OR "investment banking"/);
    expect(q['q.profiles']).toBe('"Shensi Ding" (site:theorg.com OR site:crunchbase.com)');
    const seed = webTemplates({ kind: 'subject', value: s.name }, s).filter((t) => t.params.seed).sort((a, b) => b.prior - a.prior).map((t) => t.template);
    // LinkedIn and the earlier-career question are among the first in the general search's allowance
    expect(seed.slice(0, 3)).toEqual(expect.arrayContaining(['q.linkedin', 'q.background']));
  });

  test('a very common name gets no company-free LinkedIn question (its profiles are mostly namesakes\')', () => {
    const s = createSubject({ name: 'John Smith', company: 'Acme Robotics' });
    expect(queries(s)['q.linkedin-any']).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ prior ventures, adverse and positive questions */

describe('the questions asked', () => {
  test('earlier ventures keep the known company in the query (Trevor Milton / Nikola)', () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const q = queries(s)['q.prior-ventures'];
    expect(q).toContain('"Trevor Milton" Nikola');
    expect(q).not.toContain(' -"');
    expect(q).toContain('"previously founded"');
  });

  test('accusations, arrests, convictions and class actions are asked, on the web and in the news', () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    expect(queries(s)['q.allegations']).toMatch(/accused OR allegations OR arrested OR convicted OR sentenced OR "pleaded guilty" OR "class action"/);
    const adverse = newsTemplates({ kind: 'subject', value: s.name }, s).find((t) => t.template === 'n.recent-adverse');
    for (const w of ['accused', 'allegations', 'arrested', 'convicted', 'sentenced']) expect(adverse.params.query).toContain(w);
    const company = newsTemplates({ kind: 'company', value: 'Nikola' }, s)[0];
    expect(company.params.query).toMatch(/sanctions OR "class action" OR "attorney general"/);
    expect(NEEDS_GENERAL.has('q.allegations')).toBe(true);
  });

  test('board seats, investments, awards and lists, and talks are asked', () => {
    const s = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const rec = newsTemplates({ kind: 'subject', value: s.name }, s).find((t) => t.template === 'n.recognition');
    expect(rec.params.query).toMatch(/"joins board"/);
    expect(rec.params.query).toMatch(/"angel investor"/);
    expect(rec.params.query).toMatch(/"30 Under 30"/);
    expect(queries(s)['q.interviews']).toMatch(/TEDx OR speaker OR fireside/);
  });

  test('funding rounds are asked with the company\'s domain once it is known', () => {
    const s = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    addAnchor(s, 'domains', 'merge.dev', 'f1');
    const q = queries(s, { kind: 'company', value: 'Merge' });
    expect(q['q.company-funding']).toBe('"Merge" "merge.dev" (raises OR "Series A" OR "Series B" OR "seed round" OR "led by" OR valuation)');
  });
});

/* ------------------------------------------------------------------ design decision 1: an ordinary-word company */

describe('a company named with an ordinary word is never searched or matched by the bare word', () => {
  test('without a legal name: every company question carries the person\'s name', () => {
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    expect(companyQueryRef(s, 'Ramp')).toBe('"Ramp" "Eric Glyman"');
    for (const t of webTemplates({ kind: 'company', value: 'Ramp' }, s)) expect(t.params.query).toMatch(/"Eric Glyman"|"ramp\.com"|"Ramp Business Corporation"/);
    for (const t of newsTemplates({ kind: 'company', value: 'Ramp' }, s)) expect(t.params.query).toContain('"Eric Glyman"');
  });

  test('with a learned legal name and domain: searched by those, never the bare word', () => {
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    expect(addCompanyAlias(s, { company: 'Ramp', alias: 'Ramp Business Corporation', origin: 'form-d-1' })).toBe(true);
    expect(addCompanyAlias(s, { company: 'Ramp', alias: 'ramp.com', origin: 'form-d-1' })).toBe(true);
    expect(companyNames(s, 'Ramp')).toMatchObject({ ordinary: true, legal: ['Ramp Business Corporation'], domains: ['ramp.com'] });
    const ref = companyQueryRef(s, 'Ramp');
    expect(ref).toBe('("Ramp Business Corporation" OR "ramp.com")');
    const legal = queries(s, { kind: 'company', value: 'Ramp' })['q.company-legal'];
    expect(legal.startsWith(ref)).toBe(true);
  });

  test('a distinctive name is searched by every known name', () => {
    const s = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    addCompanyAlias(s, { company: 'Theranos', alias: 'Theranos Holdings LLC', origin: 'f1' });
    expect(companyQueryRef(s, 'Theranos')).toBe('("Theranos" OR "Theranos Holdings LLC")');
  });

  test('a crime story about a boat ramp, or an Ethereum upgrade, is not a record about the company', async () => {
    const glyman = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    searchReturns([
      { title: 'Body found near Misty Water Boat Ramp; police investigate homicide', snippet: 'Deputies are investigating.', url: 'https://news.example.com/boat-ramp', date: null },
      { title: 'Son-in-law of The Ramp church founder charged with abuse', snippet: 'A lawsuit was filed.', url: 'https://news.example.com/ramp-church', date: null },
    ]);
    const one = await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Ramp' }, glyman, 'q.company-legal'), ctxFor(glyman));
    expect(one.findings).toEqual([]);
    const ding = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    searchReturns([{ title: 'Mainnet Merge Announcement: fraud warning for validators', snippet: 'The Merge is coming.', url: 'https://blog.example.org/merge', date: null }]);
    const two = await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'company', value: 'Merge' }, ding, 'n.company-last-3y'), ctxFor(ding));
    expect(two.findings).toEqual([]);
  });

  test('a record that gives the learned legal name is the company\'s', async () => {
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    addCompanyAlias(s, { company: 'Ramp', alias: 'Ramp Business Corporation', origin: 'form-d-1' });
    searchReturns([{ title: 'West Virginia attorney general opens investigation into Ramp Business Corporation', snippet: 'The letter questions whether the company is a bank.', url: 'https://news.example.com/wv-ag', date: null }]);
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Ramp' }, s, 'q.company-legal'), ctxFor(s));
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toBe('company');
  });
});

/* ------------------------------------------------------------------ web-news-only-counts-as-searched */

describe('a web question only headline feeds answered is not counted as searched', () => {
  test('headlines only: kept, but listed as not searched on the open web, and not learned from', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const { spent, spend } = spendFor();
    searchReturns([{ title: 'Trevor Milton accused of misleading investors', snippet: '', url: 'https://news.google.com/rss/articles/x', host: 'reuters.com', date: '2020-09-20' }], { general: false, headlinesOnly: true });
    const out = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.employment'), ctxFor(s, { spend }));
    expect(out.findings).toHaveLength(1);
    expect(out.noLearn).toBe(true);
    expect(out.partial[0]).toMatch(/news headlines or the encyclopedia only/);
    expect(out.notes.join(' ')).toMatch(/news headlines or the encyclopedia only/);
    expect(spent[SEARCH_COUNT_KEYS.headlines]).toBe(1);
    expect(spent[SEARCH_COUNT_KEYS.general]).toBeUndefined();
  });

  test('the seed and the adverse questions wait for a general web search twice in a check, then settle', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const { spend } = spendFor();
    searchReturns([]);
    const task = planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.lawsuit');
    const asked = [];
    keylessSearch.mockImplementation(async (q, o) => { asked.push(o.needGeneral); return { results: [], engine: null, tried: [], general: true, headlinesOnly: false }; });
    for (let i = 0; i < 3; i += 1) await webSearchConnector.run(task, ctxFor(s, { spend }));
    expect(asked).toEqual([true, true, false]);
    // a question that is not part of the seed or the adverse set never waits
    asked.length = 0;
    await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.resume'), ctxFor(s, { spend }));
    expect(asked).toEqual([false]);
  });

  test('the coverage line counts per check and never uses the words the UI avoids', () => {
    const note = searchCoverageNote({ general: 10, headlines: 6, none: 2 });
    expect(note).toBe('6 of 18 open-web questions were answered from news headlines or the encyclopedia only, because no general web search was available to take them; 2 could not be asked at all. Those questions count as not searched on the open web.');
    expect(note).not.toMatch(/\b(API|key|token|free|paid|tier|quota)\b/i);
    expect(searchCoverageNote({ general: 5 })).toBe('');
  });
});

/* ------------------------------------------------------------------ web-gnews-articles-never-read */

describe('press articles the news feed found are handed to the page reader', () => {
  test('a Google News headline naming the person on a press site: its own address is found and read', async () => {
    const s = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    resolveHeadline.mockResolvedValue('https://techcrunch.com/2022/10/24/merge-raises-55m-series-b-for-its-unified-api/');
    searchReturns([{ title: 'Merge, led by Shensi Ding, raises $55M Series B - TechCrunch', snippet: '', url: 'https://news.google.com/rss/articles/CBMi123', host: 'techcrunch.com', publisher: 'TechCrunch', date: '2022-10-24' }]);
    const { spend } = spendFor();
    const out = await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'subject', value: s.name }, s, 'n.3-8y'), ctxFor(s, { spend }));
    expect(resolveHeadline).toHaveBeenCalledWith('Merge, led by Shensi Ding, raises $55M Series B - TechCrunch', 'techcrunch.com', expect.any(Object));
    expect(out.threads.find((t) => t.kind === 'url' && /techcrunch\.com\/2022/.test(t.value))).toMatchObject({ why: 'article naming them', trusted: true });
  });

  test('at most a few per check', async () => {
    const s = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    resolveHeadline.mockResolvedValue(null);
    const items = Array.from({ length: 6 }, (_, i) => ({ title: `Shensi Ding of Merge on unified APIs, part ${i}`, snippet: '', url: `https://news.google.com/rss/articles/${i}`, host: 'forbes.com', date: '2023-01-01' }));
    searchReturns(items);
    const { spend } = spendFor();
    await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'subject', value: s.name }, s, 'n.recent'), ctxFor(s, { spend }));
    await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'subject', value: s.name }, s, 'n.1-3y'), ctxFor(s, { spend }));
    expect(resolveHeadline.mock.calls.length).toBe(RESOLVE_MAX);
  });
});

/* ------------------------------------------------------------------ critic-search-languages */

describe('adverse questions and news editions in the local language', () => {
  test('from the company domain, a place the user gave, or a register\'s country', () => {
    const br = createSubject({ name: 'Joao Silva', company: 'exemplo.com.br' });
    expect(languageHints(br)).toEqual(['pt']);
    const jp = createSubject({ name: 'Taro Yamada', company: 'Example' });
    jp.country = 'Japan';
    expect(languageHints(jp)).toEqual(['ja']);
    const il = createSubject({ name: 'Dana Levi', company: 'Example' });
    addAnchor(il, 'domains', 'example.co.il', 'f1');
    expect(languageHints(il)).toEqual(['he']);
    // a US state register's two letters are a state, not a country
    const us = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    us.jurisdiction = 'us_de';
    expect(languageHints(us)).toEqual([]);
  });

  test('a few extra lookups: one web question and one news edition per language, at most two languages', () => {
    const s = createSubject({ name: 'Lucas Souza', company: 'Exemplo Ltda' });
    s.countries = ['Brazil', 'Italy', 'Japan'];
    expect(languageHints(s)).toEqual(['pt', 'it']);
    const web = webTemplates({ kind: 'subject', value: s.name }, s).filter((t) => /^q\.adverse-/.test(t.template));
    const news = newsTemplates({ kind: 'subject', value: s.name }, s).filter((t) => /^n\.adverse-/.test(t.template));
    expect(web.map((t) => t.template)).toEqual(['q.adverse-pt', 'q.adverse-it']);
    expect(news.map((t) => [t.template, t.params.lang])).toEqual([['n.adverse-pt', 'pt'], ['n.adverse-it', 'it']]);
    expect(web[0].params.query).toMatch(/^"Lucas Souza" \(processo OR fraude/);
    for (const lang of ['pt', 'it', 'nl', 'sv', 'pl', 'ja', 'ko', 'zh', 'he', 'hi', 'id', 'tr']) expect(REGION[lang].gnews).toMatch(/^hl=/);
  });

  test('the news connector asks the local edition', async () => {
    const s = createSubject({ name: 'Lucas Souza', company: 'exemplo.com.br' });
    searchReturns([]);
    await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'subject', value: s.name }, s, 'n.adverse-pt'), ctxFor(s));
    expect(keylessSearch.mock.calls[0][1]).toMatchObject({ news: true, lang: 'pt' });
  });
});
