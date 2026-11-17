/**
 * Reading claims from saved copies of profile pages and comparing two copies
 * (pure functions, no network). Fixtures are cut down from real archived
 * pages: LinkedIn (2010 hresume, 2019+ public profile, 2024+ masked JSON-LD),
 * Crunchbase (2010 and 2018+), AngelList 2016, Indeed, and a team page.
 */
const {
  extractClaims, compareClaims, claimsSignature, claimsQuote, claimsHeadline, sameOrg, orgKey, looksLikeTitle,
} = require('../../../src/server/founder/sources/archiveClaims');

/* ------------------------------------------------------------- fixtures */

const LI_2010 = `<html><head><title>adam neumann - LinkedIn</title></head><body>
<div class="hresume">
 <h1 id="name"><span class="fn">adam neumann</span></h1>
 <div id="headline"><p class="title">Founder at WeWork</p><p class="locality">Greater New York City Area</p></div>
 <div id="experience"><ul>
  <li class="experience"><h3 class="title">Co-Founder &amp; CEO</h3><h4 class="org">WeWork</h4><p class="period"><abbr class="dtstart">2010</abbr> – <abbr class="dtend">Present</abbr> <span class="duration">(1 year)</span></p></li>
  <li class="experience"><h3 class="title">Founder</h3><h4 class="org">Krawlers</h4><p class="period">2005 – 2008</p></li>
 </ul></div>
 <div id="education"><ul>
  <li class="education"><h3 class="org">Baruch College</h3><span class="degree">BA</span>, <span class="major">Business</span><p class="period">2002 – 2006</p></li>
 </ul></div>
 <div id="summary"><p class="summary">Building communities. Call me at (212) 555-0199 or adam.private@example.com.</p></div>
</div></body></html>`;

const LI_2023 = `<html><head><title>Patrick Collison - Stripe | LinkedIn</title>
<script type="application/ld+json">{"@context":"http://schema.org","@graph":[{"@type":"Person","name":"Patrick Collison","jobTitle":["CEO"],"worksFor":[{"@type":"Organization","name":"Stripe"}],"alumniOf":[{"@type":"EducationalOrganization","name":"Massachusetts Institute of Technology"}],"address":{"@type":"PostalAddress","addressLocality":"San Francisco"}}]}</script>
</head><body>
<h1 class="top-card-layout__title">Patrick Collison</h1>
<h2 class="top-card-layout__headline">CEO at Stripe</h2>
<h3 class="top-card__subline-item">San Francisco, California, United States</h3>
<ul>
 <li class="experience-item"><h3 class="experience-item__title">CEO</h3><h4 class="experience-item__subtitle">Stripe</h4><p class="date-range">Jan 2010 - Present <span class="date-range__duration">13 years 3 months</span></p></li>
 <li class="experience-item"><h3 class="experience-item__title">Cofounder</h3><h4 class="experience-item__subtitle">Auctomatic</h4><p class="date-range">2007 - 2008 <span class="date-range__duration">1 year</span></p></li>
</ul>
<ul><li class="education__list-item"><h3 class="profile-section-card__title">Massachusetts Institute of Technology</h3><h4 class="profile-section-card__subtitle">BS, Mathematics</h4></li></ul>
</body></html>`;

const LI_MASKED = `<html><head><title>Patrick Collison - Stripe | LinkedIn</title>
<script type="application/ld+json">{"@context":"http://schema.org","@graph":[{"@type":"Person","name":"Patrick Collison","jobTitle":["******* **********","*********"],"worksFor":[{"@type":"Organization","name":"Stripe","member":{"@type":"OrganizationRole","description":"* ** **** *******."}},{"@type":"Organization","name":"**********"}],"alumniOf":[{"@type":"EducationalOrganization","name":"Massachusetts Institute of Technology"}]}]}</script>
</head><body><h1 class="top-card-layout__title">Patrick Collison</h1></body></html>`;

const LI_WALL = `<html><head><title>Sign Up | LinkedIn</title></head><body><form action="/authwall"><h1>Join LinkedIn</h1></form></body></html>`;

const CB_2010 = `<html><body><div id="col2_internal"><h1 class="h1_first">Elizabeth Holmes</h1>
<p>Elizabeth Holmes founded Theranos in 2003.</p></div>
<div class="col1_content"><span class="col1_people_name">Theranos</span><span class="col1_people_title">Founder, CEO</span></div>
<h2>Degrees</h2><div class="col1_content"><table><tr><td>Chemical Engineering</td><td>Stanford University</td></tr></table></div>
</body></html>`;

