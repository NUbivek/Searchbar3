/**
 * Network Map, round 2 (spec eval/network/design-2026-11-21/SPEC.md, sections
 * 3, 4, 7, 8, 9): the classifier fixes, families, the arrangements that fit a
 * file, the atlas changes, and the read-out and shortcuts built from the file.
 * All people are invented (tests/fixtures/network).
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(), queryOne: jest.fn(), persistenceMode: jest.fn(() => 'pglite'), PersistenceUnavailableError: class extends Error {},
}));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null) }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { parseLinkedInConnectionsCsv, parseGenericCsv, normalizeCompanyKey } = require('../../../src/utils/network/parseContacts');
const { classifyContact, familyOf, FAMILIES } = require('../../../src/utils/network/roles');
const {
  industryOf, tagsOf, cityOf, isSector, usefulGroupings, defaultGrouping, bucketsFor, GROUPINGS,
} = require('../../../src/utils/network/grouping');
const { buildAtlas, personNodeId, OTHER_COMPANIES_KEY, MAX_COMPANY_HUBS } = require('../../../src/utils/network/atlas');
const { profileNetwork, combine, countIfAdded, listText, listCsv } = require('../../../src/utils/network/insights');
const { parseQuestionRules, scoreContacts } = require('../../../src/server/network/query');

const DIR = path.resolve(__dirname, '../../fixtures/network');
const load = (file) => {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const r = file.includes('linkedin') ? parseLinkedInConnectionsCsv(text) : parseGenericCsv(text);
  return r.contacts || r;
};
const FILES = ['vc-investor-linkedin.csv', 'founder-operator-linkedin.csv', 'sales-crm.csv', 'healthcare-academic.csv', 'lp-fundraising-list.csv', 'small-network-linkedin.csv'];
const SAMPLES = Object.fromEntries(FILES.map((f) => [f, load(f)]));
const TODAY = '2026-11-21';
const PROFILES = Object.fromEntries(FILES.map((f) => [f, profileNetwork(SAMPLES[f], { today: TODAY })]));
const c = (name, position, company, extra = {}) => ({ name, position, company, ...extra });

// ------------------------------------------------------------ classifier fixes (section 7)

describe('classifier fixes', () => {
  test('tags are never read as job titles', () => {
    // A CRM tag "partner" made retail buyers and nurses "investors".
    expect(classifyContact(c('A', 'Buyer', 'Marlowe Department Stores', { tags: ['partner'] })).family).not.toBe('investors');
    expect(classifyContact(c('B', 'Registered Nurse', 'Bayview Health System', { tags: ['partner', 'decision maker'] })).family).toBe('clinicians');
    const crm = SAMPLES['sales-crm.csv'];
    expect(crm.filter((p) => familyOf(p).key === 'investors')).toHaveLength(0);
  });

  test('a role given by the employer\'s name alone yields to a title that says otherwise', () => {
    expect(classifyContact(c('A', 'Software Engineer', 'Cobalt Capital')).family).toBe('engineers');
    expect(classifyContact(c('B', 'Chief Technology Officer', 'Ember Ventures')).family).toBe('engineers');
    expect(classifyContact(c('C', 'Account Executive', 'Granite Partners')).family).toBe('sales');
    expect(classifyContact(c('D', 'Product Manager', 'Bayview Health System')).family).toBe('product');
    expect(classifyContact(c('E', 'Hospital Administrator', 'Massachusetts General Hospital')).family).toBe('operations');
    expect(classifyContact(c('F', 'Buyer', 'Lakeside Medical Group')).family).not.toBe('clinicians');
    // A title that says nothing more keeps the employer's role.
    expect(classifyContact(c('G', 'Partner', 'Sequoia Capital')).family).toBe('investors');
    expect(classifyContact(c('H', 'Associate', 'Acme Ventures')).family).toBe('investors');
    expect(classifyContact(c('I', 'Managing Director', 'Goldman Sachs')).family).toBe('bankers');
    expect(classifyContact(c('J', 'Engagement Manager', 'McKinsey & Company')).family).toBe('consultants');
    expect(classifyContact(c('K', 'Partner', 'Kirkland & Ellis')).family).toBe('lawyers');
    // The founder file's 73 false "investors" were engineers and sales people at "* Capital" firms.
    expect(SAMPLES['founder-operator-linkedin.csv'].filter((p) => familyOf(p).key === 'investors').length).toBeLessThanOrEqual(5);
  });

  test('pension, endowment and family-office staff are allocators, not investors', () => {
    expect(classifyContact(c('A', 'Director of Private Equity', 'CalPERS')).role).toBe('lp');
    expect(classifyContact(c('B', 'Investment Officer', 'Yale Investments Office')).role).toBe('lp');
    expect(classifyContact(c('C', 'Head of Venture Investments', 'Ontario Teachers Pension Plan')).role).toBe('lp');
    expect(classifyContact(c('D', 'Investment Director', 'Hawthorne Family Office')).role).toBe('lp');
    // Changed 2026-11-21 (ROUND2 R2): a family also carries its globe title and row tag.
    expect(familyOf(c('E', 'Investment Director', 'Kestrel Family Office'))).toEqual({ key: 'investors', one: 'investor', many: 'investors', title: 'Investors', tag: 'Investor', catchAll: false });
  });

  test('the wrong labels in the audit', () => {
    expect(classifyContact(c('A', 'Cardiologist', 'Massachusetts General Hospital')).family).toBe('clinicians');
    expect(classifyContact(c('A2', 'Neurologist', 'Acme')).family).toBe('clinicians');
    expect(classifyContact(c('A3', 'Chief of Surgery', 'Mayo Clinic')).family).toBe('clinicians');
    expect(classifyContact(c('B', 'Program Manager', 'National Institutes of Health')).role).not.toBe('accelerator');
    expect(classifyContact(c('B2', 'Platform Engineer', 'Acme')).family).toBe('engineers');
    expect(classifyContact(c('C', 'Program Director', 'Y Combinator')).role).toBe('accelerator');
    expect(classifyContact(c('D', 'Policy Advisor', 'Department of Health')).role).toBe('public');
    expect(industryOf(c('E', 'Investment Director', 'Driftwood Wealth Management'))).toBe('Asset management');
    expect(industryOf(c('E2', 'Chief Investment Officer', 'Granite Pension Fund'))).toBe('Asset management');
    expect(industryOf(c('F', 'Managing Director, Private Markets', 'Acme Group'))).not.toBe('Sales & marketing');
    for (const co of ['Marlowe Department Stores', 'Greenfield Grocers', 'Juniper Markets', 'Summit Outfitters', 'Northgate Pharmacy Group']) {
      expect(industryOf(c('G', 'Buyer', co))).toBe('Commerce');
    }
  });

  test('classifyContact keeps its shape and adds the family', () => {
    const k = classifyContact(c('A', 'General Partner', 'Accel'));
    expect(Object.keys(k).sort()).toEqual(['family', 'group', 'label', 'lenses', 'reason', 'role']);
    expect(k).toMatchObject({ role: 'investor', group: 'investors', family: 'investors' });
    expect(classifyContact(c('B', '', '')).family).toBe('unknown');
    // Every family the classifier gives is listed.
    const keys = new Set(FAMILIES.map((f) => f.key));
    for (const f of FILES) for (const p of SAMPLES[f]) expect(keys.has(classifyContact(p).family)).toBe(true);
  });
});

// ------------------------------------------------------------ grouping helpers (section 7, 8)

describe('tags, places, sectors and arrangements', () => {
  test('tagsOf normalises and leaves X handles out; cityOf reads the first part', () => {
    expect(tagsOf({ tags: [' Prospect ', 'prospect', 'Decision  Maker', '@someone'] })).toEqual(['prospect', 'decision maker']);
    expect(tagsOf({})).toEqual([]);
    expect(cityOf({ location: 'New York, NY' })).toBe('New York');
    expect(cityOf({ location: 'Greater Boston Area' })).toBe('Boston');
    expect(cityOf({ location: 'San Francisco Bay Area' })).toBe('San Francisco');
    expect(cityOf({ location: 'Greater Seattle Area, WA' })).toBe('Seattle');
    expect(cityOf({ location: '' })).toBe('');
  });

  test('isSector: sectors yes, job-function fallbacks and Other no', () => {
    for (const s of ['Healthcare', 'Big Tech', 'Software', 'Commerce', 'Venture capital', 'Asset management', 'Fintech']) expect(isSector(s)).toBe(true);
    for (const s of ['Other', 'Investing', 'Finance & operations', 'Sales & marketing', 'Founders & CEOs', 'Engineering & data']) expect(isSector(s)).toBe(false);
  });

  test('GROUPINGS: a tag arrangement, and country reads "By place"', () => {
    expect(GROUPINGS).toEqual([
      { key: 'role', label: 'By role' }, { key: 'company', label: 'By company' }, { key: 'industry', label: 'By industry' },
      { key: 'country', label: 'By place' }, { key: 'tag', label: 'By tag' },
    ]);
  });

  test('only the arrangements that split the file are offered; the default follows the file', () => {
    const keys = (f) => usefulGroupings(SAMPLES[f]).map((g) => g.key);
    // LinkedIn exports have no location and no tags.
    expect(keys('vc-investor-linkedin.csv')).toEqual(['role', 'company', 'industry']);
    expect(keys('small-network-linkedin.csv')).toEqual(['role', 'company', 'industry']);
    // Everyone on the fundraising list is an investor: By role would be one bubble.
    expect(keys('lp-fundraising-list.csv')).toEqual(['company', 'industry', 'country', 'tag']);
    expect(keys('sales-crm.csv')).toEqual(['role', 'company', 'industry', 'country', 'tag']);
    expect(defaultGrouping(SAMPLES['vc-investor-linkedin.csv'])).toBe('role');
    expect(defaultGrouping(SAMPLES['lp-fundraising-list.csv'])).toBe('tag');
    expect(defaultGrouping(SAMPLES['sales-crm.csv'])).toBe('tag');
    expect(defaultGrouping(SAMPLES['healthcare-academic.csv'])).toBe('role');
    // People carrying several tags each: By tag is offered but is not the default.
    const multi = Array.from({ length: 40 }, (_, i) => c(`P${i}`, 'Engineer', `Co ${i % 4}`, { tags: [['a', 'b'][i % 2], ['c', 'd'][i % 2], 'x'] }));
    expect(usefulGroupings(multi).map((g) => g.key)).toContain('tag');
    expect(defaultGrouping(multi)).not.toBe('tag');
  });

  test('tag buckets use the first tag and the commonest spelling', () => {
    const list = [c('A', '', 'X', { tags: ['Warm', 'cold'] }), c('B', '', 'X', { tags: ['warm'] }), c('C', '', 'X', { tags: ['Warm'] }), c('D', '', 'X')];
    expect(bucketsFor(list, 'tag').map((b) => [b.key, b.label, b.contacts.length])).toEqual([['warm', 'Warm', 3], ['No tag', 'No tag', 1]]);
  });
});

// ------------------------------------------------------------ atlas (section 7, 8)

describe('atlas', () => {
  test('a one-bucket first layer is skipped: the fundraising list is not one bubble', () => {
    const atlas = buildAtlas(SAMPLES['lp-fundraising-list.csv'], { groupBy: 'role' });
    expect(atlas.root.children.length).toBeGreaterThan(1);
    expect(atlas.root.children.every((n) => n.dim !== 'role')).toBe(true);
    expect(atlas.compass).toBe(false);
  });

  // Changed 2026-11-21 (ROUND2 R3, browser B5): a tag group counts everyone
  // who carries the tag, and its line says how many of them sit under another
  // tag; the "By first tag" prefix is gone.
  test('By tag: one bubble per first tag, counted as everyone with the tag', () => {
    const lp = buildAtlas(SAMPLES['lp-fundraising-list.csv'], { groupBy: 'tag' });
    expect(lp.root.children.map((n) => [n.label, n.count])).toEqual([['cold', 23], ['met 2026', 23], ['committed', 20], ['passed', 18], ['follow up', 15], ['warm', 15]]);
    expect(lp.root.children[0].hint).toMatch(/^23 people( · most at .+ \(\d+\))?$/);
    const crm = buildAtlas(SAMPLES['sales-crm.csv'], { groupBy: 'tag' });
    expect(crm.root.children.map((n) => [n.label, n.count, n.placed])).toEqual([
      ['prospect', 107, 89], ['customer', 73, 53], ['partner', 69, 53], ['decision maker', 62, 51], ['champion', 57, 48], ['churned', 45, 34],
    ]);
    expect(crm.root.children[0].hint).toBe('107 people · 18 of them sit under another tag on the map');
    expect(crm.groupIndex.get(crm.root.children[0].id)).toHaveLength(107);
  });

  test('every group node has a generated hint; the fund-manager sentences are gone', () => {
    for (const groupBy of ['role', 'industry', 'country', 'tag', 'company']) {
      for (const f of FILES) {
        const atlas = buildAtlas(SAMPLES[f], { groupBy });
        for (const node of atlas.nodes.filter((n) => n.type === 'group')) {
          expect(typeof node.hint).toBe('string');
          expect(node.hint).not.toMatch(/fund you|sees deals|vouch|co-invest/i);
        }
      }
    }
    const vc = buildAtlas(SAMPLES['vc-investor-linkedin.csv'], { groupBy: 'role' });
    const investors = vc.root.children.find((n) => n.key === 'investors');
    expect(investors.hint).toMatch(/^\d+ people · most at .+ \(\d+\)$/);
  });

  test('By company caps the first layer and is ready in well under a second', () => {
    const t = Date.now();
    const atlas = buildAtlas(SAMPLES['vc-investor-linkedin.csv'], { groupBy: 'company' });
    expect(Date.now() - t).toBeLessThan(1000);
    // Changed 2026-11-21 (review data-13): the 14 people with no company are
    // their own last group, after "Other companies", and take no company's place.
    expect(atlas.root.children).toHaveLength(MAX_COMPANY_HUBS + 2);
    expect(atlas.root.children[MAX_COMPANY_HUBS + 1]).toMatchObject({ label: 'No company listed', count: 14, last: true });
    const other = atlas.root.children[MAX_COMPANY_HUBS];
    expect(other).toMatchObject({ type: 'group', key: OTHER_COMPANIES_KEY, label: 'Other companies' });
    expect(other.hint).toMatch(/^\d+ people at \d+ smaller companies$/);
    expect(atlas.root.children[0]).toMatchObject({ type: 'company', label: 'Stripe', count: 22 });
    expect(atlas.nodes.filter((n) => n.type === 'person')).toHaveLength(544);
    // A small file keeps one bubble per company.
    expect(buildAtlas(SAMPLES['small-network-linkedin.csv'], { groupBy: 'company' }).root.children.every((n) => n.type === 'company')).toBe(true);
  });

  test('any arrangement of 5,000 contacts is built in under a second', () => {
    const big = Array.from({ length: 5000 }, (_, i) => c(`Person ${i}`, ['Software Engineer', 'Partner', 'Founder', 'Nurse', 'Account Executive'][i % 5], `Company ${i % 700}`, { location: ['Austin, TX', 'London, United Kingdom', 'Paris, France', 'Berlin, Germany'][i % 4], tags: [['lead', 'customer', 'churned'][i % 3]] }));
    for (const groupBy of ['role', 'company', 'industry', 'country', 'tag']) {
      const t = Date.now();
      const atlas = buildAtlas(big, { groupBy });
      expect(Date.now() - t).toBeLessThan(1000);
      expect(atlas.root.children.length).toBeLessThanOrEqual(MAX_COMPANY_HUBS + 2);
    }
  });

  test('companyIndex maps a company to every node it sits in', () => {
    const atlas = buildAtlas(SAMPLES['vc-investor-linkedin.csv'], { groupBy: 'role' });
    const ids = atlas.companyIndex.get('stripe');
    expect(ids.length).toBeGreaterThan(1); // Stripe is split across role groups
    expect(ids.reduce((sum, id) => sum + atlas.byId.get(id).count, 0)).toBe(22);
  });
});

// ------------------------------------------------------------ the read-out and shortcuts (sections 3, 4, 9)

describe('profileNetwork on the six sample files', () => {
  // Numbers differ from design_insights.json "examples" where the classifier
  // fixes change them: data scientists are their own family (so the VC file
  // has 97 engineers, not 108), physicians at biotech firms count as
  // clinicians (healthcare 100, not 79), the whole LP list is investors or
  // allocators (114, not 87), Healthcare (69%) is over the 60% ceiling for
  // an industry chip, and the small file's newest date is over 60 days old,
  // so its recent chip reads "before this export".
  // Changed 2026-11-21 (ROUND2 R8.1, review value-5 / data-1 / data-6 /
  // data-7): industry is read from the employer only. VC file: Software
  // engineers at Stripe or Ramp no longer count "in Software", so Fintech
  // (60) leads; founder file: the "X Partners" / "X Capital" employers are
  // Venture capital for everyone there (73); healthcare file: University
  // Hospitals are Healthcare (Education 58 -> 29, only universities) and drug
  // makers ("Therapeutics", "Bio", Moderna, Genentech) are Biotech (63).
  // Changed 2026-11-21 (round 3, review value-1 to value-17, data-4, data-10,
  // ROUND2 R7 and decisions 7 and 8): "More" holds one of each remaining kind
  // before a second of any kind, so the sales CRM now offers its 102 sales
  // and marketing people and its 70 in Healthcare; a shortcut that lights
  // nearly the same people as one already offered gives way ("7 in Software"
  // on the small file is Bluebird Labs plus one); Vice Presidents, Chiefs of
  // Staff and "Principal Scientists" are no longer senior leaders (VC 201 ->
  // 180, founder 74 -> 72); tag names are quoted in the read-out; a tie for
  // second place is not broken by the alphabet (the LP list's 4 at Ontario
  // Teachers and 4 at Yale), so the sentence names CalPERS only.
  const EXPECTED = {
    'vc-investor-linkedin.csv': {
      sentences: 'You know 544 people at 254 companies: 112 investors and 97 engineers. The most at Stripe (22) and Google (19). Strongest in Fintech (60). 79 connected in the last 12 months.',
      chips: ['112 investors', '97 engineers', '22 at Stripe', '19 at Google', '60 in Fintech', '79 connected in the last 12 months'],
      more: ['78 founders and CEOs', '12 at Goldman Sachs', '57 in Software', '180 senior leaders', '75 product and design people', '11 at Meta'],
      questions: ['Who do I know at Stripe? (22)', 'Which investors do I know? (112)', 'Who do I know at Google? (19)'],
    },
    'founder-operator-linkedin.csv': {
      sentences: 'You know 451 people at 213 companies: 201 engineers and 123 product and design people. The most at Google (41) and Meta (28). Strongest in Big Tech (124). 84 connected in the last 12 months.',
      chips: ['201 engineers', '123 product and design people', '41 at Google', '28 at Meta', '124 in Big Tech', '84 connected in the last 12 months'],
      more: ['50 sales and marketing people', '24 at Amazon', '73 in Venture capital', '72 senior leaders', '44 founders and CEOs', '19 at Microsoft'],
      questions: ['Who do I know at Google? (41)', 'Which engineers do I know? (201)', 'Who do I know at Meta? (28)'],
    },
    'sales-crm.csv': {
      sentences: '328 contacts at 147 companies. By tag: 107 “prospect”, 73 “customer”, 69 “partner”. The most at Marlowe Department Stores (18), then Bayview Health System (16). More are in New York (63) than anywhere else.',
      chips: ['107 tagged “prospect”', '73 tagged “customer”', '69 tagged “partner”', '18 at Marlowe Department Stores', '16 at Bayview Health System', '63 in New York'],
      more: ['62 tagged “decision maker”', '14 at Greenfield Grocers', '58 in Toronto', '102 sales and marketing people', '70 in Healthcare', '57 tagged “champion”'],
      questions: ['Who do I know at Marlowe Department Stores? (18)', 'Which sales and marketing people do I know? (102)', 'Who do I know in New York? (63)'],
    },
    'healthcare-academic.csv': {
      sentences: 'You know 239 people at 97 companies: 100 clinicians and 64 researchers and academics. The most at Massachusetts General Hospital (22) and Johns Hopkins University (17). Strongest in Healthcare (147). More are in Austin (27) than anywhere else.',
      chips: ['100 clinicians', '64 researchers and academics', '22 at Massachusetts General Hospital', '17 at Johns Hopkins University', '63 in Biotech', '27 in Austin'],
      more: ['35 operations people', '14 at Mayo Clinic', '29 in Education', '24 in London', '47 senior leaders', '12 sales and marketing people'],
      questions: ['Who do I know at Massachusetts General Hospital? (22)', 'Which clinicians do I know? (100)', 'Who do I know in Austin? (27)'],
    },
    'lp-fundraising-list.csv': {
      sentences: '114 contacts at 80 organisations, all of them investors or allocators. By tag: 23 “cold”, 23 “met 2026”, 20 “committed”. The most at CalPERS (5). More are in Seattle (14) than anywhere else.',
      chips: ['23 tagged “cold”', '23 tagged “met 2026”', '20 tagged “committed”', '5 at CalPERS', '4 at Ontario Teachers Pension Plan', '14 in Seattle'],
      more: ['18 tagged “passed”', '4 at Yale Investments Office', '11 in Chicago', '25 in Venture capital', '56 senior leaders', '15 tagged “follow up”'],
      questions: ['Who do I know at CalPERS? (5)', 'Who do I know in Seattle? (14)', 'Who do I know at Ontario Teachers Pension Plan? (4)'],
    },
    'small-network-linkedin.csv': {
      sentences: 'You know 22 people at 14 companies: 7 engineers and 7 investors. The most at Bluebird Labs (6) and Harbor Capital (3).',
      chips: ['7 engineers', '7 investors', '6 at Bluebird Labs', '3 at Harbor Capital', '7 connected in the 12 months before this export', '7 senior leaders'],
      more: ['3 founders and CEOs', '3 product and design people'],
      questions: ['Who do I know at Bluebird Labs? (6)', 'Which engineers do I know? (7)', 'Who do I know at Harbor Capital? (3)'],
    },
  };

  test.each(FILES)('%s: read-out, shortcuts and questions', (f) => {
    const p = PROFILES[f];
    expect({
      sentences: p.sentences.join(' '),
      chips: p.shortcuts.map((s) => s.label),
      more: p.more.map((s) => s.label),
      questions: p.questions.map((q) => `${q.text} (${q.count})`),
    }).toEqual(EXPECTED[f]);
    expect(p.everyone).toMatchObject({ id: 'everyone', label: `Everyone ${SAMPLES[f].length}`, count: SAMPLES[f].length });
    expect(p.n).toBe(SAMPLES[f].length);
  });

  test('the kind of file decides what leads', () => {
    expect(PROFILES['vc-investor-linkedin.csv'].shortcuts[0].id).toBe('role:investors');
    expect(PROFILES['founder-operator-linkedin.csv'].shortcuts.concat(PROFILES['founder-operator-linkedin.csv'].more).some((s) => s.id === 'role:investors')).toBe(false);
    expect(PROFILES['sales-crm.csv'].shortcuts.slice(0, 3).map((s) => s.type)).toEqual(['tag', 'tag', 'tag']);
    expect(PROFILES['healthcare-academic.csv'].shortcuts[0].id).toBe('role:clinicians');
    expect(PROFILES['lp-fundraising-list.csv'].defaultGrouping).toBe('tag');
    // Fewer than 30 people: no sector and no recency sentence.
    expect(PROFILES['small-network-linkedin.csv'].sentences.join(' ')).not.toMatch(/Strongest|connected/);
  });

  test('no shortcut counts zero or everyone, and pressing one lists exactly count people', () => {
    for (const f of FILES) {
      const p = PROFILES[f];
      const ids = new Set(SAMPLES[f].map(personNodeId));
      expect(p.shortcuts.length).toBeLessThanOrEqual(6);
      expect(p.shortcuts.length + p.more.length).toBeLessThanOrEqual(12);
      for (const s of [...p.shortcuts, ...p.more]) {
        expect(s.count).toBeGreaterThan(0);
        expect(s.count).toBeLessThan(p.n);
        expect(new Set(s.keys).size).toBe(s.count);
        expect(s.keys.every((k) => ids.has(k))).toBe(true);
        expect(['senior', 'recent', 'company']).toContain(s.sort);
        expect(combine(p, [s.id]).keys.size).toBe(s.count);
        expect(s.label).toBe(`${s.count.toLocaleString('en-US')} ${s.count === 1 ? s.one : s.many}`);
      }
    }
  });

  test('a company shortcut lights every person at the company, whatever the arrangement', () => {
    const list = SAMPLES['vc-investor-linkedin.csv'];
    const stripe = PROFILES['vc-investor-linkedin.csv'].shortcuts.find((s) => s.id === 'company:stripe');
    expect(stripe.count).toBe(22);
    const everyStripe = list.filter((p) => normalizeCompanyKey(p.company) === 'stripe').map(personNodeId).sort();
    expect([...stripe.keys].sort()).toEqual(everyStripe);
    for (const groupBy of ['role', 'industry', 'company']) {
      const atlas = buildAtlas(list, { groupBy });
      expect(stripe.keys.every((k) => atlas.byId.get(k)?.type === 'person')).toBe(true);
    }
  });

  test('two shortcuts combine to the intersection, and the chip counts are the intersection sizes', () => {
    const p = PROFILES['sales-crm.csv'];
    const prospect = p.shortcuts.find((s) => s.id === 'tag:prospect');
    const marlowe = p.shortcuts.find((s) => s.id.startsWith('company:marlowe'));
    const both = combine(p, [prospect.id, marlowe.id]);
    const expected = prospect.keys.filter((k) => marlowe.keys.includes(k));
    expect([...both.keys]).toEqual(expected);
    expect(both.label).toBe('tagged “prospect” · at Marlowe Department Stores');
    expect(both.sort).toBe('senior');
    for (const s of [...p.shortcuts, ...p.more]) {
      expect(countIfAdded(p, [prospect.id], s.id)).toBe(combine(p, [prospect.id, s.id]).keys.size);
    }
    expect(countIfAdded(p, [], marlowe.id)).toBe(marlowe.count);
    // At most three at once; no ids gives everyone.
    const four = [...p.shortcuts.slice(0, 4)].map((s) => s.id);
    expect(combine(p, four).label.split(' · ')).toHaveLength(3);
    expect(combine(p, []).keys.size).toBe(p.n);
    expect(combine(p, ['everyone']).label).toBe('Everyone');
  });

  test('a selection never changes the atlas', () => {
    const list = SAMPLES['vc-investor-linkedin.csv'];
    const atlas = buildAtlas(list, { groupBy: 'role' });
    const before = atlas.nodes.map((n) => [n.id, n.x, n.y, n.r]);
    const p = profileNetwork(list, { today: TODAY });
    combine(p, [p.shortcuts[0].id, p.shortcuts[2].id]);
    countIfAdded(p, [p.shortcuts[0].id], p.shortcuts[1].id);
    expect(atlas.nodes.map((n) => [n.id, n.x, n.y, n.r])).toEqual(before);
  });

  test('every example question returns at least one person from the rule engine', () => {
    for (const f of FILES) {
      const list = SAMPLES[f];
      for (const q of PROFILES[f].questions) {
        expect(q.count).toBeGreaterThan(0);
        const filters = parseQuestionRules(q.text, { knownLocations: [...new Set(list.map((p) => cityOf(p).toLowerCase()).filter(Boolean))] });
        expect(scoreContacts(list, filters).total).toBeGreaterThan(0);
      }
    }
  });

  test('the recent window ends at the earlier of today and the newest date in the file', () => {
    const list = Array.from({ length: 40 }, (_, i) => c(`P${i}`, 'Engineer', `Co ${i % 5}`, { connectedOn: i < 10 ? '2026-10-01' : '2019-01-01' }));
    expect(profileNetwork(list, { today: '2026-11-21' }).shortcuts.find((s) => s.id === 'recent').label).toBe('10 connected in the last 12 months');
    expect(profileNetwork(list, { today: '2028-01-01' }).shortcuts.find((s) => s.id === 'recent').label).toBe('10 connected in the 12 months before this export');
  });

  test('a file with little to go on says what is missing', () => {
    const x = Array.from({ length: 50 }, (_, i) => ({ name: `Handle ${i}`, company: '', position: '', tags: [`@handle${i}`], location: i % 2 ? 'Berlin' : 'London' }));
    const p = profileNetwork(x, { today: TODAY });
    // Changed 2026-11-21 (review value-15, value-2): nobody has a company or a
    // title here, so the sentence says "None", not "Most"; Berlin and London
    // hold 25 each and are said as a tie.
    expect(p.sentences[0]).toBe('50 people. None of them has a company or title in this file, so they cannot be grouped by employer or role.');
    expect(p.sentences.join(' ')).toMatch(/The most are in Berlin and London \(25 each\)\./);
    expect(p.shortcuts.every((s) => s.type !== 'tag')).toBe(true);
    expect(profileNetwork([], { today: TODAY })).toMatchObject({ n: 0, sentences: [], shortcuts: [], more: [], questions: [] });
  });

  test('the wording never uses the banned words', () => {
    const banned = /\b(api|key|token|free|paid|tier|quota|raise|source|diligence|lens)\b/i;
    for (const f of FILES) {
      const p = PROFILES[f];
      const words = [...p.sentences, ...p.shortcuts.map((s) => s.label), ...p.more.map((s) => s.label), ...p.questions.map((q) => q.text), ...p.groupings.map((g) => g.label)];
      for (const w of words) expect(w).not.toMatch(banned);
    }
  });

  test('profileNetwork on 30,000 contacts runs in under 200 ms once the map is built', () => {
    const titles = ['Software Engineer', 'Partner', 'Founder & CEO', 'Registered Nurse', 'Account Executive', 'Product Manager', 'Professor', 'VP Sales'];
    const make = () => Array.from({ length: 30000 }, (_, i) => ({
      name: `Person ${i}`, position: titles[i % titles.length], company: `Company ${i % 4000}`, location: ['Austin, TX', 'London, United Kingdom', 'Paris, France'][i % 3],
      tags: [['lead', 'customer', 'churned'][i % 3]], connectedOn: `20${10 + (i % 17)}-0${1 + (i % 9)}-15`, profileUrl: `https://www.linkedin.com/in/p-${i}`,
    }));
    profileNetwork(make(), { today: TODAY }); // load and compile the code once
    // The page builds the map first, which classifies everyone; the read-out
    // then reuses those answers. Best of two files, so a busy machine does not
    // fail the budget.
    const times = [0, 1].map(() => {
      const big = make();
      buildAtlas(big, { groupBy: 'role' });
      const t = Date.now();
      const p = profileNetwork(big, { today: TODAY });
      expect(p.n).toBe(30000);
      return Date.now() - t;
    });
    expect(Math.min(...times)).toBeLessThan(200);
  });
});

// ------------------------------------------------------------ what to do with the list (section 5)

describe('listText and listCsv', () => {
  const people = [
    c('Ada Example', 'Head of Sales', 'Stripe', { email: 'ada@example.com', tags: ['prospect', 'champion'] }),
    c('Bo Sample', '', 'Acme, Inc.', { location: 'Austin, TX' }),
    c('Cy Test', '=HYPERLINK("x")', ''),
  ];
  test('one person per line with title and company', () => {
    expect(listText(people)).toBe('Ada Example, Head of Sales at Stripe\nBo Sample, Acme, Inc.\nCy Test, =HYPERLINK("x")');
  });
  test('a CSV with only the columns the file has, quoted, and safe to open in a spreadsheet', () => {
    expect(listCsv(people)).toBe([
      'Name,Company,Title,Email,Location,Tags',
      'Ada Example,Stripe,Head of Sales,ada@example.com,,prospect; champion',
      'Bo Sample,"Acme, Inc.",,,"Austin, TX",',
      'Cy Test,,"\'=HYPERLINK(""x"")",,,',
      '',
    ].join('\n'));
    expect(listCsv([])).toBe('Name\n');
  });
});
