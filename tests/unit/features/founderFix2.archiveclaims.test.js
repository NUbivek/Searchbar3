/**
 * Round 2 fixes in archiveClaims.js: role halves read into the wrong slots,
 * addresses read as employers, one generic word read as a school, and an
 * added degree-level word reported as a changed degree.
 */
const { extractClaims, compareClaims } = require('../../../src/server/founder/sources/archiveClaims');

const crunchbase2018 = (rows, schools = []) => `<html><head><title>Jane Roe - Crunchbase Person Profile</title></head><body>
<h1 class="profile-name">Jane Roe</h1>
<table><tr><th>Organization Name</th><th>Title At Company</th><th>Start Date</th><th>End Date</th></tr>
${rows.map(([org, title]) => `<tr><td>${org}</td><td>${title}</td><td>—</td><td>—</td></tr>`).join('\n')}
</table>
<phrase-list-card>Jane Roe studied at</phrase-list-card>
<image-list-card><ul>${schools.map((s) => `<li><a>${s}</a></li>`).join('')}</ul></image-list-card>
</body></html>`;
const URL = 'https://www.crunchbase.com/person/jane-roe';

describe('role parsing', () => {
  test('a title in the employer slot is swapped with the name in the title slot', () => {
    const c = extractClaims(crunchbase2018([['Co-Founder', 'Unlockd'], ['Solutions Architect Lead', 'Iris Data Services']]), URL);
    expect(c.roles).toEqual([
      { title: 'Co-Founder', org: 'Unlockd', dates: '' },
      { title: 'Solutions Architect Lead', org: 'Iris Data Services', dates: '' },
    ]);
  });

  test('a lone title with no other half is kept as a title, never as an employer', () => {
    const c = extractClaims(crunchbase2018([['Co-Founder', '']]), URL);
    expect(c.roles).toEqual([{ title: 'Co-Founder', org: '', dates: '' }]);
  });

  test('a right-way-round role, and an org that merely contains a job word, are left alone', () => {
    const c = extractClaims(crunchbase2018([['Acme Robotics', 'Founder & CEO'], ['Lead Edge Capital', 'Partner'], ['Lead Edge Capital', '']]), URL);
    expect(c.roles.map((r) => r.org)).toEqual(['Acme Robotics', 'Lead Edge Capital', 'Lead Edge Capital']);
  });

  test('an address in either slot goes to the links, not the roles', () => {
    const c = extractClaims(crunchbase2018([['linkedin.com/in/janeroe', ''], ['Acme', 'https://twitter.com/janeroe'], ['linkedin.com', 'Engineer'], ['Booking.com Group', 'Engineer']]), URL);
    expect(c.roles.map((r) => r.org)).toEqual(['Acme', 'Booking.com Group']);
    expect(c.roles.find((r) => r.org === 'Acme').title).toBe('');
    expect(c.roles.some((r) => /linkedin|twitter/i.test(`${r.org} ${r.title}`))).toBe(false);
    expect(c.links).toEqual(expect.arrayContaining(['https://linkedin.com/in/janeroe', 'https://twitter.com/janeroe']));
  });
});

describe('schools', () => {
  test('a single generic word is not a school; a one-word school name is', () => {
    const c = extractClaims(crunchbase2018([['Acme', 'CEO']], ['Business', 'Stanford', 'INSEAD']), URL);
    expect(c.education.map((e) => e.school)).toEqual(['Stanford', 'INSEAD']);
  });
});

describe('degree wording', () => {
  const v = (degree) => ({ format: 'crunchbase', headline: '', roles: [], education: [{ school: 'Baruch College', degree, dates: '' }] });

  test('an added level word is not a changed degree', () => {
    expect(compareClaims(v('Entrepreneurship'), v('Undergraduate, Entrepreneurship'))).toEqual([]);
    expect(compareClaims(v('Undergraduate, Entrepreneurship'), v('Entrepreneurship'))).toEqual([]);
  });

  test('reordered words are not a changed degree or title', () => {
    expect(compareClaims(v('Economics, BA'), v('BA, Economics'))).toEqual([]);
    const r = (title) => ({ format: 'crunchbase', roles: [{ title, org: 'Acme', dates: '' }], education: [] });
    expect(compareClaims(r('CEO & Co-Founder'), r('Co-Founder, CEO'))).toEqual([]);
  });

  test('a different level, or a different subject, is still a change', () => {
    expect(compareClaims(v('Undergraduate, Entrepreneurship'), v('Graduate, Entrepreneurship'))).toEqual([
      expect.objectContaining({ field: 'education', change: 'changed', severity: 'medium' }),
    ]);
    expect(compareClaims(v('Entrepreneurship'), v('Undergraduate, Finance'))).toEqual([
      expect.objectContaining({ field: 'education', change: 'changed', severity: 'medium' }),
    ]);
  });
});
