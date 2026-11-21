/**
 * Round 4 review fixes for the shared name and company matcher (names.js) and the grading built on it (identity.js).
 * One table of realistic sentences, half that must tie the record to the person and half that must not, plus the
 * focused cases behind each finding.
 */
import {
  personNameMatcher, companyMention, companyMatchForms, parsePersonName, placeOrOrgName,
} from '../../../src/server/founder/names';
import {
  createSubject, matchSubject, addAnchor, addCompanyAlias, addNameAlias, findNameAliases, isWeakOrigin,
} from '../../../src/server/founder/identity';

const grade = (name, company, text) => matchSubject(createSubject({ name, company }), text).level;

// [person, company, text, expected level]
const MUST_TIE = [
  // name particles (names-lowercase-particles)
  ['Daan van der Berg', 'Zeta Labs', 'Daan van der Berg, founder of Zeta Labs, was charged', 'confirmed'],
  ['Ursula von der Leyen', 'Zeta Labs', 'Ursula von der Leyen, CEO of Zeta Labs, said the deal was done.', 'confirmed'],
  ['Carlos de la Cruz', 'Nimbus Robotics', 'Carlos de la Cruz founded Nimbus Robotics in 2019.', 'confirmed'],
  ['Mohammed bin Salman', 'Zeta Labs', 'Mohammed bin Salman, chairman of Zeta Labs, approved the plan.', 'confirmed'],
  ['Ahmed al-Rashid', 'Zeta Labs', 'Ahmed al-Rashid, co-founder of Zeta Labs, said', 'confirmed'],
  ['Vincent Van Dijk', 'Zeta Labs', 'Vincent van Dijk, the Zeta Labs founder, said', 'confirmed'],
  // shared surname lists (names-shared-surname-list)
  ['Patrick Collison', 'Stripe', 'Patrick and John Collison founded Stripe in 2010', 'likely'],
  ['Patrick Collison', 'Stripe', 'Stripe, founded by brothers Patrick and John Collison, is valued at $50 billion', 'likely'],
  ['Adam Neumann', 'WeWork', 'WeWork co-founders Adam and Rebekah Neumann', 'likely'],
  // a determiner before a role, and co-CEO (names-determiner-before-role)
  ['Eric Glyman', 'Ramp', 'Eric Glyman: How the Ramp Founder Is Reinventing Business Finance', 'confirmed'],
  ['Eric Glyman', 'Ramp', 'Eric Glyman, the Ramp co-founder, said', 'confirmed'],
  ['Eric Glyman', 'Ramp', 'Ramp co-CEO Eric Glyman: spend $100 and see', 'confirmed'],
  // a ticker after the company (names-ticker-after-company)
  ['Trevor Milton', 'Nikola', 'Nikola (NKLA) founder Trevor Milton indicted on three counts of fraud', 'confirmed'],
  ['Jack Dorsey', 'Block', 'Block (NYSE: SQ) CEO Jack Dorsey said the company will cut staff', 'confirmed'],
  // ex- (names-ex-prefix)
  ['Trevor Milton', 'Nikola', 'Ex-Nikola CEO Trevor Milton ready for takeoff with SyberJet', 'confirmed'],
  ['John Smith', 'Stripe', 'ex-Stripe engineer John Smith launched a payments app', 'confirmed'],
  // registered names with describing words (names-descriptor-legal-names)
  ['Brian Armstrong', 'Coinbase Global, Inc.', 'Coinbase CEO Brian Armstrong was sued', 'confirmed'],
  ['Vlad Tenev', 'Robinhood Markets, Inc.', 'Robinhood CEO Vlad Tenev testified before Congress', 'confirmed'],
  ['Sam Bankman-Fried', 'FTX Trading Ltd.', 'FTX founder Sam Bankman-Fried was convicted', 'confirmed'],
  ['Trevor Milton', 'Nikola Motor Company', 'Nikola founder Trevor Milton was indicted', 'confirmed'],
  ['Robert Scaringe', 'Rivian Automotive', 'Rivian CEO Robert Scaringe said deliveries would rise', 'confirmed'],
  ['Stéphane Bancel', 'Moderna Therapeutics', 'Moderna CEO Stéphane Bancel said', 'confirmed'],
  ['Eric Glyman', 'Ramp Business Corporation', 'Ramp CEO Eric Glyman said the company raised $150 million', 'confirmed'],
  // a quoted nickname, and double surnames (names-quoted-nickname-hyphen-surname)
  ['William McFarland', 'Fyre Media', 'William "Billy" McFarland, founder of Fyre Media, was sentenced', 'confirmed'],
  ['William McFarland', 'Fyre Media', 'William “Billy” McFarland, founder of Fyre Media, was sentenced', 'confirmed'],
  ['Maria Garcia Lopez', 'Zeta Labs', 'Maria Garcia-Lopez, CEO of Zeta Labs, said', 'confirmed'],
  ['Maria Garcia-Lopez', 'Zeta Labs', 'Maria Garcia Lopez, CEO of Zeta Labs, said', 'confirmed'],
  ['Sam Bankman-Fried', 'FTX', 'Sam Bankman Fried, founder of FTX, was convicted', 'confirmed'],
  // the company used as a modifier before the name (names-missing-titles-other-given)
  ['Elizabeth Holmes', 'Theranos', 'a lawsuit against Theranos Elizabeth Holmes was filed', 'confirmed'],
  // the subject's own affiliation keeps working
  ['Eric Glyman', 'Ramp', 'Eric Glyman, CEO of Ramp, said', 'confirmed'],
  ['Eric Glyman', 'Theranos', 'Eric Glyman, VP of Sales at Theranos, said', 'confirmed'],
  ['Eric Glyman', 'Theranos', 'Panel: Eric Glyman (Theranos), Jane Doe (Omega Corp)', 'confirmed'],
  ['Eric Glyman', 'Theranos', 'Eric Glyman (Harvard), founder of Theranos, spoke', 'confirmed'],
  ['Patrick Collison', 'Stripe', 'Patrick Collison | Stripe | Chief Executive', 'confirmed'],
  ['Eric Glyman', 'Theranos', 'Jane Doe | Omega Corp | Eric Glyman | Theranos', 'confirmed'],
  ['Eric Glyman', 'Theranos', 'Eric Glyman, Theranos, and Jane Doe, Omega Corp, spoke', 'confirmed'],
  // a place is not another person in a list, nor an employer in a dateline
  ['Eric Glyman', 'Theranos', 'In Palo Alto, Theranos, the blood-testing startup, hired Eric Glyman', 'confirmed'],
  ['Eric Glyman', 'Theranos', 'Eric Glyman, Brooklyn, said Theranos hired him in 2015', 'confirmed'],
  ['Sam Bankman-Fried', 'Jane Street', 'Sam Bankman-Fried | Samuel Benjamin Bankman-Fried | JANE STREET CAPITAL, LLC', 'confirmed'],
];

