/**
 * HTTP for the background-check connectors: one polite client shared by all
 * of them. Free public endpoints are easy to lose access to, so every call
 * is spaced per host, has a timeout, respects the job's deadline, and backs
 * off (briefly) on 429/503 instead of hammering.
 *
 * Tests replace the transport with setTransport(); connectors never call
 * fetch themselves.
 */

export const USER_AGENT = 'Mozilla/5.0 (compatible; diligence-research/1.0; +https://www.sec.gov/os/accessing-edgar-data)';
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
};
const DEFAULT_GAP_MS = 120;

/** After a refused connection, a paced host is left alone for this long (it is telling us to back off). */
const REFUSED_REST_MS = 60000;

let transport = (url, init) => fetch(url, init);
const nextSlot = new Map();

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
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHost(host, deadline) {
  const gap = paced ? (HOST_GAP_MS[host] ?? DEFAULT_GAP_MS) : 0;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  nextSlot.set(host, at + gap);
  const wait = at - now;
  if (wait <= 0) return true;
  if (deadline && at + 1500 > deadline) return false; // no time left to queue behind others
  await sleep(wait);
  return true;
}

export class HttpError extends Error {
  constructor(message, { status = null, url = '', retryable = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryable = retryable;
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
    const ok = await waitForHost(host, deadline);
    if (!ok) throw new HttpError('Out of time before the request could start', { url, retryable: true });
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
        headers: { 'User-Agent': USER_AGENT, Accept: accept, ...(isObject ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: isObject ? JSON.stringify(body) : body } : {}),
      });
      const status = response.status;
      if ((status === 429 || status === 503) && attempt < retries) {
        attempt += 1;
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        const wait = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * attempt, 6000);
        if (deadline && Date.now() + wait + 1500 > deadline) throw new HttpError(`Rate limited (${status})`, { status, url, retryable: true });
        await sleep(wait);
        continue;
      }
      const text = await response.text();
      if (status < 400 && text.length > Math.min(maxBytes, MAX_BODY_BYTES_CEILING)) throw new HttpError(`Response larger than ${Math.round(Math.min(maxBytes, MAX_BODY_BYTES_CEILING) / 1048576)} MB`, { status, url });
      if (status >= 400) throw new HttpError(`HTTP ${status}`, { status, url, retryable: status === 429 || status >= 500 });
      return { status, headers: response.headers, text, url: response.url || url };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const timedOut = error?.name === 'AbortError';
      // A host we pace on purpose that refuses the connection wants a rest, not an immediate second try
      if (!timedOut && paced && (HOST_GAP_MS[host] || 0) >= 1000) {
        nextSlot.set(host, Math.max(nextSlot.get(host) || 0, Date.now() + REFUSED_REST_MS));
        throw new HttpError(`${host} refused the connection; it is being left alone for a minute`, { url, retryable: true });
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
