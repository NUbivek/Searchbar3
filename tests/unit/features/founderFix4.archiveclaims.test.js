/**
 * Round 4 fixes in archiveClaims.js: a signed-out LinkedIn copy carried the
 * "see more" button and sign-in form text in the bio, and JSON-LD roles with
 * the same start and end month ("2023-05 - 2023-05") could be read as moved dates.
 */
const { extractClaims, compareClaims } = require('../../../src/server/founder/sources/archiveClaims');

const LI = 'https://www.linkedin.com/in/jane-roe';
const liPage = (summary, ld = '') => `<html><head><title>Jane Roe - Acme Robotics | LinkedIn</title>${ld}</head><body>
<h1 class="top-card-layout__title">Jane Roe</h1>
<h2 class="top-card-layout__headline">Founder at Acme Robotics</h2>
<section class="summary"><div class="core-section-container__content">${summary}</div></section>
</body></html>`;

describe('bio text without page furniture', () => {
  test('the bio stops at the "see more" button', () => {
    const c = extractClaims(liPage('Jane Roe built warehouse robots for ten years. See more Welcome back Email or phone Password Forgot password? Sign in'), LI);
    expect(c.bioText).toBe('Jane Roe built warehouse robots for ten years.');
  });

  test('the button in other languages is cut too', () => {
    const c = extractClaims(liPage('Fondatrice d’Acme Robotics depuis 2015. Voir plus Te damos la bienvenida'), LI);
    expect(c.bioText).toBe('Fondatrice d’Acme Robotics depuis 2015.');
  });

  test('sign-in form sentences are dropped wherever they sit', () => {
    const c = extractClaims(liPage('Welcome back. Jane Roe leads robotics research at Acme Robotics. By clicking Continue you agree to the User Agreement. She studied mechanical engineering.'), LI);
    expect(c.bioText).toBe('Jane Roe leads robotics research at Acme Robotics. She studied mechanical engineering.');
  });

  test('a bio that only mentions seeing more is not cut mid-word', () => {
    const c = extractClaims(liPage('Jane Roe wants to oversee moreover the robotics team.'), LI);
    expect(c.bioText).toBe('Jane Roe wants to oversee moreover the robotics team.');
  });
});

describe('JSON-LD roles with a placeholder date', () => {
  const ld = (start, end) => `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Person',
    name: 'Jane Roe',
    worksFor: [{ '@type': 'Organization', name: 'Acme Robotics', member: { startDate: start, endDate: end } }],
  })}</script>`;
  const bare = (block) => `<html><head><title>Jane Roe | LinkedIn</title>${block}</head><body><h1 class="top-card-layout__title">Jane Roe</h1></body></html>`;

  test('the same start and end month is dropped', () => {
    const c = extractClaims(bare(ld('2023-05', '2023-05')), LI);
    expect(c.roles).toEqual([{ title: '', org: 'Acme Robotics', dates: '' }]);
  });

  test('a real range is kept', () => {
    const c = extractClaims(bare(ld('2019-01', '2023-05')), LI);
    expect(c.roles[0].dates).toBe('2019-01 - 2023-05');
  });

  test('no "dates changed" finding comes from the placeholder', () => {
    const older = extractClaims(bare(ld('2021-03', '2021-03')), LI);
    const newer = extractClaims(bare(ld('2023-05', '2023-05')), LI);
    expect(compareClaims(older, newer).filter((d) => d.aspect === 'dates')).toEqual([]);
  });
});
