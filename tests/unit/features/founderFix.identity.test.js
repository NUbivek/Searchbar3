/**
 * Fixes to identity.js: a handle that is just the person's own first name or
 * surname, and a one-word company found inside a longer, different name.
 */
const { createSubject, addAnchor, matchSubject } = require('../../../src/server/founder/identity');

describe('handles and domains never match the person through their own name', () => {
  test('a handle equal to a first name or surname is refused', () => {
    const s = createSubject({ name: 'Jack Dorsey', company: 'Block' });
    expect(addAnchor(s, 'handles', 'jack')).toBe(false);
    expect(addAnchor(s, 'handles', '@Dorsey')).toBe(false);
    expect(addAnchor(s, 'domains', 'dorsey')).toBe(false);
    expect(matchSubject(s, 'Jack Dorsey, 52, of Toledo, charged with fraud').level).toBe('possible');
    // a handle with a digit, underscore or dot is not a bare name
    expect(addAnchor(s, 'handles', 'jack_')).toBe(true);
  });

  test('a handle is not found inside the written name', () => {
    const s = createSubject({ name: 'Jack Dorsey' });
    addAnchor(s, 'handles', 'jack.dorsey');
    addAnchor(s, 'handles', 'jackdorsey');
    expect(matchSubject(s, 'Jack Dorsey, 52, of Toledo, charged with fraud').level).toBe('possible');
    expect(matchSubject(s, 'Jack Dorsey (@jackdorsey) posted again').level).toBe('likely');
    expect(matchSubject(s, 'Jack Dorsey wrote at example.com/jack.dorsey').level).toBe('likely');
  });
});

describe('a one-word company inside a longer organisation name does not confirm', () => {
  test('a capitalised neighbour makes it part of another name', () => {
    const neumann = createSubject({ name: 'Adam Neumann', company: 'Flow' });
    expect(matchSubject(neumann, 'Adam Neumann, partner at Cash Flow Capital, was sued').level).toBe('possible');
    const collison = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    expect(matchSubject(collison, 'Patrick Collison, brewer at Red Stripe Brewing Co').level).toBe('possible');
    const mensch = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    expect(matchSubject(mensch, 'Arthur Mensch, winemaker at Domaine du Mistral').level).toBe('possible');
    const flowCap = createSubject({ name: 'Adam Neumann', company: 'Flow Capital' });
    expect(matchSubject(flowCap, 'Adam Neumann, partner at Cash Flow Capital, was sued').level).toBe('possible');
  });

  test('the company written as itself still confirms', () => {
    const collison = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    expect(matchSubject(collison, 'Patrick Collison, chief executive of Stripe, said so.').level).toBe('confirmed');
    expect(matchSubject(collison, 'Stripe CEO Patrick Collison said so.').level).toBe('confirmed');
    expect(matchSubject(collison, 'Patrick Collison runs Stripe Inc. in Dublin').level).toBe('confirmed');
    expect(matchSubject(collison, 'PATRICK COLLISON — STRIPE INC').level).toBe('confirmed');
    expect(matchSubject(collison, 'Patrick Collison said so. Yesterday Stripe raised money.').level).toBe('confirmed');
    expect(matchSubject(collison, "Patrick Collison's Stripe raised money").level).toBe('confirmed');
    expect(matchSubject(collison, 'Patrick Collison https://stripe.com/about').level).toBe('confirmed');
    const mensch = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    expect(matchSubject(mensch, 'Arthur Mensch, chief executive of Mistral AI, spoke.').level).toBe('confirmed');
    expect(matchSubject(mensch, 'Mistral CEO Arthur Mensch spoke.').level).toBe('confirmed');
    const neumann = createSubject({ name: 'Adam Neumann', company: 'Flow' });
    expect(matchSubject(neumann, 'Adam Neumann raised $350 million for Flow.').level).toBe('confirmed');
  });
});

describe('full legal names and headlines', () => {
  test('a name that starts with the company still confirms', () => {
    const milton = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    expect(matchSubject(milton, 'Trevor Milton, inventor; owner Nikola Motor Company LLC').level).toBe('confirmed');
  });

  test('a Title Case headline does not hide the company', () => {
    const collison = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    expect(matchSubject(collison, 'Patrick Collison Says Stripe Will Expand Payments Business').level).toBe('confirmed');
    const mensch = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    expect(matchSubject(mensch, 'Arthur Mensch Buys Domaine du Mistral Vineyard').level).toBe('possible');
  });
});

describe('the person beside their company still confirms a record', () => {
  const { createSubject: subjectOf, matchSubject: grade } = require('../../../src/server/founder/identity');
  test.each([
    ['Elizabeth Holmes', 'Theranos', 'Elizabeth Holmes of Theranos was indicted.'],
    ['Elizabeth Holmes', 'Theranos', 'Elizabeth Holmes Theranos trial begins'],
    ['Elizabeth Holmes', 'Theranos', 'Former Theranos CEO Elizabeth Holmes sentenced'],
    ['Patrick Collison', 'Stripe', 'Patrick Collison, chief executive of Stripe, said so.'],
    ['Patrick Collison', 'Stripe', 'Patrick Collison (Stripe) spoke.'],
    ['Arthur Mensch', 'Mistral AI', 'Arthur Mensch MISTRAL AI'],
    ['Arthur Mensch', 'Mistral AI', 'Arthur Mensch of Mistral AI said'],
    ['Adam Neumann', 'WeWork', "WeWork's Adam Neumann steps down"],
    ['Sam Bankman-Fried', 'FTX', 'Sam Bankman-Fried of FTX was convicted.'],
  ])('%s / %s: "%s"', (name, company, text) => {
    expect(grade(subjectOf({ name, company }), text).level).toBe('confirmed');
  });
  test.each([
    ['Patrick Collison', 'Stripe', 'Patrick Collison joined Blue Stripe Capital.'],
    ['Adam Neumann', 'Flow', 'Adam Neumann fixed the cash flow problem.'],
    ['Jane Roe', 'Columbia', 'Jane Roe studied at the University of Columbia.'],
  ])('a different organisation or an ordinary word does not: %s / %s: "%s"', (name, company, text) => {
    expect(grade(subjectOf({ name, company }), text).level).toBe('possible');
  });
});
