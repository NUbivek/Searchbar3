/**
 * Round 4 (review 2026-11-21), companyFacts.js changes asked for by the report engineer: an amount with no round
 * is funding only in a funding sentence with no crime, fine or settlement; "gets" and "got" are not raising;
 * standing lines stop at site chrome and drop a trailing publisher; a domain an earlier holder registered before
 * the founding is not the company's.
 */
const { createSubject } = require('../../../src/server/founder/identity');
const { buildCompanyFacts, clipAround } = require('../../../src/server/founder/companyFacts');

let seq = 0;
const rec = (o) => ({ id: `cf${(seq += 1)}`, source: 'web-search', category: 'press', quote: '', match: 'company', url: `https://cf.test/${seq}`, date: null, ...o });
const jane = createSubject({ name: 'Jane Roe', company: 'Zetafold' });

describe('brief-funding-misread-confirmed: a round-less amount', () => {
  test('a fine, a settlement or a forfeiture is never a funding round', () => {
    const facts = buildCompanyFacts(jane, [
      rec({ title: 'Zetafold gets $2M fine', quote: 'Zetafold got a $2M fine from the regulator.' }),
      rec({ title: 'Zetafold closed $5 million settlement', quote: 'Zetafold closed a $5 million settlement of the fraud lawsuit with investors.' }),
      rec({ title: 'Zetafold secured $3 million', quote: 'Zetafold secured $3 million to forfeit in the case.' }),
    ]);
    expect(facts.funding).toEqual([]);
  });
  test('a round-less raise in a funding sentence is still read', () => {
    const facts = buildCompanyFacts(jane, [
      rec({ title: 'Zetafold news', quote: 'Zetafold raised $12 million in new funding led by Accel.' }),
    ]);
    expect(facts.funding).toEqual([expect.objectContaining({ amount: '$12 million', lead: 'Accel' })]);
  });
  test('a round named is read as before', () => {
    const facts = buildCompanyFacts(jane, [rec({ title: 'Zetafold raises $30M Series A', quote: '' })]);
    expect(facts.funding).toEqual([expect.objectContaining({ round: 'Series A', amount: '$30M' })]);
  });
});

describe('standing-boilerplate: a standing line stops at site chrome and loses its publisher', () => {
  test('clipAround cuts at site chrome and a trailing " - Publisher"', () => {
    expect(clipAround('Zetafold is valued at $2 billion, the company said. Skip to main content Sign in Subscribe now', 20)).toBe('Zetafold is valued at $2 billion, the company said.');
    expect(clipAround('Zetafold valued at $2 billion after new round - TechCrunch', 10)).toBe('Zetafold valued at $2 billion after new round');
    expect(clipAround('Cookie policy | Accept all cookies. Zetafold employs 200 people', 60)).toBe('Zetafold employs 200 people');
  });
});

describe('the founded year reaches the domain list', () => {
  test('a domain registered years before the founding, not named for the company, is dropped', () => {
    const facts = buildCompanyFacts(jane, [
      rec({ title: 'Zetafold was founded in 2021', quote: 'Zetafold was founded in 2021.' }),
      rec({ title: 'Jane Roe co-founded Zetafold in 2021', quote: '', match: 'confirmed' }),
      rec({ title: 'janeroe.net: registered 2008-02-01', source: 'domain-history', category: 'corporate', data: { domain: 'janeroe.net', registered: '2008-02-01' } }),
      rec({ title: 'zetafold.com: registered 2012-02-01', source: 'domain-history', category: 'corporate', data: { domain: 'zetafold.com', registered: '2012-02-01' } }),
    ]);
    expect(facts.founded.year).toBe(2021);
    expect(facts.domains.map((d) => d.domain)).toEqual(['zetafold.com']);
  });
  test('funding dated before the founding is dropped', () => {
    const facts = buildCompanyFacts(jane, [
      rec({ title: 'Zetafold was founded in 2021', quote: 'Zetafold was founded in 2021.' }),
      rec({ title: 'Zetafold founded 2021', quote: 'Jane Roe started Zetafold in 2021.' }),
      rec({ title: 'Zetafold raises $4M seed', quote: 'Zetafold raised a $4M seed round in 2015.' }),
    ]);
    expect(facts.funding).toEqual([]);
  });
});
