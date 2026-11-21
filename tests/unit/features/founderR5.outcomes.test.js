/**
 * Round 5, outcomes (live check r11, Trevor Milton / Nikola): a record that states a conviction is not read as an
 * acquittal because one count ended that way, and an acquittal, dismissal or drop never becomes the latest outcome
 * of (nor lowers) a criminal matter of a person a tied record says was convicted or sentenced in that case or
 * period. The brief's bottom line opens with the profile headline, and calls a name common only when the name
 * lists say so.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const fs = require('fs');
const path = require('path');
const { makeFinding } = require('../../../src/server/founder/finding');
const { createSubject } = require('../../../src/server/founder/identity');
const { buildReport, quotedDeepBrief } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

const RUNS = path.join(__dirname, '../../../eval/founder/runs');
const saved = (file) => JSON.parse(fs.readFileSync(path.join(RUNS, file), 'utf8'));
/** A check state rebuilt from a saved report: its records and its sources. */
function stateFrom(file) {
  const rep = saved(file);
  const s = startState({ name: rep.name, company: rep.company || '' });
  const seen = new Map();
  for (const sec of rep.sections) {
    for (const f of sec.items) {
      if (seen.has(f.id)) continue;
      const { n, score, corroboration, more, alsoIn, ...rest } = f;
      seen.set(f.id, rest);
    }
  }
  s.findings = [...seen.values()];
  s.sources = Object.fromEntries((rep.coverage.searched || []).map((x) => [x.id, { label: x.label, runs: x.lookups, findings: x.records, errors: x.failed || 0, lastError: x.lastError }]));
  s.threads = Object.fromEntries((rep.threads || []).map((t, i) => [`${t.kind}|${i}`, { ...t, trusted: true }]));
  return s;
}
const section = (brief, heading) => (brief.split(`## ${heading}\n`)[1] || '').split('\n## ')[0];
const CLEARING = /^(?:acquitted|dismissed|dropped)$/;
const allMatters = (r) => [...r.redFlags, ...r.ifRightPerson, ...r.companyMatters];

describe('finding.js: a text that states a conviction is not an acquittal', () => {
  const milton = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
  const roe = createSubject({ name: 'Jane Roe', company: 'Zeta' });
  const make = (subject, title, quote) => makeFinding(subject, { source: 'littlesis', sourceLabel: 'LittleSis', category: 'press', title, quote, url: `https://x.test/${encodeURIComponent(title)}`, match: 'confirmed', severity: 'high' });

  test('the LittleSis summary of record [4] (r11) reads as convicted, one count otherwise', () => {
    const q = 'He was convicted in October 2022 on one count of securities fraud and two counts of wire fraud, and acquitted on an additional securities fraud count.';
    const f = make(milton, `Trevor Milton (LittleSis summary): ${q.slice(0, 120)}…`, q);
    expect(f.data.outcome.outcome).toBe('convicted');
    expect(f.data.outcome.otherCounts).toBe('acquitted');
  });

  test.each([
    ['Jane Roe pleaded guilty to wire fraud; the remaining counts were dismissed.', 'dismissed'],
    ['Jane Roe was found guilty of bank fraud, and prosecutors dropped two further charges.', 'dropped'],
    ['Jane Roe was sentenced to two years; she was acquitted of conspiracy.', 'acquitted'],
  ])('%s -> convicted', (text, other) => {
    const f = make(roe, text, text);
    expect(f.data.outcome.outcome).toBe('convicted');
    expect(f.data.outcome.otherCounts).toBe(other);
  });

  test.each([
    ['Jane Roe acquitted of all charges in fraud trial', 'acquitted'],
    ['Jane Roe was never convicted; the charges were dropped in 2021.', 'dropped'],
    ['Jane Roe, convicted in 2019, was acquitted on appeal in 2021.', 'acquitted'],
    ['Jane Roe was acquitted of fraud; her co-founder John Doe was convicted.', 'acquitted'],
    ['Jane Roe was acquitted of fraud, which could have seen her sentenced to ten years.', 'acquitted'],
  ])('%s keeps its clearing outcome', (text, outcome) => {
    const f = make(roe, text, text);
    expect(f.data.outcome.outcome).toBe(outcome);
  });
});

describe('report.js: the Milton run (r11) never tells a convicted man he was acquitted', () => {
  const report = buildReport(stateFrom('r11/trevor-milton-nikola.json'));

  test('no criminal matter of his carries an acquittal, dismissal or drop as its latest outcome', () => {
    const bad = allMatters(report).filter((m) => m.outcome && CLEARING.test(m.outcome.text) && /fraud|convict|charg|indict|sentenc/i.test(m.title));
    expect(bad.map((m) => [m.n, m.title, m.outcome.text])).toEqual([]);
  });

  test('the charging press release stays high and the conviction record is not cleared', () => {
    const charged = allMatters(report).find((m) => /Charged In Securities Fraud Scheme/.test(m.title) || (m.more || []).some((x) => /Charged In Securities Fraud Scheme/.test(x.title)));
    expect(charged).toBeTruthy();
    expect(charged.severity).toBe('high');
    const brief = quotedDeepBrief(report, 'x');
    expect(brief).not.toMatch(/latest outcome: acquitted/);
  });

  test('a lawsuit he dropped himself keeps its outcome (only criminal matters are guarded)', () => {
    const dropped = allMatters(report).find((m) => /Drops Utah Lawsuit/.test(m.title));
    if (dropped) expect(dropped.outcome?.text).toBe('dropped');
  });
});

