/**
 * Round 3 (audit 2026-11-20): one shared matcher for "does this text name the
 * person, and their company?" used by the quick brief and the deep check.
 * Each block is one audit finding in eval/founder/audit-2026-11-20/by-owner/identity.json.
 */
const names = require('../../../src/server/founder/names');
const {
  createSubject, matchSubject, addAnchor, addEventAnchor, addCompanyAlias, exportAnchors, restoreSubject, companyKeyStrict,
} = require('../../../src/server/founder/identity');
const { nameMatcher, normalizePersonName, companyMatcher, companyKeys, runFounderCheck } = require('../../../src/server/founderCheck');

const grade = (name, company, text, opts) => matchSubject(createSubject({ name, company }), text, opts).level;

describe('identity-name-variants-false-negatives: the person written another way', () => {
  test.each([
    ['Eric Glyman', 'Eric M. Glyman, co-founder of Ramp, said'],
    ['Eric Glyman', 'Eric Robert Glyman, co-founder of Ramp, said'],
    ['Eric Glyman', 'Eric Robert GLYMAN, co-founder of Ramp, said'],
    ['Eric Glyman', 'GLYMAN, ERIC M, an officer of Ramp'],
    ['Eric Glyman', 'Glyman, Eric, chief executive of Ramp'],
    ['Elizabeth Anne Holmes', 'Elizabeth Holmes, founder of Theranos'],
    ['John Smith Jr.', 'John Smith, founder of Theranos'],
    ['Dr. John Smith', 'John Smith, founder of Theranos'],
    ['Jose Garcia', 'José García, founder of Theranos'],
    ['José García', 'Jose Garcia, founder of Theranos'],
    ['Jean-Pierre Martin', 'Jean Pierre Martin, founder of Theranos'],
    ['Jean Pierre Martin', 'Jean-Pierre Martin, founder of Theranos'],
    ['Juan Vélez', 'Juan Velez, founder of Theranos'],
  ])('%s is found in "%s"', (name, text) => {
    const company = /Ramp/.test(text) ? 'Ramp' : 'Theranos';
    expect(grade(name, company, text)).toBe('confirmed');
  });

  test.each([
    ['John Smith', 'Jane Smith, founder of Theranos', 'other-given'],
    ['Eric Glyman', 'E. Glyman, co-founder of Theranos', 'initials'],
    ['John Smith', 'John Smith-Jones, founder of Theranos', 'longer-surname'],
    ['William Smith', 'Bill Smith, founder of Theranos', 'nickname'],
    ['Elizabeth Anne Holmes', 'Elizabeth Marie Holmes, founder of Theranos', 'other-middle'],
  ])('%s is never the full name in "%s" (a weaker %s match)', (name, text, kind) => {
    const r = matchSubject(createSubject({ name, company: 'Theranos' }), text);
    expect(r.level).toBe('none');
    expect(r.weak).toBe(kind);
    expect(nameMatcher(name)(text)).toBe(false);
  });

  test('surname first without a comma: possible alone, likely beside the company, never confirmed', () => {
    expect(grade('Wang Xiaoming', 'Theranos', 'Xiaoming Wang spoke at the conference')).toBe('possible');
    expect(grade('Wang Xiaoming', 'Theranos', 'Xiaoming Wang, founder of Theranos, spoke')).toBe('likely');
  });

  test('a conflicting generational suffix is another person', () => {
    expect(grade('John Smith Jr.', 'Theranos', 'John Smith Sr., founder of Theranos')).toBe('none');
    expect(grade('John Smith Jr.', 'Theranos', 'John Smith Jr., founder of Theranos')).toBe('confirmed');
  });

  test('normalizePersonName drops titles and suffixes and reads "Surname, Given"', () => {
    expect(normalizePersonName('Dr. John Smith Jr.')).toBe('John Smith');
    expect(normalizePersonName('Glyman, Eric')).toBe('Eric Glyman');
    expect(normalizePersonName('John Smith, Jr.')).toBe('John Smith');
  });

  test('accents are folded both ways and positions stay in the original text', () => {
    const m = names.personNameMatcher('Jose Garcia');
    const text = 'Said José García today';
    expect(m.positions(text)[0]).toMatchObject({ start: 5, end: 16, text: 'José García' });
    const decomposed = 'Said José García today';
    expect(m.positions(decomposed)[0].text).toBe('José García');
  });
});

