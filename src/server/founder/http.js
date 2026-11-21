/**
 * HTTP for the background-check connectors: one polite client shared by all
 * of them. Free public endpoints are easy to lose access to, so every call
 * is spaced per host, has a timeout, respects the job's deadline, and backs
 * off (briefly) on 429/503 instead of hammering. A host that still says
 * "slow down" (429/403/503) after that is left alone for at least a minute.
 *
 * Every address the client is about to open is checked first, the first one
 * and every redirect hop alike: web addresses only (http or https), and never
 * a private, loopback, link-local, carrier-grade or cloud-metadata address,
 * whether written into the link or reached through the name's DNS answer.
 * Links come from search results and public pages, so a hostile page must not
 * be able to make this server open its own internal network.
 *
 * Tests replace the transport with setTransport(); connectors never call
 * fetch themselves.
 */
import dns from 'dns';

/**
 * The default User-Agent: generic and honest (an automated client, not a
 * browser). It carries no owner details: those are sent only when the owner
 * declares a contact in FOUNDER_HTTP_CONTACT (a URL or address). SEC calls
 * set their own declared agent from SEC_USER_AGENT in sec.js.
 */
export const USER_AGENT = 'diligence-research/1.0 (automated public-records lookup)';

/** The User-Agent sent by default, with the owner's declared contact when one is set. */
export function userAgent() {
  const contact = String(process.env.FOUNDER_HTTP_CONTACT || '').replace(/[\u0000-\u001f\u007f()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return contact ? `diligence-research/1.0 (automated public-records lookup; +${contact})` : USER_AGENT;
}
const DEFAULT_TIMEOUT_MS = 12000;
/** Largest response read by default. A source that downloads a whole list passes maxBytes. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES_CEILING = 96 * 1024 * 1024;
/** Redirects followed before giving up. Five is what browsers' politeness guidance and most crawlers use. */
export const MAX_REDIRECTS = 5;
/** A DNS answer that takes longer than this is treated as no answer. */
const LOOKUP_TIMEOUT_MS = 5000;

/**
 * Minimum gap between two requests to the same host, in ms. Unlisted hosts use DEFAULT_GAP_MS.
 * Hosts that publish a Crawl-delay in robots.txt are listed with that delay (checked 2026-11-20).
 */
export const HOST_GAP_MS = {
  // The Internet Archive allows about 15 requests a minute and refuses connections for minutes after a burst
  'web.archive.org': 4000,
  'archive.org': 1500,
  'efts.sec.gov': 150,
  'www.sec.gov': 150,
  'data.sec.gov': 150,
  'api.gdeltproject.org': 5200, // GDELT asks for one request every 5 seconds
  'query.wikidata.org': 250,
  'html.duckduckgo.com': 1200,
  'lite.duckduckgo.com': 1200,
  'www.bing.com': 600,
  'news.google.com': 400,
  // Both publish "Crawl-delay: 10" in robots.txt
  'littlesis.org': 10000,
  'www.thegazette.co.uk': 10000,
  // The UK Information Commissioner's Office publishes "Crawl-delay: 6"
  'ico.org.uk': 6000,
  'www.ico.org.uk': 6000,
  // The Monetary Authority of Singapore publishes "Crawl-delay: 2"
  'www.mas.gov.sg': 2000,
};
const DEFAULT_GAP_MS = 120;

/** After a refused connection, a paced host is left alone for this long (it is telling us to back off). */
const REFUSED_REST_MS = 60000;
/** A host that answers 429/403/503 after our retries rests at least a minute, doubling on each repeat up to this. */
const SLOW_DOWN_REST_MS = 60000;
const MAX_REST_MS = 15 * 60000;
/** A host whose rest ends further away than this is turned down at once instead of waited for. */
const MAX_REST_WAIT_MS = 10000;

const realFetch = (url, init) => fetch(url, init);
/** The real resolver: every address the name points to, so one private answer among public ones is caught. */
const realLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

let transport = realFetch;
// null: names are not resolved (a fake network has no DNS); literal addresses are still checked
let lookupFn = realLookup;
const nextSlot = new Map();
/** host -> epoch ms until which the host asked to be left alone */
const restUntil = new Map();
/** host -> length of its last rest, for doubling on repeats; cleared by a good answer */
const lastRest = new Map();

let paced = true;

/**
 * Replace the network layer (tests). Pass nothing to restore real fetch.
 * A fake network is not paced (there is no host to be polite to) unless
 * the test asks for it with { paced: true }. Names are not resolved on a
 * fake network unless the test passes { lookup } (a function host ->
 * [{ address, family }]), so a test can show a name that resolves into a
 * private range being refused without touching DNS.
 */
export function setTransport(fn, { paced: keepPacing = false, lookup = null } = {}) {
  transport = fn || realFetch;
  paced = fn ? keepPacing : true;
  lookupFn = fn ? lookup : realLookup;
  nextSlot.clear();
  restUntil.clear();
  lastRest.clear();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Leave a host alone for `ms` (never shortens a rest already set). */
function rest(host, ms) {
  const until = Date.now() + ms;
  restUntil.set(host, Math.max(restUntil.get(host) || 0, until));
  nextSlot.set(host, Math.max(nextSlot.get(host) || 0, until));
}

/**
 * Wait for this host's turn. Returns 'ok', 'late' (the turn comes after the
 * deadline) or 'resting' (the host asked to be left alone for a while yet).
 * Only a call that will actually run books a slot, so turned-away calls do
 * not push the host's queue further back.
 */
async function waitForHost(host, deadline) {
  const gap = paced ? (HOST_GAP_MS[host] ?? DEFAULT_GAP_MS) : 0;
  const now = Date.now();
  if ((restUntil.get(host) || 0) - now > MAX_REST_WAIT_MS) return 'resting';
  const at = Math.max(now, nextSlot.get(host) || 0);
  const wait = at - now;
  if (wait > 0 && deadline && at + 1500 > deadline) return 'late'; // no time left to queue behind others
  nextSlot.set(host, at + gap);
  if (wait > 0) await sleep(wait);
  return 'ok';
}

/**
 * Error codes (error.code), so callers can tell the cases apart without reading messages:
 *   'deadline'  the caller's deadline cut the call short (before it started, or while it ran)
 *   'timeout'   the host did not answer within timeoutMs
 *   'resting'   the host asked to be left alone and no request was made
 *   'blocked'   the address is not a public web address (private network, wrong scheme ...); nothing was sent
 *   'refused'   the caller's onHop check turned a redirect target down; nothing was sent to it
 *   'redirects' more than MAX_REDIRECTS redirects
 *   'too-large' the body passed maxBytes
 *   'status'    the host answered with HTTP 4xx/5xx (error.status)
 *   'network'   the connection failed, or the name could not be found
 */
export class HttpError extends Error {
  constructor(message, { status = null, url = '', retryable = false, retryAt = null, code = null, hopUrl = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryable = retryable;
    // When the host is resting: the time it is free again (epoch ms), so the caller can wait instead of failing
    this.retryAt = retryAt;
    this.code = code || (status ? 'status' : null);
    // For 'blocked' and 'refused' on a redirect: the address that was turned down
    this.hopUrl = hopUrl;
  }
}

// ---------------------------------------------------------------------------------------------
// Address check

/** Parse a dotted IPv4 address into four numbers, or null. */
function ipv4Parts(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Why an IPv4 address is not a public internet address, or '' when it is. */
function ipv4Problem(parts) {
  const [a, b, c] = parts;
  if (a === 0) return 'an unspecified address';
  if (a === 10) return 'a private network address';
  if (a === 100 && b >= 64 && b <= 127) return 'a carrier-grade shared address'; // also covers Alibaba's 100.100.100.200 metadata
  if (a === 127) return 'a loopback address';
  if (a === 169 && b === 254) return 'a link-local address'; // includes the 169.254.169.254 cloud metadata service
  if (a === 172 && b >= 16 && b <= 31) return 'a private network address';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'a reserved address';
  if (a === 192 && b === 168) return 'a private network address';
  if (a === 198 && (b === 18 || b === 19)) return 'a reserved address';
  if (a === 198 && b === 51 && c === 100) return 'a reserved address';
  if (a === 203 && b === 0 && c === 113) return 'a reserved address';
  if (a >= 224) return 'a multicast or reserved address';
  return '';
}

/** Expand an IPv6 address (with optional embedded IPv4 tail) into eight 16-bit numbers, or null. */
function ipv6Words(text) {
  let s = String(text).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null;
  // An embedded dotted IPv4 tail becomes two words
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = ipv4Parts(tail[1]);
    if (!v4) return null;
    s = `${s.slice(0, tail.index)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rear = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rear.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rear];
  if (words.length !== 8 || words.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  return words.map((w) => parseInt(w, 16));
}

/** Why an IPv6 address is not a public internet address, or '' when it is. */
function ipv6Problem(w) {
  const embedded = (hi, lo) => ipv4Problem([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (w.every((x) => x === 0)) return 'an unspecified address';
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return 'a loopback address';
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (old compatible form) carry an IPv4 address
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return embedded(w[6], w[7]) || (w[5] === 0 ? 'a reserved address' : '');
  // 64:ff9b::/96 (NAT64) carries an IPv4 address too
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return embedded(w[6], w[7]);
  if (w[0] === 0x2002) return embedded(w[1], w[2]); // 6to4 carries one in words 1-2
  if ((w[0] & 0xfe00) === 0xfc00) return 'a private network address'; // fc00::/7, includes AWS fd00:ec2::254
  if ((w[0] & 0xffc0) === 0xfe80) return 'a link-local address';
  if ((w[0] & 0xffc0) === 0xfec0) return 'a site-local address';
  if ((w[0] & 0xff00) === 0xff00) return 'a multicast address';
  if (w[0] === 0x2001 && w[1] === 0x0db8) return 'a reserved address';
  if (w[0] === 0x2001 && w[1] === 0) return 'a tunnelled address'; // Teredo hides an IPv4 address
  if (w[0] === 0x0100 && w.slice(1, 4).every((x) => x === 0)) return 'a reserved address'; // discard-only
  return '';
}

/**
 * Why an IP address (v4 or v6, as text) may not be opened, or '' when it is a
 * public internet address. Not an IP address at all: ''.
 */
export function addressProblem(address) {
  const text = String(address || '').replace(/^\[|\]$/g, '');
  const v4 = ipv4Parts(text);
  if (v4) return ipv4Problem(v4);
  const v6 = ipv6Words(text);
  if (v6) return ipv6Problem(v6);
  return '';
}

const BLOCKED_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)$/i;
const isIpLiteral = (host) => Boolean(ipv4Parts(host) || ipv6Words(host));

/**
 * Check one address before it is opened. Throws HttpError (code 'blocked',
 * not retryable) when it is not a public web address; resolves to the parsed
 * URL when it is. `lookup` (host -> [{ address }]) resolves names; pass null
 * to check the written address only.
 *
 * The check runs just before the request, so a name whose DNS answer changes
 * between the check and the connection (DNS rebinding) is not fully closed:
 * pinning the connection to the checked address would need a custom
 * connection agent, which this project does not depend on.
 */
export async function checkTarget(url, { lookup = lookupFn, deadline = null } = {}) {
  let u;
  try { u = url instanceof URL ? url : new URL(String(url)); } catch { throw new HttpError('Invalid URL', { url: String(url), code: 'blocked' }); }
  const href = u.href;
  const blocked = (why) => new HttpError(`Not opened: ${u.hostname || href} is ${why}`, { url: href, code: 'blocked', hopUrl: href });
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw blocked('not a web address');
  if (u.username || u.password) throw blocked('an address with a sign-in in it');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw blocked('not a web address');
  if (BLOCKED_NAME.test(host) || !host.includes('.') && !isIpLiteral(host)) throw blocked('a local network name');
  if (host === 'metadata.google.internal' || host === 'metadata') throw blocked('a cloud metadata service');
  if (isIpLiteral(host)) {
    const why = addressProblem(host);
    if (why) throw blocked(why);
    return u;
  }
  if (!lookup) return u;
  let answers;
  const budget = Math.max(500, Math.min(LOOKUP_TIMEOUT_MS, deadline ? deadline - Date.now() : LOOKUP_TIMEOUT_MS));
  let timer;
  try {
    answers = await Promise.race([
      Promise.resolve().then(() => lookup(host)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), budget); }),
    ]);
  } catch (error) {
    const timedOut = error?.message === 'timeout';
    throw new HttpError(timedOut ? `Timed out after ${Math.round(budget / 1000)}s looking up ${host}` : `${host} could not be found`, { url: href, retryable: true, code: timedOut ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
  }
  const list = (Array.isArray(answers) ? answers : [answers]).map((a) => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  if (!list.length) throw new HttpError(`${host} could not be found`, { url: href, retryable: true, code: 'network' });
  for (const address of list) {
    const why = addressProblem(address);
    if (why) throw blocked(`resolves to ${why}`);
  }
  return u;
}

// ---------------------------------------------------------------------------------------------
// Body reading and decoding

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
};

/** The charset a Content-Type header or the first 2 KB of an HTML page declares, lower-case, or ''. */
export function declaredCharset(contentType, bytes) {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType || ''));
  if (fromHeader) return fromHeader[1].toLowerCase();
  if (!bytes || !bytes.length) return '';
  const head = latin1(bytes.subarray(0, 2048));
  const meta = /<meta[^>]{0,200}?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  if (meta) return meta[1].toLowerCase();
  const xml = /^<\?xml[^>]{0,200}?encoding\s*=\s*["']([\w.:-]+)/i.exec(head);
  return xml ? xml[1].toLowerCase() : '';
}

/**
 * Decode a body to text with the charset it declares (header first, then the
 * page's meta tag), UTF-8 by default. A page that claims or defaults to UTF-8
 * but is really Latin-1 (common in older pages and archive copies) is read as
 * windows-1252 when its bytes are not valid UTF-8 and nothing in them decodes
 * as a real UTF-8 accented letter, so "Jürgen Müller" keeps its umlauts.
 */
export function decodeBody(bytes, contentType = '') {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  // A byte-order mark wins over any declaration
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder('utf-8').decode(data.subarray(3));
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  let label = declaredCharset(contentType, data) || 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(label); } catch { label = 'utf-8'; decoder = new TextDecoder('utf-8'); }
  if (decoder.encoding !== 'utf-8') return decoder.decode(data);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    const lossy = new TextDecoder('utf-8').decode(data);
    // Any genuine non-ASCII letter means the page is mostly UTF-8 with a stray bad byte: keep UTF-8
    // eslint-disable-next-line no-control-regex
    const realUtf8 = /[^\u0000-\u007f�]/.test(lossy);
    return realUtf8 ? lossy : new TextDecoder('windows-1252').decode(data);
  }
}

/**
 * Read a response body as bytes, stopping as soon as it passes `limit`
 * (whether or not Content-Length was sent). Calls onTooLarge(), which must
 * throw, the moment the limit is passed. Works with fake test responses that
 * only offer text().
 */
async function readBody(response, limit, onTooLarge) {
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  if (reader) {
    const chunks = [];
    let size = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > limit) {
        try { await reader.cancel(); } catch { /* already closed */ }
        onTooLarge();
      }
      chunks.push(chunk);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return { bytes: out };
  }
  if (typeof response.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) onTooLarge();
    return { bytes };
  }
  // A fake response that only offers text(): count UTF-8 bytes of what it gave
  const text = typeof response.text === 'function' ? String(await response.text()) : '';
  if (Buffer.byteLength(text, 'utf8') > limit) onTooLarge();
  return { text };
}

/** Retry-After as milliseconds: seconds ("120") or an HTTP date. 0 when absent or in the past. */
export function retryAfterMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Headers that carry a sign-in are not passed on to another site
const PRIVATE_HEADERS = /^(authorization|cookie|proxy-authorization)$/i;

const header = (response, name) => (typeof response?.headers?.get === 'function' ? response.headers.get(name) : null);

/**
 * GET or POST a URL and return { status, headers, text, url } (or bytes in
 * place of text with responseType: 'bytes').
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string|object, timeoutMs?: number, deadline?: number, retries?: number,
 *   accept?: string, maxBytes?: number, retryOn?: number[], onHop?: (url: string, info: { hop: number, from: string|null }) => any,
 *   responseType?: 'text'|'bytes', maxRedirects?: number }} options
 *   deadline: epoch ms after which the call must not be running.
 *   maxBytes: the largest body accepted (default 8 MB). A larger body is an
 *     error, never silently cut short: half a sanctions list would look like
 *     a clean screen. The body is read as a stream and dropped the moment it
 *     passes the limit.
 *   retryOn: statuses retried (up to `retries` times) before giving up; default [429, 503].
 *   onHop: called with every address before it is opened (the first one and
 *     each redirect target). Return false, or a string saying why, to refuse
 *     it: nothing is sent there and the call fails with code 'refused'.
 *   timeoutMs covers the whole chain of redirects and the body.
 */
export async function request(url, {
  method = 'GET', headers = {}, body = undefined, timeoutMs = DEFAULT_TIMEOUT_MS, deadline = null, retries = 1, accept = '*/*',
  maxBytes = MAX_BODY_BYTES, retryOn = [429, 503], onHop = null, responseType = 'text', maxRedirects = MAX_REDIRECTS,
} = {}) {
  let start;
  try { start = new URL(String(url)); } catch { throw new HttpError('Invalid URL', { url }); }
  if (!start.hostname) throw new HttpError('Invalid URL', { url });
  const limit = Math.min(maxBytes, MAX_BODY_BYTES_CEILING);
  const isObject = body && typeof body === 'object' && !(body instanceof Uint8Array) && !(typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams);
  const baseHeaders = { 'User-Agent': userAgent(), Accept: accept, ...(isObject ? { 'Content-Type': 'application/json' } : {}), ...headers };
  const baseBody = body !== undefined ? (isObject ? JSON.stringify(body) : body) : undefined;
  const retrySet = new Set(retryOn);
  let attempt = 0;
  for (;;) {
    // Each attempt walks the redirect chain from the first address again
    let current = start;
    let previous = null;
    let hopMethod = method;
    let hopBody = baseBody;
    let hopHeaders = { ...baseHeaders };
    let host = current.hostname;
    const attemptEnd = Date.now() + timeoutMs;
    let budget = timeoutMs;
    let cutByDeadline = false;
    let controller = null;
    let timer = null;
    try {
      let response;
      for (let hop = 0; ; hop += 1) {
        host = current.hostname;
        if (onHop) {
          let verdict;
          try {
            // eslint-disable-next-line no-await-in-loop
            verdict = await onHop(current.href, { hop, from: previous });
          } catch (hookError) {
            // The caller's own check could not decide (say its robots lookup failed): the address is not opened
            if (hookError instanceof HttpError) throw hookError;
            throw new HttpError(String(hookError?.message || hookError), { url: String(url), code: 'refused', hopUrl: current.href });
          }
          if (verdict === false || typeof verdict === 'string') {
            throw new HttpError(typeof verdict === 'string' && verdict ? verdict : `Not opened: ${current.href} was turned down`, { url: String(url), code: 'refused', hopUrl: current.href });
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await checkTarget(current, { deadline });
        // eslint-disable-next-line no-await-in-loop
        const turn = await waitForHost(host, deadline);
        if (turn === 'resting') throw new HttpError(`${host} asked us to wait; it is being left alone for now`, { url: String(url), retryable: true, retryAt: restUntil.get(host) || null, code: 'resting' });
        if (turn === 'late') throw new HttpError('Out of time before the request could start', { url: String(url), retryable: true, code: 'deadline' });
        const left = attemptEnd - Date.now();
        const toDeadline = deadline ? deadline - Date.now() : Infinity;
        budget = Math.min(left, toDeadline);
        cutByDeadline = toDeadline < left;
        if (budget < 800) throw new HttpError('Out of time', { url: String(url), retryable: true, code: cutByDeadline ? 'deadline' : 'timeout' });
        clearTimeout(timer);
        controller = new AbortController();
        const thisController = controller;
        timer = setTimeout(() => thisController.abort(), budget);
        // eslint-disable-next-line no-await-in-loop
        // The first address goes out exactly as the caller wrote it (URL parsing would re-encode characters
        // such as an apostrophe); redirect targets go out as resolved
        response = await transport(current === start ? String(url) : current.href, {
          method: hopMethod,
          signal: controller.signal,
          redirect: 'manual',
          headers: hopHeaders,
          ...(hopBody !== undefined ? { body: hopBody } : {}),
        });
        const location = REDIRECT_STATUSES.has(response.status) ? header(response, 'location') : null;
        if (!location) break;
        try { response.body?.cancel?.(); } catch { /* nothing to drop */ }
        if (hop + 1 > maxRedirects) throw new HttpError(`More than ${maxRedirects} redirects`, { url: String(url), code: 'redirects', hopUrl: current.href });
        let next;
        try { next = new URL(location, current); } catch { throw new HttpError('Redirect to an invalid address', { url: String(url), code: 'blocked' }); }
        // 303, and 301/302 after a POST, continue as a GET without a body (what browsers do)
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && hopMethod === 'POST')) {
          hopMethod = 'GET';
          hopBody = undefined;
          hopHeaders = Object.fromEntries(Object.entries(hopHeaders).filter(([k]) => !/^content-/i.test(k)));
        }
        if (next.origin !== current.origin) hopHeaders = Object.fromEntries(Object.entries(hopHeaders).filter(([k]) => !PRIVATE_HEADERS.test(k)));
        previous = current.href;
        current = next;
      }

      const status = response.status;
      const waitMs = retryAfterMs(header(response, 'retry-after'));
      // The host said "slow down" and we will not try again now: leave it alone, longer on each repeat
      const slowDown = () => {
        if (!paced) return;
        const ms = Math.min(MAX_REST_MS, Math.max(waitMs, SLOW_DOWN_REST_MS, (lastRest.get(host) || 0) * 2));
        lastRest.set(host, ms);
        rest(host, ms);
      };
      if (retrySet.has(status) && attempt < retries) {
        attempt += 1;
        try { response.body?.cancel?.(); } catch { /* nothing to drop */ }
        const wait = Math.min(waitMs || (status >= 500 && status !== 503 ? 2500 : 1500 * attempt), 6000);
        if (deadline && Date.now() + wait + 1500 > deadline) {
          if (status === 429 || status === 503) slowDown();
          throw new HttpError(`Rate limited (${status})`, { status, url: String(url), retryable: true });
        }
        clearTimeout(timer);
        timer = null;
        // eslint-disable-next-line no-await-in-loop
        await sleep(wait);
        continue;
      }
      if (status === 429 || status === 403 || status === 503) slowDown();
      const tooLarge = () => {
        controller?.abort();
        throw new HttpError(`Response larger than ${Math.round(limit / 1048576)} MB`, { status, url: String(url), code: 'too-large' });
      };
      const declaredLength = Number(header(response, 'content-length'));
      if (status < 400 && Number.isFinite(declaredLength) && declaredLength > limit) tooLarge(); // refuse before reading the body
      if (status >= 400) {
        try { response.body?.cancel?.(); } catch { /* nothing to drop */ }
        throw new HttpError(`HTTP ${status}`, { status, url: String(url), retryable: status === 429 || status >= 500 });
      }
      // eslint-disable-next-line no-await-in-loop
      const read = await readBody(response, limit, tooLarge);
      if (status < 300) lastRest.delete(host);
      const finalUrl = current.href === start.href ? (response.url || String(url)) : current.href;
      const out = { status, headers: response.headers, url: finalUrl };
      if (responseType === 'bytes') out.bytes = read.bytes || new Uint8Array(Buffer.from(read.text || '', 'utf8'));
      else out.text = read.text !== undefined ? read.text : decodeBody(read.bytes, header(response, 'content-type'));
      return out;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const timedOut = error?.name === 'AbortError';
      // A host we pace on purpose that refuses the connection wants a rest, not an immediate second try
      if (!timedOut && paced && (HOST_GAP_MS[host] || 0) >= 1000) {
        rest(host, REFUSED_REST_MS);
        throw new HttpError(`${host} refused the connection; it is being left alone for a minute`, { url: String(url), retryable: true, retryAt: restUntil.get(host) || nextSlot.get(host) || null, code: 'resting' });
      }
      if (!timedOut && attempt < retries && !(deadline && Date.now() + 2500 > deadline)) {
        attempt += 1;
        clearTimeout(timer);
        timer = null;
        // eslint-disable-next-line no-await-in-loop
        await sleep(400 * attempt);
        continue;
      }
      throw new HttpError(timedOut ? `Timed out after ${Math.round(budget / 1000)}s` : String(error?.message || error), {
        url: String(url), retryable: true, code: timedOut ? (cutByDeadline ? 'deadline' : 'timeout') : 'network',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** GET (or POST) and parse JSON. Throws HttpError when the body is not JSON. */
export async function getJson(url, options = {}) {
  const { text } = await request(url, { accept: 'application/json', ...options });
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('Response was not JSON', { url });
  }
}

/** GET and return the body as text. */
export async function getText(url, options = {}) {
  const { text } = await request(url, options);
  return text;
}

/**
 * GET and return the body as bytes (a Uint8Array), with the same address
 * checks, pacing, redirect rules and size limit as request(). For small
 * binary downloads such as a zip file of a list.
 */
export async function getBytes(url, options = {}) {
  const { bytes } = await request(url, { accept: 'application/octet-stream,*/*', ...options, responseType: 'bytes' });
  return bytes;
}

/** Run async jobs with at most `limit` in flight; results keep the input order, failures become null. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------
// HTML to text

// Latin-1 named entities, in code point order from U+00A0, so accented names in older pages decode
const LATIN1_NAMES = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot '
  + 'cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute '
  + 'Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml '
  + 'aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute '
  + 'ucirc uuml yacute thorn yuml').split(' ');
const ENTITIES = Object.fromEntries(LATIN1_NAMES.map((name, i) => [name, String.fromCharCode(0xa0 + i)]));
Object.assign(ENTITIES, {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', sbquo: "'", bdquo: '"',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', euro: '€', trade: '™', ensp: ' ', emsp: ' ', thinsp: ' ',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', Zcaron: 'Ž', zcaron: 'ž', Ccaron: 'Č', ccaron: 'č',
  Ecaron: 'Ě', ecaron: 'ě', Rcaron: 'Ř', rcaron: 'ř', Ncaron: 'Ň', ncaron: 'ň', Dcaron: 'Ď', dcaron: 'ď',
  Tcaron: 'Ť', tcaron: 'ť', Uring: 'Ů', uring: 'ů', Lstrok: 'Ł', lstrok: 'ł', Nacute: 'Ń', nacute: 'ń',
  Sacute: 'Ś', sacute: 'ś', Zacute: 'Ź', zacute: 'ź', Zdot: 'Ż', zdot: 'ż', Cacute: 'Ć', cacute: 'ć',
  Aogon: 'Ą', aogon: 'ą', Eogon: 'Ę', eogon: 'ę', Odblac: 'Ő', odblac: 'ő', Udblac: 'Ű', udblac: 'ű',
  Gbreve: 'Ğ', gbreve: 'ğ', Idot: 'İ', imath: 'ı', Scedil: 'Ş', scedil: 'ş', Abreve: 'Ă', abreve: 'ă',
  Amacr: 'Ā', amacr: 'ā', Emacr: 'Ē', emacr: 'ē', Imacr: 'Ī', imacr: 'ī', Umacr: 'Ū', umacr: 'ū',
});
// The few that pages also write in capitals
const CASELESS = new Set(['nbsp', 'amp', 'lt', 'gt', 'quot', 'apos']);

const codePoint = (n) => {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return ' ';
  return String.fromCodePoint(n);
};

/** Decode HTML entities in one pass (so "&amp;lt;" stays "&lt;", as in a browser). Unknown names are kept as written. */
export function decodeEntities(text) {
  return String(text || '').replace(/&(#\d{1,8}|#x[0-9a-f]{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, name) => {
    if (name[0] === '#') return codePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    if (Object.prototype.hasOwnProperty.call(ENTITIES, name)) return ENTITIES[name];
    const lower = name.toLowerCase();
    return CASELESS.has(lower) ? ENTITIES[lower] : m;
  });
}

const RAW_BLOCK = /<(script|style|noscript|svg|template)\b/iy;
const TAG_NAME = /^<(\/?)([a-z][a-z0-9]*)/i;
const LINE_TAGS_OPEN = new Set(['br']);
const LINE_TAGS_CLOSE = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article']);

/**
 * Visible text of an HTML document: scripts, styles and tags removed, entities decoded, whitespace collapsed.
 *
 * One left-to-right scan with indexOf, so it runs in linear time on any input: a hostile page of
 * megabytes of unclosed "<script" or "<!--" (which made the old lazy regular expressions quadratic and
 * froze the server) takes milliseconds. A block or comment that is never closed hides the rest of the
 * page, as it does in a browser.
 */
export function htmlToText(html) {
  const src = String(html || '');
  const out = [];
  let i = 0;
  let gt = 0; // position of the next '>' at or after the current tag start; -1 once there is none left
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { out.push(src.slice(i)); break; }
    out.push(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const close = src.indexOf('-->', lt + 4);
      if (close < 0) break; // unclosed comment: the rest is hidden
      out.push(' ');
      i = close + 3;
      continue;
    }
    RAW_BLOCK.lastIndex = lt;
    const block = RAW_BLOCK.exec(src);
    if (block) {
      const closer = new RegExp(`</${block[1]}\\s*>`, 'gi');
      closer.lastIndex = lt + block[0].length;
      const end = closer.exec(src);
      if (!end) break; // unclosed script or style: the rest is hidden
      out.push(' ');
      i = closer.lastIndex;
      continue;
    }
    if (gt !== -1 && gt <= lt) gt = src.indexOf('>', lt + 1);
    if (gt === -1) { out.push(src.slice(lt)); break; } // no tag can close: the rest is plain text
    if (gt === lt + 1) { out.push('<'); i = lt + 1; continue; } // "<>" is not a tag
    const name = TAG_NAME.exec(src.slice(lt, Math.min(gt + 1, lt + 40)));
    const tag = name ? name[2].toLowerCase() : '';
    const lineBreak = name && (name[1] ? LINE_TAGS_CLOSE.has(tag) : LINE_TAGS_OPEN.has(tag));
    out.push(lineBreak ? '\n' : ' ');
    i = gt + 1;
  }
  return decodeEntities(out.join(''))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    // Spaces were collapsed to one just above, so " ?" keeps this linear (a "\s*" before the newline would not be)
    .replace(/ ?\n\s*/g, '\n')
    .trim();
}
