/**
 * @jest-environment node
 *
 * R4 (review 2026-11-21), the web archive (archive.js, archiveClaims.js): a short bio on a team page does not
 * absorb the next person's (web-team-bio-bleed); a bio under the person's own name line that says "she" is
 * still compared (web-bio-pronoun-dropped); spellings of one degree are not a change (web-degree-false-change);
 * a degree hidden on an older masked copy is not "added" (web-masked-older-degree-added).
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

import { createSubject } from '../../../src/server/founder/identity';
import { compareClaims, extractClaims } from '../../../src/server/founder/sources/archiveClaims';
import { archiveConnector, __resetArchiveCacheForTests } from '../../../src/server/founder/sources/archive';
import { setTransport } from '../../../src/server/founder/http';

const v = (o = {}) => ({ format: 'linkedin', headline: '', roles: [], education: [], bioText: '', ...o });
const edu = (school, degree = '', dates = '') => ({ school, degree, dates });

const JANE_BIO = 'Jane Roe started Acme after years of building payment systems for small shops worldwide today.';
const BOB_BIO = 'Bob builds things and has done so for many many years at several large companies, and he holds a PhD.';
const team = (janeBio) => `<html><head><title>Team - Acme</title></head><body><h1>Our team</h1>
<h3>Jane Roe</h3><p>Co-founder &amp; CEO</p><p>${janeBio}</p>
<h3>Bob Lee</h3><p>CTO</p><p>${BOB_BIO}</p></body></html>`;

describe('web-team-bio-bleed', () => {
  test('a short bio stops at the next person\'s name and title', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const c = extractClaims(team(JANE_BIO), 'https://acme.example.com/team', { person: s.hasName });
    expect(c.headline).toMatch(/Co-founder/);
    expect(c.bioText).toContain('payment systems');
    expect(c.bioText).not.toMatch(/Bob|PhD/);
  });

  test('a name-like line after a paragraph ends the bio even without a title under it', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const html = `<html><body><h3>Jane Roe</h3><p>Founder</p><p>${JANE_BIO}</p><h3>Bob Lee</h3><p>${BOB_BIO}</p></body></html>`;
    expect(extractClaims(html, 'https://acme.example.com/team', { person: s.hasName }).bioText).not.toMatch(/Bob/);
  });

  test('a long bio over several paragraphs is still read whole', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const html = `<html><body><h3>Jane Roe</h3><p>Founder</p><p>${JANE_BIO}</p><p>Before Acme she spent six years at Stripe leading the risk team in Dublin and San Francisco.</p></body></html>`;
    const c = extractClaims(html, 'https://acme.example.com/team', { person: s.hasName });
    expect(c.bioText).toMatch(/Stripe/);
    expect(c.bioAnchored).toBe(true);
  });
});

describe('web-degree-false-change', () => {
  const same = [
    ['AB, Economics', 'A.B., Economics'],
    ['Juris Doctor (J.D.)', 'JD'],
    ['Bachelor of Engineering (B.Eng.), Mechanical', 'BEng, Mechanical Engineering'],
    ["Bachelor's degree", 'BA, Economics'],
    ['Master of Business Administration - MBA', 'MBA, Finance'],
    ['M.Phil., History', 'MPhil, History'],
  ];
  test.each(same)('"%s" and "%s" are one degree, both ways round', (a, b) => {
    expect(compareClaims(v({ education: [edu('Harvard University', a)] }), v({ education: [edu('Harvard University', b)] }))).toEqual([]);
    expect(compareClaims(v({ education: [edu('Harvard University', b)] }), v({ education: [edu('Harvard University', a)] }))).toEqual([]);
  });

  test('real changes stay changes', () => {
    const pairs = [
      ['BA, Economics', 'BS, Economics'],
      ["Master's degree", 'MBA'],
      ['BS, Computer Science', 'BS, Computer Engineering'],
      ['JD', 'MD'],
      ['MBA, Finance', 'MBA, Marketing'],
      ['Economics', 'PhD, Economics'],
    ];
    for (const [a, b] of pairs) {
      const d = compareClaims(v({ education: [edu('Harvard University', a)] }), v({ education: [edu('Harvard University', b)] }));
      expect(d.length).toBeGreaterThan(0);
    }
  });

  test('a titled role is not changed by letter-collapsing', () => {
    expect(compareClaims(v({ roles: [{ title: 'VP, R&D', org: 'Acme', dates: '' }] }), v({ roles: [{ title: 'Vice President, R & D', org: 'Acme', dates: '' }] }))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ through the archive connector */

