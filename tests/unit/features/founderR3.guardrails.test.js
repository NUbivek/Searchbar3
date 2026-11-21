/**
 * Round-3 audit (2026-11-20) fixes to the privacy guardrails (guardrails.js) and makeFinding (finding.js):
 * a sentence-level cleaner that removes only the offending sentence, company health business kept,
 * every shape of birth date and age, relatives without a role, wedding and obituary relatives, political
 * donations, P.O. boxes, numbered and lowercase streets, UK and clipped phone numbers, obfuscated emails,
 * minors' initials in court captions, data.* cleaned recursively, grade text never stored, http(s) links
 * only, and model-written text checked too.
 */
const g = require('../../../src/server/founder/guardrails');
const { makeFinding } = require('../../../src/server/founder/finding');
const { createSubject } = require('../../../src/server/founder/identity');

const { cleanSentences, cleanModelText, cleanData, isSafeUrl, safeHref, privacyReason, redactPII, isSensitive, mentionsMinor, sanitizeFinding, isBlockedUrl } = g;
const clean = (t, o) => cleanSentences(t, o).text;
const milton = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const holmes = () => createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
const rec = (extra = {}) => ({ source: 'web-search', category: 'press', title: 'Jane Doe founded Acme', quote: '', url: 'https://example.com/a', match: 'likely', ...extra });

describe('the cleaner removes only the offending sentence and says what it removed', () => {
  test('a health sentence goes, the career sentence stays, the count is by reason', () => {
    const out = cleanSentences('Jane Doe founded Acme in 2015. She was treated for anxiety in 2019. Acme raised $20M.');
    expect(out.text).toBe('Jane Doe founded Acme in 2015. Acme raised $20M.');
    expect(out.removed).toEqual({ health: 1 });
  });
  test('a record keeps its other sentences instead of being dropped', () => {
    const f = sanitizeFinding(rec({ quote: 'Jane Doe is CEO of Acme. She was diagnosed with cancer in 2020.' }));
    expect(f).not.toBeNull();
    expect(f.quote).toBe('Jane Doe is CEO of Acme.');
  });
  test('redactions are counted too', () => {
    const out = cleanSentences('Call 415-555-0100 or write to jane@example.com.');
    expect(out.text).toBe('Call [phone removed] or write to [email removed].');
    expect(out.removed).toEqual({ phone: 1, email: 1 });
  });
  test('an abbreviation does not split a sentence', () => {
    expect(clean('Jane Doe joined Acme Inc. in 2015 as CEO.')).toBe('Jane Doe joined Acme Inc. in 2015 as CEO.');
  });
});

describe('a company’s business is not a person’s health', () => {
  test.each([
    'Elizabeth Holmes founded Theranos, a blood-testing company promising disease diagnosis from a drop of blood.',
    'Jane Doe is CEO of Lyra Health, a mental health benefits startup.',
    'Jane Doe founded a diabetes-care startup in 2018.',
    'Acme makes hearing aids.',
    'Jane Doe backed an HIV drug startup.',
    'Jane Doe ran a pregnancy test company.',
    'Jane Doe sits on the board of an autism charity.',
    'Her grandfather’s fortune survived the Great Depression.'.replace('Her grandfather’s fortune', 'The bank'),
    'Acme’s cancer research foundation raised $5M.',
    'Jane Doe founded an addiction treatment startup.',
    'Acme built a suicide prevention app.',
    'Investors miscarriage of justice claim was rejected.',
  ])('keeps %s', (s) => {
    expect(isSensitive(s)).toBe(false);
    expect(clean(s)).toBe(s);
  });
  test('the Theranos record survives makeFinding', () => {
    const f = makeFinding(holmes(), { source: 'web-search', category: 'career', title: 'Elizabeth Holmes - Theranos founder', quote: 'Elizabeth Holmes founded Theranos, a blood-testing company promising disease diagnosis.', url: 'https://example.com/t' });
    expect(f).not.toBeNull();
    expect(f.quote).toMatch(/blood-testing company/);
  });
  test.each([
    'She was treated for anxiety.',
    'He was diagnosed with Parkinson’s disease.',
    'He spent a month in rehab.',
    'His cancer returned in 2020.',
    'She took medical leave after a stroke.',
    'He was hospitalized after a heart attack.',
    'Jane Doe has ADHD and dyslexia.',
    'He has been sober since 2015.',
    'He had a heart attack in 2019.',
    'She is pregnant with her second child.',
    'Jane Doe has spoken about her depression.',
    'He died of an overdose.',
  ])('drops %s', (s) => {
    expect(privacyReason(s)).not.toBeNull();
    expect(clean(s)).toBe('');
  });
  test('AIDS is matched only as the disease, in capitals', () => {
    expect(isSensitive('Acme makes hearing aids')).toBe(false);
    expect(isSensitive('He was living with AIDS')).toBe(true);
  });
});