const CB_2019 = `<html><head><meta property="og:title" content="Elizabeth Holmes - Crunchbase Person Profile"></head><body>
<h1 class="profile-name">Elizabeth Holmes</h1>
<table><tr><th>Organization Name</th><th>Title At Company</th><th>Start Date</th><th>End Date</th></tr>
<tr><td>Theranos</td><td>Founder, Chairman &amp; Chief Executive Officer</td><td>2003</td><td>Jun 2018</td></tr></table>
<description-card><p>Elizabeth Holmes was the CEO of Theranos.</p></description-card>
</body></html>`;

const ANGEL_2016 = `<html><head><meta property="og:title" content="Adam Neumann - AngelList"><meta property="og:description" content="Adam Neumann | Co-founder &amp; CEO at WeWork"></head><body>
<h1 class="js-name">Adam Neumann</h1>
<div class="experience_container"><div class="feature"><a class="startup-link" title="WeWork" href="/wework">WeWork</a><div class="line"><span class="medium-font">Founder</span></div><span class="metadata-string">2010 – Present</span></div></div>
<div class="education"><div class="college-row"><a href="/baruch">Baruch College</a></div></div>
<a rel="me" href="http://www.linkedin.com/pub/adam-neumann/7/2a/111">LinkedIn</a>
</body></html>`;

const INDEED = `<html><body><div id="resume-contact">Jane Q Roe</div><div id="contact_info_container"><p>Austin, TX</p><p>jane.roe@example.com</p></div>
<div id="headline">Product Manager</div>
<div id="res_summary">Product lead. Phone 512-555-0142.</div>
<div class="work-experience-section"><p class="work_title">Product Manager</p><div class="work_company"><span class="bold">Acme Robotics</span></div><p class="work_dates">March 2014 to Present</p></div>
<div class="education-section"><p class="edu_title">MBA</p><div class="edu_school"><span class="bold">Stanford University</span></div><p class="edu_dates">2010 to 2012</p></div>
</body></html>`;

const TEAM = `<html><head><title>Leadership - Theranos</title></head><body>
<h2>Leadership</h2>
<p>Sunny Balwani</p><p>President and COO</p><p>Sunny joined Theranos in 2009 after a career in software at large companies around the world.</p>
<p>Elizabeth Holmes</p><p>Founder and CEO</p><p>Elizabeth founded Theranos in 2003 after studying chemical engineering at Stanford and leaving to build the company.</p>
</body></html>`;

/* ------------------------------------------------------------- extractClaims */