const MUST_NOT_TIE = [
  // a company that belongs to someone else in the sentence (names-inner-span-defeats-other-holder)
  ['Eric Glyman', 'Zeta Labs', 'Zeta Labs CEO Jane Doe met Eric Glyman', 'possible'],
  ['Eric Glyman', 'Acme Robotics', 'Acme Robotics CEO Jane Doe met Eric Glyman', 'possible'],
  ['Eric Glyman', 'Nikola Corporation', 'Nikola Corporation CEO Jane Doe met Eric Glyman', 'possible'],
  ['Eric Glyman', 'Theranos', 'Theranos Inc CEO Jane Doe met Eric Glyman', 'possible'],
  ['Eric Glyman', 'Theranos', 'Theranos, Inc. CEO Jane Doe met Eric Glyman', 'possible'],
  // a role in capitals (names-affiliation-capital-role)
  ['Eric Glyman', 'Theranos', 'Eric Glyman, CEO of Omega Corp, said Theranos is a competitor', 'possible'],
  ['Eric Glyman', 'Theranos', 'Eric Glyman, the CEO of Omega Corp, said Theranos is a competitor', 'possible'],
  ['Eric Glyman', 'Theranos', 'Eric Glyman, Co-Founder of Omega Corp, said Theranos is a competitor', 'possible'],
  ['Eric Glyman', 'Theranos', 'Eric Glyman, VP of Sales at Omega Corp, said Theranos is a competitor', 'possible'],
  ['Eric Glyman', 'Theranos', 'Eric Glyman, Co-Founder & CEO of Omega Corp, criticised Theranos', 'possible'],
  // lists, panels and rows (names-lists-pin-neighbour-company)
  ['Eric Glyman', 'Theranos', 'Speakers: Jane Doe, Theranos, and Eric Glyman, Omega Corp', 'possible'],
  ['Eric Glyman', 'Theranos', 'Panel: Jane Doe (Theranos), Eric Glyman (Omega Corp)', 'possible'],
  ['Eric Glyman', 'Theranos', 'Jane Doe | Theranos | Eric Glyman | Omega Corp', 'possible'],
  ['Eric Glyman', 'Theranos', 'Jane Doe; Theranos; Eric Glyman; Omega Corp', 'possible'],
  ['Eric Glyman', 'Zeta Labs', 'Speakers: Jane Doe, Zeta Labs, and Eric Glyman, Omega Corp', 'possible'],
  ['Eric Glyman', 'Zeta Labs', 'Panel: Jane Doe (Zeta Labs), Eric Glyman (Omega Corp)', 'possible'],
  ['Eric Glyman', 'Zeta Labs', 'Jane Doe | Zeta Labs | Eric Glyman | Omega Corp', 'possible'],
  ['Eric Glyman', 'Theranos', 'Panel: Eric Glyman (Omega Corp), Jane Doe (Theranos)', 'possible'],
  ['Eric Glyman', 'Theranos', 'Eric Glyman | Omega Corp | Jane Doe | Theranos', 'possible'],
  // another holder after a role the matcher now reads
  ['Eric Glyman', 'Ramp', 'Ramp co-CEO Jane Doe met Eric Glyman', 'possible'],
  ['Eric Glyman', 'Ramp', 'the Ramp founder Jane Doe met Eric Glyman', 'possible'],
  ['Trevor Milton', 'Nikola', 'Nikola (NKLA) founder Jane Doe met Trevor Milton', 'possible'],
  ['Trevor Milton', 'Nikola', 'Ex-Nikola CEO Jane Doe met Trevor Milton', 'possible'],
  // the word is not the company
  ['Eric Glyman', 'Ramp', 'Eric Glyman walked up the on-ramp to the highway', 'possible'],
  ['Eric Glyman', 'Ramp Business Corporation', 'Eric Glyman will ramp up hiring next year', 'possible'],
  ['Zach Perret', 'Plaid', 'Zach Perret wore a Plaid shirt to the party', 'possible'],
  ['Eric Glyman', 'Stripe', 'Eric Glyman wrote an anti-Stripe essay in college', 'possible'],
  ['Trevor Milton', 'Nikola Motor Company', 'Trevor Milton visited the Nikola Tesla Museum', 'possible'],
  ['Brian Armstrong', 'Coinbase Global, Inc.', 'Brian Armstrong found a coinbase in the attic', 'possible'],
  ['Eric Glyman', 'Theranos', 'Theranos founder Elizabeth Holmes met Eric Glyman', 'possible'],
  // not the person's name
  ['Daan van der Berg', 'Zeta Labs', 'Daan van der Bergh founded Zeta Labs', 'none'],
  ['Maria Lopez', 'Zeta Labs', 'Maria Garcia-Lopez, CEO of Zeta Labs, said', 'none'],
  ['John Smith', 'Zeta Labs', 'John Smith-Jones of Zeta Labs said', 'none'],
  ['Patrick Collison', 'Stripe', 'Patrick Smith and John Collison founded Stripe', 'none'],
  ['Patrick Collison', 'Stripe', 'Patrick and John Smith founded Stripe', 'none'],
  ['Elizabeth Holmes', 'Theranos', 'the trust for Erin Elizabeth Holmes sued Theranos', 'none'],
];