describe('identity-hyphen-boundary: a longer hyphenated surname is someone else', () => {
  test('John Smith-Jones is not John Smith', () => {
    expect(grade('John Smith', 'Ramp', 'John Smith-Jones, founder of Ramp')).toBe('none');
    expect(nameMatcher('John Smith')('John Smith-Jones joined')).toBe(false);
    expect(nameMatcher('John Smith')("John Smith's company")).toBe(true);
    expect(nameMatcher('Mary Smith')('Anne-Mary Smith joined')).toBe(false);
  });
});

describe('identity-oneword-written-as-name: a one-word company must be used as a company', () => {
  test('isOrdinaryWordCompany', () => {
    for (const c of ['Ramp', 'Merge', 'Plaid', 'Notion', 'Square', 'Apple', 'Target', 'Merge Labs', 'Figure AI', 'Notion Labs', 'Harvey AI']) expect(names.isOrdinaryWordCompany(c)).toBe(true);
    for (const c of ['Theranos', 'Nikola', 'Mistral AI', 'dHybrid Systems', 'Silicon Valley Bank']) expect(names.isOrdinaryWordCompany(c)).toBe(false);
  });

  test.each([
    ['Ramp', "After a failed partnership, Ramp's backers lobbied Washington to probe rival Airwallex's China ties", true],
    ['Ramp', 'Body found near Misty Water Boat Ramp identified, homicide investigation underway', false],
    ['Ramp', "Son-in-law of 'The Ramp' church founder fired", false],
    ['Merge', 'Mainnet Merge Announcement', false],
    ['Merge', 'Merge raises $55M Series B led by Accel', true],
    ['Ramp', 'Ramp up: John Smith was charged with fraud.', false],
    ['Plaid', 'Wearing a Plaid shirt, John Smith left', false],
    ['Merge Labs', 'Banks to Merge After John Smith Charged With Fraud', false],
    ['Figure AI', 'Figure 3: John Smith in court', false],
    ['Harvey AI', 'Harvey Weinstein accuser John Smith testified', false],
    ['Notion Labs', 'The Notion that John Smith lied', false],
    ['Ramp', 'Ramp up the pressure, said John Smith', false],
    ['Ramp', 'Ramp Network raised money', false],
    ['Merge', 'Merge Labs raised money', false],
    ['Ramp', 'Eric Glyman, CEO of Ramp, said', true],
    ['Ramp', 'Ramp, Inc. filed', true],
    ['Ramp', 'see ramp.com for details', true],
  ])('%s in "%s" -> %s', (company, text, named) => {
    expect(names.companyMention(company, text).named).toBe(named);
  });

  test('the audit texts no longer confirm a namesake', () => {
    expect(grade('John Smith', 'Ramp', 'Ramp up: John Smith was charged with fraud.')).toBe('possible');
    expect(grade('John Smith', 'Plaid', 'Wearing a Plaid shirt, John Smith was charged.')).toBe('possible');
    expect(grade('John Smith', 'Merge Labs', 'Banks to Merge After John Smith Charged With Fraud')).toBe('possible');
    expect(grade('John Smith', 'Figure AI', 'Figure 3: John Smith was charged.')).toBe('possible');
    expect(grade('John Smith', 'Harvey AI', 'Harvey Weinstein accuser John Smith testified.')).toBe('possible');
    expect(grade('John Smith', 'Notion Labs', 'The Notion that John Smith lied is false.')).toBe('possible');
    expect(grade('John Smith', 'Ramp', 'Ramp up the pressure, said John Smith')).toBe('possible');
    expect(grade('Eric Glyman', 'Ramp', 'Ramp co-founder Eric Glyman said the company would expand.')).toBe('confirmed');
  });
});

