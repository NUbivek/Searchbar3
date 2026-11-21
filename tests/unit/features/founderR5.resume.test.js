/**
 * @jest-environment node
 *
 * Round 5, résumé owner (profile.js, profileModel.js, companyFacts.js). Each defect read off the live checks
 * eval/founder/runs/r11/trevor-milton-nikola.json and eval/founder/runs/r11/eric-glyman-ramp.json, built from the
 * records those reports hold:
 *   1. a list membership ("an official member of Forbes' 400 billionaires list") read as a current job;
 *   2. the order of the roles: the current role with the newest record first, then the company typed, then
 *      earlier roles by date;
 *   3. Ramp's funding came out empty although records give rounds ("Ramp raises $300M").
 */
const { createSubject } = require('../../../src/server/founder/identity');
const { buildProfile, publishProfile, isRankingName } = require('../../../src/server/founder/profile');
const { verifyProfile, mergeProfile } = require('../../../src/server/founder/profileModel');
const { buildCompanyFacts } = require('../../../src/server/founder/companyFacts');

let seq = 0;
const rec = (o) => ({ id: `rs${(seq += 1)}`, source: 'web-search', sourceLabel: 'Open-web search', category: 'press', severity: 'info', quote: '', match: 'confirmed', url: `https://rs.test/${seq}`, date: null, ...o });
const orgs = (list) => list.map((x) => x.org);

const milton = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const eric = createSubject({ name: 'Eric Glyman', company: 'Ramp' });

// r11 record 134, as saved
const FORBES_400 = rec({
  title: "Nikola's founder Trevor Milton is now an official member of Forbes' 400 billionaires list with a net worth of more than $5 billion - Business Insider",
  date: '2020-09-09', data: { publisher: 'Business Insider' },
});
// r11 record 11
const WIKI = rec({
  source: 'wikipedia', category: 'identity', date: '2020',
  title: 'Trevor Milton: American businessman, convicted fraudster (Wikipedia article)',
  quote: 'Trevor Robert Milton is an American entrepreneur who was convicted of fraud for making false statements to drive up the stock price of Nikola Corporation, the now-bankrupt electric-vehicle maker he founded. He was later granted a presidential pardon, and is now the chief executive officer of SyberJet Aircraft, a Utah-based aviation company developing business jets. In 2020, Milton resigned as executive chairman of Nikola following regulatory inquiries. In 2022, he was found guilty of securities and wire fraud.',
  data: { wikidataId: 'Q67146947', revisedAt: '2026-11-16T11:49:34Z' },
});
// r11 record 107
const WIKIDATA = rec({
  source: 'wikidata', category: 'career', date: '2014',
  title: 'Trevor Milton at Nikola Corporation: founder; chief executive officer (2014 to 2020-09); employed (2014 to 2020)',
  quote: 'Nikola Corporation: founded by Trevor Milton (start time 2014). Nikola Corporation: chief executive officer Trevor Milton (start time 2014; end time 2020-09).',
});
// r11 record 147
const CRUNCHBASE = rec({
  source: 'web-archive', category: 'archive', match: 'likely', date: '2020-10-30', url: 'https://web.archive.org/web/*/crunchbase.com/person/trevor-milton',
  title: 'Crunchbase profile as of 2020-09-04: CEO @ Nikola Motor Company (archived 11 times between 2019-09 and 2020-10)',
  quote: 'Trevor Milton | CEO @ Nikola Motor Company | Nikola is led by its founder and serial entrepreneur, Trevor Milton. He oversees the day-to-day operations of the Company as its CEO. Prior to starting Nikola Motor Company, Trevor was the CEO of dHybrid Systems, LLC a natural gas storage technology comp…',
  data: { kind: 'snapshot', page: 'https://www.crunchbase.com/person/trevor-milton', capturedAt: '2020-09-04' },
});
// r11 record 10
const RESIGNED = rec({
  source: 'wikipedia', category: 'litigation', date: '2020-09-10', url: 'https://en.wikipedia.org/wiki/Trevor_Milton%23Career',
  title: 'Trevor Milton (Wikipedia, "Career"): On September 10, 2020, two days after Nikola established ties with General Motors, short seller Hindenburg Research released a re…',
  quote: 'On September 20, 2020, Milton resigned from his position as executive chairman of Nikola Corporation.',
});
const MILTON_RECORDS = [FORBES_400, WIKI, WIKIDATA, CRUNCHBASE, RESIGNED];