describe('the shared matcher, sentence by sentence', () => {
  test('the table is large and balanced', () => {
    expect(MUST_TIE.length).toBeGreaterThanOrEqual(30);
    expect(MUST_NOT_TIE.length).toBeGreaterThanOrEqual(30);
  });
  test.each(MUST_TIE)('%s / %s ties: %s', (name, company, text, level) => {
    expect(grade(name, company, text)).toBe(level);
  });
  test.each(MUST_NOT_TIE)('%s / %s does not tie: %s', (name, company, text, level) => {
    expect(grade(name, company, text)).toBe(level);
  });
});

describe('person names', () => {
  test.each([
    ['Ludwig van Beethoven', 'Ludwig van Beethoven said'],
    ['Carlos de la Cruz', 'Carlos de la Cruz said'],
    ['Mohammed bin Salman', 'Mohammed bin Salman said'],
    ['Vincent Van Dijk', 'Vincent van Dijk said'],
    ['Vincent van Dijk', 'Vincent Van Dijk said'],
    ['Ahmed al-Rashid', 'Ahmed al-Rashid said'],
    ['William McFarland', "William 'Billy' McFarland said"],
    ['Maria Garcia-Lopez', 'Maria Garcia Lopez said'],
    ['Maria Garcia Lopez', 'Maria Garcia-Lopez said'],
  ])('%s is written in full in "%s"', (name, text) => {
    expect(personNameMatcher(name).kind(text)).toBe('full');
  });
  test('a particle typed with a capital belongs to the surname; "Ben" typed with a capital stays a middle name', () => {
    expect(parsePersonName('Vincent Van Dijk').surname).toBe('Van Dijk');
    expect(parsePersonName('John Ben Smith').surname).toBe('Smith');
  });
  test('the main surname word must still be capitalised, so prose is not a name', () => {
    expect(personNameMatcher('Grace Hopper').kind('the grace hopper conference')).toBe('none');
    expect(personNameMatcher('Ludwig van Beethoven').kind('ludwig van beethoven')).toBe('none');
  });
  test('a hyphen before the surname is the person only when the typed name has that word', () => {
    expect(personNameMatcher('Maria Lopez').kind('Maria Garcia-Lopez said')).toBe('longer-surname');
  });
  test('shared-surname lists are their own weak kind, never the full name', () => {
    expect(personNameMatcher('Patrick Collison').kind('Patrick and John Collison founded Stripe')).toBe('shared-surname');
    expect(personNameMatcher('Patrick Collison').kind('Jane, Patrick and John Collison spoke')).toBe('shared-surname');
    expect(personNameMatcher('John Collison').kind('Patrick and John Collison founded Stripe')).toBe('full');
  });
  test('unlisted titles and wordlike given names in headlines are not another given name', () => {
    expect(grade('Elizabeth Holmes', '', 'the late Admiral Elizabeth Holmes was honoured')).toBe('possible');
    expect(grade('Grace Hopper', '', 'the pioneering Navy Grace Hopper wrote the compiler')).toBe('possible');
    expect(grade('Elizabeth Holmes', '', 'Investors Mark Elizabeth Holmes Release From Federal Prison')).toBe('possible');
    expect(grade('Elizabeth Holmes', '', 'Sheikh Elizabeth Holmes')).toBe('possible');
    expect(grade('Eric Glyman', 'Ramp', 'a conversation with Ramp Eric Glyman')).not.toBe('none');
    // a real other given name still blocks
    expect(grade('Elizabeth Holmes', '', 'the trust for Mark Elizabeth Holmes was set up')).toBe('none');
  });
});

