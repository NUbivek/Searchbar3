/**
 * Round 3, the last pass over the whole Network Map: the requests the
 * owners made of files they did not own, and the acceptance lists of
 * SPEC.md section 9 and ROUND2.md checked on all six samples at once.
 */
import fs from 'fs';
import path from 'path';
import { introPaths } from '../../../src/server/network/query';

const FIX = path.join(__dirname, '../../fixtures/network');

describe('intro paths through investors (page-b request)', () => {
  test('each investor group carries every contact key there, not only the 50 listed', async () => {
    const people = Array.from({ length: 70 }, (_, i) => ({ key: `k${i}`, name: `Person ${i}`, company: 'Cobalt Ventures', position: 'Analyst' }));
    // A placeholder employer is never matched to an investor (data-2).
    people.push({ key: 'self', name: 'Solo Person', company: 'Self-employed', position: 'Advisor' });
    const out = await introPaths(people, 'Acme', {
      profileLoader: async () => ({ investors: [{ name: 'Cobalt Ventures', evidence: 'investor' }, { name: 'Self employed', evidence: 'investor' }] }),
    });
    const g = out.viaInvestors.find((x) => x.investor === 'Cobalt Ventures');
    expect(g.contacts).toHaveLength(50);
    expect(g.total).toBe(70);
    expect(g.keys).toHaveLength(70);
    expect(new Set(g.keys).size).toBe(70);
    expect(out.viaInvestors.some((x) => (x.keys || []).includes('self'))).toBe(false);
  });
});

describe('placeholder employers are no company in a question either (data-2, query side)', () => {
  test('"Who do I know at Self-employed?" finds nobody as an employee, and says why', async () => {
    const { answerQuestion } = require('../../../src/server/network/query');
    const people = [
      { key: 'a', name: 'Ann Solo', company: 'Self-employed', position: 'Advisor' },
      { key: 'b', name: 'Bo Stealth', company: 'Stealth Startup', position: 'Founder' },
      { key: 'c', name: 'Cy Real', company: 'Stripe', position: 'Engineer' },
    ];
    const out = await answerQuestion(people, { question: 'Who do I know at Self-employed?', useLlm: false });
    expect(out.keys).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/not a company/i);
    expect(out.understood).toEqual([]);
    // Intro paths to a placeholder never look it up in public sources.
    const loader = jest.fn(async () => ({ investors: [] }));
    const intro = await answerQuestion(people, { target: 'Stealth', profileLoader: loader });
    expect(loader).not.toHaveBeenCalled();
    expect(intro.keys).toEqual([]);
    // A real company in the same question still counts.
    const both = await answerQuestion(people, { question: 'Who do I know at Stripe or Self-employed?', useLlm: false });
    expect(both.keys).toEqual(['c']);
  });
});

test('the globe\'s corner key reads in plain words', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/components/network/NetworkGraph.js'), 'utf8');
  expect(src).not.toMatch(/tip = leader/);
  expect(src).toMatch(/dot = most senior/);
});