describe('religion, sexuality, immigration and political donations', () => {
  test.each([
    ['He is a member of the Church of Jesus Christ of Latter-day Saints.', 'religion'],
    ['She attends Mass every Sunday.', 'religion'],
    ['He is a Scientologist.', 'religion'],
    ['She came to the US on a student visa.', 'immigration'],
    ['He is a DACA recipient.', 'immigration'],
    ['She is openly queer.', 'sexuality'],
    ['Milton donated $5,000 to the Trump campaign, FEC records show.', 'politics'],
    ['He gave $100,000 to a super PAC.', 'politics'],
  ])('%s -> %s', (s, reason) => {
    expect(privacyReason(s)).toBe(reason);
    expect(clean(s)).toBe('');
  });
  test('business wording is kept', () => {
    expect(privacyReason('Acme is a Visa partner.')).toBeNull();
    expect(privacyReason('Acme ran a marketing campaign.')).toBeNull();
    expect(privacyReason('He studied at Temple University.')).toBeNull();
  });
  test('donation-record pages are blocked', () => {
    expect(isBlockedUrl('https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=milton')).toBe(true);
    expect(isBlockedUrl('https://www.opensecrets.org/donor-lookup/results?name=milton')).toBe(true);
    expect(isBlockedUrl('https://www.followthemoney.org/entity-details?eid=1')).toBe(true);
    expect(isBlockedUrl('https://www.fec.gov/updates/')).toBe(false);
  });
});

