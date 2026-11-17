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
 *  - sentences about protected or intimate matters (health, including
 *    substance use, religion, sexuality, immigration status) and about
 *    children are dropped;
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
  'fastbackgroundcheck.com', 'advancedbackgroundchecks.com', 'peoplefinder.com', 'usa-people-search.com', 'infotracer.com',
  'peoplewhiz.com', '411.info', 'spytox.com',
];

// Host names that mark a people-search or records-broker site not yet on the list above.
const BROKER_HOST = /(?:people|person)-?(?:search|finder|lookup|looker|whiz)|background-?checks?|public-?records|phone-?lookup|reverse-?(?:phone|address)|mugshot|arrests?\.|truepeople|whitepages|(?:^|\.)411\./i;
// Government and court hosts are public bodies, not brokers, whatever their name says.
const PUBLIC_BODY_HOST = /\.(?:gov|mil)(?:\.[a-z]{2})?$|\.gouv\.[a-z]{2}$|\.gc\.ca$|\.[a-z]{2}\.us$|(?:^|\.)courts?\./i;

const hostOf = (url) => {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};

/** True when a URL is on (or under) a blocked host. */
export function isBlockedUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  if (BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`))) return true;
  return BROKER_HOST.test(host) && !PUBLIC_BODY_HOST.test(host);
}

const STREET = '(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Square|Sq|Trail|Trl|Crescent|Cres|Close|Row|Alley|Loop|Gardens|Gdns|Mews|Strasse)';
// Street words that are also common place names ("Menlo Park", "Capitol Hill"): only after a house number that is not a year
const STREET_PLACE = '(?:Hill|Park|Green|Grove|Rise|Walk)';
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

const REDACTIONS = [
  // the birth date in an encyclopedia lede goes whole: "Jane Doe (born 3 March 1984) is", "(Hebrew: ...; born 1984)"
  [/\s*\(([^()]*?)[;,]?\s*\bborn\b(?=[^()]*\d)[^()]*\)/gi, (m, before) => (before.trim() ? ` (${before.trim()})` : '')],
  // email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email removed]'],
  // US social security numbers and similar national identifiers
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ID number removed]'],
  [/\b(?:SSN|social security(?: number)?|national insurance(?: number)?|passport(?: number| no\.?)?)\s*[:#]?\s*[A-Z0-9][A-Z0-9 -]{5,14}\b/gi, '[ID number removed]'],
  // phone numbers: +1 (415) 555-0100, 415-555-0100, +44 20 7946 0958. A run of years ("2021 2020 2021") is not a phone.
  [/(?<![\w/.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w/-])/g, (m) => (/^(?:(?:1[89]|20)\d{2}[\s.-]){2}(?:1[89]|20)\d{2}$/.test(m) ? m : '[phone removed]')],
  // phone numbers written as one run of digits, when the text around them says it is a phone: "call 4155550100"
  [/(?<![\w/.+-])\+?\d{10,12}(?![\w/-])/g, (m, offset, text) => (/\b(?:call|phone|tel|telephone|mobile|cell|whatsapp)\b/i.test(text.slice(Math.max(0, offset - 40), offset)) ? '[phone removed]' : m)],
  // street addresses: "1234 Elm Street", "12 Kensington Gardens", with an optional unit
  [new RegExp(`\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z][A-Za-z'.-]+\\s+){1,4}${STREET}\\b\\.?(?:,?\\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\\.?\\s*[A-Za-z0-9-]+)?`, 'g'), '[address removed]'],
  [new RegExp(`\\b(?!(?:1[89]|20)\\d{2}\\b)\\d{1,5}\\s+(?:[A-Z][A-Za-z'.-]+\\s+){1,4}${STREET_PLACE}\\b(?:,?\\s*(?:Apt|Apartment|Suite|Ste|Unit|#|Flat)\\.?\\s*[A-Za-z0-9-]+)?`, 'g'), '[address removed]'],
  // French and German forms: "12 rue de Rivoli", "Friedrichstraße 43"
  [/\b(?!(?:1[89]|20)\d{2}\b)\d{1,4}(?:\s*(?:bis|ter))?,?\s+(?:[Rr]ue|[Aa]venue|[Bb]oulevard|[Bb]d|[Aa]ll[ée]e|[Ii]mpasse|[Cc]hemin|[Qq]uai)\s+(?:(?:de|du|des|la|le|l'|d')\s*)*[A-ZÀ-Ý][\wÀ-ÿ'-]+(?:\s+[A-ZÀ-Ý][\wÀ-ÿ'-]+){0,3}/g, '[address removed]'],
  [/(?<![\wÀ-ÿ-])[A-ZÄÖÜ][a-zäöüß-]*(?:straße|strasse|gasse|allee)\s+\d{1,4}[a-z]?\b/g, '[address removed]'],
  // where someone lives: "lives in Palo Alto", "resides at ..."
  [/\b(?:lives|resides)\s+(?:at|in|on)\s+[^.;\n]+/gi, '[location removed]'],
  // full dates of birth: "born on March 3, 1984", "born 3 March 1984", "DOB: 03/03/1984" (the year alone is kept)
  [new RegExp(`\\b(born(?:\\s+on)?|date of birth|DOB|d\\.o\\.b\\.?)\\s*[:,]?\\s*(?:${MONTH}\\.?\\s+\\d{1,2},?\\s+(\\d{4})|\\d{1,2}\\s+${MONTH}\\.?,?\\s+(\\d{4})|\\d{1,2}[/.-]\\d{1,2}[/.-](\\d{2,4}))`, 'gi'), (m, lead, y1, y2, y3) => {
    const year = y1 || y2 || (y3 && y3.length === 4 ? y3 : '');
    if (/^born/i.test(lead)) return year ? `born in ${year}` : 'born [date removed]';
    return year ? `${lead} ${year}` : `${lead} [date removed]`;
  }],
  // month and year of birth (the Companies House form): "born March 1984", "Date of birth: March 1984", "DOB: 03/1984".
  // The year is kept after "born"; otherwise the whole date goes.
  [new RegExp(`\\b(born(?:\\s+(?:in|on))?|date of birth|DOB|d\\.o\\.b\\.?)\\s*[:,]?\\s*(?:${MONTH}\\.?,?\\s+(\\d{4})|\\d{1,2}[/.-](\\d{4}))\\b`, 'gi'), (m, lead, y1, y2) => (
    /^born/i.test(lead) ? `born in ${y1 || y2}` : `${lead} [date removed]`
  )],
];

