/**
 * Network Map, round 3: the read-out, the shortcuts, "Narrow to" and the
 * atlas after the independent review (eval/network/review-2026-11-21:
 * value-1 to value-17, value-m1 to value-m3, data-2, data-4, data-10,
 * data-11, data-13, data-15, data-16, data-17, data-m1, ask-m1, browser B5,
 * B6, B10) and ROUND2.md R1 to R4, R7 and decisions 7, 8 and 13.
 *
 * Each finding is reproduced on the file its evidence describes, built here
 * from invented people, or on the sample files (tests/fixtures/network).
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(), queryOne: jest.fn(), persistenceMode: jest.fn(() => 'pglite'), PersistenceUnavailableError: class extends Error {},
}));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null) }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [], fundingRounds: [] })) }));

const fs = require('fs');
const path = require('path');
const { parseLinkedInConnectionsCsv, parseGenericCsv } = require('../../../src/utils/network/parseContacts');
const { familyOf, FAMILIES, ROLE_GROUPS } = require('../../../src/utils/network/roles');
const { tagsOf } = require('../../../src/utils/network/grouping');
const {
  buildAtlas, personNodeId, seniority, OTHER_COMPANIES_KEY, NO_COMPANY_KEY, FAMILY_COLORS, MAX_COMPANY_HUBS,
} = require('../../../src/utils/network/atlas');
const {
  profileNetwork, combine, countIfAdded, narrowings, labelFor, shortcutFor, listText, listCsv,
} = require('../../../src/utils/network/insights');
const { chatComplete } = require('../../../src/server/llm/providers');
const { answerQuestion } = require('../../../src/server/network/query');

const DIR = path.resolve(__dirname, '../../fixtures/network');
const load = (file) => {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const r = file.includes('linkedin') ? parseLinkedInConnectionsCsv(text) : parseGenericCsv(text);
  return r.contacts || r;
};
const FILES = ['vc-investor-linkedin.csv', 'founder-operator-linkedin.csv', 'sales-crm.csv', 'healthcare-academic.csv', 'lp-fundraising-list.csv', 'small-network-linkedin.csv'];
const S = Object.fromEntries(FILES.map((f) => [f, load(f)]));
const TODAY = '2026-11-21';
const P = Object.fromEntries(FILES.map((f) => [f, profileNetwork(S[f], { today: TODAY })]));
const c = (name, position, company, extra = {}) => ({ name, position, company, ...extra });
const offered = (p) => [...p.shortcuts, ...p.more];
const text = (p) => p.sentences.join(' ');

// The files the review's evidence describes, invented here.
const FIVE = [
  c('A1', 'Software Engineer', 'Stripe'), c('A2', 'Software Engineer', 'Stripe'), c('A3', 'Founder & CEO', 'Stripe'),
  c('A4', 'Software Engineer', 'Google'), c('A5', 'Software Engineer', 'Google'),
];
const CONFERENCE = Array.from({ length: 400 }, (_, i) => c(`Guest ${i}`, ['Software Engineer', 'Head of Sales', 'Founder', 'Product Manager', 'Partner'][i % 5], `Company ${Math.floor(i / 2) % 300}`, {
  location: ['Berlin, Germany', 'London, United Kingdom', 'Mumbai, India', 'Paris, France', 'New York, NY'][Math.floor(i / 80)],
}));
const FIRMS = ['Sequoia Capital', 'Accel', 'Benchmark', 'Index Ventures', 'Greylock Partners'];
const INVESTORS = Array.from({ length: 90 }, (_, i) => c(`Inv ${i}`, 'Partner', FIRMS[i % 5], { location: 'San Francisco, CA', connectedOn: '2025-11-05' }));
const ENGINEERS = Array.from({ length: 3000 }, (_, i) => c(`Eng ${i}`, 'Software Engineer', `Software Co ${i % 11}`));
const ONE_COMPANY = Array.from({ length: 200 }, (_, i) => c(`Acme ${i}`, ['Software Engineer', 'Account Executive', 'Product Manager'][i % 3], 'Acme Corp'));
const NO_COMPANY = Array.from({ length: 120 }, (_, i) => c(`Nc ${i}`, ['Product Manager', 'Software Engineer', 'Account Executive', 'Registered Nurse', 'Data Scientist'][i % 5], '', { location: ['Austin, TX', 'Boston, MA', 'Chicago, IL', 'Denver, CO', 'Seattle, WA'][i % 5] }));
const ADDRESS_BOOK = Array.from({ length: 250 }, (_, i) => ({
  name: `Friend ${i}`,
  email: i < 60 ? `f${i}@stripe.com` : i < 100 ? `f${i}@acme.com` : i < 200 ? `f${i}@gmail.com` : `f${i}@outlook.com`,
}));

// ------------------------------------------------------------ R1: shortcut labels, "Narrow to"

describe('R1 and value-1: shortcuts say one or many, and narrowing lives in the list', () => {
  test('every shortcut carries one and many, and labelFor picks by count', () => {
    for (const f of FILES) {
      for (const s of [...offered(P[f]), P[f].everyone]) {
        expect(typeof s.one).toBe('string');
        expect(typeof s.many).toBe('string');
        expect(s.label).toBe(labelFor(s, s.count));
      }
    }
    const vc = P['vc-investor-linkedin.csv'];
    const eng = offered(vc).find((s) => s.id === 'role:engineers');
    expect(labelFor(eng, 1)).toBe('1 engineer');
    expect(labelFor(eng, 2)).toBe('2 engineers');
    expect(labelFor(offered(vc).find((s) => s.id === 'role:founders'), 1)).toBe('1 founder or CEO');
    expect(labelFor(offered(vc).find((s) => s.id === 'senior'), 1)).toBe('1 senior leader');
    expect(labelFor(offered(vc).find((s) => s.id === 'company:stripe'), 1)).toBe('1 at Stripe');
  });

  test('the five-person file no longer offers "1 senior leaders" or "2 in Big Tech" (value-1, value-11)', () => {
    const p = profileNetwork(FIVE, { today: TODAY });
    for (const s of offered(p)) expect(s.count).toBeGreaterThanOrEqual(3);
    expect(offered(p).map((s) => s.label).join(' | ')).not.toMatch(/\b1 senior leaders\b|\bin Big Tech\b/);
  });

  test('narrowings never offer zero or the whole list, give exact counts, and stop at three parts', () => {
    for (const f of FILES) {
      const p = P[f];
      for (const s of offered(p)) {
        const list = combine(p, [s.id]).keys;
        const rows = narrowings(p, [s.id]);
        expect(rows.length).toBeLessThanOrEqual(6);
        for (const r of rows) {
          expect(r.count).toBeGreaterThanOrEqual(1);
          expect(r.count).toBeLessThan(list.size);
          expect(combine(p, [s.id, r.id]).keys.size).toBe(r.count);
          expect(countIfAdded(p, [s.id], r.id)).toBe(r.count);
          const other = offered(p).find((x) => x.id === r.id);
          expect(r.label).toBe(labelFor(other, r.count));
          expect(r.label).not.toMatch(/^1 (engineers|investors|senior leaders|founders)/);
        }
        expect(rows.map((r) => r.count)).toEqual([...rows.map((r) => r.count)].sort((a, b) => b - a));
      }
    }
    const p = P['sales-crm.csv'];
    const three = p.shortcuts.slice(0, 3).map((s) => s.id);
    expect(narrowings(p, three)).toEqual([]);
    expect(narrowings(p, [])).toEqual([]);
  });

  test('a narrowing of one person reads "1 engineer"', () => {
    const list = [
      ...Array.from({ length: 6 }, (_, i) => c(`I${i}`, 'Partner', 'Cobalt Capital')),
      c('E0', 'Software Engineer', 'Cobalt Capital'),
      ...Array.from({ length: 5 }, (_, i) => c(`E${i + 1}`, 'Software Engineer', `Startup ${i}`)),
      ...Array.from({ length: 8 }, (_, i) => c(`S${i}`, 'Account Executive', `Shop ${i % 2}`)),
    ];
    const p = profileNetwork(list, { today: TODAY });
    const cobalt = offered(p).find((s) => s.id === 'company:cobalt capital');
    const rows = narrowings(p, [cobalt.id]);
    expect(rows).toContainEqual({ id: 'role:engineers', label: '1 engineer', count: 1 });
  });

  test('shortcutFor finds the shortcut holding exactly a selection (B13)', () => {
    const p = P['lp-fundraising-list.csv'];
    const cold = offered(p).find((s) => s.id === 'tag:cold');
    expect(shortcutFor(p, new Set(cold.keys))).toBe('tag:cold');
    expect(shortcutFor(p, new Set(cold.keys.slice(1)))).toBe(null);
  });

  test('combine reads a repeated id once (data-15)', () => {
    const p = P['vc-investor-linkedin.csv'];
    expect(combine(p, ['role:investors', 'role:investors']).label).toBe('investors');
    expect(countIfAdded(p, ['role:investors', 'role:investors'], 'company:stripe')).toBe(combine(p, ['role:investors', 'company:stripe']).keys.size);
  });
});

// ------------------------------------------------------------ choosing shortcuts (decision 8)

describe('decision 8: shortcuts never repeat each other, More mixes kinds', () => {
  test('no two offered shortcuts share 80% of the larger one\'s people (value-4)', () => {
    const files = [...FILES.map((f) => S[f]), FIVE, NO_COMPANY, CONFERENCE, ENGINEERS.slice(0, 600)];
    for (const list of files) {
      const p = profileNetwork(list, { today: TODAY });
      const all = offered(p);
      for (let i = 0; i < all.length; i += 1) {
        for (let j = i + 1; j < all.length; j += 1) {
          const b = new Set(all[j].keys);
          const both = all[i].keys.filter((k) => b.has(k)).length;
          expect(both).toBeLessThan(Math.max(all[i].count, all[j].count) * 0.8);
        }
      }
    }
    // The small file's "7 in Software" was Bluebird Labs plus one person.
    expect(offered(P['small-network-linkedin.csv']).map((s) => s.label)).not.toContain('7 in Software');
  });

  test('tag-led files offer a role and an industry under More (value-3, data-10)', () => {
    const crm = P['sales-crm.csv'];
    expect(crm.more.map((s) => s.label)).toEqual(expect.arrayContaining(['102 sales and marketing people', '70 in Healthcare']));
    expect(P['lp-fundraising-list.csv'].more.map((s) => s.label)).toContain('25 in Venture capital');
    // "More" holds one of each remaining kind before a second of any kind.
    for (const f of FILES) {
      const kinds = P[f].more.map((s) => s.type);
      const firstRepeat = kinds.findIndex((k, i) => kinds.indexOf(k) !== i);
      if (firstRepeat >= 0) expect(new Set(kinds.slice(0, firstRepeat)).size).toBe(firstRepeat);
    }
  });

  test('a role question is built only from a role shortcut the user can see (data-10)', () => {
    for (const f of FILES) {
      const roles = new Set(offered(P[f]).filter((s) => s.type === 'role').map((s) => s.count));
      for (const q of P[f].questions.filter((x) => /^Which /.test(x.text))) expect(roles.has(q.count)).toBe(true);
    }
  });

  test('equal firms are all offered, not cut to four (value-14)', () => {
    const p = profileNetwork(INVESTORS, { today: TODAY });
    expect(offered(p).filter((s) => s.type === 'company').map((s) => s.label).sort()).toEqual(FIRMS.map((f) => `18 at ${f}`).sort());
  });
});

// ------------------------------------------------------------ the read-out (decision 7)

describe('decision 7: the read-out says ties as ties and never states the obvious', () => {
  test('ties are said as ties (value-2)', () => {
    const conf = profileNetwork(CONFERENCE, { today: TODAY });
    expect(text(conf)).toContain('The most are in Berlin, London, Mumbai and 2 more places (80 each).');
    const inv = profileNetwork(INVESTORS, { today: TODAY });
    expect(text(inv)).toContain('The most at Accel, Benchmark, Greylock Partners and 2 others (18 each).');
    // A tie for second place names only the leader.
    expect(text(P['lp-fundraising-list.csv'])).toContain('The most at CalPERS (5).');
  });

  test('a two-person company never leads, and a one-company file says so once (value-13)', () => {
    expect(text(profileNetwork(CONFERENCE, { today: TODAY }))).not.toMatch(/The most at/);
    const one = profileNetwork(ONE_COMPANY, { today: TODAY });
    expect(one.sentences[0]).toMatch(/^You know 200 people, all at Acme Corp: /);
    expect(text(one)).not.toMatch(/The most at/);
  });

  test('a family, sector, place or date that holds everyone is said as "all" or not at all (value-m1, value-m2, value-m3, value-12)', () => {
    const eng = profileNetwork(ENGINEERS, { today: TODAY });
    expect(eng.sentences[0]).toBe('You know 3,000 people at 11 companies, all of them engineers.');
    expect(text(eng)).not.toMatch(/Strongest in/);
    const inv = profileNetwork(INVESTORS, { today: TODAY });
    expect(text(inv)).toContain('All are in San Francisco.');
    expect(text(inv)).not.toMatch(/connected/);
  });

  test('tied families are not picked by the alphabet (value-16)', () => {
    // 24 each in five families, nothing else.
    expect(profileNetwork(NO_COMPANY, { today: TODAY }).sentences[1]).toBe('By title: 24 each of clinicians, data and analytics people, engineers and 2 other roles.');
    const list = [
      ...Array.from({ length: 20 }, (_, i) => c(`P${i}`, 'Product Manager', `Co ${i}`)),
      ...Array.from({ length: 10 }, (_, i) => c(`E${i}`, 'Software Engineer', `Co ${i}`)),
      ...Array.from({ length: 10 }, (_, i) => c(`S${i}`, 'Account Executive', `Co ${i}`)),
    ];
    // Close-out: exactly two tied runners-up are both named; "several" is for three or more.
    expect(profileNetwork(list, { today: TODAY }).sentences[0]).toBe('You know 40 people at 20 companies: 20 product and design people, 10 engineers and 10 sales and marketing people.');
  });

  test('"None" when a column is empty, "Most" when it is thin (value-15)', () => {
    expect(profileNetwork(NO_COMPANY, { today: TODAY }).sentences[0]).toBe('120 people. None of them has a company in this file, so they cannot be grouped by employer.');
    const thin = NO_COMPANY.map((p, i) => (i < 20 ? { ...p, company: `Co ${i % 3}` } : p));
    // Close-out: the few companies the file names have shortcuts, so the
    // read-out no longer says they cannot be grouped by employer.
    expect(profileNetwork(thin, { today: TODAY }).sentences[0]).toBe('120 people. Most have no company in this file.');
  });

  test('an address book is grouped by work email domain (value-9)', () => {
    const p = profileNetwork(ADDRESS_BOOK, { today: TODAY });
    expect(p.companyFrom).toBe('email');
    expect(p.sentences).toEqual([
      // Close-out: the email shortcuts do group them by employer.
      '250 people. None of them has a company or title in this file, so they cannot be grouped by role.',
      'From email addresses: the most at stripe.com (60) and acme.com (40).',
    ]);
    expect(p.shortcuts.map((s) => s.label)).toEqual(['60 at stripe.com', '40 at acme.com']);
    // Webmail is never a company.
    expect(offered(p).some((s) => /gmail|outlook/.test(s.label))).toBe(false);
  });

  test('placeholder employers are not companies anywhere (data-2)', () => {
    const list = [
      ...Array.from({ length: 12 }, (_, i) => c(`Se ${i}`, 'Consultant', 'Self-employed')),
      ...Array.from({ length: 8 }, (_, i) => c(`St ${i}`, 'Founder', i % 2 ? 'Stealth Startup' : 'Stealth Mode')),
      ...Array.from({ length: 6 }, (_, i) => c(`Mc ${i}`, 'Engagement Manager', 'McKinsey & Company')),
      ...Array.from({ length: 4 }, (_, i) => c(`Mk ${i}`, 'Associate', 'McKinsey')),
      ...Array.from({ length: 4 }, (_, i) => c(`Re ${i}`, 'Advisor', 'Retired')),
      ...Array.from({ length: 66 }, (_, i) => c(`U ${i}`, 'Software Engineer', `Unique ${i}`)),
    ];
    const p = profileNetwork(list, { today: TODAY });
    const words = [...p.sentences, ...offered(p).map((s) => s.label), ...p.questions.map((q) => q.text)].join(' | ');
    expect(words).not.toMatch(/self-employed|stealth|retired/i);
    expect(words).toContain('10 at McKinsey & Company');
    const atlas = buildAtlas(list, { groupBy: 'company' });
    expect(atlas.root.children.find((n) => n.key === NO_COMPANY_KEY)).toMatchObject({ label: 'No company listed', count: 24, last: true });
  });

  test('tag names are quoted and never bold; only counts are bold (R7, B10)', () => {
    const p = P['lp-fundraising-list.csv'];
    const tagLine = p.parts[p.sentences.findIndex((s) => s.startsWith('By tag:'))];
    expect(tagLine.filter((x) => x.bold).map((x) => x.text)).toEqual(['23', '23', '20']);
    expect(tagLine.map((x) => x.text).join('')).toBe('By tag: 23 “cold”, 23 “met 2026”, 20 “committed”.');
    for (const f of FILES) {
      expect(P[f].parts.map((pt) => pt.map((x) => x.text).join(''))).toEqual(P[f].sentences);
      for (const pt of P[f].parts) for (const x of pt.filter((y) => y.bold)) expect(x.text).toMatch(/^\d[\d,]*$/);
    }
  });

  test('read as the person who uploaded each sample, nothing is repeated or about everyone', () => {
    for (const f of FILES) {
      const p = P[f];
      expect(new Set(p.sentences).size).toBe(p.sentences.length);
      expect(text(p)).not.toMatch(/\(\d[\d,]*\) and [^.]*\(\1\)/);
      for (const s of offered(p)) expect(s.count).toBeLessThan(p.n);
    }
  });
});

// ------------------------------------------------------------ example questions (one number per thing)

describe('example questions answer exactly their count, by rules only', () => {
  const check = async (list) => {
    const p = profileNetwork(list, { today: TODAY });
    for (const q of p.questions) {
      const r = await answerQuestion(list, { question: q.text, fromPage: true, today: TODAY });
      expect([q.text, r.total]).toEqual([q.text, q.count]);
      expect(r.parsedBy).not.toBe('llm');
    }
    return p;
  };

  test('on the six samples', async () => {
    for (const f of FILES) await check(S[f]);
  });

  test('a city in another script and a long company name (value-8, ask-m1)', async () => {
    const locs = ['Москва, Россия', '東京, 日本', '서울, 대한민국'];
    const p = await check(Array.from({ length: 60 }, (_, i) => c(`P ${i}`, ['Software Engineer', 'Account Executive'][i % 2], ['Яндекс', 'Sony', 'Samsung'][i % 3], { location: locs[i % 3] })));
    expect(p.questions.map((q) => q.text)).toContain('Who do I know in Москва?');
    const long = await check([
      ...Array.from({ length: 10 }, (_, i) => c(`L${i}`, i % 2 ? 'Investment Officer' : 'Software Engineer', 'Ontario Teachers Pension Plan Board of Trustees Canada')),
      ...Array.from({ length: 20 }, (_, i) => c(`M${i}`, 'Software Engineer', `Co ${i % 7}`)),
    ]);
    expect(long.questions[0].text).toBe('Who do I know at Ontario Teachers Pension Plan Board of Trustees Canada?');
    expect(chatComplete).not.toHaveBeenCalled();
  });

  test('three examples whenever the file has three forms to offer (value-17)', async () => {
    expect((await check(CONFERENCE)).questions).toHaveLength(3);
    expect((await check(NO_COMPANY)).questions).toHaveLength(3);
    expect((await check(INVESTORS)).questions).toHaveLength(3);
  });
});

// ------------------------------------------------------------ the atlas (R2, R3, R4)

describe('atlas: families, tag counts, named companies first', () => {
  const OLD_NAMES = new Set([...ROLE_GROUPS.map((g) => g.label), 'Experts & advisors', 'Operators & talent', 'Founders & executives', 'Investors & LPs', 'Everyone else']);

  test('By role is the file\'s families, at most eight, then "Other roles" (R2, B1)', () => {
    const hc = buildAtlas(S['healthcare-academic.csv'], { groupBy: 'role' });
    expect(hc.root.children.map((n) => `${n.label} ${n.count}`)).toEqual(expect.arrayContaining(['Clinicians 100', 'Researchers & academics 64']));
    const vc = buildAtlas(S['vc-investor-linkedin.csv'], { groupBy: 'role' });
    const named = vc.root.children.filter((n) => !n.last);
    expect(named.length).toBeLessThanOrEqual(8);
    expect(vc.root.children[vc.root.children.length - 1]).toMatchObject({ key: 'other-roles', label: 'Other roles', last: true });
    // "Other roles" opens onto the families it holds.
    expect(vc.root.children.find((n) => n.key === 'other-roles').children.every((n) => n.type === 'group')).toBe(true);
    // The read-out, the chips and the globe count the same investors.
    expect(named[0]).toMatchObject({ label: 'Investors', count: offered(P['vc-investor-linkedin.csv']).find((s) => s.id === 'role:investors').count });
    for (const f of FILES) {
      for (const groupBy of ['role', 'industry', 'country', 'tag', 'company']) {
        for (const n of buildAtlas(S[f], { groupBy }).nodes) if (n.type === 'group') expect(OLD_NAMES.has(n.label)).toBe(false);
      }
    }
  });

  test('a family has one colour on every file and in every arrangement (R2)', () => {
    const seen = new Map();
    for (const f of FILES) {
      for (const groupBy of ['role', 'industry', 'country']) {
        for (const n of buildAtlas(S[f], { groupBy }).nodes.filter((x) => x.type === 'group' && x.family)) {
          expect(n.color).toBe(FAMILY_COLORS[n.family]);
          if (seen.has(n.family)) expect(seen.get(n.family)).toBe(n.color);
          seen.set(n.family, n.color);
        }
      }
    }
    const named = FAMILIES.filter((fam) => !fam.catchAll).map((fam) => FAMILY_COLORS[fam.key]);
    expect(new Set(named).size).toBe(named.length);
  });

  test('By industry and By place open onto families, not the four old groups (R2)', () => {
    const hc = buildAtlas(S['healthcare-academic.csv'], { groupBy: 'industry' });
    const healthcare = hc.root.children.find((n) => n.label === 'Healthcare');
    expect(healthcare.children.filter((n) => n.type === 'group').map((n) => n.label)).toContain('Clinicians');
    const place = buildAtlas(S['healthcare-academic.csv'], { groupBy: 'country' });
    expect(place.root.children[0].children.some((n) => n.dim === 'family')).toBe(true);
  });

  test('a tag group counts everyone with the tag, and selecting it lists them (R3, B5)', () => {
    const crm = buildAtlas(S['sales-crm.csv'], { groupBy: 'tag' });
    const prospect = crm.root.children.find((n) => n.key === 'prospect');
    const chip = offered(P['sales-crm.csv']).find((s) => s.id === 'tag:prospect');
    expect([prospect.count, prospect.placed]).toEqual([107, 89]);
    expect(prospect.count).toBe(chip.count);
    expect(new Set(crm.groupIndex.get(prospect.id))).toEqual(new Set(chip.keys));
    expect(prospect.hint).toContain('18 of them sit under another tag on the map');
    expect(crm.tagIndex.get('prospect')).toHaveLength(107);
    // Every group node has its people in groupIndex.
    for (const n of crm.nodes.filter((x) => x.type === 'group')) expect(crm.groupIndex.get(n.id).length).toBe(n.count);
    const vc = buildAtlas(S['vc-investor-linkedin.csv'], { groupBy: 'role' });
    for (const n of vc.nodes.filter((x) => x.type === 'group')) expect(vc.groupIndex.get(n.id).length).toBe(n.placed);
  });

  test('By company: the largest named company first, "Other companies" then "No company listed" last (R4, B6, data-13)', () => {
    for (const f of FILES) {
      const atlas = buildAtlas(S[f], { groupBy: 'company' });
      const kids = atlas.root.children;
      const named = kids.filter((n) => !n.last);
      expect(kids.slice(0, named.length)).toEqual(named);
      expect(named.every((n, i) => i === 0 || n.count <= named[i - 1].count)).toBe(true);
      expect(named.length).toBeLessThanOrEqual(MAX_COMPANY_HUBS);
      for (const n of kids.filter((x) => x.last)) expect([OTHER_COMPANIES_KEY, NO_COMPANY_KEY]).toContain(n.key);
    }
    const vc = buildAtlas(S['vc-investor-linkedin.csv'], { groupBy: 'company' }).root.children;
    expect(vc.slice(-2).map((n) => [n.label, n.last])).toEqual([['Other companies', true], ['No company listed', true]]);
    expect(vc.slice(0, 3).map((n) => n.label)).toEqual(['Stripe', 'Google', 'Goldman Sachs']);
  });

  test('inside a family, eight companies, then "Other companies" (R2)', () => {
    const vc = buildAtlas(S['vc-investor-linkedin.csv'], { groupBy: 'role' });
    for (const g of vc.root.children) {
      const companies = g.children.filter((n) => n.type === 'company' && n.key !== NO_COMPANY_KEY);
      expect(companies.length).toBeLessThanOrEqual(8);
    }
    // A company folded into "Other companies" is still in the company index.
    expect(vc.companyIndex.get('stripe').reduce((sum, id) => sum + vc.byId.get(id).count, 0)).toBe(22);
  });

  test('every node carries the shared fields (contract)', () => {
    const atlas = buildAtlas(S['sales-crm.csv'], { groupBy: 'tag' });
    for (const n of atlas.nodes) {
      for (const k of ['id', 'type', 'label', 'count', 'placed', 'last']) expect(n).toHaveProperty(k);
      if (n.type === 'group') expect(typeof n.hint).toBe('string');
    }
    // A file that splits on nothing is shown by company.
    expect(buildAtlas(S['small-network-linkedin.csv'], { groupBy: null }).root.children.every((n) => n.type === 'company')).toBe(true);
  });
});

// ------------------------------------------------------------ seniority and caches (data-4, data-17)

describe('seniority', () => {
  test('a spelled-out Vice President and the like are not top leaders (data-4)', () => {
    const rank = (position) => seniority({ position });
    for (const t of ['Vice President, M&A', 'Senior Vice President', 'Executive Vice President', 'Vice-President of Sales', 'Principal Engineer', 'Principal Product Manager', 'Principal Scientist', 'Partner Manager', 'Chief of Staff', 'Product Owner', 'Associate Partner']) {
      expect([t, rank(t)]).not.toEqual([t, 0]);
    }
    for (const t of ['Founder & CEO', 'Co-founder', 'President', 'Chief Technology Officer', 'Managing Director', 'General Partner', 'Partner', 'Principal', 'Owner', 'Chairman']) {
      expect([t, rank(t)]).toEqual([t, 0]);
    }
    expect(rank('Vice President, M&A')).toBe(1);
    expect(rank('Software Engineer')).toBe(2);
  });

  test('caches follow an edit to the fields they read (data-17)', () => {
    const p = { name: 'Ana', position: 'Software Engineer', company: 'Acme' };
    expect(seniority(p)).toBe(2);
    const id = personNodeId(p);
    p.position = 'Founder';
    p.email = 'ana@acme.com';
    expect(seniority(p)).toBe(0);
    expect(personNodeId(p)).not.toBe(id);
    expect(personNodeId(p)).toBe('p:e:ana@acme.com');
  });
});

// ------------------------------------------------------------ copy and download (data-16, data-m1)

describe('listText and listCsv', () => {
  test('a line break inside a field keeps one person on one line (data-16)', () => {
    expect(listText([{ name: 'x', company: 'Line\nbreak' }])).toBe('x, Line break');
  });

  test('a tag holding ";" reads as one tag (data-16)', () => {
    expect(listCsv([{ name: 'x', tags: ['a;b', 'c'] }])).toBe('Name,Tags\nx,"""a;b""; c"\n');
  });

  test('the formula guard sees past leading spaces and leaves plain numbers alone (data-m1)', () => {
    expect(listCsv([{ name: '=HYPERLINK("x")', company: ' =1+1', position: '-2' }]))
      .toBe('Name,Company,Title\n"\'=HYPERLINK(""x"")",\' =1+1,-2\n');
  });
});

// ------------------------------------------------------------ speed (decision 13, data-11)

describe('speed in the page\'s own order', () => {
  test('30,000 fresh contacts: profile then the first map under 600 ms; a selection change under 50 ms', () => {
    const titles = ['Software Engineer', 'Partner', 'Founder & CEO', 'Registered Nurse', 'Account Executive', 'Product Manager', 'Professor', 'VP Sales'];
    // Fresh objects with company names never seen before, so no cache helps:
    // the page meets every reload or re-import like this.
    const make = (run) => Array.from({ length: 30000 }, (_, i) => ({
      name: `Person ${i}`, position: titles[i % titles.length], company: `Company ${i % 4000} ${run}`, location: ['Austin, TX', 'London, United Kingdom', 'Paris, France'][i % 3],
      tags: [['lead', 'customer', 'churned'][i % 3]], connectedOn: `20${10 + (i % 17)}-0${1 + (i % 9)}-15`, profileUrl: `https://www.linkedin.com/in/p-${run}-${i}`,
    }));
    profileNetwork(make('warm').slice(0, 500), { today: TODAY }); // compile the code once
    // The time this process spends working, not the clock on the wall: with
    // the whole suite running, other test files share the machine and the
    // wall clock counts their work too (the run here alone takes about 350 ms).
    const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
    // The budgets are for a machine where this fixed piece of work takes about 45 ms. When the machine
    // is busy with the rest of the suite the same work takes longer, and the budgets stretch by the same
    // factor, so the test fails for slow code and not for a slow moment. They never shrink.
    const reference = () => {
      const t = cpuMs();
      const m = new Map();
      for (let i = 0; i < 400000; i += 1) { const k = `k${i % 5000} ${i & 7}`.toLowerCase(); m.set(k, (m.get(k) || 0) + 1); /k1\d+ 3/.test(k); }
      return cpuMs() - t;
    };
    reference();
    const before = Math.min(reference(), reference());
    const runs = ['a', 'b', 'c'].map((run) => {
      const big = make(run);
      let t = cpuMs();
      const p = profileNetwork(big, { today: TODAY });
      buildAtlas(big, { groupBy: p.defaultGrouping || 'role' });
      const first = cpuMs() - t;
      t = cpuMs();
      const ids = [p.shortcuts[0].id, p.shortcuts[1].id];
      const sel = combine(p, ids);
      narrowings(p, ids);
      shortcutFor(p, sel.keys);
      return { first, select: cpuMs() - t, n: p.n };
    });
    expect(runs.every((r) => r.n === 30000)).toBe(true);
    const slow = Math.max(1, Math.max(before, Math.min(reference(), reference())) / 45);
    // Best of three fresh files.
    expect(Math.min(...runs.map((r) => r.first))).toBeLessThan(600 * slow);
    expect(Math.min(...runs.map((r) => r.select))).toBeLessThan(50 * slow);
  });
});

// The tag a person is filed under and the tags they carry stay as the file says.
test('tagsOf is unchanged by the atlas', () => {
  const p = { name: 'T', tags: ['Prospect', 'Champion'] };
  buildAtlas([p], { groupBy: 'tag' });
  expect(tagsOf(p)).toEqual(['prospect', 'champion']);
  expect(familyOf(p).key).toBe('unknown');
});

test('"Other tags" counts everyone with one of its tags, and its line says the same number (R3)', () => {
  const tags = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r'];
  const list = Array.from({ length: 360 }, (_, i) => c(`T${i}`, 'Engineer', `Co ${i % 40}`, { tags: [tags[i % 18], tags[(i + 17) % 18]] }));
  const atlas = buildAtlas(list, { groupBy: 'tag' });
  const other = atlas.root.children.find((n) => n.label === 'Other tags');
  expect(other.count).toBe(atlas.groupIndex.get(other.id).length);
  expect(other.hint.startsWith(`${other.count} people`)).toBe(true);
});