describe('dates of birth and ages in every common shape', () => {
  test.each([
    ['Jane Doe (born March 14, 1988) is an American entrepreneur.', 'Jane Doe is an American entrepreneur.'],
    ['Trevor Milton (April 6, 1982) is an American businessman.', 'Trevor Milton is an American businessman.'],
    ['Jane Doe was born 1995 in Ohio.', 'Jane Doe was born in Ohio.'],
    ['Jane Doe was born 3rd March 1984.', 'Jane Doe was born [date removed].'],
    ['Date of birth: 1984-03-03', 'Date of birth [date removed]'],
    ['Birth date: 03 March 1984', 'Birth date [date removed]'],
    ['Jane Doe (b. March 3, 1984) founded Acme.', 'Jane Doe founded Acme.'],
    ['Her birthday is March 3.', 'Her birthday is [date removed].'],
    ['Jane Doe was born in March 1984 in Ohio.', 'Jane Doe was born in Ohio.'],
    ['Jane Doe was born in Ohio in 1984.', 'Jane Doe was born in Ohio.'],
    ['The 34-year-old founder raised $5M.', 'The founder raised $5M.'],
    ['Jane Doe, 34, founded Acme.', 'Jane Doe, founded Acme.'],
    ['Jane Doe (age 34) founded Acme.', 'Jane Doe founded Acme.'],
    ['Jane Doe, aged 34, founded Acme.', 'Jane Doe, founded Acme.'],
  ])('%s', (input, expected) => {
    expect(clean(input)).toBe(expected);
  });
  test('a company’s founding date and age at an event stay', () => {
    expect(clean('Acme was founded in March 2015.')).toBe('Acme was founded in March 2015.');
    expect(clean('Acme (founded 2015) is a five-year-old company.')).toBe('Acme (founded 2015) is a five-year-old company.');
    expect(clean('At age 19 she dropped out of Stanford.')).toBe('At age 19 she dropped out of Stanford.');
  });
  test('an infobox snippet loses its birth, spouse and children lines', () => {
    const snippet = 'Trevor Milton is an American businessman. Born Trevor Milton April 6, 1982 (age 44) Layton, Utah. Spouse Carrie Milton. Children 3. Occupation Businessman.';
    const out = cleanSentences(snippet);
    expect(out.text).toBe('Trevor Milton is an American businessman. Occupation Businessman.');
    expect(out.text).not.toMatch(/1982|Carrie|Children/);
  });
  test('makeFinding drops the infobox lines but keeps the record', () => {
    const f = makeFinding(milton(), { source: 'web-search', category: 'identity', title: 'Trevor Milton - Wikipedia', quote: 'Trevor Milton founded Nikola. Born: April 6, 1982. Spouse Carrie Milton. Children 3', url: 'https://en.wikipedia.org/wiki/Trevor_Milton' });
    expect(f).not.toBeNull();
    expect(f.quote).toBe('Trevor Milton founded Nikola.');
  });
});

describe('relatives without a public role, weddings and survived-by', () => {
  test('a wedding notice with a private relative is removed', () => {
    const s = 'Jane Doe married John Roe at Temple Emanu-El. The bride’s father, Bob Doe, is a retired dentist in Scarsdale.';
    expect(clean(s)).toBe('');
  });
  test.each([
    'He is survived by his wife, Mary.',
    'His husband, John Roe, is a teacher.',
    'Milton married Carrie in 2010.',
    'Her brother Tom lives nearby.',
  ])('drops %s', (s) => {
    expect(privacyReason(s)).toBe('relatives');
  });
  test.each([
    'Her father, Christian Holmes IV, was a vice president at Enron.',
    'Milton co-founded Nikola with his brother Travis.',
    'His wife, Jane Roe, is a California state senator.',
  ])('keeps a relative with a stated role: %s', (s) => {
    expect(privacyReason(s)).toBeNull();
  });
  test('business senses of kin words are kept', () => {
    expect(privacyReason('Acme sold the unit to its parent company.')).toBeNull();
    expect(privacyReason('Acme launched a sister publication.')).toBeNull();
    expect(privacyReason('He is called the father of 3D printing.')).toBeNull();
    expect(privacyReason('Acme built a coding app for kids.')).toBeNull();
  });
  test('a mother-of-two aside loses only that clause', () => {
    expect(clean('Jane Doe, a mother of two, is CEO of Acme.')).toBe('Jane Doe, is CEO of Acme.');
  });
});

