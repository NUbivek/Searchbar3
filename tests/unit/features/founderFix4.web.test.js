/**
 * @jest-environment node
 *
 * Round 4 fixes to the open-web and news sources, from grading real reports:
 * a company's backers and round leads are searched for (in French too when
 * the company looks French); an earlier venture is searched for old lawsuits
 * that name the person, with an encyclopedia or a metered search allowed;
 * a news date that may be a re-publication is marked approximate and not used
 * to grade; a Wikipedia page titled with the first name or surname alone is a
 * list of namesakes; background Wikipedia articles are capped per check.
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

import { createSubject, addAnchor, addRoleAnchor } from '../../../src/server/founder/identity';
import { keylessSearch } from '../../../src/server/founder/sources/searchEngines';
import { webSearchConnector, newsArchiveConnector, webTemplates, wikipediaKind, dateApprox, WIKI_OTHER_MAX } from '../../../src/server/founder/sources/web';

const ctxFor = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });
const byId = (list) => Object.fromEntries(list.map((t) => [t.template, t]));
function searchReturns(results) {
  keylessSearch.mockImplementation(async (query, options = {}) => {
    const kept = results.filter((r) => (typeof options.accept === 'function' ? options.accept(r) : true));
    return { results: kept, engine: kept.length ? 'gnews' : null, tried: [] };
  });
}

beforeEach(() => keylessSearch.mockReset());

describe('backers and round leads', () => {
  test('backers are asked at a higher prior, and round leads have their own lookup', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const t = byId(webTemplates({ kind: 'company', value: 'Acme Robotics' }, s));
    expect(t['q.company-backers'].prior).toBe(0.5);
    expect(t['q.company-investors'].params.query).toBe('"Acme Robotics" ("led by" OR "lead investor" OR "Series A" OR "Series B" OR "Series C")');
    expect(t['q.company-backers-fr']).toBeUndefined();
  });

  test('a French company is also searched for advisers, shareholders and conflicts of interest in French', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    addAnchor(s, 'schools', 'École Polytechnique', 'found');
    const fr = byId(webTemplates({ kind: 'company', value: 'Acme Robotics SAS' }, s))['q.company-backers-fr'];
    expect(fr.params.query).toBe('"Acme Robotics" (actionnaire OR conseiller OR "ancien ministre" OR "conflit d\'intérêts")');
    expect(fr.params.lang).toBe('fr');
  });
});

describe('an earlier venture is searched for old lawsuits naming the person', () => {
  const s = () => createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });

  test('a past company gets the lookup; the given company and an unplaced one do not', () => {
    const past = byId(webTemplates({ kind: 'company', value: 'Roe Fuel Systems', why: 'CEO (past)', tie: 'primary' }, s()))['q.company-prior-legal'];
    expect(past.params).toEqual({ query: '"Roe Fuel Systems" "Jane Roe" (sued OR lawsuit OR judgment)', prefer: 'reference', allowMetered: true });
    expect(byId(webTemplates({ kind: 'company', value: 'Roe Fuel Systems', why: 'Form D names the person as Executive Officer', tie: 'primary' }, s()))['q.company-prior-legal']).toBeDefined();
    expect(byId(webTemplates({ kind: 'company', value: 'Acme Robotics, Inc.', why: 'CEO (past)' }, s()))['q.company-prior-legal']).toBeUndefined();
    expect(byId(webTemplates({ kind: 'company', value: 'Roe Fuel Systems', why: 'named with the person' }, s()))['q.company-prior-legal']).toBeUndefined();
    expect(byId(webTemplates({ kind: 'company', value: 'Roe Fuel Systems', why: 'CEO (past)', tie: 'affiliate' }, s()))['q.company-prior-legal']).toBeUndefined();
  });

  test('the lookup may use the metered services', async () => {
    const subject = s();
    const t = byId(webTemplates({ kind: 'company', value: 'Roe Fuel Systems', why: 'CEO (past)' }, subject))['q.company-prior-legal'];
    searchReturns([]);
    await webSearchConnector.run({ kind: 'company', value: 'Roe Fuel Systems', template: t.template, params: t.params, prior: t.prior, depth: 0 }, ctxFor(subject));
    expect(keylessSearch.mock.calls[0][1]).toMatchObject({ allowMetered: true, prefer: 'reference' });
  });
});

describe('approximate news dates', () => {
  const s = () => createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });

  test('an earlier year in the address or headline makes the date approximate', () => {
    const subject = s();
    expect(dateApprox(subject, { title: 'Jane Roe resigns', url: 'https://news.example.com/2020/09/20/jane-roe-resigns', date: '2024-09-01' })).toBe(true);
    expect(dateApprox(subject, { title: 'Jane Roe charged with fraud in 2021', url: 'https://news.example.com/x', date: '2024-09-01' })).toBe(true);
    expect(dateApprox(subject, { title: 'Jane Roe raises $2021 million', url: 'https://news.example.com/a/2024/jane', date: '2024-09-01' })).toBe(false);
    expect(dateApprox(subject, { title: 'Jane Roe resigns', url: 'https://news.example.com/article/72020123', date: '2024-09-01' })).toBe(false);
    expect(dateApprox(subject, { title: 'Jane Roe resigns', url: 'https://news.example.com/x', date: null })).toBe(false);
  });

  test('a headline calling the person CEO after their tenure ended makes it approximate', () => {
    const subject = s();
    addRoleAnchor(subject, { org: 'Acme Robotics', from: '2015-01-01', to: '2020-09-20' });
    expect(dateApprox(subject, { title: 'Acme Robotics CEO Jane Roe unveils truck', url: 'https://n.example.com/x', date: '2024-02-01' })).toBe(true);
    expect(dateApprox(subject, { title: 'Acme Robotics CEO Jane Roe unveils truck', url: 'https://n.example.com/x', date: '2019-02-01' })).toBe(false);
    expect(dateApprox(subject, { title: 'Former Acme Robotics CEO Jane Roe sentenced', url: 'https://n.example.com/x', date: '2024-02-01' })).toBe(false);
  });

  test('the record keeps its date, marked approximate', async () => {
    const subject = s();
    searchReturns([{ title: 'Jane Roe resigns from Acme Robotics', snippet: '', url: 'https://news.example.com/2020/09/20/jane-roe-resigns', date: '2024-09-01' }]);
    const t = byId(webTemplates({ kind: 'subject', value: subject.name }, subject))['q.profile'];
    const { findings } = await webSearchConnector.run({ kind: 'subject', value: subject.name, template: t.template, params: t.params, prior: t.prior, depth: 0 }, ctxFor(subject));
    expect(findings).toHaveLength(1);
    expect(findings[0].date).toBe('2024-09-01');
    expect(findings[0].data.dateApprox).toBe(true);
  });
});

describe('Wikipedia pages about something else', () => {
  const s = () => createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });

  test('the first name or surname alone is a list of namesakes', () => {
    const subject = s();
    expect(wikipediaKind(subject, null, 'Roe')).toBe('list');
    expect(wikipediaKind(subject, null, 'Jane')).toBe('list');
    expect(wikipediaKind(subject, null, 'Jane Roe')).toBe('subject');
    expect(wikipediaKind(subject, null, 'Roe v. Wade')).toBe('other');
    // a company named like the surname stays the company
    expect(wikipediaKind(createSubject({ name: 'Jane Roe', company: 'Roe' }), null, 'Roe')).toBe('subject');
  });

  test(`at most ${WIKI_OTHER_MAX} per check, marked as background`, async () => {
    const subject = s();
    const wiki = (title) => ({ title: `${title} - Wikipedia`, snippet: 'Jane Roe, founder of Acme Robotics, spoke at the event.', url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, date: null });
    searchReturns(['Event One', 'Event Two', 'Event Three', 'Event Four'].map(wiki));
    const t = byId(webTemplates({ kind: 'subject', value: subject.name }, subject))['q.profile'];
    const task = { kind: 'subject', value: subject.name, template: t.template, params: t.params, prior: t.prior, depth: 0 };
    const first = await webSearchConnector.run(task, ctxFor(subject));
    expect(first.findings).toHaveLength(WIKI_OTHER_MAX);
    expect(first.findings.every((f) => f.data?.background && f.match === 'possible')).toBe(true);
    // a later lookup in the same check, after the allowance is used up, keeps none
    searchReturns([wiki('Event Five')]);
    const later = await newsArchiveConnector.run({ kind: 'subject', value: subject.name, template: 'n.recent', params: { query: '"Jane Roe"', window: 'recent', news: true }, depth: 0 }, ctxFor(subject, first.findings));
    expect(later.findings).toHaveLength(0);
  });
});
