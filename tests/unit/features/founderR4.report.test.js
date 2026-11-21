/**
 * Round 4 (review 2026-11-21), report.js: grading, grouping, red flags, outcomes and the timeline.
 * Each test names the finding it covers (eval/founder/review-2026-11-21/by-owner/report.json).
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const { buildReport } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
const rec = (o) => ({ id: `r4-${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', severity: 'info', quote: '', match: 'confirmed', matchReasons: [], url: `https://r4.test/${seq}`, ...o });
function state(name, company, findings, extra = {}) {
  const s = startState({ name, company });
  s.findings = findings;
  return Object.assign(s, extra);
}

describe('report-aboutthem-drops-tied-flag: a tied serious record is never dropped from every list', () => {
  test('a news report whose headline does not name them, but whose quotation does with the event, is a red flag', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Fintech startup CEO pleads guilty to wire fraud', quote: 'Jane Roe, founder and CEO of Zetafold, pleaded guilty to wire fraud on Tuesday.', severity: 'high', date: '2024-03-05' }),
    ]));
    expect(report.totals.seriousRecords).toBe(1);
    expect(report.redFlags).toHaveLength(1);
    expect(report.redFlags[0].passing).toBeUndefined();
  });

  test('a tied serious report that only mentions them is kept as a red flag marked as a mention in passing', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'How this new fintech billionaire is cashing in', quote: 'Payments are booming. Jane Roe built Zetafold in four years. Regulators have questioned the sector.', severity: 'medium', date: '2026-06-25' }),
    ]));
    expect(report.redFlags).toHaveLength(1);
    expect(report.redFlags[0].passing).toBe(true);
  });

  test('an encyclopaedia roundup that mentions them stays out of the red flags, and a name-only record is not raised', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: '2021 in the United States - Wikipedia', quote: 'July 29: Jane Roe is indicted on fraud charges.', url: 'https://en.wikipedia.org/wiki/2021_in_the_United_States', severity: 'high' }),
      rec({ title: 'Startup CEO arrested', quote: 'Police arrested a chief executive on Friday. Jane Roe declined to comment.', severity: 'high', match: 'possible' }),
    ]));
    expect(report.redFlags).toHaveLength(0);
    expect(report.totals.records).toBe(2);
  });
});

describe('report-outcome-never-joins: the record that ends a matter joins it', () => {
  test('an acquittal graded low joins the indictment: the outcome is shown and the matter is graded low', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Jane Roe indicted on wire fraud charges', quote: 'A grand jury indicted Jane Roe, CEO of Zetafold, on wire fraud charges.', source: 'doj-press-releases', sourceLabel: 'US Department of Justice', category: 'regulatory', severity: 'high', date: '2021-02-10' }),
      rec({ title: 'Jury acquits Jane Roe of wire fraud charges', quote: 'A jury acquitted Jane Roe of all wire fraud charges.', severity: 'low', date: '2022-06-01', data: { outcome: { outcome: 'acquitted', role: 'defendant' } } }),
    ]));
    expect(report.redFlags).toHaveLength(1);
    const flag = report.redFlags[0];
    expect(flag.outcome).toMatchObject({ text: 'acquitted', date: '2022-06-01' });
    expect(flag.severity).toBe('low');
    expect(flag.more.map((m) => m.title)).toContain('Jury acquits Jane Roe of wire fraud charges');
  });

  test('a pardon reported on its own folds into the sentence it ends; a later report of the pardon does not date it', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Jane Roe sentenced to four years in prison for securities fraud', quote: 'Jane Roe was sentenced to four years in prison.', source: 'doj-press-releases', category: 'regulatory', severity: 'high', date: '2023-01-12' }),
      rec({ title: 'President pardons Zetafold founder Jane Roe', quote: 'The president pardoned Jane Roe.', severity: 'medium', date: '2024-03-28' }),
      rec({ title: 'Pardoned founder Jane Roe raises $1B for new venture', quote: 'Jane Roe, pardoned last year, is raising money.', severity: 'info', date: '2025-06-30' }),
    ]));
    expect(report.redFlags).toHaveLength(1);
    expect(report.redFlags[0].outcome).toMatchObject({ text: 'pardoned', date: '2024-03-28' });
  });

  test('a dropped civil case never clears a prosecution that reached a sentence', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Jane Roe Charged In Securities Fraud Scheme', source: 'doj-press-releases', category: 'regulatory', severity: 'high', date: '2021-07-29' }),
      rec({ title: 'Jane Roe Sentenced To Four Years In Prison', source: 'doj-press-releases', category: 'regulatory', severity: 'high', date: '2022-12-18' }),
      rec({ title: 'SEC moves to drop case against former Zetafold CEO Jane Roe', severity: 'info', date: '2025-09-12' }),
    ]));
    expect(report.redFlags).toHaveLength(1);
    expect(report.redFlags[0].severity).toBe('high');
    expect(report.redFlags[0].outcome?.text).not.toBe('dropped');
  });

  test('a pardon of a namesake (name only) never joins a matter of the person', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Jane Roe sentenced to four years in prison', quote: 'Jane Roe, CEO of Zetafold, was sentenced.', source: 'doj-press-releases', category: 'regulatory', severity: 'high', date: '2023-01-12' }),
      rec({ title: 'Governor pardons Jane Roe', quote: 'A Jane Roe of Ohio was pardoned.', severity: 'medium', date: '2024-03-28', match: 'possible' }),
    ]));
    expect(report.redFlags[0].outcome).toBeUndefined();
  });
});

describe('report-grouppages-severity-from-namesake: one page, graded by its tied copies only', () => {
  test("a name-only snippet of the same address never raises the page's severity", () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Zetafold team', quote: 'Jane Roe is the founder and CEO of Zetafold.', source: 'page-reader', category: 'career', url: 'https://zetafold.test/team' }),
      rec({ title: 'Zetafold team', quote: 'John Doe was convicted of fraud.', source: 'web-search', severity: 'high', match: 'possible', url: 'https://zetafold.test/team' }),
    ]));
    expect(report.redFlags).toHaveLength(0);
    expect(report.sources).toHaveLength(1);
    expect(report.sections.flatMap((s) => s.items)[0].severity).toBe('info');
  });

  test('a more severe copy tied as strongly leads, so the quotation shown supports the grade', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Zetafold news', quote: 'Jane Roe is the founder of Zetafold.', source: 'page-reader', url: 'https://n.test/a' }),
      rec({ title: 'Zetafold news', quote: 'Jane Roe, CEO of Zetafold, was charged with fraud.', source: 'web-search', severity: 'high', match: 'likely', url: 'https://n.test/a' }),
    ]));
    expect(report.redFlags).toHaveLength(1);
    expect(report.redFlags[0].quote).toMatch(/charged with fraud/);
  });
});

describe('report-redflags-fragmented: one prosecution is one red flag', () => {
  test('charges, a conviction reported in other words and with a year only, an undated sentencing thread and the sentence are one matter', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Former Zetafold CEO Jane Roe Charged In Securities Fraud Scheme', source: 'doj-press-releases', category: 'regulatory', severity: 'high', date: '2021-07-29' }),
      rec({ title: 'Zetafold founder Jane Roe convicted of wire, securities fraud', severity: 'high', date: '2022-10-19' }),
      rec({ title: 'Zetafold Founder Jane Roe Guilty of Defrauding Investors', severity: 'high', date: '2022-10-14' }),
      rec({ title: 'Jane Roe: convicted of securities fraud (2022)', source: 'wikidata', category: 'litigation', severity: 'high', date: '2022' }),
      rec({ title: 'Zetafold founder Jane Roe sentenced to four years over fraud - Reddit', source: 'web-search', severity: 'high' }),
      rec({ title: 'Jane Roe Sentenced To Four Years In Prison For Securities Fraud Scheme', source: 'doj-press-releases', category: 'regulatory', severity: 'high', date: '2023-12-18' }),
    ]));
    expect(report.redFlags).toHaveLength(1);
    const flag = report.redFlags[0];
    expect(flag.title).toMatch(/Sentenced To Four Years/);
    expect(flag.stages.map((s) => s.tag)).toEqual(expect.arrayContaining(['charges', 'conviction', 'sentence']));
  });

  test('two convictions months apart stay two matters, and a civil settlement of charges is not a stage', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Jury convicts Jane Roe of securities fraud', severity: 'high', date: '2022-10-14' }),
      rec({ title: 'Jane Roe convicted again in a separate tax case', severity: 'high', date: '2023-03-20' }),
      rec({ title: 'Zetafold to Pay $125 Million to Resolve Fraud Charges against Jane Roe', source: 'sec-filings', category: 'regulatory', severity: 'high', date: '2022-11-01' }),
    ]));
    expect(report.redFlags).toHaveLength(3);
  });

  test('two reports of one settlement with the same amount, and the dockets of one dispute, are one matter each', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'SEC: Zetafold to Pay $125 Million to Resolve Fraud Charges (names Jane Roe)', source: 'sec-filings', category: 'regulatory', severity: 'high', date: '2021-12-21' }),
      rec({ title: "Jane Roe's alleged fraud costs Zetafold $125M in SEC deal", severity: 'medium', date: '2021-12-21' }),
      rec({ title: 'Roe v. Zetafold Corporation (US District Court, District of Arizona, federal court docket)', source: 'court-records-open', category: 'litigation', severity: 'medium', match: 'likely' }),
      rec({ title: 'Zetafold Corporation v. Roe (US District Court, District of Arizona, federal court docket)', source: 'court-records-open', category: 'litigation', severity: 'medium', match: 'likely' }),
      rec({ title: 'Zetafold Corporation v. Roe (US Court of Appeals, Ninth Circuit, federal court docket)', source: 'court-records-open', category: 'litigation', severity: 'medium', match: 'likely' }),
    ]));
    expect(report.redFlags).toHaveLength(2);
  });
});

describe('report-founded-year-from-launch: what a company launched is not its founding', () => {
  test("a product launch never marks the company's older domain as an earlier holder's", () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Zetafold launched its bill pay product in 2022', quote: 'Zetafold launched its bill pay product in 2022, said Jane Roe.', category: 'corporate' }),
      rec({ title: 'zetafold.com: registered 2019-03-02', source: 'domain-history', category: 'corporate', match: 'company', date: '2019-03-02', data: { domain: 'zetafold.com', registered: '2019-03-02' } }),
    ]));
    const domain = report.sections.flatMap((s) => s.items).find((f) => f.source === 'domain-history');
    expect(domain.title).not.toMatch(/earlier holder/);
    expect(domain.data.earlierHolder).toBeUndefined();
  });

  test('one record alone never marks a domain as an earlier holder\'s', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Interview with Jane Roe', quote: 'Jane Roe runs Zetafold, Inc. (founded in 2021), a payments firm.', category: 'career' }),
      rec({ title: 'zetafold.com: registered 2015-03-02', source: 'domain-history', category: 'corporate', match: 'company', date: '2015-03-02', data: { domain: 'zetafold.com', registered: '2015-03-02' } }),
    ]));
    expect(report.sections.flatMap((s) => s.items).find((f) => f.source === 'domain-history').data.earlierHolder).toBeUndefined();
  });
});

describe('report-claimchange-linkedin-slug: a profile address with a suffix is their own page', () => {
  const change = (page) => rec({
    title: 'Profile: headline changed', source: 'web-archive', category: 'archive', match: 'likely', url: `https://web.archive.org/web/2024/${page}`,
    data: { kind: 'change', page, field: 'headline', before: 'CTO at Paribus', after: 'CEO at Zetafold' },
  });
  test('linkedin.com/in/jane-roe-4b2a17 is theirs; a blog post address with a suffix is not', () => {
    expect(buildReport(state('Jane Roe', 'Zetafold', [change('https://www.linkedin.com/in/jane-roe-4b2a17')])).claimChanges).toHaveLength(1);
    expect(buildReport(state('Jane Roe', 'Zetafold', [change('https://news.test/blog/jane-roe-4b2a17')])).claimChanges).toHaveLength(0);
  });
});

describe('report-flagweight-court-sanctions: a court sanction in a lawsuit is not a watchlist entry', () => {
  test('a conviction is listed before a discovery sanction', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Judge sanctions Jane Roe over discovery abuse in Zetafold contract suit', category: 'litigation', severity: 'medium', date: '2020-05-01' }),
      rec({ title: 'Jane Roe convicted of securities fraud', severity: 'high', date: '2022-10-14' }),
    ]));
    expect(report.redFlags[0].title).toMatch(/convicted/);
  });
  test('an OFAC listing still leads', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      rec({ title: 'Jane Roe convicted of securities fraud', severity: 'high', date: '2022-10-14' }),
      rec({ title: 'Treasury adds Jane Roe to OFAC sanctions list', severity: 'high', date: '2023-01-10' }),
    ]));
    expect(report.redFlags[0].title).toMatch(/OFAC/);
  });
});

describe('report-timeline-company-matter-dupes: each matter is one timeline row', () => {
  test('five reports of one company lawsuit are one row', () => {
    const titles = ['Acme sues Zetafold over patent', 'Zetafold faces patent lawsuit from Acme', 'Acme files patent lawsuit against Zetafold', 'Zetafold patent lawsuit: what we know', 'Zetafold responds to Acme patent lawsuit'];
    const report = buildReport(state('Jane Roe', 'Zetafold', titles.map((title, i) => rec({ title, category: 'litigation', severity: 'medium', match: 'company', date: `2023-05-0${i + 1}`, data: { company: 'Zetafold' } }))));
    expect(report.companyMatters).toHaveLength(1);
    expect(report.timeline.filter((t) => /patent/i.test(t.title))).toHaveLength(1);
  });
});