describe('addresses, phones, emails and ID numbers', () => {
  test.each([
    ['The office at 123 5th Avenue closed.', /5th Avenue/],
    ['Her home at 12 main street was sold.', /main street/],
    ['Write to P.O. Box 1234, Palo Alto, CA 94301.', /1234|94301/],
    ['Call 07700 900123.', /900123/],
    ['Call +44 7700 900123.', /900123/],
    ['Mail jane [at] gmail [dot] com today.', /gmail/],
    ['Her driver’s license number D1234567 was in the filing.', /D1234567/],
  ])('%s', (input, leak) => {
    expect(redactPII(input)).not.toMatch(leak);
  });
  test('a company register entry keeps its office street line', () => {
    expect(clean('Registered office: 10 Downing Street, London.', { keepStreets: true })).toBe('Registered office: 10 Downing Street, London.');
    expect(clean('Correspondence address: 10 Downing Street, London.', { keepStreets: true })).not.toMatch(/Downing/);
    const f = sanitizeFinding(rec({ source: 'uk-companies-house', category: 'corporate', quote: 'Registered office: 10 Downing Street, London.' }));
    expect(f.quote).toMatch(/Downing Street/);
    expect(sanitizeFinding(rec({ quote: 'Acme moved to 10 Downing Street, London.' })).quote).not.toMatch(/Downing/);
  });
  test('a phone number cut off by the clip does not leak', () => {
    const quote = `Jane Doe is CEO of Acme. ${'Acme makes robots for warehouses. '.repeat(19)}Call 415-555-0100 for details.`;
    const f = makeFinding(createSubject({ name: 'Jane Doe' }), { source: 'web-search', category: 'press', title: 'Jane Doe of Acme', quote, url: 'https://example.com/p' });
    expect(f.quote.length).toBeLessThanOrEqual(700);
    expect(f.quote).not.toMatch(/415|555/);
    expect(redactPII('call 415-555-01…')).not.toMatch(/555/);
    expect(redactPII('Reach her at 415-555-01...')).not.toMatch(/555/);
  });
});

describe('minors in court captions', () => {
  test.each([
    'J.D., a minor, by and through her mother, v. Acme Corp.',
    'A.B., by and through his parents, sued the company.',
    'The complaint was filed by the guardian ad litem.',
  ])('%s', (s) => {
    expect(mentionsMinor(s)).toBe(true);
    expect(clean(s)).toBe('');
  });
  test('ordinary uses of minor are kept', () => {
    expect(mentionsMinor('Acme took a minor stake in Beta.')).toBe(false);
  });
});

describe('makeFinding: data, grade text and links', () => {
  const subject = () => createSubject({ name: 'Jane Doe' });
  const base = { source: 'web-search', category: 'career', title: 'Jane Doe is CEO of Acme', quote: 'Jane Doe is CEO of Acme.', url: 'https://example.com/a' };
  test('every string inside data is cleaned, recursively', () => {
    const f = makeFinding(subject(), { ...base, data: { titles: ['CEO, call 415-555-0100, jane@example.com'], role: 'lives at 12 Elm Street', nested: { note: 'She was diagnosed with cancer.', n: 3 }, relation: 'father', dob: '1984-03-03', caseNumber: '1:18-cr-00258' } });
    expect(JSON.stringify(f.data)).not.toMatch(/415|jane@|Elm|cancer|1984/);
    expect(f.data.relation).toBe('father');
    expect(f.data.nested.n).toBe(3);
    expect(f.data.caseNumber).toBe('1:18-cr-00258');
    expect('dob' in f.data).toBe(false);
  });
  test('non-http links inside data are removed', () => {
    const f = makeFinding(subject(), { ...base, data: { website: 'javascript:alert(1)', links: [{ url: 'https://acme.test/' }, { url: 'data:text/html,x' }] } });
    expect(f.data.website).toBeUndefined();
    expect(f.data.links).toEqual([{ url: 'https://acme.test/' }, {}]);
  });
  test('grade text keeps what the re-grade needs and nothing private', () => {
    const f = makeFinding(subject(), { ...base, matchText: 'Jane Doe, CEO of Acme. She was treated for anxiety. Call 415-555-0100. Spouse John Doe.' });
    expect(f.gradeText).toMatch(/CEO of Acme/);
    expect(JSON.stringify(f)).not.toMatch(/anxiety|555|Spouse/);
  });
  test.each(['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/x', '//example.com/x', 'vbscript:x'])('a %s link is refused', (url) => {
    expect(makeFinding(subject(), { ...base, url })).toBeNull();
    expect(sanitizeFinding(rec({ url }))).toBeNull();
  });
  test('the title, quote and data are cleaned; a sensitive title drops the record', () => {
    expect(makeFinding(subject(), { ...base, title: 'Jane Doe treated for cancer' })).toBeNull();
    const f = makeFinding(subject(), { ...base, title: 'Jane Doe (born March 3, 1984) is CEO of Acme' });
    expect(f.title).toBe('Jane Doe is CEO of Acme');
  });
});

