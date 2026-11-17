/**
 * Round 4 fixes in extract.js: French associate patterns (plan item 8, part 2)
 * and earlier ventures read from a record's snippet or quote (plan item 18).
 */
const { createSubject } = require('../../../src/server/founder/identity');
const { associatesFromText, companiesFromText, threadsFromResult } = require('../../../src/server/founder/extract');

const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
const names = (text) => associatesFromText(subject, text).map((a) => a.name);
const companies = (text) => companiesFromText(subject, text).map((c) => c.name);

describe('French associates', () => {
  test('co-founders, "fondé avec" and "<Name>, actionnaire" are read in a French sentence', () => {
    expect(names('Jane Roe a cofondé Acme Robotics avec ses cofondateurs Paul Durand et Luc Martin.')).toEqual(expect.arrayContaining(['Paul Durand', 'Luc Martin']));
    expect(names('Jane Roe a fondé Acme Robotics en 2023 avec Marc Petit.')).toEqual(['Marc Petit']);
    expect(names("Jane Roe a fondé la société avec l'ancien ministre Pierre Blanc.")).toContain('Pierre Blanc');
    const a = associatesFromText(subject, "Cédric O, l'ancien secrétaire d'État, actionnaire et conseiller de Acme Robotics, soutient Jane Roe depuis 2023.");
    expect(a.map((x) => x.name)).toContain('Cédric O');
  });

  test('a shareholder of another company is not an associate', () => {
    expect(names('Jane Roe a rencontré Paul Durand, actionnaire de Beta Industries, à Paris.')).toEqual([]);
  });

  test('French patterns do not run on an English sentence', () => {
    expect(names('Jane Roe spoke with Paul Durand, administrateur by trade, at the event.')).toEqual([]);
  });
});

describe('earlier ventures', () => {
  test('"startups called", "founded <Name>" and "an online marketplace, <Name>" give companies', () => {
    expect(companies('Before Acme, Jane Roe ran two startups called Gridline.')).toContain('Gridline');
    expect(companies('Jane Roe founded Harbor Labs in 2008.')).toContain('Harbor Labs');
    expect(companies('Jane Roe built an online marketplace, uPillar, that later failed.')).toContain('uPillar');
  });

  test('the given company, a publisher or a date is not an earlier venture', () => {
    expect(companies('Jane Roe founded Acme Robotics in 2014.')).toEqual([]);
    expect(companies('Jane Roe founded The Wall Street Journal club at school.')).toEqual([]);
    expect(companies('Jane Roe was profiled by a company, Bloomberg, last year.')).toEqual([]);
  });

  test('the quote of a record is read as well as its title', () => {
    const threads = threadsFromResult(subject, { title: 'Jane Roe profile', quote: 'Jane Roe started a company called Gridline in 2009.', url: 'https://example.com/a' }, { trusted: true });
    expect(threads.filter((t) => t.kind === 'company').map((t) => t.value)).toContain('Gridline');
  });
});
