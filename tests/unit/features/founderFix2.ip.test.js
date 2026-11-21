/**
 * Round 2 grading fixes for the trademark connector: the owner must be the
 * company's whole name (legal form aside), never only its core word, and a
 * one-word name other than the company the user gave is kept only as possible.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { trademarkFindings } = require('../../../src/server/founder/sources/ip');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const tm = (id, wordmark, owners, filed, { alive = false } = {}) => ({
  id, source: { id, wordmark, ownerName: owners, filedDate: `${filed}T00:00:00`, alive, internationalClass: ['IC 036'] },
});
const answer = (hits) => ({ hits: { totalValue: hits.length, hits } });
// Round 3: the trademark search the connector used is no longer asked (terms); the matching is tested on the
// filings directly, as a permitted feed would supply them.
let filings = null;
function network(body) { filings = { hits: body.hits.hits, totalValue: body.hits.totalValue }; }
const run = async (value, subject) => trademarkFindings(value, filings, ctxFor(subject));

beforeEach(() => setTransport(async (url) => { throw new Error(`unexpected request to ${url}`); }));
afterEach(() => setTransport());

describe('trademark owner must carry the whole company name', () => {
  test('"Flow Companies Inc" is not the company "Flow"', async () => {
    network(answer([
      tm('86000001', 'FLOW', ['Flow Companies Inc (CORPORATION; NORTH CAROLINA, USA)'], '2012-01-01', { alive: true }),
      tm('86000002', 'FLOW HOME', ['Flow Holdings LLC (LIMITED LIABILITY COMPANY; DELAWARE, USA)'], '2021-01-01', { alive: true }),
    ]));
    const { findings, notes } = await run('Flow', createSubject({ name: 'Jane Example', company: 'Flow' }));
    expect(findings).toEqual([]);
    expect(notes[0]).toMatch(/^No US trademark owner is named exactly Flow\./);
  });

  test('a name with a describing word ("Mistral Group") is not the company "Mistral AI", and the reverse', async () => {
    network(answer([tm('87000001', 'MISTRAL', ['Mistral Group, Inc. (CORPORATION; MARYLAND, USA)'], '2016-04-04', { alive: true })]));
    expect((await run('Mistral AI', createSubject({ name: 'Jane Example', company: 'Mistral AI' }))).findings).toEqual([]);
    network(answer([tm('79397874', 'MISTRAL AI', ['Mistral AI (SAS; FRANCE)'], '2023-12-15', { alive: true })]));
    expect((await run('Mistral', createSubject({ name: 'Jane Example', company: 'Mistral' }))).findings).toEqual([]);
  });

  test('only the legal form is set aside: "Acme Robotics, Inc." and "ACME ROBOTICS PBC" are the same owner', async () => {
    network(answer([
      tm('88000001', 'ACME', ['ACME ROBOTICS, INC. (CORPORATION; DELAWARE, USA)'], '2019-01-01', { alive: true }),
      tm('88000002', 'ACME ARM', ['Acme Robotics PBC (CORPORATION; DELAWARE, USA)', 'ACME ROBOTICS, INC. (CORPORATION; DELAWARE, USA)'], '2020-01-01', { alive: true }),
      tm('88000003', 'ACME HAND', ['Acme Robotics PBC (CORPORATION; DELAWARE, USA)'], '2021-01-01', { alive: true }),
    ]));
    const { findings } = await run('Acme Robotics', createSubject({ name: 'Jane Example', company: 'Acme Robotics' }));
    expect(findings[0].title).toBe('Acme Robotics: 3 US trademark filings, earliest filed 2019-01-01; 3 live, 0 no longer live');
    expect(findings[0].match).toBe('company');
    expect(findings[0].data.excludeFromTimeline).toBeUndefined();
  });

  test('a one-word name that is not the given company ("We Co." / "WE, INC.") is possible, fixed and out of the timeline', async () => {
    network(answer([tm('73600001', 'WE', ['WE, INC. (CORPORATION; NEW YORK, USA)'], '1987-05-05')]));
    const { findings } = await run('We Co.', createSubject({ name: 'Jane Example', company: 'Example Works' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ match: 'possible', matchFixed: true });
    expect(findings[0].matchReasons[0]).toMatch(/one-word name other companies also use/);
    expect(findings[0].data.excludeFromTimeline).toBe(true);
  });

  test('the one-word company the user gave keeps its company grade', async () => {
    network(answer([tm('85214873', 'STRIPE', ['STRIPE, INC. (CORPORATION; DELAWARE, USA)'], '2011-01-11', { alive: true })]));
    const { findings } = await run('Stripe', createSubject({ name: 'Jane Example', company: 'Stripe, Inc.' }));
    expect(findings[0]).toMatchObject({ match: 'company' });
    expect(findings[0].data.excludeFromTimeline).toBeUndefined();
  });
});
