/**
 * @jest-environment node
 *
 * Round 4, network-security-gaps-link-not-governing (src/server/founder/gaps.js).
 *
 * The second reader keeps a company or a person only when the link word in the sentence governs it: the word
 * that says "founded", "CEO", "co-founder" must be about the person and the proposed name, not about a
 * different clause or another person's own title ("Ford CEO Jim Farley").
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/llm/providers', () => ({ chatJson: jest.fn(), chatComplete: jest.fn(), llmConfigured: () => true, PROVIDERS: [], providerEnabled: () => true }));

const { startState } = require('../../../src/server/founder/deepCheck');
const { verifyGaps } = require('../../../src/server/founder/gaps');

const milton = () => startState({ name: 'Trevor Milton', company: 'Nikola' });
const rec = (quote) => ({ id: 'f1', sourceLabel: 'Fake News', category: 'press', match: 'confirmed', title: 'Trevor Milton in the news', quote });
const none = { companies: [], schools: [], people: [], searches: [] };
const values = (out) => out.threads.map((t) => `${t.kind}:${t.value}`);
const company = (quote, name) => verifyGaps(milton(), [rec(quote)], { ...none, companies: [{ name, record: 1, role: 'founder' }] });
const person = (quote, name, tie = 'business') => verifyGaps(milton(), [rec(quote)], { ...none, people: [{ name, record: 1, tie, detail: 'x' }] });

describe('a company is kept only when the link word governs it', () => {
  test.each([
    ['Trevor Milton, the CEO of Nikola, criticised Ford.', 'Ford'],
    ['Trevor Milton founded Nikola and Ford launched a truck.', 'Ford'],
    ['Trevor Milton founded Nikola, but Ford sued him later.', 'Ford'],
    ['Trevor Milton, the CEO of Nikola, is a critic of Ford.', 'Ford'],
    ['Trevor Milton criticised the board of Ford.', 'Ford'],
    ['Ford launched a truck and Trevor Milton watched.', 'Ford'],
    ['Trevor Milton founded Nikola and later acquired Ford.', 'Ford'],
  ])('%s -> %s is dropped', (quote, name) => {
    expect(company(quote, name).threads).toEqual([]);
  });

  test.each([
    ['Trevor Milton founded Romeo Power in 2014.', 'Romeo Power', 'founder'],
    ['Trevor Milton was the chief executive of Romeo Power until 2019.', 'Romeo Power', 'chief executive'],
    ['Trevor Milton co-founded Nikola and Romeo Power in 2014.', 'Romeo Power', 'co-founder'],
    ['Trevor Milton founded Nikola, then worked at Romeo Power.', 'Romeo Power', 'worked there'],
    ['Romeo Power, founded by Trevor Milton, makes batteries.', 'Romeo Power', 'founder'],
    ['Trevor Milton moved to Phoenix and founded Romeo Power.', 'Romeo Power', 'founder'],
    ['Before Nikola, Trevor Milton ran dHybrid Systems and an alarm company called St. George Security.', 'St. George Security', 'ran it'],
  ])('%s -> %s is kept as %s', (quote, name, role) => {
    const out = company(quote, name);
    expect(values(out)).toEqual([`company:${name}`]);
    expect(out.threads[0].statedRole).toBe(role);
  });
});

describe('an associate is kept only when the tie word is about the person, not the other person\'s own title', () => {
  test.each([
    ['Trevor Milton and Ford CEO Jim Farley met.', 'Jim Farley'],
    ['Trevor Milton, CEO of Nikola, criticised Jim Farley.', 'Jim Farley'],
    ['Trevor Milton and former Ford chief executive Jim Farley spoke on a panel.', 'Jim Farley'],
    ['Jim Farley, Ford CEO, and Trevor Milton spoke.', 'Jim Farley'],
    ['Jim Farley, Ford CEO, praised Trevor Milton.', 'Jim Farley'],
  ])('%s -> %s is dropped', (quote, name) => {
    expect(person(quote, name).threads).toEqual([]);
  });

  test.each([
    ['Trevor Milton hired former Ford chief executive Jim Farley in 2015.', 'Jim Farley'],
    ['Trevor Milton\'s co-founder Jim Farley left in 2016.', 'Jim Farley'],
    ['Trevor Milton co-founded Nikola with Jim Farley in 2014.', 'Jim Farley'],
    ['Jim Farley was hired by Trevor Milton in 2015.', 'Jim Farley'],
    ['Trevor Milton and Nikola co-founder Jim Farley spoke on a panel.', 'Jim Farley'],
  ])('%s -> %s is kept', (quote, name) => {
    expect(values(person(quote, name))).toEqual([`associate:${name}`]);
  });
});
