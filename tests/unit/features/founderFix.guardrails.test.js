/**
 * Fixes to the privacy guardrails (guardrails.js): births and named babies,
 * month-and-year dates of birth, the public-record exemption limited to
 * official sources, religion, citizenship and visas, UK street names, bare
 * phone numbers, where someone lives, and more people-search hosts.
 */
const { redactPII, isBlockedUrl, isSensitive, mentionsMinor, sanitizeFinding } = require('../../../src/server/founder/guardrails');
const { createSubject } = require('../../../src/server/founder/identity');
const { makeFinding } = require('../../../src/server/founder/finding');

const holmes = () => createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
const press = (quote, extra = {}) => sanitizeFinding({ source: 'web-search', category: 'press', title: 'Jane Doe founded Acme', quote, url: 'https://example.com/a', ...extra });

describe('births and named children', () => {
  const quotes = [
    'Elizabeth Holmes, the Theranos founder, gave birth to a baby boy, William, in July 2021.',
    "Elizabeth Holmes' son William was born in 2021.",
    'Elizabeth Holmes of Theranos welcomed a baby boy, William.',
  ];
  test.each(quotes)('drops %s', (quote) => {
    expect(makeFinding(holmes(), { source: 'web-search', category: 'press', title: 'Elizabeth Holmes gives birth to a son', quote, url: 'https://example.com/x' })).toBeNull();
    expect(mentionsMinor(quote)).toBe(true);
  });
  test('the title alone is enough', () => {
    expect(mentionsMinor('Elizabeth Holmes gives birth to a son')).toBe(true);
  });
  test('company child-safety work and institutions are not children', () => {
    expect(mentionsMinor("Meta's child safety team was fined by the regulator.")).toBe(false);
    expect(mentionsMinor('Elizabeth Holmes founded Theranos in 2003.')).toBe(false);
  });
});

describe('month and year of birth', () => {
  test('born in a month and year keeps only the year', () => {
    expect(redactPII('Jane Doe was born in March 1984 in Ohio.')).toBe('Jane Doe was born in 1984 in Ohio.');
    expect(redactPII('Jane Doe (born March 1984) is an American entrepreneur.')).toBe('Jane Doe (born in 1984) is an American entrepreneur.');
  });
  test('a Companies House date of birth is removed', () => {
    expect(redactPII('Director: Jane DOE, Date of birth: March 1984, Nationality: British')).toBe('Director: Jane DOE, Date of birth [date removed], Nationality: British');
    expect(redactPII('DOB: 03/1984')).toBe('DOB [date removed]');
  });
  test('full dates still behave as before', () => {
    expect(redactPII('born on March 3, 1984 in Lyon')).toBe('born in 1984 in Lyon');
  });
});

describe('the public-record exemption', () => {
  const quote = 'Elizabeth Holmes of Theranos is pregnant, her lawyers told the court; she was diagnosed with depression.';
  test('a web result tagged litigation is not exempt', () => {
    expect(makeFinding(holmes(), { source: 'web-search', category: 'litigation', title: 'Elizabeth Holmes Theranos', quote, url: 'https://example.com/case' })).toBeNull();
    expect(sanitizeFinding({ source: 'news-archive', category: 'litigation', title: 'Elizabeth Holmes Theranos', quote, url: 'https://example.com/case' })).toBeNull();
  });
  test('an official court record keeps only the sentences about the case', () => {
    const out = sanitizeFinding({
      source: 'court-dockets', category: 'litigation', title: 'United States v. Holmes',
      quote: 'Elizabeth Holmes was convicted of wire fraud. She was diagnosed with depression.', url: 'https://example.com/docket',
    });
    expect(out.quote).toBe('Elizabeth Holmes was convicted of wire fraud.');
  });
  test('an official record with nothing but sensitive text, or a sensitive title, is dropped', () => {
    expect(sanitizeFinding({ source: 'court-dockets', category: 'litigation', title: 'United States v. Holmes', quote: 'She is pregnant.', url: 'https://example.com/d' })).toBeNull();
    expect(sanitizeFinding({ source: 'court-dockets', category: 'litigation', title: 'Holmes pregnant, court told', quote: 'Sentencing was delayed.', url: 'https://example.com/d' })).toBeNull();
  });
});

describe('religion, citizenship, visas and locating details', () => {
  test.each([
    'Jane Doe is a British citizen of Indian origin, a Hindu.',
    'Jane Doe, a Mormon, founded Acme.',
    'Jane Doe was granted US citizenship after years on an H-1B visa.',
    'Jane Doe came to the US as a refugee.',
  ])('drops %s', (quote) => {
    expect(isSensitive(quote)).toBe(true);
    expect(press(quote)).toBeNull();
  });
  test('institutions and business terms are not a person’s faith or status', () => {
    expect(isSensitive('Jane Doe studied at the Catholic University of America.')).toBe(false);
    expect(isSensitive('Acme published its corporate citizenship report.')).toBe(false);
    expect(isSensitive('Jane Doe funded a refugee resettlement charity.')).toBe(false);
  });
  test('UK street names and where someone lives are removed', () => {
    expect(press('Jane Doe, 41, lives at 12 Kensington Gardens, London W8.').quote).toBe('Jane Doe, 41, [location removed].');
    expect(redactPII('Her office is at 12 Kensington Gardens, London.')).toBe('Her office is at [address removed], London.');
    expect(redactPII('She lives in Palo Alto.')).toBe('She [location removed].');
  });
  test('place names after a year are not addresses', () => {
    expect(redactPII('In 2015 Menlo Park investors backed Acme.')).toBe('In 2015 Menlo Park investors backed Acme.');
  });
  test('a bare phone number next to a phone word is removed, other long numbers are not', () => {
    expect(redactPII('call 4155550100')).toBe('call [phone removed]');
    expect(redactPII('Company number 0412345678 was dissolved.')).toBe('Company number 0412345678 was dissolved.');
  });
});

describe('people-search hosts', () => {
  test.each([
    'fastbackgroundcheck.com', 'advancedbackgroundchecks.com', 'peoplefinder.com', 'usa-people-search.com', 'infotracer.com',
    'peoplewhiz.com', '411.info', 'spytox.com', 'www.best-people-search.net', 'reversephonelookup.example', 'mugshots.example',
  ])('blocks %s', (host) => {
    expect(isBlockedUrl(`https://${host}/name/jane-doe`)).toBe(true);
  });
  test('public bodies and ordinary sites are not blocked', () => {
    expect(isBlockedUrl('https://publicrecords.lacounty.gov/search')).toBe(false);
    expect(isBlockedUrl('https://www.sec.gov/litigation')).toBe(false);
    expect(isBlockedUrl('https://www.nytimes.com/2021/business/theranos.html')).toBe(false);
  });
});
