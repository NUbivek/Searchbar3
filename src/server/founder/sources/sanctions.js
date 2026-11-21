/**
 * Sanctions lists, exclusion lists, wanted lists and the ICIJ Offshore Leaks
 * database. Four sources:
 *
 *   sanctions-lists  the US Consolidated Screening List (twelve US lists in one
 *                    file), the UN Security Council list, the EU
 *                    consolidated list, the UK Sanctions List and Canada's
 *                    autonomous sanctions list. Each list is
 *                    downloaded whole at most once a day, reduced to a compact
 *                    name index (names, aliases, list, programme, listing
 *                    date, link, the list's own role or reason text) and kept
 *                    by cache.js: memory, then the database, then the network.
 *   us-exclusions    people and firms barred from US federal contracts
 *                    (SAM.gov, searched by name; the public search shows
 *                    only exclusions in force, so ended ones are not
 *                    screened and every SAM.gov screen says so)
 *                    and federal health programmes (the HHS OIG's official
 *                    LEIE file, read whole once a day).
 *   offshore-leaks   the ICIJ Offshore Leaks database (Panama, Paradise and
 *                    Pandora Papers and others).
 *   wanted-lists     the FBI wanted list and the EU Most Wanted list.
 *
 * Matching is by name, and deliberately strict. A name is normalised (NFKD,
 * accents removed, upper case, punctuation removed, "LAST, First" read as
 * words) and compared as a set of words with the listed name and every alias:
 *   tier 1  the same words
 *   tier 2  every word of the searched name is in the listed name (the list
 *           adds middle names), and for a person the listed name either runs
 *           first name ... last name or starts with the surname followed by
 *           the first name ("Rachael Elizabeth Holmes" is not "Elizabeth Holmes")
 *   tier 3  a variant of the name: another spelling of the given name
 *           (Muhammad for Mohammed), a nickname (Samuel for Sam) or one extra
 *           trailing surname (Garcia Lopez for Garcia). Always 'possible'.
 * There is no fuzzy matching. A name typed in Cyrillic or Greek is screened
 * in Latin letters (transliterate). A hit on a person is a name match and
 * nothing more: it is 'possible' unless the list's own text names the company
 * the check was started with (gradeListedPerson; a former employer never
 * counts), and every title says "verify identity". A company is matched only
 * on tier 1 of one of its known names (the name typed and the legal names
 * learned during the check) with the legal form removed, never on part of a
 * name (a bracketed part included); a match on a one-word name stays
 * 'possible'. A name that cannot be screened, a list that could not be read,
 * an older list copy and a cut search are reported as partial, never clean.
 *
 * Never stored, never returned: addresses, dates and places of birth,
 * passport and identity numbers, nationality, physical descriptions,
 * photographs. Those columns and tags are not read.
 *
 * Not screened, and said so in every result: Australia's list (published
 * only as a spreadsheet file, which the shared client cannot read).
 */
import { request, getJson } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { mentionsMinor } from '../guardrails';
import { parsePersonName, personNameVariants, personNameMatcher, companyKeys, isBroadOrganisation } from '../names';
import { isSelfTask, withAliasHold } from './alias';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "2026-11-20" from an epoch time or an ISO string ('' when there is none). */
const dayOf = (t) => {
  const ms = typeof t === 'number' ? t : Date.parse(t || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
};
const MAX_RECORDS_SHOWN = 6;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clipText = (s, n) => {
  const str = oneLine(s);
  if (str.length <= n) return str;
  const cut = str.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '')}…`;
};
const capitalise = (s) => String(s || '').replace(/^\s*([a-z])/, (m, c) => c.toUpperCase());
const lowerFirst = (s) => String(s || '').replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
/** "elizabeth HOLMES" -> "Elizabeth Holmes", so the grader (which wants a capitalised name) can read it. */
const properCase = (s) => oneLine(s).split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

// Letters that NFKD does not break into a base letter and an accent.
const FOLD = { ß: 'SS', Æ: 'AE', æ: 'AE', Œ: 'OE', œ: 'OE', Ø: 'O', ø: 'O', Đ: 'D', đ: 'D', Ð: 'D', ð: 'D', Ł: 'L', ł: 'L', Þ: 'TH', þ: 'TH', ı: 'I', Ħ: 'H', ħ: 'H', Ŧ: 'T', ŧ: 'T' };

/**
 * A name as upper-case ASCII words: accents removed, apostrophes and full
 * stops dropped ("O'Neil" -> ONEIL, "J." -> J), every other mark a space
 * ("Bankman-Fried" -> BANKMAN FRIED, "HOLMES, Elizabeth" -> HOLMES ELIZABETH).
 * Text in another script (Cyrillic, Arabic) comes out empty.
 */
export function normalizeName(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ßÆæŒœØøĐđÐðŁłÞþıĦħŦŧ]/g, (c) => FOLD[c])
    .toUpperCase()
    .replace(/['’‘`ʼ.]/g, '')
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** The distinct words of a name, sorted. */
export function nameTokens(text) {
  const norm = normalizeName(text);
  return norm ? [...new Set(norm.split(' '))].sort() : [];
}

// Legal forms carry no identity. Phrases are removed first, then single words,
// and only from the start or the end of a name ("AS" inside a name is a word).
const LEGAL_PHRASES = [
  'PUBLIC JOINT STOCK COMPANY', 'OPEN JOINT STOCK COMPANY', 'CLOSED JOINT STOCK COMPANY', 'PRIVATE JOINT STOCK COMPANY', 'JOINT STOCK COMPANY',
  'LIMITED LIABILITY COMPANY', 'LIMITED LIABILITY PARTNERSHIP', 'PRIVATE LIMITED COMPANY', 'PUBLIC LIMITED COMPANY', 'PRIVATE LIMITED',
].map((p) => p.split(' '));
const LEGAL_END = new Set('INC INCORPORATED LLC LLP LLLP LP LTD LIMITED PLC GMBH MBH AG SA SAS SARL SRL SPA BV NV AB OY OYJ AS ASA APS KK PTE PTY PVT CORP CORPORATION CO COMPANY PC PLLC SE KG UG SL LTDA LDA OOO OAO ZAO PAO AO JSC OJSC CJSC PJSC FZE FZCO FZC DMCC BHD SDN TOO DOO EOOD OOD KFT SRO'.split(' '));
const LEGAL_START = new Set('THE OOO OAO ZAO PAO AO JSC OJSC CJSC PJSC LLC TOO PT'.split(' '));

/**
 * The words of a company name with its legal form removed, in order:
 * "Theranos, Inc." -> [THERANOS]; "OOO Vega" -> [VEGA];
 * "Joint Stock Company Russian Agricultural Bank" -> [RUSSIAN, AGRICULTURAL, BANK].
 */
export function companyTokens(text) {
  let tokens = normalizeName(text).split(' ').filter(Boolean);
  const endsWith = (p) => tokens.length > p.length && p.every((w, i) => tokens[tokens.length - p.length + i] === w);
  const startsWith = (p) => tokens.length > p.length && p.every((w, i) => tokens[i] === w);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of LEGAL_PHRASES) {
      if (endsWith(p)) { tokens = tokens.slice(0, -p.length); changed = true; }
      if (startsWith(p)) { tokens = tokens.slice(p.length); changed = true; }
    }
    if (tokens.length > 1 && LEGAL_END.has(tokens[tokens.length - 1])) { tokens = tokens.slice(0, -1); changed = true; }
    if (tokens.length > 1 && LEGAL_START.has(tokens[0])) { tokens = tokens.slice(1); changed = true; }
  }
  return tokens;
}

/**
 * How a searched name compares with a listed one, both given as word lists.
 * @returns {0|1|2} 1: the same set of words; 2: every searched word is in the
 *   listed name, which has more; 0: no match.
 */
export function matchTier(searched, listed) {
  const want = new Set(searched);
  const have = new Set(listed);
  if (!want.size || !have.size) return 0;
  for (const t of want) if (!have.has(t)) return 0;
  return want.size === have.size ? 1 : 2;
}

/** A person's name is only searched when it has a first and a last name. */
const isFullName = (tokens) => tokens.filter((t) => t.length > 1).length >= 2;

/** The words of a name in written order (not sorted, repeats kept). */
const orderedTokens = (text) => normalizeName(text).split(' ').filter(Boolean);

/**
 * Whether a listed person's name has the searched first and last name in a
 * plausible order, both given as words in written order. The word-set test
 * alone would let "Rachael Elizabeth Holmes" match "Elizabeth Holmes".
 *   a) the listed name starts with the first name and ends with the last name
 *      (extra words only between them): "Elizabeth Anne Holmes";
 *   b) the listed name starts with the surname (one or more of the searched
 *      name's trailing words) and the next word is the first name:
 *      "HOLMES, Elizabeth Anne", "BANKMAN FRIED, Sam".
 */
export function personOrderMatch(want, listed) {
  if (want.length < 2 || !listed.length) return false;
  const first = want[0];
  if (listed[0] === first && listed[listed.length - 1] === want[want.length - 1]) return true;
  for (let j = 1; j < want.length; j += 1) {
    const surname = want.slice(j);
    if (surname.length < listed.length && surname.every((w, i) => listed[i] === w) && listed[surname.length] === first) return true;
  }
  return false;
}

/**
 * The searched forms of a person's name: as given, without middle initials ("Elizabeth A. Holmes" -> also
 * "Elizabeth Holmes"), and (through the shared name parser) without titles, generational suffixes or middle
 * names ("Albert Kelly Jr." -> "Albert Kelly", "Trevor Roy Milton" -> "Trevor Milton"), so a list that files the
 * person under a shorter form is still read.
 */
