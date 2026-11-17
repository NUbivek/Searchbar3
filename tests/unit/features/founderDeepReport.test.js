/**
 * The deep check report: ranking, red flags vs possible namesakes, the
 * coverage statement, and the brief (model-written and checked, or quoted).
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const providers = require('../../../src/server/llm/providers');
const { buildReport, writeDeepBrief, quotedDeepBrief, DEEP_SECTIONS, NOT_COVERED } = require('../../../src/server/founder/report');
const { createSubject } = require('../../../src/server/founder/identity');
const { makeFinding, severityFromText } = require('../../../src/server/founder/finding');
const { startState } = require('../../../src/server/founder/deepCheck');

function sampleState() {
  const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
  const f = (o) => makeFinding(subject, { source: 's', sourceLabel: 'Source', ...o });
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  state.findings = [
    f({ category: 'press', title: 'Trevor Milton of Nikola speaks at a conference', url: 'https://a.test/1', date: '2019-05-01' }),
    f({ category: 'regulatory', severity: 'high', sourceLabel: 'US Department of Justice', title: 'Nikola founder Trevor Milton convicted of fraud', quote: 'Trevor Milton, founder of Nikola, was convicted. Case 1:21-cr-00478.', url: 'https://justice.test/pr', date: '2022-10-14' }),
    f({ category: 'press', severity: severityFromText('convicted'), title: 'Trevor Milton of Nikola convicted', quote: 'Case 1:21-cr-00478', url: 'https://news.test/x', date: '2022-10-15' }),
    f({ category: 'litigation', severity: 'medium', title: 'Trevor Milton sued in Ohio', quote: 'Trevor Milton was named in a landlord dispute.', url: 'https://court.test/ohio', date: '2015-01-01' }),
    f({ category: 'archive', severity: 'low', title: 'Trevor Milton, Nikola: title changed between 2016 and 2019', quote: 'CEO became Executive Chairman', url: 'https://web.archive.org/x', date: '2019-01-01', data: { kind: 'change', field: 'title' } }),
    f({ category: 'exposure', severity: 'medium', match: 'company', title: 'Nikola listed on a ransomware leak site', url: 'https://ransomware.test/nikola', date: '2025-03-01' }),
  ];
  state.sources = { a: { label: 'Courts', runs: 3, findings: 2, errors: 0 }, b: { label: 'Registry', runs: 2, findings: 0, errors: 2, lastError: 'HTTP 503' }, c: { label: 'Needs key', runs: 0, findings: 0, errors: 0, off: true, lastError: 'Not enabled on this deployment.' } };
  state.threads = { 'associate|mark russell': { kind: 'associate', value: 'Mark Russell', trusted: true, why: 'co-founder' }, 'company|milton bakery': { kind: 'company', value: 'Milton Bakery', trusted: false } };
  state.tasksRun = 40; state.step = 3;
  return state;
}

test('serious records tied to the person are red flags; name-only ones are listed apart as possible namesakes', () => {
  const report = buildReport(sampleState());
  // four serious records: the court record and the press report of the same case are one red flag about
  // the person, the leak-site listing is about the company, and the Ohio suit matches by name only
  expect(report.totals).toMatchObject({ records: 6, redFlags: 1, companyMatters: 1, possibleNamesake: 1, seriousRecords: 4 });
  expect(report.companyMatters.map((f) => f.title)).toEqual(['Nikola listed on a ransomware leak site']);
  expect(report.redFlags[0].more.map((m) => m.n)).toHaveLength(1);
  expect(report.redFlags[0].more[0]).toEqual(expect.objectContaining({ title: expect.any(String), url: expect.any(String), match: expect.any(String) }));
  expect(report.redFlags[0].title).toMatch(/convicted of fraud/); // official, high severity, corroborated
  expect(report.redFlags[0].corroboration).toBe(2); // the press report carries the same case number
  expect(report.redFlags.map((f) => f.match)).toEqual(['confirmed']);
  expect(report.possibleNamesake.map((f) => f.title)).toEqual(['Trevor Milton sued in Ohio']);
  expect(report.sections.map((s) => s.key)).toEqual(['regulatory', 'litigation', 'exposure', 'archive', 'press']);
  expect(report.claimChanges).toHaveLength(1);
  expect(report.timeline.map((t) => t.date)).toEqual(['2019-01-01', '2022-10-14']); // dated, tied to the person, not press
  expect(report.relatedParties).toEqual([expect.objectContaining({ name: 'Mark Russell', kind: 'associate' })]);
  // every record has one number, used everywhere
  expect(report.sources.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(report.sections.flatMap((s) => s.items).every((f) => report.sources[f.n - 1].id === f.id)).toBe(true);
});

test('the report says what was searched, what failed and what no free source covers', () => {
  const { coverage, notice } = buildReport(sampleState());
  expect(coverage.searched.map((s) => s.label)).toEqual(['Courts']); // Registry failed every lookup: it searched nothing
  expect(coverage.notSearched).toEqual([{ label: 'Registry', reason: 'HTTP 503' }, { label: 'Needs key', reason: 'Not enabled on this deployment.', off: true }]);
  expect(coverage.notCovered).toBe(NOT_COVERED);
  expect(coverage).toMatchObject({ lookups: 40, rounds: 3 });
  expect(notice).toMatch(/not a consumer report/);
});

test('a model-written brief is kept only if it has the sections and cites records it was shown', async () => {
  const report = buildReport(sampleState());
  const body = DEEP_SECTIONS.map((h, i) => `${h}\n• point ${i} [Source 1] [Source 99]`).join('\n\n');
  providers.chatComplete.mockResolvedValueOnce({ text: `${body}\nCONFIDENCE: Medium - official records plus press`, providerLabel: 'Groq', model: 'm' });
  const { brief, briefInfo } = await writeDeepBrief(report, {});
  expect(briefInfo).toMatchObject({ mode: 'ai', model: 'm', confidence: { level: 'Medium' }, recordsRead: 6 });
  expect(brief).toMatch(/\[Source 1\]/);
  expect(brief).not.toMatch(/\[Source 99\]/);
  const sent = providers.chatComplete.mock.calls[0][0][1].content;
  expect(sent).toMatch(/\[Source \d\] \(possible; Courts and litigation/); // the model is told which records are name-only
  expect(sent).toMatch(/Sources that did not answer: Registry\.\nSources not enabled on this deployment: Needs key/);
});

test('without a usable model answer the brief is assembled from the records and says so', async () => {
  const report = buildReport(sampleState());
  providers.chatComplete.mockResolvedValueOnce({ text: 'I cannot help with that.', providerLabel: 'Groq', model: 'm' });
  const failed = await writeDeepBrief(report, {});
  expect(failed.briefInfo).toMatchObject({ mode: 'quoted' });
  expect(failed.brief).toMatch(/## RED FLAGS\n• Nikola founder Trevor Milton convicted of fraud/);
  expect(failed.brief).toMatch(/Rule out a namesake: Trevor Milton sued in Ohio/);
  providers.chatComplete.mockResolvedValueOnce(null);
  expect((await writeDeepBrief(report, {})).briefInfo.reason).toMatch(/unavailable/);
  expect(quotedDeepBrief(buildReport(startState({ name: 'Jane Roe' })), 'x')).toMatch(/None found in the records searched/);
});

test('severity is read from a record\'s own words', () => {
  expect(severityFromText('He was indicted on wire fraud charges')).toBe('high');
  expect(severityFromText('The company settled a class action lawsuit')).toBe('medium');
  expect(severityFromText('She stepped down as CEO')).toBe('low');
  expect(severityFromText('She spoke at a conference')).toBe('info');
});

test('twenty reports of one event are one red flag; name-only coverage of it is listed under it, never as a fact', () => {
  const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
  const f = (o) => makeFinding(subject, { source: 'news', sourceLabel: 'News', category: 'press', severity: 'high', ...o });
  const state = startState({ name: 'Elizabeth Holmes', company: 'Theranos' });
  state.findings = [
    f({ source: 'doj', sourceLabel: 'US Department of Justice', category: 'regulatory', title: 'Elizabeth Holmes Sentenced To More Than 11 Years For Defrauding Theranos Investors', url: 'https://justice.test/1', date: '2022-11-18' }),
    f({ title: 'Theranos founder Elizabeth Holmes sentenced to 11 years', url: 'https://a.test/1', date: '2022-11-18' }),
    f({ title: 'Elizabeth Holmes Is Sentenced to More Than 11 Years for Fraud', url: 'https://b.test/1', date: '2022-11-19' }), // name only
    f({ title: 'Theranos founder Elizabeth Holmes conviction upheld by appeals court', url: 'https://c.test/1', date: '2025-02-24' }),
    f({ title: 'Elizabeth Holmes sentenced for shoplifting in Leeds', url: 'https://d.test/1', date: '2019-03-02' }), // a namesake, another month
    f({ match: 'company', title: 'Theranos sued by Walgreens', url: 'https://e.test/1', date: '2016-11-08', severity: 'medium' }),
    f({ title: 'Theranos associate charged', url: 'https://f.test/1', date: '2018-06-15', match: 'possible', data: { person: 'Ramesh Balwani' } }),
  ];
  const report = buildReport(state);
  // a name-only report of the same month's event stays with the possible namesakes, never under her matter
  expect(report.totals).toMatchObject({ seriousRecords: 7, redFlags: 2, companyMatters: 1, possibleNamesake: 3 });
  const sentencing = report.redFlags.find((x) => /Sentenced To More Than 11 Years For Defrauding/.test(x.title));
  expect(sentencing.sourceLabel).toBe('US Department of Justice'); // the official record leads
  expect(sentencing.more.map((m) => m.match).sort()).toEqual(['confirmed']);
  expect(report.redFlags.map((x) => x.title)).toEqual(expect.arrayContaining([expect.stringMatching(/conviction upheld/)]));
  // a suit against the company that does not name her is context about the company, not a red flag about her
  expect(report.companyMatters.map((x) => x.title)).toEqual(['Theranos sued by Walgreens']);
  // the namesake's sentence and the associate's charge stay apart from the founder's matters
  expect(report.possibleNamesake.map((x) => x.title).sort()).toEqual(['Elizabeth Holmes Is Sentenced to More Than 11 Years for Fraud', 'Elizabeth Holmes sentenced for shoplifting in Leeds', 'Theranos associate charged']);
  expect(report.redFlags.every((x) => x.match === 'confirmed' || x.match === 'likely')).toBe(true);
});

test('when no model answers in time the brief is assembled from the records, and one more attempt can start with other models', async () => {
  const report = buildReport(sampleState());
  const complete = jest.fn(async (messages, options) => { options.trace.push({ provider: 'Google Gemini', model: 'gemini-4-hydrogen', family: 'gemini-4-hydrogen', why: 'timed out' }); return null; });
  const first = await writeDeepBrief(report, { complete });
  expect(first.briefInfo).toMatchObject({ mode: 'quoted', retry: true, tried: ['gemini-4-hydrogen'] });
  expect(first.brief).toMatch(/## RED FLAGS/);
  // the second attempt leaves the first model out, and does not ask for a third
  const second = await writeDeepBrief(report, { complete, avoid: first.briefInfo.tried });
  expect(complete.mock.calls[1][1].avoid).toEqual(['gemini-4-hydrogen']);
  expect(second.briefInfo.retry).toBe(false);
});

test('a page that only mentions the person in passing is not a red flag about them', () => {
  const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
  const f = (o) => makeFinding(subject, { source: 'web', sourceLabel: 'Open-web search', category: 'press', severity: 'high', ...o });
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  state.findings = [
    f({ title: 'Nikola founder Trevor Milton convicted of fraud', quote: 'Trevor Milton was convicted.', url: 'https://a.test/1', date: '2022-10-14' }),
    f({ title: '2021 in the United States - Wikipedia', quote: 'July 29: Nikola founder Trevor Milton is indicted on fraud charges.', url: 'https://en.wikipedia.org/wiki/2021_in_the_United_States' }),
    f({ title: 'Nathan Anderson - Wikipedia', quote: 'His report on Nikola led to the fraud conviction of Trevor Milton.', url: 'https://en.wikipedia.org/wiki/Nathan_Anderson' }),
    f({ title: 'Hindenburg report: Nikola is an intricate fraud', quote: 'Nikola founder Trevor Milton made false statements.', url: 'https://b.test/1', date: '2020-09-10' }),
  ];
  const report = buildReport(state);
  expect(report.redFlags.map((x) => x.title)).toEqual(['Nikola founder Trevor Milton convicted of fraud', 'Hindenburg report: Nikola is an intricate fraud']);
  expect(report.totals.records).toBe(4); // the passing mentions are still in the report, under press
});
