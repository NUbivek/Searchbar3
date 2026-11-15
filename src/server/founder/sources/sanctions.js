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
 *                    (SAM.gov) and federal health programmes (HHS OIG).
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
 * There is no fuzzy matching. A hit on a person is a name match and nothing
 * more: it is graded by makeFinding ("possible") unless the list's own text
 * names something the person is known for, and every title says "verify
 * identity". A company is matched only on tier 1 of its name with the legal
 * form removed, never on part of a name (a bracketed part included).
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
import { cached } from '../cache';
import { mentionsMinor } from '../guardrails';

const DAY_MS = 24 * 60 * 60 * 1000;
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

/** The name as given and without middle initials ("Elizabeth A. Holmes" -> also "Elizabeth Holmes"). */
export function personVariants(name) {
  const words = oneLine(name).split(' ').filter(Boolean);
  const out = [words.join(' ')];
  if (words.length > 2) {
    const core = words.filter((w, i) => i === 0 || i === words.length - 1 || !/^[A-Za-z]\.?$/.test(w));
    if (core.length >= 2 && core.length < words.length) out.push(core.join(' '));
  }
  return out.filter(Boolean);
}

/** A listed name as written, and without a bracketed part ("Hanif Computer Zone (HCZ)"). */
const listedForms = (name) => {
  const bare = oneLine(String(name).replace(/\([^)]*\)/g, ' '));
  return bare && bare !== name ? [name, bare] : [name];
};

/**
 * The best match between a searched person and one listed name.
 * @param {string[]} variants the searched name and its variants
 * @param {string} listed
 * @returns {0|1|2}
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
 * @param {string[]} names the searched name and its variants (one entry for a company)
 * @param {'person'|'company'} mode
 * @returns {Array<{ row: object, tier: 1|2, matched: string, alias: boolean }>} tier 1 first
 */
export function screenIndex(index, names, mode) {
  const hits = [];
  const table = prepare(index);
  if (mode === 'company') {
    const want = companyTokens(names[0]);
    if (want.join('').length < 3) return hits;
    index.rows.forEach((row, i) => {
      if (row.t === 'person') return;
      for (const name of table[i]) {
        if (!want.every((t) => name.k.includes(` ${t} `))) continue;
        if (matchCompanyName(names[0], name.s)) { hits.push({ row, tier: 1, matched: name.s, alias: name.alias }); return; }
      }
    });
    return hits;
  }
  const wants = names.map((n) => ({ set: nameTokens(n), order: orderedTokens(n) })).filter((w) => isFullName(w.set));
  if (!wants.length) return hits;
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

/** The role or reason a list gives, without sentences that carry personal details or family members. */
export function reasonText(text, max = 260) {
  const kept = oneLine(text).split(/(?<=[.;])\s+/).filter((s) => s && !PERSONAL.test(s) && !mentionsMinor(s) && !/https?:\/\//i.test(s));
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

const loadIndex = (list, deadline) => cached(list.cacheKey, DAY_MS, () => list.load(deadline));

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

const isPersonTask = (task) => task.kind !== 'company';
const searchedNames = (task, ctx) => {
  if (task.kind === 'company') return [oneLine(task.value)];
  if (task.kind === 'subject' && ctx?.subject?.variants?.length) return [...new Set([...ctx.subject.variants, ...personVariants(ctx.subject.name)])];
  return personVariants(task.value);
};

/**
 * Grade and build one finding for a name match.
 *   subject    graded by makeFinding from the person's name plus the list's own context
 *   company    'company' (the caller has already required tier 1); 'possible' (held) when the caller
 *              says the name is a single word once the legal form is removed (meta.coreOnly)
 *   associate, relative   title names who it is about; 'possible' unless the record also names the subject
 */
function gradedFinding(task, ctx, f, context, coreOnly = false) {
  const subject = ctx.subject;
  if (task.kind === 'company' && coreOnly) {
    return makeFinding(subject, { ...f, match: 'possible', matchReasons: ['only the company name\'s one distinctive word matches; many unrelated companies share a one-word name'] });
  }
  if (task.kind === 'company') return makeFinding(subject, { ...f, match: 'company', matchReasons: ['the listed name is the same as the company name'] });
  if (task.kind === 'associate' || task.kind === 'relative') {
    const reason = `name match on ${task.kind === 'relative' ? 'a relative' : 'an associate'} of the subject`;
    return makeFinding(subject, f) || makeFinding(subject, { ...f, match: 'possible', matchReasons: [reason] });
  }
  return makeFinding(subject, { ...f, matchText: `${properCase(subject.name)}. ${context}` })
    || makeFinding(subject, { ...f, match: 'possible', matchReasons: ['matched by name only'] });
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
  const base = `Name match ${meta.where}: ${head}: verify identity`;
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
  }, shown.map((r) => `${r.context || ''}`).join(' '), Boolean(meta.coreOnly));
  // A list's reason text must never cost the hit itself: without it the record is still reported.
  return build(true) || build(false);
}

const TYPE_WORD = { person: 'individual', entity: 'entity' };

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
    row.e ? `End date: ${row.e}` : '',
  ].filter(Boolean);
  return {
    name: row.n,
    tag: row.p || (subList.match(/\(([^)]+)\)/) || [])[1] || '',
    quote: parts.join(' | '),
    context: row.r ? `Role or reason given: ${row.r}` : '',
    url: list.link(row, index),
    date: row.d || null,
    tier: hit.tier,
  };
}