describe('report.js: the guard on clearing outcomes, built from records', () => {
  let seq = 0;
  const rec = (o) => ({ id: `o${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', quote: '', match: 'confirmed', matchReasons: [], ...o });
  const state = (findings) => Object.assign(startState({ name: 'Jane Roe', company: 'Zeta' }), { findings });

  test('an acquittal on one count in the year of a conviction is not the outcome of the charges', () => {
    // the shape of r11: the charging release, a conviction record of its own, and a summary that reports only the
    // count that ended in an acquittal
    const report = buildReport(state([
      rec({ title: 'Former Zeta CEO Jane Roe Charged In Securities Fraud Scheme', url: 'https://a.test/1', date: '2021-07-29', severity: 'high', source: 'doj-press-releases', sourceLabel: 'DOJ' }),
      rec({ title: 'Jane Roe: convicted of securities fraud (2022)', url: 'https://a.test/2', date: '2022', severity: 'high', source: 'wikidata', sourceLabel: 'Wikidata', category: 'identity' }),
      rec({ title: 'Jane Roe (LittleSis summary): She was charged in a securities fraud scheme and acquitted on an additional securities fraud count', url: 'https://a.test/3', date: '2022-10', severity: 'high', source: 'littlesis', sourceLabel: 'LittleSis', data: { outcome: { outcome: 'acquitted', role: 'defendant' } } }),
    ]));
    const charged = allMatters(report).find((m) => /Charged In Securities Fraud Scheme/.test(m.title));
    expect(charged.severity).toBe('high');
    for (const m of allMatters(report)) if (m.outcome) expect(m.outcome.text).not.toBe('acquitted');
  });

  test('an acquittal years from any conviction still clears its charges', () => {
    const report = buildReport(state([
      rec({ title: 'Jane Roe charged with securities fraud', url: 'https://b.test/1', date: '2019-03-01', severity: 'high', source: 'doj-press-releases', sourceLabel: 'DOJ' }),
      rec({ title: 'Jane Roe acquitted of securities fraud', url: 'https://b.test/2', date: '2019-11-10', severity: 'low', data: { outcome: { outcome: 'acquitted', role: 'defendant' } } }),
    ]));
    const charged = allMatters(report).find((m) => /charged with securities fraud/.test(m.title));
    expect(charged.outcome?.text).toBe('acquitted');
    expect(charged.severity).toBe('low');
  });
});

describe('the bottom line (r11 Milton, r9 Glyman)', () => {
  test('it opens with the profile headline, then the current role, never a list membership first', () => {
    const report = buildReport(stateFrom('r11/trevor-milton-nikola.json'));
    // the saved profile as the page saw it, Forbes line included, so the brief is robust to it
    const savedProfile = saved('r11/trevor-milton-nikola.json').profile;
    const bottom = section(quotedDeepBrief({ ...report, profile: savedProfile }, 'x'), 'BOTTOM LINE');
    expect(bottom).toMatch(/^Trevor Milton: Founder, Nikola \(former CEO and Executive Chairman, until 2020\) \[Source \d+\]/);
    expect(bottom).toMatch(/CEO of SyberJet Aircraft/);
    expect(bottom).not.toMatch(/Forbes/);
  });

  test('a current role at the headline company keeps its dated wording', () => {
    const report = buildReport(stateFrom('r9/eric-glyman-ramp.json'));
    expect(section(quotedDeepBrief(report, 'x'), 'BOTTOM LINE')).toMatch(/^Eric Glyman is Co-Founder and Co-CEO of Ramp/);
  });
});

describe('a name is called common only when the name lists say so', () => {
  test('Milton: the name-only records are counted and may include others; the name is not called shared', () => {
    const report = buildReport(stateFrom('r11/trevor-milton-nikola.json'));
    expect(report.commonName).toBeNull();
    expect(report.nameOnly).toMatchObject({ records: report.totals.possible });
    const bottom = section(quotedDeepBrief(report, 'x'), 'BOTTOM LINE');
    expect(bottom).not.toMatch(/name is shared/);
    expect(bottom).toMatch(/match the name only were not tied to Trevor Milton by a second fact and are kept apart; they may include other people of the same name/);
  });

  test('a saved report with the old guess is worded as a possibility too', () => {
    const old = saved('r11/trevor-milton-nikola.json');
    const bottom = section(quotedDeepBrief(old, 'x'), 'BOTTOM LINE');
    expect(bottom).not.toMatch(/name is shared/);
    expect(bottom).toMatch(/may include other people of the same name/);
  });

  test('a very common name is still said to be one', () => {
    const report = buildReport(Object.assign(startState({ name: 'John Smith', company: 'Zeta' }), {
      findings: [{ id: 'c1', source: 'news-archive', sourceLabel: 'News', category: 'press', title: 'John Smith of Acme', url: 'https://cn.test/1', quote: '', match: 'possible', matchReasons: [], severity: 'info' }],
    }));
    expect(report.commonName).toMatchObject({ common: true, reason: 'very common name' });
    expect(section(quotedDeepBrief(report, 'x'), 'BOTTOM LINE')).toMatch(/John Smith is a very common name/);
  });
});
