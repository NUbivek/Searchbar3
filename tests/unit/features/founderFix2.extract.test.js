/**
 * Round 2 fixes in extract.js (plan item 9): companies named as "a company
 * called X" or in camel case, successors, the co-founder filler, place and
 * acronym words that are not people, and one-letter surnames beside a role.
 */
const { createSubject } = require('../../../src/server/founder/identity');
const { associatesFromText, threadsFromResult, companiesFromText, plausiblePersonName } = require('../../../src/server/founder/extract');

const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
const companies = (text) => threadsFromResult(subject, { title: 'Profile', snippet: text, url: 'https://example.com/a' }, { trusted: true })
  .filter((t) => t.kind === 'company').map((t) => t.value);
const names = (text) => associatesFromText(subject, text).map((a) => a.name);

describe('company threads', () => {
  test('"a company called X" gives a company thread, camel case and multi-word names included', () => {
    expect(companies('In 2010 Jane Roe started a company called dHybrid.')).toContain('dHybrid');
    expect(companies('Jane Roe ran a business called St. George Security and Alarm for years.')).toContain('St. George Security and Alarm');
    expect(companies('Jane Roe founded eBay in her garage.')).toContain('eBay');
  });

  test('a person after "and" is not part of the company name; the subject is never a company', () => {
    expect(companiesFromText(subject, 'Jane Roe set up a firm called Zeta and Bob Smith joined later.').map((c) => c.name)).toEqual(['Zeta']);
    expect(companiesFromText(subject, 'A company called Jane Roe was mentioned by Jane Roe.')).toEqual([]);
    // a sentence that does not name the subject offers nothing
    expect(companiesFromText(subject, 'Bob Smith started a company called dHybrid.')).toEqual([]);
  });
});

describe('successors', () => {
  test('the person who took over a role from the subject is an associate', () => {
    expect(names('In 2020 Jane Roe turned over the CEO role to Mark Hale.')).toEqual(['Mark Hale']);
    expect(names('Jane Roe was succeeded as chief executive by Sam Patel.')).toEqual(['Sam Patel']);
    expect(names('Jane Roe was replaced by Tom Lee as chairman.')).toEqual(['Tom Lee']);
    expect(names('Jane Roe stepped down in 2019, and Tom Lee succeeded her as CEO.')).toEqual(['Tom Lee']);
  });

  test('a succession that does not involve the subject is ignored', () => {
    expect(names('Bob Smith, who was succeeded by Tom Lee at Beta, later met Jane Roe.')).toEqual([]);
  });
});

describe('co-founder filler', () => {
  test('the filler does not cross of / the / at', () => {
    expect(names('Jane Roe is co-founder and chief executive of Acme Robotics Tim Lee said.')).toEqual([]);
    expect(names('Jane Roe hired co-founder and chief scientist Tim Lee.')).toEqual(['Tim Lee']);
  });
});

describe('words that are not people', () => {
  test('"-based" places, acronyms and nationality adjectives are rejected', () => {
    expect(plausiblePersonName('Paris-based AI', subject)).toBeNull();
    expect(plausiblePersonName('French Tech', subject)).toBeNull();
    expect(plausiblePersonName('AI Startup', subject)).toBeNull();
    expect(plausiblePersonName('NASA Ames', subject)).toBeNull();
    expect(names('Jane Roe joined co-founders Paris-based AI and others.')).toEqual([]);
    // initials and ordinary names still pass
    expect(plausiblePersonName('AJ Smith', subject)).toBe('AJ Smith');
    expect(plausiblePersonName('Bill English', subject)).toBe('Bill English');
  });
});

describe('one-letter surnames beside a role', () => {
  test('accepted next to co-founder, adviser or minister', () => {
    expect(names('Jane Roe co-founded Acme Robotics with former digital minister Cédric O.')).toEqual(['Cédric O']);
    expect(names('Jane Roe hired adviser Cédric O in 2023.')).toEqual(['Cédric O']);
    expect(names('Jane Roe and co-founder Cédric O spoke.')).toEqual(['Cédric O']);
  });

  test('not accepted in other patterns', () => {
    expect(names('Jane Roe was succeeded by Cédric O in 2024.')).toEqual([]);
  });
});
