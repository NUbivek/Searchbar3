/**
 * Round 3 (audit of 2026-11-20) for ip.js: patents graded from look-alike assignees, Google Patents only by the
 * owner's choice and honest when it turns the lookup away, a summary that can be re-graded, and trademarks that
 * never call the USPTO web application's own search and never take "RAMP CORPORATION" (HEALTHRAMP) for Ramp.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, addCompanyAlias, matchSubject } = require('../../../src/server/founder/identity');
const { patentsConnector, trademarksConnector, trademarkFindings } = require('../../../src/server/founder/sources/ip');

const reply = (body, status = 200) => ({ status, headers: new Map(), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const gp = (number, title, priority, inventor, assignee) => ({ id: `patent/${number}/en`, patent: { title, priority_date: priority, filing_date: priority, grant_date: null, inventor, assignee, publication_number: number } });
const gpAnswer = (results, inventors = []) => ({ results: { total_num_results: results.length, cluster: [results.length ? { result: results } : {}], summary: { inventor: inventors.map(([key, value]) => ({ key, value })) } } });
function patentNetwork(byName, byCompany) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    const inner = new URL(url).searchParams.get('url') || '';
    const answer = inner.includes('assignee=') ? byCompany : byName;
    return { url, ...(answer && typeof answer.text === 'function' ? answer : reply(answer)) };
  });
  return calls;
}
const run = (subject) => patentsConnector.run({ kind: 'subject', value: subject.name }, ctxFor(subject));

beforeEach(() => { setTransport(async (url) => { throw new Error(`unexpected request to ${url}`); }); process.env.FOUNDER_GOOGLE_PATENTS = 'on'; });
afterEach(() => { setTransport(); delete process.env.FOUNDER_GOOGLE_PATENTS; });

describe('patents: look-alike assignees', () => {
  test('John Smith / Flow: "Flow Hair Salon Inc" and "Flowserve Corp" from the assignee search are possible, and nothing is followed', async () => {
    const byCompany = gpAnswer([
      gp('US1000001A', 'Hair dryer stand', '2015-01-01', '<b>John Smith</b>', '<b>Flow</b> Hair Salon Inc'),
      gp('US1000002A', 'Valve seal', '2016-01-01', '<b>John A. Smith</b>', '<b>Flow</b>serve Corp'),
    ], [['John Smith', 10], ['Pat Stranger', 9]]);
    patentNetwork(gpAnswer([]), byCompany);
    const { findings, threads } = await run(createSubject({ name: 'John Smith', company: 'Flow' }));
    const families = findings.slice(1);
    expect(families).toHaveLength(2);
    for (const f of families) {
      expect(f).toMatchObject({ match: 'possible', matchFixed: true });
      expect(f.matchReasons[0]).toMatch(/only resembles Flow/);
      expect(f.data.excludeFromTimeline).toBe(true);
    }
    expect(findings[0].match).toBe('possible'); // the summary
    expect(threads.every((t) => t.trusted === false)).toBe(true);
    expect(threads.some((t) => t.kind === 'associate')).toBe(false);
  });

  test('a family whose owner is exactly a known company is graded by the identity check; its threads are followed only for the user\'s company', async () => {
    const byName = gpAnswer([gp('US1000003A', 'Price tracking', '2014-10-08', '<b>Eric Robert Glyman</b>', 'Paribus Co.'), gp('US1000004A', 'Reservation rebooking', '2017-06-30', '<b>Eric Glyman</b>', 'Capital One Services, Llc')]);
    patentNetwork(byName, gpAnswer([]));
    const subject = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    addAnchor(subject, 'companies', 'Paribus', 'wikipedia-1');
    const { findings, threads } = await run(subject);
    const paribus = findings.find((f) => f.data?.publicationNumber === 'US1000003A');
    expect(paribus.match).toBe('confirmed');
    // Paribus is a known company but neither the one typed nor one whose website is known: its owners are not followed
    expect(threads.filter((t) => t.trusted)).toEqual([]);
  });
});

describe('patents: the summary can be re-graded', () => {
  test('the summary carries every assignee, so a company learned later ties it, and its title has no stale count', async () => {
    const byName = gpAnswer([gp('US1000003A', 'Price tracking', '2014-10-08', '<b>Eric Robert Glyman</b>', 'Paribus Co.')]);
    patentNetwork(byName, gpAnswer([]));
    const subject = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    const [summary] = (await run(subject)).findings;
    expect(summary.title).toBe('Eric Glyman: named inventor on 1 patent family');
    expect(summary.match).toBe('possible');
    addAnchor(subject, 'companies', 'Paribus', 'wikipedia-1');
    expect(matchSubject(subject, summary.gradeText).level).toBe('confirmed');
  });
});

describe('patents: Google Patents only by the owner\'s choice, and honest when it says no', () => {
  test('not enabled unless the owner allows Google Patents', () => {
    delete process.env.FOUNDER_GOOGLE_PATENTS;
    expect(patentsConnector.enabled()).toBe(false);
    expect(patentsConnector.unavailableReason).toBe('Patent records are not enabled on this deployment.');
  });

  test('Google turning the lookup away is a failure that says patents were not checked, never "no patents"', async () => {
    patentNetwork(reply('<html>Our systems have detected unusual traffic</html>', 503), reply('<html>unusual traffic</html>', 503));
    await expect(run(createSubject({ name: 'Trevor Milton', company: 'Nikola' }))).rejects.toThrow(/Google Patents turned the lookup away \(HTTP 503\); patents were not checked/);
  });
});

/* ------------------------------------------------------------------ trademarks */

