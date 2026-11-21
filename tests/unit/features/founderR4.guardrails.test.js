/**
 * Round-4 review (2026-11-21) of the privacy guardrails (guardrails.js), both ways:
 *  - private details that still got through: health phrasings, birth and age shapes, phone and email formats,
 *    a private relative kept because the subject's own role was later in the sentence, birth and nationality
 *    fields in structured data;
 *  - business or official facts wrongly removed: a court or DOJ record dropped for a word in its title, health
 *    and immigration companies' own facts, a person named Gay or Son, a criminal campaign-finance charge.
 * An official court, prosecutor or regulator record is never dropped whole for a sensitive word: only the
 * offending clause goes and the charge stays.
 */
const g = require('../../../src/server/founder/guardrails');
const { makeFinding } = require('../../../src/server/founder/finding');
const { createSubject } = require('../../../src/server/founder/identity');

const { cleanSentences, sanitizeFinding, cleanData, privacyReason } = g;

// [sentence, expected text after cleaning ('' when the whole sentence goes), reason counted (or null)]
const KEEP = (s) => [s, s, null];
const DROP = (s, reason) => [s, '', reason];
const TABLE = [
  // ---- health companies' own facts stay
  KEEP('Maven Clinic serves pregnant women and new parents.'),
  KEEP('Ro sells medication to pregnant patients.'),
  KEEP('Theranos tests led some patients to be wrongly diagnosed.'),
  KEEP('Patients were treated for conditions they did not have.'),
  KEEP('Patients were diagnosed with conditions they did not have.'),
  KEEP('Three patients were hospitalized after the recall.'),
  KEEP('Sales collapsed after a COVID-19 lockdown in 2020.'),
  KEEP('Their COVID response won praise.'),
  KEEP('Acme has diabetes customers in 40 states.'),
  KEEP('Cerebral faced a probe over drug use.'),
  KEEP('Hinge helps members who were diagnosed with anxiety find therapists.'),
  KEEP('Acme operates psychiatric hospitals in three states.'),
  // ---- health about the person goes
  DROP('Doe stepped down as CEO in 2021 to undergo treatment for cancer.', 'health'),
  DROP('She took a leave of absence to undergo treatment for breast cancer.', 'health'),
  DROP('He has been open about his long battle with depression.', 'health'),
  DROP('Doe spent time at a psychiatric hospital.', 'health'),
  DROP('She was diagnosed with breast cancer in 2019.', 'health'),
  DROP('She is pregnant with her second child.', 'minor'),
  DROP('She was pregnant when she raised the round.', 'health'),
  DROP('He was hospitalized in 2022.', 'health'),
  DROP('She treated patients and was diagnosed with cancer in 2020.', 'health'),
  DROP('He admitted to drug use in college.', 'health'),
  DROP('His drug use worried the board.', 'health'),
  DROP('He was treated for anxiety.', 'health'),
  // ---- sexuality: a person's own, not a name or a company's customers
  KEEP('Gay Gaddis, founder of T3, on building an agency.'),
  KEEP('Gay Gaddis founded T3 in 1989.'),
  KEEP('Folx Health is a healthcare startup for queer and transgender people.'),
  KEEP('The Gay Area Youth Coalition gave Acme an award.'),
  DROP('He is openly gay.', 'sexuality'),
  DROP('She came out as lesbian in 2015.', 'sexuality'),
  DROP('Doe is gay and lives with his partner.', 'sexuality'),
  DROP('He lives with his same-sex partner.', 'sexuality'),
  // ---- children: the surname Son is not a son
  KEEP('SoftBank shareholders grilled their chairman Son over the losses.'),
  KEEP('Son, 12 years after founding SoftBank, bought Vodafone Japan.'),
  KEEP('Spurs welcomed Son back after the injury.'),
  DROP('Her son, 12, attends school in Palo Alto.', 'minor'),
  DROP('He welcomed a son in 2020.', 'minor'),
  DROP('Their son joined them at the event.', 'minor'),
  // ---- immigration: the person's own status, not a company's contracts or a fraud scheme
  KEEP("Palantir's software has been used by ICE in deportation operations."),
  KEEP('The company sponsored H-1B visas for 300 engineers.'),
  KEEP('Doe promised investors a path to a green card through the EB-5 program.'),
  KEEP('Silicon Valley CEO sentenced for H-1B visa fraud scheme.'),
  DROP('He came to the US on a student visa.', 'immigration'),
  DROP('She obtained a green card in 2012.', 'immigration'),
  DROP('Doe faced deportation in 2008.', 'immigration'),
  DROP('He was undocumented until 2010.', 'immigration'),
  DROP('She came to Canada as a refugee.', 'immigration'),
  // ---- religion: the person's faith, not a business word
  KEEP('The software served a mission-critical function for the Navy.'),
  KEEP('She chairs a Jewish family foundation that funds hospitals.'),
  DROP('Doe served a Mormon mission in Brazil.', 'religion'),
  DROP('She is a devout Catholic.', 'religion'),
  // ---- political donations go; a crime about campaign money stays
  KEEP('Bankman-Fried was charged with wire fraud and conspiracy to make illegal political contributions.'),
  KEEP('Doe made illegal political contributions through straw donors.'),
  DROP('Doe donated $50,000 to the Republican Party.', 'politics'),
  DROP('He is a major Democratic donor.', 'politics'),
  // ---- relatives: the subject's own role later in the sentence is not the relative's
  DROP('Milton, whose wife Carrie is often at his side, is the founder of Nikola.', 'relatives'),
  DROP('He met his wife Sarah at Stanford, where he founded his first startup.', 'relatives'),
  KEEP('Her father, John Roe, is the founder of Acme.'),
  KEEP('Her father, who is CEO of Roe Capital, invested in Acme.'),
  KEEP('He co-founded Nikola with his brother.'),
];

