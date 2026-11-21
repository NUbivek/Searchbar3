/**
 * @jest-environment node
 *
 * Round 3 fixes to the open-web and news sources, from grading real reports:
 * a one-word company name at the start of a title or sentence, or a word the
 * same text also uses in lower case ("... stagnation point flow"), is not
 * placed as the company on its own; later ventures, their funding and the
 * company's backers are searched for; Wikipedia articles about something else
 * that name the person without anything tied to them are dropped, and an
 * article the encyclopedia source already read is not added twice.
 */
jest.mock('../../../src/server/search/retrieve', () => ({
  searchWeb: jest.fn(async () => []),
  webSearchConfigured: jest.fn(() => false),
}));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/founder/sources/searchEngines', () => {
  const actual = jest.requireActual('../../../src/server/founder/sources/searchEngines');
  return { ...actual, keylessSearch: jest.fn(async () => ({ results: [], engine: null, tried: [] })) };
});

import { createSubject } from '../../../src/server/founder/identity';
import { keylessSearch } from '../../../src/server/founder/sources/searchEngines';
import { webSearchConnector, newsArchiveConnector, webTemplates, newsTemplates } from '../../../src/server/founder/sources/web';

const ctxFor = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });
const planned = (connector, thread, subject, template) => {
  const t = connector.plan(thread, subject).find((x) => x.template === template);
  return { kind: thread.kind, value: thread.value, template: t.template, params: t.params, prior: t.prior, depth: 0, relation: null };
};
function searchReturns(results) {
  keylessSearch.mockImplementation(async (query, options = {}) => {
    const kept = results.filter((r) => (typeof options.accept === 'function' ? options.accept(r) : true));
    return { results: kept, engine: kept.length ? 'gnews' : null, tried: [] };
  });
}
const r = (title, extra = {}) => ({ title, snippet: '', url: `https://www.example.com/${encodeURIComponent(title).slice(0, 40)}`, date: null, ...extra });

beforeEach(() => keylessSearch.mockReset());

async function keptByBoth(subject, company, result) {
  const out = [];
  for (const [connector, template] of [[webSearchConnector, 'q.company-legal'], [newsArchiveConnector, 'n.company-last-3y']]) {
    searchReturns([result]);
    const { findings } = await connector.run(planned(connector, { kind: 'company', value: company }, subject, template), ctxFor(subject));
    out.push(findings.length === 1);
  }
  expect(out[0]).toBe(out[1]);
  return out[0];
}

describe('a one-word company name is not placed by its position at the start of a title or sentence', () => {
  const roe = () => createSubject({ name: 'Jane Roe', company: 'Flow' });

  test('a paper whose title starts with the word is not a record about the company', async () => {
    const s = roe();
    expect(await keptByBoth(s, 'Flow', r('Flow investigation of stagnation point flow over a plate', { snippet: 'Retraction after a misconduct investigation into the data.' }))).toBe(false);
  });

  test('the same word in lower case makes a mid-sentence capital weak too', async () => {
    const s = roe();
    expect(await keptByBoth(s, 'Flow', r('Misconduct investigation into the Flow model of stagnation point flow'))).toBe(false);
    // R3: "Flow" is an ordinary word: a mid-sentence capital alone no longer makes a record the company's
    // (design decision 1: never the bare word); the surname, a legal form or a known legal name does
    expect(await keptByBoth(s, 'Flow', r('Tenants file fraud lawsuit against Flow over rents'))).toBe(false);
    // and the surname still places a weak name
    expect(await keptByBoth(s, 'Flow', r("Investors sue Roe's Flow, citing poor cash flow and fraud"))).toBe(true);
  });

  test('a sentence-initial name followed by a lower-case word is not placed; mid-sentence or with a company word it is', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    expect(await keptByBoth(s, 'Nikola', r('Nikola recalls trucks after battery fires lawsuit'))).toBe(false);
    expect(await keptByBoth(s, 'Nikola', r('Truck fires lawsuit grows', { snippet: 'Nikola recalls trucks after the fires.' }))).toBe(false);
    expect(await keptByBoth(s, 'Nikola', r('Truck fires lawsuit grows. Nikola recalls trucks'))).toBe(false);
    expect(await keptByBoth(s, 'Nikola', r('Regulators say Nikola recalls trucks after battery fires lawsuit'))).toBe(true);
    expect(await keptByBoth(s, 'Nikola', r('Fraud lawsuit names Nikola'))).toBe(true);
    expect(await keptByBoth(s, 'Nikola', r('Nikola Corp recalls trucks after battery fires lawsuit'))).toBe(true);
  });
});