describe('1. a ranking, list, club or award is recognition, never an employer', () => {
  test('r11 record 134: "an official member of Forbes\' 400 billionaires list" is no role; it is recognition with its year', () => {
    const p = buildProfile(milton, [FORBES_400]);
    expect(orgs(p.resume.roles).join(' ')).not.toMatch(/Forbes/);
    expect(p.resume.recognition).toEqual([expect.objectContaining({ text: 'Forbes 400', year: 2020 })]);
  });
  test.each([
    ['Trevor Milton is a member of the Forbes 400 list.', 'Forbes 400'],
    ['Trevor Milton was named to the Forbes 30 Under 30 list in 2016.', 'Forbes 30 Under 30'],
    ['Trevor Milton joined the Forbes 400 in 2020.', 'Forbes 400'],
    ['Trevor Milton joins the Bloomberg Billionaires List.', 'Bloomberg Billionaires List'],
    ['Trevor Milton is ranked No. 3 on the Midas List.', 'Midas List'],
    ['Trevor Milton is now a member of the TIME 100.', 'TIME 100'],
    ['Trevor Milton made the Fortune 40 Under 40 list in 2019.', 'Fortune 40 Under 40'],
  ])('%s', (quote, text) => {
    const p = buildProfile(milton, [rec({ title: 'News', quote, date: '2020-06-01' })]);
    expect(p.resume.roles.map((r) => `${r.title} ${r.org}`).join(' ')).not.toMatch(/Forbes|Bloomberg|Midas|TIME|Fortune/);
    expect(p.resume.recognition.map((x) => x.text)).toContain(text);
  });
  test('a year printed beside the list wins over the record date', () => {
    const p = buildProfile(milton, [rec({ title: 'News', quote: 'Trevor Milton was named to the Forbes 30 Under 30 list in 2016.', date: '2020-06-01' })]);
    expect(p.resume.recognition[0].year).toBe(2016);
  });
  test('a real employer is still a role, including a magazine', () => {
    const p = buildProfile(milton, [rec({ title: 'Bio', quote: 'Trevor Milton previously worked at Fortune Brands and Acme Motors.' })]);
    expect(orgs(p.resume.roles)).toEqual(expect.arrayContaining(['Fortune Brands', 'Acme Motors']));
  });
  test('isRankingName: lists by name or by the words after them, never an ordinary company', () => {
    expect(isRankingName("Forbes' 400")).toBe(true);
    expect(isRankingName('Fortune 500')).toBe(true);
    expect(isRankingName('Forbes 30 Under 30')).toBe(true);
    expect(isRankingName('Midas List')).toBe(true);
    expect(isRankingName('Hurun', ' rich list')).toBe(true);
    expect(isRankingName('Fortune Brands')).toBe(false);
    expect(isRankingName('Index Ventures')).toBe(false);
    expect(isRankingName('SyberJet Aircraft')).toBe(false);
  });
  test('a model\'s reading of record 134 as a role is turned into recognition', () => {
    const records = [FORBES_400];
    const v = verifyProfile(milton, records, {
      roles: [{ org: "Forbes' 400", title: 'Official member', current: true, record: 1, quote: "Trevor Milton is now an official member of Forbes' 400 billionaires list" }],
    });
    expect(v.roles).toEqual([]);
    expect(v.recognition).toEqual([expect.objectContaining({ title: 'Forbes 400', year: 2020 })]);
  });
  test('a saved profile carrying the list as a role loses it when merged', () => {
    const base = { company: 'Nikola', roles: [{ org: "Forbes' 400", title: 'Official member', current: true, cites: [134] }, { org: 'SyberJet Aircraft', title: 'CEO', current: true, cites: [11] }], recognition: [] };
    const m = mergeProfile(base, {});
    expect(orgs(m.roles)).toEqual(['SyberJet Aircraft']);
    expect(m.recognition).toEqual([expect.objectContaining({ text: 'Forbes 400', cites: [134] })]);
  });
});

describe('2. role order and currency (Trevor Milton / Nikola, r11)', () => {
  const p = buildProfile(milton, MILTON_RECORDS);
  test('SyberJet (current) first, Nikola (the company typed) next, dHybrid (earlier) last', () => {
    expect(orgs(p.resume.roles)).toEqual(['SyberJet Aircraft', 'Nikola', 'dHybrid Systems, LLC']);
    expect(p.resume.roles.map((r) => r.current)).toEqual([true, false, false]);
    expect(p.resume.roles[1]).toEqual(expect.objectContaining({ from: 2014, to: 2020 }));
  });
  test('the headline stays on the founding of Nikola, with the ended titles', () => {
    expect(p.headline).toMatch(/^Founder, Nikola \(former CEO and Executive Chairman, until 2020\)$/);
  });
  test('two current roles: the one with the newest record first', () => {
    const q = buildProfile(milton, [
      rec({ title: 'Bio', quote: 'Trevor Milton is now the chairman of Acme Motors.', date: '2019-03-01' }),
      rec({ title: 'Bio', quote: 'Trevor Milton is now the CEO of SyberJet Aircraft.', date: '2025-06-01' }),
    ]);
    expect(orgs(q.resume.roles).slice(0, 2)).toEqual(['SyberJet Aircraft', 'Acme Motors']);
  });
  test('earlier roles by date, latest first, after the company typed', () => {
    const q = buildProfile(milton, [WIKIDATA,
      rec({ title: 'Bio', quote: 'Trevor Milton worked at Acme Motors (2005 - 2008).' }),
      rec({ title: 'Bio', quote: 'Trevor Milton worked at Upsource (2010 - 2012).' }),
    ]);
    expect(orgs(q.resume.roles)).toEqual(['Nikola', 'Upsource', 'Acme Motors']);
  });
  test('the model merge keeps the same order', () => {
    const base = publishProfile(p, (ids) => ids.map((id) => Number(String(id).replace(/\D/g, '')) || 1));
    const m = mergeProfile(base, { roles: [{ org: 'dHybrid Systems, LLC', title: 'CEO', from: null, to: null, current: false, cites: [147] }] });
    expect(orgs(m.roles)).toEqual(['SyberJet Aircraft', 'Nikola', 'dHybrid Systems, LLC']);
  });
});

