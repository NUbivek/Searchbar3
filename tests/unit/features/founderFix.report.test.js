/**
 * Fixes to the deep check report found in review: what counts as searched,
 * which records corroborate or share a matter, related parties, and the
 * checks on the model-written brief.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const { buildReport, writeDeepBrief, quotedDeepBrief, DEEP_SECTIONS } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
// Records with their grade set by hand, so these tests do not depend on how identity grades text.
const rec = (o) => ({ id: `r${(seq += 1)}`, source: 's', sourceLabel: 'Source', category: 'press', severity: 'info', quote: '', match: 'confirmed', ...o });
function state(findings, extra = {}) {
  const s = startState({ name: 'John Smith', company: 'Zeta' });
  s.findings = findings;
  return Object.assign(s, extra);
}

test('a source whose every lookup failed is not listed as searched, and a run where nothing answered is not clean', () => {
  const s = state([], { sources: { a: { label: 'Sanctions', runs: 3, findings: 0, errors: 3, lastError: 'timed out' }, b: { label: 'Courts', runs: 2, findings: 0, errors: 1, lastError: 'HTTP 500' } } });
  const { coverage } = buildReport(s);
  expect(coverage.searched.map((x) => x.label)).toEqual(['Courts']);
  expect(coverage.searched[0]).toMatchObject({ failed: 1 });
  expect(coverage.notSearched).toEqual([{ label: 'Sanctions', reason: 'timed out' }]);
});

test('a namesake\'s record, or the same headline in another year, does not count as agreement', () => {
  const report = buildReport(state([
    rec({ title: 'John Smith charged with securities fraud', url: 'https://a.test/1', date: '2021-03-01', severity: 'high', category: 'regulatory' }),
    rec({ title: 'John Smith charged with securities fraud', url: 'https://b.test/1', date: '2015-03-01', severity: 'high', match: 'possible' }),
    rec({ title: 'John Smith charged with securities fraud', url: 'https://c.test/1', date: '2016-03-01', severity: 'high' }),
    rec({ title: 'John Smith charged with securities fraud', url: 'https://d.test/1', date: '2021-03-02', severity: 'high' }),
  ]));
  const by = (host) => report.sections.flatMap((x) => x.items).find((f) => f.url.includes(host));
  expect(by('a.test').corroboration).toBe(2); // the same-year report from another site
  expect(by('b.test').corroboration).toBe(1);
  expect(by('c.test').corroboration).toBe(1);
});

test('separate matters of one kind in one month, undated records, and different companies stay apart', () => {
  const report = buildReport(state([
    rec({ title: 'John Smith sued by former employee over unpaid wages', url: 'https://a.test/1', date: '2023-05-02', severity: 'medium', category: 'litigation' }),
    rec({ title: 'Investors file lawsuit against John Smith over Zeta stock sale', url: 'https://b.test/1', date: '2023-05-20', severity: 'medium', category: 'litigation' }),
    rec({ title: 'John Smith hit with lawsuit from former employee seeking unpaid wages', url: 'https://c.test/1', date: '2023-05-03', severity: 'medium' }),
    rec({ title: 'John Smith sued by landlord', url: 'https://d.test/1', severity: 'medium' }),
    rec({ title: 'John Smith named in shareholder lawsuit', url: 'https://e.test/1', severity: 'medium' }),
    rec({ title: 'Zeta Corp sued for patent infringement', url: 'https://f.test/1', date: '2022-01-05', severity: 'medium', match: 'company', via: 'company: Zeta Corp' }),
    rec({ title: 'Omega Inc sued for patent infringement', url: 'https://g.test/1', date: '2022-01-09', severity: 'medium', match: 'company', via: 'company: Omega Inc' }),
    // a namesake's lawsuit in the same month is not coverage of the founder's
    rec({ title: 'John Smith sued by neighbour over fence', url: 'https://h.test/1', date: '2023-05-04', severity: 'medium', match: 'possible' }),
  ]));
  expect(report.totals.redFlags).toBe(4);
  const wages = report.redFlags.find((f) => /unpaid wages/.test(f.title));
  expect(wages.more.map((m) => m.url)).toEqual(['https://c.test/1']);
  expect(report.totals.companyMatters).toBe(2);
  expect(report.possibleNamesake.map((f) => f.url)).toEqual(['https://h.test/1']);
});

test('archive changes matched by name only are not claims that changed; the quoted brief asks to rule them out', () => {
  const report = buildReport(state([
    rec({ category: 'archive', severity: 'low', title: 'John Smith: title changed', url: 'https://web.archive.org/1', data: { kind: 'change' } }),
    rec({ category: 'archive', severity: 'low', title: 'J Smith profile: school changed', url: 'https://web.archive.org/2', match: 'possible', data: { kind: 'change' } }),
  ]));
  expect(report.claimChanges.map((f) => f.title)).toEqual(['John Smith: title changed']);
  const brief = quotedDeepBrief(report, 'x');
  const changed = brief.split('## CLAIMS THAT CHANGED OVER TIME')[1].split('##')[0];
  expect(changed).not.toMatch(/school changed/);
  expect(brief).toMatch(/Rule out a namesake: J Smith profile: school changed \[Source \d+\]/);
});

test('related parties are keyed like threads and say when a watchlist lookup ran for them', () => {
  const s = state([
    rec({ title: 'Christian Holmes IV joins board', url: 'https://a.test/1', data: { person: 'Christian Holmes IV' } }),
    rec({ title: 'Mary Jones appointed', url: 'https://b.test/1', data: { person: 'Mary Jones' } }),
  ], {
    threads: {
      'relative|christian holmes': { kind: 'relative', value: 'Christian Holmes', trusted: true, relation: 'brother' },
      'associate|mary jones': { kind: 'associate', value: 'Mary Jones', trusted: true },
    },
    done: ['sanctions-lists|relative|christian holmes iv|', 'web-search|associate|mary jones|q.person', 'sanctions-lists|company|mary jones|'],
    // round 3: screened only when the lookup answered (a key in done may be a lookup that failed)
    screenedOk: ['sanctions-lists|relative|christian holmes iv|'],
  });
  const parties = buildReport(s).relatedParties;
  const christian = parties.find((p) => p.name === 'Christian Holmes');
  expect(christian.records.map((r) => r.title)).toEqual(['Christian Holmes IV joins board']);
  expect(christian.screened).toBe(true);
  const mary = parties.find((p) => p.name === 'Mary Jones');
  expect(mary.records).toHaveLength(1);
  expect(mary.screened).toBeUndefined();
});

function briefReport() {
  // Nine records; with maxRecords 2 the model is shown only the two strongest.
  const findings = [rec({ title: 'John Smith convicted of wire fraud', url: 'https://a.test/0', severity: 'high', category: 'regulatory', date: '2020-01-01' })];
  for (let i = 1; i < 9; i += 1) findings.push(rec({ title: `John Smith spoke at event ${i}`, url: `https://x${i}.test/`, date: `2019-01-0${i}` }));
  return buildReport(state(findings));
}

test('a brief citing only records the model was not shown is rejected, and bullets resting on them are dropped', async () => {
  const report = briefReport();
  const unshownOnly = `${DEEP_SECTIONS.map((h) => `${h}\n• claim [Source 9]`).join('\n\n')}\nCONFIDENCE: Low - x`;
  const complete = jest.fn(async (messages, options) => (options.accept(unshownOnly) ? { text: unshownOnly, providerLabel: 'G', model: 'm' } : null));
  const rejected = await writeDeepBrief(report, { complete, maxRecords: 2 });
  expect(rejected.briefInfo.mode).toBe('quoted');
  const mixed = `${DEEP_SECTIONS.map((h) => `${h}\n• shown [Source 1]\n• unshown [Source 9]`).join('\n\n')}\nCONFIDENCE: Low - x`;
  const ok = await writeDeepBrief(report, { complete: async (m, o) => (o.accept(mixed) ? { text: mixed, providerLabel: 'G', model: 'm' } : null), maxRecords: 2 });
  expect(ok.briefInfo.mode).toBe('ai');
  expect(ok.brief).toMatch(/• shown \[Source 1\]/);
  expect(ok.brief).not.toMatch(/unshown/);
});

test('a saved report without scores still gives the model its most serious records', async () => {
  const report = briefReport();
  const strip = (f) => { const { score, ...rest } = f; return rest; };
  const saved = { ...report, redFlags: [], sections: report.sections.map((sec) => ({ ...sec, items: [...sec.items].reverse().map(strip) })) };
  const complete = jest.fn(async () => null);
  await writeDeepBrief(saved, { complete, maxRecords: 2 });
  const sent = complete.mock.calls[0][0][1].content;
  expect(sent).toMatch(/convicted of wire fraud/);
});
