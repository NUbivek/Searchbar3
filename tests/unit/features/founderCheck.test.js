jest.mock('../../../src/utils/sources/curatedIndex', () => ({
  searchCuratedSources: jest.fn(),
  searchCuratedForEntity: jest.fn(async () => []),
  getCuratedIndexStatus: jest.fn(() => ({ ready: true, itemsAvailable: 3000, indexableSources: 135 })),
}));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(), PROVIDERS: [{ id: 'groq' }], providerEnabled: jest.fn(() => false) }));
jest.mock('../../../src/utils/sources/hackernewsAlgolia', () => ({ searchHackerNews: jest.fn() }));

const {
  runFounderCheck, extractFounderEvidence, extractProfiles, nameMatcher, nameVariants, companyKeys,
  normalizePersonName, completeBriefSections, LITIGATION_DISCLAIMER, BRIEF_SECTIONS,
} = require('../../../src/server/founderCheck');

const R = (over) => ({ title: 'Untitled', url: `https://example.com/${Math.abs(JSON.stringify(over).length)}-${over.title}`, content: '', source: 'curated', sourceName: 'Example News', publishedAt: '2024-06-01T00:00:00Z', ...over });

const RESULTS = [
  R({ title: 'Mistral raises funding', url: 'https://news.example/a', content: 'Jane Doe co-founded Acme Robotics in 2019 with two partners. In 2015, Jane Doe joined Google DeepMind as a researcher. Mistral is growing fast.' }),
  R({ title: 'Profile', url: 'https://news.example/b', content: 'Jane Doe was previously at Initech before starting her company. She is the former CTO of Globex Corp according to filings.' }),
  R({ title: 'Different Jane', url: 'https://news.example/c', content: 'jane doe is mentioned in lowercase here in 2010 when she joined Foo Inc. Jane Doelittle founded Bar Ltd in 2012.' }),
  R({ title: 'Jane Doe sued by former employer', url: 'https://news.example/d', content: 'The lawsuit alleges that Jane Doe took trade secrets in 2021 when she left.' }),
];

const searchersWith = (results) => ({
  curated: async () => results, hackernews: async () => [], web: async () => [],
  courtlistener: async () => { throw new Error('CourtListener skipped: requires token'); },
  webConfigured: () => false,
});

function allItems(out) {
  return [...out.timeline, ...out.pastCompanies, ...out.litigation, ...out.press, ...out.mentions];
}

