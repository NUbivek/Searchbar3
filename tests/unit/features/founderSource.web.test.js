/**
 * @jest-environment node
 *
 * The open-web and news sources of the deep background check: the query
 * patterns (stable ids, joint-only queries for other people), how search
 * results become graded findings and threads, and the failure path.
 */
jest.mock('../../../src/server/search/retrieve', () => ({
  searchWeb: jest.fn(async () => []),
  webSearchConfigured: jest.fn(() => false),
}));
// the search engines share their rests through the database: none here
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/founder/sources/searchEngines', () => {
  const actual = jest.requireActual('../../../src/server/founder/sources/searchEngines');
  return { ...actual, keylessSearch: jest.fn(actual.keylessSearch), engineHealth: jest.fn(actual.engineHealth) };
});

import { setTransport } from '../../../src/server/founder/http';
import { createSubject, addAnchor } from '../../../src/server/founder/identity';
import { CATEGORIES } from '../../../src/server/founder/finding';
import { keylessSearch, engineHealth, __resetEnginesForTests } from '../../../src/server/founder/sources/searchEngines';
import {
  webSearchConnector, newsArchiveConnector, webTemplates, newsTemplates, categoryFor, languageHints, shortCompany,
  windowDates, NEWS_WINDOWS, METERED_PRIOR, SEED_TEMPLATES, SEED_RESERVE,
} from '../../../src/server/founder/sources/web';

const actualEngines = jest.requireActual('../../../src/server/founder/sources/searchEngines');

/* ------------------------------------------------------------------ fixtures (trimmed real responses) */

const DDG_HTML = `<!DOCTYPE html><html><head><title>&quot;Elizabeth Holmes&quot; lawsuit at DuckDuckGo</title></head><body><div class="serp__results"><div id="links" class="results">
<div class="result results_links results_links_deep web-result ">
 <div class="links_main links_deep result__body"> <!-- This is the visible part -->
 <h2 class="result__title">
 <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Fenforcement%2Dlitigation%2Flitigation%2Dreleases%2Flr%2D24069&amp;rut=a8c9744522efdc9c526370668b5071de2633bf92f094db422f2d8e93fbb48432">Elizabeth Holmes, et al. and Ramesh &quot;Sunny&quot; Balwani - SEC.gov</a>
 </h2>
 <div class="result__extras">
 <div class="result__extras__url">
 <span class="result__icon">
 <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Fenforcement%2Dlitigation%2Flitigation%2Dreleases%2Flr%2D24069&amp;rut=a8c9744522efdc9c526370668b5071de2633bf92f094db422f2d8e93fbb48432">
 
 </a>
 </span>
 <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Fenforcement%2Dlitigation%2Flitigation%2Dreleases%2Flr%2D24069&amp;rut=a8c9744522efdc9c526370668b5071de2633bf92f094db422f2d8e93fbb48432">
 www.sec.gov/enforcement-litigation/litigation-releases/lr-24069
 </a>
 </div>
 </div>
 <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Fenforcement%2Dlitigation%2Flitigation%2Dreleases%2Flr%2D24069&amp;rut=a8c9744522efdc9c526370668b5071de2633bf92f094db422f2d8e93fbb48432">On March 14, 2018, the Securities and Exchange Commission charged Silicon Valley-based private company Theranos Inc., its founder and CEO <b>Elizabeth Holmes</b>, and its former President Ramesh &quot;Sunny&quot; Balwani with raising more than $700 million from investors through an elaborate, years-long fraud in which they exaggerated or made false statements about the company&#x27;s technology, business, and ...</a>
 <div class="clear"></div>
 </div>
 </div>
 <div class="result results_links results_links_deep web-result ">
 <div class="links_main links_deep result__body"> <!-- This is the visible part -->
 <h2 class="result__title">
 <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Ffiles%2Flitigation%2Fcomplaints%2F2018%2Fcomp%2Dpr2018%2D41%2Dtheranos%2Dholmes.pdf&amp;rut=b55c6a9bab02302b91fb748cdfd10aa61a0c43e3ec71624db23badab5b4fe06f"><span class="result__type">PDF</span> Elizabeth Holmes and Theranos, Inc. - SEC.gov</a>
 </h2>
 <div class="result__extras">
 <div class="result__extras__url">
 <span class="result__icon">
 <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Ffiles%2Flitigation%2Fcomplaints%2F2018%2Fcomp%2Dpr2018%2D41%2Dtheranos%2Dholmes.pdf&amp;rut=b55c6a9bab02302b91fb748cdfd10aa61a0c43e3ec71624db23badab5b4fe06f">
 
 </a>
 </span>
 <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Ffiles%2Flitigation%2Fcomplaints%2F2018%2Fcomp%2Dpr2018%2D41%2Dtheranos%2Dholmes.pdf&amp;rut=b55c6a9bab02302b91fb748cdfd10aa61a0c43e3ec71624db23badab5b4fe06f">
 www.sec.gov/files/litigation/complaints/2018/comp-pr2018-41-theranos-holmes.pdf
 </a>
 </div>
 </div>
 <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Ffiles%2Flitigation%2Fcomplaints%2F2018%2Fcomp%2Dpr2018%2D41%2Dtheranos%2Dholmes.pdf&amp;rut=b55c6a9bab02302b91fb748cdfd10aa61a0c43e3ec71624db23badab5b4fe06f">In 2017, Theranos and Holmes settled a <b>lawsuit</b> with an investor that alleged it was defrauded by Theranos. Theranos also settled a <b>lawsuit</b> with Pharmacy A, which brought an action for breach of contract against the company.</a>
 <div class="clear"></div>
 </div>
 </div>
 </div></div></body></html>`;

