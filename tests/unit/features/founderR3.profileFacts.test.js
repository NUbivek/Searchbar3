/**
 * @jest-environment node
 *
 * Round 3, profile owner: companyFacts.js (design decision 1, and the graders' "funding history", "company
 * standing" and "legal entity" notes). Read in code, from records tied to the person or the company only.
 */
const fs = require('fs');
const path = require('path');
const { createSubject } = require('../../../src/server/founder/identity');
const { buildCompanyFacts, publishCompanyFacts, learnCompanyNames, clipAround, companyNames } = require('../../../src/server/founder/companyFacts');

let seq = 0;
const rec = (o) => ({ id: `c${(seq += 1)}`, source: 'web-search', category: 'press', quote: '', match: 'confirmed', url: `https://x.test/${seq}`, date: null, ...o });
const formD = (o = {}) => rec({ source: 'sec-filings', category: 'corporate', title: 'Form D filed by Ramp Business Corp names Eric Glyman as Executive Officer and Director', quote: 'Issuer: Ramp Business Corp (Corporation, DELAWARE); related person: Eric Glyman, Executive Officer and Director; date of first sale: 2026-10-07; total offering amount: $1,850,000,000; total amount sold: $1,585,000,000', data: { form: 'D', issuer: 'Ramp Business Corp', roles: ['Executive Officer', 'Director'] }, date: '2026-10-16', ...o });

describe('funding rounds, investors and standing', () => {
  const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
  test('"raised $55M Series B led by Accel", with date, lead and investors', () => {
    const facts = buildCompanyFacts(shensi, [
      rec({ match: 'company', title: 'Merge raises $55M Series B led by Accel', quote: 'Merge raised a $55M Series B led by Accel, with participation from NEA and Addition, in October 2022.', date: '2022-10-24' }),
      rec({ match: 'company', title: 'Merge raises $4.5M seed', quote: 'Merge raised $4.5M in seed funding led by NEA in May 2021.' }),
    ]);
    const b = facts.funding.find((r) => r.round === 'Series B');
    expect(b).toEqual(expect.objectContaining({ amount: '$55M', lead: 'Accel' }));
    expect(b.date).toMatch(/^2022-10/);
    expect(b.investors).toEqual(expect.arrayContaining(['NEA', 'Addition']));
    expect(facts.funding.find((r) => /seed/i.test(r.round || ''))).toEqual(expect.objectContaining({ amount: '$4.5M', lead: 'NEA', date: '2021-05' }));
    expect(facts.investors.map((i) => i.name)).toEqual(expect.arrayContaining(['Accel', 'NEA', 'Addition']));
  });
  test('a record matched by name only, or the bare word in a record tied to nothing, is not the company\'s', () => {
    const facts = buildCompanyFacts(shensi, [
      rec({ match: 'possible', title: 'Merge raises $9M', quote: 'Merge raised $9M led by Foo Ventures.' }),
      rec({ match: 'company', title: 'Mainnet Merge', quote: 'The Merge cost $1 billion in gas fees, valued at $2 billion.' }),
    ]);
    expect(facts.funding).toEqual([]);
    expect(facts.standing).toEqual([]);
  });
  test('valuation, headcount and customers, each cited; founding year', () => {
    const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    const facts = buildCompanyFacts(eric, [
      rec({ title: 'Eric Glyman, co-founder of Ramp', quote: 'Eric Glyman is the co-founder of Ramp, valued at $44 billion and used by over 70,000 businesses. Ramp has about 1,200 employees.' }),
      rec({ title: 'Ramp (company) - Wikipedia', quote: 'Ramp was founded in March 2019 by Eric Glyman, Karim Atiyeh, and Gene Lee.' }),
    ]);
    expect(facts.standing.map((x) => x.kind).sort()).toEqual(['customers', 'headcount', 'valuation']);
    for (const x of facts.standing) expect(x.ids.length).toBeGreaterThan(0);
    expect(facts.founded).toEqual(expect.objectContaining({ year: 2019 }));
  });
});

