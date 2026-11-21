/**
 * Round 4 (review 2026-11-21): the brief rebuilt for the four saved runs and read as the investor reads it.
 * r10 (after the round 3 repair) is read as saved; the r9 runs (older shape) are rebuilt from their records.
 * Every factual line cites a record; no name-only record is stated as fact; each matter carries its latest
 * outcome; no site furniture; nothing cut inside a number; the screens that did not answer in one short sentence.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const fs = require('fs');
const path = require('path');
const { buildReport, quotedDeepBrief } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

const RUNS = path.join(__dirname, '../../../eval/founder/runs');
const load = (file) => JSON.parse(fs.readFileSync(path.join(RUNS, file), 'utf8'));
/** A check state rebuilt from a saved report: its records, its sources (answered, partial, silent and off) and its threads. */
function stateFrom(file) {
  const saved = load(file);
  const s = startState({ name: saved.name, company: saved.company || '' });
  const seen = new Map();
  for (const sec of saved.sections) {
    for (const f of sec.items) {
      if (seen.has(f.id)) continue;
      const { n, score, corroboration, more, alsoIn, ...rest } = f;
      seen.set(f.id, rest);
    }
  }
  s.findings = [...seen.values()];
  s.sources = Object.fromEntries((saved.coverage.searched || []).map((x) => [x.id, { label: x.label, runs: x.lookups, findings: x.records, errors: x.failed || 0, lastError: x.lastError, waitedOut: x.waitedOut, partial: x.partial }]));
  const ids = new Map((saved.screens || []).flatMap((g) => g.items).map((i) => [i.label, i.id]));
  for (const x of saved.coverage.notSearched || []) {
    const id = ids.get(x.label) || x.label;
    if (!s.sources[id]) s.sources[id] = x.off ? { label: x.label, off: true } : { label: x.label, runs: 1, errors: 1, lastError: x.reason };
  }
  s.threads = Object.fromEntries((saved.threads || []).map((t, i) => [`${t.kind}|${i}`, { ...t, trusted: true }]));
  return s;
}
const section = (brief, heading) => (brief.split(`## ${heading}\n`)[1] || '').split('\n## ')[0];
const FACT = ['BOTTOM LINE', 'RED FLAGS', 'CAREER AND EDUCATION', 'COMPANY', 'WHAT CHECKS OUT', 'CLAIMS THAT CHANGED OVER TIME', 'RELATED PARTIES'];
const TIED = ['CAREER AND EDUCATION', 'COMPANY', 'WHAT CHECKS OUT'];
const BANNED = /\b(?:API|free|paid|tier|quota|token)\b/i;

const RUNS_READ = [
  ['r10/eric-glyman-ramp.json', () => load('r10/eric-glyman-ramp.json')],
  ['r9/eric-glyman-ramp.json', () => buildReport(stateFrom('r9/eric-glyman-ramp.json'))],
  ['r9/trevor-milton-nikola.json', () => buildReport(stateFrom('r9/trevor-milton-nikola.json'))],
  ['r9/jack-zhang-airwallex.json', () => buildReport(stateFrom('r9/jack-zhang-airwallex.json'))],
];

