/**
 * Round 3 fixes to identity.js.
 * (1) A company named in a headline after a joining word ("Worth Of Acme Stock"), before a possessive or a
 *     title ("Acme's", "Acme CEO"), or after a common word ("With Acme CEO") is named as the company.
 * (6) A record dated inside the person's CEO tenure that names the company's CEO grades 'likely', never more.
 */
const { createSubject, matchSubject, addRoleAnchor, exportAnchors, restoreSubject } = require('../../../src/server/founder/identity');

describe('company names in headlines and before titles', () => {
  const nikola = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });

  test('the graded headlines confirm', () => {
    expect(matchSubject(nikola(), 'Trevor Milton Sold Nearly $300 Million Worth Of Nikola Stock').level).toBe('confirmed');
    expect(matchSubject(nikola(), 'A Timeline of Nikola’s Trevor Milton').level).toBe('confirmed');
    expect(matchSubject(nikola(), 'SEC Charges Against Former Nikola CEO Trevor Milton, with commentary from regulators and lawyers').level).toBe('confirmed');
    const mistral = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    expect(matchSubject(mistral, 'Paris AI week – With Mistral CEO Arthur Mensch [video]').level).toBe('confirmed');
  });

  test('a title or a possessive after the company counts in prose too', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Stripe' });
    expect(matchSubject(s, 'in a filing, regulators said Payments Stripe CEO Jane Roe knew about the plan').level).toBe('confirmed');
    expect(matchSubject(s, 'regulators said that Jane Roe, Oversized Stripe’s founder, knew about it').level).toBe('confirmed');
  });

  test('longer names are still longer names', () => {
    const flow = createSubject({ name: 'Jane Roe', company: 'Flow' });
    expect(matchSubject(flow, 'Jane Roe was hired by Cash Flow Capital as an analyst last year').level).toBe('possible');
    const m = createSubject({ name: 'Jane Roe', company: 'Mistral' });
    expect(matchSubject(m, 'Jane Roe bought a bottle at Domaine du Mistral last week, she said').level).toBe('possible');
    expect(matchSubject(m, 'Jane Roe met the Domaine du Mistral CEO at a tasting last week, she said').level).toBe('possible');
  });
});

describe('CEO tenure anchors', () => {
  const subject = () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Zentrix' });
    addRoleAnchor(s, { org: 'Orbitly', role: 'ceo', from: '2012-03-01', to: '2019-09-24', origin: 'wikidata' });
    return s;
  };

  test('names the company CEO during the tenure: likely, without the name', () => {
    const g = matchSubject(subject(), 'Orbitly CEO gives back $5.9M from trademark deal', { date: '2019-07-02' });
    expect(g.level).toBe('likely');
    expect(g.reasons[0]).toMatch(/Orbitly's CEO while the person held the role/);
    expect(matchSubject(subject(), 'Jane Roe interview: Orbitly’s chief executive on growth', { date: '2015-05' }).level).toBe('likely');
  });

  test('never above likely, and only with a date inside the tenure', () => {
    const s = subject();
    expect(matchSubject(s, 'Orbitly CEO gives back $5.9M', { date: '2020-01-10' }).level).toBe('none');
    expect(matchSubject(s, 'Orbitly CEO gives back $5.9M', { date: '2019' }).level).toBe('none');
    expect(matchSubject(s, 'Orbitly CEO gives back $5.9M').level).toBe('none');
    expect(matchSubject(s, 'Jane Roe spoke; Orbitly CEO gives back $5.9M', { date: '2016-01-01' }).level).toBe('likely');
  });

  test('predecessors, successors, co-founders and other named CEOs do not count', () => {
    const s = subject();
    const at = { date: '2016-01-01' };
    expect(matchSubject(s, 'Former Orbitly CEO sues the board', at).level).toBe('none');
    expect(matchSubject(s, 'the new Orbitly CEO starts Monday', at).level).toBe('none');
    expect(matchSubject(s, 'Orbitly co-founder sells shares', at).level).toBe('none');
    expect(matchSubject(s, 'Orbitly co-CEO sells shares', at).level).toBe('none');
    expect(matchSubject(s, 'Orbitly CEO John Smith sells shares', at).level).toBe('none');
  });

  test('only the CEO role is accepted, and role anchors survive export and restore', () => {
    const s = createSubject({ name: 'Jane Roe' });
    expect(addRoleAnchor(s, { org: 'Orbitly', role: 'founder', from: '2012' })).toBe(false);
    expect(addRoleAnchor(s, { org: 'Orbitly', role: 'ceo', from: '2012-03-01', to: '2019-09-24' })).toBe(true);
    const saved = exportAnchors(s);
    expect(saved.roles[0]).toMatchObject({ org: 'Orbitly', role: 'ceo', from: '2012-03-01', to: '2019-09-24' });
    const back = restoreSubject({ name: 'Jane Roe', anchors: saved });
    expect(matchSubject(back, 'Orbitly CEO gives back $5.9M', { date: '2018-02-01' }).level).toBe('likely');
  });
});