describe('company mentions', () => {
  test('a shorter form inside a longer one is dropped', () => {
    const m = companyMention('Zeta Labs', 'Zeta Labs CEO Jane Doe');
    expect(m.spans).toHaveLength(1);
    expect(m.spans[0]).toMatchObject({ start: 0, end: 9 });
  });
  test('"ex-" names a former employer, other glued words do not', () => {
    expect(companyMention('Nikola', 'Ex-Nikola CEO Trevor Milton').named).toBe(true);
    expect(companyMention('Stripe', 'ex-Stripe engineer John Smith').named).toBe(true);
    expect(companyMention('Ramp', 'the on-ramp to the highway').named).toBe(false);
    expect(companyMention('Stripe', 'an anti-Stripe essay').named).toBe(false);
  });
  test('registered names with describing words give the brand as a form', () => {
    const forms = (c) => companyMatchForms(c).map((f) => f.form);
    expect(forms('Coinbase Global, Inc.')).toContain('coinbase');
    expect(forms('Robinhood Markets, Inc.')).toContain('robinhood');
    expect(forms('FTX Trading Ltd.')).toContain('ftx');
    expect(forms('Nikola Motor Company')).toContain('nikola');
    expect(forms('Rivian Automotive')).toContain('rivian');
    expect(forms('Moderna Therapeutics')).toContain('moderna');
    expect(companyMatchForms('Ramp Business Corporation').find((f) => f.form === 'ramp')).toMatchObject({ ordinary: true });
    // places, numbers and joining words never stand alone
    expect(forms('General Motors')).not.toContain('general');
    expect(forms('Bank of America')).toEqual(['bank of america']);
  });
  test('a ticker after the company is not a longer name', () => {
    expect(companyMention('Nikola', 'Nikola (NKLA) founder Trevor Milton').named).toBe(true);
    expect(companyMention('Ramp', 'Ramp (UK) shirt sale').named).toBe(false);
  });
});

