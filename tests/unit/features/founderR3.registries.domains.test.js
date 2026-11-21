/**
 * Round 3 (audit of 2026-11-20) for domains.js: the founding year is read from a tied record that names the
 * domain, so "ramp.com: registered 1994" (Ramp was founded in 2019) is labelled as an earlier holder's
 * registration and kept off the timeline, while another company's founding year is never compared.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { domainHistoryConnector, foundingYearFor } = require('../../../src/server/founder/sources/domains');

const reply = (body, status = 200) => ({ status, headers: new Map(), text: async () => JSON.stringify(body) });
const RDAP = { objectClassName: 'domain', status: ['client transfer prohibited'], events: [{ eventAction: 'registration', eventDate: '1994-03-14T05:00:00Z' }, { eventAction: 'expiration', eventDate: '2030-12-01T05:00:00Z' }] };
beforeEach(() => setTransport(async (url) => ({ url, ...(url.startsWith('https://rdap.org/') ? reply(RDAP) : reply({ years: {}, first_ts: null })) })));
afterEach(() => setTransport());

const subject = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
const run = (findings) => domainHistoryConnector.run({ kind: 'domain', value: 'ramp.com' }, { subject, deadline: Date.now() + 20000, findings: () => findings });
const yc = (website, yearFounded, match = 'company') => ({ id: `yc-${website}`, source: 'yc-directory', match, data: { website, yearFounded } });

test('a tied record naming the domain gives the founding year; the old registration is an earlier holder\'s and off the timeline', async () => {
  const [f] = (await run([yc('ramp.com', 2019)])).findings;
  expect(f.title).toBe('ramp.com: registered 1994-03-14; no archived copies found (registered 25 years before the stated 2019 founding: registered by an earlier holder and acquired later)');
  expect(f.data).toMatchObject({ earlierHolder: true, excludeFromTimeline: true, foundedYear: 2019, foundedFrom: 'yc-ramp.com' });
  expect(f.severity).toBe('info');
});

test('another company\'s founding year (an earlier start-up) or a name-only record is never compared', async () => {
  expect(foundingYearFor('ramp.com', {}, { findings: () => [yc('paribus.co', 2015), yc('ramp.com', 2019, 'possible')] })).toBeNull();
  const [f] = (await run([yc('paribus.co', 2015)])).findings;
  expect(f.title).not.toMatch(/founding/);
  expect(f.data.excludeFromTimeline).toBeUndefined();
});
