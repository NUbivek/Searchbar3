/**
 * Round 3 fix in archiveClaims.js: on the 2008-2014 Crunchbase layout, a link
 * label under "Web Presence" ("LinkedIn") was read as an employer.
 */
const { extractClaims, isWebPresenceLabel } = require('../../../src/server/founder/sources/archiveClaims');

const URL = 'http://www.crunchbase.com/person/jane-roe';
const cbOld = (entries) => `<html><body><div id="col2_internal"><h1 class="h1_first">Jane Roe</h1>
<p>Jane Roe founded Acme Robotics.</p></div>
${entries}
</body></html>`;

describe('2008-2014 Crunchbase roles', () => {
  test('a web-presence link with no title of its own is not an employer', () => {
    const c = extractClaims(cbOld(`<div class="col1_content"><span class="col1_people_name">Acme Robotics</span><span class="col1_people_title">Founder, CEO</span></div>
<h2>Web Presence</h2><div class="col1_content"><span class="col1_people_name">LinkedIn</span><span class="col1_people_name">Blog</span></div>`), URL);
    expect(c.roles).toEqual([{ title: 'Founder, CEO', org: 'Acme Robotics', dates: '' }]);
  });

  test('a bare name never borrows the title of the entry after it', () => {
    const c = extractClaims(cbOld(`<div class="col1_content"><span class="col1_people_name">LinkedIn</span>
<span class="col1_people_name">Acme Robotics</span><span class="col1_people_title">Founder</span></div>`), URL);
    expect(c.roles).toEqual([{ title: 'Founder', org: 'Acme Robotics', dates: '' }]);
  });

  test('a web-presence label with a non-role line beside it is dropped', () => {
    const c = extractClaims(cbOld(`<div class="col1_content"><span class="col1_people_name">Website</span><span class="col1_people_title">acmerobotics example</span></div>
<div class="col1_content"><span class="col1_people_name">Acme Robotics</span><span class="col1_people_title">Founder</span></div>`), URL);
    expect(c.roles.map((r) => r.org)).toEqual(['Acme Robotics']);
  });

  test('a real role at a company with such a name is kept', () => {
    const c = extractClaims(cbOld('<div class="col1_content"><span class="col1_people_name">Twitter</span><span class="col1_people_title">Software Engineer</span></div>'), URL);
    expect(c.roles).toEqual([{ title: 'Software Engineer', org: 'Twitter', dates: '' }]);
  });
});

describe('isWebPresenceLabel', () => {
  test.each(['LinkedIn', 'Linked In', 'Twitter', 'Facebook', 'Blog', 'Website', 'Web site', 'AngelList', 'GitHub', 'Homepage', 'Personal website', 'LinkedIn profile'])('%s is a link label', (s) => {
    expect(isWebPresenceLabel(s)).toBe(true);
  });
  test.each(['Acme Robotics', 'LinkedIn Corporation', 'Blogger Media Group', 'GitHub Inc', ''])('%s is not', (s) => {
    expect(isWebPresenceLabel(s)).toBe(false);
  });
});
