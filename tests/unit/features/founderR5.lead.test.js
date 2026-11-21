/**
 * @jest-environment node
 *
 * From the live report on Shensi Ding / Merge (2026-11-21): "Columbia University (2015)" and "Columbia" were two
 * education lines.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { createSubject } = require('../../../src/server/founder/identity');
const { makeFinding } = require('../../../src/server/founder/finding');
const { buildProfile } = require('../../../src/server/founder/profile');

const subject = () => createSubject({ name: 'Shensi Ding', company: 'Merge' });
const rec = (s, o) => makeFinding(s, { source: 'page-reader', sourceLabel: 'Bio and interview pages', category: 'career', url: `https://example.test/${encodeURIComponent(o.title)}`, ...o });

test('a bare "Columbia" beside one "Columbia University" is one school', () => {
  const s = subject();
  const findings = [
    rec(s, { title: 'Shensi Ding - Co-Founder & CEO, Merge', quote: 'Shensi Ding is the co-founder and CEO of Merge. Shensi Ding graduated from Columbia University in 2015.' }),
    rec(s, { title: 'Shensi Ding of Merge', quote: 'Shensi Ding is the co-founder and CEO of Merge. Shensi Ding studied computer science at Columbia.' }),
  ].filter(Boolean);
  const schools = buildProfile(s, findings, []).resume.education.map((e) => e.school);
  expect(schools.filter((x) => /Columbia/.test(x))).toEqual(['Columbia University']);
});

test('beside both a university and a college of that name, the bare name stays apart', () => {
  const s = subject();
  const findings = [
    rec(s, { title: 'Shensi Ding - Co-Founder & CEO, Merge', quote: 'Shensi Ding is the co-founder and CEO of Merge. Shensi Ding graduated from Boston University in 2015.' }),
    rec(s, { title: 'Shensi Ding of Merge, profile', quote: 'Shensi Ding is the co-founder and CEO of Merge. Shensi Ding graduated from Boston College in 2017.' }),
    rec(s, { title: 'Shensi Ding of Merge', quote: 'Shensi Ding is the co-founder and CEO of Merge. Shensi Ding studied economics at Boston.' }),
  ].filter(Boolean);
  const schools = buildProfile(s, findings, []).resume.education.map((e) => e.school);
  expect(schools).toEqual(expect.arrayContaining(['Boston University', 'Boston College']));
});
