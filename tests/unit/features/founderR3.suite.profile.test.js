/**
 * Final pass (suite): a lead to confirm with the person never carries a broker's CRD number. The number
 * identifies the person, and the profile card shows lead text as it is (privacy rule: no ID numbers).
 */
const { createSubject } = require('../../../src/server/founder/identity');
const { buildProfile } = require('../../../src/server/founder/profile');
const { buildReport } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
const rec = (o) => ({ id: `q${(seq += 1)}`, source: 'web-search', sourceLabel: 'Open-web search', category: 'press', severity: 'info', quote: '', match: 'confirmed', url: `https://x.test/${seq}`, date: null, ...o });

test('a BrokerCheck lead in the profile names the firm and years, without the CRD number', () => {
  const shensi = createSubject({ name: 'Shensi Ding', company: 'Merge' });
  const broker = rec({ source: 'finra-brokercheck', category: 'regulatory', match: 'possible', title: 'Shensi Ding (CRD 6203724): no disclosures on the BrokerCheck record', quote: 'Shensi Ding, CRD 6203724: broker registration inactive. Firms: Credit Suisse Securities (USA) LLC (2015-08-11 to 2017-08-01). No disclosures.', data: { crd: '6203724', firms: ['Credit Suisse Securities (USA) LLC'], disclosures: 0 }, date: '2017-08-01' });
  const bio = rec({ source: 'page-reader', data: { kind: 'bio' }, title: 'Podcast', quote: 'In this episode, Shensi Ding, Co-Founder and CEO of Merge, shares her journey from investment banking to leading Merge.' });
  const grad = rec({ source: 'page-reader', data: { kind: 'bio' }, title: 'Accel', quote: 'The journey began in 2015 after Shensi and Gil graduated from Columbia University.' });
  const lead = buildProfile(shensi, [broker, bio, grad]).resume.leads.find((l) => /Credit Suisse/.test(l.text));
  expect(lead).toBeTruthy();
  expect(lead.text).toMatch(/2015/);
  expect(lead.text).not.toMatch(/CRD|6203724/);
});

test('a lead taken from a name-only record\'s title drops the CRD number too', () => {
  const s = startState({ name: 'Jane Roe', company: 'Acme' });
  s.findings = [
    rec({ title: 'Founder story', quote: 'Jane Roe, co-founder of Acme, previously worked at Credit Suisse.' }),
    rec({ source: 'finra-brokercheck', category: 'regulatory', match: 'possible', title: 'Jane Roe (CRD 1): no disclosures', quote: 'Jane Roe, CRD 1. Firms: Credit Suisse Securities (USA) LLC (2015 to 2017).' }),
  ];
  const leads = buildReport(s).profile.leads.map((l) => l.text);
  expect(leads.length).toBeGreaterThan(0);
  for (const t of leads) expect(t).not.toMatch(/CRD/);
});