describe('table: what is kept and what is removed', () => {
  test.each(TABLE)('%s', (sentence, expected, reason) => {
    const out = cleanSentences(sentence);
    expect(out.text).toBe(expected);
    if (reason) expect(out.removed[reason]).toBeGreaterThan(0);
    else expect(out.removed).toEqual({});
  });
  test('the table has at least sixty sentences', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(60);
  });
});

// [sentence, text that must not be left, text that must be left]
const REDACT = [
  ['Call her at +33 1 42 68 53 00', '42 68', 'Call her at'],
  ['Reach him on +49 30 12345678', '12345678', 'Reach him on'],
  ['Her mobile is 06 12 34 56 78', '34 56', 'Her mobile is'],
  ['Office line +91 98765 43210', '98765', 'Office line'],
  ['Email jane dot doe at gmail dot com', 'gmail', 'Email'],
  ['Phone: 4155 5501 00 for the office', '5501', 'Phone'],
  ['Doe, a 1984-born entrepreneur, founded Acme.', '1984', 'founded Acme'],
  ['Doe was born in the spring of 1984 in Lyon.', '1984', 'born in Lyon'],
  ['Doe was born in late 1984.', '1984', 'Doe was born'],
  ['He celebrated his 40th birthday in Ibiza.', '40th', 'birthday in Ibiza'],
  ['Doe turned 40 last year.', '40', 'Doe'],
  ['Doe (44) founded Acme.', '44', 'Doe founded Acme'],
];

describe('redactions of contact details, birth years and ages', () => {
  test.each(REDACT)('%s', (sentence, gone, kept) => {
    const out = cleanSentences(sentence).text;
    expect(out).not.toContain(gone);
    expect(out).toContain(kept);
  });
  test('a 1984-born entrepreneur keeps a grammatical article', () => {
    expect(cleanSentences('Doe, a 1984-born entrepreneur, founded Acme.').text).toBe('Doe, an entrepreneur, founded Acme.');
  });
  test('record numbers, years and a footnote are not phones or ages', () => {
    for (const s of [
      'SIREN 123 456 789 registered in Paris.',
      'Revenue rose in 2019 2020 2021 each year.',
      'Acme (2019) is a case about patents.',
      'See note (4) on page 12.',
      'The company has 12 345 678 shares outstanding.',
    ]) expect(cleanSentences(s).text).toBe(s);
  });
});

