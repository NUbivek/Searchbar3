/**
 * Round 4, quick brief (src/server/founderCheck.js and the line checks in src/server/search/answer.js): a made-up
 * legal matter never passes on any citation, namesakes' items are flagged when the page asks which person is meant,
 * name-only pages stay out of the quoted brief's legal section, court records left out are said, wedding headlines
 * go, the fallback digest names no junk companies, and one counted check gives one model brief.
 */
jest.mock('../../../src/utils/sources/curatedIndex', () => ({
  searchCuratedSources: jest.fn(),
  searchCuratedForEntity: jest.fn(async () => []),
  getCuratedIndexStatus: jest.fn(() => ({ ready: true, itemsAvailable: 3000, indexableSources: 135 })),
}));
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => false),
  prepareChain: jest.fn(() => Promise.resolve()),
  reportAnswerQuality: jest.fn(async () => {}),
}));
jest.mock('../../../src/utils/sources/hackernewsAlgolia', () => ({ searchHackerNews: jest.fn(async () => []) }));

const providers = require('../../../src/server/llm/providers');
const {
  runFounderCheck, runFounderBrief, cleanSearchResult, checkFounderBrief, BRIEF_SECTIONS, __clearBriefCacheForTests,
} = require('../../../src/server/founderCheck');
const { checkClaims } = require('../../../src/server/search/answer');

const W = (o) => ({ snippet: '', source: 'web', sourceName: 'Web', publishedAt: '2025-01-01T00:00:00Z', ...o });
const searchersWith = (results, extra = {}) => ({
  curated: async () => [], hackernews: async () => [], courtlistener: async () => [],
  web: async () => results, webConfigured: () => true, indexStatus: () => null, ...extra,
});
function modelSays(...texts) {
  providers.providerEnabled.mockReturnValue(true);
  providers.chatComplete.mockImplementation(async (messages, opts) => {
    for (const text of texts) if (!opts.accept || opts.accept(text)) return { text, provider: 'groq', providerLabel: 'Groq', model: 'm', family: 'f' };
    return null;
  });
}
const section = (brief, h) => String(brief).split(h)[1].split('\n## ')[0];

beforeEach(() => {
  providers.chatComplete.mockReset();
  providers.providerEnabled.mockReset().mockReturnValue(false);
  providers.prepareChain.mockReset().mockReturnValue(Promise.resolve());
  providers.reportAnswerQuality.mockReset().mockResolvedValue();
  __clearBriefCacheForTests();
});