describe('legal names and domains (design decision 1)', () => {
  const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
  test('a Form D naming the person as officer gives the legal name, and its amounts are never cut', () => {
    const facts = buildCompanyFacts(eric, [formD()]);
    expect(facts.legalNames).toEqual([{ name: 'Ramp Business Corp', ids: [expect.any(String)] }]);
    expect(facts.funding[0]).toEqual(expect.objectContaining({ round: 'Form D offering', amount: '$1,850,000,000 offered; $1,585,000,000 sold', date: '2026-10-07' }));
  });
  test('an issuer that does not begin with the company, or a filing that does not name them, gives nothing', () => {
    expect(buildCompanyFacts(eric, [formD({ data: { form: 'D', issuer: 'Ramp Network Ltd' }, title: 'Form D filed by Ramp Network Ltd' })]).legalNames).toEqual([]);
    expect(buildCompanyFacts(eric, [formD({ data: { form: 'D', issuer: 'Rampart Holdings', roles: ['Director'] } })]).legalNames).toEqual([]);
    expect(buildCompanyFacts(eric, [formD({ match: 'possible' })]).legalNames).toEqual([]);
  });
  test('the site\'s legal footer on a company domain', () => {
    const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const { legalNames } = companyNames(shensi, [
      rec({ source: 'domain-history', match: 'company', title: 'merge.dev: registered 2020-01-02', url: 'https://rdap.org/domain/merge.dev' }),
      rec({ match: 'company', url: 'https://www.merge.dev/legal/terms', title: 'Terms', quote: 'These terms are between you and Merge API, Inc. © 2024 Merge API, Inc. All rights reserved.' }),
    ]);
    expect(legalNames.map((n) => n.name)).toEqual(['Merge API, Inc.']);
  });
  test('learnCompanyNames registers them through identity.js, with the record as origin', () => {
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    const f = formD();
    expect(learnCompanyNames(s, [f])).toEqual(['Ramp Business Corp']);
    expect([...s.anchors.aliases.values()][0]).toEqual(expect.objectContaining({ value: 'Ramp Business Corp', origin: f.id }));
    expect(learnCompanyNames(s, [f])).toEqual([]);
  });
});

describe('published form and number safety', () => {
  test('ids become cites; a line with no cited record is dropped', () => {
    const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    const facts = buildCompanyFacts(eric, [formD()]);
    const out = publishCompanyFacts(facts, (ids) => ids.map(() => 3));
    expect(out.legalNames).toEqual([{ name: 'Ramp Business Corp', cites: [3] }]);
    expect(publishCompanyFacts(facts, () => [])).toBeNull();
  });
  test('a long sentence is shortened only between words: a figure is never cut', () => {
    const text = `${'word '.repeat(80)}raised $1,850,000,000 in total ${'more '.repeat(80)}`;
    const out = clipAround(text, text.indexOf('$'), 120);
    expect(out).toMatch(/\$1,850,000,000/);
    expect(out.replace(/…/g, '').split(/\s+/).every((w) => /^(word|more|raised|\$1,850,000,000|in|total)?$/.test(w))).toBe(true);
  });
  test('the saved Glyman report: Ramp Business Corp, the Form D, the $44 billion valuation', () => {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../eval/founder/runs/r9/eric-glyman-ramp.json'), 'utf8'));
    const items = new Map();
    const walk = (v) => { if (Array.isArray(v)) { v.forEach(walk); return; } if (!v || typeof v !== 'object') return; if (v.id && 'quote' in v && v.source) items.set(v.id, v); Object.values(v).forEach(walk); };
    walk(d);
    const facts = buildCompanyFacts(createSubject({ name: d.name, company: d.company }), [...items.values()]);
    expect(facts.legalNames.map((n) => n.name)).toContain('Ramp Business Corp');
    expect(facts.founded.year).toBe(2019);
    expect(facts.standing.some((x) => /\$44 billion/.test(x.text))).toBe(true);
    expect(facts.funding.some((x) => /1,850,000,000/.test(x.amount))).toBe(true);
  });
});