const PAGE = 'https://acme.example.com/team';
async function runArchive(subject, copies) {
  __resetArchiveCacheForTests();
  const stamps = Object.keys(copies);
  setTransport(async (url) => {
    if (url.includes('/cdx/search/cdx')) {
      return { status: 200, headers: new Map(), url, text: async () => JSON.stringify([['timestamp', 'endtimestamp', 'original', 'digest', 'length', 'groupcount'], ...stamps.map((ts, i) => [ts, ts, PAGE, `D${i}`, '5000', '1'])]) };
    }
    const ts = stamps.find((t) => url.includes(`/web/${t}`));
    return { status: 200, headers: new Map([['content-type', 'text/html']]), url, text: async () => copies[ts] || '' };
  });
  try {
    return await archiveConnector.run({ kind: 'url', value: PAGE, depth: 1 }, { subject, deadline: Date.now() + 20000 });
  } finally { setTransport(); }
}

describe('web-bio-pronoun-dropped', () => {
  test('a bio under the person\'s own name that says "she" is compared, and a real change is reported', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const page = (bio) => `<html><head><title>Team - Acme</title></head><body><h3>Jane Roe</h3><p>Co-founder &amp; CEO, Acme</p><p>${bio}</p></body></html>`;
    const out = await runArchive(s, {
      20220101000000: page('She is a former Goldman Sachs banker who holds an MBA from Wharton and spent a decade in New York.'),
      20240101000000: page('Before co-founding Acme, she spent six years leading the payments team at Stripe in Dublin and London.'),
    });
    const bio = out.findings.filter((f) => f.data?.kind === 'change' && f.data.field === 'bio');
    expect(bio.length).toBe(1);
  });
});

describe('web-masked-older-degree-added', () => {
  const li = (degree) => `<html><head><title>Jane Roe - Acme | LinkedIn</title></head><body>
<h1 class="top-card-layout__title">Jane Roe</h1><h2 class="top-card-layout__headline">CEO at Acme</h2>
<ul><li class="experience-item"><h3 class="experience-item__title">CEO</h3><h4 class="experience-item__subtitle">Acme</h4><p class="date-range">Jan 2019 - Present</p></li></ul>
<ul><li class="education__list-item"><h3 class="profile-section-card__title">Stanford University</h3><h4 class="profile-section-card__subtitle">${degree}</h4></li></ul>
</body></html>`;

  test('the masked older copy is marked masked and shows no degree', () => {
    const c = extractClaims(li('****** *********'), 'https://www.linkedin.com/in/jane-roe-acme');
    expect(c.masked).toBe(true);
    expect(c.education[0]).toMatchObject({ school: 'Stanford University', degree: '' });
  });

  test('a degree hidden on the older masked copy is not reported as added on the next copy', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const page = 'https://www.linkedin.com/in/jane-roe-acme';
    __resetArchiveCacheForTests();
    const copies = { 20230101000000: li('****** *********'), 20240101000000: li('PhD, Chemistry') };
    const stamps = Object.keys(copies);
    setTransport(async (url) => {
      if (url.includes('/cdx/search/cdx')) return { status: 200, headers: new Map(), url, text: async () => JSON.stringify([['timestamp', 'endtimestamp', 'original', 'digest', 'length', 'groupcount'], ...stamps.map((ts, i) => [ts, ts, page, `D${i}`, '5000', '1'])]) };
      const ts = stamps.find((t) => url.includes(`/web/${t}`));
      return { status: 200, headers: new Map([['content-type', 'text/html']]), url, text: async () => copies[ts] || '' };
    });
    let out;
    try { out = await archiveConnector.run({ kind: 'url', value: page, depth: 1 }, { subject: s, deadline: Date.now() + 20000 }); } finally { setTransport(); }
    expect(out.findings.length).toBeGreaterThan(0); // the copies were read
    const added = out.findings.filter((f) => f.data?.kind === 'change' && f.data.field === 'education' && f.data.change === 'added');
    expect(added).toEqual([]);
  });

  test('two unmasked copies still report the degree added', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const page = 'https://www.linkedin.com/in/jane-roe-acme';
    __resetArchiveCacheForTests();
    const plain = li('').replace(/<h4 class="profile-section-card__subtitle"><\/h4>/, '');
    const copies = { 20230101000000: plain, 20240101000000: li('PhD, Chemistry') };
    const stamps = Object.keys(copies);
    setTransport(async (url) => {
      if (url.includes('/cdx/search/cdx')) return { status: 200, headers: new Map(), url, text: async () => JSON.stringify([['timestamp', 'endtimestamp', 'original', 'digest', 'length', 'groupcount'], ...stamps.map((ts, i) => [ts, ts, page, `D${i}`, '5000', '1'])]) };
      const ts = stamps.find((t) => url.includes(`/web/${t}`));
      return { status: 200, headers: new Map([['content-type', 'text/html']]), url, text: async () => copies[ts] || '' };
    });
    let out;
    try { out = await archiveConnector.run({ kind: 'url', value: page, depth: 1 }, { subject: s, deadline: Date.now() + 20000 }); } finally { setTransport(); }
    const added = out.findings.filter((f) => f.data?.kind === 'change' && f.data.field === 'education' && f.data.change === 'added');
    expect(added.length).toBe(1);
  });
});