describe('the URL check the page can reuse', () => {
  test('http and https only', () => {
    expect(isSafeUrl('https://example.com/a')).toBe(true);
    expect(isSafeUrl('HTTP://example.com')).toBe(true);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl(' javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('java\nscript:alert(1)')).toBe(false);
    expect(isSafeUrl('/relative')).toBe(false);
    expect(isSafeUrl(null)).toBe(false);
    expect(safeHref(' https://example.com/a ')).toBe('https://example.com/a');
    expect(safeHref('javascript:alert(1)')).toBeNull();
  });
});

describe('model-written text', () => {
  test('applies the same rules line by line and keeps citations of the lines it keeps', () => {
    const brief = '## Summary\n- Holmes founded Theranos in 2003 [Source 1].\n- Holmes, who has two children and was born in 1984 [Source 3].\n- She was convicted of fraud [Source 2].';
    const out = cleanModelText(brief);
    expect(out.text).toBe('## Summary\n- Holmes founded Theranos in 2003 [Source 1].\n- She was convicted of fraud [Source 2].');
    expect(out.removed.minor).toBe(1);
  });
  test('strips images, HTML and links that are not http or https', () => {
    const out = cleanModelText('See ![x](https://img.test/a.png) <img src=x onerror=alert(1)><b>bold</b> [site](javascript:alert(1)) and [filing](https://sec.gov/a) <script>alert(1)</script>javascript:alert(2)');
    expect(out.text).toBe('See bold site and [filing](https://sec.gov/a)');
  });
});

describe('cleanData on its own', () => {
  test('returns the cleaned value and the counts', () => {
    const out = cleanData({ a: ['call 415-555-0100'], b: 2 });
    expect(out.data).toEqual({ a: ['call [phone removed]'], b: 2 });
    expect(out.removed.phone).toBe(1);
  });
});

describe('what the rules must leave alone', () => {
  test('a record date in brackets and a patent number stay', () => {
    expect(clean('Before (2013-05-12): "Chemical Engineering, Stanford University"')).toBe('Before (2013-05-12): "Chemical Engineering, Stanford University"');
    expect(redactPII('also published as US20210179202A1, MX387190B')).toBe('also published as US20210179202A1, MX387190B');
    expect(redactPII('NI number AB 12 34 56 C')).not.toMatch(/12 34 56/);
    expect(redactPII('Her number is AB 12 34 56 C.')).not.toMatch(/12 34 56/);
  });
  test('a related-party record keeps the kin sentence when the relative’s role is stated elsewhere in it', () => {
    const f = sanitizeFinding(rec({ category: 'related', title: 'Father: John Roe, board member of Acme Robotics', quote: 'Jane Roe: father John Roe. John Roe: occupation businessperson.' }));
    expect(f.quote).toContain('Jane Roe: father John Roe');
    expect(sanitizeFinding(rec({ category: 'related', title: 'Father: John Roe, board member of Acme', quote: 'John Roe is survived by his wife.' }))).toBeNull();
  });
  test('the patent inventor line is left as it is', () => {
    const line = 'Inventor named: Trevor R. Milton (searched as Trevor Milton); assignee: Nikola Corporation; priority 2015-12-30; filed 2021-03-02';
    expect(clean(line)).toBe(line);
  });
  test('research and company work on a disease is not the person’s health', () => {
    expect(isSensitive('Doctoral thesis: Chemotherapy response in breast cancer')).toBe(false);
    expect(isSensitive('Patent: Real-time detection of HIV and cancer markers')).toBe(false);
  });
});