/** Screen one name against one list. Resolves to { finding, clean }. */
async function screenList(list, task, ctx) {
  const index = await loadIndex(list, ctx.deadline);
  const hits = screenIndex(index, searchedNames(task, ctx), isPersonTask(task) ? 'person' : 'company');
  const finding = matchFinding(task, ctx, {
    source: 'sanctions-lists',
    sourceLabel: groupLabel(),
    category: 'sanctions',
    severity: 'high',
    where: `on the ${list.name}`,
    data: { list: list.name, listKey: list.key, listReadAt: index.at, ...(index.asOf ? { listDated: index.asOf } : {}) },
  }, hits.map((h) => listRecord(list, index, h)));
  return { finding, clean: hits.length === 0 };
}

/** False when a name cannot be screened at all (a single word for a person, a two-letter company). */
const canScreen = (task, ctx) => (isPersonTask(task)
  ? searchedNames(task, ctx).some((v) => isFullName(nameTokens(v)))
  : companyTokens(task.value).join('').length >= 3);

/* ------------------------------------------------------------------ */
/* 1. Sanctions lists                                                  */
/* ------------------------------------------------------------------ */

const ALL_LISTS = 'list.all';

export const sanctionsListsConnector = {
  id: 'sanctions-lists',
  get label() { return groupLabel(); },
  kinds: ['subject', 'company', 'associate', 'relative'],
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
    if (!canScreen(task, ctx)) return { findings: [], threads: [], notes: [...notes, `${groupLabel()}: "${name}" is too short a name to screen`] };

    const wanted = String(task.template || ALL_LISTS);
    if (wanted !== ALL_LISTS) {
      const list = activeLists().find((l) => `list.${l.key}` === wanted);
      if (!list) throw new Error(`Unknown sanctions list: ${wanted}`);
      const { finding, clean } = await screenList(list, task, ctx);
      if (clean) notes.push(`${list.name}: no match for ${name}`);
      return { findings: [finding].filter(Boolean), threads: [], notes };
    }

    const lists = activeLists();
    const results = await Promise.allSettled(lists.map((l) => screenList(l, task, ctx)));
    const failed = lists.filter((l, i) => results[i].status === 'rejected');
    if (failed.length === lists.length) throw results[0].reason;
    const findings = results.map((r) => (r.status === 'fulfilled' ? r.value.finding : null)).filter(Boolean);
    const cleanLists = lists.filter((l, i) => results[i].status === 'fulfilled' && results[i].value.clean);
    if (cleanLists.length === lists.length) notes.push(`${groupLabel()}: no match for ${name}`);
    else for (const l of cleanLists) notes.push(`${l.name}: no match for ${name}`);
    for (const l of failed) notes.push(`${l.name}: could not be read, so ${name} was not screened against it`);
    return { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ */
/* 2. US federal exclusions: SAM.gov and HHS OIG                       */
/* ------------------------------------------------------------------ */

const EXCLUSIONS_LABEL = 'US federal exclusion lists (SAM.gov, HHS OIG)';
const SAM_SEARCH = 'https://sam.gov/api/prod/sgs/v1/search/';
const OIG_URL = 'https://exclusions.oig.hhs.gov/';

/** The shortest searched form of a person's name: first and last name, no middle initials. */
const coreName = (variants) => variants.slice().sort((a, b) => a.split(' ').length - b.split(' ').length)[0];

async function screenSam(task, ctx) {
  const name = oneLine(task.value);
  const person = isPersonTask(task);
  const variants = searchedNames(task, ctx);
  const q = person ? normalizeName(coreName(variants)) : companyTokens(name).join(' ');
  const url = `${SAM_SEARCH}?index=ex&q=${encodeURIComponent(q.toLowerCase())}&qMode=ALL&page=0&size=50&mode=search&sort=-relevance&is_active=true`;
  const json = await getJson(url, { deadline: ctx.deadline, accept: 'application/hal+json', timeoutMs: 12000 });
  if (!json || (json.page == null && json._embedded == null)) throw new Error('SAM.gov did not return a search result');
  const rows = Array.isArray(json._embedded?.results) ? json._embedded.results : [];
  const seen = new Set();
  const hits = [];
  for (const r of rows) {
    const listed = oneLine(r?.title);
    const individual = /individual/i.test(r?.classification?.code || '');
    // Rows copied from the Treasury sanctions list are already covered by the screening list
    if (!listed || !r?._id || individual !== person || /OFAC/i.test(`${r.excludingAgency || ''} ${r.excludingAgencyDesc || ''}`)) continue;
    const tier = person ? matchPersonName(variants, listed) : (matchCompanyName(name, listed) ? 1 : 0);
    if (!tier) continue;
    const key = [normalizeName(listed), r.excludingAgency, r.exclusionType, r.activationDate].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ r, listed, tier });
  }
  hits.sort((a, b) => a.tier - b.tier);
  const findings = hits.slice(0, 5).map(({ r, listed, tier }) => {
    const agency = oneLine(r.excludingAgencyDesc || r.excludingAgency);
    const state = r.address?.state && /^(USA|US)$/i.test(r.address?.country || '') ? `${r.address.state}, USA` : oneLine(r.address?.country);
    return matchFinding(task, ctx, {
      source: 'us-exclusions', sourceLabel: EXCLUSIONS_LABEL, category: 'sanctions', severity: 'high',
      where: 'on the SAM.gov exclusion list',
      data: { list: 'SAM.gov exclusions', excludingAgency: agency, exclusionType: oneLine(r.exclusionType) || null },
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
        `Termination date: ${oneLine(r.terminationDate) || 'Indefinite'}`,
        state ? `State: ${state}` : '',
      ].filter(Boolean).join(' | '),
      url: `https://sam.gov/exclusion/${encodeURIComponent(r._id)}/view`,
      date: r.activationDate || null,
      tier,
    }]);
  }).filter(Boolean);
  const notes = [];
  if (!hits.length) notes.push(`SAM.gov exclusion list: no match for ${name}`);
  if (hits.length > 5) notes.push(`SAM.gov exclusion list: ${hits.length} records match the name ${name}; the first 5 are shown`);
  if (Number(json.page?.totalElements) > rows.length) notes.push(`SAM.gov exclusion list: ${json.page.totalElements} records contain the words of the name ${name}; the first ${rows.length} were read`);
  return { findings, threads: [], notes };
}