describe('extractClaims', () => {
  test('2010 LinkedIn (hresume): name, roles, education; job lengths, location and contact details are dropped', () => {
    const c = extractClaims(LI_2010, 'https://web.archive.org/web/20110101000000id_/http://www.linkedin.com/in/adamneumann');
    expect(c.format).toBe('linkedin');
    expect(c.name).toBe('adam neumann');
    expect(c.roles[0]).toEqual({ title: 'Co-Founder & CEO', org: 'WeWork', dates: '2010 – Present' });
    expect(c.roles[1].org).toBe('Krawlers');
    expect(c.education[0]).toMatchObject({ school: 'Baruch College', degree: 'BA, Business' });
    const all = JSON.stringify(c);
    expect(all).not.toMatch(/Greater New York/);
    expect(all).not.toMatch(/555-0199|adam\.private@example\.com/);
    expect(c).not.toHaveProperty('location');
  });

  test('2019+ LinkedIn: visible roles and education, no location', () => {
    const c = extractClaims(LI_2023, 'linkedin.com/in/patrickcollison');
    expect(c.name).toBe('Patrick Collison');
    expect(c.headline).toBe('CEO at Stripe');
    expect(c.roles).toEqual([{ title: 'CEO', org: 'Stripe', dates: 'Jan 2010 - Present' }, { title: 'Cofounder', org: 'Auctomatic', dates: '2007 - 2008' }]);
    expect(c.education[0]).toMatchObject({ school: 'Massachusetts Institute of Technology', degree: 'BS, Mathematics' });
    expect(JSON.stringify(c)).not.toMatch(/San Francisco/);
    expect(c.masked).toBeUndefined();
  });

  test('LinkedIn lines hidden behind asterisks are dropped and the copy is marked masked', () => {
    const c = extractClaims(LI_MASKED, 'https://www.linkedin.com/in/patrickcollison/');
    expect(c.masked).toBe(true);
    expect(c.roles).toEqual([{ title: '', org: 'Stripe', dates: '' }]);
    expect(JSON.stringify(c)).not.toMatch(/\*\*/);
  });

  test('a LinkedIn sign-in wall is marked blocked', () => {
    const c = extractClaims(LI_WALL, 'linkedin.com/in/someone');
    expect(c.blocked).toBe('sign-in wall');
    expect(c.roles).toEqual([]);
  });

  test('Crunchbase, old (2010) and new (2018+) layouts', () => {
    const old = extractClaims(CB_2010, 'http://www.crunchbase.com/person/elizabeth-holmes');
    expect(old).toMatchObject({ name: 'Elizabeth Holmes', format: 'crunchbase' });
    expect(old.roles).toEqual([{ title: 'Founder, CEO', org: 'Theranos', dates: '' }]);
    expect(old.education).toEqual([{ school: 'Stanford University', degree: 'Chemical Engineering', dates: '' }]);
    const neu = extractClaims(CB_2019, 'https://www.crunchbase.com/person/elizabeth-holmes');
    expect(neu.roles).toEqual([{ title: 'Founder, Chairman & Chief Executive Officer', org: 'Theranos', dates: '2003 - Jun 2018' }]);
    expect(neu.bioText).toMatch(/CEO of Theranos/);
  });

  test('AngelList 2016: role, school, headline and the LinkedIn address it links to', () => {
    const c = extractClaims(ANGEL_2016, 'https://angel.co/adam-neumann');
    expect(c).toMatchObject({ name: 'Adam Neumann', format: 'angellist', headline: 'Co-founder & CEO at WeWork' });
    expect(c.roles[0]).toMatchObject({ title: 'Founder', org: 'WeWork' });
    expect(c.education[0].school).toBe('Baruch College');
    expect(c.links).toContain('http://www.linkedin.com/pub/adam-neumann/7/2a/111');
  });

  test('Indeed resume: roles and education, never contact details or home town', () => {
    const c = extractClaims(INDEED, 'https://www.indeed.com/r/Jane-Roe/abc123');
    expect(c.format).toBe('indeed');
    expect(c.roles[0]).toEqual({ title: 'Product Manager', org: 'Acme Robotics', dates: 'March 2014 to Present' });
    expect(c.education[0]).toMatchObject({ school: 'Stanford University', degree: 'MBA' });
    const all = JSON.stringify(c);
    expect(all).not.toMatch(/jane\.roe@example\.com|512-555-0142|Austin/);
  });

  test('a team page: the title beside the person\'s name and their paragraph, not a neighbour\'s', () => {
    const c = extractClaims(TEAM, 'http://www.theranos.com/leadership', { person: 'Elizabeth Holmes' });
    expect(c.format).toBe('page');
    expect(c.named).toBe(true);
    expect(c.headline).toBe('Founder and CEO');
    expect(c.bioText).toMatch(/founded Theranos in 2003/);
    expect(c.bioText).not.toMatch(/Sunny/);
    const absent = extractClaims(TEAM, 'http://www.theranos.com/leadership', { person: 'Jane Roe' });
    expect(absent.named).toBe(false);
  });
});

/* ------------------------------------------------------------- compareClaims */

const v = (over) => ({ headline: '', roles: [], education: [], bioText: '', format: 'linkedin', ...over });

