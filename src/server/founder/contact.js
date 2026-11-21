/**
 * The contact the deep check declares to the few official sites that refuse automated readers which do not
 * name one: the SEC's website (www.sec.gov), the FTC case search (www.ftc.gov) and crates.io.
 *
 * Where it comes from, first match wins:
 *   1. the operator's own setting. For the SEC: SEC_USER_AGENT as written, else an email in
 *      FOUNDER_HTTP_CONTACT. For the FTC and crates.io: FOUNDER_HTTP_CONTACT. Then no person's address is sent.
 *   2. the signed-in person's name and email from Google sign-in, for the checks that person runs. Nobody has
 *      to configure anything; the person who asks for the check is the one named to those three sites.
 *
 * The signed-in contact is held for one request in AsyncLocalStorage (withSignedInContact), so it reaches every
 * lookup that request awaits and never another person's check running at the same time. It is never written
 * into the job, the report, a log line, an error message or a cache key, and the sources send it only to their
 * own host (requestOptionsFor locks the request to that host, redirects included). The page is told only where
 * the contact came from (contactSource), never the address.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { USER_AGENT } from './http';

const scope = new AsyncLocalStorage();

/** The hosts a person's address may be sent to, and nothing else. */
export const CONTACT_HOSTS = { sec: 'www.sec.gov', ftc: 'www.ftc.gov', crates: 'crates.io' };

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const EMAIL_IN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// A plain address: one @, a local part of ordinary characters, a domain of real labels ending in letters.
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
// Names that never reach the open internet: an address there is not a contact anyone can write to.
const NOT_REAL_TLD = new Set(['localhost', 'local', 'localdomain', 'internal', 'invalid', 'test', 'example', 'lan', 'home', 'corp', 'intranet']);

