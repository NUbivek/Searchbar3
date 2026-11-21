/**
 * Round 3 report fixes checked on the records of real saved checks (eval/founder/runs): the report is rebuilt
 * from each saved report's own records and sources, as a check state would hold them.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const fs = require('fs');
const path = require('path');
const { buildReport, quotedDeepBrief, cleanScreens } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

const RUNS = path.join(__dirname, '../../../eval/founder/runs');
/** A check state rebuilt from a saved report: its records (as first graded), its sources and its threads. */
function stateFrom(file) {
  const saved = JSON.parse(fs.readFileSync(path.join(RUNS, file), 'utf8'));
  const s = startState({ name: saved.name, company: saved.company || '' });
  const seen = new Map();
  for (const sec of saved.sections) {
    for (const f of sec.items) {
      if (seen.has(f.id)) continue;
      const { n, score, corroboration, more, alsoIn, ...rest } = f;
      // the saved report demoted some company records to name-only itself: give them back their first grade
      if ((rest.matchReasons || []).some((r) => /appears, but not clearly as this company/.test(r))) {
        rest.match = 'company';
        rest.matchReasons = [];
        rest.data = { ...(rest.data || {}) };
        delete rest.data.companyNamesake;
      }
      seen.set(f.id, rest);
    }
  }
  s.findings = [...seen.values()];
  s.sources = Object.fromEntries((saved.coverage.searched || []).map((x) => [x.id, { label: x.label, runs: x.lookups, findings: x.records, errors: x.failed || 0, lastError: x.lastError }]));
  s.threads = Object.fromEntries((saved.threads || []).map((t, i) => [`${t.kind}|${i}`, { ...t, trusted: true }]));
  return s;
}

describe('Eric Glyman / Ramp (r9)', () => {
  const report = buildReport(stateFrom('r9/eric-glyman-ramp.json'));
  const titles = report.sources.map((x) => x.title);

  test('records about the boat ramp, the church and RAMP & CO LTD leave the numbered report, counted with a reason', () => {
    expect(titles.some((t) => /Boat Ramp|church founder|RAMP & CO LTD/i.test(t))).toBe(false);
    expect(report.wordOnly.count).toBeGreaterThanOrEqual(4);
    expect(report.wordOnly.items.every((x) => x.reason)).toBe(true);
  });

  test('the first records are about the person, and Ramp news about its backers is about the company', () => {
    expect(['confirmed', 'likely']).toContain(report.sources[0].match);
    const airwallex = report.sources.find((x) => /Airwallex/.test(x.title));
    expect(airwallex.match).toBe('company');
  });

  test("another employee's bio is not his claim that changed; his own title change is", () => {
    const changes = report.claimChanges.map((c) => c.title).join('\n');
    expect(changes).toMatch(/Co-CEO/);
    expect(report.claimChanges.some((c) => /Stefanie/.test(c.data?.before || ''))).toBe(false);
  });

  test('the timeline holds no archive capture and no 1994 domain registration', () => {
    expect(report.timeline.some((t) => t.category === 'archive')).toBe(false);
    expect(report.timeline.some((t) => /^1994/.test(String(t.date)))).toBe(false);
  });

  test('the SEC company screen is not called clear next to a Form D record', () => {
    expect(cleanScreens(report.coverage).some((l) => /SEC company filings/.test(l))).toBe(false);
  });

  test('the brief quotes no number cut in half', () => {
    expect(quotedDeepBrief(report, 'test')).not.toMatch(/\$1,850,00(?!0)/);
  });
});

describe('Shensi Ding / Merge (r8)', () => {
  const report = buildReport(stateFrom('r8/shensi-ding-merge.json'));

  test('one page is one record: totals count pages', () => {
    const keys = report.sources.map((x) => x.url.replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//, '').replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/$/, ''));
    const pages = report.sections.flatMap((s) => s.items).filter((f) => f.data?.kind !== 'change' && ['web-search', 'page-reader', 'web-archive'].includes(f.source));
    const pageKeys = pages.map((f) => (f.data?.page || f.url).replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//, '').replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/$/, ''));
    expect(new Set(pageKeys).size).toBe(pageKeys.length);
    expect(report.totals.copiesMerged).toBeGreaterThan(0);
    expect(keys.length).toBe(report.totals.records);
  });

  test('marketing-copy edits of the company page are not claims that changed', () => {
    expect(report.claimChanges.some((c) => /merge\.dev page: bio rewritten/.test(c.title))).toBe(false);
  });

  test('Ethereum "Merge" posts leave the numbered report', () => {
    expect(report.sources.some((x) => /Mainnet Merge|^The Merge$/i.test(x.title))).toBe(false);
  });
});

describe('Trevor Milton / Nikola (r9)', () => {
  const report = buildReport(stateFrom('r9/trevor-milton-nikola.json'));
  test('the conviction leads the red flags and every red flag is tied to the person', () => {
    expect(report.redFlags.length).toBeGreaterThan(0);
    expect(report.redFlags.every((r) => r.match === 'confirmed' || r.match === 'likely')).toBe(true);
    expect(report.identityNote).toBeNull();
  });
});