describe('quickbrief-fabricated-legal-claims-pass / weak-sources-outside-lit: a legal matter needs its words in a cited, tied source', () => {
  const src = new Map([
    [1, { text: 'Jane Doe - CEO - Acme Robotics | LinkedIn. Experience: Acme Robotics · Education: Stanford University' }],
    [2, { text: 'Jane Doe raises $20M for Acme Robotics. Jane Doe co-founded Acme Robotics in 2019 and raised $20M in a Series A.' }],
    [3, { text: 'Man named Jane Doe charged with fraud after a robbery in Ohio.', weak: true }],
    [4, { text: 'Acme Robotics founder Jane Doe was indicted on securities fraud charges and sued by Globex in 2022.' }],
  ]);
  const body = (parts) => {
    const all = {
      '## SUMMARY': 'Jane Doe co-founded Acme Robotics in 2019 [Source 2].',
      '## CAREER TIMELINE': '• 2019: Co-founded Acme Robotics [Source 2]',
      '## PAST COMPANIES AND ROLES': '• Acme Robotics [Source 1]',
      '## EDUCATION': '• Stanford University [Source 1]',
      '## LITIGATION AND REGULATORY': 'Not found in the available sources.',
      '## PRESS AND PUBLIC STATEMENTS': '• Raised $20M [Source 2]',
      '## RED FLAGS AND OPEN QUESTIONS': '• Confirm the role history with references.',
      ...parts,
    };
    return `${BRIEF_SECTIONS.map((h) => `${h}\n${all[h]}`).join('\n')}\nCONFIDENCE: Medium - few sources`;
  };
  const check = (parts) => checkFounderBrief(body(parts), src, { maxSource: 4, personWords: ['Jane Doe'] });

  test('a made-up conviction citing a profile, and a charge citing a funding story, are both removed; two refuse the brief', () => {
    const out = check({
      '## LITIGATION AND REGULATORY': '• She was convicted of wire fraud and sentenced to prison [Source 1].',
      '## RED FLAGS AND OPEN QUESTIONS': '• She was charged with securities fraud [Source 2].\n• Confirm the role history with references.',
    });
    expect(out.ok).toBe(false);
    const one = check({ '## SUMMARY': 'Jane Doe co-founded Acme Robotics in 2019 [Source 2]. She was convicted of fraud [Source 2].' });
    expect(one.ok).toBe(true);
    expect(one.content).not.toMatch(/convicted/);
    expect(one.content).toMatch(/co-founded Acme Robotics in 2019/);
  });

  test('a legal line in SUMMARY, TIMELINE or PRESS that rests on a name-only source is removed', () => {
    for (const h of ['## SUMMARY', '## CAREER TIMELINE', '## PRESS AND PUBLIC STATEMENTS']) {
      const out = check({ [h]: `${h === '## SUMMARY' ? 'Jane Doe co-founded Acme Robotics in 2019 [Source 2]. ' : ''}Jane Doe was charged with fraud after a robbery [Source 3].` });
      expect(out.content).not.toMatch(/robbery/);
    }
  });

  test('the matter is kept when a cited source tied to the person states it, in its own or kindred words', () => {
    const out = check({ '## LITIGATION AND REGULATORY': '• Jane Doe was charged with securities fraud [Source 4].\n• She was sued by Globex in 2022 [Source 4].' });
    expect(out.ok).toBe(true);
    expect(section(out.content, '## LITIGATION AND REGULATORY')).toMatch(/charged with securities fraud[\s\S]*sued by Globex/);
  });

  test('a loose citation never rescues a legal line, even when another tied source states it', () => {
    const out = check({ '## SUMMARY': 'Jane Doe co-founded Acme Robotics in 2019 [Source 2]. She was sued by Globex [Source 2].' });
    expect(out.content).not.toMatch(/sued by Globex/);
  });

  test('a paragraph cited once at its end: the legal sentence rests on that citation', () => {
    const out = check({ '## LITIGATION AND REGULATORY': 'Jane Doe was indicted. The charges concern securities fraud [Source 4].' });
    expect(section(out.content, '## LITIGATION AND REGULATORY')).toMatch(/indicted/);
  });

  test('ordinary words are not legal matters, and a yes/no reference question needs no source', () => {
    const out = check({
      '## SUMMARY': 'Jane Doe co-founded Acme Robotics in 2019 [Source 2]. Acme Robotics charges a fee per robot [Source 2].',
      '## RED FLAGS AND OPEN QUESTIONS': '• Ask whether Jane Doe has ever been sued or investigated?',
    });
    expect(out.content).toMatch(/Ask whether Jane Doe has ever been sued/);
  });

  test('Open Research (no legalTerms option) is unchanged', () => {
    const text = '## SUMMARY\nJane Doe co-founded Acme Robotics [Source 2]. She was convicted of fraud [Source 2].';
    expect(checkClaims(text, src, { maxDropShare: 1 }).dropped).toBe(0);
    expect(checkClaims(text, src, { maxDropShare: 1, legalTerms: true }).dropped).toBe(1);
  });
});

describe('quickbrief-people-evidence-unflagged: while the page asks which person, nothing is shown as theirs', () => {
  test('every evidence item carries its group and the possible-different-person flag; no current role is claimed', async () => {
    const results = [
      W({ title: 'John Kowalczyk - Pastor - Grace Chapel | LinkedIn', url: 'https://www.linkedin.com/in/jk-pastor', snippet: 'Experience: Grace Chapel' }),
      W({ title: 'Grace Chapel pastor John Kowalczyk sued over fraud', url: 'https://local.example/suit', snippet: 'John Kowalczyk, pastor of Grace Chapel, was sued for fraud by a neighbour.' }),
      W({ title: 'John Kowalczyk - CEO - Acme Robotics | LinkedIn', url: 'https://www.linkedin.com/in/jk-ceo', snippet: 'Experience: Acme Robotics' }),
      W({ title: 'Acme Robotics CEO John Kowalczyk raises $10M', url: 'https://news.example/raise', snippet: 'John Kowalczyk, CEO of Acme Robotics, founded the company in 2020.' }),
    ];
    const out = await runFounderCheck({ name: 'John Kowalczyk', useLLM: false }, { searchers: searchersWith(results) });
    expect(out.briefInfo.mode).toBe('choose');
    const items = [...out.timeline, ...out.pastCompanies, ...out.litigation, ...out.press, ...out.mentions, ...out.education];
    expect(items.length).toBeGreaterThan(0);
    for (const x of items) expect(x.possibleDifferentPerson).toBe(true);
    expect(out.litigation.some((x) => /fraud/.test(x.quote))).toBe(true);
    expect(out.currentRole).toBeNull();
    for (const p of out.profiles) expect(p.possibleDifferentPerson).toBe(true);
  });
});

