/**
 * Privacy guardrails for the deep background check and the quick brief.
 *
 * The check is for investment diligence on a founder or executive: public
 * records and published sources about their professional conduct. It is not
 * a people-search tool. These rules are applied to every finding from every
 * source, to search snippets in the quick brief, and to text a model wrote,
 * before anything is stored, shown or given to a model:
 *
 *  - people-search, data-broker and donation-record sites are never used;
 *  - contact and locating details are removed from quoted text (street
 *    addresses, P.O. boxes, phone numbers, email addresses, dates of birth and
 *    ages, national ID numbers);
 *  - sentences about protected or intimate matters (health, including
 *    substance use, religion, sexuality, immigration status, political
 *    donations), about children, and about relatives who have no stated
 *    business, political or philanthropic role are removed;
 *  - only the offending sentence goes: the rest of the record stays, so a
 *    founder's career record is not lost because one sentence in it was private.
 *
 * The one entry point for text is cleanSentences(); cleanModelText() is the
 * same for model-written text; cleanData() walks structured extras;
 * sanitizeFinding() applies everything to one finding.
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
  // political donation records are excluded by rule: the whole site is donor lookups
  'followthemoney.org',
];

// Donation-record pages on sites that are otherwise fine: the FEC's individual contribution search (donor's
// employer, city and ZIP) and OpenSecrets' donor lookups. The rest of those sites stays usable.
const BLOCKED_PATHS = [
  [/(?:^|\.)fec\.gov$/, /^\/(?:data\/receipts|data\/individual-contributions|cgi-bin\/qind)/i],
  [/(?:^|\.)opensecrets\.org$/, /^\/(?:donor-lookup|indivs|search)/i],
];

// Host names that mark a people-search or records-broker site not yet on the list above.
const BROKER_HOST = /(?:people|person)-?(?:search|finder|lookup|looker|whiz)|background-?checks?|public-?records|phone-?lookup|reverse-?(?:phone|address)|mugshot|arrests?\.|truepeople|whitepages|(?:^|\.)411\./i;
// Government and court hosts are public bodies, not brokers, whatever their name says.
const PUBLIC_BODY_HOST = /\.(?:gov|mil)(?:\.[a-z]{2})?$|\.gouv\.[a-z]{2}$|\.gc\.ca$|\.[a-z]{2}\.us$|(?:^|\.)courts?\./i;

const parseUrl = (url) => {
  try { return new URL(String(url)); } catch { return null; }
};
const hostOf = (url) => (parseUrl(url)?.hostname || '').toLowerCase().replace(/^www\./, '');

/** True when a URL is on (or under) a blocked host, or is a donation-record page. */
export function isBlockedUrl(url) {
  const u = parseUrl(url);
  const host = (u?.hostname || '').toLowerCase().replace(/^www\./, '');
  if (!host) return false;
  if (BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`))) return true;
  if (BLOCKED_PATHS.some(([h, p]) => h.test(host) && p.test(u.pathname))) return true;
  return BROKER_HOST.test(host) && !PUBLIC_BODY_HOST.test(host);
}

/**
 * True only for an absolute http or https link. Anything else (javascript:, data:, vbscript:, file:,
 * protocol-relative "//host", relative paths, text with control characters) is refused, because a link
 * a source scraped is rendered as <a href> and React does not block script links.
 */
export function isSafeUrl(url) {
  if (typeof url !== 'string' && !(url instanceof URL)) return false;
  const s = String(url).trim();
  // a control character or whitespace inside the link can hide a scheme ("java\nscript:")
  if (!s || /[\u0000-\u001F\u007F\s]/.test(s)) return false;
  if (!/^https?:\/\/[^/]/i.test(s)) return false;
  const u = parseUrl(s);
  return Boolean(u && (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname);
}

/** The link trimmed, or null when it is not an absolute http(s) link. For href attributes. */
export function safeHref(url) {
  return isSafeUrl(url) ? String(url).trim() : null;
}

const STREET = '(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Square|Sq|Trail|Trl|Crescent|Cres|Close|Row|Alley|Loop|Gardens|Gdns|Mews|Strasse)';
// Street words that are also common place names ("Menlo Park", "Capitol Hill"): only after a house number that is not a year
const STREET_PLACE = '(?:Hill|Park|Green|Grove|Rise|Walk)';
// A street name word: capitalised ("Elm"), or a numbered street ("5th", "42nd")
const STREET_NAME = "(?:[A-Z][A-Za-z'.-]+|\\d{1,3}(?:st|nd|rd|th))";
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?![a-z])';
const DAY = '\\d{1,2}(?:st|nd|rd|th)?';
const YEAR = '(?:1[89]|20)\\d{2}';
// Every common shape of a date, longest first: "March 3, 1984", "3rd of March 1984", "March 1984",
// "1984-03-03", "03/03/1984", "03/1984", "March 3" (a birthday), "3 March", "1984".
const DATE = `(?:${MONTH}\\.?\\s+${DAY},?\\s+${YEAR}|${DAY}\\s+(?:of\\s+)?${MONTH}\\.?,?\\s+${YEAR}|${MONTH}\\.?,?\\s+${YEAR}|${YEAR}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|\\d{1,2}[/.-]${YEAR}|${MONTH}\\.?\\s+${DAY}|${DAY}\\s+(?:of\\s+)?${MONTH}|${YEAR})(?![\\w/])`;
// A date with its day: what a bracket right after a two-word name holds when it is a birth date ("Jane Doe (March 3, 1984)")
// (month names only: an ISO date in brackets is a record date, "Before (2013-05-12)")
const BIRTH_PAREN_DATE = `(?:${MONTH}\\.?\\s+${DAY},?\\s+${YEAR}|${DAY}\\s+(?:of\\s+)?${MONTH}\\.?,?\\s+${YEAR})`;
// What a company is, so "a 5-year-old company" keeps its age
const BUSINESS_NOUN = '(?:company|companies|startup|firm|business|brand|fund|platform|product|venture|partnership|program|programme|policy|law|case|lawsuit|dispute|record|deal|unit|subsidiary|bank|group|charity|foundation|project|app|website|site|model|plan|contract|loan|debt|building|car|truck|vehicle|patent)';
// The text before a street line that says it is a person's address, even in a register entry
const PERSONAL_ADDRESS_CUE = /\b(?:correspondence|residential|home|service|usual) address\b|\bresid(?:es|ent|ing|ence)\b|\blives?\b|\bhome\b/i;

const has5Digits = (m) => (m.match(/\d/g) || []).length >= 5;

/**
 * [pattern, replacement, reason, { street: true } when it is a street line a company register may keep].
 * Order matters: brackets holding a birth date go whole before the date rules see them.
 */
const REDACTIONS = [
  // the birth date in an encyclopedia lede goes whole: "Jane Doe (born 3 March 1984) is", "(Hebrew: ...; born 1984)", "(b. 1984)"
  [/\s*\(([^()]*?)[;,]?\s*(?:\bborn\b|(?<![\w.])b\.)(?=[^()]*\d)[^()]*\)/gi, (m, before) => (before.trim() ? ` (${before.trim()})` : ''), 'dob'],
  // a bracket after a capitalised name that holds only a full date: "Trevor Milton (April 6, 1982) is"
  [new RegExp(`(?<=\\b[A-Z][\\w'’.-]*\\s+(?:[A-Z]\\.\\s+)?[A-Z][\\w'’.-]*)\\s*\\(\\s*${BIRTH_PAREN_DATE}\\s*(?:[–—-]\\s*(?:present)?\\s*)?\\)`, 'g'), '', 'dob'],
  // ages: "(age 44)", ", aged 34,", "age: 34" (not "at age 19", an age at an event), "34-year-old founder", "Jane Doe, 34,"
  [/\s*\(\s*(?:age[ds]?|aged)\s*:?\s*\d{1,3}\s*\)/gi, '', 'age'],
  [/,\s*aged?\s+\d{1,3}\s*(?=[,.;)]|$)/gi, '', 'age'],
  [/(?<!\bat\s)(?<!\bthe\s)(?<!\bof\s)(?<!\bfor\s)(?<!\bunder\s)\b(?:age[ds]?|aged)\s*:?\s+\d{1,3}\b(?!\s*(?:%|percent|years? ago))/gi, '[age removed]', 'age'],
  [new RegExp(`\\b\\d{1,3}[- ]years?[- ]old\\s+(?!${BUSINESS_NOUN}\\b)(?=[a-z])`, 'g'), '', 'age'],
  [new RegExp(`\\b\\d{1,3}[- ]years?[- ]old\\b(?![- ]?${BUSINESS_NOUN}\\b)`, 'gi'), '[age removed]', 'age'],
  [/(\b[A-Z][a-z'’-]+),\s(?:1[89]|[2-9]\d),(?=\s)/g, '$1,', 'age'],
  // a bare age in brackets right after a name, as UK and German press write it: "Doe (44) founded" (not a year
  // "(2019)", nor a footnote "(4)")
  [/(?<=\b[A-Z][\w'’.-]*[a-z][\w'’.-]*)\s*\(\s*(?:1[89]|[2-9]\d)\s*\)(?!\s*[-–\d])/g, '', 'age'],
  // "turned 40", "turning fifty" (not "turned 40 stores into", "turned 10 percent")
  [/\bturn(?:ed|s|ing)\s+(?:\d{2}|thirty|forty|fifty|sixty|seventy|eighty)\b(?!\s*(?:%|percent|per cent|million|billion|thousand|[a-z]+s\b|[a-z]+\s+(?:into|in)\b))/gi, '[age removed]', 'age'],
  // "his 40th birthday", "her fortieth birthday": the birthday may stay, the age goes
  [/\b(?:\d{1,3}(?:st|nd|rd|th)|(?:twent|thirt|fort|fift|sixt|sevent|eight|ninet)ieth|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-\w+(?:st|nd|rd|th))\s+(birthday)\b/gi, '$1', 'age'],
  // email addresses, and the spelled-out kind: "jane [at] gmail [dot] com"
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email removed]', 'email'],
  [/[\w.%+-]+\s*[[({]\s*at\s*[\])}]\s*[\w-]+(?:\s*(?:[[({]\s*dot\s*[\])}]|\.)\s*[\w-]+)+/gi, '[email removed]', 'email'],
  // spelled out without brackets: "jane dot doe at gmail dot com". Only when the name part has a "dot" or the text
  // before says it is an address, so "worked at Acme dot com" is not read as an email.
  [/\b[\w%+-]+(?:\s+dot\s+[\w%+-]+)*\s+at\s+[\w-]+(?:\s+dot\s+[\w-]+)*\s+dot\s+(?:com|org|net|io|co|edu|gov|ai|me|uk|fr|de|in|us|ca|au|info|biz)\b/gi,
    (m, offset, text) => (/^\S+\s+dot\s/i.test(m) || /\b(?:e-?mail|mail|contact|write to|reach (?:him|her|them)|address)\b[^.;\n]{0,20}$/i.test(text.slice(Math.max(0, offset - 30), offset)) ? '[email removed]' : m), 'email'],
  // US social security numbers and similar national identifiers
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ID number removed]', 'id'],
  [/\b(?:SSN|social security(?: number)?|national insurance(?: number)?|passport(?: number| no\.?)?|driver['’]?s? licen[cs]e(?: number| no\.?)?|national (?:ID|identity)(?: card)?(?: number| no\.?)?|ID card(?: number| no\.?)?|tax ID(?: number)?|Aadhaar(?: number)?|NI (?:number|no\.?)|NINO)\s*[:#]?\s*(?=[A-Z0-9 -]{0,15}\d)[A-Z0-9][A-Z0-9-]{3,}(?:[ ]\d[A-Z0-9-]*){0,3}/gi, '[ID number removed]', 'id'],
  // UK national insurance number: "QQ 12 34 56 C"
  // (spaced form only: unspaced it is indistinguishable from a patent or product number such as "MX387190B")
  [/\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] \d{2} \d{2} \d{2} [A-D]\b/g, '[ID number removed]', 'id'],
  // international numbers: "+33 1 42 68 53 00", "+49 30 12345678", "+91 98765 43210": a country code, then 7 to 14 more
  // digits in groups of 1 to 8
  [/(?<![\w/.+-])\+\d{1,3}(?:[\s.-]?\(?\d{1,8}\)?){1,6}(?![\w/-])/g, (m) => { const n = (m.match(/\d/g) || []).length; return n >= 8 && n <= 15 ? '[phone removed]' : m; }, 'phone'],
  // French national numbers: "06 12 34 56 78", "01.42.68.53.00"
  [/(?<![\w/.+-])0[1-9](?:[\s.-]\d{2}){4}(?![\w/-])/g, '[phone removed]', 'phone'],
  // any spaced run of 8 or more digits when the text just before says it is a phone: "mobile: 4155 5501 00"
  [/(\b(?:call|calls|phone|tel|telephone|mobile|cell|line|whatsapp|fax|reach (?:him|her|them) (?:at|on))\b[^\d\n+]{0,15})(\+?\d[\d\s().-]{6,}\d)/gi,
    (m, lead, num) => ((num.match(/\d/g) || []).length >= 8 && !/^(?:(?:1[89]|20)\d{2}[\s.-]*)+$/.test(num) ? `${lead}[phone removed]` : m), 'phone'],
  // UK phone numbers: "07700 900123", "+44 7700 900123", "+44 (0)20 7946 0958". The 0 form needs a space or dash,
  // so a company number ("0412345678") is not read as a phone.
  [/(?<![\w/.+-])(?:\+44\s?(?:\(0\)\s?)?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}|\(?0\d{2,4}\)?[\s.-]\d{3,4}[\s.-]?\d{3,4})(?![\w/-])/g, '[phone removed]', 'phone'],
  // phone numbers: +1 (415) 555-0100, 415-555-0100, +44 20 7946 0958. A run of years ("2021 2020 2021") is not a phone.
  // Without a + or brackets the last group has four digits, so a register number ("SIREN 123 456 789") or a share
  // count ("12 345 678 shares") is not read as a phone.
  [/(?<![\w/.-])(?:\+\d{1,3}[\s.-]?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}|\(\d{2,4}\)[\s.-]?\d{3,4}[\s.-]\d{3,4}|\d{2,4}[\s.-]\d{3,4}[\s.-]\d{4})(?![\w/-])/g, (m) => (/^(?:(?:1[89]|20)\d{2}[\s.-]){2}(?:1[89]|20)\d{2}$/.test(m) ? m : '[phone removed]'), 'phone'],
  // phone numbers written as one run of digits, when the text around them says it is a phone: "call 4155550100"
  [/(?<![\w/.+-])\+?\d{10,12}(?![\w/-])/g, (m, offset, text) => (/\b(?:call|phone|tel|telephone|mobile|cell|whatsapp)\b/i.test(text.slice(Math.max(0, offset - 40), offset)) ? '[phone removed]' : m), 'phone'],
  // a phone number cut off where the text was clipped ("call 415-555-01…"): the digits left are still a phone
  [/(\b(?:call|phone|tel|telephone|mobile|cell|fax|whatsapp|reach (?:him|her|them) at)\b[:.]?\s*)\+?[\d(][\d\s().-]{3,}(?:…|\.\.\.)?\s*$/i, '$1[phone removed]', 'phone'],
  [/(?<![\w/.-])\+?\(?\d[\d\s().-]{4,}(?:…|\.\.\.)\s*$/, (m) => (has5Digits(m) && /[\s().-]/.test(m.replace(/(?:…|\.\.\.)\s*$/, '')) ? '…' : m), 'phone'],
  // P.O. boxes, with the town and ZIP that follow
  [/\b(?:P\.?\s?O\.?|Post Office)\s*Box\s+\d+(?:,?\s+[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3})?(?:,?\s+[A-Z]{2})?(?:\s+\d{5}(?:-\d{4})?)?/gi, '[address removed]', 'address', { street: true }],
  // street addresses: "1234 Elm Street", "123 5th Avenue", "12 Kensington Gardens", with an optional unit
  [new RegExp(`\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:${STREET_NAME}\\s+){1,4}${STREET}\\b\\.?(?:,?\\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\\.?\\s*[A-Za-z0-9-]+)?`, 'g'), '[address removed]', 'address', { street: true }],
  [new RegExp(`\\b(?!(?:1[89]|20)\\d{2}\\b)\\d{1,5}\\s+(?:[A-Z][A-Za-z'.-]+\\s+){1,4}${STREET_PLACE}\\b(?:,?\\s*(?:Apt|Apartment|Suite|Ste|Unit|#|Flat)\\.?\\s*[A-Za-z0-9-]+)?`, 'g'), '[address removed]', 'address', { street: true }],
  // a street written in lower case: "home at 12 main street" (full street words only, so "the road" in prose is safe)
  [/\b(?!(?:1[89]|20)\d{2}\b)\d{1,5}\s+(?:[a-z][a-z'.-]+\s+){1,2}(?:street|avenue|road|drive|lane|boulevard)\b/g, '[address removed]', 'address', { street: true }],
  // French and German forms: "12 rue de Rivoli", "Friedrichstraße 43"
  [/\b(?!(?:1[89]|20)\d{2}\b)\d{1,4}(?:\s*(?:bis|ter))?,?\s+(?:[Rr]ue|[Aa]venue|[Bb]oulevard|[Bb]d|[Aa]ll[ée]e|[Ii]mpasse|[Cc]hemin|[Qq]uai)\s+(?:(?:de|du|des|la|le|l'|d')\s*)*[A-ZÀ-Ý][\wÀ-ÿ'-]+(?:\s+[A-ZÀ-Ý][\wÀ-ÿ'-]+){0,3}/g, '[address removed]', 'address', { street: true }],
  [/(?<![\wÀ-ÿ-])[A-ZÄÖÜ][a-zäöüß-]*(?:straße|strasse|gasse|allee)\s+\d{1,4}[a-z]?\b/g, '[address removed]', 'address', { street: true }],
  // where someone lives: "lives in Palo Alto", "resides at ..."
  [/\b(?:lives|resides)\s+(?:at|in|on)\s+[^.;\n]+/gi, '[location removed]', 'location'],
  // "a 1984-born entrepreneur": the year goes and the article is mended
  [new RegExp(`\\b(?:(an?)\\s+)?${YEAR}-born\\s+(?=\\S)`, 'gi'), (m, art, offset, text) => {
    if (!art) return '';
    const an = /^[aeiou]/i.test(text.slice(offset + m.length)) ? 'an' : 'a';
    return `${art[0] === 'A' ? an[0].toUpperCase() + an.slice(1) : an} `;
  }, 'dob'],
  // "born in the spring of 1984", "born in late 1984", "born during the summer of 1984": the time goes, a place stays
  [new RegExp(`\\b([Bb]orn)\\s+(?:in|during)\\s+(?:the\\s+)?(?:(?:spring|summer|autumn|fall|winter|early|late|middle|mid|first half|second half|beginning|end|start)(?:\\s+(?:months|part|days))?\\s+of\\s+|(?:early|late|mid)[- ]?)${YEAR}s?\\b`, 'g'), (m, lead, offset, text) => (/^\s*,?\s+(?:in|at)\s+[A-Z]/.test(text.slice(offset + m.length)) ? lead : `${lead} [date removed]`), 'dob'],
  // "born in Ohio in 1984": the place may stay, the year goes
  [new RegExp(`\\b([Bb]orn\\s+(?:in|at)\\s+[A-Z][^.;\\n\\d]{0,40}?)\\s*,?\\s+(?:in|on)\\s+${DATE}`, 'g'), '$1', 'dob'],
  // dates of birth after "born", in every shape, the year alone included ("born 1995", "Born Trevor Milton April 6, 1982",
  // "born on March 3, 1984 in Lyon"). The date and its preposition go; "born in Lyon" stays.
  [new RegExp(`\\b([Bb]orn|BORN)(\\s*:)?\\s+((?:[A-Z][\\w'’-]*\\.?\\s+){0,5}?)(?:(?:on|in)\\s+)?(?:the\\s+)?${DATE}`, 'g'), (m, lead, colon, names, offset, text) => {
    if (names.trim()) return `${lead} ${names.trim()}`;
    const after = text.slice(offset + m.length);
    return /^\s*,?\s+(?:in|at)\s+[A-Z]/.test(after) ? lead : `${lead} [date removed]`;
  }, 'dob'],
  // the other leads: "Date of birth: 1984-03-03", "Birth date: 03 March 1984", "DOB: 03/1984", "her birthday is March 3", "b. 1984"
  [new RegExp(`\\b(date of birth|birth ?date|DOB|D\\.O\\.B\\.?|birthday(?:\\s+(?:is|was|falls on))?)\\s*[:,]?\\s*(?:on\\s+)?(?:the\\s+)?${DATE}`, 'gi'), (m, lead) => `${lead} [date removed]`, 'dob'],
  [new RegExp(`(?<![\\w.])b\\.\\s*${DATE}`, 'g'), '[date removed]', 'dob'],
];

/** Redact one piece of text and count what went, by reason. */
function redactCounted(text, { keepStreets = false } = {}, removed = null) {
  let out = String(text ?? '');
  // a register entry keeps its office street line, but never one that says it is where a person lives
  const keepStreetHere = keepStreets && !PERSONAL_ADDRESS_CUE.test(out);
  for (const [re, replacement, reason, flags] of REDACTIONS) {
    if (flags?.street && keepStreetHere) continue;
    re.lastIndex = 0;
    out = out.replace(re, (...args) => {
      const m = args[0];
      // a string replacement may name groups ("$1"); the groups are the arguments before the offset
      const groups = args.slice(1, args.findIndex((a) => typeof a === 'number'));
      const rep = typeof replacement === 'function' ? replacement(...args) : replacement.replace(/\$(\d)/g, (_, i) => groups[Number(i) - 1] ?? '');
      if (rep !== m && removed) removed[reason] = (removed[reason] || 0) + 1;
      return rep;
    });
  }
  return tidy(out);
}

const tidy = (s) => s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.;:!?])/g, '$1').replace(/,\s*,/g, ',').replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').trim();

/** Remove contact and locating details (and birth dates and ages) from a piece of quoted text. */
export function redactPII(text, opts = {}) {
  return redactCounted(text, opts);
}

// ---------------------------------------------------------------------------------------------------------
// Protected or intimate matters. A sentence that is about one of these is not investment diligence and is
// removed, whatever the source. Health words count only when they describe a person ("he was diagnosed",
// "her depression"), not a company's business ("a diabetes-care startup", "Theranos, a blood-testing company").

// Conditions a person has. Used only together with a person-tying verb or a possessive pronoun.
const HEALTH_TERM = "(?:cancer|tumou?rs?|leuka?emia|lymphoma|melanoma|diabetes|depression|anxiety|bipolar(?: disorder)?|schizophrenia|autism|ADHD|dyslexia|disabilit(?:y|ies)|illness|diseases?|pregnancy|miscarriage|abortion|addiction|alcoholism|surgery|(?:a |mild |minor |major )?stroke(?! of)|heart attack|heart condition|seizures?|epilepsy|Parkinson['’]?s(?: disease)?|Alzheimer['’]?s(?: disease)?|dementia|diagnosis|mental health|mental illness|eating disorder|anorexia|bulimia|PTSD|OCD|chemotherapy|radiation therapy|infertility|IVF|(?:multiple )?sclerosis|ALS|lupus|long COVID|COVID(?:-19)?|concussion|burnout|insomnia|obesity|transplant|hepatitis|tuberculosis|coma|overdose|sobriety|rehab|HIV|AIDS)";
// What a health word is followed by when it names a company's business, not a person's condition
// (also the people a company serves, "diabetes customers", and a company's pandemic, "a COVID-19 lockdown")
const HEALTH_BUSINESS = '(?![-–]|\\s+(?:startups?|compan(?:y|ies)|care|tech|apps?|platforms?|benefits|insurance|business(?:es)?|products?|services?|ventures?|funds?|clinics?|portfolio|investments?|sector|industry|research|space|market|tests?|testing|screening|drugs?|therap(?:y|ies)|treatments?|diagnostics?|devices?|patients|customers|clients|members|users|consumers|employees|workers|charit(?:y|ies)|non-?profits?|foundation|awareness|prevention|cent(?:er|re)s?|hospitals?|programs?|programmes?|coverage|data|records|systems?|solutions?|software|management|providers?|network|organi[sz]ations?|initiatives?|trials?|stud(?:y|ies)|medications?|medicines?|vaccines?|detection|monitoring|outcomes|polic(?:y|ies)|support|teams?|units?|advocacy|groups?|communit(?:y|ies)|ward|wing|space|experts?|specialists?|sufferers|survivors|outbreaks?|pandemic|epidemic|crisis|scare|cure|robots?|tools?|kits?|lockdowns?|restrictions|response|rules|mandates?|relief|loans?|era|shutdowns?|closures?|guidelines|protocols?|precautions|disruptions?|impact|downturn|slump|boom|surge|waves?|cases|deaths|rates?|costs?)\\b)';
// A health word whose subject is other people (patients, women, members, customers) is about a company's business or
// a matter it is accused of, not the person's own health: "Three patients were hospitalized", "patients were
// diagnosed with conditions they did not have", "led some patients to be wrongly diagnosed". The guard reads back to
// the nearest such noun in the same clause; a pronoun, a possessive or "and" in between gives the verb another
// subject ("she treated patients and was diagnosed with cancer" is still about her).
const THIRD_PARTY = '(?:patients|women|men|mothers|people|persons|customers|clients|members|users|consumers|employees|workers|veterans|adults|individuals|residents|participants|subjects|victims|families|students|babies|infants|seniors)';
const NOT_THIRD = `(?<!\\b${THIRD_PARTY}\\b(?:(?!\\b(?:he|she|I|his|her|and|but|about|told|tells|telling|informed)\\b)[^,.;:\\n]){0,40})`;
const HEALTH_VERB = "(?:diagnos(?:ed|is) (?:with|of)|(?:cit(?:ed|es|ing)|blam(?:ed|es|ing)|disclos(?:ed|es|ing)|reveal(?:ed|s|ing)|(?:spoke|speaks|spoken|talked|talks|opened up|wrote|writes|written) (?:publicly )?about|pointed to)(?:\\s+(?:his|her|their))?|treated for|(?:treatment|treated|hospitali[sz]ed|surgery|care) for(?:\\s+(?:his|her|their))?|suffer(?:s|ed|ing)? (?:from|an?)|had|has|have|having|underwent|undergoing|undergone|recover(?:ing|ed|s)? from|struggl(?:e|es|ed|ing) with|(?:he|she|I) (?:is |was )?(?:living|lives|lived) with|(?:battl(?:e|es|ed|ing)|fight(?:s|ing)?|fought|bout|bouts) (?:with|against)(?:\\s+(?:his|her|their))?|battl(?:e|es|ed|ing) (?:his|her|their)|died (?:of|from|after)|dies (?:of|from|after)|succumbed to|complications (?:of|from)|hospitali[sz]ed (?:for|with|after)|leave (?:for|after)|after (?:a|an|his|her|their))";
const HEALTH_MOD = "(?:an?\\s+|the\\s+|stage\\s+\\w+\\s+|(?:advanced|severe|chronic|mild|minor|major|early[- ]onset|breast|lung|brain|prostate|pancreatic|colon|skin|ovarian|clinical|postpartum|terminal|rare|serious|recurring|undisclosed|unspecified|heart|knee|back|emergency|long|lengthy|lifelong|years-long|ongoing|private|public|recent|second|first)\\s+)*";
const HEALTH_PERSON = new RegExp(
  `${NOT_THIRD}\\b${HEALTH_VERB}\\s+${HEALTH_MOD}${HEALTH_TERM}\\b${HEALTH_BUSINESS}`
  // "his cancer", "her depression", "their mental health": a possessive pronoun, then up to two words that are not
  // a company's ("her company's diabetes product" stays)
  + `|\\b(?:his|her|their|my)\\s+(?:(?!compan|startup|firm|business|team|employee|customer|patient|user|client|product|app\\b|platform|investor|portfolio|fund\\b)[a-z'’-]+\\s+){0,2}${HEALTH_TERM}\\b${HEALTH_BUSINESS}`
  // "his long battle with depression": a possessive, then up to four words that include a fight or a struggle
  + `|\\b(?:his|her|their|my)\\s+(?:[a-z'’-]+\\s+){0,3}(?:battle|fight|struggle|bout)s?\\s+(?:with|against)\\s+${HEALTH_MOD}${HEALTH_TERM}\\b${HEALTH_BUSINESS}`,
  'i',
);
// Health phrasings that are about a person on their own. The ones that can also describe the people a company
// serves (diagnosed, treated for, hospitalized, pregnant, drug use) are tied to a person: never after a plural
// third-party noun in the same clause, and "pregnant" never before the people a company serves ("pregnant women").
const HEALTH_ALWAYS = new RegExp(
  `${NOT_THIRD}\\bdiagnosed\\b(?!\\s+(?:patients|cases|conditions))`
  + `|${NOT_THIRD}\\btreated for\\b(?!\\s+(?:free|less|nothing))`
  + `|${NOT_THIRD}\\b(?:undergo(?:es|ing|ne)?|underwent|(?:seek|sought|seeking|receiv(?:e|ed|es|ing)|get(?:s|ting)?|got|enter(?:ed|s|ing)?|began|begin|start(?:ed|ing)?)\\s+(?:medical\\s+)?treatment)\\s+(?:for\\b|in\\b|at\\b|after\\b)`
  + `|${NOT_THIRD}\\bundergo(?:es|ing|ne)?\\s+(?:medical\\s+)?treatment\\b|${NOT_THIRD}\\bunderwent\\s+(?:medical\\s+)?treatment\\b`
  + `|${NOT_THIRD}\\bhospitali[sz](?:ed|ation)\\b(?!\\s+(?:rates?|costs?|data))`
  + '|\\bpsychiatric (?:hospital|ward|facility|unit|clinic|care|treatment|evaluation|hold)\\b(?!\\s+(?:startups?|compan\\w*|software|platforms?|apps?|providers?|services|beds|market|industry|chains?|operators?|systems?|staff|workers))|\\bmental (?:health )?(?:facility|institution|hospital|asylum)\\b(?!\\s+(?:startups?|compan\\w*|software|platforms?|operators?|chains?))'
  + '|\\bmedical leave\\b(?!\\s+(?:polic\\w*|act|law|benefits?))|\\bsick leave\\b(?!\\s+(?:polic\\w*|act|law|benefits?))'
  + '|\\brehab\\b(?![-\\s]+(?:startups?|compan\\w*|clinics?|cent(?:er|re)s?|apps?|platforms?|facilit\\w+|chains?|business\\w*|providers?|services|robots?|devices?|tech\\w*|market|industry))'
  + '|\\bsober (?:since|for|living)\\b|\\bsobriety\\b|\\b(?:got|stayed|stay|getting) sober\\b|\\boverdos(?:ed|ing)\\b'
  // pregnant: whoever it describes, unless it describes the people a company serves ("pregnant women", "pregnant patients")
  + `|${NOT_THIRD}\\bpregnant\\b(?!\\s+(?:${THIRD_PARTY}|wom[ae]n|mothers?|people|workers?|employees?|patients?|customers?|users?|members?|individuals?|persons?|teens|mice|rats|animals|cows|ewes)\\b)`
  + '|\\bmiscarriage\\b(?!\\s+of\\s+justice)|\\b(?:entered|checked into|went to|time in|stint in) (?:a )?(?:treatment|detox)|\\bdetox\\b(?![-\\s]+(?:startups?|compan\\w*|products?|drinks?|tea|juices?|apps?))'
  + '|\\bterminal(?:ly)? ill\\w*|\\b(?:died by|committed|attempted|contemplated) suicide\\b|\\bsuicide attempt|\\bsuicidal\\b|\\btook (?:his|her|their) own life\\b|\\b(?:nervous|mental) breakdown\\b|\\b(?:addicted to|struggled with addiction)\\b'
  // drug use only when it is a person's: "his drug use", "she admitted to drug use", "a history of drug use"
  + '|\\b(?:his|her|their|my)\\s+(?:[a-z\'’-]+\\s+){0,2}(?:drug|substance|alcohol) (?:ab)?use\\b|\\b(?:he|she|I)\\b(?:(?!\\b(?:patients|customers|users|members)\\b)[^,.;:\\n]){0,40}\\b(?:drug|substance) (?:ab)?use\\b|\\b(?:history of|recreational|past|admitted|admits|alleged|reported) (?:to )?(?:drug|substance) (?:ab)?use\\b|\\b(?:drug|substance) (?:ab)?use by (?:him|her|the (?:founder|CEO|executive|defendant|accused|respondent|plaintiff))\\b'
  + '|(?:us(?:e|ed|es|ing)|snort\\w*|smok\\w*)\\s+(?:of\\s+)?(?:cocaine|marijuana|cannabis|ketamine|heroin|meth\\w*)|(?:cocaine|marijuana|cannabis|ketamine|heroin)\\s+(?:use|habit|binges?|abuse)|alcoholism|alcoholics?\\b(?!\\s+(?:beverages?|drinks?|brands?|spirits|products?|content|sales))|drinking problem|(?:heavy|binge|problem) drinking'
  + '|\\b(?:he|she|I|they)\\s+(?:is|was|are|were|has been|had been|became)\\s+(?:clinically\\s+|severely\\s+|deeply\\s+)?(?:depressed|disabled|ill|sick)\\b|\\b(?:is|was|been|became)\\s+(?:clinically\\s+)?(?:bipolar|autistic|schizophrenic|anorexic|bulimic|diabetic|HIV[- ]positive|paraly[sz]ed)\\b',
  'i',
);
// A named person's own drug use ("Jane Doe's drug use": a capitalised name, so case matters here), and a person
// speaking or writing of it ("has spoken about substance abuse").
const HEALTH_NAMED = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}'’-]+['’]s\s+(?:[a-z'’-]+\s+){0,2}(?:drug|substance|alcohol) (?:ab)?use\b(?!\s+(?:polic\w*|trends?|data|rates?|statistics|research|stud(?:y|ies)|prevention|programs?|testing|screening|treatment|market|crisis|epidemic))|\b(?:spoke|spoken|speaks|speaking|talked|talks|talking|written|wrote|writes|writing|opened up|opens up)\s+(?:openly\s+|publicly\s+|candidly\s+)?about\s+(?:(?:his|her|their|my)\s+(?:past\s+|own\s+)?)?(?:drug|substance|alcohol) (?:ab)?use\b/u;
// HIV and AIDS only in capitals, so "hearing aids" or "visual aids" are not read as a disease
const HIV_AIDS = /\b(?:HIV[- ]positive|(?:living with|lives with|has|had|have|diagnosed with|died of|dies of|contracted|tested positive for)\s+(?:HIV|AIDS))\b/;

// A person's own sexuality or gender identity, never a bare word: "Gay" is also a given name (Gay Gaddis) and the
// first word of names ("Gay Area Youth Coalition"), and a company may serve "queer and transgender people". So the
// word counts only after a person verb or descriptor ("is gay", "came out as lesbian", "openly gay"), before a person
// noun in the singular ("a gay founder"), or as the person's own ("his sexual orientation", "her same-sex partner").
const SEX_WORD = '(?:gay|lesbian|bisexual|bi|queer|transgender|trans|non-?binary|pansexual|asexual|homosexual)';
const SEXUALITY = new RegExp(
  `\\b(?:is|was|are|were|am|be|been|being|identifies as|identified as|identify as|(?:came|comes|coming|come) out (?:publicly )?(?:as|to be)|openly|out as|proudly|publicly)\\s+(?:an?\\s+)?(?:openly\\s+)?(?<w>${SEX_WORD})\\b(?!-)`
  + `|\\b(?<w2>${SEX_WORD})\\s+(?:man|woman|person|founder|co-?founder|CEO|entrepreneur|executive|investor|couple|husband|wife|partner|icon|activist)\\b(?![-'’])`
  + '|\\b(?:his|her|their|my)\\s+(?:own\\s+)?(?:sexual orientation|sexuality|gender identity|transition|coming out)\\b'
  + '|\\bsame-sex (?:partner|spouse|husband|wife|marriage|relationship)\\b'
  + '|\\b(?:came|comes|coming|come) out (?:publicly )?(?:as|to be) (?:gay|lesbian|bi\\w*|queer|trans\\w*|non-?binary)',
  'gid',
);
/** True when a sentence names a person's own sexuality. A capitalised "Gay" before another capitalised word is a name. */
function sexualityMatch(s) {
  SEXUALITY.lastIndex = 0;
  let m;
  while ((m = SEXUALITY.exec(s))) {
    const w = m.groups?.w || m.groups?.w2;
    if (w) {
      const [at] = m.indices.groups.w || m.indices.groups.w2;
      const word = s.slice(at, at + w.length);
      // the word in its private sense is lower case ("is gay"); a capitalised one is a name or a title-case
      // headline. A name is followed by another capitalised word ("Gay Gaddis", "Gay Area"); a headline's word is not.
      if (/^[A-Z]/.test(word) && /^\s+[A-Z]/.test(s.slice(at + w.length))) continue;
      // "bi" and "trans" are words only with the person verb and at the end of the phrase ("she is trans."),
      // never "trans fats" or "is bi-weekly"
      if (/^(?:bi|trans)$/i.test(w) && !(m.groups?.w && /^(?:\s*[,.;:!?)]|\s*$|\s+(?:and|woman|man|person)\b)/i.test(s.slice(at + w.length)))) continue;
    }
    return true;
  }
  return false;
}

// Religion named as a person's own faith: "Jane Doe, a Mormon, founded ...", "is a devout Catholic who".
// Case-sensitive so that "the Catholic University" or "a Christian charity" are not caught.
const RELIGION = /\b(?:[Aa]n?|[Ii]s|[Ww]as|[Aa]s)\s+(?:(?:devout|practi[sc]ing|observant|born-again|lifelong)\s+)?(?:Hindu|Muslim|Mormon|Catholic|Jew|Jewish|Evangelical|Sikh|Buddhist|Christian|Baptist|Methodist|[Aa]theist)\b(?=\s*(?:[,.;:)!?]|$)|\s+(?:and|who|whose|by|from|since|himself|herself|man|woman|convert|family(?!\s+(?:foundations?|offices?|trusts?|funds?|business(?:es)?|compan\w*|charit\w*|philanthrop\w*))|faith|household|upbringing)\b)/;
const RELIGION_PRACTICE = /\b(?:devout|practi[sc]ing (?:muslim|catholic|jew|christian|hindu|mormon|buddhist)|converted to (?:islam|christianity|judaism|hinduism|buddhism|catholicism)|(?:LDS|Mormon)\s+mission\w*|served (?:an? )?(?:LDS |Mormon |church )?mission\b(?!-)|(?<!mercenar(?:y|ies),?\s+(?:vs\.?|versus|not|or|and|over)\s+(?:a\s+)?)missionar(?:y|ies)\b(?![\s,]+(?:vs\.?|versus|not|or|and|over)\s+(?:a\s+)?mercenar)|Shabbat|Sabbath observ\w*|keeps? kosher|synagogues?|Kabbalah|Scientologists?|(?:members?|adherents?) of the (?:[\w-]+\s+){0,6}?(?:Latter[- ]day Saints|LDS Church|Mormon Church|Church of Scientology))\b/i;
// Attending a place of worship. Case-sensitive, so "went to Temple University" is a school, not a faith.
const RELIGION_ATTEND = /\b(?:[Aa]ttends?|[Aa]ttended|[Aa]ttending|[Gg]oes to|[Ww]ent to)\s+(?:church|Mass|mass|mosque|synagogue|temple|(?:Sunday )?services|Friday prayers)\b/;

