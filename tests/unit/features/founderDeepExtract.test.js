/**
 * Reading records for threads: companies and schools, associates, relatives
 * in a public role (and only those), profile pages and handles.
 */
const { createSubject } = require('../../../src/server/founder/identity');
const { relativesFromText, associatesFromText, profileFromUrl, handleFitsSubject, threadsFromResult } = require('../../../src/server/founder/extract');

const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });

describe('relatives', () => {
  test('a relative is kept only when the sentence gives them a public role', () => {
    const text = 'Jane Roe grew up in Ohio. Her father, Martin Roe, is the chairman of Roe Steel. Her brother Tom Roe likes sailing. She is the daughter of billionaire investor Martin Roe. Jane Roe is married to David Stone, a partner at Stone Capital.';
    const found = relativesFromText(subject, text);
    expect(found.map((r) => [r.name, r.relation])).toEqual([['Martin Roe', 'father'], ['David Stone', 'spouse']]);
    expect(found[0].role).toMatch(/chairman/i);
    // "Tom Roe likes sailing": family only, no public role, so not reported
    expect(found.some((r) => r.name === 'Tom Roe')).toBe(false);
  });

  test('descent phrases name the parent; children and health are never reported', () => {
    expect(relativesFromText(subject, 'Jane Roe, the son of real-estate developer Harold Roe, founded Acme.').map((r) => [r.name, r.relation])).toEqual([['Harold Roe', 'parent']]);
    expect(relativesFromText(subject, 'Jane Roe and her husband Mark Lee, a CEO, have a 6-year-old son.')).toEqual([]);
    expect(relativesFromText(subject, 'Her mother Ann Roe, a director at the bank, was diagnosed with cancer.')).toEqual([]);
    // the subject is never their own relative, and organisations are not people
    expect(relativesFromText(subject, 'Her sister Jane Roe is CEO. Her father Roe Capital Partners is a fund.')).toEqual([]);
  });
});

describe('associates', () => {
  test('co-founders, founding partners and co-parties named with the subject', () => {
    expect(associatesFromText(subject, 'Jane Roe founded Acme Robotics with Sam Patel and Lena Müller in 2019.').map((a) => a.name)).toEqual(['Sam Patel', 'Lena Müller']);
    expect(associatesFromText(subject, 'Acme was started by Jane Roe and co-founder Omar Haddad.').map((a) => a.name)).toEqual(['Omar Haddad']);
    expect(associatesFromText(subject, 'SEC v. Acme Robotics, Jane Roe and Peter Vance').map((a) => a.name)).toEqual(['Peter Vance']);
    // a sentence that does not name the subject offers nothing
    expect(associatesFromText(subject, 'Sam Patel and Lena Müller, co-founders of Beta.')).toEqual([]);
  });
});

describe('profiles and handles', () => {
  test('profile pages are recognised; site pages are not', () => {
    expect(profileFromUrl('https://www.linkedin.com/in/jane-roe-1a2b3c/?trk=x')).toEqual({ platform: 'linkedin', handle: 'jane-roe-1a2b3c', url: 'https://linkedin.com/in/jane-roe-1a2b3c' });
    expect(profileFromUrl('https://uk.linkedin.com/pub/jane-roe/1/2a/3b')).toMatchObject({ platform: 'linkedin', handle: 'jane-roe' });
    expect(profileFromUrl('https://github.com/janeroe')).toMatchObject({ platform: 'github', handle: 'janeroe' });
    expect(profileFromUrl('https://x.com/jroe')).toMatchObject({ platform: 'x', handle: 'jroe' });
    expect(profileFromUrl('https://github.com/pricing')).toBeNull();
    expect(profileFromUrl('https://github.com/janeroe/some-repo')).toBeNull();
    expect(profileFromUrl('https://example.com/in/jane-roe')).toBeNull();
  });
  test('a handle must fit the name to be followed', () => {
    expect(handleFitsSubject(subject, 'jane-roe-1a2b3c')).toBe(true);
    expect(handleFitsSubject(subject, 'jroe')).toBe(true);
    expect(handleFitsSubject(subject, 'bob-smith')).toBe(false);
  });
});

describe('threads from a search result', () => {
  test('companies, schools, associates, relatives and the profile page, all marked with whether the record is trusted', () => {
    const threads = threadsFromResult(subject, {
      title: 'Jane Roe - CEO - Acme Robotics | LinkedIn',
      snippet: 'Jane Roe previously worked at Initech and graduated from Stanford University. She founded Acme Robotics with Sam Patel. Her father, Martin Roe, is chairman of Roe Steel.',
      url: 'https://www.linkedin.com/in/jane-roe',
    }, { trusted: true });
    const of = (kind) => threads.filter((t) => t.kind === kind).map((t) => t.value);
    expect(of('company')).toEqual(expect.arrayContaining(['Initech']));
    expect(of('school')).toEqual(['Stanford University']);
    expect(of('associate')).toEqual(['Sam Patel']);
    expect(threads.find((t) => t.kind === 'relative')).toMatchObject({ value: 'Martin Roe', relation: 'father', trusted: true });
    expect(of('url')).toEqual(['https://linkedin.com/in/jane-roe']);
    expect(threads.every((t) => t.trusted)).toBe(true);
    const untrusted = threadsFromResult(subject, { title: 'Jane Roe, dentist', snippet: 'Jane Roe previously worked at Smile Dental.', url: 'https://example.com/x' }, { trusted: false });
    expect(untrusted.every((t) => t.trusted === false)).toBe(true);
  });
});