describe('identity-generic-residue-keys: what is left after generic words never stands alone', () => {
  test.each([
    ['Silicon Valley Bank', 'John Smith, a Silicon Valley investor, was charged'],
    ['Bank of America', 'John Smith, president of America First, was charged'],
    ['Capital One', 'One of the defendants, John Smith, was charged'],
    ['Scale AI', 'Scale of the scheme: John Smith was charged'],
  ])('%s does not confirm "%s"', (company, text) => {
    expect(grade('John Smith', company, text)).toBe('possible');
  });

  test('the whole name still confirms', () => {
    // Bank of America and Capital One are very large employers: their whole name ties, but only to 'likely'
    // (identity2 finding critic-big-employer-typed-company); a smaller multi-word name confirms.
    expect(grade('John Smith', 'Bank of America', 'John Smith, an executive at Bank of America, was charged')).toBe('likely');
    expect(grade('John Smith', 'Capital One', 'John Smith of Capital One was charged')).toBe('likely');
    expect(grade('John Smith', 'Silicon Valley Bank', 'John Smith of Silicon Valley Bank was charged')).toBe('confirmed');
    expect(grade('John Smith', 'Scale AI', 'Scale AI co-founder John Smith said')).toBe('confirmed');
  });

  test('companyMatchForms keeps only safe forms', () => {
    expect(names.companyMatchForms('Bank of America').map((f) => f.form)).toEqual(['bank of america']);
    expect(names.companyMatchForms('Capital One').map((f) => f.form)).toEqual(['capital one']);
    expect(names.companyMatchForms('Silicon Valley Bank').map((f) => f.form)).toEqual(['silicon valley bank']);
    expect(names.companyMatchForms('Mistral AI, Inc.').map((f) => f.form)).toEqual(['mistral ai', 'mistral']);
    // grouping keys are unchanged for their callers
    expect(companyKeys('Mistral AI, Inc.')).toEqual(['mistral']);
    expect(companyKeyStrict('Mistral AI, Inc.')).toBe('mistral ai');
  });
});

describe('identity-cooccurrence-no-proximity: the name and the company close together, about the same person', () => {
  test('a company sentences away from a name tied to another firm does not confirm', () => {
    expect(grade('John Smith', 'Stripe', 'Stripe raised $1B. Separately, analyst John Smith of Morgan Stanley was charged with fraud.')).toBe('possible');
  });
  test('a company given to another person does not confirm', () => {
    expect(grade('John Smith', 'Theranos', 'John Smith praised Jane Doe, CEO of Theranos, at the event.')).toBe('possible');
    expect(grade('John Smith', 'Theranos', 'Theranos CEO Jane Doe and John Smith spoke.')).toBe('possible');
  });
  test('far apart in a long text does not confirm', () => {
    const filler = ' The weather was fine and the market moved sideways for most of the day.'.repeat(6);
    expect(grade('John Smith', 'Theranos', `Theranos opened a new lab.${filler} John Smith was charged.`)).toBe('possible');
  });
  test('close together still confirms', () => {
    expect(grade('John Smith', 'Theranos', 'Theranos opened a new lab. John Smith runs it.')).toBe('confirmed');
    expect(grade('John Smith', 'Theranos', 'John Smith | Theranos | founder')).toBe('confirmed');
  });
});