describe('founderCheck extraction', () => {
  test('strict, case-sensitive full-name matching', () => {
    const m = nameMatcher('Jane Doe');
    expect(m('Jane Doe joined.')).toBe(true);
    expect(m('jane doe joined.')).toBe(false);
    expect(m('Jane Doelittle joined.')).toBe(false);
    expect(m('J. Doe joined.')).toBe(false);
    const out = extractFounderEvidence({ name: 'Jane Doe', results: RESULTS });
    for (const item of allItems(out)) expect(item.quote).toMatch(/Jane Doe(?![a-z])/);
    expect(out.sources.map((s) => s.url)).not.toContain('https://news.example/c');
  });

  test('years extracted and timeline sorted ascending', () => {
    const out = extractFounderEvidence({ name: 'Jane Doe', results: RESULTS });
    const years = out.timeline.map((t) => t.year);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    const fromSentence = out.timeline.filter((t) => t.yearFrom === 'sentence');
    expect(fromSentence.map((t) => t.year)).toEqual([2015, 2019, 2021]);
    for (const t of fromSentence) expect(t.quote).toContain(String(t.year));
    // sentences with a role word but no year take the source's year
    for (const t of out.timeline.filter((t) => t.yearFrom === 'source')) expect(t.year).toBe(2024);
  });

  test('past-company patterns', () => {
    const out = extractFounderEvidence({ name: 'Jane Doe', results: RESULTS });
    const companies = out.pastCompanies.map((c) => c.company);
    expect(companies).toEqual(expect.arrayContaining(['Acme Robotics', 'Initech', 'Google DeepMind']));
    expect(companies).not.toContain('Bar Ltd');
    expect(companies).not.toContain('Foo Inc');
    // "former CTO of Globex Corp" sentence does not contain the name, so it is not used.
    expect(companies).not.toContain('Globex Corp');
    expect(out.pastCompanies.find((c) => c.company === 'Acme Robotics').status).toBe('founded');
    expect(out.pastCompanies.find((c) => c.company === 'Initech').status).toBe('past');
  });

  test('company ranking and possible-different-person flag', () => {
    const out = extractFounderEvidence({ name: 'Jane Doe', company: 'Mistral', results: RESULTS });
    expect(out.mentions[0].mentionsCompany).toBe(true); // "Mistral raises funding" ranks first
    const flagged = [...out.press, ...out.mentions].filter((p) => p.possibleDifferentPerson).map((p) => out.sources[p.sourceIndex].url);
    expect(flagged).toEqual(expect.arrayContaining(['https://news.example/b', 'https://news.example/d']));
    expect(flagged).not.toContain('https://news.example/a');
  });

  test('every item has a valid sourceIndex', () => {
    const out = extractFounderEvidence({ name: 'Jane Doe', company: 'Mistral', results: RESULTS });
    expect(allItems(out).length).toBeGreaterThan(0);
    for (const item of allItems(out)) {
      expect(Number.isInteger(item.sourceIndex)).toBe(true);
      expect(out.sources[item.sourceIndex]).toBeDefined();
      expect(out.sources[item.sourceIndex].url).toMatch(/^https:\/\//);
    }
    out.sources.forEach((s, i) => expect(s.n).toBe(i + 1));
  });
});

describe('founderCheck extraction: real-world phrasings (from live outputs)', () => {
  const HN = (title, created, over = {}) => ({ title, url: `https://hn.example/${encodeURIComponent(title)}`, content: '', snippet: '', source: 'hackernews', timestamp: created, ...over });

  test('headline-only sources get a timeline year from the source date, never a future year', () => {
    const out = extractFounderEvidence({
      name: 'Sam Altman',
      results: [
        HN("OpenAI's board has fired Sam Altman", '2023-11-17T20:00:00Z'),
        HN('Sam Altman returns as CEO, OpenAI has a new initial board', '2023-11-30T00:00:00Z'),
        HN('I Am Sam Altman, President of Y Combinator. AMA', '2015-05-01T00:00:00Z'),
        HN('Tesla will discontinue Cybertruck production in 2027, CEO Elon Musk announced on X.', '2026-10-01T00:00:00Z', { title: 'Tesla will discontinue Cybertruck production in 2027, CEO Sam Altman announced on X.' }),
        HN('Mistral AI, led by Sam Altman, plans to open a data centre in 2027.', '2026-10-01T00:00:00Z'),
      ],
    });
    const years = out.timeline.map((t) => [t.year, t.yearFrom]);
    expect(years).toEqual([[2015, 'source'], [2023, 'source'], [2023, 'source']]);
    expect(out.timeline.every((t) => t.year <= new Date().getFullYear())).toBe(true);
    expect(out.timeline.map((t) => t.quote).join(' ')).not.toMatch(/2027/);
  });

  test('"CEO of X" and "previously a researcher at Y" are captured; current role is identified', () => {
    const out = extractFounderEvidence({
      name: 'Arthur Mensch',
      company: 'Mistral AI',
      results: [
        R({ title: 'Discussion w Arthur Mensch, CEO of Mistral AI', url: 'https://news.example/m1', content: 'Arthur Mensch, CEO of Mistral AI, was previously a researcher at Google DeepMind.' }),
        R({ title: 'Fireside Chat with Mistral CEO, Arthur Mensch [video]', url: 'https://news.example/m2', source: 'hackernews', content: '' }),
      ],
    });
    const byName = Object.fromEntries(out.pastCompanies.map((c) => [c.company, c]));
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(['Mistral AI', 'Google DeepMind']));
    expect(byName['Mistral AI'].status).toBe('current');
    expect(byName['Mistral AI'].role).toBe('CEO');
    expect(byName['Google DeepMind'].status).toBe('past');
    expect(out.currentRole).toEqual(expect.objectContaining({ role: 'CEO', company: 'Mistral AI' }));
    // "Mistral" counts as mentioning "Mistral AI": no false different-person flag
    const flagged = allItems(out).filter((x) => x.possibleDifferentPerson);
    expect(flagged).toEqual([]);
    // headline-only source that cannot name the company is marked unknown, not different
    const fireside = out.press.find((p) => /Fireside/.test(p.title));
    expect(fireside.mentionsCompany).toBe(true);
  });

  test('role words about someone else in the sentence are not attributed to the person', () => {
    const out = extractFounderEvidence({
      name: 'Jane Doe',
      results: [R({ title: 'Panel', url: 'https://news.example/p', content: 'Jane Doe spoke on a panel. Later that day, the audience heard from the new CEO of Megacorp Industries, who joined Megacorp Industries in 2020 after a long career, said Bob.' })],
    });
    expect(out.pastCompanies.map((c) => c.company)).not.toContain('Megacorp Industries');
  });

  test('education: no false positives from MA/MS/degree/studies; real schools kept', () => {
    const out = extractFounderEvidence({
      name: 'Jane Doe',
      results: [
        R({ title: 'Talk', url: 'https://news.example/e1', content: 'Jane Doe, based in Boston, MA, spoke at Harvard University about robotics.' }),
        R({ title: 'Demand', url: 'https://news.example/e2', content: 'Jane Doe studies demand at Acme Corp.' }),
        R({ title: 'Control', url: 'https://news.example/e3', content: 'Jane Doe has a degree of control at Globex Corp.' }),
        R({ title: 'Office', url: 'https://news.example/e4', content: 'Jane Doe said the MS Office rollout at Initech Corp took a year.' }),
        R({ title: 'Bio', url: 'https://news.example/e5', content: 'Jane Doe graduated from Stanford University in 2012 and studied mathematics at École Polytechnique. Jane Doe holds an MBA from INSEAD.' }),
      ],
    });
    expect(out.education.map((e) => e.school)).toEqual(['Stanford University', 'École Polytechnique', 'INSEAD']);
  });

  test('litigation: legal context required; non-legal "settled"/"probe"/"charged" excluded', () => {
    const out = extractFounderEvidence({
      name: 'Jane Doe',
      results: [
        R({ title: 'Jane Doe settled in San Francisco after a probe into the market', url: 'https://news.example/l1' }),
        R({ title: 'Jane Doe Settles SEC Fraud Charges', url: 'https://news.example/l2' }),
        R({ title: 'Jane Doe charged customers twice, company says', url: 'https://news.example/l3' }),
        R({ title: 'Judge rules Jane Doe must face investors’ complaint', url: 'https://news.example/l4' }),
        R({ title: 'Court docket', url: 'https://news.example/l5', source: 'courtlistener', sourceName: 'CourtListener', content: 'Doe v. Acme (N.D. Cal.). Jane Doe is the defendant.' }),
      ],
    });
    const quotes = out.litigation.map((l) => l.quote);
    expect(quotes).toContain('Jane Doe Settles SEC Fraud Charges');
    expect(quotes).toContain('Judge rules Jane Doe must face investors’ complaint');
    expect(quotes.join(' ')).not.toMatch(/probe into the market|charged customers/);
    expect(out.litigation.some((l) => out.sources[l.sourceIndex].sourceName === 'CourtListener')).toBe(true);
  });

  test('press (name in headline) is separated from other mentions', () => {
    const out = extractFounderEvidence({
      name: 'Paul Graham',
      results: [
        R({ title: 'Paul Graham on SICP', url: 'https://news.example/pg1', content: '' }),
        R({ title: 'Repl.it raises $4.5M from A16Z and others', url: 'https://news.example/pg2', content: 'Investors include Paul Graham and others.' }),
      ],
    });
    expect(out.press.map((p) => p.title)).toEqual(['Paul Graham on SICP']);
    expect(out.mentions.map((p) => p.title)).toEqual(['Repl.it raises $4.5M from A16Z and others']);
  });

  test('company keys ignore suffixes and punctuation', () => {
    expect(companyKeys('Mistral AI, Inc.')).toEqual(['mistral']);
    expect(companyKeys('Google DeepMind')).toEqual(['google deepmind']);
    expect(companyKeys('Ramp')).toEqual(['ramp']);
  });
});

