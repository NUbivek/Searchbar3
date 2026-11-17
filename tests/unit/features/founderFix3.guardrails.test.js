/**
 * Round-3 fixes to the privacy guardrails (guardrails.js): substance use is a health matter, so a
 * non-official record that talks about it is dropped, and an official record keeps only the other sentences.
 */
const { isSensitive, sanitizeFinding } = require('../../../src/server/founder/guardrails');

const rec = (extra = {}) => ({ source: 'web-search', category: 'press', title: 'Jane Doe steps down as Acme CEO', quote: '', url: 'https://example.com/a', match: 'confirmed', ...extra });

describe('substance use', () => {
  test.each([
    'Reports described Jane Doe’s drug use on company flights.',
    'Jane Doe has spoken about substance abuse.',
    'Jane Doe was said to have used cocaine at parties.',
    'Colleagues described smoking marijuana in the office.',
    'Jane Doe’s cocaine habit was widely reported.',
    'Jane Doe has written about her alcoholism.',
    'John Doe, a recovering alcoholic, returned to the board.',
    'Jane Doe admitted to a drinking problem.',
    'Investors worried about heavy drinking at offsites.',
  ])('drops %s from a non-official source', (text) => {
    expect(isSensitive(text)).toBe(true);
    expect(sanitizeFinding(rec({ quote: text }))).toBeNull();
  });

  test('an official record keeps only the sentences that are not about substance use', () => {
    const out = sanitizeFinding(rec({
      source: 'court-dockets', category: 'litigation', title: 'Doe v. Acme',
      quote: 'The complaint alleges breach of fiduciary duty. It describes drug use by the defendant.',
    }));
    expect(out.quote).toBe('The complaint alleges breach of fiduciary duty.');
  });

  test('business and criminal-trade wording is kept', () => {
    expect(isSensitive('Jane Doe founded an alcoholic beverages company.')).toBe(false);
    expect(isSensitive('Acme sells alcoholic drinks in 40 countries.')).toBe(false);
    expect(isSensitive('John Doe was charged with cocaine trafficking.')).toBe(false);
    expect(isSensitive('Jane Doe stepped down as CEO after investor pressure.')).toBe(false);
  });
});