// A person's own immigration status, never a company's visa sponsorship, a government contract, a program or a fraud
// scheme ("sponsored H-1B visas for 300 engineers", "deportation operations", "a path to a green card through the
// EB-5 program", "H-1B visa fraud"). A visa or green card counts only as the person's: after a possessive, or after a
// person verb with a singular article ("came on a student visa", "obtained a green card").
const VISA = '(?:(?:H-?1B|O-?1|EB-?5|E-?2|L-?1|F-?1|J-?1|TN|student|tourist|investor|work|business|spousal|fianc[ée]e?|K-?1|golden|startup|skilled worker|global talent)\\s+visa|visa|green card|work permit|residen(?:cy|ce) permit|permanent residen(?:cy|ce)|residency|immigration status|citizenship|naturali[sz]ation|asylum (?:claim|application|case|status)|refugee status|DACA status|visa status)';
const IMMIGRATION = new RegExp(
  `\\b(?:his|her|their|my)\\s+(?:[a-z'’-]+\\s+){0,2}${VISA}\\b(?!\\s+(?:program\\w*|polic\\w*|fraud|scheme|sponsorship program))`
  + `|\\b(?:on|holds?|held|holding|obtain(?:ed|s|ing)?|got|gets|getting|receiv(?:ed|es|ing|e)|granted|denied|refused|revoked|lost|los(?:es|ing)|awaiting|waiting for|appl(?:y|ied|ies|ying) for|sponsored for|renew(?:ed|s|ing)?|overstay(?:ed|s|ing)?|secur(?:ed|es|ing)|won|wins)\\s+(?:an?|his|her|their)\\s+(?:new\\s+|temporary\\s+|permanent\\s+)?(?:(?:H-?1B|O-?1|EB-?5|E-?2|L-?1|F-?1|J-?1|K-?1)(?:\\s+visa)?|(?:TN|student|tourist|investor|work|business|spousal|golden|startup)\\s+visa|visa|green card|work permit|residen(?:cy|ce) permit)\\b(?!-)`
  + '|\\b(?:is|was|were|been|being|became|become|remained|lived)\\s+(?:an?\\s+)?(?:undocumented|illegal immigrant|unauthori[sz]ed immigrant|asylum seeker|green card holder|permanent resident|DACA recipient|Dreamer|naturali[sz]ed)\\b'
  + '|\\b(?:an?|as|former)\\s+(?:undocumented immigrant|asylum seeker|green card holder|DACA recipient)\\b(?!s)'
  + '|\\b(?:sought|seeking|seeks|applied for|granted|claimed|claiming|received|requested|was given) (?:political )?asylum\\b'
  + '|\\b(?:holds?|held|has|had|obtained|acquired|renounced|gave up|was granted|granted|applied for|received|took|takes|dual)\\s+(?:\\w+\\s+){0,2}citizenship\\b|\\bdual (?:citizen|national)\\b'
  + '|\\b(?:became|become|becoming|becomes)\\s+an?\\s+(?:naturali[sz]ed\\s+)?(?:[A-Z][\\w.]*\\s+)?citizen\\b|\\b(?:was|were|got|been|being|is) naturali[sz]ed\\b'
  + '|\\b(?:was|is|had been|has been|been|being|be|were nearly|was nearly)\\s+deported\\b|\\b(?:fac(?:es|ed|ing|e)|fought|fighting|avoided|escaped|risk(?:ed|s)? of|threat(?:ened)? (?:of|with)|ordered|order of|proceedings against (?:him|her))\\s+(?:\\w+\\s+){0,2}deportation\\b(?!\\s+(?:operations?|contracts?|flights?|programs?|centers?|centres?|facilit\\w+|services))|\\b(?:his|her|their|my)\\s+(?:\\w+\\s+)?deportation\\b'
  + '|\\boverst(?:ayed|ays|aying) (?:a|his|her|their) visa\\b|\\bvisa overstay\\b(?!\\s+rates?)'
  + '|\\b(?:as|was|were|an?|former)\\s+refugees?\\b(?!\\s+(?:charit\\w*|camps?|organi[sz]ations?|non-?profits?|programmes?|programs?|funds?|agenc\\w*|council|crisis|resettlement|services|support|aid|relief|startups?|apps?|platforms?)\\b)'
  + '|\\bimmigration status\\b(?!\\s+(?:of|checks?|verification|data|polic\\w*))|\\bundocumented\\b(?!\\s+(?:workers|immigrants|migrants|employees|people|labou?r|labou?rers|families|students))',
  'i',
);
// "a Dreamer" (a DACA recipient) only with the capital: "a dreamer and a builder" is not immigration status
const DREAMER = /\b(?:[Aa]n?|[Tt]he) Dreamers?\b/;

