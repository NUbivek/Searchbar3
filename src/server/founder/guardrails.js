/**
 * Privacy guardrails for the deep background check.
 *
 * The check is for investment diligence on a founder or executive: public
 * records and published sources about their professional conduct. It is not
 * a people-search tool. These rules are applied to every finding from every
 * source before it is stored, shown or given to a model:
 *
 *  - people-search and data-broker sites are never used;
 *  - contact and locating details are removed from quoted text (street
 *    addresses, phone numbers, email addresses, dates of birth, national ID
 *    numbers);
 *  - sentences about protected or intimate matters (health, religion,
 *    sexuality, immigration status) and about children are dropped;
 *  - family members are only reported when the source places them in a
 *    public business, political or philanthropic role (see related.js).
 *
 * Deterministic, no network, no model.
 */

/** Hosts that sell or aggregate personal records. Never queried, never cited. */
export const BLOCKED_HOSTS = [
  'spokeo.com', 'whitepages.com', 'beenverified.com', 'truepeoplesearch.com', 'fastpeoplesearch.com', 'peoplefinders.com',
  'intelius.com', 'radaris.com', 'mylife.com', 'zabasearch.com', 'pipl.com', 'peekyou.com', 'instantcheckmate.com',
  'truthfinder.com', 'ussearch.com', 'peoplelooker.com', 'nuwber.com', 'clustrmaps.com', 'thatsthem.com', 'usphonebook.com',
  'familytreenow.com', 'checkpeople.com', 'publicrecordsnow.com', 'searchpeoplefree.com', 'cyberbackgroundchecks.com',
  'idcrawl.com', 'socialcatfish.com', 'numlookup.com', 'anywho.com', '411.com', 'addresses.com', 'voterrecords.com',
  'peoplesearchnow.com', 'smartbackgroundchecks.com', 'publicdatausa.com', 'officialusa.com', 'neighbor.report',
  'rocketreach.co', 'contactout.com', 'signalhire.com', 'lusha.com', 'apollo.io', 'zoominfo.com', 'leadiq.com',
  'hunter.io', 'snov.io', 'datanyze.com', 'emailsherlock.com', 'unmask.com', 'veripages.com', 'homemetry.com',
  'blockshopper.com', 'ancestry.com', 'myheritage.com', 'findagrave.com', 'legacy.com',
  // leak and doxxing hosts: stolen personal data is never retrieved or shown
  'doxbin.com', 'doxbin.org', 'doxbin.net', 'breachforums.st', 'breached.vc', 'raidforums.com', 'leakbase.io', 'dehashed.com',
  'snusbase.com', 'leakcheck.io', 'intelx.io', 'weleakinfo.to',
];

const hostOf = (url) => {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};

/** True when a URL is on (or under) a blocked host. */
export function isBlockedUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  return BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));
}

const STREET = '(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Square|Sq|Trail|Trl|Crescent|Cres|Close|Row|Alley|Loop)';
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

const REDACTIONS = [
  // email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email removed]'],
  // US social security numbers and similar national identifiers
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ID number removed]'],
  [/\b(?:SSN|social security(?: number)?|national insurance(?: number)?|passport(?: number| no\.?)?)\s*[:#]?\s*[A-Z0-9][A-Z0-9 -]{5,14}\b/gi, '[ID number removed]'],
  // phone numbers: +1 (415) 555-0100, 415-555-0100, +44 20 7946 0958
  [/(?<![\w/.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w/-])/g, '[phone removed]'],
  // street addresses: "1234 Elm Street", "12 Rue de ...", with an optional unit
  [new RegExp(`\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z][A-Za-z'.-]+\\s+){1,4}${STREET}\\b\\.?(?:,?\\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\\.?\\s*[A-Za-z0-9-]+)?`, 'g'), '[address removed]'],
  // full dates of birth: "born on March 3, 1984", "born 3 March 1984", "DOB: 03/03/1984" (the year alone is kept)
  [new RegExp(`\\b(born(?:\\s+on)?|date of birth|DOB|d\\.o\\.b\\.?)\\s*[:,]?\\s*(?:${MONTH}\\.?\\s+\\d{1,2},?\\s+(\\d{4})|\\d{1,2}\\s+${MONTH}\\.?,?\\s+(\\d{4})|\\d{1,2}[/.-]\\d{1,2}[/.-](\\d{2,4}))`, 'gi'), (m, lead, y1, y2, y3) => {
    const year = y1 || y2 || (y3 && y3.length === 4 ? y3 : '');
    if (/^born/i.test(lead)) return year ? `born in ${year}` : 'born [date removed]';
    return year ? `${lead} ${year}` : `${lead} [date removed]`;
  }],
];

/** Remove contact and locating details from a piece of quoted text. */
export function redactPII(text) {
  let out = String(text || '');
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

// Protected or intimate matters. A sentence that is about one of these is not
// investment diligence and is dropped, whatever the source.
const SENSITIVE = /\b(diagnos(?:ed|is)|cancer|chemotherap\w*|rehab(?:ilitation)?\b|addict(?:ed|ion)|overdos\w*|suicid\w*|mental (?:health|illness)|depress(?:ion|ed)|bipolar|schizophreni\w*|autis\w*|HIV|AIDS|pregnan\w*|miscarriage|abortion|disabilit(?:y|ies)|terminal(?:ly)? ill\w*|sexual orientation|\bgay\b|lesbian|bisexual|transgender|came out as|devout|practi[sc]ing (?:muslim|catholic|jew|christian|hindu|mormon|buddhist)|converted to (?:islam|christianity|judaism|hinduism|buddhism)|undocumented|immigration status|asylum seeker|green card|visa overstay)\b/i;

// Children and minors are never part of a report.
const MINOR = /\b(?:(?:his|her|their)\s+(?:\w+\s+)?(?:son|daughter|child|children|kids?|baby|toddler|newborn|infant|grand(?:son|daughter|child(?:ren)?))\b|(?:\d{1,2})[- ]year[- ]old\s+(?:son|daughter|child|boy|girl)|(?:son|daughter|child),?\s+(?:aged?\s+)?(?:\d|1[0-7])\b|kindergarten|elementary school|middle school|(?:in|at)\s+high school|minor child|custody (?:battle|dispute|of)|birth of (?:his|her|their))\b/i;

/** True when a sentence is about a protected or intimate matter. */
export function isSensitive(text) {
  return SENSITIVE.test(String(text || ''));
}

/** True when a sentence is about a child or minor. */
export function mentionsMinor(text) {
  return MINOR.test(String(text || ''));
}

/**
 * Apply every rule to one finding. Returns the cleaned finding, or null when
 * it must not be used at all. `finding` is { title, quote, url, ... }.
 */
export function sanitizeFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  if (finding.url && isBlockedUrl(finding.url)) return null;
  const title = redactPII(finding.title);
  const quote = redactPII(finding.quote);
  if (isSensitive(`${title} ${quote}`) && finding.category !== 'litigation' && finding.category !== 'regulatory' && finding.category !== 'sanctions') {
    // Court and regulator records are kept (they are the public record); anything else about protected matters is dropped.
    return null;
  }
  if (mentionsMinor(`${title} ${quote}`)) return null;
  return { ...finding, title, quote };
}

/** Clean a list of findings, dropping the ones that must not be used. */
export function sanitizeFindings(findings) {
  return (findings || []).map(sanitizeFinding).filter(Boolean);
}

export const USE_NOTICE =
  'This is a research aid built from public records and published sources, for investment diligence. It is not a consumer report and must not be used for employment, tenancy, credit or insurance decisions. Records are matched by name and context; confirm identity and every finding with the cited source before relying on it.';