describe('name handling', () => {
  test('variants drop a middle initial; quotes and possessives are stripped', () => {
    expect(nameVariants('Paul J. Graham')).toEqual(['Paul J. Graham', 'Paul Graham']);
    expect(nameVariants('Paul Graham')).toEqual(['Paul Graham']);
    expect(nameVariants('Mary Ann Smith')).toEqual(['Mary Ann Smith']);
    expect(normalizePersonName('"Arthur" Mensch\'s')).toBe('Arthur Mensch');
    expect(normalizePersonName('  sam   altman ')).toBe('sam altman');
  });

  test('a name with an initial also matches the source without it, and the result says so', async () => {
    const out = await runFounderCheck({ name: 'Paul J. Graham' }, {
      searchers: searchersWith([R({ title: 'Paul Graham on startups', url: 'https://news.example/pg', content: 'Paul Graham co-founded Y Combinator in 2005.' })]),
    });
    expect(out.sources).toHaveLength(1);
    expect(out.name).toBe('Paul Graham');
    expect(out.warnings.join(' ')).toMatch(/without|match "Paul Graham"/);
    expect(out.pastCompanies.map((c) => c.company)).toContain('Y Combinator');
  });

  test('lowercase typed name finds the capitalized name in a source', () => {
    const match = nameMatcher('bivek adhikari');
    expect(match('Interview with Bivek Adhikari, founder of Acme.')).toBe(true);
  });
  test('still requires the source to write it as a proper name', () => {
    const match = nameMatcher('Grace Hopper');
    expect(match('the grace hopper conference schedule')).toBe(false);
    expect(match('Grace Hopper wrote the first compiler.')).toBe(true);
    expect(match('G. Hopper wrote it')).toBe(false);
  });
});

