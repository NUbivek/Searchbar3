/**
 * Round 3 (audit 2026-11-20), completeness critic findings on the identity matcher:
 * eval/founder/audit-2026-11-20/by-owner/identity2.json. One block per finding.
 */
const names = require('../../../src/server/founder/names');
const {
  createSubject, matchSubject, addAnchor, addNameAlias, findNameAliases, exportAnchors, restoreSubject, slugCandidates,
} = require('../../../src/server/founder/identity');
const { severityFromText, THREAD_KINDS, makeThread } = require('../../../src/server/founder/finding');

const grade = (name, company, text, opts) => matchSubject(createSubject({ name, company }), text, opts).level;

describe('critic-big-employer-typed-company: a very large employer alone does not confirm', () => {
  test.each([
    ['John Smith', 'Google', 'John Smith, a Google engineer in Ohio, was charged with wire fraud.'],
    ['Michael Johnson', 'Amazon', 'Michael Johnson, an Amazon warehouse manager, was arrested.'],
    ['Priya Raman', 'Deloitte', 'Priya Raman of Deloitte said the audit was late.'],
    ['Alan Turing', 'JPMorgan', 'Alan Turing, a JPMorgan analyst, left the bank.'],
    ['Alan Turing', 'Stanford University', 'Alan Turing, a Stanford University lecturer, spoke.'],
  ])('%s at %s is at most likely', (name, company, text) => {
    expect(grade(name, company, text)).toBe('likely');
  });

  test('a second fact (a school, another company of theirs, a handle) still confirms', () => {
    const s = createSubject({ name: 'John Smith', company: 'Google' });
    addAnchor(s, 'schools', 'Ohio State University', 'given');
    expect(matchSubject(s, 'John Smith, a Google engineer and Ohio State University graduate, spoke.').level).toBe('confirmed');
    const t = createSubject({ name: 'John Smith', company: 'Google' });
    addAnchor(t, 'companies', 'Zeptolabs', 'f1');
    expect(matchSubject(t, 'John Smith, who left Google to found Zeptolabs, raised a seed round.').level).toBe('confirmed');
  });

  test('a distinctive company still confirms on its own', () => {
    expect(grade('Trevor Milton', 'Nikola', 'Trevor Milton, founder of Nikola, was charged with fraud.')).toBe('confirmed');
  });

  test('"a Google engineer in Ohio" describes someone ordinary and local', () => {
    const text = 'John Smith, a Google engineer in Ohio, was charged.';
    expect(names.describedAsSomeoneElse(text, { start: 0, end: 10 })).toBe(true);
    expect(names.isLargeEmployer('Amazon')).toBe(true);
    expect(names.isLargeEmployer('HSBC')).toBe(true);
    expect(names.isLargeEmployer('Capital One')).toBe(true);
    expect(names.isLargeEmployer('Theranos')).toBe(false);
    // the older list keeps its meaning for the files that use it
    expect(names.isBroadOrganisation('HSBC')).toBe(false);
  });
});

describe('critic-foreign-legal-forms: legal forms outside the US are stripped', () => {
  test.each([
    ['Zepto Technologies Private Limited', 'zepto technologies', 'zepto'],
    ['Grab Holdings Pte Ltd', 'grab holdings', 'grab'],
    ['Booksy Sp. z o.o.', 'booksy', 'booksy'],
    ['Rappi S.A.S.', 'rappi', 'rappi'],
    ['Kavak S.A. de C.V.', 'kavak', 'kavak'],
    ['Northvolt AB', 'northvolt', 'northvolt'],
    ['Nubank Ltda', 'nubank', 'nubank'],
    ['Grab Sdn Bhd', 'grab', 'grab'],
    ['Infosys Pvt. Ltd.', 'infosys', 'infosys'],
    ['Kaspi JSC', 'kaspi', 'kaspi'],
    ['Yandex OOO', 'yandex', 'yandex'],
    ['Wolt Oy', 'wolt', 'wolt'],
    ['Pleo ApS', 'pleo', 'pleo'],
    ['Kahoot AS', 'kahoot', 'kahoot'],
    ['Prezi Kft.', 'prezi', 'prezi'],
    ['Satispay S.p.A.', 'satispay', 'satispay'],
    ['Musixmatch S.r.l.', 'musixmatch', 'musixmatch'],
    ['Mercari KK', 'mercari', 'mercari'],
    ['Celonis GmbH', 'celonis', 'celonis'],
    ['Alan SAS', 'alan', 'alan'],
  ])('%s', (typed, strict, key) => {
    expect(names.companyKeyStrict(typed)).toBe(strict);
    expect(names.companyKeys(typed)[0]).toBe(key);
    expect(names.companyMatchForms(typed).map((f) => f.form)).toContain(key);
  });

  test('the brand in prose matches the typed legal name', () => {
    expect(names.companyMention('Zepto Technologies Private Limited', 'Aadit Palicha, co-founder of Zepto, said').named).toBe(true);
    expect(grade('Aadit Palicha', 'Zepto Technologies Private Limited', 'Aadit Palicha, co-founder of Zepto, said the round closed.')).toBe('confirmed');
  });

  test('a legal-form word in the middle of a name is kept', () => {
    expect(names.companyKeyStrict('As Seen On Screen')).toBe('as seen on screen');
    expect(names.companyKeys('Mistral AI, Inc.')[0]).toBe('mistral');
  });
});

