/**
 * @jest-environment node
 *
 * R3 (audit 2026-11-20), the web archive (archive.js, archiveClaims.js): a change is reported only when a claim
 * (title, employer, school, degree, dates) differs in text about the person; "Bachelor's degree" and "BS" are
 * the same degree; a degree added to or dropped from an unchanged school is a change; regional LinkedIn hosts
 * are one profile; builder placeholder text is never a record; a page's copies are one record.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

import { createSubject } from '../../../src/server/founder/identity';
import { compareClaims, extractClaims, bioClaimKeys, isPlaceholderText } from '../../../src/server/founder/sources/archiveClaims';
import { pageOf, describeChange, archiveConnector, __resetArchiveCacheForTests } from '../../../src/server/founder/sources/archive';
import { setTransport } from '../../../src/server/founder/http';

const v = (o = {}) => ({ format: 'linkedin', headline: '', roles: [], education: [], bioText: '', ...o });
const edu = (school, degree = '', dates = '') => ({ school, degree, dates });

describe('web-false-degree-change: one degree written two ways is not a change', () => {
  test('"Bachelor\'s degree" and "BS", "Master\'s degree" and "MS", both ways round', () => {
    const pairs = [
      ["Bachelor's degree, Chemical Engineering", 'BS, Chemical Engineering'],
      ["Master's degree, Computer Science", 'MS Computer Science'],
      ['Bachelor of Science (BS), Computer Science', "Bachelor's degree, Computer Science"],
    ];
    for (const [a, b] of pairs) {
      expect(compareClaims(v({ education: [edu('Stanford University', a)] }), v({ education: [edu('Stanford University', b)] }))).toEqual([]);
      expect(compareClaims(v({ education: [edu('Stanford University', b)] }), v({ education: [edu('Stanford University', a)] }))).toEqual([]);
    }
  });

  test('a real change of degree is still a change: BA to BS, Master\'s to MBA', () => {
    const ba = compareClaims(v({ education: [edu('Harvard University', 'BA, Economics')] }), v({ education: [edu('Harvard University', 'BS, Economics')] }));
    expect(ba).toEqual([expect.objectContaining({ field: 'education', change: 'changed', aspect: 'degree' })]);
    const mba = compareClaims(v({ education: [edu('Harvard University', "Master's degree")] }), v({ education: [edu('Harvard University', 'MBA')] }));
    expect(mba).toEqual([expect.objectContaining({ field: 'education', change: 'changed', aspect: 'degree' })]);
  });
});

describe('web-missed-degree-change: a degree added to or dropped from an unchanged school', () => {
  test('a doctorate that appears on an unchanged school: added, medium', () => {
    const d = compareClaims(v({ education: [edu('Stanford University')] }), v({ education: [edu('Stanford University', 'PhD, Chemistry')] }));
    expect(d).toEqual([expect.objectContaining({ field: 'education', change: 'added', aspect: 'degree', severity: 'medium', about: 'Stanford University', after: 'PhD, Chemistry, Stanford University' })]);
    expect(describeChange(d[0])).toBe('degree added to "Stanford University": now "PhD, Chemistry, Stanford University"');
  });

  test('a bachelor\'s degree that appears: added, low', () => {
    const d = compareClaims(v({ education: [edu('Columbia University')] }), v({ education: [edu('Columbia University', 'BS, Computer Science')] }));
    expect(d).toEqual([expect.objectContaining({ change: 'added', aspect: 'degree', severity: 'low' })]);
  });

  test('a degree dropped: reported (low) only when the newer copy shows degrees for other schools', () => {
    const shown = compareClaims(
      v({ education: [edu('Stanford University', 'BS, Chemical Engineering'), edu('Harvard University', 'MBA')] }),
      v({ education: [edu('Stanford University'), edu('Harvard University', 'MBA')] }),
    );
    expect(shown).toEqual([expect.objectContaining({ field: 'education', change: 'removed', aspect: 'degree', severity: 'low' })]);
    // a view that hides every degree says nothing
    const hidden = compareClaims(v({ education: [edu('Stanford University', 'BS, Chemical Engineering')] }), v({ education: [edu('Stanford University')] }));
    expect(hidden).toEqual([]);
  });

  test('role titles keep their silence: a title that appears on an unchanged employer is not a change', () => {
    expect(compareClaims(v({ roles: [{ title: '', org: 'Acme', dates: '' }] }), v({ roles: [{ title: 'CEO', org: 'Acme', dates: '' }] }))).toEqual([]);
  });
});

describe('claims that changed: only a claim in text about the person', () => {
  test('marketing copy rewritten with the same claims is not a change (merge.dev about page)', () => {
    const d = compareClaims(
      v({ format: 'page', bioText: 'Shensi Ding and her co-founder are former college classmates and current best friends.' }),
      v({ format: 'page', bioText: 'Shensi Ding and her co-founder turned their shared frustration into innovation.' }),
    );
    expect(d).toEqual([]);
  });

  test('a bio whose claims differ is a change (an earlier venture gone, a degree added)', () => {
    const d = compareClaims(
      v({ format: 'page', bioText: 'Eric is the co-founder and CEO of Ramp. He previously co-founded Paribus (acq. in 2016 by Capital One).' }),
      v({ format: 'page', bioText: 'Eric is the co-founder and CEO of Ramp. BA in Economics, Harvard University.' }),
    );
    expect(d).toEqual([expect.objectContaining({ field: 'bio', change: 'changed' })]);
    expect([...bioClaimKeys('He previously co-founded Paribus in 2014.')]).toEqual(expect.arrayContaining(['y:2014', 'n:paribus']));
  });
});

describe('web-linkedin-regional-host', () => {
  test('fr.linkedin.com and uk.linkedin.com are the same profile as linkedin.com', () => {
    expect(pageOf('https://fr.linkedin.com/in/arthurmensch')).toBe('linkedin.com/in/arthurmensch');
    expect(pageOf('https://uk.linkedin.com/in/arthurmensch/')).toBe('linkedin.com/in/arthurmensch');
    expect(pageOf('https://www.linkedin.com/in/arthurmensch?trk=x')).toBe('linkedin.com/in/arthurmensch');
  });
});

describe('noise: builder placeholder text and copies that repeat each other', () => {
  test('"This is some text inside of a div block." is never a title or a bio', () => {
    expect(isPlaceholderText('This is some text inside of a div block.')).toBe(true);
    const html = '<html><head><title>Accel</title></head><body><h2>Shensi Ding</h2><p>This is some text inside of a div block.</p><div>This is some text inside of a div block. This is some text inside of a div block. This is some text inside of a div block.</div></body></html>';
    const c = extractClaims(html, 'https://www.accel.com/relationships/merge', { person: createSubject({ name: 'Shensi Ding', company: 'Merge' }).hasName });
    expect(c.headline).toBe('');
    expect(c.bioText).toBe('');
  });

  test('an archived page whose copies say only placeholder text gives no record', async () => {
    __resetArchiveCacheForTests();
    const subject = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const page = '<html><head><title>Accel</title></head><body><h2>Shensi Ding</h2><p>This is some text inside of a div block.</p></body></html>';
    setTransport(async (url) => {
      if (url.includes('/cdx/search/cdx')) return { status: 200, headers: new Map(), url, text: async () => JSON.stringify([['timestamp', 'endtimestamp', 'original', 'digest', 'length', 'groupcount'], ['20230101000000', '20230101000000', 'https://www.accel.com/relationships/merge', 'A', '5000', '1'], ['20240101000000', '20240101000000', 'https://www.accel.com/relationships/merge', 'B', '5000', '1']]) };
      return { status: 200, headers: new Map([['content-type', 'text/html']]), url, text: async () => page };
    });
    try {
      const out = await archiveConnector.run({ kind: 'url', value: 'https://www.accel.com/relationships/merge', depth: 1 }, { subject, deadline: Date.now() + 20000 });
      expect(out.findings).toEqual([]);
      expect(out.notes.join(' ')).toMatch(/name Shensi Ding but say nothing else/);
    } finally { setTransport(); }
  });
});