export function personVariants(name) {
  const words = oneLine(name).split(' ').filter(Boolean);
  const out = [words.join(' ')];
  if (words.length > 2) {
    const core = words.filter((w, i) => i === 0 || i === words.length - 1 || !/^[A-Za-z]\.?$/.test(w));
    if (core.length >= 2 && core.length < words.length) out.push(core.join(' '));
  }
  // The parser reads Latin script only; a name in another script is left to transliterate().
  if (/[A-Za-z]/.test(name || '')) out.push(...personNameVariants(name));
  const seen = new Set();
  return out.filter((v) => {
    const key = orderedTokens(v).join(' ') || v;
    if (!v || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ICAO 9303 transliteration (the one printed in passports), and the spelling most press and many lists use
// where it differs (Й Y, Ю YU, Я YA): "Юрий" is IURII in a passport and YURIY or YURI on a list.
const CYRILLIC = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'ZH', З: 'Z', И: 'I', Й: 'I', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O',
  П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'KH', Ц: 'TS', Ч: 'CH', Ш: 'SH', Щ: 'SHCH', Ъ: 'IE', Ы: 'Y', Ь: '', Э: 'E',
  Ю: 'IU', Я: 'IA', Є: 'IE', І: 'I', Ї: 'I', Ґ: 'G', Ў: 'U',
};
const CYRILLIC_COMMON = { ...CYRILLIC, Й: 'Y', Ю: 'YU', Я: 'YA', Ъ: '', Є: 'YE', Ї: 'YI' };
const GREEK = {
  Α: 'A', Β: 'V', Γ: 'G', Δ: 'D', Ε: 'E', Ζ: 'Z', Η: 'I', Θ: 'TH', Ι: 'I', Κ: 'K', Λ: 'L', Μ: 'M', Ν: 'N', Ξ: 'X', Ο: 'O',
  Π: 'P', Ρ: 'R', Σ: 'S', Τ: 'T', Υ: 'Y', Φ: 'F', Χ: 'CH', Ψ: 'PS', Ω: 'O',
};
const NON_LATIN = /[Ͱ-Ͽἀ-῿Ѐ-ӿ]/;

/**
 * A name written in Cyrillic or Greek, in Latin letters ("Олег Дерипаска" -> ["Oleg Deripaska"]), so it can be
 * screened at all: every list here is compared in Latin letters. Up to two spellings; [] for any other text.
 */
export function transliterate(text) {
  // Composed form: Й and Ї are letters of their own, not И or І with a mark
  const s = String(text ?? '').normalize('NFC');
  if (!NON_LATIN.test(s)) return [];
  // Greek vowel pairs ICAO writes as two Latin letters: ΟΥ OU, ΑΥ AV, ΕΥ EV (an accent on either is dropped)
  const pairs = s.replace(/([ΑΕΟαεοΆΈΌάέό])([ΥυΎύ])/g, (m, a) => {
    const base = a.normalize('NFD')[0];
    const latin = { Ο: 'OU', Α: 'AV', Ε: 'EV' }[base.toUpperCase()];
    return base === base.toUpperCase() ? latin : latin.toLowerCase();
  });
  const read = (table) => pairs.replace(/[Ͱ-Ͽἀ-῿Ѐ-ӿ]/g, (c) => {
    const up = c.toUpperCase();
    // A Greek accent (tonos) is dropped: Ά is read as Α
    const greek = GREEK[up.normalize('NFD')[0]];
    const latin = table[up] ?? greek ?? '';
    return c === up ? latin : latin.toLowerCase();
  });
  return [...new Set([read(CYRILLIC), read(CYRILLIC_COMMON)].map((v) => oneLine(v)).filter((v) => /[A-Za-z]/.test(v)))]
    .map((v) => v.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(' '));
}

/** A listed name as written, and without a bracketed part ("Hanif Computer Zone (HCZ)"). */
const listedForms = (name) => {
  const bare = oneLine(String(name).replace(/\([^)]*\)/g, ' '));
  return bare && bare !== name ? [name, bare] : [name];
};

/** A listed name with the given name first: "GARCIA LOPEZ, Juan Carlos" -> "Juan Carlos GARCIA LOPEZ". */
const givenFirstForms = (listed) => listedForms(listed).flatMap((form) => {
  const at = form.indexOf(',');
  return at > 0 ? [form, `${form.slice(at + 1)} ${form.slice(0, at)}`] : [form];
});

// Spellings of one given name that lists and passports use interchangeably (transliterations, not nicknames;
// nicknames come from the shared name parser).
const SPELLINGS = [
  'MOHAMMED MUHAMMAD MOHAMMAD MOHAMED MUHAMMED MOHAMAD MUHAMED MOHAMMEDE', 'AHMED AHMAD AHMET', 'HUSSEIN HUSSAIN HUSAIN HOSSEIN',
  'ALEKSANDR ALEXANDER ALEKSANDER ALEXANDR OLEKSANDR', 'YURI YURIY YURY IURII IURI', 'SERGEI SERGEY SERGUEI SERGII SERHII SERHIY',
  'DMITRI DMITRY DMITRIY DMITRII', 'ANDREI ANDREY ANDRII ANDRIY', 'ALEXEI ALEXEY ALEKSEI ALEKSEY OLEKSII OLEKSIY',
  'NIKOLAI NIKOLAY', 'EVGENY EVGENII EVGENIY YEVGENY YEVGENIY', 'ARKADY ARKADIY ARKADII', 'VALERY VALERIY VALERII',
  'GENNADY GENNADIY GENNADII', 'ANATOLY ANATOLIY ANATOLII', 'VASILY VASILIY VASILII VASSILY', 'GRIGORY GRIGORIY GRIGORII',
  'MAXIM MAKSIM', 'YULIA YULIYA IULIIA', 'NATALIA NATALYA NATALIIA', 'TATIANA TATYANA TETIANA',
].map((g) => g.split(' '));
const SPELLING_OF = new Map();
SPELLINGS.forEach((g, i) => g.forEach((w) => SPELLING_OF.set(w, i)));

const nicknameMemo = new Map();
/** Whether two given names (upper case) are the same name in another spelling or a nickname of it (Sam, Samuel). */
function sameGivenName(a, b) {
  if (a === b) return true;
  if (SPELLING_OF.has(a) && SPELLING_OF.get(a) === SPELLING_OF.get(b)) return true;
  const key = `${a}|${b}`;
  if (!nicknameMemo.has(key)) {
    const cap = (w) => w[0] + w.slice(1).toLowerCase();
    // A fixed made-up surname: only the given names are compared
    let same = false;
    try { same = personNameMatcher(`${cap(a)} Qzxvbt`).kind(`${cap(b)} Qzxvbt`) === 'nickname'; } catch { same = false; }
    if (nicknameMemo.size > 5000) nicknameMemo.clear();
    nicknameMemo.set(key, same);
  }
  return nicknameMemo.get(key);
}

/** The searched given name and surname as upper-case words ({ given: 'SAM', surname: ['BANKMAN', 'FRIED'] }). */
function givenAndSurname(variant) {
  const p = parsePersonName(variant);
  const given = orderedTokens(p.given)[0];
  const surname = orderedTokens(p.surname);
  return given && given.length > 1 && surname.length ? { given, surname } : null;
}

const endsWith = (list, tail) => tail.length <= list.length && tail.every((w, i) => list[list.length - tail.length + i] === w);

/**
 * Tier 3: a listed name that is a variant of the searched one, never the same name. The listed given name is
 * the searched one in another spelling or its nickname, or the list adds one trailing surname ("Juan Carlos
 * Garcia Lopez" for Juan Garcia, "BANKMAN-FRIED, Samuel Benjamin" for Sam Bankman-Fried). Such a match is only
 * ever 'possible'.
 */
function variantMatch(variants, listed) {
  for (const v of variants) {
    const want = givenAndSurname(v);
    if (!want) continue;
    for (const form of givenFirstForms(listed)) {
      const have = orderedTokens(form);
      if (have.length < 1 + want.surname.length || !sameGivenName(want.given, have[0])) continue;
      const rest = have.slice(1);
      const otherGiven = have[0] !== want.given;
      if (otherGiven && endsWith(rest, want.surname)) return true;
      // One more surname at the end ("Garcia Lopez"), never a lone initial
      const extra = rest[rest.length - 1];
      if (rest.length > want.surname.length && extra.length > 1 && endsWith(rest.slice(0, -1), want.surname)) return true;
    }
  }
  return false;
}

/**
 * The best match between a searched person and one listed name.
 * @param {string[]} variants the searched name and its variants
 * @param {string} listed
 * @returns {0|1|2|3} 1 the same words, 2 the list adds middle names, 3 a variant of the name (another
 *   spelling, a nickname, an extra trailing surname: always 'possible'), 0 no match
 */
export function matchPersonName(variants, listed) {
  let best = 0;
  for (const form of listedForms(listed)) {
    const have = nameTokens(form);
    for (const v of variants) {
      const want = nameTokens(v);
      if (!isFullName(want)) continue;
      const tier = matchTier(want, have);
      // A longer listed name must also have the first and last name in order
      if (tier === 2 && !personOrderMatch(orderedTokens(v), orderedTokens(form))) continue;
      if (tier && (!best || tier < best)) best = tier;
    }
  }
  if (!best && variantMatch(variants.filter((v) => isFullName(nameTokens(v))), listed)) return 3;
  return best;
}

/**
 * True when a listed name is the searched company's name once legal forms are
 * removed (tier 1 only). A bracketed part counts as part of the name:
 * "VTB Bank (Kiev)" or "Mossack Fonseca & Co. (Israel) Limited" is a different
 * company from "VTB Bank" or "Mossack Fonseca & Co.".
 */
export function matchCompanyName(company, listed) {
  const want = companyTokens(company);
  if (want.join('').length < 3) return false;
  return matchTier(want, companyTokens(listed)) === 1;
}

/* ------------------------------------------------------------------ */
/* Screening a compact index                                           */
/* ------------------------------------------------------------------ */

/**
 * A compact index is { v, key, at, lists?, urls?, rows } where each row is
 *   n  primary name as listed        a  aliases (omitted when none)
 *   t  'person' | 'entity' | ''      ('' when the list does not say)
 *   l  list name (in the US file: a position in index.lists)
 *   p  programme or regime           d  listed date      e  end date
 *   i  the list's own reference      u  link (a position in index.urls)
 *   r  the role or reason the list gives (short, no personal details)
 */
const prepared = new WeakMap();

/** Normalised words of every name in an index, built once per loaded copy. */
function prepare(index) {
  let p = prepared.get(index);
  if (p) return p;
  p = index.rows.map((row) => {
    const names = [];
    for (const [j, name] of [row.n, ...(row.a || [])].entries()) {
      for (const form of listedForms(name)) {
        const tokens = nameTokens(form);
        if (tokens.length) names.push({ s: name, k: ` ${tokens.join(' ')} `, c: tokens.length, o: orderedTokens(form), alias: j > 0 });
      }
    }
    return names;
  });
  prepared.set(index, p);
  return p;
}

/**
 * Screen one name against a compact index.
 * @param {object} index
 * @param {string[]} names the searched name and its variants; for a company, every known name of it (the name
 *   as typed first, then fuller legal names learned during the check)
 * @param {'person'|'company'} mode
 * @returns {Array<{ row: object, tier: 1|2|3, matched: string, alias: boolean, via?: string }>} tier 1 first;
 *   `via` (companies) is the known name that matched
 */
export function screenIndex(index, names, mode) {
  const hits = [];
  const table = prepare(index);
  if (mode === 'company') {
    const wants = names.map((n) => ({ name: n, tokens: companyTokens(n) })).filter((w) => w.tokens.join('').length >= 3);
    if (!wants.length) return hits;
    index.rows.forEach((row, i) => {
      if (row.t === 'person') return;
      // A fuller legal name is tried before the bare name, so a record it matches is reported through it
      for (const want of [...wants].sort((a, b) => b.tokens.length - a.tokens.length)) {
        for (const name of table[i]) {
          if (!want.tokens.every((t) => name.k.includes(` ${t} `))) continue;
          if (matchCompanyName(want.name, name.s)) { hits.push({ row, tier: 1, matched: name.s, alias: name.alias, via: want.name }); return; }
        }
      }
    });
    return hits;
  }
  const full = names.filter((n) => isFullName(nameTokens(n)));
  const wants = full.map((n) => ({ set: nameTokens(n), order: orderedTokens(n) }));
  if (!wants.length) return hits;
  // Variants (tier 3) are looked for only in rows that carry every word of a searched surname
  const surnames = full.map(givenAndSurname).filter(Boolean).map((w) => w.surname);
  index.rows.forEach((row, i) => {
    if (row.t === 'entity') return;
    let best = null;
    for (const name of table[i]) {
      for (const want of wants) {
        if (!want.set.every((t) => name.k.includes(` ${t} `))) continue;
        const tier = want.set.length === name.c ? 1 : 2;
        // A longer listed name must also have the first and last name in order
        if (tier === 2 && !personOrderMatch(want.order, name.o)) continue;
        if (!best || tier < best.tier) best = { row, tier, matched: name.s, alias: name.alias };
      }
    }
    if (!best) {
      for (const name of table[i]) {
        if (!surnames.some((s) => s.every((t) => name.k.includes(` ${t} `)))) continue;
        if (variantMatch(full, name.s)) { best = { row, tier: 3, matched: name.s, alias: name.alias }; break; }
      }
    }
    if (best) hits.push(best);
  });
  return hits.sort((a, b) => a.tier - b.tier);
}

/* ------------------------------------------------------------------ */
/* Reading list files                                                  */
/* ------------------------------------------------------------------ */

// The largest list file (EU, about 25 MB of text) with room to grow. The
// shared client refuses a larger body outright rather than cutting it short.
const LIST_MAX_BYTES = 48 * 1024 * 1024;

/** Download a whole list file as text, in one request. */
async function fetchList(url, { deadline, timeoutMs = 17000 }) {
  return (await request(url, { deadline, timeoutMs, maxBytes: LIST_MAX_BYTES })).text;
}

/** One pass over delimited text with quoted fields; calls onRow(fields) per record. */
function eachCsvRow(text, sep, onRow) {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row = [];
  while (i < n) {
    let field;
    if (text[i] === '"') {
      let j = i + 1;
      field = '';
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { field += text.slice(j); j = n; break; }
        if (text[q + 1] === '"') { field += text.slice(j, q + 1); j = q + 2; continue; }
        field += text.slice(j, q);
        j = q + 1;
        break;
      }
      i = j;
    } else {
      let j = i;
      while (j < n && text[j] !== sep && text[j] !== '\n' && text[j] !== '\r') j += 1;
      field = text.slice(i, j);
      i = j;
    }
    row.push(field);
    if (i < n && text[i] === sep) {
      i += 1;
      if (i === n) row.push('');
      continue;
    }
    if (text[i] === '\r') i += 1;
    if (text[i] === '\n') i += 1;
    onRow(row);
    row = [];
  }
  if (row.length) onRow(row);
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) => String(s).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const key = e.toLowerCase();
  if (XML_ENTITIES[key]) return XML_ENTITIES[key];
  try { return String.fromCodePoint(key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1))); } catch { return ' '; }
});
const tagRes = new Map();
const tagRe = (tag) => {
  if (!tagRes.has(tag)) tagRes.set(tag, new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'));
  const re = tagRes.get(tag);
  re.lastIndex = 0;
  return re;
};
/** Text of every <tag>...</tag> inside a block (tags without attributes). */
const inners = (block, tag) => [...block.matchAll(tagRe(tag))].map((m) => oneLine(decodeXml(m[1]))).filter(Boolean);
const inner = (block, tag) => inners(block, tag)[0] || '';
function eachBlock(xml, tag, fn) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let i = 0;
  for (;;) {
    const a = xml.indexOf(open, i);
    if (a < 0) return;
    const b = xml.indexOf(close, a);
    if (b < 0) return;
    fn(xml.slice(a + open.length, b));
    i = b + close.length;
  }
}