describe('critic-non-latin-and-mononyms: other scripts and one-word names', () => {
  test('company keys keep letters of other scripts', () => {
    expect(names.companyKeys('Яндекс')).toEqual(['яндекс']);
    expect(names.companyMatchForms('字节跳动').map((f) => f.form)).toEqual(['字节跳动']);
    expect(names.companyMention('Яндекс', 'Аркадий Волож основал Яндекс в 1997 году.').named).toBe(true);
    expect(names.companyMention('字节跳动', '张一鸣是字节跳动的创始人。').named).toBe(true);
  });

  test('a Cyrillic full name ties to a Cyrillic company', () => {
    expect(grade('Аркадий Волож', 'Яндекс', 'Аркадий Волож основал Яндекс в 1997 году.')).toBe('confirmed');
  });

  test('a CJK name written without a space is a full name', () => {
    const m = names.personNameMatcher('张一鸣');
    expect(m('张一鸣是字节跳动的创始人。')).toBe(true);
    expect(grade('张一鸣', '字节跳动', '张一鸣是字节跳动的创始人。')).toBe('confirmed');
  });

  test('a one-word name is allowed with a company and graded strictly', () => {
    const s = createSubject({ name: 'Budi', company: 'Kopi Kenangan' });
    expect(s.mononym).toBe(true);
    // the name alone is not enough
    expect(matchSubject(s, 'Budi was arrested in Jakarta.').level).toBe('none');
    // part of another person's longer name
    expect(matchSubject(s, 'Budi Santoso, founder of Kopi Kenangan, spoke.').level).toBe('none');
    // with the company: likely, not confirmed
    expect(matchSubject(s, 'Budi, founder of Kopi Kenangan, spoke.').level).toBe('likely');
  });

  test('slugs stay plain ASCII', () => {
    expect(slugCandidates('Аркадий Волож')).toEqual([]);
    expect(slugCandidates('Trevor Milton')).toContain('trevor-milton');
  });
});