describe('runFounderCheck', () => {
  test('empty sources: nothing invented, no brief, litigation disclaimer present, unavailable and searched sources listed', async () => {
    const out = await runFounderCheck({ name: 'Nobody Known' }, {
      searchers: { ...searchersWith([]), hackernews: async () => [] },
    });
    expect(out.timeline).toEqual([]);
    expect(out.pastCompanies).toEqual([]);
    expect(out.litigation).toEqual([]);
    expect(out.press).toEqual([]);
    expect(out.sources).toEqual([]);
    expect(out.brief).toBeNull();
    expect(out.briefInfo).toBeNull();
    expect(out.litigationDisclaimer).toBe(LITIGATION_DISCLAIMER);
    expect(out.litigationDisclaimer).toMatch(/NOT evidence of a clean record/);
    const names = out.unavailableSources.map((u) => u.source);
    expect(names).toEqual(expect.arrayContaining(['Web search', 'CourtListener', 'LinkedIn']));
    expect(out.searchedSources).toEqual([{ source: 'Curated news index', results: 0 }, { source: 'Hacker News', results: 0 }]);
    expect(out.indexStatus).toEqual({ ready: true, items: 3000, sources: 135 });
  });

  test('merges searchers and dedupes by URL', async () => {
    const out = await runFounderCheck({ name: 'Jane Doe', company: 'Mistral' }, {
      searchers: {
        curated: async () => RESULTS, hackernews: async () => [RESULTS[3]], web: async () => RESULTS,
        courtlistener: async () => [], webConfigured: () => true,
      },
    });
    const urls = out.sources.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const item of allItems(out)) expect(out.sources[item.sourceIndex]).toBeDefined();
    expect(out.unavailableSources.map((u) => u.source)).not.toContain('Web search');
  });

  test('warns when the curated index is still loading', async () => {
    const out = await runFounderCheck({ name: 'Jane Doe' }, {
      searchers: { ...searchersWith(RESULTS), indexStatus: () => ({ ready: false, itemsAvailable: 120, indexableSources: 135 }) },
    });
    expect(out.warnings.join(' ')).toMatch(/still loading/);
    expect(out.indexStatus.ready).toBe(false);
  });
});