/** Remove contact and locating details from a piece of quoted text. */
export function redactPII(text) {
  let out = String(text || '');
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

// Protected or intimate matters. A sentence that is about one of these is not
// investment diligence and is dropped, whatever the source.
const SENSITIVE = /\b(diagnos(?:ed|is)|cancer|chemotherap\w*|rehab(?:ilitation)?\b|addict(?:ed|ion)|overdos\w*|drug (?:ab)?use|substance (?:ab)?use|(?:us(?:e|ed|es|ing)|snort\w*|smok\w*)\s+(?:of\s+)?(?:cocaine|marijuana|cannabis|ketamine|heroin|meth\w*)|(?:cocaine|marijuana|cannabis|ketamine|heroin)\s+(?:use|habit|binges?|abuse)|alcoholism|alcoholics?\b(?!\s+(?:beverages?|drinks?|brands?|spirits|products?|content|sales))|drinking problem|(?:heavy|binge|problem) drinking|suicid\w*|mental (?:health|illness)|depress(?:ion|ed)|bipolar|schizophreni\w*|autis\w*|HIV|AIDS|pregnan\w*|miscarriage|abortion|disabilit(?:y|ies)|terminal(?:ly)? ill\w*|sexual orientation|\bgay\b|lesbian|bisexual|transgender|came out as|devout|practi[sc]ing (?:muslim|catholic|jew|christian|hindu|mormon|buddhist)|converted to (?:islam|christianity|judaism|hinduism|buddhism)|undocumented|immigration status|(?:LDS|Mormon)\s+mission\w*|served (?:an? )?(?:LDS |Mormon |church )?mission\b|(?<!mercenar(?:y|ies),?\s+(?:vs\.?|versus|not|or|and|over)\s+(?:a\s+)?)missionar(?:y|ies)\b(?![\s,]+(?:vs\.?|versus|not|or|and|over)\s+(?:a\s+)?mercenar)|Shabbat|Sabbath observ\w*|keeps? kosher|synagogues?|Kabbalah|asylum seeker|green card|visa overstay|(?<!corporate |global )citizenship|naturali[sz](?:ed|ation)|H-?1B|work visa|residency permit|deport\w*|(?:as|was|were|an?|former)\s+refugees?\b(?!\s+(?:charit\w*|camps?|organi[sz]ations?|non-?profits?|programmes?|programs?|funds?|agenc\w*|council|crisis|resettlement|services|support|aid|relief|startups?|apps?|platforms?)\b))\b/i;
// Religion named as a person's own faith: "Jane Doe, a Mormon, founded ...", "is a devout Catholic who".
// Case-sensitive so that "the Catholic University" or "a Christian charity" are not caught.
const RELIGION = /\b(?:[Aa]n?|[Ii]s|[Ww]as|[Aa]s)\s+(?:(?:devout|practi[sc]ing|observant|born-again|lifelong)\s+)?(?:Hindu|Muslim|Mormon|Catholic|Jew|Jewish|Evangelical|Sikh|Buddhist|Christian|Baptist|Methodist|[Aa]theist)\b(?=\s*(?:[,.;:)!?]|$)|\s+(?:and|who|whose|by|from|since|himself|herself|man|woman|convert|family|faith|household|upbringing)\b)/;