describe('critic-no-former-names: other names of the person', () => {
  test('"alias" is a thread kind', () => {
    expect(THREAD_KINDS).toContain('alias');
    expect(makeThread('alias', 'Jane Smith', 'formerly known as')).toMatchObject({ kind: 'alias', value: 'Jane Smith' });
  });

  test('a typed former name is graded like the main name', () => {
    const s = createSubject({ name: 'Jane Doe', company: 'Acmetron', otherNames: ['Jane Smith'] });
    expect(s.otherNames).toEqual(['Jane Smith']);
    expect(s.searchNames).toEqual(['Jane Doe', 'Jane Smith']);
    expect(matchSubject(s, 'Jane Smith, founder of Acmetron, was sued.').level).toBe('confirmed');
    expect(matchSubject(s, 'Jane Smith was sued.').level).toBe('possible');
  });

  test('an alias found in a tied record is capped at likely', () => {
    const s = createSubject({ name: 'Jane Doe', company: 'Acmetron' });
    expect(addNameAlias(s, { alias: 'Jane Smith', origin: 'f1' })).toBe(true);
    expect(addNameAlias(s, { alias: 'Jane Doe', origin: 'f1' })).toBe(false);
    expect(addNameAlias(s, { alias: 'Smith', origin: 'f1' })).toBe(false);
    const r = matchSubject(s, 'Jane Smith, founder of Acmetron, was sued.');
    expect(r.level).toBe('likely');
    expect(r.basis).toContain('alias');
    expect(matchSubject(s, 'Jane Smith was sued.').level).toBe('possible');
  });

  test('aliases are read from "formerly known as", "née" and "born"', () => {
    const s = createSubject({ name: 'Jane Doe' });
    expect(findNameAliases(s, 'Jane Doe (née Smith) founded Acmetron.').map((a) => a.name)).toEqual(['Jane Smith']);
    expect(findNameAliases(s, 'Jane Doe, formerly known as Janet Rowe, founded it.').map((a) => a.name)).toEqual(['Janet Rowe']);
    expect(findNameAliases(s, 'Jane Doe, born Jane Ann Black, grew up in Ohio.').map((a) => a.name)).toEqual(['Jane Ann Black']);
    expect(findNameAliases(s, 'John Roe, formerly known as Janet Rowe, founded it.')).toEqual([]);
  });

  test('exportAnchors and restoreSubject carry typed and found names', () => {
    const s = createSubject({ name: 'Jane Doe', company: 'Acmetron', otherNames: ['Jane Smith'] });
    addNameAlias(s, { alias: 'Janet Rowe', origin: 'f2' });
    const saved = exportAnchors(s);
    expect(saved.otherNames).toEqual([
      { value: 'Jane Smith', origin: 'given', typed: true },
      { value: 'Janet Rowe', origin: 'f2', typed: false },
    ]);
    const r = restoreSubject({ name: 'Jane Doe', company: 'Acmetron', anchors: JSON.parse(JSON.stringify(saved)) });
    expect(r.otherNames).toEqual(['Jane Smith']);
    expect(matchSubject(r, 'Jane Smith, founder of Acmetron, was sued.').level).toBe('confirmed');
    expect(matchSubject(r, 'Janet Rowe, founder of Acmetron, was sued.').level).toBe('likely');
  });
});

describe('critic-outcome-blind-severity: severity reads the outcome and the part', () => {
  const s = createSubject({ name: 'Jane Doe', company: 'Acmetron' });
  test.each([
    ['Jury acquits Jane Doe of all fraud charges', 'acquitted'],
    ['Conviction of Jane Doe overturned on appeal', 'overturned'],
    ['Judge dismisses lawsuit against Jane Doe', 'dismissed'],
    ['Charges against Jane Doe dropped', 'dropped'],
    ['Appeals court vacates Jane Doe conviction', 'vacated'],
    ['Jane Doe wins lawsuit against former employer', 'won'],
  ])('%s', (text, outcome) => {
    expect(severityFromText(text, s)).toBe('low');
    expect(names.matterOutcome(text, { person: s.hasName }).outcome).toBe(outcome);
  });

  test('a pardon is not a high red flag', () => {
    expect(severityFromText('Jane Doe pardoned after her fraud conviction', s)).toBe('medium');
    expect(names.matterOutcome('Jane Doe pardoned after her fraud conviction', { person: s.hasName }).outcome).toBe('pardoned');
  });

  test.each([
    ['Jane Doe sues former employer for breach of contract', 'plaintiff'],
    ['Jane Doe testified as a witness in the fraud trial of John Roe', 'witness'],
    ['Jane Doe was a victim of the Ponzi scheme run by John Roe', 'victim'],
  ])('%s', (text, role) => {
    expect(severityFromText(text, s)).toBe('low');
    expect(names.matterOutcome(text, { person: s.hasName }).role).toBe(role);
  });

  test('a mixed verdict or the person as defendant stays high', () => {
    expect(severityFromText('Jane Doe acquitted on two counts but convicted of wire fraud', s)).toBe('high');
    expect(severityFromText('Jane Doe convicted of wire fraud', s)).toBe('high');
    expect(severityFromText('Judge denies Jane Doe motion to dismiss fraud charges; Jane Doe indicted', s)).toBe('high');
    expect(severityFromText('Investors sue Jane Doe over fraud', s)).toBe('medium');
    expect(names.matterOutcome('Investors sue Jane Doe over fraud', { person: s.hasName }).role).toBe('defendant');
  });
});