describe('identity-quickbrief-company-filter / quickbrief-company-filter-lowercase', () => {
  test('companyMatcher reads the company as a company, and near the person', () => {
    const hasCo = companyMatcher('Ramp', { person: nameMatcher('Jane Kowalski') });
    expect(hasCo('Jane Kowalski, Ohio dentist, charged with fraud ... began to ramp up')).toBe(false);
    expect(hasCo('Body of John Smith found near boat ramp')).toBe(false);
    expect(hasCo('Jane Kowalski, CEO of Ramp, said')).toBe(true);
    expect(hasCo.near('Jane Kowalski, CEO of Ramp, said', nameMatcher('Jane Kowalski'))).toBe(true);
    expect(companyMatcher('Merge Labs')('Two banks will merge; John Smith, a dentist, sued')).toBe(false);
    // profile titles from search results keep the company beside the name
    expect(hasCo.near('Jane Kowalski - Ramp | LinkedIn', nameMatcher('Jane Kowalski'))).toBe(true);
    expect(hasCo.near('Jane Kowalski – Co-Founder & CEO – Ramp | LinkedIn', nameMatcher('Jane Kowalski'))).toBe(true);
  });

  const searchersWith = (results) => ({
    curated: async () => [], hackernews: async () => [], courtlistener: async () => [],
    web: async () => results, webConfigured: () => true, indexStatus: () => null,
  });
  test('the quick brief leaves out namesake pages that use the company word as a word', async () => {
    const out = await runFounderCheck({ name: 'John Smith', company: 'Ramp', useLLM: false }, {
      searchers: searchersWith([
        { title: 'Body of John Smith found near boat ramp', url: 'https://news.example/a', snippet: 'Police said John Smith, 45, was found near the boat ramp.' },
        { title: 'Jane Kowalski news', url: 'https://news.example/c', snippet: 'John Smith, Ohio dentist, charged with fraud as prices began to ramp up.' },
        { title: 'Ramp names John Smith CFO', url: 'https://news.example/b', snippet: 'Ramp, the corporate card startup, named John Smith its chief financial officer.' },
      ]),
    });
    expect(out.sources.map((s) => s.url)).toEqual(['https://news.example/b']);
    expect(out.litigation).toEqual([]);
  });
  test('a page naming both far apart is left out', async () => {
    const filler = ' Shares of many firms moved in a narrow range through the session as traders waited.'.repeat(4);
    const out = await runFounderCheck({ name: 'John Smith', company: 'Theranos', useLLM: false }, {
      searchers: searchersWith([{ title: 'Markets wrap', url: 'https://news.example/d', snippet: `Theranos was mentioned once.${filler} John Smith, a local man, was charged with fraud.` }]),
    });
    expect(out.sources).toEqual([]);
  });
});

describe('alias: a fuller legal name learned from a tied record', () => {
  test('Ramp Business Corp ties its UK arm and its full name; a bare prefix never does', () => {
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    expect(matchSubject(s, 'Eric Glyman, director of Ramp Business UK Ltd').level).toBe('possible');
    expect(addCompanyAlias(s, { company: 'Ramp', alias: 'Ramp Business Corp', origin: 'sec-form-d-1' })).toBe(true);
    expect(addCompanyAlias(s, { company: 'Ramp', alias: 'Ramp Business Corp', origin: 'x' })).toBe(false);
    expect(addCompanyAlias(s, { company: 'Ramp', alias: 'Ramp', origin: 'x' })).toBe(false); // adds nothing
    expect(addCompanyAlias(s, { company: 'Unknown Co', alias: 'Unknown Holdings Inc' })).toBe(false); // not an anchor
    expect(matchSubject(s, 'Eric Glyman, director of Ramp Business UK Ltd').level).toBe('confirmed');
    expect(matchSubject(s, 'Eric Glyman, an officer of Ramp Business Corporation').level).toBe('confirmed');
    expect(matchSubject(s, 'Eric Glyman, an engineer at Ramp Network').level).toBe('possible');
    expect(addCompanyAlias(s, { company: 'Ramp', alias: 'https://ramp.com/about' })).toBe(true);
    expect(matchSubject(s, 'Eric Glyman wrote on ramp.com today').level).toBe('confirmed');
    const back = restoreSubject(JSON.parse(JSON.stringify({ name: s.name, company: s.company, anchors: exportAnchors(s) })));
    expect(exportAnchors(back).aliases).toEqual([
      { value: 'Ramp Business Corp', of: 'ramp', origin: 'sec-form-d-1' },
      { value: 'ramp.com', of: 'ramp', origin: 'found' },
    ]);
    expect(matchSubject(back, 'Eric Glyman, director of Ramp Business UK Ltd').level).toBe('confirmed');
  });
});

