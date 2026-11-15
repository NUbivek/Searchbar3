/**
 * Reading what a person said about themselves on a saved copy of a page, and
 * comparing two saved copies of the same page.
 *
 * extractClaims(html, url)        -> { name, headline, roles, education, bioText, format, blocked }
 * compareClaims(older, newer)     -> the differences that matter for diligence
 *
 * Pure functions: no network. The page formats covered are the ones the web
 * archive actually holds: four generations of public LinkedIn profiles
 * (2008-2012 "hresume", 2013-2016, 2016-2018, 2019 onwards), Indeed resumes,
 * AngelList / Wellfound, three generations of Crunchbase person pages,
 * GitHub, Twitter, about.me, and a generic reader for anything else
 * (JSON-LD Person, the page description, the text beside the person's name
 * on a team or speaker page).
 *
 * Privacy: location lines are never read; contact details are removed from
 * free text; sentences about protected matters are dropped.
 */
import * as cheerio from 'cheerio';
import { htmlToText } from '../http';
import { redactPII, isSensitive, mentionsMinor } from '../guardrails';

const clean = (s) => String(s ?? '').replace(/[ ​‎‏]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Free text that is safe to quote: no contact details, no sentences about protected matters or children. */
export function safeText(text, max = 900) {
  const kept = clean(text)
    .split(/(?<=[.!?])\s+(?=[A-Z"“•])/)
    .filter((sentence) => !isSensitive(sentence) && !mentionsMinor(sentence));
  return clip(redactPII(kept.join(' ')), max);
}

/** "May 2012 – August 2014 (2 years 4 months)" -> "May 2012 – August 2014": the length of a job changes with every copy and is not a claim. */
function cleanDates(s) {
  return clean(s)
    .replace(/\(?\b(?:over|about|almost|less than)?\s*(?:a|an|\d+)\+?\s*(?:years?|yrs?|months?|mos?)\b(?:\s+\d+\s*(?:months?|mos?)\b)?\)?/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:()·-]+|[\s,;:()·-]+$/g, '')
    .trim();
}

const hostOf = (url) => {
  const raw = String(url || '');
  // a saved-copy address carries the original after the timestamp
  const inner = raw.match(/\/web\/\d{4,14}(?:[a-z]{2}_)?\/(.+)$/);
  const target = inner ? inner[1] : raw;
  try { return new URL(/^https?:\/\//i.test(target) ? target : `http://${target}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};

function textOf($, el, drop = '') {
  const node = $(el).first().clone();
  if (drop) node.find(drop).remove();
  node.find('script, style, noscript, svg, img').remove();
  node.find('br').replaceWith(' ');
  return clean(node.text());
}
const firstText = ($, selectors, drop = '') => {
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) { const t = textOf($, el, drop); if (t) return t; }
  }
  return '';
};
/** The first selector that yields text, searched inside `scope`. */
const firstIn = ($, scope, selectors, drop = '') => {
  for (const sel of selectors) {
    const el = scope.find(sel).first();
    if (el.length) { const t = textOf($, el, drop); if (t) return t; }
  }
  return '';
};
const meta = ($, names) => {
  for (const n of names) {
    const v = clean($(`meta[name="${n}"]`).attr('content') || $(`meta[property="${n}"]`).attr('content') || '');
    if (v) return v;
  }
  return '';
};

/** Every JSON-LD object on the page, flattened (graphs and nested main entities included). */
function jsonLd($) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    out.push(node);
    if (node['@graph']) walk(node['@graph']);
    if (node.mainEntity) walk(node.mainEntity);
  };
  $('script[type="application/ld+json"]').each((i, el) => {
    try { walk(JSON.parse($(el).contents().text())); } catch { /* not JSON */ }
  });
  return out;
}
const typeIs = (node, type) => [].concat(node?.['@type'] || []).some((t) => String(t).toLowerCase() === type.toLowerCase());
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const ldDates = (m) => {
  const start = clean(m?.startDate);
  const end = clean(m?.endDate);
  return start || end ? `${start || '?'} - ${end || 'Present'}` : '';
};

function fromLdPerson(person) {
  const titles = list(person.jobTitle).map(clean).filter(Boolean);
  const roles = [];
  list(person.worksFor).forEach((w, i) => {
    const org = clean(typeof w === 'string' ? w : w?.name);
    if (org) roles.push({ title: titles[i] || (i === 0 ? titles[0] || '' : ''), org, dates: ldDates(w?.member) });
  });
  const education = [];
  for (const a of list(person.alumniOf)) {
    const name = clean(typeof a === 'string' ? a : a?.name);
    if (!name) continue;
    if (typeIs(a, 'Organization') && !typeIs(a, 'EducationalOrganization') && !typeIs(a, 'CollegeOrUniversity')) roles.push({ title: '', org: name, dates: ldDates(a?.member) });
    else education.push({ school: name, degree: '', dates: ldDates(a?.member) });
  }
  return {
    name: clean(person.name),
    headline: roles.length ? '' : titles.join(', '),
    roles,
    education,
    bioText: clean(htmlToText(String(person.description || ''))),
  };
}

// ---------- LinkedIn ----------

function linkedin($) {
  const pageTitle = clean($('title').first().text());
  const name = firstText($, ['h1.top-card-layout__title', '.top-card-layout__title', '#name .full-name', '#name .fn', 'h1#name', '.profile-overview-content h1', '.masthead h1', 'h1.fn']);
  const headline = firstText($, ['h2.top-card-layout__headline', '.top-card-layout__headline', '#headline p.title', '#headline .title', 'p.headline.title', 'p.headline', '.profile-overview-content .headline']);

  const roles = [];
  const education = [];
  const pushRole = (title, org, dates) => { if (title || org) roles.push({ title, org, dates: cleanDates(dates) }); };
  const pushEdu = (school, degree, dates) => { if (school) education.push({ school, degree: degree.replace(/[\s,]+$/, ''), dates: cleanDates(dates) }); };
  const dateRange = (el) => textOf($, $(el).find('.date-range').first(), '.date-range__duration, span');

  // 2019 onwards
  $('li.experience-item, li.experience-group-position').each((i, el) => {
    const li = $(el);
    const group = li.closest('li.experience-group');
    const title = firstIn($, li, ['.experience-item__title', '.profile-section-card__title', 'h3']);
    const org = group.length && !li.hasClass('experience-item')
      ? textOf($, group.find('.experience-group-header__company').first())
      : firstIn($, li, ['.experience-item__subtitle', '.profile-section-card__subtitle', 'h4']);
    pushRole(title, org, dateRange(li));
  });
  $('li.education__list-item').each((i, el) => {
    const li = $(el);
    pushEdu(firstIn($, li, ['.profile-section-card__title', 'h3']), firstIn($, li, ['.profile-section-card__subtitle', 'h4']), dateRange(li));
  });
  // 2016-2018
  if (!roles.length) {
    $('#experience li.position').each((i, el) => {
      const li = $(el);
      pushRole(textOf($, li.find('.item-title')), textOf($, li.find('.item-subtitle')), dateRange(li));
    });
  }
  if (!education.length) {
    $('#education li.school').each((i, el) => {
      const li = $(el);
      pushEdu(textOf($, li.find('.item-title')), textOf($, li.find('.item-subtitle')), dateRange(li));
    });
  }
  // 2013-2016
  if (!roles.length) {
    $('#background-experience .section-item').each((i, el) => {
      const item = $(el);
      pushRole(textOf($, item.find('header h4').first()), textOf($, item.find('header h5').not('.experience-logo').first()), textOf($, item.find('.experience-date-locale').first(), '.locality'));
    });
  }
  if (!education.length) {
    $('#background-education .section-item').each((i, el) => {
      const item = $(el);
      pushEdu(textOf($, item.find('header h4').first()), textOf($, item.find('header h5').not('.education-logo').first()), textOf($, item.find('.education-date').first()));
    });
  }
  // 2008-2012 (hresume)
  if (!roles.length) {
    $('#experience li.experience, .hresume li.experience').each((i, el) => {
      const li = $(el);
      pushRole(textOf($, li.find('.title').first()), textOf($, li.find('.org').first()), textOf($, li.find('.period').first(), '.duration'));
    });
  }
  if (!education.length) {
    $('#education li.education, .hresume li.education').each((i, el) => {
      const li = $(el);
      const degree = [textOf($, li.find('.degree').first()), textOf($, li.find('.major').first())].filter(Boolean).join(', ') || textOf($, li.find('h4').first());
      pushEdu(textOf($, li.find('.org, h3').first()), degree, textOf($, li.find('.period').first(), '.duration') || li.find('abbr.dtstart, abbr.dtend').map((j, a) => clean($(a).text())).get().join(' - '));
    });
  }

  let bioText = firstText($, ['section.summary .core-section-container__content', '[data-section="summary"] .core-section-container__content', '#summary .description', '#summary-item-view .description', '#background-summary .description', '.summary p.description', '#summary p.summary', '#summary .content']);

  // The structured block newer pages carry fills whatever the visible page did not give.
  const person = jsonLd($).find((n) => typeIs(n, 'Person'));
  if (person) {
    const ld = fromLdPerson(person);
    if (!roles.length) roles.push(...ld.roles);
    if (!education.length) education.push(...ld.education);
    if (!bioText) bioText = ld.bioText;
  }

  const empty = !headline && !roles.length && !education.length;
  const wall = empty && /authwall|sign up \| linkedin|log in or sign up|linkedin login|sign in \| linkedin|join linkedin|security verification|linkedin: log in/i.test(`${pageTitle} ${$('form').attr('action') || ''} ${$('body').attr('class') || ''} ${clean($('h1').first().text())}`);
  return {
    name: name || (person ? clean(person.name) : '') || (empty ? '' : pageTitle.split(/\s[-|]\s/)[0]),
    headline, roles, education, bioText,
    format: 'linkedin',
    blocked: wall || (empty && !name) ? 'sign-in wall' : null,
  };
}

// ---------- Indeed resumes ----------

function indeed($) {
  const roles = [];
  const education = [];
  $('.work-experience-section, [id^="workExperience-"]').each((i, el) => {
    const item = $(el);
    const title = textOf($, item.find('.work_title').first());
    const org = textOf($, item.find('.work_company .bold, .work_company span').first());
    if (title || org) roles.push({ title, org, dates: cleanDates(textOf($, item.find('.work_dates').first())) });
  });
  $('.education-section, [id^="education-"]').each((i, el) => {
    const item = $(el);
    const school = textOf($, item.find('.edu_school .bold, .edu_school span').first());
    if (school) education.push({ school, degree: textOf($, item.find('.edu_title').first()), dates: cleanDates(textOf($, item.find('.edu_dates').first())) });
  });
  return {
    name: firstText($, ['#resume-contact', 'h1.fn', 'h1[itemprop="name"]']),
    headline: firstText($, ['#headline', 'h2[itemprop="jobTitle"]']),
    roles, education,
    bioText: firstText($, ['#res_summary', 'p.summary']),
    format: 'indeed',
    blocked: null,
  };
}

// ---------- AngelList / Wellfound ----------

function angel($) {
  const roles = [];
  $('[data-_tn="startup_roles/experience"], .experience_container .feature').each((i, el) => {
    const item = $(el);
    const org = clean(item.find('a.startup-link').first().attr('title')) || textOf($, item.find('a.u-unstyledLink, a[data-type="Startup"]').first());
    const title = textOf($, item.find('.line .medium-font, .medium-font').last());
    if (org || title) roles.push({ title: title === org ? '' : title, org, dates: cleanDates(textOf($, item.find('.metadata-string').first())) });
  });
  const education = [];
  $('[data-module_name="education"] a, .education .college-row a').each((i, el) => {
    const school = clean($(el).text());
    if (school && !education.some((e) => e.school === school)) education.push({ school, degree: '', dates: '' });
  });
  const og = meta($, ['og:description', 'description']);
  return {
    name: firstText($, ['h1.js-name', 'h1[itemprop="name"]']) || meta($, ['og:title']).split(/\s[-|]\s/)[0],
    headline: firstText($, ['[data-field="bio"]', 'h2 [data-field="bio"]']) || (og.includes('|') ? clean(og.split('|').slice(1).join('|')) : ''),
    roles, education,
    bioText: firstText($, ['[data-field="what_i_do"]', '[data-field="achievements"]', '.what_i_do .content']),
    format: 'angellist',
    blocked: null,
  };
}

// ---------- Crunchbase person pages ----------

function crunchbase($) {
  const roles = [];
  const education = [];
  let headline = '';
  let bioText = '';
  let name = '';

  if ($('#col2_internal, .col1_people_name').length) {
    // 2008-2014
    name = textOf($, $('h1.h1_first, #col2_internal h1').first(), '.right');
    $('.col1_people_name').each((i, el) => {
      const org = textOf($, el);
      const title = textOf($, $(el).nextAll('.col1_people_title').first());
      if (org) roles.push({ title, org, dates: '' });
    });
    $('h2').filter((i, el) => /^\s*Degrees/.test($(el).text())).first().nextAll('.col1_content').first().find('tr, li').each((i, el) => {
      const cells = $(el).find('td').length ? $(el).find('td').map((j, td) => textOf($, td)).get().filter(Boolean) : [textOf($, el)];
      if (cells.length) education.push({ school: cells[cells.length - 1], degree: cells.slice(0, -1).join(', '), dates: '' });
    });
    bioText = textOf($, $('#col2_internal > p').first());
    if (/^no overview yet/i.test(bioText)) bioText = '';
  } else if ($('.info-tab, #person_details').length) {
    // 2015-2017
    name = firstText($, ['#profile_header_heading', 'h1']);
    headline = textOf($, $('dt').filter((i, el) => /Primary Role/i.test($(el).text())).first().next('dd'));
    $('.info-tab.experiences .info-block').each((i, el) => {
      const block = $(el);
      const title = textOf($, block.find('h4').first());
      const org = textOf($, block.find('h5').not('.date').first());
      if (title || org) roles.push({ title, org, dates: cleanDates(textOf($, block.find('h5.date').first()).replace(/\bCurrent\b/i, 'Present')) });
    });
    $('.info-tab.education .info-block').each((i, el) => {
      const block = $(el);
      const school = textOf($, block.find('h4').first());
      if (school) education.push({ school, degree: textOf($, block.find('h5').first()), dates: cleanDates(textOf($, block, 'h4, h5')) });
    });
    bioText = firstText($, ['#description .description-ellipsis', '#description']);
  } else {
    // 2018 onwards
    name = firstText($, ['h1.profile-name', 'h1']) || meta($, ['og:title']).split(/\s[-|]\s/)[0];
    $('table').each((i, table) => {
      const heads = $(table).find('th').map((j, th) => clean($(th).text()).toLowerCase()).get();
      const col = (label) => heads.findIndex((h) => h.includes(label));
      const [iOrg, iTitle, iStart, iEnd] = [col('organization name'), col('title at company'), col('start date'), col('end date')];
      if (iOrg < 0 || iTitle < 0) return;
      $(table).find('tr').each((j, tr) => {
        const cells = $(tr).find('td').map((k, td) => clean($(td).text())).get();
        if (cells.length <= Math.max(iOrg, iTitle)) return;
        const blank = (v) => !v || /^[—–-]+$/.test(v);
        const [start, end] = [iStart >= 0 ? cells[iStart] : '', iEnd >= 0 ? cells[iEnd] : ''];
        const dates = blank(start) && blank(end) ? '' : `${blank(start) ? '?' : start} - ${blank(end) ? 'Present' : end}`;
        roles.push({ title: cells[iTitle], org: cells[iOrg], dates });
      });
    });
    const studied = $('phrase-list-card').filter((i, el) => /studied at/i.test($(el).text())).first();
    studied.nextAll('image-list-card').first().find('.image-list-item, li').each((i, el) => {
      const item = $(el);
      const school = textOf($, item.find('a').first());
      const degree = item.find('.field-type-text_short').map((j, s) => clean($(s).text())).get().filter((v) => v && !/^unknown$/i.test(v)).join(', ');
      if (school) education.push({ school, degree, dates: clean(item.find('.field-type-date_precision').first().text()) });
    });
    bioText = $('description-card p').map((i, p) => clean($(p).text())).get().join(' ');
    const fields = {};
    $('fields-card li, fields-card .text_and_value').each((i, el) => {
      const label = clean($(el).find('label-with-info, .wrappable-label-with-info').first().text());
      const value = clean($(el).find('field-formatter').first().text());
      if (label && value) fields[label.toLowerCase()] = value;
    });
    headline = [fields['primary job title'], fields['primary organization']].filter(Boolean).join(' @ ');
  }
  return { name, headline, roles, education, bioText, format: 'crunchbase', blocked: null };
}

// ---------- GitHub, Twitter, about.me ----------

function github($) {
  const org = firstText($, ['.p-org', '[itemprop="worksFor"]']);
  return {
    name: firstText($, ['.p-name', '.vcard-fullname', 'h1 [itemprop="name"]', '[itemprop="name"]']),
    headline: firstText($, ['.p-note', '.user-profile-bio']),
    roles: org ? [{ title: '', org: org.replace(/^@/, ''), dates: '' }] : [],
    education: [],
    bioText: '',
    format: 'github',
    blocked: null,
  };
}

function twitter($) {
  const title = clean($('title').first().text());
  const fromTitle = (title.match(/^(.+?)\s*\(@?[A-Za-z0-9_]{1,15}\)\s*(?:on Twitter|\| Twitter|\/ Twitter|\/ X)/) || [])[1] || '';
  return {
    name: firstText($, ['.ProfileHeaderCard-name a', '.ProfileHeaderCard-nameLink', '.profile-card h1.fullname', 'h1.fullname', '.profile-card .fullname', '.user-actions-follow-button ~ .fullname', '#profile .fn', '.full-name', '.fn']) || clean(fromTitle),
    headline: firstText($, ['.ProfileHeaderCard-bio', '.profile-card p.bio', 'p.bio', '.bio-container .bio', '#bio', 'span.bio', '.bio']),
    roles: [], education: [], bioText: '',
    format: 'twitter',
    blocked: null,
  };
}

function aboutMe($) {
  return {
    name: firstText($, ['h1.name', '.name h1', 'h1[itemprop="name"]', '.profile h1', 'h1']),
    headline: firstText($, ['h2.headline', '.headline', '.short-bio', '[itemprop="jobTitle"]']),
    roles: [], education: [],
    bioText: firstText($, ['.bio', '.bio-container', '[itemprop="description"]', '#bio', '.biography']) || meta($, ['og:description', 'description']),
    format: 'about.me',
    blocked: null,
  };
}

// ---------- anything else ----------

const TITLE_WORDS = /\b(ceo|cto|coo|cfo|cmo|cpo|cso|cio|chief|founder|co-?founder|founding|president|chair(?:man|woman|person)?|officer|director|vp|svp|evp|vice[- ]president|head|partner|principal|engineer|scientist|professor|manager|lead|leader|advis[eo]r|board|investor|analyst|associate|counsel|attorney|architect|designer|developer|researcher|fellow|owner|executive|secretary|treasurer|managing|general manager|editor|consultant|entrepreneur|intern|student|lecturer|physician|doctor|member)\b/i;
/** Does this short line read like a job title ("Founder, CEO"), rather than a name or a sentence? */
export const looksLikeTitle = (line) => TITLE_WORDS.test(String(line || '')) && String(line || '').split(/\s+/).length <= 18;

/**
 * The line that names the person and the text beside it. On a team page
 * that is "Jane Roe, Chief Scientist" followed by her paragraph.
 * `person` is a name or a matcher with .positions(text).
 */
function aroundName(html, person) {
  if (!person) return null;
  const body = String(html || '').replace(/<head\b[\s\S]*?<\/head>/i, ' ');
  const text = htmlToText(body);
  let hit = null;
  if (typeof person === 'function' && typeof person.positions === 'function') [hit] = person.positions(text);
  else if (typeof person === 'string' && person.trim()) {
    const m = text.match(new RegExp(`(?<![A-Za-z0-9])${person.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}(?![A-Za-z0-9])`, 'i'));
    if (m) hit = { start: m.index, end: m.index + m[0].length, text: m[0] };
  }
  if (!hit) return null;
  const lineStart = text.lastIndexOf('\n', hit.start) + 1;
  const rest = text.slice(hit.end);
  const lines = rest.split('\n');
  const sameLine = clean(lines[0]).replace(/^[\s,;:|·•–—-]+/, '');
  let headline = '';
  let from = 1;
  // Only a line that reads like a job title is taken as one: on a list of names the next line is another person.
  if (sameLine && sameLine.length <= 140 && !/[.!?]\s+[A-Z]/.test(sameLine) && looksLikeTitle(sameLine)) headline = sameLine.replace(/[\s,;:|·•–—-]+$/, '');
  else if (!sameLine && lines[1] && clean(lines[1]).length <= 120 && !/[.!?]$/.test(clean(lines[1])) && looksLikeTitle(clean(lines[1]))) { headline = clean(lines[1]); from = 2; }
  const bio = [];
  let size = 0;
  if (sameLine && !headline) { bio.push(`${text.slice(lineStart, hit.end)} ${sameLine}`.trim()); size = bio[0].length; }
  for (let i = from; i < lines.length && bio.length < 6 && size < 900; i += 1) {
    const line = clean(lines[i]);
    if (!line) continue;
    if (line.length <= 60 && size >= 160) break; // the next heading: another person or section
    if (line.length <= 30 && !bio.length && i > from + 1) break;
    bio.push(line);
    size += line.length;
  }
  return { name: clean(hit.text), headline, bioText: bio.filter((l) => l.length > 30).join(' ') };
}

function generic($, html, person) {
  const near = aroundName(html, person);
  const ld = jsonLd($).filter((n) => typeIs(n, 'Person')).map(fromLdPerson);
  const matcher = typeof person === 'function' ? person : (t) => Boolean(person) && clean(t).toLowerCase() === String(person).trim().toLowerCase();
  const own = ld.find((p) => p.name && (!person || matcher(p.name))) || (person ? null : ld[0]) || null;
  const title = clean($('title').first().text());
  const description = meta($, ['og:description', 'description', 'twitter:description']);
  const name = near?.name || own?.name || meta($, ['og:title']).split(/\s[-|–—·]\s/)[0] || title.split(/\s[-|–—·]\s/)[0];
  return {
    name,
    headline: near?.headline || own?.headline || '',
    roles: own?.roles || [],
    education: own?.education || [],
    bioText: near?.bioText || own?.bioText || (near || !person ? description : ''),
    format: 'page',
    blocked: null,
    named: person ? Boolean(near || own) : null,
  };
}

/** Other profile addresses the page itself gives as the same person's (rel="me" links, the profile's link row, sameAs). */
function ownLinks($) {
  const out = new Set();
  const add = (raw) => {
    let href = clean(raw);
    const inner = href.match(/\/web\/\d{4,14}(?:[a-z]{2}_)?\/(https?:\/\/.+)$/); // a link rewritten by the archive
    if (inner) [, href] = inner;
    if (/^https?:\/\//i.test(href) && href.length < 300) out.add(href);
  };
  $('a[rel~="me"], a[data-field$="_url"], a[itemprop="url"], a[itemprop="sameAs"], link[itemprop="sameAs"]').each((i, el) => add($(el).attr('href')));
  for (const node of jsonLd($)) if (typeIs(node, 'Person')) list(node.sameAs).forEach((u) => add(typeof u === 'string' ? u : ''));
  return [...out].slice(0, 12);
}

const READERS = [
  [/(^|\.)linkedin\.com$/, linkedin],
  [/(^|\.)indeed\.com$/, indeed],
  [/^(angel\.co|wellfound\.com)$/, angel],
  [/(^|\.)crunchbase\.com$/, crunchbase],
  [/^github\.com$/, github],
  [/^(twitter\.com|x\.com)$/, twitter],
  [/^about\.me$/, aboutMe],
];

const hasContent = (c) => Boolean(c && (c.headline || c.bioText || c.roles.length || c.education.length));

/**
 * What a saved page says about a person.
 * @param {string} html the page as it was served (not the archive's framed replay)
 * @param {string} url the page's own address, or its saved-copy address
 * @param {{ person?: string | Function }} options  the person to look for on pages that list several people
 * @returns {{ name: string, headline: string, roles: Array<{ title: string, org: string, dates: string }>,
 *             education: Array<{ school: string, degree: string, dates: string }>, bioText: string,
 *             format: string, blocked: string | null, named?: boolean | null }}
 */
export function extractClaims(html, url = '', { person = null } = {}) {
  const source = String(html || '');
  const $ = cheerio.load(source);
  const host = hostOf(url);
  const reader = (READERS.find(([re]) => re.test(host)) || [])[1];
  let claims = reader ? reader($) : null;
  const links = reader ? ownLinks($) : [];
  if (!hasContent(claims) && !(claims && claims.blocked)) {
    const fallback = generic($, source, person);
    claims = claims ? { ...fallback, name: claims.name || fallback.name, format: claims.format } : fallback;
  }
  const seen = new Set();
  const unique = (items, key) => items.filter((item) => { const k = key(item).toLowerCase(); if (!k.replace(/\|/g, '') || seen.has(k)) return false; seen.add(k); return true; });
  // Since about 2024 LinkedIn shows signed-out visitors some lines as asterisks ("******* **********"): such a line says nothing.
  let masked = false;
  const unmask = (s) => {
    const t = clean(s);
    if (!/\*{2,}/.test(t)) return t;
    masked = true;
    const words = t.split(' ');
    const kept = words.filter((w) => !/^[*.,;:'’()-]*\*[*.,;:'’()-]*$/.test(w));
    return kept.length * 2 > words.length ? kept.join(' ') : '';
  };
  const short = (s, n) => clip(redactPII(unmask(s)), n);
  const roles = claims.roles.map((r) => ({ title: short(r.title, 160), org: short(r.org, 160), dates: short(r.dates, 60) })).filter((r) => r.title || r.org);
  const education = claims.education.map((e) => ({ school: short(e.school, 160), degree: short(e.degree, 200), dates: short(e.dates, 60) })).filter((e) => e.school);
  const headline = isSensitive(claims.headline) || mentionsMinor(claims.headline) ? '' : short(claims.headline, 300);
  const bioText = safeText(unmask(claims.bioText), 1200);
  return {
    name: short(claims.name, 120),
    headline,
    roles: unique(roles, (r) => `role|${r.title}|${r.org}|${r.dates}`).slice(0, 25),
    education: unique(education, (e) => `edu|${e.school}|${e.degree}|${e.dates}`).slice(0, 12),
    bioText,
    format: claims.format,
    blocked: claims.blocked || null,
    links,
    ...(masked ? { masked: true } : {}),
    ...(claims.named === undefined ? {} : { named: claims.named }),
  };
}

// ---------- describing a version ----------

export const roleText = (r) => [r.title, r.org].filter(Boolean).join(', ') + (r.dates ? ` (${r.dates})` : '');
export const educationText = (e) => [e.degree, e.school].filter(Boolean).join(', ') + (e.dates ? ` (${e.dates})` : '');

/** The page's own words, laid out for quoting: name, headline, roles, education (or the bio when there is nothing else). */
export function claimsQuote(claims, max = 680) {
  const parts = [];
  const usable = (text) => !isSensitive(text) && !mentionsMinor(text);
  const roles = (claims.roles || []).map(roleText).filter(usable);
  const education = (claims.education || []).map(educationText).filter(usable);
  if (claims.name) parts.push(claims.name);
  if (claims.headline) parts.push(claims.headline);
  if (roles.length) parts.push(`Experience: ${roles.slice(0, 8).join('; ')}`);
  if (education.length) parts.push(`Education: ${education.slice(0, 5).join('; ')}`);
  if (claims.bioText && (!roles.length || parts.join(' | ').length < 260)) parts.push(claims.bioText);
  return clip(parts.join(' | '), max);
}

/** One line that says what this version claims: the headline, else the first role, else the start of the bio. */
export function claimsHeadline(claims, max = 110) {
  const usable = (text) => text && !isSensitive(text) && !mentionsMinor(text);
  const first = [claims.headline, ...(claims.roles || []).slice(0, 1).map(roleText), claims.bioText].find(usable);
  return first ? clip(clean(first), max) : '';
}

// ---------- comparing two versions ----------

const ORG_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sas|sa|ag|bv|pty|pvt|lp|llp|the)\b/g;
const normText = (s) => stripAccents(s).toLowerCase().replace(/&/g, ' and ').replace(/\bco[\s-]?founders?\b/g, 'cofounder').replace(/[^a-z0-9]+/g, ' ').trim();
/** "Theranos, Inc." = "theranos"; "we work" = "WeWork". */
export const orgKey = (s) => normText(s).replace(ORG_SUFFIX, ' ').replace(/\s+/g, '');

const TITLE_SYNONYMS = [
  [/\bchief executive officer\b/g, 'ceo'], [/\bchief technology officer\b|\bchief technical officer\b/g, 'cto'], [/\bchief operating officer\b/g, 'coo'],
  [/\bchief financial officer\b/g, 'cfo'], [/\bchief product officer\b/g, 'cpo'], [/\bchief scientific officer\b|\bchief science officer\b/g, 'cso'],
  [/\bvice president\b/g, 'vp'], [/\bchair(?:man|woman|person)?(?: of the board)?\b/g, 'chair'], [/\bfounders\b/g, 'founder'], [/\bsr\b/g, 'senior'], [/\bjr\b/g, 'junior'],
  [/\bbachelor of science\b|\bb sc\b|\bb s\b|\bbsc\b/g, 'bs'], [/\bbachelor of arts\b|\bb a\b/g, 'ba'], [/\bmaster of science\b|\bm sc\b|\bm s\b|\bmsc\b/g, 'ms'],
  [/\bmaster of business administration\b|\bm b a\b/g, 'mba'], [/\bmaster of arts\b|\bm a\b/g, 'ma'], [/\bdoctor of philosophy\b|\bph d\b|\bdphil\b/g, 'phd'], [/\bbachelor s\b|\bbachelors\b/g, 'bachelor'], [/\bmaster s\b|\bmasters\b/g, 'master'],
];
const STOP = new Set(['and', 'of', 'the', 'at', 'a', 'an', 'for', 'in', 'to', 'degree']);
/** Order, case, punctuation and common spellings do not matter: "Chairman, CEO, and Founder" = "Founder, Chief Executive Officer & Chairman". */
function phraseKey(s) {
  let t = normText(s);
  for (const [re, to] of TITLE_SYNONYMS) t = t.replace(re, to);
  return [...new Set(t.split(' ').filter((w) => w && !STOP.has(w)))].sort().join(' ');
}

const ROLE_CLASSES = [
  ['founder', /\b(co[\s-]?founder|founder|founding)\b/i],
  ['executive', /\b(ceo|cto|coo|cfo|chief|president|chair\w*|managing director|general partner)\b/i],
  ['advisor', /\b(advis[eo]r|mentor|consultant|contractor|freelance)\b/i],
  ['junior', /\b(intern|internship|trainee|student|apprentice|assistant|volunteer)\b/i],
  ['investor', /\b(investor|venture partner|principal)\b/i],
  ['board', /\b(board|director|trustee)\b/i],
];
const roleClasses = (s) => ROLE_CLASSES.filter(([, re]) => re.test(s)).map(([k]) => k).join(',');

/** Start and end year of a date range ("Present" is open-ended). */
function yearSpan(dates) {
  const s = String(dates || '');
  const years = (s.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
  const open = /\b(present|current|now|today|ongoing)\b/i.test(s);
  return { start: years[0] || null, end: open ? 'open' : years[1] || (years.length === 1 && !/[-–—]|\bto\b/.test(s) ? years[0] : null) };
}
function datesMoved(before, after) {
  const a = yearSpan(before);
  const b = yearSpan(after);
  if (a.start && b.start && a.start !== b.start) return true;
  if (typeof a.end === 'number' && typeof b.end === 'number' && a.end !== b.end) return true;
  if (typeof a.end === 'number' && b.end === 'open' && a.start && b.start) return true; // a job that had ended is open again
  return false; // "Present" becoming a year is someone leaving a job, not a changed claim
}

const tokenSet = (s) => new Set(normText(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
function similarity(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  return both / (A.size + B.size - both);
}

function diffEntries(older, newer, { field, nameOf, detailOf, text, detailAspect, goneAspect }) {
  const out = [];
  const group = (items) => {
    const m = new Map();
    for (const item of items) {
      const k = orgKey(nameOf(item)) || `~${phraseKey(detailOf(item))}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(item);
    }
    return m;
  };
  const O = group(older);
  // "The School of Engineering at Stanford University" and "Stanford University" are one school; "Stripe" and "Stripe, Inc." one employer
  const alias = (item) => {
    const own = orgKey(nameOf(item));
    if (!own || O.has(own)) return null;
    for (const [k, olds] of O) if (!k.startsWith('~') && sameOrg(nameOf(olds[0]), nameOf(item))) return k;
    return null;
  };
  const N = new Map();
  for (const item of newer) {
    const k = alias(item) || orgKey(nameOf(item)) || `~${phraseKey(detailOf(item))}`;
    if (!N.has(k)) N.set(k, []);
    N.get(k).push(item);
  }
  for (const [k, olds] of O) {
    const news = [...(N.get(k) || [])];
    if (!news.length) {
      for (const item of olds) out.push({ field, change: 'removed', before: text(item), after: '', about: nameOf(item), aspect: goneAspect, severity: 'medium' });
      continue;
    }
    const unmatched = [];
    for (const item of olds) {
      const want = phraseKey(detailOf(item));
      let i = news.findIndex((x) => phraseKey(detailOf(x)) === want);
      if (i < 0 && !want) i = 0; // the older copy gave no detail to compare
      if (i < 0) i = news.findIndex((x) => !phraseKey(detailOf(x)));
      if (i < 0) { unmatched.push(item); continue; }
      const [same] = news.splice(i, 1);
      if (datesMoved(item.dates, same.dates)) out.push({ field, change: 'changed', before: text(item), after: text(same), about: nameOf(item), aspect: 'dates', severity: 'low' });
    }
    while (unmatched.length && news.length) {
      const item = unmatched.shift();
      // pair with the newer entry that shares the most words ("Founder, Chairman & CEO" goes with "Founder and CEO", not with "CEO")
      let best = 0;
      let bestShare = -1;
      news.forEach((x, i) => { const share = keyOverlap(detailOf(item), detailOf(x)); if (share > bestShare) { best = i; bestShare = share; } });
      const [next] = news.splice(best, 1);
      out.push({ field, change: 'changed', before: text(item), after: text(next), about: nameOf(item), aspect: detailAspect, severity: field === 'role' && sameStanding(detailOf(item), detailOf(next)) ? 'low' : 'medium' });
    }
    for (const item of unmatched) out.push({ field, change: 'removed', before: text(item), after: '', about: nameOf(item), aspect: detailAspect, severity: 'medium' });
    for (const item of news) out.push({ field, change: 'added', before: '', after: text(item), about: nameOf(item), aspect: detailAspect, severity: 'info' });
  }
  for (const [k, news] of N) {
    if (O.has(k)) continue;
    for (const item of news) out.push({ field, change: 'added', before: '', after: text(item), about: nameOf(item), aspect: goneAspect, severity: 'info' });
  }
  // Most of a long list gone at once is the site showing less (or a new page layout), not a person editing one line.
  const gone = out.filter((d) => d.change === 'removed' && d.aspect === goneAspect);
  if (gone.length >= 3 && gone.length * 2 >= older.length) {
    const rest = out.filter((d) => !gone.includes(d));
    rest.push({ field, change: 'removed', before: gone.slice(0, 5).map((d) => d.before).join('; '), after: '', aspect: 'section', count: gone.length, severity: 'low' });
    return rest;
  }
  return out;
}

/** Two spellings of one organisation: the same once suffixes go, or every word of the shorter name appears in the longer. */
export function sameOrg(a, b) {
  if (orgKey(a) && orgKey(a) === orgKey(b)) return true;
  const words = (s) => normText(s).replace(ORG_SUFFIX, ' ').split(' ').filter((w) => w && !STOP.has(w));
  const [short, long] = [words(a), words(b)].sort((x, y) => x.length - y.length);
  if (!short.length || !short.some((w) => w.length >= 4)) return false;
  return short.every((w) => long.includes(w));
}

const keyWords = (s) => new Set(phraseKey(s).split(' ').filter(Boolean));
function keyOverlap(a, b) {
  const A = keyWords(a);
  const B = keyWords(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  return both / (A.size + B.size - both);
}
/**
 * A reworded title that claims the same standing: words were only added or
 * only dropped ("Founder, CEO" -> "Chairman, CEO, and Founder") and the kind
 * of role did not change. "Advisor" -> "Co-founder" or "Intern" ->
 * "Engineer" is not that.
 */
function sameStanding(before, after) {
  const A = keyWords(before);
  const B = keyWords(after);
  if (!A.size || !B.size) return false;
  const subset = (X, Y) => [...X].every((w) => Y.has(w));
  return (subset(A, B) || subset(B, A)) && roleClasses(before) === roleClasses(after);
}

const SEVERITY_ORDER = { medium: 0, low: 1, info: 2 };

/**
 * What changed between an older and a newer copy of the same page.
 * Differences of case, punctuation, word order, company suffixes and
 * spelled-out titles are ignored. What is reported: a degree or school that
 * is later different or gone, an employer or title that disappears or is
 * reworded, dates that moved, a rewritten headline or bio, and additions.
 *
 * Severity: 'medium' for a changed or removed degree, school, employer or
 * title; 'low' for moved dates, a reworded title of the same standing, or a
 * whole section that is no longer shown; 'info' for additions and rewrites.
 *
 * @returns {Array<{ field: 'headline'|'role'|'education'|'bio', change: 'changed'|'removed'|'added',
 *                   before: string, after: string, about?: string, aspect?: string, severity: 'medium'|'low'|'info' }>}
 */
export function compareClaims(older, newer) {
  const o = older || {};
  const n = newer || {};
  const out = [];

  if (o.headline && n.headline && phraseKey(o.headline) !== phraseKey(n.headline)) {
    // On a team or speaker page the line beside the name IS the title; on a profile it is a tagline that moves with every new job.
    const isTitle = o.format === 'page' && n.format === 'page';
    const standing = roleClasses(o.headline) !== roleClasses(n.headline);
    const severity = isTitle ? (standing || !sameStanding(o.headline, n.headline) ? 'medium' : 'low') : (standing ? 'low' : 'info');
    out.push({ field: 'headline', change: 'changed', before: o.headline, after: n.headline, aspect: isTitle ? 'title' : 'headline', severity });
  }

  const oRoles = o.roles || [];
  const nRoles = n.roles || [];
  if (oRoles.length && nRoles.length) {
    out.push(...diffEntries(oRoles, nRoles, { field: 'role', nameOf: (r) => r.org, detailOf: (r) => r.title, text: roleText, detailAspect: 'title', goneAspect: 'employer' }));
  } else if (oRoles.length && !nRoles.length && (n.headline || n.education?.length)) {
    out.push({ field: 'role', change: 'removed', before: oRoles.slice(0, 4).map(roleText).join('; '), after: '', aspect: 'section', severity: 'low' });
  } else if (!oRoles.length && nRoles.length && (o.headline || o.education?.length)) {
    for (const r of nRoles.slice(0, 3)) out.push({ field: 'role', change: 'added', before: '', after: roleText(r), about: r.org, aspect: 'employer', severity: 'info' });
  }

  const oEdu = o.education || [];
  const nEdu = n.education || [];
  if (oEdu.length && nEdu.length) {
    out.push(...diffEntries(oEdu, nEdu, { field: 'education', nameOf: (e) => e.school, detailOf: (e) => e.degree, text: educationText, detailAspect: 'degree', goneAspect: 'school' }));
  } else if (oEdu.length && !nEdu.length && (n.headline || nRoles.length)) {
    out.push({ field: 'education', change: 'removed', before: oEdu.slice(0, 4).map(educationText).join('; '), after: '', aspect: 'section', severity: 'low' });
  } else if (!oEdu.length && nEdu.length && (o.headline || oRoles.length)) {
    for (const e of nEdu.slice(0, 3)) out.push({ field: 'education', change: 'added', before: '', after: educationText(e), about: e.school, aspect: 'school', severity: 'info' });
  }

  if (o.bioText && n.bioText && normText(o.bioText) !== normText(n.bioText) && similarity(o.bioText, n.bioText) < 0.6) {
    out.push({ field: 'bio', change: 'changed', before: clip(o.bioText, 300), after: clip(n.bioText, 300), aspect: 'bio', severity: 'info' });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Two copies that say the same thing (after the same normalisation the comparison uses). */
export function claimsSignature(claims) {
  const c = claims || {};
  return [
    phraseKey(c.headline || ''),
    (c.roles || []).map((r) => `${orgKey(r.org)}:${phraseKey(r.title)}:${JSON.stringify(yearSpan(r.dates))}`).sort().join(';'),
    (c.education || []).map((e) => `${orgKey(e.school)}:${phraseKey(e.degree)}`).sort().join(';'),
    [...tokenSet(c.bioText || '')].sort().slice(0, 60).join(' '),
  ].join('|');
}
