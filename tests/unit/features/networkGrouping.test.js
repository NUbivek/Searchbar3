/**
 * Network Map groupings: industry from title/company words, country from the
 * location field, and hub buckets for the map.
 */
const { industryOf, countryOf, groupKeyFor, bucketsFor, GROUPINGS } = require('../../../src/utils/network/grouping');
const { buildAtlas } = require('../../../src/utils/network/atlas');

const c = (name, position, company, location) => ({ name, position, company, location });

describe('industryOf', () => {
  test('matches sector words in title or company, else Other', () => {
    expect(industryOf(c('A', 'Engineer', 'Stripe Payments'))).toBe('Fintech');
    expect(industryOf(c('B', 'Research Scientist', 'OpenAI'))).toBe('AI');
    expect(industryOf(c('C', 'Nurse', 'City Hospital'))).toBe('Healthcare');
    expect(industryOf(c('D', 'Partner', 'Sequoia Capital'))).toBe('Venture capital');
    expect(industryOf(c('D2', 'Partner', 'Smith & Co'))).toBe('Other');
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
  test('buildAtlas by industry/country makes one bubble per bucket with its companies inside', () => {
    const atlas = buildAtlas(list, { groupBy: 'country' });
    const groups = atlas.root.children;
    expect(groups.map((h) => h.label).sort()).toEqual(['United Kingdom', 'United States', 'Unknown']);
    expect(groups.every((h) => h.type === 'group' && h.dim === 'country' && Number.isFinite(h.x) && h.r > 0)).toBe(true);
    expect(atlas.compass).toBe(false);
    const google = atlas.nodes.find((n) => n.type === 'company' && n.label === 'Google');
    expect(google.parent.key === 'Unknown' || google.parent.parent.key === 'Unknown').toBe(true);
    expect(buildAtlas(list, { groupBy: 'industry' }).root.children.map((h) => h.label).sort()).toEqual(['Big Tech', 'Fintech', 'Media', 'Venture capital']);
  });
});

describe('industryOf: known employers and decisive titles', () => {
  const ind = (position, company) => industryOf({ position, company });
  test('well-known employers are classified by company, not by title words', () => {
    expect(ind('Engineer', 'Google')).toBe('Big Tech');
    expect(ind('Product Manager', 'Stripe')).toBe('Fintech');
    expect(ind('Partner', 'Sequoia Capital')).toBe('Venture capital');
    expect(ind('Partner', 'a16z')).toBe('Venture capital');
    expect(ind('Associate', 'McKinsey & Company')).toBe('Consulting');
    expect(ind('Analyst', 'Goldman Sachs')).toBe('Finance & banking');
    expect(ind('Engineer', 'Databricks')).toBe('AI');
    expect(ind('Data Scientist', 'OpenAI')).toBe('AI');
    expect(ind('Designer', 'Figma')).toBe('Software');
    expect(ind('Researcher', 'UC Berkeley Haas School of Business')).toBe('Education');
  });
  test('decisive titles place people without a known employer; unknown stays Other', () => {
    expect(ind('MBA Candidate', 'Startup 12')).toBe('Education');
    expect(ind('Angel investor', 'Self-employed')).toBe('Venture capital');
    expect(ind('Engineer', 'Startup 12')).toBe('Other');
  });
  test('word boundaries: "Metadata Inc" is not Meta, "Bainbridge" is not Bain', () => {
    expect(ind('Engineer', 'Metadata Inc')).not.toBe('Big Tech');
    expect(ind('Engineer', 'Bainbridge Labs')).not.toBe('Consulting');
  });
});
