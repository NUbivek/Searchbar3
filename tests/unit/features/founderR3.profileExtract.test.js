/**
 * @jest-environment node
 *
 * Round 3, profile owner: extract.js. Relatives and co-founders belong to the person only when the sentence ties
 * them to the person and not to someone else named in between; every name in "founded by A, B and C" is read;
 * an article on someone's newsletter is not their profile; another person's parenthetical role is not theirs.
 */
const { createSubject } = require('../../../src/server/founder/identity');
const { relativesFromText, publicRelativeIn, associatesFromText, profileFromUrl, threadsFromResult } = require('../../../src/server/founder/extract');

const milton = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });

describe('a relative\'s role is read only in apposition to the relative (privacy-relative-role-misread)', () => {
  test.each([
    'Trevor Milton was there with his wife Carrie Milton, who told reporters the founder was innocent.',
    'Trevor Milton came with his brother Jake Milton, a customer service representative.',
    'Trevor Milton came; his sister Jane Milton attended; Nikola chairman Steve Girsky spoke.',
    'Trevor Milton said his father Bob Milton worked as a janitor at a company run by a billionaire.',
  ])('%s', (text) => {
    expect(relativesFromText(milton, text)).toEqual([]);
  });
  test('a role right beside the relative is kept', () => {
    const got = relativesFromText(milton, 'Trevor Milton thanked his father, John Milton, chairman of Acme Holdings, for the loan.');
    expect(got.map((r) => [r.name, r.relation, r.role])).toEqual([['John Milton', 'father', 'chairman']]);
    const rep = relativesFromText(milton, 'Trevor Milton spoke after his brother Lance Milton, a state representative, introduced him.');
    expect(rep.map((r) => r.role)).toEqual(['state representative']);
  });
});

describe('his/her refers to the nearest person (report-relative-wrong-referent)', () => {
  test('a relative of someone named in between is not theirs', () => {
    expect(relativesFromText(milton, 'Trevor Milton sued Ford CEO Jim Farley and his brother John Farley, chairman of Acme Holdings.')).toEqual([]);
  });
  test('"<Org> founder X and co-founder Y" are another company\'s founders', () => {
    const got = associatesFromText(milton, 'Ford founder Henry Ford and co-founder Jim Smith spoke with Trevor Milton.');
    expect(got.map((a) => a.name)).not.toContain('Jim Smith');
  });
});

describe('publicRelativeIn needs the kin word bound to the name (accuracy-publicrelativein-loose-kin)', () => {
  test('a business partner is not family', () => {
    expect(publicRelativeIn(milton, "Jane Roe, a partner at Sequoia, invested in Trevor Milton's company.", 'Jane Roe')).toBeNull();
    expect(publicRelativeIn(milton, 'Trevor Milton and his family met Jane Roe, chairman of Acme Holdings.', 'Jane Roe')).toBeNull();
  });
  test('a stated kinship with a role is kept', () => {
    const got = publicRelativeIn(milton, "Trevor Milton's father, John Milton, chairman of Acme Holdings, backed the company.", 'John Milton');
    expect(got).toEqual(expect.objectContaining({ relation: 'father', role: 'chairman' }));
  });
});

describe('every name in "founded by A, B and C"', () => {
  test('Ramp\'s three founders', () => {
    const got = associatesFromText(eric, 'Ramp was founded in March 2019 by Eric Glyman, Karim Atiyeh, and Gene Lee.');
    expect(got.map((a) => a.name).sort()).toEqual(['Gene Lee', 'Karim Atiyeh']);
  });
  test('not when the person is not among them', () => {
    expect(associatesFromText(eric, 'Eric Glyman praised Acme, which was founded by Jane Doe and Bob Smith.')).toEqual([]);
  });
});

describe('a newsletter article is not the person\'s profile (profile-interviewer-substack)', () => {
  test('Substack and Medium: only the profile root', () => {
    expect(profileFromUrl('https://notanotherceo.substack.com/p/shensi-ding-merge-74')).toBeNull();
    expect(profileFromUrl('https://shensiding.substack.com/')).toEqual(expect.objectContaining({ platform: 'substack', handle: 'shensiding' }));
    expect(profileFromUrl('https://medium.com/@someone/a-post-about-shensi-ding-1234')).toBeNull();
    expect(profileFromUrl('https://medium.com/@shensiding')).toEqual(expect.objectContaining({ platform: 'medium', handle: 'shensiding' }));
  });
});

describe('another person\'s parenthetical role is not theirs (grader: Village Global)', () => {
  test('"joined Erik Torenberg (Co-founder of Village Global ...)"', () => {
    const threads = threadsFromResult(eric, { title: 'Eric Glyman on the podcast', snippet: 'Eric Glyman recently joined Erik Torenberg (Co-founder of Village Global, On Deck, and Turpentine) to talk about Ramp.', url: 'https://podcast.test/ep1' }, { trusted: true });
    const companies = threads.filter((t) => t.kind === 'company').map((t) => t.value);
    expect(companies).not.toContain('Village Global');
    expect(companies).not.toContain('Erik Torenberg');
  });
});