describe('identity-name-commonness: a very common name needs more', () => {
  test('isCommonName', () => {
    for (const n of ['John Smith', 'Wei Zhang', 'Jack Zhang', 'Maria Garcia', 'Mohammed Khan', 'Raj Patel', 'Jiwoo Kim']) expect(names.isCommonName(n)).toBe(true);
    for (const n of ['Trevor Milton', 'Eric Glyman', 'Elizabeth Holmes']) expect(names.isCommonName(n)).toBe(false);
    expect(names.nameCommonness('John Smith')).toEqual({ common: true, givenCommon: true, surnameCommon: true });
  });
  test('events and encyclopedia links never raise a common name; the company or a nearby anchor does', () => {
    const s = createSubject({ name: 'John Smith', company: 'Zentrix' });
    expect(s.common).toBe(true);
    addEventAnchor(s, { event: 'convicted', date: '2022-10-14', origin: 'rec-1' });
    addAnchor(s, 'companies', 'SoftBank', 'encyclopedia');
    expect(matchSubject(s, 'John Smith was convicted of fraud', { date: '2022-10-20' }).level).toBe('possible');
    expect(matchSubject(s, 'John Smith, SoftBank Near Settlement').level).toBe('possible');
    expect(matchSubject(s, 'John Smith, founder of Zentrix, was convicted').level).toBe('confirmed');
    addAnchor(s, 'schools', 'Stanford University', 'f1');
    expect(matchSubject(s, 'John Smith, a Stanford University graduate, spoke').level).toBe('likely');
  });
});

describe('identity-event-anchor-namesake: an event anchor needs the same matter', () => {
  const subject = () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    addEventAnchor(s, { event: 'convicted', date: '2022-10-14', origin: 'rec-7', docket: '1:21-cr-00478' });
    return s;
  };
  test('years later, without the matter: possible', () => {
    expect(matchSubject(subject(), 'Trevor Milton, a Utah man, was convicted of drunk driving', { date: '2024-03-01' }).level).toBe('possible');
  });
  test('within weeks: likely, unless the text describes someone else', () => {
    expect(matchSubject(subject(), 'Trevor Milton was convicted on all counts', { date: '2022-10-15' }).level).toBe('likely');
    expect(matchSubject(subject(), 'Trevor Milton, a Utah man, was convicted of drunk driving', { date: '2022-10-15' }).level).toBe('possible');
  });
  test('a shared docket ties it whatever the date, and the docket survives restore', () => {
    const back = restoreSubject({ name: 'Trevor Milton', company: 'Nikola', anchors: exportAnchors(subject()) });
    const r = matchSubject(back, 'Trevor Milton convicted, case 1:21-cr-00478', { date: '2024-09-01' });
    expect(r.level).toBe('likely');
    expect(r.basis).toEqual(['event']);
  });
});

describe('identity-encyclopedia-related-broad: very large organisations are not related anchors', () => {
  test('Harvard University and Google are refused; a small investor is kept', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Orbitly' });
    expect(addAnchor(s, 'companies', 'Harvard University', 'encyclopedia:x')).toBe(false);
    expect(addAnchor(s, 'companies', 'Google', 'encyclopedia:x')).toBe(false);
    expect(addAnchor(s, 'companies', 'Democratic Party', 'encyclopedia:x')).toBe(false);
    expect(matchSubject(s, 'Jane Roe, a Harvard University dentist, was sued').level).toBe('possible');
    expect(addAnchor(s, 'companies', 'Zentrix Ventures', 'encyclopedia:x')).toBe(true);
    const r = matchSubject(s, 'Jane Roe and Zentrix Ventures settle');
    expect(r).toMatchObject({ level: 'likely', basis: ['related'] });
    expect(names.isBroadOrganisation('Stanford University')).toBe(true);
    expect(names.isBroadOrganisation('Zentrix Ventures')).toBe(false);
  });
});

describe('knowledge-prefix-company-in-lists: a bare prefix in an organisation list', () => {
  test('Mercury Records, Mercury Insurance Group and Nikola Tesla Institute are other organisations', () => {
    expect(grade('John Smith', 'Mercury', 'John Smith; employer: Mercury Records')).toBe('possible');
    expect(grade('John Smith', 'Mercury', 'John Smith; University of Leeds; Mercury Insurance Group')).toBe('possible');
    expect(grade('Jane Roe', 'Nikola', 'Jane Roe; Nikola Tesla Institute')).toBe('possible');
    expect(grade('Trevor Milton', 'Nikola', 'Trevor Milton, owner of Nikola Motor Company LLC')).toBe('confirmed');
    expect(grade('John Smith', 'Mercury', 'John Smith; Mercury')).toBe('confirmed');
  });
});