describe.each(RUNS_READ)('the brief of %s, read as the investor reads it', (file, make) => {
  const report = make();
  const brief = quotedDeepBrief(report, 'No AI model answered');
  const matchOf = new Map((report.sources || []).map((s) => [s.n, s.match]));

  test('every factual bullet cites a record, and no line about the person rests only on name-only records', () => {
    for (const h of FACT) {
      // the leads under "To confirm with the person" are questions about name-only records, never facts
      const facts = section(brief, h).split(/\nTo confirm with the person[^\n]*\n/)[0];
      for (const line of facts.split('\n').filter((l) => l.startsWith('• ') && !/^• … and \d+ more/.test(l))) {
        expect(line).toMatch(/\[Source \d+\]/);
        if (TIED.includes(h) || h === 'RED FLAGS') {
          const ns = [...line.matchAll(/\[Source (\d+)\]/g)].map((m) => Number(m[1]));
          expect(ns.some((x) => matchOf.get(x) && matchOf.get(x) !== 'possible')).toBe(true);
        }
      }
    }
  });

  test('each red flag with an outcome shows it beside the matter', () => {
    const flags = section(brief, 'RED FLAGS');
    for (const f of (report.redFlags || []).slice(0, 14).filter((x) => x.outcome?.text)) {
      expect(flags).toMatch(new RegExp(`latest outcome: ${f.outcome.text}[^\\n]*\\[Source ${f.n}\\]`));
    }
  });

  test('no site furniture, no headline publisher tails in the company section, nothing cut inside a number', () => {
    expect(brief).not.toMatch(/Skip to (?:navigation|content)|Today's Paper|Accessibility statement/i);
    expect(section(brief, 'COMPANY')).not.toMatch(/ - (?:CNBC|saastr\.com)\./);
    expect(brief).not.toMatch(/\d[-,./:]…/);
    expect(brief).not.toMatch(BANNED);
  });

  test('the screens that did not answer in full are one short sentence of counts in the bottom line', () => {
    const bottom = section(brief, 'BOTTOM LINE');
    const sentence = (bottom.match(/(?:Of the public-record screens[^.]*\(see Public-record screens\)|Every public-record screen that was asked answered in full)\./) || [''])[0];
    expect(sentence).not.toBe('');
    expect(sentence.length).toBeLessThan(170);
    expect(bottom).not.toMatch(/Screens that not enabled/);
  });

  test('the latest funding named in the bottom line is dated, and never a sum from a crime or a settlement', () => {
    const bottom = section(brief, 'BOTTOM LINE');
    const m = /latest dated funding on record is ([^[]+)\[/.exec(bottom);
    if (m) expect(m[1]).toMatch(/\(\d{4}-\d{2}(?:-\d{2})?\)/);
    expect(bottom).not.toMatch(/latest funding on record is \$30M/);
  });
});

describe('Trevor Milton / Nikola (r9): one prosecution, with its pardon', () => {
  const report = buildReport(stateFrom('r9/trevor-milton-nikola.json'));
  const brief = quotedDeepBrief(report, 'x');

  test('the red flags are matters, not reports: well under the 35 the earlier code listed', () => {
    expect(report.redFlags.length).toBeLessThanOrEqual(18);
    // the charges, the trial, the conviction and the sentence are one red flag, which the pardon ends
    const prosecution = report.redFlags[0];
    expect(prosecution.title).toMatch(/Sentenced To Four Years/);
    expect(prosecution.stages.map((s) => s.tag)).toEqual(expect.arrayContaining(['charges', 'conviction', 'sentence']));
    expect(prosecution.outcome).toMatchObject({ text: 'pardoned', date: '2025-03-28' });
    expect(report.redFlags.some((f) => /Trump pardons/.test(f.title))).toBe(false);
  });

  test('the bottom line names the pardon beside the most serious matter, and no funding from a sentencing', () => {
    const bottom = section(brief, 'BOTTOM LINE');
    expect(bottom).toMatch(/the most serious: Trevor Milton Sentenced To Four Years[^.]*latest outcome: pardoned/);
    expect(bottom).not.toMatch(/\$600M/);
    expect(section(brief, 'WHAT CHECKS OUT')).not.toMatch(/funding round: \$1 billion/);
    expect(section(brief, 'COMPANY')).not.toMatch(/trevormilton\.com/);
  });

  test('one question about the prosecution, asking for its final documents', () => {
    const qs = section(brief, 'QUESTIONS FOR THE FOUNDER');
    expect(qs.match(/Sentenced To Four Years|Charged In Securities Fraud/g)).toHaveLength(1);
    expect(qs).not.toMatch(/cnbc\.com page: bio rewritten/);
  });
});

describe('Eric Glyman / Ramp (r10, as saved)', () => {
  const report = load('r10/eric-glyman-ramp.json');
  const brief = quotedDeepBrief(report, 'x');

  test('the undated $30M is never the latest; the latest dated raise is', () => {
    expect(section(brief, 'BOTTOM LINE')).toMatch(/the latest dated funding on record is a reported raise of \$300M \(2021-08-24\)/);
    expect(section(brief, 'COMPANY')).not.toMatch(/\$2B/);
  });
  test('UK and register names are registered entities, in one line', () => {
    const checks = section(brief, 'WHAT CHECKS OUT');
    expect(checks).not.toMatch(/is the legal name of Ramp on a register entry/);
    expect(checks.match(/registered entities of Ramp/g)).toHaveLength(1);
  });
  test('the three dockets naming the company are one line, each saying it has no filing year on record', () => {
    const flags = section(brief, 'RED FLAGS');
    expect(flags.match(/Court cases naming Ramp as a party/g)).toHaveLength(1);
    expect(flags.match(/no filing year on record/g)).toHaveLength(3);
  });
  test('the change in his headline is written in full, not cut inside a date', () => {
    expect(section(brief, 'CLAIMS THAT CHANGED OVER TIME')).toMatch(/headline changed between 2017-05-11 and 2020-12-17/);
  });
});

describe('Jack Zhang / Airwallex (r9)', () => {
  const report = buildReport(stateFrom('r9/jack-zhang-airwallex.json'));
  const brief = quotedDeepBrief(report, 'x');
  test('no funding read from a valuation headline, and a press red flag asks for his account', () => {
    expect(section(brief, 'COMPANY')).not.toMatch(/\$15\.9 billion/);
    expect(section(brief, 'QUESTIONS FOR THE FOUNDER')).not.toMatch(/final court or regulator documents: Career, as told on afr\.com/);
  });
});