const GNEWS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><generator>NFE/5.0</generator><title>""Elizabeth Holmes" lawsuit" - Google News</title><link>https://news.google.com/search?q=%22Elizabeth+Holmes%22+lawsuit&amp;hl=en-US&amp;gl=US&amp;ceid=US:en</link><language>en-US</language><webMaster>news-webmaster@google.com</webMaster><lastBuildDate>Sat, 14 Nov 2026 21:30:39 GMT</lastBuildDate><description>Google News</description>
<item><title>Elizabeth Holmes advocate threatens suing A24 over documentary portrayal - NBC News</title><link>https://news.google.com/rss/articles/CBMivwFBVV95cUxQcFA0S1pwU001VlByRU5hM2FDX3BFTUxIMjFaTDd4TXZjaDlORFl4Mk5jYU5aTXJ5RnU0WEhMZ3RMQVgzY1VmNTRUamgySVhBeE42QTRjNDdmS25hWkVBNG1hTkJFTnlrRmZDV2pUWVpuOXNsVk9zZ2VwemJRRUpPQk4zUktieVEtRFlmcUNDcFZ2SGNyTnJRbHpBY29tTXI5ZTZQSld5akVwZ3pUcENrVmdIUXJoUnVkOWZoNmk1cw?oc=5</link><pubDate>Tue, 27 Oct 2026 07:00:00 GMT</pubDate><source url="https://www.nbcnews.com">NBC News</source></item>
<item><title>Elizabeth Holmes owes over $25 million to Theranos, lawsuit says - CNBC</title><link>https://news.google.com/rss/articles/CBMioAFBVV95cUxOejM3a3k1YjNIZDBKdGhSMF9PSXo1djZCLURiUkppRjBUMEdhaWRKSVZnMFYxQWJRRnc4OFVxSDJBS09zc3VjTG82Zlk2SWIzdzFuN2xpb3ZfUVJzZW5mSjVwVzhWNEljd1NueTNRSnhmbzVUTnJlSFY0dDFoa1lqTnVFSHZyQVRIYmdBZFE2eGQ2UXJ0SzRpTUNhN3Nuc1VT0gGmAUFVX3lxTFBUTnNHa2hBZkVJclc5cUZMSkQ2S1JBaV91c3hXUjJsbk5UVnVfS3pBRGJZbWRDQm5LUVVPYVI5cW5lUUV2c2dCVzByT2c3ZTZrSUxtbzl1eUZPRkF3V05MQUZHT2VERlY2YUpmSjZhV1Blbnp1bDdnXzk3aWFWYW1MSldzX3gyVUd2eFdSYXRMVUtsZEc3QncwZ3dFZ3FjcDlpWlg3Y3c?oc=5</link><pubDate>Fri, 17 Mar 2023 07:00:00 GMT</pubDate><source url="https://www.cnbc.com">CNBC</source></item>
<item><title>Elizabeth Holmes Phones In Her Defense After Civil Lawyers Quit - Bloomberg Law News</title><link>https://news.google.com/rss/articles/CBMiqAFBVV95cUxPTXR1ZFBldGJsRnVVSlI4YVJLUkdIdmNPVUNKZmtDdzZkTThhVm42STQ3TnpWUkc3SkgxdjlkMmdfVEppVkJTVWlyaTFMN3Z2X21KTUltd1BfeHhGenFrVnIxQzQ0UkJocWFNZkxEaEQwT1dibGNrRzFZenR2Y2J3UUktaUw1YTJ2SXdFcW5QY3U3QjlaU2ptLW5QSEdwbnFaZVNtcnpvZ3g?oc=5</link><pubDate>Fri, 24 Jan 2020 08:00:00 GMT</pubDate><source url="https://news.bloomberglaw.com">Bloomberg Law News</source></item>
</channel></rss>`;

/* ------------------------------------------------------------------ helpers */

const holmes = () => createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
const roe = () => createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const task = (kind, value, template, params, extra = {}) => ({ kind, value, template, params, depth: 0, relation: null, ...extra });
const planned = (connector, thread, subject, template) => {
  const t = connector.plan(thread, subject).find((x) => x.template === template);
  return task(thread.kind, thread.value, t.template, t.params, { prior: t.prior });
};

/** Make the search return these results (after the caller's own accept filter, as the real one does). */
function searchReturns(results, { engine = 'ddg', tried = null } = {}) {
  keylessSearch.mockImplementation(async (query, options = {}) => {
    const kept = results.filter((r) => (typeof options.accept === 'function' ? options.accept(r) : true));
    return { results: kept, engine: kept.length ? engine : null, tried: tried || [{ id: engine, outcome: kept.length ? 'results' : 'nothing', count: kept.length }] };
  });
}

beforeEach(() => {
  __resetEnginesForTests();
  keylessSearch.mockReset();
  keylessSearch.mockImplementation(actualEngines.keylessSearch);
  engineHealth.mockReset();
  engineHealth.mockImplementation(actualEngines.engineHealth);
});
afterEach(() => setTransport());

/* ------------------------------------------------------------------ query patterns */

describe('web-search: query patterns', () => {
  test('the connector says what it is', () => {
    expect(webSearchConnector.id).toBe('web-search');
    expect(webSearchConnector.label).toBe('Open-web search');
    expect(webSearchConnector.kinds).toEqual(['subject', 'company', 'associate', 'relative', 'school', 'handle']);
    expect(typeof webSearchConnector.run).toBe('function');
  });

  test('the person: one pattern per question, with stable ids and priors between 0.3 and 0.8', () => {
    const subject = holmes();
    const templates = webSearchConnector.plan({ kind: 'subject', value: subject.name }, subject);
    expect(templates.map((t) => t.template)).toEqual([
      'q.profile', 'q.linkedin', 'q.lawsuit', 'q.fraud', 'q.prior-ventures', 'q.later-ventures', 'q.employment', 'q.regulatory', 'q.education', 'q.background',
      'q.insolvency', 'q.resume', 'q.interviews', 'q.family', 'q.forums', 'q.family-business', 'q.related-party',
    ]);
    expect(new Set(templates.map((t) => t.template)).size).toBe(templates.length);
    for (const t of templates) {
      expect(t.prior).toBeGreaterThanOrEqual(0.3);
      expect(t.prior).toBeLessThanOrEqual(0.8);
      expect(typeof t.why).toBe('string');
      expect(t.why.length).toBeGreaterThan(8);
      expect(t.why).not.toMatch(/\b(API|endpoint|free|paid|key|token)\b/i);
      if (t.template !== 'q.family-business') expect(t.params.query).toContain('"Elizabeth Holmes"');
    }
    // the same call again gives the same ids (learning is keyed on them)
    expect(webTemplates({ kind: 'subject', value: subject.name }, subject).map((t) => t.template)).toEqual(templates.map((t) => t.template));
  });

  test('the person: what each query says', () => {
    const subject = holmes();
    const q = Object.fromEntries(webTemplates({ kind: 'subject', value: subject.name }, subject).map((t) => [t.template, t.params.query]));
    expect(q['q.profile']).toBe('"Elizabeth Holmes" Theranos');
    expect(q['q.linkedin']).toBe('"Elizabeth Holmes" Theranos site:linkedin.com/in');
    expect(q['q.resume']).toBe('"Elizabeth Holmes" (resume OR CV OR "curriculum vitae")');
    expect(q['q.prior-ventures']).toBe('"Elizabeth Holmes" (founder OR "co-founder" OR CEO) -"Theranos"');
    expect(q['q.education']).toBe('"Elizabeth Holmes" Theranos (graduated OR alumni OR degree OR university OR studied)');
    expect(q['q.background']).toBe('"Elizabeth Holmes" Theranos (previously OR formerly OR "prior to" OR "before founding" OR "worked at")');
    expect(q['q.lawsuit']).toBe('"Elizabeth Holmes" (lawsuit OR sued OR court OR complaint)');
    expect(q['q.fraud']).toBe('"Elizabeth Holmes" (fraud OR scam OR investigation OR indicted OR charged)');
    expect(q['q.employment']).toBe('"Elizabeth Holmes" (fired OR ousted OR resigned OR harassment OR misconduct)');
    expect(q['q.insolvency']).toBe('"Elizabeth Holmes" (bankruptcy OR insolvency OR liquidation OR "shut down")');
    expect(q['q.regulatory']).toBe('"Elizabeth Holmes" (SEC OR FTC OR regulator OR fine OR settlement)');
    expect(q['q.interviews']).toBe('"Elizabeth Holmes" (interview OR podcast OR keynote)');
    expect(q['q.family']).toBe('"Elizabeth Holmes" ("son of" OR "daughter of" OR father OR mother OR brother OR sister OR married)');
    expect(q['q.family-business']).toBe('"Holmes family" (business OR heir OR dynasty) (Elizabeth OR Theranos)');
    expect(q['q.related-party']).toBe('"Elizabeth Holmes" ("family office" OR "related party" OR trust OR nominee)');
    expect(q['q.forums']).toBe('"Elizabeth Holmes" (site:reddit.com OR site:news.ycombinator.com)');
  });

  test('company names are shortened to what the press uses, and quoted when they have a space; no company still works', () => {
    expect(shortCompany('Theranos, Inc.')).toBe('Theranos');
    expect(shortCompany('Mistral AI SAS')).toBe('Mistral AI');
    expect(shortCompany('Acme Holdings Ltd.')).toBe('Acme');
    const mensch = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI SAS' });
    const q = Object.fromEntries(webTemplates({ kind: 'subject', value: mensch.name }, mensch).map((t) => [t.template, t.params.query]));
    expect(q['q.profile']).toBe('"Arthur Mensch" "Mistral AI"');
    expect(q['q.family-business']).toBe('"Mensch family" (business OR heir OR dynasty) (Arthur OR "Mistral AI")');

    const alone = createSubject({ name: 'Jane Roe' });
    const qa = Object.fromEntries(webTemplates({ kind: 'subject', value: alone.name }, alone).map((t) => [t.template, t.params.query]));
    expect(qa['q.profile']).toBe('"Jane Roe"');
    expect(qa['q.linkedin']).toBe('"Jane Roe" site:linkedin.com/in');
    expect(qa['q.prior-ventures']).toBe('"Jane Roe" (founder OR "co-founder" OR CEO)');
    expect(qa['q.family-business']).toBe('"Roe family" (business OR heir OR dynasty) Jane');
  });

  test('a non-English pass is added only when the name or company points to a country', () => {
    expect(languageHints(holmes())).toEqual([]);
    const fr = createSubject({ name: 'François Dupont', company: 'Exemple SAS' });
    expect(languageHints(fr)).toEqual(['fr']);
    const frPass = webTemplates({ kind: 'subject', value: fr.name }, fr).find((t) => t.template === 'q.adverse-fr');
    expect(frPass.params).toMatchObject({ lang: 'fr' });
    expect(frPass.params.query).toMatch(/^"François Dupont" \(procès OR fraude OR escroquerie/);
    expect(frPass.why).toMatch(/French/);

    const de = createSubject({ name: 'Jürgen Müller', company: 'Beispiel GmbH' });
    const dePass = webTemplates({ kind: 'subject', value: de.name }, de).find((t) => t.template === 'q.adverse-de');
    expect(dePass.params.query).toMatch(/^"Jürgen Müller" \(Klage OR Betrug/);

    const es = createSubject({ name: 'Alejandro Ruiz', company: 'ejemplo.es' });
    expect(webTemplates({ kind: 'subject', value: es.name }, es).map((t) => t.template)).toContain('q.adverse-es');
    // what the check learns later counts too (a school found in round one)
    const mensch = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    expect(languageHints(mensch)).toEqual([]);
    addAnchor(mensch, 'schools', 'École Polytechnique', 'found');
    expect(languageHints(mensch)).toEqual(['fr']);
  });

  test('a company: legal trouble, leadership, distress (no separate data-breach lookup: the breach registers cover it)', () => {
    const subject = holmes();
    const templates = webTemplates({ kind: 'company', value: 'Theranos, Inc.' }, subject);
    expect(templates.map((t) => t.template)).toEqual(['q.company-legal', 'q.company-leadership', 'q.company-distress', 'q.company-funding', 'q.company-backers', 'q.company-investors']);
    expect(templates.map((t) => t.params.query)).toEqual([
      '"Theranos" (lawsuit OR fraud OR investigation)',
      '"Theranos" (founder OR CEO)',
      '"Theranos" (shutdown OR layoffs OR bankruptcy)',
      '"Theranos" "Elizabeth Holmes" (funding OR raises OR investors OR led)',
      '"Theranos" (adviser OR advisor OR shareholder OR board)',
      '"Theranos" ("led by" OR "lead investor" OR "Series A" OR "Series B" OR "Series C")',
    ]);
  });

  test('an associate or a relative is only ever searched together with the subject', () => {
    const subject = holmes();
    for (const kind of ['associate', 'relative']) {
      const templates = webTemplates({ kind, value: 'Ramesh Balwani' }, subject);
      // one joint lookup per person, with the trouble words optional (the other name closes the OR group)
      expect(templates.map((t) => t.template)).toEqual([`q.${kind}-joint`]);
      for (const t of templates) {
        expect(t.params.query.startsWith('"Elizabeth Holmes" "Ramesh Balwani"')).toBe(true);
        expect(t.prior).toBeGreaterThanOrEqual(0.3);
      }
      expect(templates[0].params.query).toBe('"Elizabeth Holmes" "Ramesh Balwani" (lawsuit OR fraud OR investigation OR settlement OR dispute OR "Ramesh Balwani")');
    }
    // the subject listed as their own associate: nothing to search
    expect(webTemplates({ kind: 'associate', value: 'Elizabeth Holmes' }, subject)).toEqual([]);
  });

  test('a school and a handle are searched with the name; other thread kinds are not ours', () => {
    const subject = holmes();
    expect(webTemplates({ kind: 'school', value: 'Stanford University' }, subject)).toEqual([expect.objectContaining({ template: 'q.school', params: expect.objectContaining({ query: '"Elizabeth Holmes" "Stanford University"' }) })]);
    expect(webTemplates({ kind: 'handle', value: '@eholmes2003' }, subject)).toEqual([expect.objectContaining({ template: 'q.handle', params: { query: '"eholmes2003" "Elizabeth Holmes"' } })]);
    expect(webTemplates({ kind: 'domain', value: 'theranos.com' }, subject)).toEqual([]);
    expect(webTemplates({ kind: 'url', value: 'https://theranos.com/team' }, subject)).toEqual([]);
    expect(webTemplates({ kind: 'company', value: '' }, subject)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ run(): the search that is made */

describe('web-search: the search a lookup makes', () => {
  test('one search per lookup, with the pattern\'s query and options', async () => {
    const subject = holmes();
    searchReturns([]);
    const ctx = ctxFor(subject);
    const out = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.profile'), ctx);
    expect(out).toEqual({ findings: [], threads: [], notes: [] });
    expect(keylessSearch).toHaveBeenCalledTimes(1);
    const [query, options] = keylessSearch.mock.calls[0];
    expect(query).toBe('"Elizabeth Holmes" Theranos');
    expect(options).toMatchObject({ news: false, num: 10, deadline: ctx.deadline, allowMetered: true, prefer: 'reference' });
    expect(typeof options.accept).toBe('function');
  });

  test('the metered services are allowed for the seed and for patterns with a prior of 0.7 or more', async () => {
    const subject = holmes();
    searchReturns([]);
    const allowed = {};
    for (const t of webSearchConnector.plan({ kind: 'subject', value: subject.name }, subject)) {
      keylessSearch.mockClear();
      await webSearchConnector.run(task('subject', subject.name, t.template, t.params, { prior: t.prior }), ctxFor(subject));
      allowed[t.template] = keylessSearch.mock.calls[0][1].allowMetered;
      expect(allowed[t.template]).toBe(t.prior >= METERED_PRIOR || SEED_TEMPLATES.includes(t.template));
    }
    expect(METERED_PRIOR).toBe(0.7);
    expect(Object.keys(allowed).filter((k) => allowed[k])).toEqual(['q.profile', 'q.linkedin', 'q.lawsuit', 'q.fraud', 'q.prior-ventures', 'q.education', 'q.background', 'q.interviews']);

    // a company, an associate, and a free-form search proposed by the second reader: never metered
    for (const t of [
      planned(webSearchConnector, { kind: 'company', value: 'Theranos' }, subject, 'q.company-legal'),
      planned(webSearchConnector, { kind: 'associate', value: 'Ramesh Balwani' }, subject, 'q.associate-joint'),
      task('subject', subject.name, 'q.gap', { query: '"Elizabeth Holmes" Stanford dropout' }, { prior: 0.5 }),
    ]) {
      keylessSearch.mockClear();
      await webSearchConnector.run(t, ctxFor(subject));
      expect(keylessSearch.mock.calls[0][1].allowMetered).toBe(false);
    }
    expect(keylessSearch.mock.calls[0][0]).toBe('"Elizabeth Holmes" Stanford dropout');
  });

  test('language and family options reach the search', async () => {
    const fr = createSubject({ name: 'François Dupont', company: 'Exemple SAS' });
    searchReturns([]);
    await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: fr.name }, fr, 'q.adverse-fr'), ctxFor(fr));
    expect(keylessSearch.mock.calls[0][1]).toMatchObject({ lang: 'fr', allowMetered: false });
  });

  test('a lookup about another person that arrives without the subject\'s name is turned into a joint query', async () => {
    const subject = holmes();
    searchReturns([]);
    await webSearchConnector.run(task('associate', 'Ramesh Balwani', 'q.gap', { query: '"Ramesh Balwani" fraud' }), ctxFor(subject));
    expect(keylessSearch.mock.calls[0][0]).toBe('"Elizabeth Holmes" "Ramesh Balwani"');
    await webSearchConnector.run(task('relative', 'Christian Holmes', null, null), ctxFor(subject));
    expect(keylessSearch.mock.calls[1][0]).toBe('"Elizabeth Holmes" "Christian Holmes" (lawsuit OR fraud OR investigation OR settlement OR dispute OR "Christian Holmes")');
  });
});

/* ------------------------------------------------------------------ run(): results -> findings */

const RESULTS = [
  { title: 'Elizabeth Holmes - Founder & CEO - Theranos | LinkedIn', snippet: 'Elizabeth Holmes. Founder & CEO at Theranos. Palo Alto, California.', url: 'https://www.linkedin.com/in/elizabeth-holmes', date: null },
  { title: 'United States v. Holmes, 5:18-cr-00258 – CourtListener.com', snippet: 'Elizabeth Holmes and Ramesh Balwani were indicted on wire fraud charges over statements about Theranos blood tests.', url: 'https://www.courtlistener.com/docket/7185174/united-states-v-holmes/', date: null },
  { title: 'Elizabeth Holmes, et al. and Ramesh "Sunny" Balwani - SEC.gov', snippet: 'On March 14, 2018, the Securities and Exchange Commission charged Silicon Valley-based private company Theranos Inc., its founder and CEO Elizabeth Holmes, and its former President Ramesh "Sunny" Balwani with raising more than $700 million from investors through an elaborate, years-long fraud.', url: 'https://www.sec.gov/enforcement-litigation/litigation-releases/lr-24069', date: null },
  { title: 'Elizabeth Holmes loses appeal', snippet: 'The former chief executive was sentenced to more than 11 years in prison.', url: 'https://www.reuters.com/legal/holmes-appeal-2025-02-24/', date: '2025-02-24' },
  { title: 'Holmes County sheriff sued over jail conditions', snippet: 'Elizabeth Warren asked for a federal review of the county.', url: 'https://www.example-news.com/holmes-county', date: '2024-05-01' },
  { title: 'Elizabeth Holmes, Age 42, Palo Alto CA - phone and address', snippet: 'Find Elizabeth Holmes of Theranos: current address and relatives.', url: 'https://www.spokeo.com/Elizabeth-Holmes', date: null },
];

describe('web-search: results become graded findings', () => {
  test('category by site and content, severity from the words, verbatim quote, date when the engine gives one', async () => {
    const subject = holmes();
    searchReturns(RESULTS);
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.lawsuit'), ctxFor(subject));
    expect(findings.map((f) => [f.category, f.match, f.severity])).toEqual([
      ['identity', 'confirmed', 'info'],
      ['litigation', 'confirmed', 'high'],
      ['regulatory', 'confirmed', 'medium'],
      ['press', 'possible', 'high'],
    ]);
    const [linkedin, court, sec, press] = findings;
    expect(linkedin).toMatchObject({ source: 'web-search', sourceLabel: 'Open-web search', title: RESULTS[0].title, quote: RESULTS[0].snippet, url: RESULTS[0].url, date: null });
    expect(linkedin.matchReasons).toEqual(['names Theranos']);
    expect(court.url).toBe('https://www.courtlistener.com/docket/7185174/united-states-v-holmes/');
    expect(sec.quote).toBe(RESULTS[2].snippet);
    expect(press).toMatchObject({ date: '2025-02-24', matchReasons: ['matched by name only'] });
    for (const f of findings) expect(CATEGORIES[f.category]).toBeTruthy();
  });

  test('a result that does not name the subject is dropped, and so is a people-search site', async () => {
    const subject = holmes();
    // even if a search handed these back unfiltered
    keylessSearch.mockImplementation(async () => ({ results: RESULTS, engine: 'ddg', tried: [] }));
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.lawsuit'), ctxFor(subject));
    expect(findings).toHaveLength(4);
    expect(findings.some((f) => /Holmes County/.test(f.title))).toBe(false);
    expect(findings.some((f) => /spokeo/.test(f.url))).toBe(false);
  });

  test('the accept filter given to the search keeps what names the person and rejects the rest', async () => {
    const subject = holmes();
    searchReturns(RESULTS);
    await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.lawsuit'), ctxFor(subject));
    const { accept } = keylessSearch.mock.calls[0][1];
    expect(RESULTS.map((r) => accept(r))).toEqual([true, true, true, true, false, true]);
    expect(accept({ title: 'Theranos to dissolve after fraud charges', snippet: '' })).toBe(false); // a person lookup: company-only is not enough
  });

  test('without a company, a name-only match stays "possible"; a known school makes it "likely"', async () => {
    const subject = createSubject({ name: 'Jane Roe' });
    addAnchor(subject, 'schools', 'Stanford University', 'found');
    searchReturns([
      { title: 'Jane Roe named to board', snippet: 'Jane Roe joins the board of a logistics firm.', url: 'https://www.example.com/a', date: null },
      { title: 'Alumni spotlight: Jane Roe', snippet: 'Jane Roe graduated from Stanford University in 2011.', url: 'https://alumni.stanford.edu/spotlight/jane-roe', date: null },
    ]);
    const { findings, threads } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.education'), ctxFor(subject));
    expect(findings.map((f) => [f.match, f.category])).toEqual([['possible', 'press'], ['likely', 'education']]);
    // threads from the name-only record are recorded but not trusted
    for (const t of threads.filter((x) => x.kind !== 'url')) expect(typeof t.trusted).toBe('boolean');
  });

  test('threads: profile, resume, personal-site and team pages are handed on, trusted only from a record tied to the person', async () => {
    const subject = roe();
    searchReturns([
      { title: 'Jane Roe - CEO - Acme Robotics | LinkedIn', snippet: 'Jane Roe, CEO at Acme Robotics. Previously at Initech.', url: 'https://www.linkedin.com/in/jroe-ceo', date: null },
      { title: 'Jane Roe - Founder @ Acme Robotics - Crunchbase Person Profile', snippet: 'Jane Roe is the founder of Acme Robotics.', url: 'https://www.crunchbase.com/person/jane-roe', date: null },
      { title: 'Jane Roe | Wellfound', snippet: 'Jane Roe, founder at Acme Robotics.', url: 'https://wellfound.com/p/jane-roe', date: null },
      { title: 'Jane Roe on about.me', snippet: 'I am Jane Roe, founder of Acme Robotics.', url: 'https://about.me/janeroe', date: null },
      { title: 'Jane Roe - Resume | Indeed', snippet: 'Jane Roe. Chief Executive, Acme Robotics.', url: 'https://www.indeed.com/r/Jane-Roe/0a1b2c3d4e', date: null },
      { title: 'About - Jane Roe', snippet: 'Jane Roe is the founder of Acme Robotics.', url: 'https://www.janeroe.com/about', date: null },
      { title: 'Our team - Acme Robotics', snippet: 'Jane Roe, Chief Executive Officer.', url: 'https://www.acmerobotics.com/team/jane-roe/', date: null },
      { title: 'Jane Roe curriculum vitae', snippet: 'Jane Roe. Education and employment history.', url: 'https://people.example.edu/~jroe/Jane_Roe_CV.pdf', date: null },
    ]);
    const { findings, threads } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.profile'), ctxFor(subject));
    expect(findings).toHaveLength(8);
    const urls = Object.fromEntries(threads.filter((t) => t.kind === 'url').map((t) => [t.value, t]));
    expect(urls['https://linkedin.com/in/jroe-ceo']).toMatchObject({ why: 'linkedin profile', trusted: true, platform: 'linkedin' });
    expect(urls['https://crunchbase.com/person/jane-roe']).toMatchObject({ trusted: true, platform: 'crunchbase' });
    expect(urls['https://wellfound.com/p/jane-roe']).toMatchObject({ trusted: true, platform: 'wellfound' });
    expect(urls['https://about.me/janeroe']).toMatchObject({ trusted: true, platform: 'about.me' });
    expect(urls['https://www.indeed.com/r/Jane-Roe/0a1b2c3d4e']).toMatchObject({ why: 'Indeed resume', trusted: true });
    expect(urls['https://www.janeroe.com/about']).toMatchObject({ why: 'personal site', trusted: true });
    expect(urls['https://www.acmerobotics.com/team/jane-roe']).toMatchObject({ why: 'team or bio page', trusted: true });
    // the CV names her but no company: recorded, not followed
    expect(urls['https://people.example.edu/~jroe/Jane_Roe_CV.pdf']).toMatchObject({ why: 'resume or CV', trusted: false });
    expect(threads.find((t) => t.kind === 'domain')).toMatchObject({ value: 'janeroe.com', trusted: true });
    // no thread twice
    const keys = threads.map((t) => `${t.kind}|${t.value.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a news article on a path like /people/ is not mistaken for a bio page', async () => {
    const subject = roe();
    searchReturns([{ title: 'Jane Roe, CEO of Acme Robotics, on robots', snippet: '', url: 'https://news.google.com/rss/articles/CBMiabc?oc=5', host: 'people.com', publisher: 'People', date: '2026-01-05' }]);
    const { findings, threads } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.interviews'), ctxFor(subject));
    expect(findings[0]).toMatchObject({ category: 'press', match: 'confirmed', date: '2026-01-05', data: { publisher: 'People' } });
    expect(threads.filter((t) => t.kind === 'url')).toEqual([]);
  });

  test('family patterns: a relative becomes a thread only with a public role in the same sentence', async () => {
    const subject = roe();
    searchReturns([
      { title: 'Jane Roe, the Acme Robotics founder, and the family fortune', snippet: 'Jane Roe is the daughter of billionaire John Roe, founder of Roe Industries. She grew up in Ohio with her brother Tom Roe.', url: 'https://www.example.com/profile-jane-roe', date: null },
    ]);
    const { findings, threads } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.family'), ctxFor(subject));
    expect(findings[0].match).toBe('confirmed');
    const relatives = threads.filter((t) => t.kind === 'relative');
    expect(relatives).toEqual([expect.objectContaining({ value: 'John Roe', relation: 'parent', trusted: true })]);
    expect(threads.some((t) => /Tom Roe/.test(t.value))).toBe(false);
  });

  test('a company lookup: records about the company alone are marked as such, only when they report trouble, the most serious few', async () => {
    const subject = holmes();
    searchReturns([
      { title: 'Theranos - Wikipedia', snippet: 'Theranos was an American privately held health technology company.', url: 'https://en.wikipedia.org/wiki/Theranos', date: null },
      { title: 'Theranos lays off 340 employees', snippet: 'Theranos announced layoffs across its labs.', url: 'https://www.example.com/layoffs', date: null },
      { title: 'Walgreens sues Theranos for breach of contract', snippet: 'The lawsuit seeks $140 million.', url: 'https://www.example.com/walgreens', date: null },
      { title: 'Grand jury indicts Theranos president on wire fraud charges', snippet: 'A grand jury returned the indictment.', url: 'https://www.example.com/indicted', date: null },
      { title: 'Investors file class action against Theranos', snippet: 'A class-action lawsuit was filed in California.', url: 'https://www.example.com/class-action', date: null },
      { title: 'Theranos founder Elizabeth Holmes steps down as CEO', snippet: 'Elizabeth Holmes resigned after the charges.', url: 'https://www.example.com/steps-down', date: null },
    ]);
    const { findings, threads } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Theranos, Inc.' }, subject, 'q.company-legal'), ctxFor(subject));
    expect(findings.map((f) => [f.match, f.severity, f.title])).toEqual([
      ['confirmed', 'low', 'Theranos founder Elizabeth Holmes steps down as CEO'],
      ['company', 'high', 'Grand jury indicts Theranos president on wire fraud charges'],
      ['company', 'medium', 'Walgreens sues Theranos for breach of contract'],
      ['company', 'medium', 'Investors file class action against Theranos'],
    ]);
    expect(findings[1].matchReasons).toEqual(['names Theranos, Inc.']);
    expect(Array.isArray(threads)).toBe(true);
  });

  test('a one-word company name must be written as a name: "stripe" the pattern is not Stripe the company', async () => {
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    searchReturns([
      { title: 'How to fix a stripe pattern lawsuit', snippet: 'A dispute about a stripe design.', url: 'https://www.example.com/pattern', date: null },
      { title: 'Merchants settle lawsuit with Stripe over fees', snippet: 'The settlement ends a class action.', url: 'https://www.example.com/fees', date: null },
    ]);
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Stripe' }, subject, 'q.company-legal'), ctxFor(subject));
    expect(findings.map((f) => f.title)).toEqual(['Merchants settle lawsuit with Stripe over fees']);
    expect(findings[0].match).toBe('company');
  });

  test('an associate lookup keeps only records that also name the subject', async () => {
    const subject = holmes();
    searchReturns([
      { title: 'Ramesh Balwani sentenced to nearly 13 years', snippet: 'Balwani was convicted on all counts.', url: 'https://www.example.com/balwani', date: null },
      { title: 'Elizabeth Holmes and Ramesh Balwani charged with fraud', snippet: 'Prosecutors charged the two former Theranos executives.', url: 'https://www.example.com/both', date: null },
    ]);
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'associate', value: 'Ramesh Balwani' }, subject, 'q.associate-joint'), ctxFor(subject));
    expect(findings.map((f) => f.title)).toEqual(['Elizabeth Holmes and Ramesh Balwani charged with fraud']);
    expect(findings[0].match).toBe('confirmed');
  });

  test('says so when an engine asked us to slow down', async () => {
    const subject = holmes();
    searchReturns([RESULTS[3]], { engine: 'gnews', tried: [{ id: 'ddg', outcome: 'blocked', error: 'challenge' }, { id: 'gnews', outcome: 'results', count: 1 }] });
    const { notes } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.fraud'), ctxFor(subject));
    expect(notes).toEqual(['DuckDuckGo asked for fewer searches and is paused for a while; the other search engines cover for it meanwhile.']);
    expect(notes[0]).not.toMatch(/\b(API|endpoint|free|paid|key|token)\b/i);
  });

  test('categoryFor', () => {
    expect(categoryFor('fr.linkedin.com', 'x')).toBe('identity');
    expect(categoryFor('crunchbase.com', 'x')).toBe('identity');
    expect(categoryFor('wellfound.com', 'x')).toBe('identity');
    expect(categoryFor('cdn.ca9.uscourts.gov', 'x')).toBe('litigation');
    expect(categoryFor('law.justia.com', 'x')).toBe('litigation');
    expect(categoryFor('example.com', 'Roe v. Acme, Case No. 3:19-cv-01234')).toBe('litigation');
    expect(categoryFor('sec.gov', 'x')).toBe('regulatory');
    expect(categoryFor('justice.gov', 'x')).toBe('regulatory');
    expect(categoryFor('ftc.gov', 'x')).toBe('regulatory');
    expect(categoryFor('fca.org.uk', 'x')).toBe('regulatory');
    expect(categoryFor('nytimes.com', 'x')).toBe('press');
    expect(categoryFor('example.com', 'Jane Roe studied at Stanford University', { kind: 'school', value: 'Stanford University' })).toBe('education');
  });
});