describe('other names read beside the person (identity-born-place-alias)', () => {
  const subject = () => createSubject({ name: 'Jane Doe', company: 'Zeta Labs' });
  test('a place after "born" is not another name', () => {
    expect(findNameAliases(subject(), 'Jane Doe (born Kansas City, Missouri) is the founder of Zeta Labs')).toEqual([]);
    expect(findNameAliases(subject(), 'Jane Doe (born South Korea) is the founder of Zeta Labs')).toEqual([]);
    expect(findNameAliases(subject(), 'Jane Doe (born Seoul, 1980) is the founder of Zeta Labs')).toEqual([]);
  });
  test('an organisation is not another name', () => {
    expect(findNameAliases(subject(), 'Jane Doe, also known as JD Capital Partners, invested')).toEqual([]);
  });
  test('real birth and former names are still read', () => {
    expect(findNameAliases(subject(), 'Jane Doe (born Jane Ann Black) founded Zeta Labs').map((a) => a.name)).toEqual(['Jane Ann Black']);
    expect(findNameAliases(subject(), 'Jane Doe (born Janet Rowe; 1980) founded Zeta Labs').map((a) => a.name)).toEqual(['Janet Rowe']);
    expect(findNameAliases(subject(), 'Jane Doe, formerly known as Janet Rowe, founded Zeta Labs').map((a) => a.name)).toEqual(['Janet Rowe']);
    expect(findNameAliases(subject(), 'Jane Doe (née Smith) founded Zeta Labs').map((a) => a.name)).toEqual(['Jane Smith']);
  });
  test('addNameAlias refuses places and organisations', () => {
    const s = subject();
    expect(addNameAlias(s, { alias: 'Kansas City', origin: 'found:x' })).toBe(false);
    expect(addNameAlias(s, { alias: 'South Korea', origin: 'found:x' })).toBe(false);
    expect(addNameAlias(s, { alias: 'JD Capital Partners', origin: 'found:x' })).toBe(false);
    expect(addNameAlias(s, { alias: 'Janet Rowe', origin: 'found:x' })).toBe(true);
    expect(matchSubject(s, 'Kansas City police said a Zeta Labs truck crashed').level).toBe('none');
  });
  test('placeOrOrgName', () => {
    expect(placeOrOrgName('Kansas City')).toBe(true);
    expect(placeOrOrgName('Janet Rowe')).toBe(false);
    expect(placeOrOrgName('Kanye West')).toBe(false);
  });
});

