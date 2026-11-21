/**
 * Round 4 (review 2026-11-21), names.js changes asked for by the report, sources-official and sources-company
 * engineers: an ordinary-word company named as a company, "won't" is not a case won, one shared nickname table,
 * and dictionary-word brands such as Mistral.
 */
const names = require('../../../src/server/founder/names');

const { companyMention, matterOutcome, isOrdinaryWordCompany, givenNamesAgree } = names;

describe('report-ordinaryword-drops-company-news: an ordinary-word company named as a company', () => {
  test.each([
    ["Ramp's new AI agents promise to close the books faster"],
    ['Visa and Ramp partner on corporate cards'],
    ['Ramp and Visa partner on corporate cards'],
    ['Inside Ramp: how the books are closed'],
  ])('%s names Ramp', (text) => {
    expect(companyMention('Ramp', text).named).toBe(true);
  });
  test.each([
    ["The ramp's slope was too steep for the van"],
    ['Wheelchair users and ramp partners met on Tuesday'],
    ['Inside the ramp: a short walk'],
    ["Square's corners are all right angles"],
  ])('%s does not name the company', (text) => {
    const company = /square/i.test(text) ? 'Square' : 'Ramp';
    expect(companyMention(company, text).named).toBe(false);
  });
});

describe("matterOutcome: \"won't\" is never a case won", () => {
  test('"Won\'t Testify" is not a win', () => {
    const person = names.personNameMatcher('Jane Roe');
    expect(matterOutcome("Jane Roe Won't Testify in Fraud Trial", { person }).outcome).not.toBe('won');
    expect(matterOutcome('Jane Roe won’t appeal the verdict', { person }).outcome).not.toBe('won');
    // a case won is still read
    expect(matterOutcome('Jane Roe wins appeal in fraud case', { person }).outcome).toBe('won');
  });
});

describe('sources-official: one shared nickname table', () => {
  test('givenNamesAgree reads diminutives both ways and never a different name', () => {
    expect(givenNamesAgree('William', 'Bill')).toBe(true);
    expect(givenNamesAgree('bill', 'WILLIAM')).toBe(true);
    expect(givenNamesAgree('Robert', 'Robert')).toBe(true);
    expect(givenNamesAgree('William', 'Robert')).toBe(false);
    expect(givenNamesAgree('', 'Robert')).toBe(false);
  });
});

describe('sources-company: Mistral stays a distinctive name', () => {
  // Not added to the ordinary words: "Mistral AI" written "Mistral" is the company in the press and in a register
  // record tied to the person, and a bare "Mistral, Inc." carries a legal form either way.
  test('Mistral AI is not an ordinary-word company', () => {
    expect(isOrdinaryWordCompany('Mistral AI')).toBe(false);
  });
});

describe('sources-company: a look-alike owner with a longer registered name is not the company', () => {
  test.each([
    ['Patent Family Assigned To Flow Hair Salon Inc Covering Styling Devices'],
    ['Owner: Flow Hair Salon Inc.'],
    ['Assignee Flow Hair Salon, LLC filed the application'],
  ])('%s does not name Flow', (text) => {
    expect(companyMention('Flow', text).named).toBe(false);
  });
  test.each([
    ['Assignee: Flow, Inc.'],
    ['Patent Family Assigned To Flow Inc Covering Housing'],
    ['Patent Family Assigned To Flow Technologies Inc Covering Housing'],
  ])('%s still names Flow', (text) => {
    expect(companyMention('Flow', text).named).toBe(true);
  });
});
