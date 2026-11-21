/**
 * @jest-environment node
 *
 * Round 2 fixes to the open-web and news sources, from grading real reports:
 * a short or plain one-word company name ("We") and a one-word name in a
 * headline-case title ("Flow Characteristics Of ...") must be placed as the
 * company by a legal form, the company's site, the subject's surname within
 * five words or the subject's name; Wikipedia articles found by the web
 * search that are about something else are background at most, and pages
 * listing namesakes are dropped.
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

import { createSubject, addAnchor } from '../../../src/server/founder/identity';
import { keylessSearch } from '../../../src/server/founder/sources/searchEngines';
import { webSearchConnector, newsArchiveConnector, wikipediaTitle, wikipediaKind } from '../../../src/server/founder/sources/web';

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
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
const BOTH = [[webSearchConnector, 'q.company-legal'], [newsArchiveConnector, 'n.company-last-3y']];

beforeEach(() => keylessSearch.mockReset());

/** Is this one result kept as a company record by both the web and the news lookups? */
async function keptByBoth(subject, company, result) {
  const out = [];
  for (const [connector, template] of BOTH) {
    searchReturns([result]);
    const { findings } = await connector.run(planned(connector, { kind: 'company', value: company }, subject, template), ctxFor(subject));
    out.push(findings.length === 1);
  }
  expect(out[0]).toBe(out[1]);
  return out[0];
}

describe('a short or plain company name needs more than a capital letter', () => {
  const subject = () => createSubject({ name: 'Jane Roe', company: 'We' });

  test('"We" in an ordinary headline is not the company', async () => {
    const s = subject();
    expect(await keptByBoth(s, 'We', r('What We Learned From The Fraud Lawsuit'))).toBe(false);
    expect(await keptByBoth(s, 'We', r('Paymentwall sues We over unpaid invoices in fraud lawsuit'))).toBe(false);
    expect(await keptByBoth(s, 'We', r('Why We sued the landlord, a lawsuit story'))).toBe(false);
  });

  test('a legal form, the surname nearby or the company site still places it', async () => {
    const s = subject();
    addAnchor(s, 'domains', 'we.co', 'given');
    expect(await keptByBoth(s, 'We', r('We Inc. faces fraud lawsuit from investors'))).toBe(true);
    expect(await keptByBoth(s, 'We', r('Roe-led We hit with fraud lawsuit'))).toBe(true);
    expect(await keptByBoth(s, 'We', r('We statement on the lawsuit', { url: 'https://we.co/news/lawsuit' }))).toBe(true);
  });

  test('the surname far from the name does not place it', async () => {
    const s = subject();
    expect(await keptByBoth(s, 'We', r('What We Learned: the one fraud lawsuit that every reader of Roe should know'))).toBe(false);
  });

  test('a three-letter name is held to the same test, and the full given name is enough', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Zyx Holdings Ltd' });
    // shortCompany drops "Holdings" and "Ltd": "Zyx" alone needs placing
    expect(await keptByBoth(s, 'Zyx Holdings Ltd', r('Zyx Brands sued in fraud lawsuit'))).toBe(false);
    expect(await keptByBoth(s, 'Zyx Holdings Ltd', r('Zyx Holdings Ltd sued in fraud lawsuit'))).toBe(true);
  });
});

describe('a one-word name in a headline-case title', () => {
  const subject = () => createSubject({ name: 'Jane Roe', company: 'Flow' });

  test('a capital is not evidence in headline case: "Flow Characteristics" is not the company', async () => {
    const s = subject();
    expect(await keptByBoth(s, 'Flow', r('Flow Characteristics Of Fluids In Pipe Fraud Lawsuit'))).toBe(false);
    // business words around it are not enough either
    expect(await keptByBoth(s, 'Flow', r('Flow Shares Plunge After Investors File Fraud Lawsuit'))).toBe(false);
  });

  test('a legal form, the surname within five words or the person places it', async () => {
    const s = subject();
    expect(await keptByBoth(s, 'Flow', r('Flow Inc. Faces Fraud Lawsuit From Investors'))).toBe(true);
    expect(await keptByBoth(s, 'Flow', r("Roe's Flow Faces Fraud Lawsuit From Investors"))).toBe(true);
  });

  test('a sentence-case snippet can still place it', async () => {
    const s = subject();
    // R3: "Flow" is an ordinary word; a sentence-case capital alone no longer places it (never the bare word)
    expect(await keptByBoth(s, 'Flow', r('Flow Hit With Lawsuit Over Fraud Claims', { snippet: 'Tenants filed a lawsuit against Flow last week.' }))).toBe(false);
    expect(await keptByBoth(s, 'Flow', r('Flow Hit With Lawsuit Over Fraud Claims', { snippet: 'Tenants filed a lawsuit against Flow Inc. last week.' }))).toBe(true);
  });
});