const isLatin = (name) => normalizeName(name).length >= 2;
/** Usable aliases: Latin script, not the primary name again, capped. */
function cleanAliases(primary, aliases, { max = 25 } = {}) {
  const seen = new Set([nameTokens(primary).join(' ')]);
  const out = [];
  for (const raw of aliases) {
    const alias = oneLine(raw);
    // A list sometimes writes birth details or document numbers into an alias: such an alias is dropped whole
    if (!alias || alias.length > 160 || !isLatin(alias) || PERSONAL.test(alias) || /\d{5,}/.test(alias)) continue;
    const key = nameTokens(alias).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= max) break;
  }
  return out;
}

// Details that must not be kept even when a list puts them in its free text.
const PERSONAL = /\b(born|birth|d\.?o\.?b\.?|passport|national (?:id|identification)|identity (?:card|number)|id (?:no|number)|tax (?:id|number)|address|resid(?:es|ing|ence|ent)|lives in|living in|nationality|citizen(?:ship)?)\b/i;

// A family tie of the listed person ("together with her husband Kim Su Gwang, her father-in-law ..."): a third
// party's family is never shown. Lower case only, or a capitalised kin word opening a sentence with "of" or "to"
// ("Brother of the minister"), so a name such as "Son Hyok" is not read as a son.
const KIN_START = /^(?:Wife|Husband|Spouse|Sons?|Daughters?|Father|Mother|Brother|Sister|Sibling|Niece|Nephew|Cousin|Uncle|Aunt|Grand(?:son|daughter|father|mother)|Widow(?:er)?)(?:-in-law)?\s+(?:of|to)\b/;
// "Parent company", "sister company" and "child soldiers" are not family; children are left to mentionsMinor.
const KIN = /\b(?:wife|wives|husband|spouse|sons?|daughters?|fathers?|mothers?|brothers?|(?:sisters?|siblings?)(?!\s+(?:compan|organi[sz]ation|entit|firm|bank|vessel|ship|concern))|nieces?|nephews?|cousins?|uncles?|aunts?|grand(?:son|daughter|father|mother|child|children)s?|step(?:son|daughter|father|mother|brother|sister)s?|(?:\w+)-in-law|in-laws?|widow(?:er)?|relatives?|family members?)\b/;

/** The role or reason a list gives, without sentences that carry personal details or family members. */
export function reasonText(text, max = 260) {
  const kept = oneLine(text).split(/(?<=[.;])\s+/).filter((s) => s && !PERSONAL.test(s) && !mentionsMinor(s) && !/https?:\/\//i.test(s)
    && !KIN.test(s) && !KIN_START.test(s));
  return clipText(kept.join(' '), max);
}

const compact = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== '' && v != null && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out;
};
const stamp = (key, extra, rows) => {
  if (!rows.length) throw new Error('The list file had no entries that could be read');
  return { v: 1, key, at: new Date().toISOString(), ...extra, rows };
};
const INCOMPLETE = 'The list file arrived incomplete';

/* ---- US Consolidated Screening List (trade.gov) ---- */

const OFAC_DETAILS = 'https://sanctionssearch.ofac.treas.gov/Details.aspx?id=';

/** Build the compact index from the US Consolidated Screening List CSV. */
export function parseUsCsl(text) {
  if (!/\n\s*$/.test(text.slice(-8))) throw new Error(INCOMPLETE);
  let col = null;
  let width = 0;
  let lastWidth = 0;
  const lists = [];
  const urls = [];
  const position = (arr, value) => {
    let at = arr.indexOf(value);
    if (at < 0) { arr.push(value); at = arr.length - 1; }
    return at;
  };
  const rows = [];
  eachCsvRow(text, ',', (f) => {
    if (!col) {
      col = Object.fromEntries(f.map((name, i) => [name.trim(), i]));
      width = f.length;
      lastWidth = width;
      if (col.name == null || col.source == null || col.alt_names == null) throw new Error('The US screening list file is not in the expected format');
      return;
    }
    lastWidth = f.length;
    const type = oneLine(f[col.type]);
    const name = oneLine(f[col.name]);
    if (!name || /^(vessel|aircraft)$/i.test(type) || !isLatin(name)) return;
    const entityNumber = oneLine(f[col.entity_number]);
    const linked = [...String(f[col.remarks] || '').matchAll(/\(Linked To: [^)]{2,120}\)/g)].map((m) => m[0]);
    rows.push(compact({
      n: name,
      a: cleanAliases(name, String(f[col.alt_names] || '').split(';')),
      t: /^individual$/i.test(type) ? 'person' : /^entity$/i.test(type) ? 'entity' : '',
      l: position(lists, oneLine(f[col.source])),
      p: clipText(f[col.programs], 120),
      d: oneLine(f[col.start_date]),
      e: oneLine(f[col.end_date]),
      ...(/^\d+$/.test(entityNumber) ? { i: entityNumber } : { u: position(urls, oneLine(f[col.source_list_url])) }),
      r: reasonText([oneLine(f[col.title]), ...linked.slice(0, 3)].filter(Boolean).join(' '), 200),
    }));
  });
  if (lastWidth !== width) throw new Error(INCOMPLETE);
  return stamp('us-csl', { lists, urls }, rows);
}

/* ---- UN Security Council Consolidated List ---- */