const tm = (id, wordmark, owners, filed, alive = false) => ({ id, source: { id, wordmark, ownerName: owners, filedDate: `${filed}T00:00:00`, alive, internationalClass: ['IC 036'] } });
const RAMP_FILINGS = {
  hits: [
    tm('78272809', 'HEALTHRAMP', ['RAMP CORPORATION (CORPORATION; DELAWARE, USA)'], '2003-07-10'),
    tm('78424963', 'HEALTHRAMP CAREPOINT COMPANION', ['Ramp Corporation (CORPORATION; DELAWARE, USA)'], '2004-05-25'),
    tm('88500001', 'RAMP', ['Ramp Business Corporation (CORPORATION; DELAWARE, USA)'], '2019-06-01', true),
    tm('97000002', 'RAMP INTELLIGENCE', ['Ramp Business Corporation (CORPORATION; DELAWARE, USA)'], '2023-02-01', true),
  ],
  totalValue: 4,
};

describe('trademarks', () => {
  test('the connector never makes a request and reports the lookup as not run', async () => {
    const out = await trademarksConnector.run({ kind: 'company', value: 'Ramp' }, ctxFor(createSubject({ name: 'Eric Glyman', company: 'Ramp' })));
    expect(out.findings).toEqual([]);
    expect(out.partial).toEqual(['US trademarks (not enabled)']);
  });

  test('Ramp without its legal name: the bare-word owner (HEALTHRAMP) is counted in a note, never shown as Ramp\'s', () => {
    const out = trademarkFindings('Ramp', RAMP_FILINGS, ctxFor(createSubject({ name: 'Eric Glyman', company: 'Ramp' })));
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/2 US trademark filings are owned by a business named Ramp \(RAMP CORPORATION\)\. "Ramp" is an ordinary word/);
    expect(JSON.stringify(out)).not.toMatch(/HEALTHRAMP/);
  });

  test('with Ramp\'s legal name known, its own marks are the company\'s and the bare-word owner is left out', () => {
    const subject = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    addCompanyAlias(subject, { company: 'Ramp', alias: 'Ramp Business Corporation', origin: 'sec-filings-1' });
    const out = trademarkFindings('Ramp', RAMP_FILINGS, ctxFor(subject));
    expect(out.findings[0].title).toBe('Ramp: 2 US trademark filings, earliest filed 2019-06-01; 2 live, 0 no longer live');
    expect(out.findings[0]).toMatchObject({ match: 'company' });
    expect(out.findings[0].matchReasons[0]).toMatch(/matches Ramp Business Corporation, a known name of Ramp/);
    expect(JSON.stringify(out)).not.toMatch(/HEALTHRAMP|RAMP CORPORATION/);
  });
});