describe('founder check: profiles, education and brief', () => {
  const providers = require('../../../src/server/llm/providers');
  const results = [
    { title: 'Jane Doe - Co-Founder & CEO - Acme Robotics | LinkedIn', url: 'https://www.linkedin.com/in/janedoe', snippet: 'Experience: Acme Robotics · Education: Stanford University · Location: San Francisco', source: 'web' },
    { title: 'Jane Doe raises $20M for Acme Robotics', url: 'https://news.example/raise', content: 'Jane Doe, who graduated from Stanford University in 2012, raised $20M. In 2019, Jane Doe co-founded Acme Robotics.', source: 'web', publishedAt: '2026-01-01T00:00:00Z' },
  ];

  test('extracts public profile facts from LinkedIn search results', () => {
    const profiles = extractProfiles(results, nameMatcher('Jane Doe'));
    expect(profiles).toEqual([expect.objectContaining({ platform: 'LinkedIn', role: 'Co-Founder & CEO', company: 'Acme Robotics', education: 'Stanford University', location: 'San Francisco', sourceIndex: 0 })]);
  });

  test('generic LinkedIn titles do not become roles; Crunchbase "is the ROLE at COMPANY" is parsed', () => {
    const profiles = extractProfiles([
      { title: 'Jane Doe – San Francisco Bay Area | Professional Profile | LinkedIn', url: 'https://www.linkedin.com/in/jd2', snippet: '', source: 'web' },
      { title: 'Jane Doe - Crunchbase Person Profile', url: 'https://www.crunchbase.com/person/jane-doe', snippet: 'Jane Doe is the Co-Founder & CEO at Acme Robotics.', source: 'web' },
    ], nameMatcher('Jane Doe'));
    expect(profiles[0]).toEqual(expect.objectContaining({ role: null, company: null, location: 'San Francisco Bay Area' }));
    expect(profiles[1]).toEqual(expect.objectContaining({ platform: 'Crunchbase', role: 'Co-Founder & CEO', company: 'Acme Robotics' }));
  });

  test('extracts education with a source', () => {
    const ev = extractFounderEvidence({ name: 'Jane Doe', results, keepAllSources: true });
    expect(ev.education.map((e) => e.school)).toContain('Stanford University');
    expect(ev.sources).toHaveLength(2);
    expect(ev.sources[0]).toEqual(expect.objectContaining({ via: 'Web', dateLabel: 'published' }));
  });

  test('quoted brief when no model is configured; AI brief when valid, with missing sections completed', async () => {
    const searchers = { ...searchersWith(results), courtlistener: async () => [] };
    providers.providerEnabled.mockReturnValue(false);
    const quoted = await runFounderCheck({ name: 'jane doe' }, { searchers });
    expect(quoted.briefInfo.mode).toBe('quoted');
    expect(quoted.brief).toMatch(/## CAREER TIMELINE[\s\S]*2019/);
    expect(quoted.brief).toMatch(/NOT evidence of a clean record/);
    expect(quoted.brief).toMatch(/Most recent role found: Co-Founder/i);
    expect(quoted.brief).toMatch(/Ask references about the reasons for each move between/);

    providers.providerEnabled.mockReturnValue(true);
    providers.chatComplete.mockResolvedValue({
      text: '## SUMMARY\nJane Doe co-founded Acme Robotics [Source 1].\n## CAREER TIMELINE\n• 2019: co-founded Acme [Source 2]\n## PAST COMPANIES AND ROLES\n• Acme [Source 1] [Source 7]\n## EDUCATION\n• Stanford [Source 2]\n## PRESS AND PUBLIC STATEMENTS\n• Raised $20M [Source 2]\n## RED FLAGS AND OPEN QUESTIONS\n• Confirm role history.\nCONFIDENCE: Medium - two sources',
      provider: 'groq', providerLabel: 'Groq', model: 'openai/gpt-oss-120b',
    });
    const ai = await runFounderCheck({ name: 'Jane Doe' }, { searchers });
    expect(ai.briefInfo).toEqual(expect.objectContaining({ mode: 'ai', model: 'openai/gpt-oss-120b', confidence: { level: 'Medium', reason: 'two sources' } }));
    expect(ai.brief).not.toMatch(/Source 7/); // invented citation removed
    for (const h of BRIEF_SECTIONS) expect(ai.brief).toContain(h);
    expect(ai.brief).toMatch(/## LITIGATION AND REGULATORY\nNot found in the available sources\.\n\n\*Absence of litigation/);
    // sections stay in order
    const idx = BRIEF_SECTIONS.map((h) => ai.brief.indexOf(h));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  test('completeBriefSections leaves a complete brief untouched', () => {
    const full = BRIEF_SECTIONS.map((h) => `${h}\nx`).join('\n');
    expect(completeBriefSections(full)).toBe(full);
  });
});
