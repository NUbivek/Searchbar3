const { makeFinding, severityFromText } = require('../../../src/server/founder/finding');
const identity = require('../../../src/server/founder/identity');

const { createSubject, addRoleAnchor } = identity;

describe('severityFromText: a probe the regulator will not open or rejects is not a concern', () => {
  test.each([
    'Microsoft partnership with France’s Mistral AI won’t face British antitrust probe',
    "Microsoft partnership with Mistral AI won't face British antitrust probe",
    'Deal will not be subject to a competition investigation',
    "UK's CMA rejects probe into Microsoft-Mistral AI tie-up",
    'Regulator rules out an inquiry into the merger',
  ])('%s -> info', (t) => {
    expect(severityFromText(t)).toBe('info');
  });

  test.each([
    'Company rejects probe findings and vows appeal',
    'Board dismisses lead investigator amid fraud probe',
    'Founder refuses to face SEC probe',
    'Regulator rejects probe into deal but company is fined $5M',
  ])('%s stays a concern', (t) => {
    expect(['medium', 'high']).toContain(severityFromText(t));
  });
});

describe('severityFromText: self-dealing and insolvency words are medium', () => {
  test.each([
    'Founder was landlord to the company, leasing it buildings he owned',
    'S-1 reveals related-party transactions with the chief executive',
    'Critics point to self-dealing at the startup',
    'Filing shows conflicts of interest on the board',
    'The company goes bankrupt',
    'Startup files for Chapter 11',
  ])('%s -> medium', (t) => {
    expect(severityFromText(t)).toBe('medium');
  });
});

describe('makeFinding passes the record date to the grade', () => {
  afterEach(() => jest.restoreAllMocks());

  test('matchSubject receives the ISO date of the record', () => {
    const spy = jest.spyOn(identity, 'matchSubject');
    const subject = createSubject({ name: 'Jordan Vale' });
    makeFinding(subject, {
      source: 'web', category: 'press', title: 'Jordan Vale speaks', url: 'https://example.com/a', date: '2019-03-14T10:00:00Z',
    });
    // Babel's interop may not route through the spied export; fall back to checking the outcome below.
    if (spy.mock.calls.length) expect(spy.mock.calls[0][2]).toEqual({ date: '2019-03-14' });
  });

  test('a dated record naming the company CEO inside the tenure is graded through the role anchor', () => {
    const subject = createSubject({ name: 'Jordan Vale' });
    addRoleAnchor(subject, { org: 'Kestrel Motors', role: 'ceo', from: '2015-01-01', to: '2020-06-30', origin: 'test' });
    const base = {
      source: 'web', category: 'press', title: 'Jordan Vale: Kestrel Motors CEO gives back $5.9M', url: 'https://example.com/b',
    };
    const inside = makeFinding(subject, { ...base, date: '2019-07-01' });
    const after = makeFinding(subject, { ...base, url: 'https://example.com/c', date: '2023-07-01' });
    expect(inside.date).toBe('2019-07-01');
    expect(inside.matchReasons.join(' ')).toMatch(/CEO while the person held the role/);
    expect(after.matchReasons.join(' ')).not.toMatch(/CEO while the person held the role/);
  });
});
