/**
 * HTTP for the background-check connectors: one polite client shared by all
 * of them. Free public endpoints are easy to lose access to, so every call
 * is spaced per host, has a timeout, respects the job's deadline, and backs
 * off (briefly) on 429/503 instead of hammering. A host that still says
 * "slow down" (429/403/503) after that is left alone for at least a minute.
 *
 * Tests replace the transport with setTransport(); connectors never call
 * fetch themselves.
 */

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

/** Minimum gap between two requests to the same host, in ms. Unlisted hosts use DEFAULT_GAP_MS. */
const HOST_GAP_MS = {
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
};
const DEFAULT_GAP_MS = 120;

/** After a refused connection, a paced host is left alone for this long (it is telling us to back off). */
const REFUSED_REST_MS = 60000;
/** A host that answers 429/403/503 after our retries rests at least a minute, doubling on each repeat up to this. */
const SLOW_DOWN_REST_MS = 60000;
const MAX_REST_MS = 15 * 60000;
/** A host whose rest ends further away than this is turned down at once instead of waited for. */
const MAX_REST_WAIT_MS = 10000;

let transport = (url, init) => fetch(url, init);
const nextSlot = new Map();
/** host -> epoch ms until which the host asked to be left alone */
const restUntil = new Map();
/** host -> length of its last rest, for doubling on repeats; cleared by a good answer */
const lastRest = new Map();

let paced = true;

/**
 * Replace the network layer (tests). Pass nothing to restore real fetch.
 * A fake network is not paced (there is no host to be polite to) unless
 * the test asks for it with { paced: true }.
 */
export function setTransport(fn, { paced: keepPacing = false } = {}) {
  transport = fn || ((url, init) => fetch(url, init));
  paced = fn ? keepPacing : true;
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

export class HttpError extends Error {
  constructor(message, { status = null, url = '', retryable = false, retryAt = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryable = retryable;
    // When the host is resting: the time it is free again (epoch ms), so the caller can wait instead of failing
    this.retryAt = retryAt;
  }
}

/**
 * GET or POST a URL and return { status, headers, text }.
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string|object, timeoutMs?: number, deadline?: number, retries?: number, accept?: string, maxBytes?: number }} options
 *   deadline: epoch ms after which the call must not be running.
 *   maxBytes: the largest body accepted (default 8 MB). A larger body is an
 *     error, never silently cut short: half a sanctions list would look like
 *     a clean screen.
 */
export async function request(url, { method = 'GET', headers = {}, body = undefined, timeoutMs = DEFAULT_TIMEOUT_MS, deadline = null, retries = 1, accept = '*/*', maxBytes = MAX_BODY_BYTES } = {}) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!host) throw new HttpError('Invalid URL', { url });
  let attempt = 0;
  for (;;) {
    const turn = await waitForHost(host, deadline);
    if (turn === 'resting') throw new HttpError(`${host} asked us to wait; it is being left alone for now`, { url, retryable: true, retryAt: restUntil.get(host) || null });
    if (turn === 'late') throw new HttpError('Out of time before the request could start', { url, retryable: true });
    const budget = deadline ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs;
    if (budget < 800) throw new HttpError('Out of time', { url, retryable: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const isObject = body && typeof body === 'object';
      const response = await transport(url, {
        method,
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': userAgent(), Accept: accept, ...(isObject ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: isObject ? JSON.stringify(body) : body } : {}),
      });
      const status = response.status;
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
      // The host said "slow down" and we will not try again now: leave it alone, longer on each repeat
      const slowDown = () => {
        if (!paced) return;
        const ms = Math.min(MAX_REST_MS, Math.max(retryAfterMs, SLOW_DOWN_REST_MS, (lastRest.get(host) || 0) * 2));
        lastRest.set(host, ms);
        rest(host, ms);
      };
      if ((status === 429 || status === 503) && attempt < retries) {
        attempt += 1;
        const wait = Math.min(retryAfterMs || 1500 * attempt, 6000);
        if (deadline && Date.now() + wait + 1500 > deadline) {
          slowDown();
          throw new HttpError(`Rate limited (${status})`, { status, url, retryable: true });
        }
        await sleep(wait);
        continue;
      }
      if (status === 429 || status === 403 || status === 503) slowDown();
      const limit = Math.min(maxBytes, MAX_BODY_BYTES_CEILING);
      const tooLarge = () => new HttpError(`Response larger than ${Math.round(limit / 1048576)} MB`, { status, url });
      const declaredLength = Number(response.headers?.get?.('content-length'));
      if (status < 400 && Number.isFinite(declaredLength) && declaredLength > limit) {
        controller.abort(); // refuse before reading the body
        throw tooLarge();
      }
      const text = await response.text();
      if (status < 400 && text.length > limit) throw tooLarge();
      if (status >= 400) throw new HttpError(`HTTP ${status}`, { status, url, retryable: status === 429 || status >= 500 });
      if (status < 300) lastRest.delete(host);
      return { status, headers: response.headers, text, url: response.url || url };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const timedOut = error?.name === 'AbortError';
      // A host we pace on purpose that refuses the connection wants a rest, not an immediate second try
      if (!timedOut && paced && (HOST_GAP_MS[host] || 0) >= 1000) {
        rest(host, REFUSED_REST_MS);
        throw new HttpError(`${host} refused the connection; it is being left alone for a minute`, { url, retryable: true, retryAt: restUntil.get(host) || nextSlot.get(host) || null });
      }
      if (!timedOut && attempt < retries && !(deadline && Date.now() + 2500 > deadline)) {
        attempt += 1;
        await sleep(400 * attempt);
        continue;
      }
      throw new HttpError(timedOut ? `Timed out after ${Math.round(budget / 1000)}s` : String(error?.message || error), { url, retryable: true });
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

/** Visible text of an HTML document: scripts, styles and tags removed, entities decoded, whitespace collapsed. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