describe('anchors from a likely record never confirm (loop-weak-anchor-confirms, identity part)', () => {
  const fraud = 'Jane Roe of Google, a Stanford University graduate, was charged with fraud';
  test('a school learned from a likely record makes a namesake record likely, not confirmed', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Google' });
    addAnchor(s, 'schools', 'Stanford University', 'weak:f1');
    expect(matchSubject(s, fraud).level).toBe('likely');
    // from a confirmed record it still confirms
    const t = createSubject({ name: 'Jane Roe', company: 'Google' });
    addAnchor(t, 'schools', 'Stanford University', 'found:f1');
    expect(matchSubject(t, fraud).level).toBe('confirmed');
  });
  test.each([
    ['people', 'Max Mustermann', 'Jane Roe of Google and Max Mustermann were charged'],
    ['handles', '@janeroe99', 'Jane Roe of Google (@janeroe99) was charged'],
    ['domains', 'janeroe.dev', 'Jane Roe of Google, janeroe.dev, was charged'],
  ])('a %s anchor from a likely record caps at likely', (kind, value, text) => {
    const s = createSubject({ name: 'Jane Roe', company: 'Google' });
    addAnchor(s, kind, value, 'weak:f1');
    expect(matchSubject(s, text).level).toBe('likely');
    const t = createSubject({ name: 'Jane Roe', company: 'Google' });
    addAnchor(t, kind, value, 'found:f1');
    expect(matchSubject(t, text).level).toBe('confirmed');
  });
  test('a legal name learned from a likely record makes a record likely, not confirmed', () => {
    const text = 'Jane Roe, director of Zeta Holdings Inc, was charged';
    const s = createSubject({ name: 'Jane Roe', company: 'Bluebird Analytics' });
    expect(addCompanyAlias(s, { company: 'Bluebird Analytics', alias: 'Zeta Holdings Inc', origin: 'weak:x1' })).toBe(true);
    expect(matchSubject(s, text).level).toBe('likely');
    const t = createSubject({ name: 'Jane Roe', company: 'Bluebird Analytics' });
    addCompanyAlias(t, { company: 'Bluebird Analytics', alias: 'Zeta Holdings Inc', origin: 'found:x1' });
    expect(matchSubject(t, text).level).toBe('confirmed');
  });
  test('a company test honours the anchor view it is graded with', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Bluebird Analytics' });
    addCompanyAlias(s, { company: 'Bluebird Analytics', alias: 'Zeta Holdings Inc', origin: 'weak:x1' });
    const a = [...s.anchors.companies.values()][0];
    expect(a.test.positions('Zeta Holdings Inc filed').length).toBeGreaterThan(0);
    expect(a.test.positions('Zeta Holdings Inc filed', { anchors: { aliases: new Map() } })).toEqual([]);
  });
  test('isWeakOrigin', () => {
    expect(isWeakOrigin('weak:abc')).toBe(true);
    expect(isWeakOrigin('inferred')).toBe(true);
    expect(isWeakOrigin('network')).toBe(true);
    expect(isWeakOrigin('found:abc')).toBe(false);
    expect(isWeakOrigin('given')).toBe(false);
  });
});
