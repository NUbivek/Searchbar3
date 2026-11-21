/**
 * @jest-environment node
 *
 * Round 4 (review 2026-11-21), asked for by the profile engineer (pages.js): a career or education quote keeps the
 * page's sentence order, and a "She/He" sentence goes in the same record as the sentence naming the person, never
 * alone (profile.js trusts such a sentence only when its record names the person).
 */
const { createSubject } = require('../../../src/server/founder/identity');
const { readPage } = require('../../../src/server/founder/sources/pages');

const page = (body, title = 'Jane Roe - Biography') => `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

describe('page order and pronoun follow-ons', () => {
  const subject = createSubject({ name: 'Jane Roe', company: 'Zetafold' });
  const html = page(`<p>Jane Roe is the chief executive officer and co-founder of Zetafold, a payments company in New York.</p>
    <p>She studied economics at Stanford University and earned an MBA from Harvard Business School.</p>
    <p>Before Zetafold, Jane Roe worked at Goldman Sachs for six years as an analyst in its technology group.</p>`);
  const out = readPage(subject, { url: 'https://janeroe.test/about', html });
  const byKind = (k) => out.findings.find((f) => f.category === k && f.data?.kind === 'bio');

  test('the career quote keeps the page order', () => {
    const q = byKind('career').quote;
    expect(q.indexOf('chief executive officer')).toBeGreaterThanOrEqual(0);
    expect(q.indexOf('chief executive officer')).toBeLessThan(q.indexOf('Goldman Sachs'));
  });
  test('a pronoun sentence never stands alone: its record names the person first', () => {
    const edu = byKind('education');
    expect(edu).toBeTruthy();
    const q = edu.quote;
    expect(q).toMatch(/Stanford/);
    expect(q.indexOf('Jane Roe')).toBeGreaterThanOrEqual(0);
    expect(q.indexOf('Jane Roe')).toBeLessThan(q.indexOf('She studied'));
  });
});
