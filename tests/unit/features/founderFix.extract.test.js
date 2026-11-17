/**
 * Fixes in extract.js: ordinary jobs are not public roles, a handle must
 * hold a full name slug, and a name-only search result never gives trusted
 * profile threads.
 */
const { createSubject } = require('../../../src/server/founder/identity');
const { relativesFromText, publicRelativeIn, handleFitsSubject, threadsFromResult } = require('../../../src/server/founder/extract');

describe('public roles of relatives', () => {
  const holmes = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });

  test('ordinary jobs and verbs are not public roles', () => {
    expect(relativesFromText(holmes, 'Her husband, John Roe, a software developer, helped Elizabeth Holmes.')).toEqual([]);
    expect(relativesFromText(holmes, 'Elizabeth Holmes grew up close to her mother, Mary Doe, a history professor.')).toEqual([]);
    expect(relativesFromText(holmes, 'Elizabeth Holmes is the daughter of Peter Doe, who runs a small bakery.')).toEqual([]);
    expect(relativesFromText(holmes, 'Elizabeth Holmes lives with her partner Sam Lee, a director of photography.')).toEqual([]);
    expect(publicRelativeIn(holmes, 'Elizabeth Holmes and her husband John Roe, a software developer, moved.', 'John Roe')).toBeNull();
  });

  test('real public roles still count, including the qualified forms', () => {
    const chair = relativesFromText(holmes, 'Elizabeth Holmes was helped by her father, John Roe, chairman of Roe Holdings.');
    expect(chair.map((r) => [r.name, r.relation])).toEqual([['John Roe', 'father']]);
    expect(chair[0].role).toMatch(/chairman/i);
    const runs = relativesFromText(holmes, 'Elizabeth Holmes is the daughter of Peter Doe, who runs Doe Capital.');
    expect(runs.map((r) => r.name)).toEqual(['Peter Doe']);
    const director = relativesFromText(holmes, 'Elizabeth Holmes and her brother, Sam Lee, director of Lee Ventures, spoke.');
    expect(director.map((r) => r.name)).toEqual(['Sam Lee']);
    expect(relativesFromText(holmes, 'Elizabeth Holmes is the daughter of property developer Peter Doe.').map((r) => r.name)).toEqual(['Peter Doe']);
  });
});

describe('handles and profile threads', () => {
  test('a bare first name or surname is not a fitting handle', () => {
    const dorsey = createSubject({ name: 'Jack Dorsey', company: 'Block' });
    const collison = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    expect(handleFitsSubject(dorsey, 'jack')).toBe(false);
    expect(handleFitsSubject(collison, 'collison')).toBe(false);
    expect(handleFitsSubject(dorsey, 'jackdorsey')).toBe(true);
    expect(handleFitsSubject(dorsey, 'jdorsey')).toBe(true);
  });

  test('a result that only repeats the name gives untrusted profile threads', () => {
    const smith = createSubject({ name: 'John Smith', company: 'Zeta' });
    const threads = threadsFromResult(smith, { title: 'John Smith (johnsmith) · GitHub', snippet: 'Plumber in Ohio.', url: 'https://github.com/johnsmith' }, { trusted: false });
    const profile = threads.filter((t) => t.kind === 'url' || t.kind === 'handle');
    expect(profile.map((t) => t.kind).sort()).toEqual(['handle', 'url']);
    expect(profile.every((t) => t.trusted === false)).toBe(true);
    const dorsey = createSubject({ name: 'Jack Dorsey', company: 'Block' });
    expect(threadsFromResult(dorsey, { title: 'Jack Dorsey (@jack) / X', snippet: 'plumber in Ohio', url: 'https://x.com/jack' }, { trusted: false })
      .filter((t) => t.kind === 'url' || t.kind === 'handle')).toEqual([]);
  });

  test('a trusted result still gives trusted profile threads', () => {
    const smith = createSubject({ name: 'John Smith', company: 'Zeta' });
    const threads = threadsFromResult(smith, { title: 'John Smith (johnsmith) · GitHub', snippet: 'Founder of Zeta.', url: 'https://github.com/johnsmith' }, { trusted: true });
    expect(threads.filter((t) => t.kind === 'url' || t.kind === 'handle').every((t) => t.trusted === true)).toBe(true);
  });
});