/** Rows of the HHS OIG search result table: [last, first, middle, general, specialty, exclusion]. */
export function parseOigResults(html) {
  const grid = String(html).match(/<table[^>]*id="ctl00_cpExclusions_gvEmployees"[\s\S]*?<\/table>/i);
  if (!grid) return null;
  const cell = (c) => oneLine(decodeXml(c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')));
  return [...grid[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cell(c[1])))
    .filter((cells) => cells.length >= 6)
    .map((cells) => cells.slice(0, 6));
}

async function screenOig(task, ctx) {
  const name = oneLine(task.value);
  const variants = searchedNames(task, ctx);
  const words = normalizeName(coreName(variants)).split(' ');
  const [first, last] = [words[0], words[words.length - 1]];
  // The site needs to see that cookies work before it shows the form
  const page = await request(OIG_URL, { deadline: ctx.deadline, timeoutMs: 10000, headers: { Cookie: 'AspxAutoDetectCookieSupport=1' } });
  const session = (String(page.headers?.get?.('set-cookie') || '').match(/ASP\.NET_SessionId=[^;,\s]+/) || [])[0];
  const fields = {};
  for (const m of page.text.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
    const key = (m[0].match(/name="([^"]*)"/) || [])[1];
    if (key && key.startsWith('__')) fields[key] = decodeXml((m[0].match(/value="([^"]*)"/) || [])[1] || '');
  }
  if (!fields.__VIEWSTATE || !/txtSPLastName/.test(page.text)) throw new Error('The HHS OIG search page was not in the expected format');
  const form = new URLSearchParams(fields);
  form.set('ctl00$cpExclusions$txtSPLastName', last);
  form.set('ctl00$cpExclusions$txtSPFirstName', first);
  form.set('ctl00$cpExclusions$ibSearchSP.x', '20');
  form.set('ctl00$cpExclusions$ibSearchSP.y', '10');
  const result = await request(OIG_URL, {
    method: 'POST', deadline: ctx.deadline, timeoutMs: 10000, body: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: ['AspxAutoDetectCookieSupport=1', session].filter(Boolean).join('; ') },
  });
  const rows = parseOigResults(result.text);
  if (!rows && !/No Results were found/i.test(result.text)) throw new Error('The HHS OIG search did not return a result page');
  const stampLine = oneLine((result.text.match(/Source data updated on[^<]*/i) || [])[0]);
  const records = (rows || []).map(([l, f, m, general, specialty, exclusion]) => {
    const listed = `${l}, ${[f, m].filter(Boolean).join(' ')}`;
    return {
      name: listed,
      tag: exclusion,
      quote: [`Listed name: ${listed}`, general ? `General: ${general}` : '', specialty ? `Specialty: ${specialty}` : '', exclusion ? `Exclusion: ${exclusion}` : ''].filter(Boolean).join(' | '),
      context: [general, specialty].filter(Boolean).join(' '),
      url: OIG_URL,
      tier: matchPersonName(variants, `${f} ${m} ${l}`),
    };
  }).filter((r) => r.tier).sort((a, b) => a.tier - b.tier);
  const finding = matchFinding(task, ctx, {
    source: 'us-exclusions', sourceLabel: EXCLUSIONS_LABEL, category: 'sanctions', severity: 'high',
    where: 'on the HHS OIG exclusion list', noun: 'listed people',
    data: { list: 'HHS OIG List of Excluded Individuals/Entities', ...(stampLine ? { sourceStamp: stampLine } : {}) },
  }, records);
  const notes = records.length ? [] : [`HHS OIG exclusion list: no match for ${name}`];
  if (rows && /Page\$\d+/.test(result.text)) notes.push(`HHS OIG exclusion list: more people share the name ${name} than one result page holds; only the first page was read`);
  return { findings: [finding].filter(Boolean), threads: [], notes };
}

export const exclusionsConnector = {
  id: 'us-exclusions',
  label: EXCLUSIONS_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.4,
  timeoutMs: 15000,
  /** A person is searched on both lists. A company only on SAM.gov, which also carries the health exclusions of firms. */
  plan(thread) {
    const sam = { template: 'excl.sam', prior: 0.4, why: 'search the SAM.gov exclusion list by name' };
    return thread?.kind === 'company' ? [sam] : [sam, { template: 'excl.leie', prior: 0.4, why: 'search the HHS OIG exclusion list by name' }];
  },
  async run(task, ctx) {
    if (!canScreen(task, ctx)) return { findings: [], threads: [], notes: [`${EXCLUSIONS_LABEL}: "${oneLine(task.value)}" is too short a name to screen`] };
    if (task.template === 'excl.leie') {
      if (!isPersonTask(task)) return { findings: [], threads: [], notes: [] };
      return screenOig(task, ctx);
    }
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
  // A leak database, not a watchlist: never searched for an associate or relative by name alone
  kinds: ['subject', 'company'],
  prior: 0.3,
  timeoutMs: 12000,
  async run(task, ctx) {
    const name = oneLine(task.value);
    if (task.kind !== 'subject' && task.kind !== 'company') return { findings: [], threads: [], notes: [] };
    if (!canScreen(task, ctx)) return { findings: [], threads: [], notes: [`${ICIJ_LABEL}: "${name}" is too short a name to search`] };
    const person = isPersonTask(task);
    const variants = searchedNames(task, ctx).slice(0, 3);
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
        const tier = person ? matchPersonName(variants, node.name) : (matchCompanyName(name, node.name) ? 1 : 0);
        if (tier) byId.set(String(node.id), { node, kind, tier });
      }
    }
    const hits = [...byId.values()].sort((a, b) => a.tier - b.tier);
    // A one-word company name ("Flow Inc." -> FLOW) matches every offshore shell that shares the word:
    // such a hit is held as 'possible', never reported as the company's own record.
    const coreOnly = !person && companyTokens(name).length < 2;
    const findings = hits.slice(0, 5).map(({ node, kind, tier }) => {
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

async function screenEuWanted(task, ctx) {
  const name = oneLine(task.value);
  const index = await cached('watchlist:eu-most-wanted:v1', DAY_MS, async () => parseEuMostWanted((await request(EU_WANTED, { deadline: ctx.deadline, timeoutMs: 12000 })).text));
  const hits = screenIndex(index, searchedNames(task, ctx), 'person').filter((h) => h.tier === 1);
  const findings = hits.slice(0, 3).map(({ row }) => matchFinding(task, ctx, {
    source: 'wanted-lists', sourceLabel: WANTED_LABEL, category: 'sanctions', severity: 'high',
    where: 'on the EU Most Wanted list',
    data: { list: 'EU Most Wanted', listReadAt: index.at },
  }, [{
    name: row.n,
    tag: row.p || '',
    quote: [`Listed name: ${row.n}`, row.p ? `Crime: ${row.p}` : '', row.s ? `Status: ${row.s}` : ''].filter(Boolean).join(' | '),
    url: `https://eumostwanted.eu${row.u}`,
    tier: 1,
  }])).filter(Boolean);
  return { findings, threads: [], notes: findings.length ? [] : [`EU Most Wanted list: no match for ${name}`] };
}

export const wantedConnector = {
  id: 'wanted-lists',
  label: WANTED_LABEL,
  kinds: ['subject'],
  prior: 0.2,
  timeoutMs: 14000,
  plan() {
    return [
      { template: 'wanted.fbi', prior: 0.2, why: 'search the FBI wanted list for the exact name' },
      { template: 'wanted.eu', prior: 0.15, why: 'search the EU Most Wanted list for the exact name' },
    ];
  },
  async run(task, ctx) {
    if (task.kind !== 'subject') return { findings: [], threads: [], notes: [] };
    if (!canScreen(task, ctx)) return { findings: [], threads: [], notes: [`${WANTED_LABEL}: "${oneLine(task.value)}" is too short a name to search`] };
    return task.template === 'wanted.eu' ? screenEuWanted(task, ctx) : screenFbi(task, ctx);
  },
};