/* ------------------------------------------------------------------ through the real engines */

describe('web-search: end to end on recorded pages', () => {
  test('a DuckDuckGo results page becomes regulator findings tied to the person', async () => {
    const subject = holmes();
    const asked = [];
    setTransport(async (url) => { asked.push(url); return { status: 200, headers: new Map(), url, text: async () => DDG_HTML }; });
    const out = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.lawsuit'), ctxFor(subject));
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]).searchParams.get('q')).toBe('"Elizabeth Holmes" lawsuit OR sued OR court OR complaint');
    expect(out.findings.map((f) => [f.category, f.match, f.severity, f.url])).toEqual([
      ['regulatory', 'confirmed', 'medium', 'https://www.sec.gov/enforcement-litigation/litigation-releases/lr-24069'],
      ['regulatory', 'confirmed', 'medium', 'https://www.sec.gov/files/litigation/complaints/2018/comp-pr2018-41-theranos-holmes.pdf'],
    ]);
    expect(out.findings[0].quote).toContain('its founder and CEO Elizabeth Holmes');
    expect(out.notes).toEqual([]);
  });

  test('the source being down makes run() reject', async () => {
    const subject = holmes();
    setTransport(async (url) => ({ status: 503, headers: new Map(), url, text: async () => 'Service Unavailable' }));
    await expect(webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.fraud'), ctxFor(subject))).rejects.toThrow(/No search engine answered/);
    await expect(newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'subject', value: subject.name }, subject, 'n.1-3y'), ctxFor(subject))).rejects.toThrow(/No search engine answered/);
  });

  test('engines that answer with nothing give an empty result, not an error', async () => {
    const subject = holmes();
    setTransport(async (url) => {
      if (url.includes('duckduckgo.com')) return { status: 200, headers: new Map(), url, text: async () => '<html><head><title>x at DuckDuckGo</title></head><body><div class="results"><div class="no-results">No results.</div></div></body></html>' };
      if (url.includes('wikipedia.org')) return { status: 200, headers: new Map(), url, text: async () => '{"batchcomplete":true,"query":{"search":[]}}' };
      return { status: 200, headers: new Map(), url, text: async () => '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>' };
    });
    const out = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.insolvency'), ctxFor(subject));
    expect(out).toEqual({ findings: [], threads: [], notes: [] });
  });
});