// Political donations are excluded by rule, whatever the source says about them.
const POLITICS = /\b(?:[Dd]onat\w*|[Gg]ave|[Gg]iving|[Cc]ontribut\w*|[Bb]undl\w*|[Mm]axed out|[Ww]rote checks?)\b[^.;\n]{0,80}?\b(?:PACs?|super ?PAC|political action committee|(?:re-?election|presidential|senate|congressional|mayoral|gubernatorial|leadership) (?:campaign|bid|run|fund)|[A-Z][a-z]+(?:['’]s)? (?:presidential |senate |congressional |re-?election )?campaign|(?:political|presidential|[Ss]enate|congressional|mayoral|Republican|Democratic) candidates?|GOP|DNC|RNC|ActBlue|WinRed|Republicans?|Democrats?|Democratic (?:Party|candidates?|National)|Republican (?:Party|candidates?|National)|Labour Party|Conservative Party|Tory|Tories)\b|\bFEC (?:records?|filings?|data|reports?|disclosures?)\b|\b(?:political|campaign) (?:donations?|contributions?|donors?|giving)\b|\b(?:major|mega|top|big|prominent|longtime|leading) (?:GOP|Republican|Democratic|Democrat|Tory|Labour|political) (?:donor|fundraiser|bundler|megadonor)s?\b/;

// What makes campaign money a crime rather than a donation record: "illegal political contributions", "straw donors",
// "conspiracy to make ... contributions", "campaign finance violations". A crime is diligence and stays; the rule
// excludes donation records. The word must be inside the matched phrase or just before it in the same clause, so a
// separate charge elsewhere in the sentence does not keep a lawful donation ("donated to the DNC and was later charged
// with fraud" still goes).
const POLITICS_CRIME = /\b(?:illegal(?:ly)?|unlawful(?:ly)?|straw|conduits?|excessive|disguised|reimburs\w*|falsely|in the name of another|conspir\w*|scheme|funnel\w*)\b/i;
const POLITICS_G = new RegExp(POLITICS.source, 'g');
function politicalDonation(s) {
  POLITICS_G.lastIndex = 0;
  let m;
  while ((m = POLITICS_G.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 50), m.index).split(/[,;:]/).pop();
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (POLITICS_CRIME.test(m[0]) || POLITICS_CRIME.test(before) || /^\s*(?:through|via|using|by)\s+(?:\w+\s+){0,2}(?:straw|conduit)|^\s*(?:violations?|fraud|charges?|crimes?|offen[cs]es?|scheme)\b/i.test(after)) continue;
    return true;
  }
  return false;
}

/** True when a sentence is about a protected or intimate matter (health, religion, sexuality, immigration, political donations). */
export function isSensitive(text) {
  return Boolean(protectedReason(String(text || '')));
}

function protectedReason(s) {
  if (HEALTH_ALWAYS.test(s) || HEALTH_PERSON.test(s) || HEALTH_NAMED.test(s) || HIV_AIDS.test(s)) return 'health';
  if (RELIGION.test(s) || RELIGION_PRACTICE.test(s) || RELIGION_ATTEND.test(s)) return 'religion';
  if (sexualityMatch(s)) return 'sexuality';
  if (IMMIGRATION.test(s) || DREAMER.test(s)) return 'immigration';
  if (politicalDonation(s)) return 'politics';
  return null;
}

// Children and minors are never part of a report.
// The kin nouns are matched in lower case only, so "Son" the surname (Masayoshi Son, Son Heung-min: "their chairman
// Son", "Son, 12 years after founding SoftBank") and "Child" the surname are not read as a child. "Daughter(s)" and
// "Children" are not names, so a title-case headline ("Her Daughter") still counts.
const KID_NOUN = '(?:son|sons|daughter|daughters|Daughters?|child|children|Children|kids?|Kids|baby|toddler|newborn|infant|grand(?:son|daughter|child(?:ren)?))';
const MINOR_KIN = new RegExp(
  `\\b(?:[Hh]is|[Hh]er|[Tt]heir|HIS|HER|THEIR)\\s+(?:\\w+\\s+)?${KID_NOUN}\\b`
  + '|\\b\\d{1,2}[- ][Yy]ear[- ][Oo]ld\\s+(?:son|daughter|Daughter|child|Child|boy|girl|Boy|Girl)\\b'
  + '|\\b(?:son|daughter|child),?\\s+(?:aged?\\s+)?(?:\\d|1[0-7])\\b'
  + '|\\b[Ww]elcom(?:ed|es|ing)\\s+(?:a\\s+|their\\s+|her\\s+|his\\s+)?(?:baby|son|daughter|child|twins|[Bb]aby|Daughter|Twins)\\b',
);
const MINOR = /\b(?:kindergarten|elementary school|middle school|(?:in|at)\s+high school|minor child(?:ren)?|custody (?:battle|dispute|of)|birth of (?:his|her|their)|gave birth|gives? birth|giving birth|baby (?:boy|girl)|newborn|stepchild(?:ren)?|expecting (?:a|their) (?:baby|child|first|second)|born to (?:him|her|them|the couple)|(?:father|mother|dad|mom|mum|parent)\s+(?:of|to)\s+(?:@\w+|\d+|two|three|four|five|six|twins|triplets|a\s+(?:boy|girl|son|daughter))\b(?!\s+(?:companies|startups|businesses|ventures|firms|brands|funds|products|patents|unicorns)\b)|(?:has|have|had|with|raising)\s+(?:\w+\s+)?(?:two|three|four|five|six|seven|\d{1,2})\s+(?:young\s+|adult\s+|grown\s+|small\s+)?(?:children|kids|sons|daughters)\b|guardian ad litem|next friend of|by and through (?:his|her|their) (?:parents?|guardians?|mother|father|next friend)|on behalf of (?:his|her|their) minor|\(\s*a minor\s*\)|,\s*a minor\s*,)/i;
// A named child: "Elizabeth Holmes' son William", "a son, William". Case-sensitive: the name must be capitalised.
const NAMED_CHILD = /[A-Z][\w’'-]*[’']s?\s+(?:son|daughter|child|children|kids)\b(?![’'-]|\s+(?:safety|privacy|data|products?|apps?|services?|accounts?|online|protection|content)\b)|\b(?:[Aa]|[Tt]heir|[Oo]ne)\s+(?:son|daughter|child),?\s+[A-Z][a-z]+/;
// A minor's initials in a court caption: "J.D., a minor, by and through her mother", "A.B. (a minor)"
const MINOR_CAPTION = /\b[A-Z]\.\s?[A-Z]\.(?:\s?[A-Z]\.)?,?\s*(?:\(?\s*a minor\b|by and through\b|by (?:his|her|their) (?:parents?|guardians?|next friend|mother|father)\b|individually and as (?:parent|guardian))/;
// An infobox count of children: "Children 3", "Children: 2"
const CHILD_COUNT = /\bChildren\s*:?\s*\d/;

/** True when a sentence is about a child or minor. */
export function mentionsMinor(text) {
  const s = String(text || '');
  return MINOR_KIN.test(s) || MINOR.test(s) || NAMED_CHILD.test(s) || MINOR_CAPTION.test(s) || CHILD_COUNT.test(s);
}

// Infobox-style personal fields that search snippets copy from encyclopedia pages:
// "Born Trevor Milton April 6, 1982", "Born: ...", "Spouse Carrie Milton", "Parents ...", "Residence: ...".
// Case-sensitive: the field names are capitalised there, and "Born in Ohio, she ..." is ordinary prose.
const INFOBOX = /(?:^|[\s.;|·•])(?:(?:Born|BORN)(?:\s*:|\s+(?=[A-Z0-9(]))|(?:Spouses?|Spouse\(s\)|Partner\(s\)|Domestic partner|Parents|Parent\(s\)|Relatives|Relations)(?:\s*:|\s+(?=[A-Z]))|(?:Residence|Religion|Height|Resting place)\s*:)/;

// Relatives. A kin word in lower case (so "Masayoshi Son" or "Lehman Brothers" are not kin).
const KIN = /\b(?:ex-)?(?:husband|wife|spouse|fianc[ée]e?|boyfriend|girlfriend|father|mother|dad|mom|mum|parents|brothers?|sisters?|siblings?|uncle|aunt|cousin|nephew|niece|grand(?:father|mother|parents|son|daughter|children)|step(?:father|mother|son|daughter|brother|sister)|(?:father|mother|brother|sister|son|daughter)s?-in-law|in-laws|sons?|daughters?|children|kids|widow(?:er|ed)?|married|marries|marrying|marriage)\b/g;
// Kin words used in a business sense: "parent company", "sister publication", "founding father", "father of 3D printing"
const KIN_BUSINESS_AFTER = /^(?:s|'s|’s)?\s+(?:company|companies|firm|group|entity|entities|organi[sz]ation|bank|corporation|holding|holdings|publication|site|brand|fund|title|channel|network|station|paper|newspaper|magazine|hotel|property|ship|school|city|cities|label|project|product|agency|airline|outlet|show|series|board|lode|tongue|land|country|nature|clause|in arms|to the (?:idea|concept|plan))\b|^\s+of\s+(?:the |modern |[A-Z0-9])/i;
const KIN_BUSINESS_BEFORE = /\b(?:founding|god|big|foster)\s*$/i;
// Roles that make a relative a public business, political or philanthropic figure (rule 3 of the handover).
const PUBLIC_ROLE = /\b(?:CEO|CFO|COO|CTO|chief (?:\w+ ){0,2}officer|chief executive|chair(?:man|woman|person)?|(?:vice[- ])?president|co-?founder|founder|(?:co-?)?found(?:ed|s|ing)|executive|director|managing (?:director|partner)|general partner|partner (?:at|in|of)|investor|venture capitalist|financier|banker|billionaire|millionaire|businessman|businesswoman|businessperson|business (?:executive|leader|owner)|entrepreneur|developer|industrialist|magnate|tycoon|mogul|owner|owns|runs|ran|heads|headed|board member|on the board|board of directors|trustee|philanthropist|foundation|senator|congress(?:man|woman)|representative|governor|mayor|minister|ambassador|diplomat|judge|politician|lawmaker|member of parliament|commissioner|secretary of|council(?:or|lor|man|woman|member)|candidate|(?:works?|worked|working) (?:at|for) [A-Z])\b|\bMP\b/i;
// Wedding, engagement and death notices are about private family life, whatever roles they mention.
const FAMILY_NOTICE = /\b(?:wedding|weddings|bride|bridegroom|nuptials|honeymoon|engaged to|engagement to|survived by|is survived|predeceased|funeral|obituary|memorial service|laid to rest)\b/i;
// A wedding or engagement announcement by its headline: always private family life.
const WEDDING_NOTICE_TITLE = /\b(?:weddings?|weds|bride|bridegroom|nuptials|honeymoon|engaged to|engagement to)\b/i;
// A headline about a marriage, an engagement, a divorce or a spouse ("marries", "and his wife") is about private
// family life (obituary headlines have their own rule, isObituary). Shared with the quick brief (founderCheck.js).
export const WEDDING_TITLE = /\b(?:weddings?|weds|bride|bridegroom|nuptials|honeymoon|engaged to|engagement to|marr(?:y|ies|ied|ying)|divorc(?:e|es|ed|ing))\b|\b(?:and|with)\s+(?:his|her|their)?\s*(?:new\s+|late\s+|former\s+|ex-)?(?:wife|husband|spouse|fianc[ée]e?)(?![A-Za-z])/i;
// Where a role after the kin word stops belonging to the relative
// (a new subject: "he"/"she" as the subject of a verb, ", where he founded"; a new clause after a comma: ", is the
// founder" when the relative sat inside a "whose" clause about the subject)
const CLAUSE_END = /;|\band\s+(?:he|she|they|later|then|went|founded|started|launched)\b|\bbut\b|\bwhile\b|\bbefore\b|\bafter\b|\bthen\b|\bwhen\b|,\s*(?:where|when|since|although|though|as)\b|\b(?:he|she)\b/i;
// A relative clause about someone else that opens later in the stretch after the kin word (", who", ", which"). Right
// after the kin word or the relative's name it describes the relative ("her father, who is CEO of Acme") and counts.
const LATER_RELATIVE = /,\s*(?:who|whom|which|whose)\b/i;
// The relative named in apposition right after the kin word: "wife Carrie", "father, John Roe,"
const KIN_NAME = /^(?:,?\s+[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,2})?/;
// A role in apposition before: "Bob Doe, a former Enron CEO, is her father"; or a joint venture: "co-founded Nikola with his brother"
const ROLE_BEFORE_KIN = /(?:\b(?:is|was|are|were)\s+(?:his|her|their|the)\s+(?:\w+\s+)?$)/i;
const JOINT_VENTURE_BEFORE = /\b(?:co-?found\w*|found(?:ed|ing)|started|launched|runs?|ran|built|invested|partnered|serv\w+ on the board|own(?:s|ed)?|manag\w+)\b[^.;]{0,60}\b(?:with|alongside|and)\s+(?:his|her|their)\s+(?:\w+\s+)?$/i;

/** The kin word in a sentence that has no business, political or philanthropic role beside it, or null. */
function privateRelative(s) {
  if (FAMILY_NOTICE.test(s)) return true;
  KIN.lastIndex = 0;
  let m;
  while ((m = KIN.exec(s))) {
    const word = m[0];
    const before = s.slice(Math.max(0, m.index - 120), m.index);
    const after = s.slice(m.index + word.length);
    if (KIN_BUSINESS_AFTER.test(after) || KIN_BUSINESS_BEFORE.test(before)) continue;
    // children and kids are kin only with a possessive or a count ("his children", "two kids"); "an app for kids" is a product
    // ("new parents" are a company's customers too; "Doe's parents" and "her parents" are kin)
    if (/^(?:children|kids|parents)$/.test(word) && !/(?:\b(?:his|her|their|my|two|three|four|five|six|\d+|no|young|adult|grown)|[’']s?)\s+(?:\w+\s+)?$/i.test(before)) continue;
    let clause = after.slice(0, 140).split(CLAUSE_END)[0];
    // a later ", who/which" belongs to someone else; one right after the kin word or the name is the relative's own
    const lead = clause.match(KIN_NAME)[0].length;
    const later = clause.slice(lead).replace(/^\s*,\s*(?:who|whom|which|whose)\b/i, (x) => ' '.repeat(x.length)).search(LATER_RELATIVE);
    if (later >= 0) clause = clause.slice(0, lead + later);
    // the kin word inside a "whose" clause about the subject ("Milton, whose wife Carrie is often at his side, is the
    // founder of Nikola"): the clause closes at the next comma, and the verb after it is the subject's
    if (/\bwhose\s+(?:\w+\s+)?$/i.test(before)) clause = clause.slice(0, lead) + clause.slice(lead).split(',')[0];
    if (PUBLIC_ROLE.test(clause)) continue;
    if (ROLE_BEFORE_KIN.test(before) && PUBLIC_ROLE.test(before)) continue;
    if (JOINT_VENTURE_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * Why a sentence must not be used, or null when it may. Reasons: 'minor', 'health', 'religion', 'sexuality',
 * 'immigration', 'politics', 'personal-details' (an infobox birth, spouse or parents line), 'relatives'
 * (a relative without a stated public role, or a wedding, engagement or death notice).
 * `{ kin: false }` skips the relatives rule (for short labels such as a relation field that says "father");
 * `{ kin: 'notices' }` applies only its wedding, engagement and death-notice part (a related-party record whose
 * relative has a stated role elsewhere in the record).
 */
export function privacyReason(text, { kin = true } = {}) {
  const s = String(text || '');
  if (!s.trim()) return null;
  if (mentionsMinor(s)) return 'minor';
  const p = protectedReason(s);
  if (p) return p;
  if (INFOBOX.test(s)) return 'personal-details';
  if (kin === 'notices') return FAMILY_NOTICE.test(s) ? 'relatives' : null;
  if (kin && privateRelative(s)) return 'relatives';
  return null;
}

// Clauses that can go without the sentence: "Jane Doe, a mother of two, is CEO of Acme" keeps the CEO fact.
const PARENT_CLAUSE = /,\s*(?:an?\s+|the\s+)?(?:proud\s+|single\s+)?(?:mother|father|mom|mum|dad|parent)\s+(?:of|to)\s+(?:two|three|four|five|six|twins|triplets|\d+|a\s+(?:boy|girl|son|daughter))(?:\s+(?:young\s+)?(?:children|kids|sons|daughters|boys|girls))?\s*,/gi;

// Sentence ends. A full stop after an abbreviation or an initial ("Inc.", "U.S.", "b.") is not one.
const ABBREV_END = /(?:^|[\s(.])(?:[A-Za-z]|Inc|Corp|Co|Ltd|LLC|Jr|Sr|Mr|Mrs|Ms|Dr|St|No|Nos|vs|v|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Gen|Gov|Sen|Rep|Rev|Prof|etc|e\.g|i\.e|approx|est|Ave|Blvd|Rd|Mt|Ft|Bros|Hon|Lt|Col|Capt|Sgt)\.$/;

/** Split text into [sentence, separator] pairs, keeping the separators so the text can be put back as it was. */
function splitSentences(text) {
  const out = [];
  const re = /(?<=[.!?;…]["'’”)\]]*)[ \t]+|[ \t]*\n\s*/g;
  let start = 0;
  let m;
  while ((m = re.exec(text))) {
    const piece = text.slice(start, m.index);
    if (!m[0].includes('\n') && ABBREV_END.test(piece)) continue;
    out.push([piece, m[0]]);
    start = m.index + m[0].length;
  }
  out.push([text.slice(start), '']);
  // a piece that is only citations ("[Source 3]") belongs to the sentence before it
  const merged = [];
  for (const [s, sep] of out) {
    if (merged.length && /^(?:\[[^\]]{1,40}\]\s*)+[.;]?$/.test(s.trim()) && !merged[merged.length - 1][1].includes('\n')) {
      const last = merged[merged.length - 1];
      last[0] = `${last[0]}${last[1]}${s}`;
      last[1] = sep;
    } else merged.push([s, sep]);
  }
  return merged;
}

const bump = (removed, reason, n = 1) => { removed[reason] = (removed[reason] || 0) + n; };

// Reasons a clause cannot be cut out of: a sentence about a child or an infobox personal line goes whole, even in an
// official record (a minor's initials or a birth line can sit in any clause of it).
const WHOLE_SENTENCE_REASONS = new Set(['minor', 'personal-details']);
// Where a sentence splits into clauses: commas, semicolons, dashes and brackets, and the joining words that open a
// new clause. The separator stays with the clause after it, so the kept clauses read as they were written.
const CLAUSE_SPLIT = /(?=,\s|;\s|\s[–—-]\s|\s\()|(?=\s(?:and|but|while|after|because|although|though|whereas|who|which|where)\s)/i;

/**
 * An official record's sentence with only its private clauses taken out ("Doe, who was diagnosed with cancer in 2019,
 * was sentenced for wire fraud" keeps "Doe, was sentenced for wire fraud"), or '' when nothing clean is left.
 */
function withoutPrivateClauses(sentence, opts) {
  const parts = sentence.split(CLAUSE_SPLIT);
  if (parts.length < 2) return '';
  const kept = parts.filter((p) => !privacyReason(p.replace(/^[\s,;([–—-]+/, ''), opts));
  if (!kept.length || kept.length === parts.length) return '';
  let out = kept.join('').replace(/^[\s,;–—-]+/, '').replace(/,\s*,/g, ',').replace(/\s+([,.;])/g, '$1');
  // a bracket the cut left open
  if ((out.match(/\(/g) || []).length > (out.match(/\)/g) || []).length) out = out.replace(/\s*\([^()]*$/, '');
  out = out.trim();
  if (!/[A-Za-z]{2}/.test(out) || privacyReason(out, opts)) return '';
  // the sentence keeps its full stop if the cut took it
  if (/[.!?;]$/.test(sentence.trim()) && !/[.!?;]$/.test(out)) out += sentence.trim().slice(-1);
  return out;
}

/**
 * The sentence-level cleaner every caller uses (the quick brief's snippets, makeFinding, the profile, model
 * output). Each sentence or line that is about a protected matter, a child, a birth or family infobox field or a
 * relative without a public role is removed; contact details, birth dates and ages are redacted in the rest.
 * Only the offending sentence goes, never the whole text.
 *
 * @param {string} text
 * @param {{ keepStreets?: boolean, kin?: boolean, clauses?: boolean }} [opts] keepStreets: an official company register
 *   entry keeps its office street line; kin: false skips the relatives rule (short labels); clauses: an official
 *   record's sentence loses only its private clauses (not for a child or an infobox personal line, which go whole)
 * @returns {{ text: string, removed: Record<string, number>, dropped: number }} the cleaned text, a count of what
 *   was removed or redacted by reason, and how many sentences were dropped
 */
export function cleanSentences(text, opts = {}) {
  const removed = {};
  let dropped = 0;
  const src = String(text ?? '');
  if (!src.trim()) return { text: '', removed, dropped };
  let out = '';
  for (const [sentence, sep] of splitSentences(src)) {
    if (!sentence.trim()) { out += sep; continue; }
    let s = sentence.replace(PARENT_CLAUSE, () => { bump(removed, 'minor'); return ','; });
    const reason = privacyReason(s, opts);
    if (reason) {
      bump(removed, reason);
      // an official court, prosecutor or regulator record loses only the private clause, so its charge stays
      const rest = opts.clauses && !WHOLE_SENTENCE_REASONS.has(reason) ? withoutPrivateClauses(s, opts) : '';
      if (!rest) {
        dropped += 1;
        continue;
      }
      s = rest;
    }
    s = redactCounted(s, opts, removed);
    if (!s) continue;
    out += s + sep;
  }
  return { text: out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(), removed, dropped };
}

/**
 * The same rules for text a model wrote (a brief, a summary). Images, HTML and links that are not http or https
 * are stripped first; then every line is cleaned sentence by sentence, keeping its markdown marker ("- ", "## ")
 * and the citations of the sentences it keeps. A line left empty goes.
 *
 * @returns {{ text: string, removed: Record<string, number> }}
 */
export function cleanModelText(text, opts = {}) {
  const removed = {};
  let t = String(text ?? '');
  // a script or style block goes with its content; an image goes whole
  t = t.replace(/<(script|style|iframe|object|embed|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, () => { bump(removed, 'markup'); return ''; });
  t = t.replace(/!\[[^\]]*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, () => { bump(removed, 'image'); return ''; });
  t = t.replace(/<[^>\n]*>/g, () => { bump(removed, 'markup'); return ''; });
  // a markdown link keeps its target only when it is http(s) and not a blocked site; otherwise only its words stay
  t = t.replace(/\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/g, (m, label, href) => {
    if (isSafeUrl(href) && !isBlockedUrl(href)) return m;
    bump(removed, 'link');
    return label;
  });
  // a bare script or data link left in the prose
  t = t.replace(/\b(?:javascript|vbscript|data|file|blob):(?=\S)(?:[^\s()\]]|\([^\s()]*\))*/gi, () => { bump(removed, 'link'); return ''; });
  const lines = [];
  for (const line of t.split('\n')) {
    const [, marker, body] = line.match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+|>\s*)?)([\s\S]*)$/);
    if (!body.trim()) { if (!marker.trim()) lines.push(''); continue; }
    const c = cleanSentences(body, opts);
    for (const [k, v] of Object.entries(c.removed)) bump(removed, k, v);
    if (c.text) lines.push(marker + c.text);
  }
  return { text: lines.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

// Fields that hold personal details whatever their value: they are dropped from data outright.
// (birth and death fields in every spelling, a person's nationality, citizenship and country of residence: a
// register's officer rows carry them, and a value such as "March 1984" has no "born" lead for the text rules to see)
const PERSONAL_KEY = /^(?:dob|dateOfBirth|date_of_birth|birth(?:Date|_date|day|Year|_year|Month|_month|place|Place|_place|Country|_country)?|born|(?:year|month|date|day|place|country|city)_?of_?(?:birth|death)|death(?:Date|_date|Year|_year|place|Place)|nationalit(?:y|ies)|citizenships?|countryOfResidence|country_of_residence|residenceCountry|usualResidence|residence|age|phone\w*|tel|telephone|mobile|fax|e?mail|emails?|personalEmail|homeAddress|home_address|residentialAddress|ssn|nationalId|national_id|passport\w*|driversLicen[cs]e|spouse|spouses|children|kids|religion|ethnicity|gender|sexuality|immigrationStatus|donations?|politicalDonations?)$/i;
// Identifiers: not prose, so they are not read for sentences or phones ("1:18-cr-00258", an SEC accession number)
const ID_KEY = /^(?:id|ids|caseNumber|accession|documentNumber|siren|siret|serial|wikidataId|docket|relationshipId|register|registry|form|noticeCode|noticeType|lei|cik|companyNumber|number|crd|ein|fileNumber|hash|kind|type|status|category|source|match)$/i;
// Link fields: kept only when they are http(s) and not a blocked site
const URL_KEY = /(?:url|href|link|website|homepage)s?$/i;
// A value that is a link by its scheme (contact links such as mailto: and tel: go too)
const SCHEME = /^\s*(?:https?|javascript|vbscript|data|file|blob|ftp|about|mailto|tel|sms|intent|chrome|view-source):/i;

/**
 * Walk structured extras (finding.data and the like) and clean every string in them: personal fields are
 * dropped, links must be http(s), identifiers are left as they are, short labels skip the relatives rule,
 * everything else goes through the sentence cleaner.
 *
 * @returns {{ data: any, removed: Record<string, number> }}
 */
export function cleanData(value, opts = {}) {
  const removed = {};
  const walk = (v, key, depth) => {
    if (depth > 8) return undefined;
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (ID_KEY.test(key || '')) return v;
      // any link, whatever the field is called, must be http(s) and not a blocked site; a link field holds nothing else
      if (URL_KEY.test(key || '') || SCHEME.test(v)) {
        if (isSafeUrl(v) && !isBlockedUrl(v)) return v.trim();
        bump(removed, 'link');
        return undefined;
      }
      // a short label ("father", "Director") is not a sentence about a relative
      const words = v.trim().split(/\s+/).length;
      const c = cleanSentences(v, { ...opts, kin: words < 4 ? false : (opts.kin ?? true) });
      for (const [k, n] of Object.entries(c.removed)) bump(removed, k, n);
      return c.text;
    }
    if (Array.isArray(v)) {
      return v.map((x) => walk(x, key, depth + 1)).filter((x) => x !== undefined);
    }
    if (typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (PERSONAL_KEY.test(k)) { bump(removed, 'personal-details'); continue; }
        const w = walk(x, k, depth + 1);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return undefined;
  };
  return { data: walk(value, '', 0), removed };
}

// Records from these connectors are official court, regulator or sanctions records (courts.js, sec.js,
// sanctions.js). Web, news and reference sources never get the public-record exemption, whatever category they carry.
const OFFICIAL_SOURCES = new Set([
  'delaware-courts', 'us-agency-orders', 'eu-courts', 'canada-federal-courts', 'federal-register', 'fda-recalls', 'cfpb-complaints', 'us-bank-regulators', 'fincen-actions', 'mdb-debarment',
  'court-dockets', 'court-records-open', 'doj-press-releases', 'finra-brokercheck', 'uk-gazette', 'uk-case-law', 'fr-bodacc',
  'us-enforcement-actions', 'sec-filings', 'sec-company', 'sanctions-lists', 'us-exclusions', 'wanted-lists',
  'fda-debarment', 'opensanctions-lists', 'asic-banned', 'fara-registrations', 'ftc-cases', 'esma-sanctions-register', 'sfc-hk-enforcement', 'us-tax-court',
]);
// Official company registers: their entries carry the company's registered office, which is not personal data.
const COMPANY_REGISTERS = new Set(['uk-companies-house', 'fr-companies', 'us-state-registries', 'lei-register', 'sec-company']);

/** True when a finding is an official company register entry, whose office street line may stay. */
export function isCompanyRegisterEntry(finding) {
  return Boolean(finding && COMPANY_REGISTERS.has(finding.source) && finding.category === 'corporate');
}

// Obituaries and funeral notices are about private family life and are the usual way a private namesake's
// record gets in. They are kept only when the record is confirmed as the subject's.
const OBITUARY_TITLE = /\bobituar\w*|\bfuneral (?:home|chapel|service|notice|arrangements?)\b|\bin memoriam\b|\b(?:pays?|paid) tributes?\b|\btributes? (?:to|for|pour|paid)\b|\bcelebration of life\b/i;
const OBITUARY_HOST = /obituar|funeral|(?:^|\.)legacy\.com$|(?:^|\.)tributes?\.com$/i;

/** True when a record is an obituary or funeral notice, by its title or its host. */
export function isObituary(finding) {
  return OBITUARY_TITLE.test(String(finding?.title || '')) || OBITUARY_HOST.test(hostOf(finding?.url));
}

/**
 * Apply every rule to one finding. Returns the cleaned finding, or null when it must not be used at all:
 * a link that is not http(s) or is on a blocked site, an obituary not confirmed as the subject's, a title that is
 * itself private, or a quote whose every sentence was private (the record then has nothing left to show).
 * Otherwise only the offending sentences of the quote go, and every string inside `data` is cleaned.
 * `finding` is { title, quote, url, data?, source, category, ... }.
 */
export function sanitizeFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  if (finding.url != null && finding.url !== '' && (!isSafeUrl(finding.url) || isBlockedUrl(finding.url))) return null;
  if (finding.match !== 'confirmed' && isObituary(finding)) return null;
  const opts = { keepStreets: isCompanyRegisterEntry(finding) };
  // A related-party record states the relative's role in its title or another sentence ("Father: John Roe, board
  // member of Acme"; "Jane Roe: father John Roe. John Roe: occupation businessperson"). The role stated anywhere in
  // the record counts, so its kin sentences stay; wedding and death notices still go.
  if (finding.category === 'related' && PUBLIC_ROLE.test(`${finding.title || ''} ${finding.quote || ''}`)) opts.kin = 'notices';
  // An official court, prosecutor or regulator record is never dropped whole for a sensitive word: only the private
  // clause goes and the charge stays. A child or an infobox personal line still drops the sentence, and a title
  // about a child still drops the record.
  const official = isOfficialRecord(finding);
  if (official) opts.clauses = true;
  // the title is one line: if it is private the record is about a private matter, so it goes
  let rawTitle = String(finding.title ?? '');
  // A related-party record that states the relative's public role keeps its "(married to)" title (a relative with a
  // stated role may be named); a wedding or engagement notice still goes.
  if (WEDDING_NOTICE_TITLE.test(rawTitle) || (opts.kin !== 'notices' && WEDDING_TITLE.test(rawTitle))) return null;
  const titleReason = privacyReason(rawTitle, { kin: false });
  if (titleReason) {
    if (!official || WHOLE_SENTENCE_REASONS.has(titleReason)) return null;
    rawTitle = withoutPrivateClauses(rawTitle, { kin: false });
    // what is left must still say what the record is ("charged with securities fraud"), not a scrap ("court told")
    if (!rawTitle || rawTitle.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length < 3) return null;
  }
  const title = redactPII(rawTitle, opts);
  const rawQuote = String(finding.quote ?? '');
  const quote = cleanSentences(rawQuote, opts).text;
  // an official record whose every quoted sentence was private still stands on its title
  if (rawQuote.trim() && !quote && !official) return null;
  const out = { ...finding, title, quote };
  if (finding.data !== undefined) {
    const { data } = cleanData(finding.data, opts);
    if (data === undefined) delete out.data;
    else out.data = data;
  }
  if (finding.url != null && finding.url !== '') out.url = String(finding.url).trim();
  return out;
}

/** True when a finding comes from an official court, regulator or sanctions connector. */
export function isOfficialRecord(finding) {
  return Boolean(finding && OFFICIAL_SOURCES.has(finding.source));
}

/** Clean a list of findings, dropping the ones that must not be used. */
export function sanitizeFindings(findings) {
  return (findings || []).map(sanitizeFinding).filter(Boolean);
}

export const USE_NOTICE =
  'This is a research aid built from public records and published sources, for investment diligence. It is not a consumer report and must not be used for employment, tenancy, credit or insurance decisions. Records are matched by name and context; confirm identity and every finding with the cited source before relying on it.';
