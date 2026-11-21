/**
 * Round 4 (review 2026-11-21), report.js: the two brief writers (quotedDeepBrief and writeDeepBrief's checks).
 * Each describe names the finding it covers (eval/founder/review-2026-11-21/by-owner/report.json).
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const { buildReport, quotedDeepBrief, writeDeepBrief, DEEP_SECTIONS } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
const rec = (o) => ({ id: `rb-${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', severity: 'info', quote: '', match: 'confirmed', matchReasons: [], url: `https://rb.test/${seq}`, ...o });
function state(name, company, findings, extra = {}) {
  const s = startState({ name, company });
  s.findings = findings;
  return Object.assign(s, extra);
}
const section = (brief, heading) => (brief.split(`## ${heading}\n`)[1] || '').split('\n## ')[0];
const n = (report, re) => report.sources.find((s) => re.test(s.title)).n;

// A report with a tied charge, a tied bio, a name-only arrest, and a sanctions screen that failed every lookup.
function flagged(extraFindings = [], extraState = {}) {
  return buildReport(state('Jane Roe', 'Zeta', [
    rec({ title: 'Jane Roe, CEO of Zeta, charged with securities fraud', quote: 'Jane Roe, chief executive of Zeta, was charged with securities fraud.', category: 'regulatory', severity: 'high', date: '2024-02-01', source: 'doj-press-releases', sourceLabel: 'US Department of Justice' }),
    rec({ title: 'Jane Roe founded Zeta in 2019', quote: 'Jane Roe founded Zeta in 2019 after five years at Acme Bank.', category: 'career', date: '2019-01-01' }),
    rec({ title: 'Jane Roe arrested for burglary in Leeds', quote: 'A Jane Roe was arrested for burglary in Leeds.', category: 'press', severity: 'high', date: '2018-03-01', match: 'possible' }),
    ...extraFindings,
  ], {
    sources: {
      'sanctions-lists': { label: 'Sanctions lists', runs: 2, findings: 0, errors: 2, lastError: 'timed out' },
      'us-exclusions': { label: 'US federal exclusion lists', runs: 1, findings: 0, errors: 0 },
      'news-archive': { label: 'News', runs: 3, findings: 3, errors: 0 },
    },
    ...extraState,
  }));
}
function answer(report, edits = {}) {
  const fraud = n(report, /securities fraud/);
  const founded = n(report, /founded Zeta/);
  const leeds = n(report, /Leeds/);
  const body = {
    'BOTTOM LINE': `Jane Roe founded Zeta in 2019 [Source ${founded}]. She was charged with securities fraud in 2024 [Source ${fraud}].`,
    'RED FLAGS': `• Charged with securities fraud, February 2024 [Source ${fraud}]`,
    'CAREER AND EDUCATION': `• Founded Zeta in 2019 [Source ${founded}]\n• Worked at Acme Bank for five years [Source ${founded}]`,
    COMPANY: `• Zeta was founded in 2019 [Source ${founded}]`,
    'WHAT CHECKS OUT': `• The Justice Department record names her as Zeta's chief executive [Source ${fraud}]`,
    'CLAIMS THAT CHANGED OVER TIME': 'None found.',
    'RELATED PARTIES': 'None found.',
    'PUBLIC-RECORD SCREENS': '• Sanctions and watchlists: no match in US federal exclusion lists.',
    'GAPS AND UNVERIFIED CLAIMS': `• Rule out a namesake: an arrest in Leeds matched by name only [Source ${leeds}]\n• Her years at Acme Bank are stated only in a press profile.\n• State courts were not searched.`,
    'QUESTIONS FOR THE FOUNDER': '• What is the status of the 2024 charges?\n• Confirm the years at Acme Bank.\n• Share the incorporation papers of Zeta.\n• Has any regulator contacted Zeta?\n• Who are the investors?\n• What is the cap table?',
    ...edits,
  };
  return `${DEEP_SECTIONS.map((h) => `${h}\n${body[h.slice(3)]}`).join('\n\n')}\nCONFIDENCE: Medium - official record`;
}
async function run(report, text) {
  const complete = jest.fn(async (messages, o) => (o.accept(text) ? { text, providerLabel: 'G', model: 'm' } : null));
  return writeDeepBrief(report, { complete });
}

describe('brief-model-screens-unchecked: the model never calls a failed screen clean', () => {
  test('the screens are the check\'s own; a claim of full coverage and an uncited accusation in the gaps go', async () => {
    const report = flagged();
    const { brief, briefInfo } = await run(report, answer(report, {
      'PUBLIC-RECORD SCREENS': '• Sanctions and watchlists: no match in Sanctions lists\n• Every screen answered in full.',
      'GAPS AND UNVERIFIED CLAIMS': `• Rule out a namesake: an arrest in Leeds matched by name only [Source ${n(report, /Leeds/)}]\n• She was investigated by the FCA for insider trading in 2017.\n• Her years at Acme Bank are stated only in a press profile.`,
    }));
    expect(briefInfo.mode).toBe('ai');
    const screens = section(brief, 'PUBLIC-RECORD SCREENS');
    expect(screens).toMatch(/did not answer: Sanctions lists/);
    expect(screens).not.toMatch(/no match in Sanctions lists/);
    expect(brief).not.toMatch(/Every screen answered in full/);
    expect(section(brief, 'GAPS AND UNVERIFIED CLAIMS')).not.toMatch(/FCA/);
    expect(section(brief, 'GAPS AND UNVERIFIED CLAIMS')).toMatch(/Acme Bank are stated only/);
    // the bottom line states, in counts, that a screen did not answer
    expect(section(brief, 'BOTTOM LINE')).toMatch(/1 screen did not answer/);
  });
});

describe('brief-redflag-launder-weak-overlap: an adverse claim must be what a tied record says', () => {
  test("a namesake's arrest cited beside a tied bio is removed", async () => {
    const report = flagged();
    const { brief } = await run(report, answer(report, { 'RED FLAGS': `• Charged with securities fraud, February 2024 [Source ${n(report, /securities fraud/)}]\n• Arrested for burglary in Leeds in 2018 [Source ${n(report, /Leeds/)}] [Source ${n(report, /founded Zeta/)}]` }));
    expect(section(brief, 'RED FLAGS')).not.toMatch(/Leeds/);
  });
  test('a lawsuit pinned on a bio that shares one word (Acme) is removed', async () => {
    const report = flagged();
    const { brief } = await run(report, answer(report, { 'RED FLAGS': `• Charged with securities fraud, February 2024 [Source ${n(report, /securities fraud/)}]\n• Sued by Acme Bank for embezzlement in 2018 [Source ${n(report, /founded Zeta/)}]` }));
    expect(section(brief, 'RED FLAGS')).not.toMatch(/embezzlement/);
  });
  test('a conviction in the bottom line resting on a bio is removed; a charge resting on the charge record stays', async () => {
    const report = flagged();
    const { brief, briefInfo } = await run(report, answer(report, { 'BOTTOM LINE': `Jane Roe founded Zeta in 2019 [Source ${n(report, /founded Zeta/)}]. She was convicted of embezzlement at Acme Bank in 2015 [Source ${n(report, /founded Zeta/)}]. She was charged with securities fraud in 2024 [Source ${n(report, /securities fraud/)}].` }));
    expect(briefInfo.mode).toBe('ai');
    expect(section(brief, 'BOTTOM LINE')).not.toMatch(/embezzlement/);
    expect(section(brief, 'BOTTOM LINE')).toMatch(/charged with securities fraud/);
  });
});

describe('brief-noclaim-label-bypass: "nothing found" and labels are whole lines', () => {
  test('a conviction followed by "no records of an appeal" and a claim written as a label are removed', async () => {
    const report = flagged();
    const fraud = n(report, /securities fraud/);
    const { brief } = await run(report, answer(report, {
      'RED FLAGS': `• Charged with securities fraud, February 2024 [Source ${fraud}]\n• Convicted of embezzlement in 2015; no records of an appeal were found.`,
      'BOTTOM LINE': `Jane Roe founded Zeta in 2019 [Source ${n(report, /founded Zeta/)}]. She was charged with securities fraud in 2024 [Source ${fraud}].\nConvicted of wire fraud in Ohio in 2016:`,
    }));
    expect(brief).not.toMatch(/embezzlement|Ohio/);
  });
  test('"No lawsuits or charges were found." stays a no-claim line', async () => {
    const report = flagged();
    const { brief } = await run(report, answer(report, { 'CLAIMS THAT CHANGED OVER TIME': 'No changes were found.', 'RELATED PARTIES': 'No related parties with lawsuits or charges were found.' }));
    expect(section(brief, 'RELATED PARTIES')).toMatch(/No related parties/);
  });
});

describe('brief-assumed-tie-dropped: matters that hold only if this is the right person are never lost', () => {
  test('the assembled block replaces the model\'s, with its bottom-line sentence', async () => {
    const report = flagged([
      rec({ title: 'Jane Roe of Zeta sued for fraud by investors', quote: 'Investors sued Jane Roe of Zeta for fraud.', category: 'litigation', severity: 'high', date: '2022-05-01', match: 'likely', assumedTie: true }),
    ], { identity: { status: 'assumed', company: 'Zeta' } });
    expect(report.ifRightPerson).toHaveLength(1);
    const sued = n(report, /sued for fraud by investors/);
    const { brief, briefInfo } = await run(report, answer(report, {
      'RED FLAGS': `• Charged with securities fraud, February 2024 [Source ${n(report, /securities fraud/)}]\n\nOnly if this is the right person:\n• Sued for fraud by investors, 2022 [Source ${sued}]`,
    }));
    expect(briefInfo.mode).toBe('ai');
    const flags = section(brief, 'RED FLAGS');
    expect(flags).toMatch(/Only if this is the right person[^\n]*:\n• Jane Roe of Zeta sued for fraud by investors/);
    expect(flags).toMatch(new RegExp(`\\[Source ${sued}\\]`));
    expect(section(brief, 'BOTTOM LINE')).toMatch(/only if this is the right person/);
  });
});

// A report with company facts written by hand: what the brief may say of funding, standing, names and domains.
function withFacts(facts, records) {
  const report = buildReport(state('Jane Roe', 'Zetafold', records));
  report.companyFacts = facts(report);
  return report;
}

describe('brief-funding-misread-confirmed and live-brief-latest-funding: a round is money raised, the latest is dated', () => {
  const records = [
    rec({ title: 'Zetafold founder gets four years in prison for $600M fraud', quote: 'Jane Roe gets four years in prison.', severity: 'high', date: '2023-12-18' }),
    rec({ title: 'SEC press release 2021-1: SEC Charges Founder of Zetafold With Fraud', quote: 'Jane Roe, founder of Zetafold, misled investors about $1 billion in orders.', source: 'sec-filings', sourceLabel: 'SEC', category: 'regulatory', severity: 'high', date: '2021-07-29' }),
    rec({ title: 'Form D filed by Zetafold Inc names Jane Roe as Executive Officer', quote: 'Total offering amount: $5,000,000. Total amount sold: $5,000,000.', source: 'sec-company', sourceLabel: 'SEC', category: 'corporate', date: '2020-02-01', data: { form: 'D' } }),
    rec({ title: 'Zetafold raises $115M Series B', quote: 'Jane Roe said Zetafold raised $115 million in Series B funding.', category: 'corporate' }),
    rec({ title: 'Zetafold secures $30M for its card', quote: 'Zetafold, led by Jane Roe, secured $30M in funding.', category: 'corporate' }),
    rec({ title: 'Zetafold raises $300M', quote: 'Jane Roe announced Zetafold raised $300 million.', category: 'corporate', date: '2021-08-24' }),
  ];
  const report = withFacts((r) => ({
    founded: { year: 2019, cites: [n(r, /\$300M/)] },
    legalNames: [], domains: [], investors: [], standing: [],
    funding: [
      { round: null, amount: '$600M', date: '2023-12-18', cites: [n(r, /\$600M/)] },
      { round: null, amount: '$1 billion', date: '2021-07-29', cites: [n(r, /SEC Charges/)] },
      { round: 'Series B', amount: '$115M', date: null, cites: [n(r, /\$115M/)] },
      { round: null, amount: '$30M', date: null, cites: [n(r, /\$30M/)] },
      { round: null, amount: '$2B', date: '2016-05-18', cites: [n(r, /\$300M/)] },
      { round: null, amount: '$300M', date: '2021-08-24', cites: [n(r, /\$300M/)] },
      { round: 'Form D offering', amount: '$5,000,000 offered', date: '2020-02-01', cites: [n(r, /Form D/)] },
    ],
  }), records);
  report.profile = { roles: [{ org: 'Zetafold', title: 'CEO', current: true, cites: [n(report, /SEC Charges/)] }], education: [], founded: [], boards: [], leads: [] };
  const brief = quotedDeepBrief(report, 'x');

  test('a sum in a sentencing or an SEC charge is not funding; one dated before the founding is left out', () => {
    expect(section(brief, 'COMPANY')).not.toMatch(/\$600M|\$1 billion|\$2B/);
    expect(section(brief, 'BOTTOM LINE')).not.toMatch(/funding[^.]*(?:\$600M|\$1 billion|\$2B)/);
  });
  test('the latest is the latest dated entry, never an undated one; a round-less amount is a reported raise', () => {
    expect(section(brief, 'BOTTOM LINE')).toMatch(/the latest dated funding on record is a reported raise of \$300M \(2021-08-24\)/);
    expect(section(brief, 'COMPANY')).toMatch(/Series B: \$115M \(date not given\)/);
    expect(section(brief, 'COMPANY')).toMatch(/A reported raise of \$30M \(date not given\)/);
  });
  test('what checks out confirms an offering only from a Form D that states it, and calls an SEC press release that', () => {
    const checks = section(brief, 'WHAT CHECKS OUT');
    expect(checks).toMatch(/A Form D offering notice filed with the SEC confirms Zetafold's offering: \$5,000,000 offered/);
    expect(checks).not.toMatch(/funding round: \$1 billion/);
    expect(checks).toMatch(/an SEC press release confirms/);
  });
});

describe('brief-standing-boilerplate: standing figures without site furniture, newest first, dated', () => {
  test('one line per kind with the newest figure and its date, the others as earlier figures', () => {
    const records = [
      rec({ title: 'Zetafold founder defies attacks', category: 'press', date: '2026-07-05' }),
      rec({ title: "Zetafold's CEO on hitting $60B valuation - CNBC", category: 'press', date: '2026-10-15' }),
    ];
    const report = withFacts((r) => ({
      legalNames: [], domains: [], investors: [], funding: [], founded: null,
      standing: [
        { text: "Zetafold founder defies attacks amid $11 billion valuation Skip to navigation Skip to content Today's Paper", kind: 'valuation', date: '2026-07-05', cites: [n(r, /defies/)] },
        { text: "Zetafold's CEO on hitting $60B valuation - CNBC.", kind: 'valuation', date: '2026-10-15', cites: [n(r, /\$60B/)] },
      ],
    }), records);
    const company = section(quotedDeepBrief(report, 'x'), 'COMPANY');
    expect(company).toMatch(/• Valuation: Zetafold's CEO on hitting \$60B valuation \(2026-10-15\)/);
    expect(company).toMatch(/Earlier or undated valuation figures: \$11 billion \(2026-07-05\)/);
    expect(company).not.toMatch(/Skip to|Today's Paper|- CNBC/);
  });
});

describe('brief-earlier-holder-domain: a domain an earlier holder registered is not the company\'s', () => {
  test('it is left out of the company section, in the report and in the brief', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Zetafold was founded in 2015', quote: 'Zetafold was founded in 2015 by Jane Roe.', category: 'corporate' }),
      rec({ title: 'Zetafold was founded in 2015 in Utah', quote: 'Zetafold was founded in 2015 by Jane Roe in Utah.', category: 'corporate', url: 'https://rb.test/other' }),
      rec({ title: 'janeroe.com: registered 2007-01-24', source: 'domain-history', category: 'corporate', match: 'company', date: '2007-01-24', data: { domain: 'janeroe.com', registered: '2007-01-24', earlierHolder: true } }),
    ]));
    const dom = n(report, /janeroe\.com/);
    report.companyFacts = { ...(report.companyFacts || {}), domains: [{ domain: 'janeroe.com', cites: [dom] }] };
    expect(section(quotedDeepBrief(report, 'x'), 'COMPANY')).not.toMatch(/janeroe\.com/);
    // a domain of the company's own name bought from an earlier holder is still the company's
    const old = n(report, /janeroe\.com/);
    report.companyFacts = { ...report.companyFacts, domains: [{ domain: 'zetafold.com', cites: [old] }] };
    expect(section(quotedDeepBrief(report, 'x'), 'COMPANY')).toMatch(/Web domains: zetafold\.com/);
  });
});

describe('brief-bottom-no-outcome: the most serious matter carries its latest outcome', () => {
  test('a pardoned sentence says so in the bottom line', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Jane Roe sentenced to four years in prison for securities fraud', quote: 'Jane Roe was sentenced.', source: 'doj-press-releases', category: 'regulatory', severity: 'high', date: '2023-01-12' }),
      rec({ title: 'President pardons Zetafold founder Jane Roe', quote: 'The president pardoned Jane Roe.', severity: 'medium', date: '2024-03-28' }),
    ]));
    expect(section(quotedDeepBrief(report, 'x'), 'BOTTOM LINE')).toMatch(/the most serious: Jane Roe sentenced[^.]*\[Source \d+\]; latest outcome: pardoned, 2024-03-28 \[Source \d+\]/);
  });
});

describe('brief-questions-generic: questions about this person\'s claims and matters', () => {
  test('a news site rewriting its article is not a question; their own headline change is; press asks for their account', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'fortune.com page: bio rewritten between 2025-10 and 2026-02', source: 'web-archive', category: 'archive', url: 'https://web.archive.org/web/2026/https://fortune.com/jane-roe-profile', data: { kind: 'change', page: 'https://fortune.com/jane-roe-profile', field: 'bio', before: 'Jane Roe is CTO at Paribus.', after: 'Jane Roe is CEO at Zetafold.' } }),
      rec({ title: 'Twitter profile: headline changed', source: 'web-archive', category: 'archive', url: 'https://web.archive.org/web/2020/https://twitter.com/janeroe', data: { kind: 'change', page: 'https://twitter.com/janeroe', field: 'headline', before: 'CTO at Paribus', after: 'CEO at Zetafold' } }),
      rec({ title: 'Zetafold founder Jane Roe defies attacks over ties to foreign government', quote: 'Jane Roe denied claims of foreign government influence.', severity: 'medium', date: '2026-07-05' }),
    ]));
    const qs = section(quotedDeepBrief(report, 'x'), 'QUESTIONS FOR THE FOUNDER');
    expect(qs).not.toMatch(/fortune\.com/);
    expect(qs).toMatch(/Ask what changed and why: Twitter profile: headline changed/);
    expect(qs).toMatch(/Ask for their account of this matter[^\n]*defies attacks/);
  });
  test('the stages of one prosecution listed apart in a saved report get one question', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [rec({ title: 'Jane Roe profile', category: 'career' })]));
    const flag = (n, title, date) => ({ n, title, date, source: 'doj-press-releases', category: 'regulatory', severity: 'high', match: 'confirmed', more: [] });
    report.redFlags = [flag(1, 'Jane Roe Sentenced To Four Years In Prison', '2023-12-18'), flag(1, 'Jane Roe convicted of securities fraud', '2022-10-14'), flag(1, 'Jane Roe Charged In Securities Fraud Scheme', '2021-07-29')];
    const qs = section(quotedDeepBrief(report, 'x'), 'QUESTIONS FOR THE FOUNDER');
    expect(qs.match(/final court or regulator documents/g)).toHaveLength(1);
  });
});

describe('live-brief-grammar-screens: the bottom line counts the silent screens; the screens section names them', () => {
  test('counts in one short sentence', () => {
    const sources = Object.fromEntries(['opensanctions-lists', 'asic-banned', 'court-dockets', 'us-tax-court', 'ftc-cases'].map((id) => [id, { label: `${id} label`, off: true }]));
    sources['sanctions-lists'] = { label: 'Sanctions lists', runs: 4, findings: 0, errors: 1 };
    sources['sec-filings'] = { label: 'SEC filings', runs: 4, findings: 0, errors: 0, waitedOut: 2 };
    const report = buildReport(state('Jane Roe', 'Zetafold', [rec({ title: 'Jane Roe profile', category: 'career' })], { sources }));
    const bottom = section(quotedDeepBrief(report, 'x'), 'BOTTOM LINE');
    const sentence = (bottom.match(/Of the public-record screens[^.]*\./) || [''])[0];
    expect(sentence).toMatch(/^Of the public-record screens, 5 screens are not enabled on this deployment and 2 answered only in part \(see Public-record screens\)\.$/);
    expect(bottom).not.toMatch(/opensanctions-lists label/);
  });
});

describe('live-brief-legal-name-wording and live-company-matters-undated', () => {
  test('register names are registered entities, grouped; docket-only cases are one line with their filing years', () => {
    const report = buildReport(state('Eric Roe', 'Ramp', [
      rec({ title: 'Eric Roe: director of RAMP BUSINESS UK LTD (UK company, active), appointed 14 March 2024', source: 'uk-companies-house', category: 'corporate', date: '2024-03-14' }),
      rec({ title: 'Eric Roe: director of RAMP PLATFORM UK LTD (UK company, active)', source: 'uk-companies-house', category: 'corporate', date: '2024-03-14' }),
      rec({ title: 'Peters v. Ramp Business Corporation (US Bankruptcy Court, District of Colorado, federal court docket)', quote: 'Peters v. Ramp Business Corporation', source: 'court-records-open', sourceLabel: 'Court dockets', category: 'litigation', severity: 'medium', match: 'company', data: { company: 'Ramp' } }),
      rec({ title: 'Diaz v. Ramp Business Corporation (US District Court, Southern District of California, federal court docket)', quote: 'Diaz v. Ramp Business Corporation', source: 'court-records-open', sourceLabel: 'Court dockets', category: 'litigation', severity: 'medium', match: 'company', date: '2023-04-02', data: { company: 'Ramp' } }),
    ]));
    report.companyFacts = { legalNames: [{ name: 'Ramp Business UK LTD', cites: [n(report, /BUSINESS UK/)] }, { name: 'Ramp Platform UK LTD', cites: [n(report, /PLATFORM UK/)] }], domains: [], funding: [], investors: [], standing: [], founded: null };
    const brief = quotedDeepBrief(report, 'x');
    expect(section(brief, 'WHAT CHECKS OUT')).toMatch(/Company registers list these registered entities of Ramp: Ramp Business UK LTD \[Source \d+\]; Ramp Platform UK LTD \[Source \d+\]/);
    expect(brief).not.toMatch(/is the legal name of Ramp on a register entry/);
    expect(section(brief, 'COMPANY')).toMatch(/Registered entities on company registers/);
    const flags = section(brief, 'RED FLAGS');
    expect(flags).toMatch(/Court cases naming Ramp as a party, known from their docket titles only/);
    expect(flags).toMatch(/Peters v\. Ramp Business Corporation \(US Bankruptcy Court, District of Colorado; no filing year on record\) \[Source \d+\]/);
    expect(flags).toMatch(/Diaz v\. Ramp Business Corporation \(US District Court, Southern District of California; filed 2023\) \[Source \d+\]/);
  });
});

describe('a source that cut its text inside a date or number never shows a broken figure', () => {
  test('a change record is written from its own fields', () => {
    const report = buildReport(state('Eric Roe', 'Ramp', [
      rec({ title: 'Twitter profile: headline changed from "A" to "B…" between 2017-05 and 2020-…', source: 'web-archive', category: 'archive', url: 'https://web.archive.org/web/2020/https://twitter.com/ericroe', data: { kind: 'change', page: 'https://twitter.com/ericroe', field: 'headline', before: 'Co-Founder at Paribus', after: 'Co-Founder at Ramp', fromDate: '2017-05-11', toDate: '2020-12-17' } }),
    ]));
    const brief = quotedDeepBrief(report, 'x');
    expect(section(brief, 'CLAIMS THAT CHANGED OVER TIME')).toMatch(/Twitter profile: headline changed between 2017-05-11 and 2020-12-17: "Co-Founder at Paribus" became "Co-Founder at Ramp"/);
    expect(brief).not.toMatch(/\d[-,.]…/);
  });
});
