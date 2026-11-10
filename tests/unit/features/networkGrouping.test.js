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
    // No sector in the employer's name: grouped by what the person does instead.
    expect(industryOf(c('D2', 'Partner', 'Smith & Co'))).toBe('Investing');
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
  test('decisive titles place people without a known employer; otherwise by function', () => {
    expect(ind('MBA Candidate', 'Startup 12')).toBe('Education');
    expect(ind('Angel investor', 'Self-employed')).toBe('Venture capital');
    expect(ind('Engineer', 'Startup 12')).toBe('Engineering & data');
  });
  test('word boundaries: "Metadata Inc" is not Meta, "Bainbridge" is not Bain', () => {
    expect(ind('Engineer', 'Metadata Inc')).not.toBe('Big Tech');
    expect(ind('Engineer', 'Bainbridge Labs')).not.toBe('Consulting');
  });
});

describe('nobody useful is left in "Other"', () => {
  const { classifyContact } = require('../../../src/utils/network/roles');
  // Titles and employers of the kind a real export holds: mostly companies no table knows.
  const TITLES = ['Software Engineer', 'Senior Product Designer', 'Founder & CEO', 'Co-Founder', 'VP Engineering', 'Head of Growth', 'Account Executive',
    'Chief of Staff', 'Product Manager', 'Data Scientist', 'Partner', 'General Partner', 'Associate', 'Investor', 'MBA Candidate', 'Recruiter',
    'Marketing Manager', 'Operations Lead', 'Attorney', 'Registered Nurse', 'Professor of Economics', 'Policy Advisor', 'Freelance Photographer',
    'Customer Success Manager', 'Financial Analyst', 'Architect', 'Teacher', 'Board Member', 'Consultant', 'Intern', 'Director of Sales', 'CTO',
    'Research Scientist', 'Journalist', 'Office Manager', 'Musician', 'Managing Director', 'Business Development', 'UX Researcher', 'Controller'];
  const COMPANIES = ['Brightloop', 'Northside Health', 'Orbit Labs', 'Acme Capital', 'Harbor & Finch LLP', 'Self-employed', 'Google', 'Riverbend Foods',
    'Kestrel Robotics', 'City of Oakland', 'Lumen Studios', 'Tidewater Energy', 'Stripe', 'Quill Advisors', 'Pinecrest University', 'Zephyr'];
  const people = [];
  TITLES.forEach((position, i) => COMPANIES.forEach((company, j) => { if ((i + j) % 3 === 0) people.push(c(`P${i}-${j}`, position, company)); }));
  // A real export also has a few rows with nothing but a name.
  for (let i = 0; i < 6; i += 1) people.push(c(`Blank ${i}`, '', ''));

  test('under 5% of people end up in the role group "Everyone else"', () => {
    const other = people.filter((p) => classifyContact(p).group === 'other').length;
    expect(other / people.length).toBeLessThan(0.05);
    expect(classifyContact(c('X', '', '')).group).toBe('other');
  });
  test('under 5% of people end up in the industry "Other"', () => {
    const other = people.filter((p) => industryOf(p) === 'Other').length;
    expect(other / people.length).toBeLessThan(0.05);
  });
  test('new role rules', () => {
    expect(classifyContact(c('A', 'General Partner', 'Accel'))).toMatchObject({ role: 'investor', group: 'investors' });
    expect(classifyContact(c('B', 'Partner', 'a16z'))).toMatchObject({ role: 'investor' });
    expect(classifyContact(c('C', 'Partner', 'Harbor & Finch LLP')).group).toBe('experts');
    expect(classifyContact(c('D', 'MBA Candidate', 'UC Berkeley Haas School of Business'))).toMatchObject({ role: 'student', group: 'founders' });
    expect(classifyContact(c('E', 'Senior Product Designer', 'Brightloop')).role).toBe('operator');
    expect(classifyContact(c('F', 'Registered Nurse', 'Northside Health')).role).toBe('clinician');
    expect(classifyContact(c('G', 'Musician', 'Zephyr'))).toMatchObject({ role: 'professional', group: 'founders' });
  });
  test('sector from the company name, then function from the title', () => {
    expect(industryOf(c('A', 'Engineer', 'Northside Health'))).toBe('Healthcare');
    expect(industryOf(c('B', 'Engineer', 'Kestrel Robotics'))).toBe('Industrials');
    expect(industryOf(c('C', 'Analyst', 'City of Oakland'))).toBe('Government & nonprofit');
    expect(industryOf(c('D', 'Founder & CEO', 'Zephyr'))).toBe('Founders & CEOs');
    expect(industryOf(c('E', 'Senior Product Designer', 'Brightloop'))).toBe('Product & design');
    expect(industryOf(c('F', 'Photographer', 'Self-employed'))).toBe('Self-employed');
  });
});