describe('later ventures, their funding and the company\'s backers are searched for', () => {
  const neumann = () => createSubject({ name: 'Jane Roe', company: 'WeWork' });

  test('a later-ventures lookup that does not exclude the known company', () => {
    const s = neumann();
    const q = Object.fromEntries(webTemplates({ kind: 'subject', value: s.name }, s).map((t) => [t.template, t.params.query]));
    expect(q['q.later-ventures']).toBe('"Jane Roe" (raises OR funding OR "backed by" OR launches OR "new company")');
    expect(q['q.later-ventures']).not.toContain('WeWork');
    // R3: earlier ventures are asked WITH the known company (excluding it left mostly namesakes)
    expect(q['q.prior-ventures']).toContain('"Jane Roe" WeWork (');
    expect(q['q.prior-ventures']).not.toContain('-"WeWork"');
  });

  test('a plain news pass for 3 to 8 years ago', () => {
    const s = neumann();
    const plain = newsTemplates({ kind: 'subject', value: s.name }, s).filter((t) => !t.template.endsWith('-adverse'));
    expect(plain.map((t) => t.params.window)).toEqual(['recent', '1-3y', '3-8y']);
    expect(plain.find((t) => t.template === 'n.3-8y').params.query).toBe('"Jane Roe" WeWork');
  });

  test('a one-word company is searched for funding with the person named; every company for advisers and shareholders', () => {
    const s = neumann();
    const one = Object.fromEntries(webTemplates({ kind: 'company', value: 'Flow' }, s).map((t) => [t.template, t.params.query]));
    expect(one['q.company-funding']).toBe('"Flow" "Jane Roe" (raises OR "Series A" OR "Series B" OR "seed round" OR "led by" OR valuation)');
    // R3: an ordinary word is never searched alone: with the person's name until a legal name or domain is known
    expect(one['q.company-backers']).toBe('"Flow" "Jane Roe" (adviser OR advisor OR shareholder OR board)');
    const two = Object.fromEntries(webTemplates({ kind: 'company', value: 'Acme Robotics Inc.' }, s).map((t) => [t.template, t.params.query]));
    expect(two['q.company-funding']).toBeUndefined();
    expect(two['q.company-backers']).toBe('"Acme Robotics" (adviser OR advisor OR shareholder OR board)');
  });

  test('a funding article naming the person is kept from the funding lookup', async () => {
    const s = neumann();
    searchReturns([r('Jane Roe\'s Flow raises $350 million led by a venture firm', { snippet: 'Flow, the new company from WeWork co-founder Jane Roe, raised funding.' })]);
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Flow' }, s, 'q.company-funding'), ctxFor(s));
    expect(findings).toHaveLength(1);
    expect(findings[0].match).not.toBe('company');
  });
});

describe('Wikipedia articles about something else', () => {
  const milton = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });

  test('an article that names the person but nothing tied to them is dropped; one that names their company is kept as possible', async () => {
    const s = milton();
    searchReturns([
      { title: 'The Trevor Milton Story (1921 film) - Wikipedia', snippet: 'A silent film starring Trevor Milton as a sailor.', url: 'https://en.wikipedia.org/wiki/The_Trevor_Milton_Story', date: null },
      { title: '1975 Birthday Honours - Wikipedia', snippet: 'Trevor Milton, for services to farming.', url: 'https://en.wikipedia.org/wiki/1975_Birthday_Honours', date: null },
      { title: 'Hydrogen trucks - Wikipedia', snippet: 'Trevor Milton, founder of Nikola, promoted hydrogen trucks.', url: 'https://en.wikipedia.org/wiki/Hydrogen_trucks', date: null },
    ]);
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.profile'), ctxFor(s));
    expect(findings.map((f) => [f.url, f.match])).toEqual([['https://en.wikipedia.org/wiki/Hydrogen_trucks', 'possible']]);
  });

  test('an article the encyclopedia source already read is not added again, whatever form its link takes', async () => {
    const s = milton();
    const article = { title: 'Trevor Milton - Wikipedia', snippet: 'Trevor Milton is the founder of Nikola.', url: 'https://en.m.wikipedia.org/wiki/Trevor_Milton#Career', date: null };
    searchReturns([article]);
    const already = [{ source: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Trevor_Milton', title: 'Wikipedia: Trevor Milton' }];
    const skipped = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.profile'), ctxFor(s, already));
    expect(skipped.findings).toEqual([]);
    // a record from another source with the same link does not count, nor does another language
    searchReturns([article]);
    const other = [{ source: 'web-search', url: 'https://en.wikipedia.org/wiki/Trevor_Milton' }, { source: 'wikipedia', url: 'https://fr.wikipedia.org/wiki/Trevor_Milton' }];
    const kept = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.profile'), ctxFor(s, other));
    expect(kept.findings).toHaveLength(1);
    // no record list at all (an older caller) is fine
    searchReturns([article]);
    const bare = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.profile'), { subject: s, deadline: Date.now() + 20000, known: () => ({}) });
    expect(bare.findings).toHaveLength(1);
  });
});
