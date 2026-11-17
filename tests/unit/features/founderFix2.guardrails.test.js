/**
 * Round-2 fixes to the privacy guardrails (guardrails.js): religious missions and observance,
 * "father of two" and social-handle children, obituaries and funeral notices, birth dates in
 * encyclopedia ledes, and runs of years read as phone numbers.
 */
const { redactPII, isSensitive, mentionsMinor, sanitizeFinding, isObituary } = require('../../../src/server/founder/guardrails');

const rec = (extra = {}) => ({ source: 'web-search', category: 'press', title: 'Jane Doe founded Acme', quote: '', url: 'https://example.com/a', match: 'likely', ...extra });

describe('religious missions and observance', () => {
  test.each([
    'Jane Doe went on an LDS mission to Brazil before founding Acme.',
    'After high school Jane Doe served a Mormon mission in Peru.',
    'Jane Doe served a mission in Japan.',
    'Jane Doe worked as a missionary in Kenya.',
    'Inside the Acme founder’s Shabbat dinners',
    'Jane Doe keeps kosher and attends synagogue weekly.',
    'Jane Doe is a follower of Kabbalah.',
  ])('drops %s', (text) => {
    expect(isSensitive(text)).toBe(true);
    expect(sanitizeFinding(rec({ quote: text }))).toBeNull();
  });
  test('the title alone is checked when the quote is empty', () => {
    expect(sanitizeFinding(rec({ title: 'Jane Doe and the Shabbat dinners at Acme', quote: '' }))).toBeNull();
  });
  test('business uses of mission and missionary are kept', () => {
    expect(isSensitive("Acme's mission is to electrify trucking.")).toBe(false);
    expect(isSensitive('Jane Doe says founders should be missionaries, not mercenaries.')).toBe(false);
    expect(isSensitive('Mercenaries vs missionaries: how Jane Doe hires.')).toBe(false);
  });
});

describe('parents of children', () => {
  test.each([
    'Jane Doe, mother of two, lives quietly.',
    'John Doe, father of @someteenhandle, posted the video.',
    'John Doe is a father of 3 and a pilot.',
    'Jane Doe, mum to twins, runs a bakery.',
    'John Doe, dad of a girl',
  ])('drops %s', (text) => {
    expect(mentionsMinor(text)).toBe(true);
    expect(sanitizeFinding(rec({ quote: text }))).toBeNull();
  });
  test('business senses of father of are kept', () => {
    expect(mentionsMinor('Jane Doe, the father of two startups, raised again.')).toBe(false);
    expect(mentionsMinor('John Doe is called the father of 3D printing.')).toBe(false);
    expect(mentionsMinor('John Doe is the father of the modern electric truck.')).toBe(false);
  });
});

describe('obituaries and funeral notices', () => {
  test('dropped by title or host unless the record is confirmed', () => {
    expect(sanitizeFinding(rec({ title: 'Jane Doe Obituary (1950 - 2020)' }))).toBeNull();
    expect(sanitizeFinding(rec({ title: 'Jane Doe - Smith Funeral Home', match: 'possible' }))).toBeNull();
    expect(sanitizeFinding(rec({ title: 'Jane Doe', url: 'https://www.smithfuneralhome.com/obituaries/jane-doe' }))).toBeNull();
    expect(sanitizeFinding(rec({ title: 'Jane Doe', url: 'https://www.tributes.com/jane-doe' }))).toBeNull();
    expect(sanitizeFinding(rec({ title: 'Jane Doe Obituary', match: 'confirmed' }))).not.toBeNull();
  });
  test('ordinary titles are not obituaries', () => {
    expect(isObituary(rec({ title: 'Tribute Pharmaceuticals hires Jane Doe' }))).toBe(false);
    expect(isObituary(rec({ title: 'Jane Doe founded Acme', url: 'https://www.nytimes.com/x' }))).toBe(false);
  });
});

describe('birth dates in ledes', () => {
  test('a parenthesised birth date goes whole', () => {
    expect(redactPII('Jane Doe (born 3 March 1984) is a French entrepreneur.')).toBe('Jane Doe is a French entrepreneur.');
    expect(redactPII('Jane Doe (born 1984) is an executive.')).toBe('Jane Doe is an executive.');
    expect(redactPII('Jane Doe (Hebrew: X; born 25 April 1979) is a businessman.')).toBe('Jane Doe (Hebrew: X) is a businessman.');
  });
  test('other parentheses are kept', () => {
    expect(redactPII('Acme (founded 2015) was born out of a lab.')).toBe('Acme (founded 2015) was born out of a lab.');
  });
});

describe('years are not phone numbers', () => {
  test('a run of years is kept, a phone is still removed', () => {
    expect(redactPII('Revenue in 2021 2020 2021 rose.')).toBe('Revenue in 2021 2020 2021 rose.');
    expect(redactPII('Call 415-555-0100.')).toBe('Call [phone removed].');
  });
});