describe('compareClaims', () => {
  test('trivial differences are ignored: case, punctuation, word order, "Inc", spelled-out titles, job lengths', () => {
    const a = v({ headline: 'Founder & CEO, Theranos', roles: [{ title: 'Founder, CEO', org: 'Theranos, Inc.', dates: '2003 - Present' }], education: [{ school: 'Stanford University', degree: 'B.S.', dates: '' }] });
    const b = v({ headline: 'founder and ceo theranos', roles: [{ title: 'Chief Executive Officer and Founder', org: 'theranos', dates: '2003 – Present' }], education: [{ school: 'stanford university', degree: 'BS', dates: '' }] });
    expect(compareClaims(a, b)).toEqual([]);
    expect(claimsSignature(a)).toBe(claimsSignature(b));
  });

  test('a degree that changed is medium', () => {
    const d = compareClaims(v({ education: [{ school: 'Stanford University', degree: 'MBA', dates: '' }] }), v({ education: [{ school: 'Stanford University', degree: 'Executive Program', dates: '' }] }));
    expect(d).toEqual([expect.objectContaining({ field: 'education', change: 'changed', before: 'MBA, Stanford University', after: 'Executive Program, Stanford University', severity: 'medium' })]);
  });

  test('a school that disappears is medium; a reworded school name is the same school', () => {
    const older = v({ headline: 'x', education: [{ school: 'Harvard University', degree: 'BA', dates: '' }, { school: 'Stanford University', degree: 'BS', dates: '' }] });
    const newer = v({ headline: 'x', education: [{ school: 'The School of Engineering at Stanford University', degree: 'BS', dates: '' }] });
    const d = compareClaims(older, newer);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ field: 'education', change: 'removed', before: 'BA, Harvard University', severity: 'medium' });
  });

  test('retitled roles: Intern -> Engineer and Advisor -> Co-founder are medium; an employer that disappears is medium', () => {
    const older = v({ roles: [{ title: 'Software Intern', org: 'Google', dates: '' }, { title: 'Advisor', org: 'Acme', dates: '' }, { title: 'Analyst', org: 'Lehman Brothers', dates: '' }] });
    const newer = v({ roles: [{ title: 'Software Engineer', org: 'Google', dates: '' }, { title: 'Co-founder', org: 'Acme', dates: '' }] });
    const d = compareClaims(older, newer);
    const by = (org) => d.find((x) => x.before.includes(org));
    expect(by('Google')).toMatchObject({ field: 'role', change: 'changed', after: 'Software Engineer, Google', severity: 'medium' });
    expect(by('Acme')).toMatchObject({ change: 'changed', after: 'Co-founder, Acme', severity: 'medium' });
    expect(by('Lehman')).toMatchObject({ change: 'removed', after: '', severity: 'medium' });
  });

  test('a reworded title of the same standing is low; added roles are info', () => {
    const d = compareClaims(v({ roles: [{ title: 'Founder, CEO', org: 'Theranos', dates: '' }] }), v({ roles: [{ title: 'Founder, Chairman & CEO', org: 'Theranos', dates: '' }, { title: 'Board Member', org: 'Arc Institute', dates: '' }] }));
    expect(d.find((x) => x.change === 'changed')).toMatchObject({ severity: 'low' });
    expect(d.find((x) => x.change === 'added')).toMatchObject({ after: 'Board Member, Arc Institute', severity: 'info' });
  });

  test('dates that moved are reported; a job that ended is not', () => {
    const moved = compareClaims(v({ roles: [{ title: 'CEO', org: 'Acme', dates: '2012 - 2015' }] }), v({ roles: [{ title: 'CEO', org: 'Acme', dates: '2010 - 2015' }] }));
    expect(moved).toEqual([expect.objectContaining({ field: 'role', change: 'changed', aspect: 'dates' })]);
    const ended = compareClaims(v({ roles: [{ title: 'CEO', org: 'Acme', dates: '2012 - Present' }] }), v({ roles: [{ title: 'CEO', org: 'Acme', dates: '2012 - 2016' }] }));
    expect(ended).toEqual([]);
  });

  test('a headline change and a rewritten bio are reported', () => {
    const d = compareClaims(v({ headline: 'Student at Stanford', bioText: 'I study chemical engineering and build lab tools.' }), v({ headline: 'Founder and CEO at Theranos', bioText: 'Theranos makes actionable health information accessible to everyone.' }));
    expect(d.map((x) => x.field).sort()).toEqual(['bio', 'headline']);
    expect(d.find((x) => x.field === 'headline')).toMatchObject({ change: 'changed', before: 'Student at Stanford', after: 'Founder and CEO at Theranos' });
  });

  test('on a team page the line beside the name is a title: a different standing is medium', () => {
    const d = compareClaims(v({ format: 'page', headline: 'Advisor' }), v({ format: 'page', headline: 'Co-founder' }));
    expect(d[0]).toMatchObject({ field: 'headline', aspect: 'title', severity: 'medium' });
  });
});

describe('helpers', () => {
  test('sameOrg, orgKey, looksLikeTitle, claimsQuote and claimsHeadline', () => {
    expect(orgKey('Theranos, Inc.')).toBe(orgKey('theranos'));
    expect(sameOrg('Stanford University', 'The School of Engineering at Stanford University')).toBe(true);
    expect(sameOrg('Stanford University', 'Harvard University')).toBe(false);
    expect(looksLikeTitle('Founder and CEO')).toBe(true);
    expect(looksLikeTitle('Sunny Balwani')).toBe(false);
    const c = extractClaims(CB_2010, 'crunchbase.com/person/elizabeth-holmes');
    expect(claimsQuote(c)).toBe('Elizabeth Holmes | Experience: Founder, CEO, Theranos | Education: Chemical Engineering, Stanford University | Elizabeth Holmes founded Theranos in 2003.');
    expect(claimsHeadline(c)).toBe('Founder, CEO, Theranos');
  });
});
