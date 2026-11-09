/**
 * Network Map groupings: industry from title/company words, country from the
 * location field, and hub buckets for the map.
 */
const { industryOf, countryOf, groupKeyFor, bucketsFor, GROUPINGS } = require('../../../src/utils/network/grouping');
const { buildGraph } = require('../../../src/utils/network/graph');

const c = (name, position, company, location) => ({ name, position, company, location });

describe('industryOf', () => {
  test('matches sector words in title or company, else Other', () => {
    expect(industryOf(c('A', 'Engineer', 'Stripe Payments'))).toBe('Fintech');
    expect(industryOf(c('B', 'Research Scientist', 'OpenAI'))).toBe('AI');
    expect(industryOf(c('C', 'Nurse', 'City Hospital'))).toBe('Healthcare');
    expect(industryOf(c('D', 'Partner', 'Sequoia Capital'))).toBe('Other');
    expect(industryOf(c('E', '', ''))).toBe('Other');
  });
});

describe('countryOf', () => {
  test('reads the country from the end of the location, with US states and cities and aliases', () => {
    expect(countryOf(c('A', '', '', 'San Francisco, CA'))).toBe('United States');
    expect(countryOf(c('B', '', '', 'San Francisco Bay Area'))).toBe('United States');
    expect(countryOf(c('C', '', '', 'London, England, United Kingdom'))).toBe('United Kingdom');
    expect(countryOf(c('D', '', '', 'Berlin'))).toBe('Germany');
    expect(countryOf(c('E', '', '', 'Kathmandu, Nepal'))).toBe('Nepal');
    expect(countryOf(c('F', '', '', 'Paris, France'))).toBe('France');
    expect(countryOf(c('G', '', '', ''))).toBe('Unknown');
    expect(countryOf(c('H', '', '', 'Greater Boston'))).toBe('United States');
  });
});

describe('groupKeyFor / bucketsFor', () => {
  const list = [
    c('A', 'Partner', 'Sequoia Capital', 'Menlo Park, CA'),
    c('B', 'Founder', 'Fintech Co', 'London, United Kingdom'),
    c('C', 'Engineer', 'Google', ''),
    c('D', 'Reporter', 'TechCrunch', 'New York, NY'),
  ];
  test('keys per grouping; company has no hubs', () => {
    expect(groupKeyFor(list[0], 'role')).toBe('investors');
    expect(groupKeyFor(list[1], 'industry')).toBe('Fintech');
    expect(groupKeyFor(list[2], 'country')).toBe('Unknown');
    expect(groupKeyFor(list[2], 'company')).toBeNull();
    expect(GROUPINGS.map((g) => g.key)).toEqual(['role', 'company', 'industry', 'country']);
  });
  test('country buckets are largest first with Unknown last', () => {
    const b = bucketsFor(list, 'country');
    expect(b.map((x) => [x.key, x.contacts.length])).toEqual([['United States', 2], ['United Kingdom', 1], ['Unknown', 1]]);
  });
  test('buildGraph by industry/country adds pinned hubs and links companies under them', () => {
    const g = buildGraph(list, { groupBy: 'country' });
    const hubs = g.nodes.filter((n) => n.type === 'group');
    expect(hubs.map((h) => h.label)).toEqual(['United States', 'United Kingdom', 'Unknown']);
    expect(hubs.every((h) => Number.isFinite(h.fx) && Number.isFinite(h.fy))).toBe(true);
    const google = g.nodes.find((n) => n.type === 'company' && n.label === 'Google');
    expect(google.hub).toBe('Unknown');
    expect(g.links.some((l) => l.source === 'g:Unknown' && l.target === google.id)).toBe(true);
    expect(buildGraph(list, { groupBy: 'industry' }).nodes.filter((n) => n.type === 'group').map((h) => h.label)).toEqual(['Fintech', 'Media', 'Other']);
  });
});