describe('3. funding: real, cited rounds are kept, newest first; a valuation or a fraud amount is never a round', () => {
  // r11 record 60 (graded to the company), r10 records 21, 22 and 44
  const HN = rec({ id: 'hacker-news-14a7d8w', source: 'hacker-news', category: 'press', match: 'company', date: '2021-08-24', title: 'Hacker News (63 points, 47 comments): Ramp raises $300M', quote: 'Ramp raises $300M' });
  const SERIES_B = rec({ id: 'web-search-4dbm4r', title: 'Corporate Card Fintech Ramp Earns Its Horn Following $115M Series B', quote: 'Ramp, a fintech company that developed a corporate card designed to help businesses spend less, reached a unicorn status valuation of $1.6 billion after raising $115 million in Series B funding. Subscribe to the Crunchbase Daily Eric Glyman, Gene Lee and Karim Atiyeh co-founded the New York-based company in 2019 after building and scaling money-saving platform Paribus before selling it to...' });
  const SECURES = rec({ id: 'web-search-7j2mm7', title: 'A New Corporate Card: Ramp Secures $30M For Money-saving Company Credit...', quote: '"We\'ve talked to people about the cost of rewards," Ramp co-founder and CEO Eric Glyman told Crunchbase News.' });
  const WIKI_RAMP = rec({ id: 'web-search-1ap0ain', title: 'Ramp (company) - Wikipedia', quote: 'As of June 2026, Ramp was valued at $44 billion with $1 billion in annualized revenue. Ramp was founded in March 2019 by Eric Glyman, Karim Atiyeh, and' });
  const facts = buildCompanyFacts(eric, [HN, SERIES_B, SECURES, WIKI_RAMP]);
  test('the three rounds are kept, each with its record', () => {
    expect(facts.funding.map((x) => x.amount).sort()).toEqual(['$115M', '$300M', '$30M'].sort());
    expect(facts.funding.find((x) => x.amount === '$300M')).toEqual(expect.objectContaining({ date: '2021-08-24', ids: ['hacker-news-14a7d8w'] }));
    expect(facts.funding.find((x) => x.amount === '$115M')).toEqual(expect.objectContaining({ round: 'Series B' }));
  });
  test('the newest dated round first, undated after', () => {
    const f = buildCompanyFacts(eric, [
      rec({ match: 'company', date: '2020-02-10', title: 'Ramp raises $30M Series A led by Founders Fund', quote: '' }),
      rec({ match: 'company', date: '2022-03-29', title: 'Ramp raises $200M Series C led by Founders Fund', quote: '' }),
      rec({ match: 'company', date: null, title: 'Ramp raises $8M seed round', quote: '' }),
    ]);
    expect(f.funding.map((x) => x.round)).toEqual(['Series C', 'Series A', 'Seed']);
    expect(f.funding[0]).toEqual(expect.objectContaining({ amount: '$200M', date: '2022-03-29', lead: 'Founders Fund' }));
  });
  test('valuations stay standing lines, never rounds', () => {
    expect(facts.funding.map((x) => x.amount).join(' ')).not.toMatch(/1\.6 billion|44 billion|1 billion/);
    const f = buildCompanyFacts(eric, [rec({ match: 'company', title: 'Ramp raises $500M at $13B valuation', quote: 'Ramp raised $500 million at a $13 billion valuation.' })]);
    expect(f.funding.map((x) => x.amount).join(' ')).not.toMatch(/13/);
    expect(f.standing.map((x) => x.kind)).toContain('valuation');
  });
  test('a fraud amount or a net worth is never a round', () => {
    const f = buildCompanyFacts(milton, [
      rec({ title: 'Nikola raised $700 million from investors defrauded by its founder', quote: '' }),
      rec({ title: 'Nikola secures $125 million settlement with the SEC', quote: '' }),
      FORBES_400,
    ]);
    expect(f.funding).toEqual([]);
    expect(f.standing.map((x) => x.text).join(' ')).not.toMatch(/5 billion/);
  });
});