export function parseUn(xml) {
  if (!/<\/CONSOLIDATED_LIST>\s*$/.test(xml.slice(-200))) throw new Error(INCOMPLETE);
  const rows = [];
  const read = (block, type) => {
    const name = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME'].map((t) => inner(block, t)).filter(Boolean).join(' ');
    if (!name || !isLatin(name)) return;
    const designation = block.match(/<DESIGNATION>([\s\S]*?)<\/DESIGNATION>/);
    rows.push(compact({
      n: name,
      a: cleanAliases(name, inners(block, 'ALIAS_NAME')).filter((a) => type === 'entity' || isFullName(nameTokens(a))),
      t: type,
      p: inner(block, 'UN_LIST_TYPE'),
      d: inner(block, 'LISTED_ON').slice(0, 10),
      i: inner(block, 'REFERENCE_NUMBER'),
      r: designation ? reasonText(inners(designation[1], 'VALUE').join('; '), 200) : '',
    }));
  };
  eachBlock(xml, 'INDIVIDUAL', (b) => read(b, 'person'));
  eachBlock(xml, 'ENTITY', (b) => read(b, 'entity'));
  return stamp('un', { asOf: (xml.slice(0, 600).match(/dateGenerated="(\d{4}-\d{2}-\d{2})/) || [])[1] || null }, rows);
}

/* ---- UK Sanctions List (FCDO) ---- */

const ukDate = (s) => {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

export function parseUk(xml) {
  if (!/<\/Designations>\s*$/.test(xml.slice(-200))) throw new Error(INCOMPLETE);
  const rows = [];
  eachBlock(xml, 'Designation', (block) => {
    const kind = inner(block, 'IndividualEntityShip');
    if (!/^(individual|entity)$/i.test(kind)) return;
    const names = [];
    eachBlock(block, 'Name', (nb) => {
      const full = ['Name1', 'Name2', 'Name3', 'Name4', 'Name5', 'Name6'].map((t) => inner(nb, t)).filter(Boolean).join(' ');
      if (full && isLatin(full)) names.push({ full, primary: /^primary name$/i.test(inner(nb, 'NameType')) });
    });
    const primary = (names.find((x) => x.primary) || names[0])?.full;
    if (!primary) return;
    rows.push(compact({
      n: primary,
      a: cleanAliases(primary, names.map((x) => x.full)),
      t: /^individual$/i.test(kind) ? 'person' : 'entity',
      p: inner(block, 'RegimeName'),
      d: ukDate(inner(block, 'DateDesignated')),
      i: inner(block, 'UniqueID'),
      r: reasonText([...inners(block, 'Position').slice(0, 3), inner(block, 'UKStatementofReasons')].join('. ').replace(/\.\./g, '.'), 300),
    }));
  });
  const generated = (xml.slice(0, 600).match(/<DateGenerated>([^<]+)</) || [])[1];
  return stamp('uk', { asOf: ukDate(generated) || null }, rows);
}

/* ---- Canada: Special Economic Measures Act and related regulations ---- */

export function parseCanada(xml) {
  if (!/<\/data-set>\s*$/.test(xml.slice(-200))) throw new Error(INCOMPLETE);
  const rows = [];
  eachBlock(xml, 'record', (block) => {
    if (/<ShipIMONumber-/.test(block)) return;
    const person = [inner(block, 'GivenName-Prenom'), inner(block, 'LastName-NomDeFamille')].filter(Boolean).join(' ');
    const entity = inner(block, 'EntityOrShip-EntiteOuNavire');
    const name = person || entity;
    if (!name || !isLatin(name)) return;
    // Aliases are free text ("A or B / C, Russian: ..."): only plain alternatives are kept
    const aliases = inner(block, 'Aliases-Alias').split(/[;,]/).filter((a) => !/\bor\b|[/:]/i.test(a));
    const schedule = inner(block, 'Schedule-Annexe');
    const item = inner(block, 'Item-NumeroDarticle');
    rows.push(compact({
      n: name,
      a: cleanAliases(name, aliases, { max: 8 }),
      t: person ? 'person' : 'entity',
      p: oneLine(inner(block, 'Country-Pays').split(' / ')[0]),
      d: inner(block, 'DateOfListing-DateDinscription').slice(0, 10),
      i: [schedule && `Schedule ${schedule}`, item && `item ${item}`].filter(Boolean).join(', '),
    }));
  });
  return stamp('ca', {}, rows);
}

/* ---- EU Financial Sanctions Files ---- */

export function parseEu(csv) {
  let col = null;
  let width = 0;
  let lastWidth = 0;
  const byId = new Map();
  const urls = [];
  eachCsvRow(csv, ';', (f) => {
    if (!col) {
      col = Object.fromEntries(f.map((name, i) => [name.trim(), i]));
      width = f.length;
      lastWidth = width;
      if (col.Entity_LogicalId == null || col.NameAlias_WholeName == null) throw new Error('The EU list file is not in the expected format');
      return;
    }
    if (f.length === 1 && !f[0]) return;
    lastWidth = f.length;
    const id = oneLine(f[col.Entity_LogicalId]);
    const name = oneLine(f[col.NameAlias_WholeName]);
    if (!id || !name || !isLatin(name)) return;
    let e = byId.get(id);
    if (!e) {
      const link = col.Entity_Regulation_PublicationUrl == null ? '' : oneLine(f[col.Entity_Regulation_PublicationUrl]);
      let u = /^https?:\/\//.test(link) ? urls.indexOf(link) : -1;
      if (u < 0 && /^https?:\/\//.test(link)) { urls.push(link); u = urls.length - 1; }
      e = { names: [], t: /^(p|person)$/i.test(oneLine(f[col.Entity_SubjectType])) || /^person$/i.test(oneLine(f[col.Entity_SubjectType_ClassificationCode])) ? 'person' : 'entity', p: oneLine(f[col.Entity_Regulation_Programme]), d: oneLine(f[col.Entity_Regulation_PublicationDate]).slice(0, 10), i: oneLine(f[col.Entity_EU_ReferenceNumber]), u: u >= 0 ? u : '', r: '' };
      byId.set(id, e);
    }
    e.names.push(name);
    const role = oneLine(f[col.NameAlias_Function]);
    if (role && !e.r) e.r = reasonText(role, 200);
  });
  if (lastWidth !== width) throw new Error(INCOMPLETE);
  const rows = [...byId.values()].map((e) => compact({ n: e.names[0], a: cleanAliases(e.names[0], e.names.slice(1)), t: e.t, p: e.p, d: e.d, i: e.i, u: e.u, r: e.r }));
  return stamp('eu', { urls }, rows);
}

/* ------------------------------------------------------------------ */
/* The lists                                                           */
/* ------------------------------------------------------------------ */

const UN_PAGE = 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list';
const CANADA_PAGE = 'https://www.international.gc.ca/world-monde/international_relations-relations_internationales/sanctions/consolidated-consolide.aspx?lang=eng';
const EU_PAGE = 'https://www.sanctionsmap.eu/';

/**
 * `off` gives the reason a list is not screened; such a list is never planned
 * or loaded and is named in a note. Australia needs the file's bytes (it is a
 * spreadsheet), which the shared client does not return.
 */
export const LISTS = [
  {
    key: 'us-csl', short: 'US', name: 'US Consolidated Screening List',
    cacheKey: 'watchlist:us-csl:v1',
    load: async (deadline) => parseUsCsl(await fetchList('https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.csv', { deadline })),
    listOf: (row, index) => index.lists?.[row.l] || '',
    link: (row, index) => (row.i ? `${OFAC_DETAILS}${row.i}` : index.urls?.[row.u] || 'https://www.trade.gov/consolidated-screening-list'),
  },
  {
    key: 'un', short: 'UN', name: 'UN Security Council sanctions list',
    cacheKey: 'watchlist:un:v1',
    load: async (deadline) => parseUn(await fetchList('https://scsanctions.un.org/resources/xml/en/consolidated.xml', { deadline })),
    link: () => UN_PAGE,
  },
  {
    key: 'eu', short: 'EU', name: 'EU consolidated sanctions list',
    cacheKey: 'watchlist:eu:v1',
    // One 25 MB file (about 2.5 MB compressed on the wire). The host is slow at times (4 to 24 s on
    // 14 Nov 2026): a cold load may then fail, and the cache keeps the last good copy for later lookups.
    load: async (deadline) => parseEu(await fetchList('https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw', { deadline, timeoutMs: 16000 })),
    link: (row, index) => (row.u !== undefined && index.urls?.[row.u]) || EU_PAGE,
  },
  {
    key: 'uk', short: 'UK', name: 'UK Sanctions List',
    cacheKey: 'watchlist:uk:v1',
    load: async (deadline) => parseUk(await fetchList('https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml', { deadline })),
    link: (row) => `https://search-uk-sanctions-list.service.gov.uk/designations/${encodeURIComponent(row.i)}/${row.t === 'person' ? 'Individual' : 'Entity'}`,
  },
  {
    key: 'ca', short: 'Canada', name: 'Canada sanctions list',
    cacheKey: 'watchlist:ca:v1',
    load: async (deadline) => parseCanada(await fetchList('https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml', { deadline })),
    link: () => CANADA_PAGE,
  },
  {
    key: 'au', short: 'Australia', name: 'Australia consolidated sanctions list',
    off: 'it is published only as a spreadsheet file',
  },
];

const activeLists = () => LISTS.filter((l) => !l.off);
const groupLabel = () => `Sanctions lists (${activeLists().map((l) => l.short).join(', ')})`;
const notScreenedNote = () => {
  const off = LISTS.filter((l) => l.off);
  return off.length ? `Not screened on this deployment: ${off.map((l) => `the ${l.name} (${l.off})`).join('; ')}.` : null;
};

/**
 * A list's compact index from the cache, with the date of the copy. The loader gets the cache's own deadline
 * (a shared list load must not die with the first caller's deadline); this caller waits only until its own.
 * @returns {Promise<{ index: object, at: number, fresh: boolean, asOf: string }>} fresh is false when an older
 *   copy stands in for a download that failed; asOf is the day of the copy
 */
async function loadIndex(list, deadline) {
  const entry = await cachedEntry(list.cacheKey, DAY_MS, ({ deadline: d }) => list.load(d), { deadline });
  return { index: entry.value, at: entry.at, fresh: entry.fresh !== false, asOf: dayOf(entry.at) || dayOf(entry.value?.at) };
}

/** "(list as of 2026-11-20)": every "no match" says which copy of a list was read. */
const asOfText = (copy) => (copy?.asOf ? ` (list as of ${copy.asOf})` : '');
/** A stale copy (a refresh failed) is screened, but the screen is only partly current: said in notes and partial. */
const staleParts = (label, copy) => (copy && !copy.fresh && copy.asOf
  ? { note: `${label}: the latest copy could not be downloaded, so the copy of ${copy.asOf} was screened`, partial: `${label}: list as of ${copy.asOf}` }
  : null);

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

const isPersonTask = (task) => task.kind !== 'company';
const isDomain = (s) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(s) && /\.[a-z]{2,}$/i.test(s);

/**
 * Every known name of a company: the name as given, then the fuller legal names the check has learned for it
 * through identity.addCompanyAlias ("Ramp" -> "Ramp Business Corporation"). Domains are left out. Lists and
 * registers are searched under each, because a one-word name finds every unrelated firm that shares the word,
 * while the legal name finds the company itself.
 * @param {object} subject
 * @param {string} company
 * @param {number} [max]
 * @returns {string[]}
 */
export function companyNames(subject, company, max = 3) {
  const typed = oneLine(company);
  const out = [typed];
  const key = companyKeys(typed)[0];
  const aliases = subject?.anchors?.aliases;
  if (key && aliases && typeof aliases.values === 'function') {
    for (const a of aliases.values()) if (a && a.of === key && a.value && !isDomain(a.value)) out.push(oneLine(a.value));
  }
  const seen = new Set();
  return out.filter((n) => {
    const k = companyTokens(n).join(' ') || n.toLowerCase();
    if (!n || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, max);
}

/** A company name of one distinctive word once the legal form is removed ("Flow Inc." -> FLOW). */
export const isOneWordCompany = (name) => companyTokens(name).length < 2;

/**
 * The names a lookup screens. A company: its known names. A person: their name and variants, plus the name in
 * Latin letters when it was typed in Cyrillic or Greek.
 */
export function screenNames(task, ctx) {
  if (task.kind === 'company') return companyNames(ctx?.subject, task.value);
  const base = task.kind === 'subject' && ctx?.subject?.variants?.length
    ? [...ctx.subject.variants, ...personVariants(ctx.subject.name), ...personVariants(task.value)]
    : personVariants(task.value);
  const latin = base.flatMap((n) => transliterate(n)).flatMap((n) => personVariants(n));
  return [...new Set([...base, ...latin])];
}
const searchedNames = screenNames;

/**
 * The grade of a listed person (a sanctions list, an exclusion list, a regulator's order) for the person being
 * checked. The list gives the name; the record's own words (the bank, the role, the reason) are then read with
 * the person's name the way makeFinding reads any record. A namesake who worked at a bank the person also
 * worked at is common, so an employer or any other organisation learned from other records never raises such a
 * record: only a company the check was started with (origin 'given') does.
 *   tier 3 (a variant of the name)                                  'possible'
 *   the record names no company the check was started with           'possible'
 *   the same name (tier 1), the given company named, not a huge firm  as makeFinding grades it ('confirmed')
 *   otherwise (a longer listed name, a very large organisation)       'likely' at most
 * A held grade is fixed, so a later re-grade with new anchors cannot raise it.
 * @param {object} subject
 * @param {object} f the finding fields for makeFinding (no match fields)
 * @param {{ tier: number, context: string, possibleTitle?: string }} opts possibleTitle replaces the title of
 *   a 'possible' result
 */
export function gradeListedPerson(subject, f, { tier, context = '', possibleTitle } = {}) {
  const held = (match, reasons) => makeFinding(subject, { ...f, ...(match === 'possible' && possibleTitle ? { title: possibleTitle } : {}), match, matchReasons: reasons });
  if (Number(tier) >= 3) return held('possible', ['only a variant of the name matches (another spelling, a nickname or an extra surname)']);
  const graded = makeFinding(subject, { ...f, matchText: `${properCase(subject.name)}. ${oneLine(context)}` });
  if (!graded || (graded.match !== 'confirmed' && graded.match !== 'likely')) return held('possible', ['matched by name only']);
  const given = [...(subject.anchors?.companies?.values?.() || [])].find((a) => a.origin === 'given' && typeof a.test === 'function' && a.test(oneLine(context)));
  if (!given) {
    return held('possible', ['matched by name only', 'the record names an organisation the person is linked to only through other records, where a namesake may also have worked']);
  }
  const broad = isBroadOrganisation(given.value);
  if (graded.match === 'confirmed' && Number(tier) === 1 && !broad) return graded;
  const why = broad ? `${given.value} is a very large organisation, so the same name there may be someone else`
    : Number(tier) !== 1 ? 'the listed name has words the searched name lacks' : 'not named beside the person';
  return held('likely', [...(graded.matchReasons || []).slice(0, 3), why]);
}

/**
 * Grade and build one finding for a name match.
 *   subject    gradeListedPerson: the person's name plus the list's own context, held below 'confirmed' unless
 *              the same name sits beside the company the check was started with
 *   company    'company' (the caller has already required tier 1); 'possible' (held) when the caller
 *              says the name matched is a single word once the legal form is removed (meta.coreOnly)
 *   associate, relative   title names who it is about; 'possible' unless the record also names the subject
 */
function gradedFinding(task, ctx, f, context, coreOnly = false, tier = 1) {
  const subject = ctx.subject;
  if (task.kind === 'company' && coreOnly) {
    return makeFinding(subject, { ...f, match: 'possible', matchReasons: ['only the company name\'s one distinctive word matches; many unrelated companies share a one-word name'] });
  }
  if (task.kind === 'company') return makeFinding(subject, { ...f, match: 'company', matchReasons: ['the listed name is the same as the company name'] });
  if (task.kind === 'associate' || task.kind === 'relative') {
    const reason = `name match on ${task.kind === 'relative' ? 'a relative' : 'an associate'} of the subject`;
    const named = makeFinding(subject, f);
    // A record that also names the subject is graded on its text, but never above 'likely' from a list
    if (named && named.match === 'confirmed') return makeFinding(subject, { ...f, match: 'likely', matchReasons: named.matchReasons });
    return named || makeFinding(subject, { ...f, match: 'possible', matchReasons: [reason] });
  }
  return gradeListedPerson(subject, f, { tier, context });
}

/** "Father John Roe" / "Associate Jane Roe": who a record found for a related person is about. */
const aboutPrefix = (task) => (task.kind === 'associate' || task.kind === 'relative'
  ? `${capitalise(task.relation || (task.kind === 'relative' ? 'relative' : 'associate'))} ${oneLine(task.value)}`
  : '');

/**
 * One finding for everything a single lookup matched on one list.
 * @param {object} task
 * @param {object} ctx
 * @param {{ source: string, sourceLabel: string, category: string, severity: string, where: string, noun?: string, data?: object }} meta
 *   where: "on the UK Sanctions List" style phrase used in the title
 * @param {Array<{ name: string, tag?: string, quote: string, context?: string, url: string, date?: string, tier: number }>} records best first
 */
function matchFinding(task, ctx, meta, records) {
  if (!records.length) return null;
  const shown = records.slice(0, MAX_RECORDS_SHOWN);
  const first = shown[0];
  const tag = first.tag ? ` (${first.tag})` : '';
  const head = records.length === 1 ? `${first.name}${tag}` : `${records.length} ${meta.noun || 'listed names'}, first ${first.name}${tag}`;
  // Records come best first: when the best is a variant of the name, every record is
  const base = `${first.tier >= 3 ? 'Name variant match' : 'Name match'} ${meta.where}: ${head}: verify identity`;
  const about = aboutPrefix(task);
  const title = about ? `${about}: ${lowerFirst(base)}` : base;
  const room = Math.max(150, Math.floor(660 / shown.length));
  const more = records.length > shown.length ? ` || and ${records.length - shown.length} more` : '';
  const build = (withContext) => gradedFinding(task, ctx, {
    source: meta.source,
    sourceLabel: meta.sourceLabel,
    category: meta.category,
    severity: meta.severity,
    title,
    quote: shown.map((r) => clipText(withContext && r.context ? `${r.quote} | ${r.context}` : r.quote, room)).join(' || ') + more,
    url: first.url,
    date: first.date || null,
    data: {
      ...(meta.data || {}),
      searched: oneLine(task.value),
      bestTier: first.tier,
      records: shown.map((r) => ({ name: r.name, tier: r.tier, url: r.url, ...(r.tag ? { programme: r.tag } : {}), ...(r.date ? { listed: r.date } : {}) })),
      ...(records.length > shown.length ? { moreRecords: records.length - shown.length } : {}),
    },
  }, shown.map((r) => `${r.context || ''}`).join(' '), Boolean(meta.coreOnly),
  // Several records share one grade: it is only as strong as the weakest name among them
  Math.max(...shown.map((r) => Number(r.tier) || 1)));
  // A list's reason text must never cost the hit itself: without it the record is still reported.
  return build(true) || build(false);
}

const TYPE_WORD = { person: 'individual', entity: 'entity' };

/**
 * The end date of a list row whose listing has ended (yyyy-mm-dd, before today), or ''. The US screening list
 * keeps denial orders long after they lapsed (some ended in 2000), and such a row must not read as a current
 * listing.
 */
export function listingEnded(row, today = new Date().toISOString().slice(0, 10)) {
  const end = (String(row?.e || '').match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || '';
  return end && end < today ? end : '';
}

/** A matched list row as a record for matchFinding. */
function listRecord(list, index, hit) {
  const { row } = hit;
  const subList = list.listOf ? list.listOf(row, index) : '';
  const parts = [
    `Listed name: ${row.n}`,
    hit.alias ? `Also listed as: ${hit.matched}` : '',
    row.t ? `Type: ${TYPE_WORD[row.t]}` : '',
    subList ? `List: ${subList}` : '',
    row.p ? `Programme: ${row.p}` : '',
    row.i && list.key !== 'us-csl' ? `Reference: ${row.i}` : '',
    row.d ? `Listed: ${row.d}` : '',
    row.e ? `${listingEnded(row) ? 'Listing ended' : 'End date'}: ${row.e}` : '',
  ].filter(Boolean);
  return {
    ended: listingEnded(row),
    name: row.n,
    tag: row.p || (subList.match(/\(([^)]+)\)/) || [])[1] || '',
    quote: parts.join(' | '),
    context: row.r ? `Role or reason given: ${row.r}` : '',
    url: list.link(row, index),
    date: row.d || null,
    tier: hit.tier,
  };
}

/**
 * Company hits split by how they matched: through a name of two or more distinctive words (the company), or
 * only through a one-word name ("Flow Inc." -> FLOW), which many unrelated firms share and which is held as
 * 'possible'. Each group becomes its own finding.
 */
const byStrength = (task, hits) => (isPersonTask(task)
  ? [{ hits, coreOnly: false }]
  : [{ hits: hits.filter((h) => !isOneWordCompany(h.via || task.value)), coreOnly: false }, { hits: hits.filter((h) => isOneWordCompany(h.via || task.value)), coreOnly: true }])
  .filter((g) => g.hits.length);

/** Screen one name against one list. Resolves to { findings, clean, copy }. */
async function screenList(list, task, ctx) {
  const copy = await loadIndex(list, ctx.deadline);
  const { index } = copy;
  const hits = screenIndex(index, searchedNames(task, ctx), isPersonTask(task) ? 'person' : 'company');
  // Listings in force and listings that ended are reported apart, like SAM.gov's ended exclusions: an ended
  // listing still matters, but it is no longer a bar, so it is medium and says when it ended.
  const groups = byStrength(task, hits).flatMap((g) => {
    const records = g.hits.map((h) => listRecord(list, index, h));
    return [
      { ...g, records: records.filter((r) => !r.ended), ended: '' },
      { ...g, records: records.filter((r) => r.ended), ended: records.filter((r) => r.ended).map((r) => r.ended).sort().pop() || '' },
    ].filter((x) => x.records.length);
  });
  const findings = groups.map((g) => matchFinding(task, ctx, {
    source: 'sanctions-lists',
    sourceLabel: groupLabel(),
    category: 'sanctions',
    severity: g.ended ? 'medium' : 'high',
    where: g.ended
      ? `on the ${list.name} (${g.records.length === 1 ? `listing ended ${g.ended}` : `listings ended, the latest ${g.ended}`})`
      : `on the ${list.name}`,
    coreOnly: g.coreOnly,
    data: {
      list: list.name, listKey: list.key, listReadAt: new Date(copy.at || Date.now()).toISOString(), ...(index.asOf ? { listDated: index.asOf } : {}), ...(copy.fresh ? {} : { listStale: true }),
      ...(g.ended ? { ended: g.ended } : {}),
    },
  }, g.records)).filter(Boolean);
  return { findings, clean: hits.length === 0, copy };
}

/** False when a name cannot be screened at all (a single word for a person, a two-letter company). */
const canScreen = (task, ctx) => (isPersonTask(task)
  ? searchedNames(task, ctx).some((v) => isFullName(nameTokens(v)))
  : searchedNames(task, ctx).some((n) => companyTokens(n).join('').length >= 3));

/**
 * A name that cannot be screened was not looked up at all: never a clean result. `partial` makes the report
 * list the screen as not done, not as "no match".
 */
const notScreened = (label, task, extraNotes = []) => ({
  findings: [], threads: [],
  notes: [...extraNotes, `${label}: "${oneLine(task.value)}" could not be screened (a single word, or too short a name)`],
  partial: [`${oneLine(task.value).slice(0, 40)}: name could not be screened`],
});

/* ------------------------------------------------------------------ */
/* 1. Sanctions lists                                                  */
/* ------------------------------------------------------------------ */

const ALL_LISTS = 'list.all';

export const sanctionsListsConnector = {
  id: 'sanctions-lists',
  get label() { return groupLabel(); },
  // 'alias': another name of the person, screened like their own name (alias.js holds the grade)
  kinds: ['subject', 'alias', 'company', 'associate', 'relative'],
  prior: 0.5,
  timeoutMs: 20000,
  /**
   * The person being checked gets one lookup per list (each list then has its
   * own time budget and its own score). Companies, associates and relatives
   * get one lookup that screens every list, because by then the lists are
   * already loaded and a check has a fixed number of lookups to spend.
   */
  plan(thread) {
    if (thread?.kind === 'subject') return activeLists().map((l) => ({ template: `list.${l.key}`, prior: 0.5, why: `screen the name against the ${l.name}` }));
    return [{ template: ALL_LISTS, prior: 0.5, why: 'screen the name against every sanctions list' }];
  },
  async run(task, ctx) {
    const name = oneLine(task.value);
    const notes = [];
    const off = notScreenedNote();
    if (off) notes.push(off);
    if (!canScreen(task, ctx)) return notScreened(groupLabel(), task, notes);

    const wanted = String(task.template || ALL_LISTS);
    if (wanted !== ALL_LISTS) {
      const list = activeLists().find((l) => `list.${l.key}` === wanted);
      if (!list) throw new Error(`Unknown sanctions list: ${wanted}`);
      const { findings, clean, copy } = await screenList(list, task, ctx);
      if (clean) notes.push(`${list.name}: no match for ${name}${asOfText(copy)}`);
      const stale = staleParts(list.name, copy);
      if (stale) notes.push(stale.note);
      return { findings, threads: [], notes, ...(stale ? { partial: [stale.partial] } : {}) };
    }

    const lists = activeLists();
    const results = await Promise.allSettled(lists.map((l) => screenList(l, task, ctx)));
    const failed = lists.filter((l, i) => results[i].status === 'rejected');
    if (failed.length === lists.length) throw results[0].reason;
    const findings = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.findings : []));
    const partial = [];
    const cleanLists = lists.filter((l, i) => results[i].status === 'fulfilled' && results[i].value.clean);
    const dates = [...new Set(cleanLists.map((l) => results[lists.indexOf(l)].value.copy?.asOf).filter(Boolean))];
    if (cleanLists.length === lists.length) notes.push(`${groupLabel()}: no match for ${name}${dates.length === 1 ? ` (lists as of ${dates[0]})` : ''}`);
    else for (const l of cleanLists) notes.push(`${l.name}: no match for ${name}${asOfText(results[lists.indexOf(l)].value.copy)}`);
    lists.forEach((l, i) => {
      const stale = results[i].status === 'fulfilled' ? staleParts(l.name, results[i].value.copy) : null;
      if (stale) { notes.push(stale.note); partial.push(stale.partial); }
    });
    // A list that could not be read was not screened: the lookup is partly answered, never clean
    for (const l of failed) {
      notes.push(`${l.name}: could not be read, so ${name} was not screened against it`);
      partial.push(`${l.name}: not read`);
    }
    return { findings, threads: [], notes, ...(partial.length ? { partial } : {}) };
  },
};

/* ------------------------------------------------------------------ */
/* 2. US federal exclusions: SAM.gov and HHS OIG                       */
/* ------------------------------------------------------------------ */

const EXCLUSIONS_LABEL = 'US federal exclusion lists (SAM.gov, HHS OIG)';
const SAM_SEARCH = 'https://sam.gov/api/prod/sgs/v1/search/';
const SAM_PAGE_SIZE = 50;
// A common name brings back many rows: up to three pages are read, and a longer answer is reported as partial.
const SAM_MAX_PAGES = 3;
const OIG_URL = 'https://exclusions.oig.hhs.gov/';
// The official monthly file of the whole List of Excluded Individuals/Entities (about 11 MB). It replaces the
// search form, which showed one page of results at a time.
const LEIE_CSV = 'https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv';
const LEIE_CACHE_KEY = 'watchlist:leie:v2';

/** The shortest searched form of a person's name that can be screened: first and last name, no middle initials. */
const coreName = (variants) => {
  const usable = variants.filter((v) => isFullName(nameTokens(v)));
  return (usable.length ? usable : variants).slice().sort((a, b) => a.split(' ').length - b.split(' ').length)[0];
};

/** A SAM.gov date ("2019-05-01", "05/01/2019") as yyyy-mm-dd, or '' ("Indefinite", empty). */
const samDate = (s) => {
  const t = oneLine(s);
  const us = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1]}-${us[2]}`;
  return (t.match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || '';
};

/**
 * One SAM.gov exclusions search, read page by page up to SAM_MAX_PAGES. The public search returns only exclusions
 * in force: asking for inactive ones is refused ("Unauthorized to view inactive exclusions"), and leaving the
 * filter out returns the active ones only. Ended exclusions are therefore not screened (SAM_ACTIVE_ONLY_NOTE).
 */
async function samSearch(q, ctx) {
  const rows = [];
  let total = 0;
  for (let page = 0; page < SAM_MAX_PAGES; page += 1) {
    // No is_active filter. It changes nothing for the public (only exclusions in force come back either way), but
    // a row whose termination date has passed while it is still listed is then read and labelled as ended.
    const url = `${SAM_SEARCH}?index=ex&q=${encodeURIComponent(q.toLowerCase())}&qMode=ALL&page=${page}&size=${SAM_PAGE_SIZE}&mode=search&sort=-relevance`;
    const json = await getJson(url, { deadline: ctx.deadline, accept: 'application/hal+json', timeoutMs: 12000 });
    if (!json || (json.page == null && json._embedded == null)) throw new Error('SAM.gov did not return a search result');
    const got = Array.isArray(json._embedded?.results) ? json._embedded.results : [];
    rows.push(...got);
    total = Math.max(total, Number(json.page?.totalElements) || 0, rows.length);
    if (got.length < SAM_PAGE_SIZE || rows.length >= total) break;
  }
  return { rows, total };
}

/** Said on every SAM.gov screen: a clean SAM.gov answer says nothing about exclusions that have ended. */
export const SAM_ACTIVE_ONLY_NOTE = 'SAM.gov shows the public only exclusions currently in force; ended exclusions were not screened.';

async function screenSam(task, ctx) {
  const name = oneLine(task.value);
  const person = isPersonTask(task);
  const variants = searchedNames(task, ctx);
  // A company is searched under each known name (up to two): its legal name finds it far better than one word
  const queries = person ? [normalizeName(coreName(variants))] : variants.slice(0, 2).map((n) => companyTokens(n).join(' ')).filter((q) => q.length >= 3);
  const rows = [];
  const seenIds = new Set();
  let cut = 0;
  for (const q of [...new Set(queries)]) {
    const answer = await samSearch(q, ctx);
    for (const r of answer.rows) if (r?._id && !seenIds.has(r._id)) { seenIds.add(r._id); rows.push(r); }
    if (answer.total > answer.rows.length) cut = Math.max(cut, answer.total - answer.rows.length);
  }
  const seen = new Set();
  const hits = [];
  for (const r of rows) {
    const listed = oneLine(r?.title);
    const individual = /individual/i.test(r?.classification?.code || '');
    // Rows copied from the Treasury sanctions list are already covered by the screening list
    if (!listed || !r?._id || individual !== person || /OFAC/i.test(`${r.excludingAgency || ''} ${r.excludingAgencyDesc || ''}`)) continue;
    const via = person ? '' : variants.find((n) => matchCompanyName(n, listed)) || '';
    const tier = person ? matchPersonName(variants, listed) : (via ? 1 : 0);
    if (!tier) continue;
    const key = [normalizeName(listed), r.excludingAgency, r.exclusionType, r.activationDate].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ r, listed, tier, via });
  }
  hits.sort((a, b) => a.tier - b.tier);
  const today = new Date().toISOString().slice(0, 10);
  const findings = hits.slice(0, 5).map(({ r, listed, tier, via }) => {
    const agency = oneLine(r.excludingAgencyDesc || r.excludingAgency);
    const state = r.address?.state && /^(USA|US)$/i.test(r.address?.country || '') ? `${r.address.state}, USA` : oneLine(r.address?.country);
    const ended = samDate(r.terminationDate);
    const over = Boolean(ended && ended < today);
    return matchFinding(task, ctx, {
      source: 'us-exclusions', sourceLabel: EXCLUSIONS_LABEL, category: 'sanctions',
      // An exclusion that has ended still matters, but it is no longer a bar
      severity: over ? 'medium' : 'high',
      where: over ? `on the SAM.gov exclusion list (exclusion ended ${ended})` : 'on the SAM.gov exclusion list',
      coreOnly: !person && isOneWordCompany(via || name),
      data: { list: 'SAM.gov exclusions', excludingAgency: agency, exclusionType: oneLine(r.exclusionType) || null, ...(over ? { ended } : {}) },
    }, [{
      name: listed,
      tag: [agency, oneLine(r.exclusionType)].filter(Boolean).join(', '),
      quote: [
        `Listed name: ${listed}`,
        `Classification: ${oneLine(r.classification?.code)}`,
        agency ? `Excluding agency: ${agency}` : '',
        r.exclusionType ? `Exclusion type: ${oneLine(r.exclusionType)}` : '',
        r.exclusionProgram ? `Exclusion program: ${oneLine(r.exclusionProgram)}` : '',
        r.activationDate ? `Active date: ${oneLine(r.activationDate)}` : '',
        over ? `Exclusion ended ${ended}` : `Termination date: ${oneLine(r.terminationDate) || 'Indefinite'}`,
        state ? `State: ${state}` : '',
      ].filter(Boolean).join(' | '),
      url: `https://sam.gov/exclusion/${encodeURIComponent(r._id)}/view`,
      date: r.activationDate || null,
      tier,
    }]);
  }).filter(Boolean);
  const notes = [SAM_ACTIVE_ONLY_NOTE];
  if (!hits.length) notes.push(`SAM.gov exclusion list: no match for ${name} among exclusions in force`);
  if (hits.length > 5) notes.push(`SAM.gov exclusion list: ${hits.length} records match the name ${name}; the first 5 are shown`);
  // A cut answer may hold the matching record on a page not read: the screen is partial, never clean
  if (cut) notes.push(`SAM.gov exclusion list: ${cut + rows.length} records contain the words of the name ${name}; the first ${rows.length} were read`);
  return { findings, threads: [], notes, ...(cut ? { partial: [`SAM.gov exclusion list: ${rows.length} of ${cut + rows.length} records read`] } : {}) };
}

