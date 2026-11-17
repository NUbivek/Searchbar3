/**
 * Round 2 fix to identity.js: a company key glued to other words in an
 * @handle or a domain ("@acmemotor", "acmemotor.com") names the company when
 * the key has 5 or more characters.
 */
const { createSubject, matchSubject } = require('../../../src/server/founder/identity');

describe('company key as the start of a handle or domain', () => {
  test('an @handle starting with the key confirms', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Zentrix' });
    expect(matchSubject(s, 'Jane Roe, founder of @zentrixmotor, posted an update').level).toBe('confirmed');
    expect(matchSubject(s, 'Jane Roe (@ZentrixMotor) stepped down').level).toBe('confirmed');
  });

  test('a domain label starting with the key confirms', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Zentrix Motor Company' });
    expect(matchSubject(s, 'Jane Roe | https://www.zentrixmotor.com/team').level).toBe('confirmed');
    expect(matchSubject(s, 'Contact Jane Roe at press@zentrixmotors.co.uk').level).toBe('confirmed');
  });

  test('short keys, mid-word keys and sentence breaks do not count', () => {
    const flow = createSubject({ name: 'Jane Roe', company: 'Flow' });
    expect(matchSubject(flow, 'Jane Roe (@flowstate) shared a recipe').level).toBe('possible');
    expect(matchSubject(flow, 'Jane Roe wrote at flowstate.com').level).toBe('possible');
    const z = createSubject({ name: 'Jane Roe', company: 'Zentrix' });
    expect(matchSubject(z, 'Jane Roe (@thezentrixfan) posted').level).toBe('possible');
    expect(matchSubject(z, 'Jane Roe wrote at myzentrix.com').level).toBe('possible');
    expect(matchSubject(z, 'Jane Roe met zentrixy.Then she left').level).toBe('possible');
  });

});