/* ------------------------------------------------------------------ news archives */

describe('news-archive', () => {
  test('the connector says what it is', () => {
    expect(newsArchiveConnector.id).toBe('news-archive');
    expect(newsArchiveConnector.label).toBe('News archives');
    expect(newsArchiveConnector.kinds).toEqual(['subject', 'company']);
  });

  test('the person: an adverse-terms pass for all four windows, a plain pass for the three most recent; older windows have lower priors', () => {
    const subject = holmes();
    const templates = newsArchiveConnector.plan({ kind: 'subject', value: subject.name }, subject);
    expect(templates.map((t) => t.template)).toEqual(['n.recent', 'n.recent-adverse', 'n.1-3y', 'n.1-3y-adverse', 'n.3-8y', 'n.3-8y-adverse', 'n.older-adverse']);
    expect(NEWS_WINDOWS.map((w) => w.label)).toEqual(['the last 12 months', '1 to 3 years ago', '3 to 8 years ago', 'more than 8 years ago']);
    const plain = templates.filter((t) => !t.template.endsWith('-adverse'));
    const adverse = templates.filter((t) => t.template.endsWith('-adverse'));
    for (const list of [plain, adverse]) {
      for (let i = 1; i < list.length; i += 1) expect(list[i].prior).toBeLessThan(list[i - 1].prior);
    }
    for (const t of templates) {
      expect(t.params.news).toBe(true);
      expect(t.params.query).toContain('"Elizabeth Holmes"');
      expect(t.prior).toBeGreaterThanOrEqual(0.3);
      expect(t.prior).toBeLessThanOrEqual(0.8);
    }
    expect(plain.map((t) => t.params.query)).toEqual(['"Elizabeth Holmes" Theranos', '"Elizabeth Holmes" Theranos', '"Elizabeth Holmes" Theranos']);
    expect(adverse[0].params.query).toBe('"Elizabeth Holmes" (lawsuit OR fraud OR investigation OR charged OR bankruptcy OR scandal OR fired OR settlement)');
    expect(plain.map((t) => t.params.window)).toEqual(['recent', '1-3y', '3-8y']);
    expect(adverse.map((t) => t.params.window)).toEqual(['recent', '1-3y', '3-8y', 'older']);
  });

  test('a company: two adverse passes, the last three years and everything older', () => {
    const templates = newsTemplates({ kind: 'company', value: 'Theranos, Inc.' }, holmes());
    expect(templates.map((t) => t.template)).toEqual(['n.company-last-3y', 'n.company-before-3y']);
    expect(templates.map((t) => t.params.window)).toEqual(['last-3y', 'before-3y']);
    expect(templates[1].prior).toBeLessThan(templates[0].prior);
    for (const t of templates) expect(t.params.query).toBe('"Theranos" (lawsuit OR fraud OR investigation OR bankruptcy OR layoffs OR "shut down" OR scandal OR settlement)');
    expect(newsTemplates({ kind: 'associate', value: 'Ramesh Balwani' }, holmes())).toEqual([]);
  });

  test('windows are counted back from today', () => {
    const today = Date.parse('2026-11-14T12:00:00Z');
    expect(windowDates('recent', today)).toEqual({ after: '2025-11-14', before: '2026-11-15' });
    expect(windowDates('1-3y', today)).toEqual({ after: '2023-11-15', before: '2025-11-14' });
    expect(windowDates('3-8y', today)).toEqual({ after: '2018-11-16', before: '2023-11-15' });
    expect(windowDates('older', today)).toEqual({ after: '1995-01-01', before: '2018-11-16' });
    expect(windowDates('last-3y', today)).toEqual({ after: '2023-11-15', before: '2026-11-15' });
    expect(windowDates('before-3y', today)).toEqual({ after: '1995-01-01', before: '2023-11-15' });
    expect(windowDates('nope', today)).toEqual({});
  });

  test('one news search for the window; findings are press records with the article date', async () => {
    const subject = holmes();
    searchReturns([
      { title: 'Elizabeth Holmes owes over $25 million to Theranos, lawsuit says - CNBC', snippet: '', url: 'https://news.google.com/rss/articles/CBMioAFBVV95?oc=5', date: '2023-03-17', host: 'cnbc.com', publisher: 'CNBC' },
      { title: 'Elizabeth Holmes Phones In Her Defense After Civil Lawyers Quit - Bloomberg Law News', snippet: '', url: 'https://news.google.com/rss/articles/CBMiqAFBVV95?oc=5', date: '2020-01-24', host: 'news.bloomberglaw.com', publisher: 'Bloomberg Law News' },
      { title: 'Blood-testing startup faces new questions - Example Wire', snippet: '', url: 'https://news.google.com/rss/articles/CBMizzz?oc=5', date: '2020-02-01', host: 'example.com', publisher: 'Example Wire' },
    ], { engine: 'gnews' });
    const ctx = ctxFor(subject);
    const lookup = planned(newsArchiveConnector, { kind: 'subject', value: subject.name }, subject, 'n.3-8y-adverse');
    const out = await newsArchiveConnector.run(lookup, ctx);
    expect(keylessSearch).toHaveBeenCalledTimes(1);
    const [query, options] = keylessSearch.mock.calls[0];
    expect(query).toBe(lookup.params.query);
    expect(options).toMatchObject({ news: true, num: 15, deadline: ctx.deadline, ...windowDates('3-8y') });
    expect(options.allowMetered).toBeUndefined();
    expect(out.findings.map((f) => [f.category, f.match, f.severity, f.date])).toEqual([
      ['press', 'confirmed', 'medium', '2023-03-17'],
      ['press', 'possible', 'info', '2020-01-24'],
    ]);
    expect(out.findings[0]).toMatchObject({ source: 'news-archive', sourceLabel: 'News archives', url: 'https://news.google.com/rss/articles/CBMioAFBVV95?oc=5', data: { publisher: 'CNBC' }, quote: '' });
  });

  test('a regulator or court site in the news results is still filed under press', async () => {
    const subject = holmes();
    searchReturns([{ title: 'SEC charges Theranos and Elizabeth Holmes with fraud', snippet: '', url: 'https://news.google.com/rss/articles/CBMisec?oc=5', date: '2018-03-14', host: 'sec.gov', publisher: 'SEC.gov' }], { engine: 'gnews' });
    const out = await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'subject', value: subject.name }, subject, 'n.older-adverse'), ctxFor(subject));
    expect(out.findings[0]).toMatchObject({ category: 'press', match: 'confirmed', date: '2018-03-14' });
  });

  test('a company window keeps the person\'s records and at most four company-only ones that report trouble', async () => {
    const subject = holmes();
    const companyOnly = ['lawsuit', 'fraud probe', 'bankruptcy filing', 'settlement', 'investigation', 'layoffs'].map((word, i) => ({ title: `Report says Theranos ${word} deepens - Wire ${i}`, snippet: '', url: `https://news.google.com/rss/articles/c${i}?oc=5`, date: '2018-06-01', host: 'example.com', publisher: `Wire ${i}` }));
    searchReturns([
      ...companyOnly,
      { title: 'Theranos opens new lab - Wire', snippet: '', url: 'https://news.google.com/rss/articles/open?oc=5', date: '2015-06-01', host: 'example.com', publisher: 'Wire' },
      { title: 'Feds charge Theranos\' Elizabeth Holmes with wire fraud - Fierce Biotech', snippet: '', url: 'https://news.google.com/rss/articles/feds?oc=5', date: '2018-06-18', host: 'fiercebiotech.com', publisher: 'Fierce Biotech' },
    ], { engine: 'gnews' });
    const out = await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'company', value: 'Theranos' }, subject, 'n.company-before-3y'), ctxFor(subject));
    expect(out.findings[0]).toMatchObject({ match: 'confirmed', severity: 'high', date: '2018-06-18' });
    const rest = out.findings.slice(1);
    expect(rest).toHaveLength(4);
    for (const f of rest) {
      expect(f.match).toBe('company');
      expect(f.category).toBe('press');
      expect(f.severity).not.toBe('info');
    }
    expect(out.findings.some((f) => /opens new lab/.test(f.title))).toBe(false);
  });

  test('end to end on a recorded Google News feed, with the window in the query', async () => {
    const subject = holmes();
    const asked = [];
    setTransport(async (url) => { asked.push(url); return { status: 200, headers: new Map(), url, text: async () => GNEWS_XML }; });
    const out = await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'subject', value: subject.name }, subject, 'n.3-8y-adverse'), ctxFor(subject));
    const { after, before } = windowDates('3-8y');
    expect(new URL(asked[0]).searchParams.get('q')).toBe(`"Elizabeth Holmes" (lawsuit OR fraud OR investigation OR charged OR bankruptcy OR scandal OR fired OR settlement) after:${after} before:${before}`);
    // the feed's 2026 item is outside the window and is dropped; the 2023 and 2020 items stay
    expect(out.findings.map((f) => [f.date, f.match, f.category])).toEqual([
      ['2023-03-17', 'confirmed', 'press'],
      ['2020-01-24', 'possible', 'press'],
    ]);
    expect(out.findings[0].data).toEqual({ publisher: 'CNBC' });
    expect(out.findings[0].url).toMatch(/^https:\/\/news\.google\.com\/rss\/articles\//);
  });
});

