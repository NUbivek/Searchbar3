/**
 * Fixes in archiveClaims.js: a profile reader that found a name line but no
 * other content must not hand the page to someone named only in a sidebar.
 */
const { extractClaims } = require('../../../src/server/founder/sources/archiveClaims');
const { createSubject } = require('../../../src/server/founder/identity');

const SIDEBAR = `<html><head><title>Jane Doe | LinkedIn</title></head><body>
<h1 class="top-card-layout__title">Jane Doe</h1>
<p>Some text about the page.</p>
<aside><h2>People also viewed</h2><div>Patrick Collison<br>
CEO at Stripe</div></aside>
</body></html>`;

describe('a profile whose name line is someone else', () => {
  test('a sidebar mention does not make the page the person\'s, nor lend its headline', () => {
    const subject = createSubject({ name: 'Patrick Collison' });
    const c = extractClaims(SIDEBAR, 'https://www.linkedin.com/in/janedoe', { person: subject.hasName });
    expect(c.name).toBe('Jane Doe');
    expect(c.named).toBe(false);
    expect(c.headline).toBe('');
    expect(JSON.stringify(c)).not.toMatch(/Stripe/);
  });

  test('the same with a plain name', () => {
    const c = extractClaims(SIDEBAR, 'https://www.linkedin.com/in/janedoe', { person: 'Patrick Collison' });
    expect(c.named).toBe(false);
    expect(c.headline).toBe('');
  });

  test('when the name line is the person\'s, the text beside it is still read and the name line decides', () => {
    const subject = createSubject({ name: 'Jane Doe' });
    const html = SIDEBAR.replace('<p>Some text about the page.</p>', '<div>Jane Doe<br>\nFounder at Acme Robotics</div>');
    const c = extractClaims(html, 'https://www.linkedin.com/in/janedoe', { person: subject.hasName });
    expect(c.name).toBe('Jane Doe');
    expect(c.named).toBe(null);
  });
});
