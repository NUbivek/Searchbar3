/**
 * Round 4 fixes to identity.js.
 * (1) A sole-founder role anchor: a record dated on or after the founding that names the person in full and
 *     "<Company> founder" grades 'likely'. Without the full name it grades nothing.
 * (4) Event anchors (a confirmed conviction, sentence, pardon, indictment or charge) and encyclopedia anchors
 *     (organisations and people linked in the subject's own entry). Both need the full name and give 'likely'
 *     at most, never 'confirmed'.
 */
const { createSubject, matchSubject, addAnchor, addRoleAnchor, addEventAnchor, exportAnchors, restoreSubject } = require('../../../src/server/founder/identity');

describe('sole-founder role anchors', () => {
  const subject = () => {
    const s = createSubject({ name: 'Jane Roe' });
    expect(addRoleAnchor(s, { org: 'Orbitly', role: 'founder', from: '2014', origin: 'wd-1' })).toBe(true);
    return s;
  };

  test('full name plus "<Company> founder" on or after the founding grades likely', () => {
    const r = matchSubject(subject(), 'Orbitly founder Jane Roe pardoned by the president', { date: '2025-05-28' });
    expect(r.level).toBe('likely');
    expect(r.reasons[0]).toMatch(/Orbitly's founder/);
  });

  test('without the full name, before the founding, without a date, or as co-founder it does not count', () => {
    const s = subject();
    expect(matchSubject(s, 'Orbitly founder pardoned by the president', { date: '2025-05-28' }).level).toBe('none');
    expect(matchSubject(s, 'Orbitly founder Jane Roe speaks', { date: '2010-01-01' }).level).toBe('possible');
    expect(matchSubject(s, 'Orbitly founder Jane Roe speaks').level).toBe('possible');
    expect(matchSubject(s, 'Orbitly co-founder Jane Roe speaks', { date: '2020-01-01' }).level).toBe('possible');
    expect(matchSubject(s, 'Former Orbitly founder Jane Roe speaks', { date: '2020-01-01' }).level).toBe('possible');
  });

  test('a founder anchor does not clash with a CEO anchor from the same date, and survives restore', () => {
    const s = subject();
    expect(addRoleAnchor(s, { org: 'Orbitly', role: 'ceo', from: '2014', to: '2019' })).toBe(true);
    const back = restoreSubject({ name: 'Jane Roe', anchors: exportAnchors(s) });
    expect([...back.anchors.roles.values()].map((a) => a.role).sort()).toEqual(['ceo', 'founder']);
    expect(matchSubject(back, 'Orbitly founder Jane Roe speaks', { date: '2022-01-01' }).level).toBe('likely');
  });
});

describe('event anchors', () => {
  const subject = () => {
    const s = createSubject({ name: 'Jane Roe' });
    expect(addEventAnchor(s, { event: 'convicted', date: '2022-10-14', origin: 'rec-7' })).toBe(true);
    return s;
  };

  test('full name plus the event word, dated within weeks of the event, grades likely with a reason', () => {
    const r = matchSubject(subject(), 'Utah billionaire Jane Roe, who was convicted of fraud, plans an appeal', { date: '2022-11-02' });
    expect(r.level).toBe('likely');
    expect(r.reasons).toContain('names conviction reported in rec-7');
    // audit 2026-11-20: a report years later may be a namesake's conviction; without the same matter it stays possible
    expect(matchSubject(subject(), 'Pardon of Utah billionaire Jane Roe, who was convicted of fraud', { date: '2025-03-28' }).level).toBe('possible');
  });

  test('never without the full name, before the event, without a date, or for another event', () => {
    const s = subject();
    expect(matchSubject(s, 'Billionaire convicted of fraud', { date: '2025-03-28' }).level).toBe('none');
    expect(matchSubject(s, 'Jane Roe convicted of fraud', { date: '2019-01-01' }).level).toBe('possible');
    expect(matchSubject(s, 'Jane Roe convicted of fraud').level).toBe('possible');
    expect(matchSubject(s, 'Jane Roe sentenced to four years', { date: '2025-03-28' }).level).toBe('possible');
    expect(matchSubject(s, 'Jane Roe was electrically charged up', { date: '2025-03-28' }).level).toBe('possible');
  });

  test('an SEC complaint registers the charge family; unknown events and dates are refused', () => {
    const s = createSubject({ name: 'Jane Roe' });
    expect(addEventAnchor(s, { event: 'complaint', date: '2021-07-29', origin: 'sec-2' })).toBe(true);
    expect(addEventAnchor(s, { event: 'complaint', date: '2021-07-29', origin: 'sec-3' })).toBe(false);
    expect(addEventAnchor(s, { event: 'lawsuit', date: '2021-07-29' })).toBe(false);
    expect(addEventAnchor(s, { event: 'pardoned', date: 'soon' })).toBe(false);
    expect(matchSubject(s, 'SEC charges Jane Roe with securities fraud', { date: '2021-07-29' }).level).toBe('likely');
    const back = restoreSubject({ name: 'Jane Roe', anchors: exportAnchors(s) });
    expect(matchSubject(back, 'Jane Roe charged with fraud', { date: '2021-08-01' }).level).toBe('likely');
  });
});

describe('encyclopedia anchors', () => {
  const subject = () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Orbitly' });
    expect(addAnchor(s, 'companies', 'SoftBank', 'encyclopedia')).toBe(true);
    expect(addAnchor(s, 'people', 'John Smith', 'encyclopedia:wp-3')).toBe(true);
    return s;
  };

  test('full name plus a linked organisation or person grades likely, never confirmed', () => {
    const s = subject();
    expect(matchSubject(s, 'Jane Roe, SoftBank Near Settlement').level).toBe('likely');
    expect(matchSubject(s, 'John Smith backs Jane Roe again').level).toBe('likely');
    expect(matchSubject(s, 'Jane Roe of Orbitly and SoftBank settle').level).toBe('confirmed');
  });

  test('a linked organisation is not the subject\'s company and gives nothing without the name', () => {
    const s = subject();
    expect([...s.anchors.companies.values()].map((a) => a.value)).toEqual(['Orbitly']);
    expect(matchSubject(s, 'SoftBank reports a loss').level).toBe('none');
    expect(addAnchor(s, 'schools', 'Harvard', 'encyclopedia')).toBe(false);
    expect(addAnchor(s, 'companies', 'SoftBank', 'encyclopedia')).toBe(false);
  });

  test('a later stronger source still adds it as a company, and encyclopedia anchors survive restore', () => {
    const s = subject();
    expect(addAnchor(s, 'companies', 'SoftBank', 'f-9')).toBe(true);
    expect(matchSubject(s, 'Jane Roe, SoftBank Near Settlement').level).toBe('confirmed');
    const back = restoreSubject({ name: 'Jane Roe', anchors: exportAnchors(subject()) });
    expect(back.anchors.companies.size).toBe(1);
    expect(matchSubject(back, 'Jane Roe, SoftBank Near Settlement').level).toBe('likely');
    expect(matchSubject(back, 'John Smith backs Jane Roe again').level).toBe('likely');
  });
});
