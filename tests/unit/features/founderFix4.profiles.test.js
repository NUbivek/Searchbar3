/**
 * Round 4 fixes in sources/profiles.js (Hacker News company stories): a
 * company story whose article address carries the person's full name is
 * graded as theirs ('likely' at most), a company-only story from before the
 * person's stated tenure is dropped, and a one-word company name used for
 * another organisation's product is not the company.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addRoleAnchor } = require('../../../src/server/founder/identity');
const { hackerNewsConnector, __resetProfilesForTests } = require('../../../src/server/founder/sources/profiles');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const companyTask = (company) => ({ kind: 'company', value: company, template: null, params: null, depth: 1, relation: null });
const hnHit = (id, title, url, points, comments, created, text = null) => ({ objectID: String(id), title, url, points, num_comments: comments, created_at: created, story_text: text, author: 'someone', _tags: ['story'] });

function network(hits) {
  setTransport(async (url) => ({ status: 200, headers: new Map(), url, text: async () => JSON.stringify({ hits }) }));
}

beforeEach(() => __resetProfilesForTests());
afterEach(() => setTransport());

describe('a company story that carries the person', () => {
  test("the article's address names the person: graded as theirs, but likely at most", async () => {
    network([
      hnHit(1, 'Brightloom founder made millions leasing buildings to Brightloom', 'https://news.example.com/2019/dana-okafor-landlord-to-brightloom', 120, 40, '2019-07-18T00:00:00Z'),
      hnHit(2, 'Brightloom raises $50M', 'https://news.example.com/2019/brightloom-raise', 80, 10, '2019-03-01T00:00:00Z'),
    ]);
    const subject = createSubject({ name: 'Dana Okafor', company: 'Brightloom' });
    const { findings } = await hackerNewsConnector.run(companyTask('Brightloom'), ctxFor(subject));
    const byUrl = Object.fromEntries(findings.map((f) => [f.url, f]));
    const lifted = byUrl['https://news.example.com/2019/dana-okafor-landlord-to-brightloom'];
    expect(lifted.match).toBe('likely');
    expect(lifted.matchReasons[0]).toBe("the article's address names the person");
    expect(byUrl['https://news.example.com/2019/brightloom-raise'].match).toBe('company');
  });

  test('a story naming only the company and a CEO title stays a company record (no full name)', async () => {
    network([hnHit(3, 'Brightloom CEO gives back $5.9M', 'https://news.example.com/ceo-gives-back', 90, 20, '2019-10-22T00:00:00Z')]);
    const subject = createSubject({ name: 'Dana Okafor', company: 'Brightloom' });
    addRoleAnchor(subject, { org: 'Brightloom', from: '2010-01-01', to: '2019-09-24' });
    const { findings } = await hackerNewsConnector.run(companyTask('Brightloom'), ctxFor(subject));
    expect(findings.map((f) => f.match)).toEqual(['company']);
  });
});

describe('company-only stories that are not about the person’s company', () => {
  test('dated before the year the stated tenure began: dropped', async () => {
    network([
      hnHit(4, 'Flow raises $70M for apartment rentals', 'https://news.example.com/flow-raise', 50, 10, '2022-08-15T00:00:00Z'),
      hnHit(5, 'Flow raises seed round for a music app', 'https://news.example.com/old-flow', 50, 10, '2014-02-01T00:00:00Z'),
    ]);
    const subject = createSubject({ name: 'Dana Okafor', company: 'Flow' });
    addRoleAnchor(subject, { org: 'Flow', from: '2022-05-01' });
    const { findings } = await hackerNewsConnector.run(companyTask('Flow'), ctxFor(subject));
    expect(findings.map((f) => f.url)).toEqual(['https://news.example.com/flow-raise']);
  });

  test('without a stated tenure, nothing is dropped on its date', async () => {
    network([hnHit(5, 'Flow raises seed round for a music app', 'https://news.example.com/old-flow', 50, 10, '2014-02-01T00:00:00Z')]);
    const subject = createSubject({ name: 'Dana Okafor', company: 'Flow' });
    const { findings } = await hackerNewsConnector.run(companyTask('Flow'), ctxFor(subject));
    expect(findings).toHaveLength(1);
  });

  test("another organisation launching a product of that one-word name: dropped", async () => {
    network([
      hnHit(6, 'Facebook Launches Flow, a static type checker for JavaScript', 'https://code.example.com/flow-type-checker', 600, 200, '2014-11-18T00:00:00Z'),
      hnHit(7, 'Acmecorp acquires Flow', 'https://news.example.com/flow-acquired', 40, 10, '2024-01-01T00:00:00Z'),
      hnHit(8, 'Today Flow launches its new app', 'https://news.example.com/flow-app', 40, 10, '2023-01-01T00:00:00Z'),
    ]);
    const subject = createSubject({ name: 'Dana Okafor', company: 'Flow' });
    const { findings } = await hackerNewsConnector.run(companyTask('Flow'), ctxFor(subject));
    expect(findings.map((f) => f.url).sort()).toEqual(['https://news.example.com/flow-acquired', 'https://news.example.com/flow-app']);
  });

  test('a known company of the subject launching it is not another organisation', async () => {
    network([hnHit(9, 'Brightloom launches Flow, its rental platform', 'https://news.example.com/bl-flow', 40, 10, '2023-01-01T00:00:00Z')]);
    const subject = createSubject({ name: 'Dana Okafor', company: 'Flow' });
    require('../../../src/server/founder/identity').addAnchor(subject, 'companies', 'Brightloom');
    const { findings } = await hackerNewsConnector.run(companyTask('Flow'), ctxFor(subject));
    expect(findings).toHaveLength(1);
  });
});
