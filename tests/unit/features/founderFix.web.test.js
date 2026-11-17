/**
 * @jest-environment node
 *
 * Fixes to the open-web and news sources: a one-word company name must be
 * placed as that company before a record about the company alone is kept
 * (namesake people and companies are not), and a typical check stays within
 * its share of the search allowance.
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
import { webSearchConnector, newsArchiveConnector } from '../../../src/server/founder/sources/web';

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const planned = (connector, thread, subject, template) => {
  const t = connector.plan(thread, subject).find((x) => x.template === template);
  return { kind: thread.kind, value: thread.value, template: t.template, params: t.params, prior: t.prior, depth: 0, relation: null };
};
/** The search hands back what the caller's accept filter keeps, as the real one does. */
function searchReturns(results) {
  keylessSearch.mockImplementation(async (query, options = {}) => {
    const kept = results.filter((r) => (typeof options.accept === 'function' ? options.accept(r) : true));
    return { results: kept, engine: kept.length ? 'gnews' : null, tried: [] };
  });
}
const r = (title, extra = {}) => ({ title, snippet: '', url: `https://www.example.com/${encodeURIComponent(title).slice(0, 40)}`, date: null, ...extra });

beforeEach(() => keylessSearch.mockReset());

describe('a one-word company name must be placed as that company', () => {
  const milton = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });

  test('a namesake person ("Nikola Jokic") is not a record about Nikola the company', async () => {
    const subject = milton();
    searchReturns([r('Nikola Jokic fined $25,000 by NBA for obscene gesture')]);
    for (const [connector, template] of [[newsArchiveConnector, 'n.company-last-3y'], [webSearchConnector, 'q.company-legal']]) {
      const { findings } = await connector.run(planned(connector, { kind: 'company', value: 'Nikola' }, subject, template), ctxFor(subject));
      expect(findings).toEqual([]);
    }
  });

  test('a namesake company ("Square Enix") is not a record about Square', async () => {
    const subject = createSubject({ name: 'Yosuke Matsuda', company: 'Square' });
    searchReturns([r('Square Enix sued over loot boxes')]);
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Square' }, subject, 'q.company-legal'), ctxFor(subject));
    expect(findings).toEqual([]);
  });

  test('the company itself is still kept: on its own, with a company word, with the surname, or on its own site', async () => {
    const subject = milton();
    addAnchor(subject, 'domains', 'nikolamotor.com', 'given');
    searchReturns([
      r('Regulators say Nikola recalls trucks after battery fires lawsuit'),
      r('Nikola Corp Faces Fraud Investigation By Regulators'),
      r('Nikola Motor Faces Fraud Lawsuit From Investors'),
      r('Nikola Shares Plunge After Fraud Lawsuit'),
      r('Founder Milton: Nikola settles fraud lawsuit'),
      r('Nikola Update On The Lawsuit', { url: 'https://nikolamotor.com/press/lawsuit-update' }),
    ]);
    const { findings } = await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'company', value: 'Nikola' }, subject, 'n.company-before-3y'), ctxFor(subject));
    // at most four company-only records per news lookup
    expect(findings).toHaveLength(4);
    for (const f of findings) expect(f.match).toBe('company');
  });

  test('each placement on its own is enough', async () => {
    const subject = milton();
    addAnchor(subject, 'domains', 'nikolamotor.com', 'given');
    const kept = async (result) => {
      searchReturns([result]);
      const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Nikola' }, subject, 'q.company-legal'), ctxFor(subject));
      return findings.length === 1;
    };
    expect(await kept(r('Regulators say Nikola recalls trucks after battery fires lawsuit'))).toBe(true);
    expect(await kept(r('Nikola Corp faces fraud investigation'))).toBe(true);
    expect(await kept(r('Nikola Jokic and Milton named in fraud lawsuit'))).toBe(true); // the surname places it
    expect(await kept(r('Nikola Update On The Fraud Lawsuit', { url: 'https://nikolamotor.com/news/1' }))).toBe(true);
    // headline case: the capitals say nothing, so a legal form, the surname, the site or the person must place it
    expect(await kept(r('Nikola Shares Plunge After Fraud Lawsuit'))).toBe(false);
    expect(await kept(r('Nikola Jokic Hit With Lawsuit Over Fraud Claims'))).toBe(false);
    // the snippet, in plain sentence case, can place a headline-case title
    expect(await kept(r('Nikola Hit With Lawsuit Over Fraud Claims', { snippet: 'Buyers filed a lawsuit against Nikola.' }))).toBe(true);
    // a lower-case word is never the company
    expect(await kept(r('nikola fraud lawsuit thread'))).toBe(false);
  });

  test('a multi-word company name is unchanged', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    searchReturns([r('Acme Robotics sued over fraud'), r('acme robotics lawsuit settled')]);
    const { findings } = await webSearchConnector.run(planned(webSearchConnector, { kind: 'company', value: 'Acme Robotics' }, subject, 'q.company-legal'), ctxFor(subject));
    expect(findings).toHaveLength(2);
  });
});

describe('a typical check stays within its share of the search allowance', () => {
  test('the person, four companies, ten associates and three relatives take at most about 70 search lookups', () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const count = (kind, value) => webSearchConnector.plan({ kind, value }, subject).length + (newsArchiveConnector.kinds.includes(kind) ? newsArchiveConnector.plan({ kind, value }, subject).length : 0);
    let total = count('subject', subject.name);
    for (const c of ['Theranos', 'Acme Robotics', 'Initech', 'Hooli']) total += count('company', c);
    for (let i = 0; i < 10; i += 1) total += count('associate', `Associate Person${String.fromCharCode(65 + i)}`);
    for (const name of ['Christian Holmes', 'Noel Holmes', 'Billy Evans']) total += count('relative', name);
    expect(total).toBeLessThanOrEqual(70);
    expect(newsArchiveConnector.plan({ kind: 'company', value: 'Theranos' }, subject)).toHaveLength(2);
    expect(newsArchiveConnector.plan({ kind: 'subject', value: subject.name }, subject)).toHaveLength(7);
    expect(webSearchConnector.plan({ kind: 'associate', value: 'Ramesh Balwani' }, subject)).toHaveLength(1);
    expect(webSearchConnector.plan({ kind: 'company', value: 'Theranos' }, subject).map((t) => t.template)).not.toContain('q.company-breach');
  });
});