const oneLine = (s) => String(s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

/** A plain address with a real domain, lower-cased, or ''. The local test account (…@localhost) is not one. */
function cleanEmail(value) {
  const e = oneLine(value).toLowerCase();
  if (!e || e.length > 254 || !PLAIN_EMAIL.test(e)) return '';
  const tld = e.slice(e.lastIndexOf('.') + 1);
  return NOT_REAL_TLD.has(tld) ? '' : e;
}

// Latin letters that carry no accent to strip, so NFKD leaves them whole: spelled the way they are usually
// written in plain letters, so "Đặng" becomes "Dang" rather than "ang".
const PLAIN_LETTERS = { 'Đ': 'D', 'đ': 'd', 'Ł': 'L', 'ł': 'l', 'Ø': 'O', 'ø': 'o', 'ß': 'ss', 'Æ': 'AE', 'æ': 'ae', 'Œ': 'OE', 'œ': 'oe', 'Þ': 'Th', 'þ': 'th', 'Ð': 'D', 'ð': 'd', 'ı': 'i', 'Ħ': 'H', 'ħ': 'h' };

/**
 * The name as it may sit in a User-Agent: plain printable ASCII only (fetch refuses a header value with a
 * character above U+00FF, which would break every request carrying it, so accents are taken off and other
 * scripts are left out), no control characters, no brackets of any kind (they would break the header's comment,
 * or pass as an address), never an "@" (a second address smuggled in as a name), 80 characters at most. A name
 * with nothing usable left, such as one written only in Chinese characters, is left out; the address alone is
 * still a contact.
 */
function cleanName(value) {
  const plain = String(value ?? '')
    .replace(/[ĐđŁłØøßÆæŒœÞþÐðıĦħ]/g, (ch) => PLAIN_LETTERS[ch])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ');
  const n = oneLine(plain.replace(/[()[\]{}<>]/g, ' '));
  if (!n || n.includes('@') || !/[A-Za-z0-9]/.test(n)) return '';
  return n.slice(0, 80).trim();
}

/** The signed-in person's contact cleaned for use, or null when there is no usable email. */
export function cleanContact(contact) {
  if (!contact || typeof contact !== 'object') return null;
  const email = cleanEmail(contact.email);
  if (!email) return null;
  return Object.freeze({ name: cleanName(contact.name), email });
}

/**
 * Run fn with the signed-in person's { name, email } in scope for everything it awaits. A missing or unusable
 * contact runs fn with none in scope (an outer one never leaks in).
 */
export function withSignedInContact(contact, fn) {
  return scope.run({ contact: cleanContact(contact) }, fn);
}

const signedIn = () => scope.getStore()?.contact || null;
const accountText = (c) => (c.name ? `${c.name} ${c.email}` : c.email);

/**
 * The contact to declare, or null when there is none.
 *   kind 'sec'  -> the full User-Agent the SEC asks for ("Name email"): SEC_USER_AGENT as written, else the code's
 *                  generic client name and an email from FOUNDER_HTTP_CONTACT, else the same with the signed-in
 *                  person's name and email.
 *   kind 'site' -> the contact text for the FTC and crates.io: FOUNDER_HTTP_CONTACT, else "Name email" of the
 *                  signed-in person.
 * @returns {{ agent: string, from: 'operator'|'account' } | null}
 */
export function contactFor(kind) {
  if (kind === 'sec') {
    const own = oneLine(process.env.SEC_USER_AGENT);
    if (own) return { agent: own.slice(0, 200), from: 'operator' };
    const email = (String(process.env.FOUNDER_HTTP_CONTACT || '').match(EMAIL_IN) || [])[0];
    if (email) return { agent: `diligence-research ${email}`, from: 'operator' };
    const c = signedIn();
    return c ? { agent: `diligence-research ${accountText(c)}`, from: 'account' } : null;
  }
  if (kind === 'site') {
    const own = oneLine(process.env.FOUNDER_HTTP_CONTACT);
    if (own) return { agent: own.slice(0, 200), from: 'operator' };
    const c = signedIn();
    return c ? { agent: accountText(c), from: 'account' } : null;
  }
  return null;
}

/**
 * Where the contact for this request comes from, for the page, so its note names exactly the sites given the
 * person's address (never the address itself):
 *   'account'      the SEC, the FTC and crates.io are all given the signed-in person's contact
 *   'account-sec'  only the SEC is (the operator's FOUNDER_HTTP_CONTACT, a web address, goes to the FTC and crates.io)
 *   'account-site' only the FTC and crates.io are (the operator's SEC_USER_AGENT goes to the SEC)
 *   'operator'     only the operator's settings are sent;  'none'  no contact at all.
 */
export function contactSource() {
  const sec = contactFor('sec')?.from;
  const site = contactFor('site')?.from;
  if (sec === 'account' && site === 'account') return 'account';
  if (sec === 'account') return 'account-sec';
  if (site === 'account') return 'account-site';
  if (sec === 'operator' || site === 'operator') return 'operator';
  return 'none';
}

/**
 * Extra request options for a call to `host` carrying the signed-in person's contact, or {} when the contact is
 * the operator's (http.js already sends FOUNDER_HTTP_CONTACT, and sec.js its own setting) or there is none.
 * With an account contact the User-Agent names it, and the request is held to `host`: a redirect to any other
 * host is not followed, so the address cannot be carried somewhere it was not meant for.
 * @param {'sec'|'site'} kind
 * @param {string} host  the one host this contact may go to
 * @param {string} url   the address about to be asked (a different host gets nothing)
 */
export function requestOptionsFor(kind, host, url) {
  const contact = contactFor(kind);
  if (!contact || contact.from !== 'account') return {};
  let target = '';
  try { target = new URL(String(url)).hostname.toLowerCase(); } catch { return {}; }
  if (target !== host) return {};
  const agent = kind === 'sec' ? contact.agent : USER_AGENT.replace(/\)$/, `; +${contact.agent})`);
  return {
    headers: { 'User-Agent': agent },
    onHop: (next) => {
      let to = '';
      try { to = new URL(next).hostname.toLowerCase(); } catch { /* refused below */ }
      return to === host ? true : `Not opened: ${host} sent the request on to another site`;
    },
  };
}