describe('official court, prosecutor and regulator records are never dropped whole for a sensitive word', () => {
  const doj = (title, quote) => ({ source: 'doj-press-releases', category: 'regulatory', title, quote, url: 'https://www.justice.gov/usao/pr/x', match: 'possible' });
  test('the five DOJ and FDA records from the review all stay', () => {
    const recs = [
      doj('Silicon Valley CEO sentenced for H-1B visa fraud scheme', 'Jane Doe was sentenced to 30 months.'),
      doj('Developer charged in EB-5 fraud', 'Doe promised investors a path to a green card through the EB-5 program.'),
      doj('Executive pleads guilty to campaign finance crimes', 'Doe made illegal political contributions through straw donors.'),
      doj('Clinic owner convicted of health care fraud', 'Patients were diagnosed with conditions they did not have.'),
      { ...doj('Acme recalls infusion pumps', 'Three patients were hospitalized.'), source: 'fda-recalls' },
    ];
    for (const r of recs) {
      const f = sanitizeFinding(r);
      expect(f).not.toBeNull();
      expect(f.quote).toBe(r.quote);
    }
  });
  test('in an official record only the private clause goes; the charge stays', () => {
    const f = sanitizeFinding(doj('Doe sentenced for wire fraud', 'Doe, who was diagnosed with cancer in 2019, was sentenced to 5 years for wire fraud.'));
    expect(f).not.toBeNull();
    expect(f.quote).not.toMatch(/cancer|diagnosed/);
    expect(f.quote).toMatch(/sentenced to 5 years for wire fraud/);
  });
  test('an official record whose title names a private matter keeps the charge and loses the private clause', () => {
    const f = sanitizeFinding(doj('Doe, who is HIV-positive, charged with securities fraud', 'Doe was charged with securities fraud.'));
    expect(f).not.toBeNull();
    expect(f.title).not.toMatch(/HIV/);
    expect(f.title).toMatch(/charged with securities fraud/);
  });
  test('an official record keeps its title when every quote sentence was private', () => {
    const f = sanitizeFinding(doj('Doe charged with wire fraud', 'She was diagnosed with cancer.'));
    expect(f).not.toBeNull();
    expect(f.title).toBe('Doe charged with wire fraud');
    expect(f.quote).toBe('');
  });
  test('a minor in an official title still drops the record, and a press record is still dropped for a private title', () => {
    expect(sanitizeFinding(doj('J.D., a minor, by and through her mother v. Doe', 'Complaint filed.'))).toBeNull();
    expect(sanitizeFinding({ source: 'web-search', category: 'press', title: 'Doe was diagnosed with cancer', quote: '', url: 'https://example.com/a', match: 'likely' })).toBeNull();
  });
  test('a press record still loses the whole private sentence, not just a clause', () => {
    const f = sanitizeFinding({ source: 'web-search', category: 'press', title: 'Doe sentenced', quote: 'Doe, who was diagnosed with cancer in 2019, was sentenced. Acme closed.', url: 'https://example.com/a', match: 'likely' });
    expect(f.quote).toBe('Acme closed.');
  });
});

describe('subjects named Gay or Son keep their records', () => {
  test('makeFinding for Gay Gaddis keeps the record about her', () => {
    const s = createSubject({ name: 'Gay Gaddis', company: 'T3' });
    const f = makeFinding(s, { source: 'web-search', sourceLabel: 'Web', category: 'press', title: 'Gay Gaddis, founder of T3, on building an agency', quote: 'Gay Gaddis founded T3 in 1989.', url: 'https://example.com/gg' });
    expect(f).not.toBeNull();
    expect(f.title).toMatch(/Gay Gaddis/);
  });
  test('the quick brief keeps a search result about Gay Gaddis', () => {
    const { cleanSearchResult } = require('../../../src/server/founderCheck');
    const r = cleanSearchResult({ title: 'Gay Gaddis - T3 founder', url: 'https://example.com/gg', snippet: 'Gay Gaddis founded T3 in 1989.' });
    expect(r).not.toBeNull();
    expect(r.title).toBe('Gay Gaddis - T3 founder');
  });
  test('a Masayoshi Son title is not a minor', () => {
    expect(privacyReason('Son, 12 years after founding SoftBank, bought Vodafone Japan', { kin: false })).toBeNull();
    expect(privacyReason('Son Heung-min, 31, signs new deal', { kin: false })).toBeNull();
    const s = createSubject({ name: 'Masayoshi Son', company: 'SoftBank' });
    const f = makeFinding(s, { source: 'web-search', sourceLabel: 'Web', category: 'press', title: 'Shareholders grill their chairman Son over losses', quote: 'Masayoshi Son, chairman of SoftBank, answered questions.', url: 'https://example.com/son' });
    expect(f).not.toBeNull();
  });
});

describe('structured data birth, nationality and residence fields', () => {
  test('born, yearOfBirth, monthOfBirth, nationality, citizenship and countryOfResidence are dropped', () => {
    const { data } = cleanData({ person: { name: 'Jane Doe', born: 'March 1984', nationality: 'British', citizenship: 'UK', countryOfResidence: 'England', placeOfBirth: 'Leeds' }, yearOfBirth: 1984, monthOfBirth: 3, dateOfDeath: '2020-01-01', role: 'Director' });
    expect(data).toEqual({ person: { name: 'Jane Doe' }, role: 'Director' });
  });
});