describe('quickbrief-weak-pages-in-quoted-brief: one profile among name-only pages is not "most of them"', () => {
  const results = [
    W({ title: 'John Kowalczyk, CEO of Acme Robotics', url: 'https://news.example/acme', snippet: 'John Kowalczyk, CEO of Acme Robotics, spoke at the summit.' }),
    W({ title: 'Man named John Kowalczyk charged with fraud after a robbery', url: 'https://local.example/robbery', snippet: 'Police said John Kowalczyk was charged with fraud after a robbery in Ohio.' }),
    W({ title: 'John Kowalczyk finishes the city marathon', url: 'https://local.example/marathon', snippet: 'John Kowalczyk finished the city marathon on Sunday.' }),
    W({ title: 'John Kowalczyk wins the chess open', url: 'https://local.example/chess', snippet: 'John Kowalczyk won the chess open.' }),
  ];

  test('no group covers enough pages: the summary claims no company, and the namesake charge is not listed as theirs', async () => {
    const out = await runFounderCheck({ name: 'John Kowalczyk', useLLM: false }, { searchers: searchersWith(results) });
    expect(out.brief).not.toMatch(/most of them/);
    const lit = section(out.brief, '## LITIGATION AND REGULATORY');
    // the charge is listed only under the name-only note, never as a plain item of the person's record
    expect(lit).toMatch(/name only/i);
    const plain = lit.split(/name only/i)[0];
    expect(plain).not.toMatch(/robbery/);
    expect(out.litigation.every((x) => x.nameOnly || x.possibleDifferentPerson)).toBe(true);
    expect(section(out.brief, '## RED FLAGS AND OPEN QUESTIONS')).not.toMatch(/Review the \d+ litigation/);
  });
});

describe('quickbrief-court-records-dropped-silently: court records left out by the company filter are said', () => {
  test('the quoted brief says how many court records name the person without the company', async () => {
    const court = [{ title: 'United States v. Trevor Milton (nysd, docket 1:21-cr-478).', snippet: 'Trevor Milton was sentenced.', url: 'https://www.courtlistener.com/docket/1/', date: '2021-07-29', source: 'courtlistener', sourceName: 'CourtListener' }];
    const web = [W({ title: 'Nikola founder Trevor Milton steps down', url: 'https://news.example/steps', snippet: 'Trevor Milton founded Nikola in 2014 and stepped down as executive chairman in 2020.' })];
    const out = await runFounderCheck({ name: 'Trevor Milton', company: 'Nikola', useLLM: false }, { searchers: searchersWith(web, { courtlistener: async () => court }) });
    expect(out.namesakeCourtRecords).toEqual(expect.objectContaining({ count: 1 }));
    const lit = section(out.brief, '## LITIGATION AND REGULATORY');
    expect(lit).toMatch(/1 court record names? a Trevor Milton without Nikola/);
    expect(lit).not.toMatch(/^No litigation or regulatory mentions found/m);
  });

  test('the AI brief says it too', async () => {
    const court = [{ title: 'United States v. Trevor Milton (nysd).', snippet: '', url: 'https://www.courtlistener.com/docket/2/', source: 'courtlistener', sourceName: 'CourtListener' }];
    const web = [W({ title: 'Nikola founder Trevor Milton steps down', url: 'https://news.example/steps', snippet: 'Trevor Milton founded Nikola in 2014 and stepped down as executive chairman in 2020.' })];
    modelSays(`${BRIEF_SECTIONS.map((h) => `${h}\n${h === '## SUMMARY' ? 'Trevor Milton founded Nikola in 2014 [Source 1].' : 'Not found in the available sources.'}`).join('\n')}\nCONFIDENCE: Low - one source`);
    const out = await runFounderCheck({ name: 'Trevor Milton', company: 'Nikola' }, { searchers: searchersWith(web, { courtlistener: async () => court }) });
    expect(out.briefInfo.mode).toBe('ai');
    expect(section(out.brief, '## LITIGATION AND REGULATORY')).toMatch(/court record/);
  });

  test('court records not searched are said as not searched, never as none found', async () => {
    const web = [W({ title: 'Nikola founder Trevor Milton steps down', url: 'https://news.example/steps', snippet: 'Trevor Milton founded Nikola in 2014.' })];
    const failing = async () => { const e = new Error('Court records are not enabled on this deployment.'); e.skipped = true; throw e; };
    const out = await runFounderCheck({ name: 'Trevor Milton', company: 'Nikola', useLLM: false }, { searchers: searchersWith(web, { courtlistener: failing }) });
    expect(section(out.brief, '## LITIGATION AND REGULATORY')).toMatch(/Court records were not searched/);
  });
});

