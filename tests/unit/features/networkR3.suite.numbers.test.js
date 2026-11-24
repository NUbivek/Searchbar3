/**
 * ROUND2 R8, "one number per thing": for the same people, the read-out, the
 * shortcut, the map's group and a typed answer say the same number, on all
 * six samples, in one test. Each shortcut is typed back as a question and
 * found on the map; the people (not only their number) must be the same.
 * All people are invented (tests/fixtures/network).
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(), queryOne: jest.fn(), persistenceMode: jest.fn(() => 'pglite'), PersistenceUnavailableError: class extends Error {},
}));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null) }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [], fundingRounds: [] })) }));

const fs = require('fs');
const path = require('path');
const { chatComplete } = require('../../../src/server/llm/providers');
const { parseLinkedInConnectionsCsv, parseGenericCsv } = require('../../../src/utils/network/parseContacts');
const { familyByKey } = require('../../../src/utils/network/roles');
const { profileNetwork } = require('../../../src/utils/network/insights');
const { buildAtlas } = require('../../../src/utils/network/atlas');
const { answerQuestion } = require('../../../src/server/network/query');

const DIR = path.resolve(__dirname, '../../fixtures/network');
const load = (file) => {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const r = file.includes('linkedin') ? parseLinkedInConnectionsCsv(text) : parseGenericCsv(text);
  return r.contacts || r;
};
const FILES = ['vc-investor-linkedin.csv', 'founder-operator-linkedin.csv', 'sales-crm.csv', 'healthcare-academic.csv', 'lp-fundraising-list.csv', 'small-network-linkedin.csv'];
const TODAY = '2026-11-21';
const num = (s) => Number(String(s).replace(/,/g, ''));
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sorted = (a) => [...a].sort();

/** The question a user would type for a shortcut, in the shortcut's own words. */
function questionFor(s) {
  const key = s.id.slice(s.id.indexOf(':') + 1);
  switch (s.type) {
    case 'role': return `Which ${familyByKey(key).many} do I know?`;
    case 'company': return `Who do I know ${s.short}?`;
    case 'industry': case 'place': return `Who do I know ${s.short}?`;
    case 'tag': return `everyone ${s.short}`;
    case 'senior': return 'Which senior leaders do I know?';
    case 'recent': return `Who have I ${s.short}?`;
    default: return null;
  }
}

/** The map's group for a shortcut, in the arrangement that shows it, or null. */
function groupFor(atlases, s) {
  const key = s.id.slice(s.id.indexOf(':') + 1);
  const find = (groupBy, test) => {
    const a = atlases[groupBy];
    const node = a && a.nodes.find((n) => n.type === 'group' && test(n));
    return node ? { count: node.count, ids: a.groupIndex.get(node.id) } : null;
  };
  if (s.type === 'role') return find('role', (n) => n.dim === 'role' && n.key === key);
  if (s.type === 'tag') return find('tag', (n) => n.dim === 'tag' && n.key === key);
  if (s.type === 'industry') return find('industry', (n) => n.dim === 'industry' && n.label === key);
  if (s.type === 'company') {
    // One company can sit in several groups: the map counts all its nodes.
    const a = atlases.company;
    const ids = (a.companyIndex.get(key) || []).flatMap((id) => a.byId.get(id).contacts);
    return ids.length ? { count: ids.length, ids: null } : null;
  }
  return null;
}

/** The number the read-out says for a shortcut's people, or null when it does not name them. */
function readOutFor(text, s) {
  const key = s.id.slice(s.id.indexOf(':') + 1);
  let m = null;
  if (s.type === 'role') {
    const f = familyByKey(key);
    m = text.match(new RegExp(`(\\d[\\d,]*) (?:${esc(f.many)}|${esc(f.one)})\\b`));
  } else if (s.type === 'tag') {
    m = text.match(new RegExp(`(\\d[\\d,]*) ${esc(s.short.replace(/^tagged /, ''))}`));
  } else if (s.type === 'company' || s.type === 'industry' || s.type === 'place') {
    m = text.match(new RegExp(`${esc(s.short.replace(/^(at|in) /, ''))} \\((\\d[\\d,]*)\\)`));
  }
  return m ? num(m[1]) : null;
}

describe('one number per thing (ROUND2 R8)', () => {
  test('read-out, shortcut, map group and typed answer agree on all six samples', async () => {
    const checked = { readOut: 0, map: 0, answer: 0 };
    const report = [];
    for (const file of FILES) {
      const contacts = load(file);
      const p = profileNetwork(contacts, { today: TODAY });
      const atlases = Object.fromEntries(['role', 'tag', 'industry', 'company'].map((g) => [g, buildAtlas(contacts, { groupBy: g })]));
      const text = p.sentences.join(' ');
      for (const s of [...p.shortcuts, ...p.more]) {
        const where = `${file} · ${s.label}`;
        // The label says the count.
        expect([where, s.label.includes(s.count.toLocaleString('en-US'))]).toEqual([where, true]);
        const said = readOutFor(text, s);
        if (said !== null) { expect([where, 'read-out', said]).toEqual([where, 'read-out', s.count]); checked.readOut += 1; }
        const g = groupFor(atlases, s);
        if (g) {
          expect([where, 'map', g.count]).toEqual([where, 'map', s.count]);
          if (g.ids) expect([where, sorted(g.ids)]).toEqual([where, sorted(s.keys)]);
          checked.map += 1;
        }
        const q = questionFor(s);
        if (!q) continue;
        // eslint-disable-next-line no-await-in-loop
        const out = await answerQuestion(contacts, { question: q, useLlm: true, today: TODAY });
        expect([where, q, out.parsedBy]).toEqual([where, q, 'rules']);
        expect([where, q, out.total]).toEqual([where, q, s.count]);
        expect([where, q, sorted(out.keys.map((k) => `p:${k}`))]).toEqual([where, q, sorted(s.keys)]);
        checked.answer += 1;
        report.push(`${where}: ${s.count}`);
      }
      // Each example question answers its own count.
      for (const ex of p.questions) {
        // eslint-disable-next-line no-await-in-loop
        const out = await answerQuestion(contacts, { question: ex.text, fromPage: true, today: TODAY });
        expect([file, ex.text, out.total]).toEqual([file, ex.text, ex.count]);
      }
    }
    // Every kind of number was compared somewhere, and the model was never asked.
    expect(checked.readOut).toBeGreaterThan(10);
    expect(checked.map).toBeGreaterThan(20);
    expect(checked.answer).toBeGreaterThan(40);
    expect(chatComplete).not.toHaveBeenCalled();
  });
});