/* ------------------------------------------------------------------ the seed, and pages handed to the page reader */

describe('the seed and the backup search service', () => {
  const health = (used) => engineHealth.mockImplementation(() => ({ engines: [], metered: { configured: true, usedThisHour: used, hourlyLimit: 20 }, note: '' }));

  test('late in a busy hour only the seed may still use the backup service', async () => {
    const subject = holmes();
    searchReturns([]);
    health(20 - SEED_RESERVE);
    const allowed = {};
    for (const t of webSearchConnector.plan({ kind: 'subject', value: subject.name }, subject)) {
      keylessSearch.mockClear();
      await webSearchConnector.run(task('subject', subject.name, t.template, t.params, { prior: t.prior }), ctxFor(subject));
      allowed[t.template] = keylessSearch.mock.calls[0][1].allowMetered;
    }
    expect(Object.keys(allowed).filter((k) => allowed[k]).sort()).toEqual([...SEED_TEMPLATES].sort());
    // an earlier venture's lawsuit lookup too waits for a quieter hour
    keylessSearch.mockClear();
    await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Old Co', why: 'founder (past)' }, subject, 'q.company-prior-legal'), ctxFor(subject));
    expect(keylessSearch.mock.calls[0][1].allowMetered).toBe(false);
    health(2);
    keylessSearch.mockClear();
    await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, 'q.lawsuit'), ctxFor(subject));
    expect(keylessSearch.mock.calls[0][1].allowMetered).toBe(true);
  });

  test('a task that carries a seed flag of its own is not a seed: only our own patterns are', async () => {
    const subject = holmes();
    searchReturns([]);
    health(20 - SEED_RESERVE);
    await webSearchConnector.run(task('subject', subject.name, 'q.gap', { query: '"Elizabeth Holmes" Stanford', seed: true }, { prior: 0.5 }), ctxFor(subject));
    expect(keylessSearch.mock.calls[0][1].allowMetered).toBe(false);
  });
});