describe('quickbrief-wedding-title: wedding and spouse headlines go, as in the deep check', () => {
  test.each([
    'Trevor Milton weds Carrie Smith in Utah',
    'Trevor Milton marries Carrie Smith in Utah',
    'Trevor Milton and wife Carrie Milton donate to hospital',
    'Trevor Milton and his wife open a gallery',
  ])('%s', (title) => {
    expect(cleanSearchResult(W({ title, url: 'https://news.example/x', snippet: 'Trevor Milton founded Nikola.' }))).toBeNull();
  });

  test('a business headline stays', () => {
    expect(cleanSearchResult(W({ title: 'Trevor Milton steps down from Nikola', url: 'https://news.example/x', snippet: 'Trevor Milton founded Nikola.' }))).not.toBeNull();
  });
});

describe('live-digest-junk-companies: the fallback digest names only companies a profile or a sentence about the person gives', () => {
  test('headline words are not companies; no role at a junk company; no removal markers or image captions in quotes', async () => {
    const results = [
      W({ title: 'Who Is Canva CEO Eric Glyman? Top Companies founder', url: 'https://blog.example/who', snippet: 'Nearly every founder admires Eric Glyman.' }),
      W({ title: 'Ramp co-founders Eric Glyman and Karim Atiyeh raise $300M', url: 'https://news.example/ramp', snippet: 'eric@ramp.example Eric Glyman is the co-founder and CEO of Ramp, the finance automation company.' }),
      W({ title: 'Eric Glyman on Instagram', url: 'https://www.instagram.com/p/abc', snippet: 'May be an image of text. Eric Glyman, CEO of Ramp, speaks at the summit.' }),
    ];
    const out = await runFounderCheck({ name: 'Eric Glyman', company: 'Ramp', useLLM: false }, { searchers: searchersWith(results) });
    const summary = section(out.brief, '## SUMMARY');
    expect(summary).not.toMatch(/Who Is Canva|Top Companies|Nearly|Companies,/);
    expect(summary).not.toMatch(/co-founders at/);
    expect(out.brief).not.toMatch(/\[email removed\]|May be an image/);
  });
});

describe('quickbrief-only-mode-bypasses-limit: one counted check gives one model brief', () => {
  test('the cached sources are used once; a second brief call runs (and is counted as) a new check', async () => {
    const results = [W({ title: 'Jane Doe of Acme Robotics', url: 'https://news.example/a', snippet: 'Jane Doe, CEO of Acme Robotics, co-founded it in 2019.' })];
    const searchers = searchersWith(results);
    await runFounderCheck({ name: 'Jane Doe', company: 'Acme Robotics', brief: 'none', cacheScope: 'u1', useLLM: false }, { searchers });
    const onMiss = jest.fn(async () => {});
    const first = await runFounderBrief({ name: 'Jane Doe', company: 'Acme Robotics', cacheScope: 'u1', useLLM: false, onMiss }, { searchers });
    expect(first.fromCache).toBe(true);
    expect(onMiss).not.toHaveBeenCalled();
    const second = await runFounderBrief({ name: 'Jane Doe', company: 'Acme Robotics', cacheScope: 'u1', useLLM: false, onMiss }, { searchers });
    expect(second.fromCache).toBe(false);
    expect(onMiss).toHaveBeenCalledTimes(1);
  });

  test('onMiss refusing stops the run before any search', async () => {
    const web = jest.fn(async () => []);
    const refuse = async () => { const e = new Error('wait'); e.retryAfter = 30; throw e; };
    await expect(runFounderBrief({ name: 'Jane Doe', company: 'Acme', cacheScope: 'u9', useLLM: false, onMiss: refuse }, { searchers: searchersWith([], { web }) })).rejects.toThrow('wait');
    expect(web).not.toHaveBeenCalled();
  });
});

describe('a regulator named without a legal matter', () => {
  test('is checked like a name: removed when its source lacks it, but not counted as an invented legal matter', () => {
    const src = new Map([[1, { text: 'Jane Doe co-founded Acme Robotics in 2019 and raised $20M.' }]]);
    const text = '## SUMMARY\nJane Doe co-founded Acme Robotics in 2019 [Source 1]. Acme Robotics filed with the SEC [Source 1]. Acme Robotics briefed the FTC [Source 1]. Jane Doe raised $20M [Source 1].';
    const out = checkClaims(text, src, { legalTerms: true, failAfter: 2, maxDropShare: 0.5 });
    expect(out.ok).toBe(true);
    expect(out.content).not.toMatch(/SEC|FTC/);
    const legal = checkClaims('## SUMMARY\nJane Doe co-founded Acme Robotics in 2019 [Source 1]. She was fined by the SEC [Source 1]. She was sued [Source 1]. Jane Doe raised $20M [Source 1].', src, { legalTerms: true, failAfter: 2, maxDropShare: 0.5 });
    expect(legal.ok).toBe(false);
  });
});