/** Rows of the HHS OIG search result table: [last, first, middle, general, specialty, exclusion]. Kept for old callers. */
export function parseOigResults(html) {
  const grid = String(html).match(/<table[^>]*id="ctl00_cpExclusions_gvEmployees"[\s\S]*?<\/table>/i);
  if (!grid) return null;
  const cell = (c) => oneLine(decodeXml(c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')));
  return [...grid[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cell(c[1])))
    .filter((cells) => cells.length >= 6)
    .map((cells) => cells.slice(0, 6));
}

const leieDate = (s) => {
  const m = oneLine(s).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

/**
 * Build the compact index from the LEIE file. Only names, the general category, the specialty, the exclusion
 * type and its date are read: the file's birth date, address, NPI and UPIN columns are never read or kept.
 * About 84,000 rows, packed so the stored copy stays small enough for the shared cache: each row is
 * [name, 0 person | 1 entity, general, specialty, exclusion type, date], the three repeated texts as positions
 * in `dict`. leieRows() turns it back into rows { n, t, g, s, x, d }.
 */
export function parseLeie(text, { minRows = 1000 } = {}) {
  if (!/\n\s*$/.test(String(text).slice(-8))) throw new Error(INCOMPLETE);
  let col = null;
  const rows = [];
  const dict = { g: [], s: [], x: [] };
  const at = { g: new Map(), s: new Map(), x: new Map() };
  const code = (k, v) => {
    if (!at[k].has(v)) { at[k].set(v, dict[k].length); dict[k].push(v); }
    return at[k].get(v);
  };
  eachCsvRow(String(text), ',', (f) => {
    if (!col) {
      col = Object.fromEntries(f.map((h, i) => [oneLine(h).toUpperCase(), i]));
      for (const need of ['LASTNAME', 'FIRSTNAME', 'MIDNAME', 'BUSNAME', 'GENERAL', 'SPECIALTY', 'EXCLTYPE', 'EXCLDATE']) {
        if (col[need] == null) throw new Error('The HHS OIG exclusion file is not in the expected format');
      }
      return;
    }
    if (f.length < 8) return;
    const get = (k) => oneLine(f[col[k]]);
    const last = get('LASTNAME');
    const first = get('FIRSTNAME');
    const business = get('BUSNAME');
    const person = Boolean(last);
    const n = person ? `${last}, ${[first, get('MIDNAME')].filter(Boolean).join(' ')}`.replace(/,\s*$/, '') : business;
    if (!n || !isLatin(n)) return;
    rows.push([n, person ? 0 : 1, code('g', clipText(get('GENERAL'), 40)), code('s', clipText(get('SPECIALTY'), 60)), code('x', clipText(get('EXCLTYPE'), 20)), leieDate(get('EXCLDATE'))]);
  });
  if (rows.length < minRows) throw new Error('The HHS OIG exclusion file had too few entries to be the whole list');
  return { v: 2, key: 'leie', at: new Date().toISOString(), dict, packed: rows };
}

const unpacked = new WeakMap();
/** The LEIE index as rows { n, t, g, s, x, d } (built once per loaded copy, so screenIndex's own memo holds). */
export function leieRows(index) {
  let out = unpacked.get(index);
  if (!out) {
    const { dict = {}, packed = [] } = index || {};
    out = {
      at: index?.at,
      rows: packed.map(([n, t, g, s, x, d]) => compact({ n, t: t ? 'entity' : 'person', g: dict.g?.[g], s: dict.s?.[s], x: dict.x?.[x], d })),
    };
    unpacked.set(index, out);
  }
  return out;
}

const LEIE_LIST = {
  name: 'HHS OIG exclusion list',
  cacheKey: LEIE_CACHE_KEY,
  load: async (deadline) => parseLeie(await fetchList(LEIE_CSV, { deadline, timeoutMs: 24000 })),
};

async function screenOig(task, ctx) {
  const name = oneLine(task.value);
  const copy = await loadIndex(LEIE_LIST, ctx.deadline);
  const index = leieRows(copy.index);
  const person = isPersonTask(task);
  const hits = screenIndex(index, searchedNames(task, ctx), person ? 'person' : 'company');
  const records = (h) => ({
    name: h.row.n,
    tag: h.row.x || '',
    quote: [`Listed name: ${h.row.n}`, h.row.g ? `General: ${h.row.g}` : '', h.row.s ? `Specialty: ${h.row.s}` : '', h.row.x ? `Exclusion: ${h.row.x}` : '', h.row.d ? `Excluded: ${h.row.d}` : ''].filter(Boolean).join(' | '),
    context: [h.row.g, h.row.s].filter(Boolean).join(' '),
    url: OIG_URL,
    date: h.row.d || null,
    tier: h.tier,
  });
  const findings = byStrength(task, hits).map((g) => matchFinding(task, ctx, {
    source: 'us-exclusions', sourceLabel: EXCLUSIONS_LABEL, category: 'sanctions', severity: 'high',
    where: 'on the HHS OIG exclusion list', noun: person ? 'listed people' : 'listed firms',
    coreOnly: g.coreOnly,
    data: { list: 'HHS OIG List of Excluded Individuals/Entities', listReadAt: new Date(copy.at || Date.now()).toISOString(), ...(copy.fresh ? {} : { listStale: true }) },
  }, g.hits.map(records))).filter(Boolean);
  const notes = hits.length ? [] : [`HHS OIG exclusion list: no match for ${name}${asOfText(copy)}`];
  const stale = staleParts(LEIE_LIST.name, copy);
  if (stale) notes.push(stale.note);
  return { findings, threads: [], notes, ...(stale ? { partial: [stale.partial] } : {}) };
}

export const exclusionsConnector = {
  id: 'us-exclusions',
  label: EXCLUSIONS_LABEL,
  // Associates and relatives are screened too (a debarred co-founder matters), graded 'possible' unless the
  // record also names the person being checked
  kinds: ['subject', 'alias', 'company', 'associate', 'relative'],
  prior: 0.4,
  // The LEIE file is about 11 MB: a cold load needs longer than a search
  timeoutMs: 25000,
  /** A person is screened on both lists. A company only on SAM.gov, which also carries the health exclusions of firms. */
  plan(thread) {
    const sam = { template: 'excl.sam', prior: 0.4, why: 'search the SAM.gov exclusion list by name' };
    return thread?.kind === 'company' ? [sam] : [sam, { template: 'excl.leie', prior: 0.4, why: 'screen the name against the HHS OIG exclusion list' }];
  },
  async run(task, ctx) {
    if (!canScreen(task, ctx)) return notScreened(EXCLUSIONS_LABEL, task);
    if (task.template === 'excl.leie') return screenOig(task, ctx);
    return screenSam(task, ctx);
  },
};

/* ------------------------------------------------------------------ */
/* 3. ICIJ Offshore Leaks                                              */
/* ------------------------------------------------------------------ */

const ICIJ_LABEL = 'ICIJ Offshore Leaks database';
const ICIJ_RECONCILE = 'https://offshoreleaks.icij.org/api/v1/reconcile';
export const OFFSHORE_NOTE = 'Appearing in the Offshore Leaks database is not evidence of wrongdoing; many offshore structures are legal.';

export const offshoreLeaksConnector = {
  id: 'offshore-leaks',
  label: ICIJ_LABEL,
  // A leak database, not a watchlist: never searched for an associate or relative by name alone. Another name
  // of the person is searched like their own.
  kinds: ['subject', 'alias', 'company'],
  prior: 0.3,
  timeoutMs: 12000,
  async run(task, ctx) {
    const name = oneLine(task.value);
    if (!isSelfTask(task) && task.kind !== 'company') return { findings: [], threads: [], notes: [] };
    if (!canScreen(task, ctx)) return notScreened(ICIJ_LABEL, task);
    const person = isPersonTask(task);
    // Forms that can be screened only (a name typed in Cyrillic is searched in Latin letters); a company under
    // each known name
    const variants = searchedNames(task, ctx).filter((v) => (person ? isFullName(nameTokens(v)) : companyTokens(v).join('').length >= 3)).slice(0, 3);
    // A person is looked for as an officer (or intermediary) of an offshore entity; a company as the entity itself,
    // or as an officer or intermediary of one. Address records are never requested.
    const types = person ? ['Officer', 'Intermediary'] : ['Entity', 'Officer', 'Intermediary'];
    const queries = {};
    for (const v of variants) for (const type of types) queries[`q${Object.keys(queries).length}`] = { query: v, type, limit: 10 };
    const json = await getJson(ICIJ_RECONCILE, { method: 'POST', body: { queries }, deadline: ctx.deadline, timeoutMs: 10000 });
    const answers = Object.keys(queries).map((k) => json?.[k]?.result);
    if (!answers.some(Array.isArray)) throw new Error('The Offshore Leaks database did not return a search result');
    const byId = new Map();
    for (const list of answers) {
      for (const node of Array.isArray(list) ? list : []) {
        const kind = oneLine(node?.types?.[0]?.name);
        if (!node?.id || !node?.name || !types.includes(kind) || byId.has(String(node.id))) continue;
        const via = person ? '' : [...variants].sort((a, b) => companyTokens(b).length - companyTokens(a).length).find((n) => matchCompanyName(n, node.name)) || '';
        const tier = person ? matchPersonName(variants, node.name) : (via ? 1 : 0);
        if (tier) byId.set(String(node.id), { node, kind, tier, via });
      }
    }
    const hits = [...byId.values()].sort((a, b) => a.tier - b.tier);
    // A one-word company name ("Flow Inc." -> FLOW) matches every offshore shell that shares the word:
    // such a hit is held as 'possible', never reported as the company's own record. A hit through a learned
    // legal name of two or more words is the company's.
    const findings = hits.slice(0, 5).map(({ node, kind, tier, via }) => {
      const coreOnly = !person && isOneWordCompany(via || name);
      const description = oneLine(node.description);
      const leak = (description.match(/extracted from the (.+?) data\.?$/i) || [])[1] || '';
      return matchFinding(task, ctx, {
        source: 'offshore-leaks', sourceLabel: ICIJ_LABEL, category: 'leaks', severity: 'low',
        where: 'in the ICIJ Offshore Leaks database',
        coreOnly,
        data: { nodeId: String(node.id), nodeType: kind, ...(leak ? { leak } : {}) },
      }, [{
        name: oneLine(node.name),
        tag: [kind.toLowerCase(), leak].filter(Boolean).join(', '),
        quote: `${oneLine(node.name)}: ${description || `${kind} record in the Offshore Leaks database.`}`,
        url: `https://offshoreleaks.icij.org/nodes/${encodeURIComponent(node.id)}`,
        tier,
      }]);
    }).filter(Boolean);
    const notes = findings.length ? [OFFSHORE_NOTE] : [`${ICIJ_LABEL}: no match for ${name}`];
    if (hits.length > 5) notes.push(`${ICIJ_LABEL}: ${hits.length} records carry the name ${name}; the first 5 are shown`);
    return { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ */
/* 4. Wanted lists: FBI and EU Most Wanted                             */
/* ------------------------------------------------------------------ */

const WANTED_LABEL = 'Wanted lists (FBI, EU Most Wanted)';
const FBI_LIST = 'https://api.fbi.gov/wanted/v1/list';
const EU_WANTED = 'https://eumostwanted.eu/';
// The FBI feed also carries missing people, victims and appeals for information: never used.
const FBI_NOT_FUGITIVE = /missing|kidnap|vicap|ecap|seeking information|victim|unidentified/i;

async function screenFbi(task, ctx) {
  const name = oneLine(task.value);
  const variants = searchedNames(task, ctx);
  const url = `${FBI_LIST}?title=${encodeURIComponent(coreName(variants))}&pageSize=50&page=1`;
  const json = await getJson(url, { deadline: ctx.deadline, timeoutMs: 10000 });
  if (!json || !Array.isArray(json.items)) throw new Error('The FBI wanted list did not return a search result');
  const findings = [];
  for (const item of json.items) {
    if (!item?.title || !item?.url) continue;
    if (item.person_classification !== 'Main' || /missing|information|assistance/i.test(item.poster_classification || '')) continue;
    if ((item.subjects || []).some((s) => FBI_NOT_FUGITIVE.test(s))) continue;
    // Exact full name only: the title, or an alias the notice gives
    const names = [item.title, ...(Array.isArray(item.aliases) ? item.aliases : [])].map((n) => oneLine(String(n).replace(/["“”]/g, '')));
    const matched = names.find((n) => matchPersonName(variants, n) === 1);
    if (!matched) continue;
    const subjectsText = (item.subjects || []).map(oneLine).filter(Boolean).join('; ');
    const status = oneLine(item.status);
    const finding = matchFinding(task, ctx, {
      source: 'wanted-lists', sourceLabel: WANTED_LABEL, category: 'sanctions', severity: 'high',
      where: 'on the FBI wanted list',
      data: { list: 'FBI wanted list', ...(status && status !== 'na' ? { status } : {}) },
    }, [{
      name: oneLine(item.title),
      tag: subjectsText,
      quote: [
        `Listed name: ${oneLine(item.title)}`,
        matched !== names[0] ? `Also listed as: ${matched}` : '',
        item.description ? `Wanted for: ${oneLine(item.description)}` : '',
        subjectsText ? `Category: ${subjectsText}` : '',
        status && status !== 'na' ? `Status: ${status}` : '',
      ].filter(Boolean).join(' | '),
      url: String(item.url),
      date: item.publication || null,
      tier: 1,
    }]);
    if (finding) findings.push(finding);
    if (findings.length >= 3) break;
  }
  return { findings, threads: [], notes: findings.length ? [] : [`FBI wanted list: no match for ${name}`] };
}

/** The EU Most Wanted page as a compact index: [{ n, u, p, s }]. */
export function parseEuMostWanted(html) {
  const field = (row, cls) => oneLine(decodeXml((row.match(new RegExp(`views-field-${cls}"[^>]*>\\s*<(?:span|div) class="field-content">([\\s\\S]*?)</(?:span|div)>`)) || [])[1] || '').replace(/<[^>]+>/g, ' '));
  const rows = [];
  for (const row of String(html).split(/<div class="[^"]*views-row[^"]*">/).slice(1)) {
    const n = field(row, 'title');
    const path = field(row, 'view-node').replace(/^\/index\.php/, '');
    if (!n || !path.startsWith('/')) continue;
    rows.push(compact({ n, u: path, p: field(row, 'field-crime'), s: field(row, 'field-status'), t: 'person' }));
  }
  return stamp('eu-most-wanted', {}, rows);
}

const EU_WANTED_LIST = {
  name: 'EU Most Wanted list',
  cacheKey: 'watchlist:eu-most-wanted:v1',
  load: async (deadline) => parseEuMostWanted((await request(EU_WANTED, { deadline, timeoutMs: 12000 })).text),
};

async function screenEuWanted(task, ctx) {
  const name = oneLine(task.value);
  const copy = await loadIndex(EU_WANTED_LIST, ctx.deadline);
  const { index } = copy;
  const hits = screenIndex(index, searchedNames(task, ctx), 'person').filter((h) => h.tier === 1);
  const findings = hits.slice(0, 3).map(({ row }) => matchFinding(task, ctx, {
    source: 'wanted-lists', sourceLabel: WANTED_LABEL, category: 'sanctions', severity: 'high',
    where: 'on the EU Most Wanted list',
    data: { list: 'EU Most Wanted', listReadAt: new Date(copy.at || Date.now()).toISOString(), ...(copy.fresh ? {} : { listStale: true }) },
  }, [{
    name: row.n,
    tag: row.p || '',
    quote: [`Listed name: ${row.n}`, row.p ? `Crime: ${row.p}` : '', row.s ? `Status: ${row.s}` : ''].filter(Boolean).join(' | '),
    url: `https://eumostwanted.eu${row.u}`,
    tier: 1,
  }])).filter(Boolean);
  const notes = findings.length ? [] : [`EU Most Wanted list: no match for ${name}${asOfText(copy)}`];
  const stale = staleParts(EU_WANTED_LIST.name, copy);
  if (stale) notes.push(stale.note);
  return { findings, threads: [], notes, ...(stale ? { partial: [stale.partial] } : {}) };
}

export const wantedConnector = {
  id: 'wanted-lists',
  label: WANTED_LABEL,
  kinds: ['subject', 'alias'],
  prior: 0.2,
  timeoutMs: 14000,
  plan() {
    return [
      { template: 'wanted.fbi', prior: 0.2, why: 'search the FBI wanted list for the exact name' },
      { template: 'wanted.eu', prior: 0.15, why: 'search the EU Most Wanted list for the exact name' },
    ];
  },
  async run(task, ctx) {
    if (!isSelfTask(task)) return { findings: [], threads: [], notes: [] };
    if (!canScreen(task, ctx)) return notScreened(WANTED_LABEL, task);
    return task.template === 'wanted.eu' ? screenEuWanted(task, ctx) : screenFbi(task, ctx);
  },
};

// A record found only under another name of the person the user did not type is 'likely' at most (alias.js).
for (const c of [sanctionsListsConnector, exclusionsConnector, offshoreLeaksConnector, wantedConnector]) c.run = withAliasHold(c.run);