describe('pages handed to the page reader', () => {
  const run = async (results, subject = roe(), template = 'q.profile') => {
    searchReturns(results);
    const { threads } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: subject.name }, subject, template), ctxFor(subject));
    return threads;
  };

  test('the company\'s own site, seen on a record tied to the person, becomes a site to read', async () => {
    const threads = await run([{ title: 'About us | Acme Robotics', snippet: 'Acme Robotics was founded by Jane Roe, its CEO.', url: 'https://www.acmerobotics.com/company/story', date: null }]);
    expect(threads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'domain', value: 'acmerobotics.com', why: 'company website', trusted: true })]));
  });

  test('an established publication\'s article whose snippet names them, though its headline does not', async () => {
    const threads = await run([
      { title: 'Acme Robotics raises $40M to automate warehouses', snippet: 'Jane Roe, co-founder and CEO of Acme Robotics, previously led robotics at Initech.', url: 'https://techcrunch.com/2024/05/01/acme-robotics-raises/', date: null },
      { title: 'Acme Robotics raises money', snippet: 'Jane Roe, CEO of Acme Robotics, said ...', url: 'https://someblog.test/acme-robotics-raises', date: null },
    ]);
    const urls = threads.filter((t) => t.kind === 'url').map((t) => `${t.why}|${t.value}`);
    expect(urls).toContain('article naming them|https://techcrunch.com/2024/05/01/acme-robotics-raises');
    expect(urls.some((u) => u.includes('someblog.test'))).toBe(false);
  });

  test('podcast show notes and newsletter interviews that name them are read', async () => {
    const threads = await run([
      { title: 'Episode 74: building in robotics', snippet: 'Our guest is Jane Roe, CEO of Acme Robotics.', url: 'https://www.founderpod.test/episodes/74-building-in-robotics', date: null },
      { title: 'Building Acme Robotics (#74)', snippet: 'A conversation with Jane Roe, co-founder of Acme Robotics.', url: 'https://notanotherceo.substack.com/p/acme-robotics-74', date: null },
    ], roe(), 'q.interviews');
    const why = Object.fromEntries(threads.filter((t) => t.kind === 'url').map((t) => [t.value, t.why]));
    expect(why['https://www.founderpod.test/episodes/74-building-in-robotics']).toBe('podcast or interview page');
    expect(why['https://notanotherceo.substack.com/p/acme-robotics-74']).toBe('interview or article page about them');
  });

  test('a record that only names them (a possible namesake) hands on no article, show notes or site', async () => {
    const threads = await run([
      { title: 'Robotics funding roundup', snippet: 'Jane Roe of Springfield spoke.', url: 'https://techcrunch.com/2024/05/01/roundup/', date: null },
      { title: 'Episode 9', snippet: 'Our guest is Jane Roe.', url: 'https://pod.test/episodes/9-guest', date: null },
    ]);
    expect(threads.filter((t) => t.kind === 'url' || t.kind === 'domain')).toEqual([]);
  });
});