// Children and minors are never part of a report.
const MINOR = /\b(?:(?:his|her|their)\s+(?:\w+\s+)?(?:son|daughter|child|children|kids?|baby|toddler|newborn|infant|grand(?:son|daughter|child(?:ren)?))\b|(?:\d{1,2})[- ]year[- ]old\s+(?:son|daughter|child|boy|girl)|(?:son|daughter|child),?\s+(?:aged?\s+)?(?:\d|1[0-7])\b|kindergarten|elementary school|middle school|(?:in|at)\s+high school|minor child|custody (?:battle|dispute|of)|birth of (?:his|her|their)|gave birth|gives? birth|giving birth|welcom(?:ed|es|ing)\s+(?:a\s+|their\s+|her\s+|his\s+)?(?:baby|son|daughter|child|twins)|baby (?:boy|girl)|newborn|stepchild(?:ren)?|expecting (?:a|their) (?:baby|child|first|second)|born to (?:him|her|them|the couple)|(?:father|mother|dad|mom|mum|parent)\s+(?:of|to)\s+(?:@\w+|\d+|two|three|four|five|six|twins|triplets|a\s+(?:boy|girl|son|daughter))\b(?!\s+(?:companies|startups|businesses|ventures|firms|brands|funds|products|patents|unicorns)\b))/i;
// A named child: "Elizabeth Holmes' son William", "a son, William". Case-sensitive: the name must be capitalised.
const NAMED_CHILD = /[A-Z][\w’'-]*[’']s?\s+(?:son|daughter|child|children|kids)\b(?![’'-]|\s+(?:safety|privacy|data|products?|apps?|services?|accounts?|online|protection|content)\b)|\b(?:[Aa]|[Tt]heir|[Oo]ne)\s+(?:son|daughter|child),?\s+[A-Z][a-z]+/;

/** True when a sentence is about a protected or intimate matter. */
export function isSensitive(text) {
  const s = String(text || '');
  return SENSITIVE.test(s) || RELIGION.test(s);
}

/** True when a sentence is about a child or minor. */
export function mentionsMinor(text) {
  const s = String(text || '');
  return MINOR.test(s) || NAMED_CHILD.test(s);
}

// Records from these connectors are official court, regulator or sanctions records (courts.js, sec.js,
// sanctions.js). Web, news and reference sources never get the public-record exemption, whatever category they carry.
const OFFICIAL_SOURCES = new Set([
  'court-dockets', 'court-records-open', 'doj-press-releases', 'finra-brokercheck', 'uk-gazette', 'uk-case-law', 'fr-bodacc',
  'us-enforcement-actions', 'sec-filings', 'sec-company', 'sanctions-lists', 'us-exclusions', 'wanted-lists',
]);
const OFFICIAL_CATEGORIES = new Set(['litigation', 'regulatory', 'sanctions']);

// Obituaries and funeral notices are about private family life and are the usual way a private namesake's
// record gets in. They are kept only when the record is confirmed as the subject's.
const OBITUARY_TITLE = /\bobituar\w*|\bfuneral (?:home|chapel|service|notice|arrangements?)\b|\bin memoriam\b|\b(?:pays?|paid) tributes?\b|\btributes? (?:to|for|pour|paid)\b|\bcelebration of life\b/i;
const OBITUARY_HOST = /obituar|funeral|(?:^|\.)legacy\.com$|(?:^|\.)tributes?\.com$/i;

/** True when a record is an obituary or funeral notice, by its title or its host. */
export function isObituary(finding) {
  return OBITUARY_TITLE.test(String(finding?.title || '')) || OBITUARY_HOST.test(hostOf(finding?.url));
}

/**
 * Apply every rule to one finding. Returns the cleaned finding, or null when
 * it must not be used at all. `finding` is { title, quote, url, ... }.
 */
export function sanitizeFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  if (finding.url && isBlockedUrl(finding.url)) return null;
  if (finding.match !== 'confirmed' && isObituary(finding)) return null;
  const title = redactPII(finding.title);
  let quote = redactPII(finding.quote);
  if (mentionsMinor(`${title} ${quote}`)) return null;
  if (isSensitive(`${title} ${quote}`)) {
    // Anything about protected matters is dropped, except an official court, regulator or sanctions record
    // (the public record). Even then the title must be clean and only the sentences about the case are kept.
    if (!OFFICIAL_SOURCES.has(finding.source) || !OFFICIAL_CATEGORIES.has(finding.category) || isSensitive(title)) return null;
    quote = quote.split(/(?<=[.;!?])\s+/).filter((s) => s && !isSensitive(s) && !mentionsMinor(s)).join(' ');
    if (!quote) return null;
  }
  return { ...finding, title, quote };
}

/** Clean a list of findings, dropping the ones that must not be used. */
export function sanitizeFindings(findings) {
  return (findings || []).map(sanitizeFinding).filter(Boolean);
}

export const USE_NOTICE =
  'This is a research aid built from public records and published sources, for investment diligence. It is not a consumer report and must not be used for employment, tenancy, credit or insurance decisions. Records are matched by name and context; confirm identity and every finding with the cited source before relying on it.';