describe('Wikipedia articles from the web search', () => {
  test('reads the article title from the link', () => {
    expect(wikipediaTitle('https://en.wikipedia.org/wiki/Milton_(surname)')).toBe('Milton (surname)');
    expect(wikipediaTitle('https://en.m.wikipedia.org/wiki/Viva_Technology?x=1')).toBe('Viva Technology');
    expect(wikipediaTitle('https://www.example.com/wiki/Foo')).toBe('');
  });

  test('sorts articles into the person or their companies, lists of namesakes, and everything else', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Robotics, Inc.' });
    addAnchor(s, 'people', 'John Doe', 'given');
    const task = { kind: 'subject', value: 'Jane Roe' };
    expect(wikipediaKind(s, task, 'Jane Roe')).toBe('subject');
    expect(wikipediaKind(s, task, 'Jane Roe (businesswoman)')).toBe('subject');
    expect(wikipediaKind(s, task, 'Acme Robotics')).toBe('subject');
    expect(wikipediaKind(s, task, 'John Doe')).toBe('subject');
    expect(wikipediaKind(s, task, 'Roe (surname)')).toBe('list');
    expect(wikipediaKind(s, task, 'Jane (given name)')).toBe('list');
    expect(wikipediaKind(s, task, 'Roe (disambiguation)')).toBe('list');
    expect(wikipediaKind(s, task, 'Founder mode')).toBe('other');
    expect(wikipediaKind(s, task, 'List of unicorn startup companies')).toBe('other');
    // containing an anchor is not being it
    expect(wikipediaKind(s, task, 'Acme Robotics Arena')).toBe('other');
  });

  test('an article about something else is at most possible, background, and gives no trusted threads', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    searchReturns([
      { title: 'Founder mode - Wikipedia', snippet: 'Jane Roe, chief executive of Acme Robotics, was charged with fraud in a lawsuit.', url: 'https://en.wikipedia.org/wiki/Founder_mode', date: null },
      { title: 'Roe (surname) - Wikipedia', snippet: 'Jane Roe, founder of Acme Robotics.', url: 'https://en.wikipedia.org/wiki/Roe_(surname)', date: null },
      { title: 'Jane Roe - Wikipedia', snippet: 'Jane Roe is the founder of Acme Robotics.', url: 'https://en.wikipedia.org/wiki/Jane_Roe', date: null },
    ]);
    const { findings, threads } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: 'Jane Roe' }, s, 'q.profile'), ctxFor(s));
    expect(findings.map((f) => f.url)).toEqual(['https://en.wikipedia.org/wiki/Founder_mode', 'https://en.wikipedia.org/wiki/Jane_Roe']);
    const other = findings[0];
    expect(other).toMatchObject({ match: 'possible', severity: 'info', matchFixed: true });
    expect(other.matchReasons[0]).toMatch(/about Founder mode/);
    expect(findings[1].match).toBe('confirmed');
    for (const t of threads.filter((x) => /Founder_mode/.test(x.value))) expect(t.trusted).toBeFalsy();
  });

  test('in a company lookup, an article about something else is never kept as a company record', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    searchReturns([
      { title: 'Robot fraud cases - Wikipedia', snippet: 'Acme Robotics was sued for fraud in 2019.', url: 'https://en.wikipedia.org/wiki/Robot_fraud_cases', date: null },
      { title: 'Acme Robotics - Wikipedia', snippet: 'Acme Robotics was sued for fraud in 2019.', url: 'https://en.wikipedia.org/wiki/Acme_Robotics', date: null },
    ]);
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Acme Robotics' }, s, 'q.company-legal'), ctxFor(s));
    expect(findings.map((f) => [f.url, f.match])).toEqual([['https://en.wikipedia.org/wiki/Acme_Robotics', 'company']]);
  });
});
