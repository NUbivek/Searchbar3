/**
 * @jest-environment node
 *
 * R4 (review 2026-11-21), web.js: the local-language passes. ö, ä and ü are not German alone
 * (web-lang-umlaut-german); the Japanese, Korean, Chinese, Hebrew and Hindi passes search the name in the
 * local script, or say the local press was not really searched (web-lang-native-script); the seed and adverse
 * questions pass on how long the check may still wait (web-needgeneral-never-waits).
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

import { createSubject, addNameAlias } from '../../../src/server/founder/identity';
import { keylessSearch, REGION } from '../../../src/server/founder/sources/searchEngines';
import { webSearchConnector, newsArchiveConnector, webTemplates, newsTemplates, languageHints } from '../../../src/server/founder/sources/web';

const ctxFor = (subject, extra = {}) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => [], ...extra });
const planned = (connector, thread, subject, template) => {
  const t = connector.plan(thread, subject).find((x) => x.template === template);
  if (!t) throw new Error(`no ${template}`);
  return { kind: thread.kind, value: thread.value, template: t.template, params: t.params, prior: t.prior, depth: 0, relation: null };
};

beforeEach(() => { keylessSearch.mockReset(); keylessSearch.mockResolvedValue({ results: [], engine: 'ddg', tried: [], general: true, headlinesOnly: false }); });

describe('web-lang-umlaut-german', () => {
  test('Swedish and Turkish names with ö or ü get their own language, not German', () => {
    expect(languageHints(createSubject({ name: 'Björn Ström', company: 'Klarna' }))).toEqual(['sv']);
    expect(languageHints(createSubject({ name: 'Niklas Zennström', company: 'Skype' }))).toEqual(['sv']);
    expect(languageHints(createSubject({ name: 'Gökhan Öztürk', company: 'Getir' }))).toEqual(['tr']);
  });

  test('a Finnish name with a Finnish place gets Finnish, with its own news edition', () => {
    const s = createSubject({ name: 'Mikko Hyppönen', company: 'WithSecure' });
    expect(languageHints(s)).toEqual(['fi']);
    expect(REGION.fi.gnews).toMatch(/^hl=fi/);
    expect(webTemplates({ kind: 'subject', value: s.name }, s).map((t) => t.template)).toContain('q.adverse-fi');
  });

  test('German stays German: a German first name, a German company, or ö/ü with no other sign', () => {
    expect(languageHints(createSubject({ name: 'Jürgen Müller', company: 'Beispiel GmbH' }))).toEqual(['de']);
    expect(languageHints(createSubject({ name: 'Lena Schröder', company: 'Acme' }))).toEqual(['de']);
    expect(languageHints(createSubject({ name: 'Peter Weiß', company: 'Acme' }))).toEqual(['de']);
  });
});

describe('web-lang-native-script', () => {
  test('a Japanese pass with a name in Japanese script searches it beside the Latin name', () => {
    const s = createSubject({ name: 'Masayoshi Son', company: 'SoftBank', otherNames: ['孫正義'] });
    s.country = 'Japan';
    const web = webTemplates({ kind: 'subject', value: s.name }, s).find((t) => t.template === 'q.adverse-ja');
    expect(web.params.query).toMatch(/^\("孫正義" OR "Masayoshi Son"\) \(訴訟/);
    expect(web.params.latinOnly).toBeUndefined();
    const news = newsTemplates({ kind: 'subject', value: s.name }, s).find((t) => t.template === 'n.adverse-ja');
    expect(news.params.query).toMatch(/^\("孫正義" OR "Masayoshi Son"\)/);
  });

  test('a name learned later in that script is used too', () => {
    const s = createSubject({ name: 'Masayoshi Son', company: 'SoftBank' });
    s.country = 'Japan';
    addNameAlias(s, { alias: '孫正義', origin: 'wikidata' });
    expect(webTemplates({ kind: 'subject', value: s.name }, s).find((t) => t.template === 'q.adverse-ja').params.query).toMatch(/孫正義/);
  });

  test('no name in the local script: the pass runs, but the local press is reported as not really searched', async () => {
    const s = createSubject({ name: 'Masayoshi Son', company: 'SoftBank' });
    s.country = 'Japan';
    const task = planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.adverse-ja');
    expect(task.params.latinOnly).toBe(true);
    const out = await webSearchConnector.run(task, ctxFor(s));
    expect(out.partial.join(' ')).toMatch(/Japanese-language press/);
    expect(out.noLearn).toBe(true);
    const news = await newsArchiveConnector.run(planned(newsArchiveConnector, { kind: 'subject', value: s.name }, s, 'n.adverse-ja'), ctxFor(s));
    expect(news.partial.join(' ')).toMatch(/Latin letters/);
  });

  test('a Latin-script language pass is not marked', () => {
    const s = createSubject({ name: 'François Dupont', company: 'Exemple SAS' });
    expect(webTemplates({ kind: 'subject', value: s.name }, s).find((t) => t.template === 'q.adverse-fr').params.latinOnly).toBeUndefined();
  });

  test('Taiwan and Hong Kong get Traditional characters and their own edition', () => {
    const s = createSubject({ name: 'Jensen Huang', company: 'Example', otherNames: ['黃仁勳'] });
    s.country = 'Taiwan';
    expect(languageHints(s)).toEqual(['zt']);
    expect(REGION.zt.gnews).toMatch(/zh-TW/);
    expect(webTemplates({ kind: 'subject', value: s.name }, s).find((t) => t.template === 'q.adverse-zt').params.query).toMatch(/訴訟 OR 欺詐/);
  });
});

describe('web-needgeneral-never-waits: the check\'s remaining wait is passed on', () => {
  test('ctx.waitLeftMs becomes maxWaitMs', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const spent = {};
    const spend = (key, n = 1, max = Infinity) => { if ((spent[key] || 0) + n > max) return false; spent[key] = (spent[key] || 0) + n; return true; };
    await webSearchConnector.run(planned(webSearchConnector, { kind: 'subject', value: s.name }, s, 'q.lawsuit'), ctxFor(s, { spend, waitLeftMs: () => 3 * 60 * 1000 }));
    expect(keylessSearch.mock.calls[0][1]).toMatchObject({ needGeneral: true, maxWaitMs: 3 * 60 * 1000 });
  });
});
