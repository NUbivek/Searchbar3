# http.js and cache.js: what changed for callers (R3, 2026-11-20)

Everything that worked before still works: same exports, same call signatures, same error messages
("Timed out after Ns", "Out of time before the request could start", "HTTP 404", "Response larger than N MB").
Tests keep using `setTransport(fn, { paced })`.

## src/server/founder/http.js

### Every request is now address-checked and follows redirects by hand
Nothing to do to get this. Before the first request and before every redirect hop the client checks
the address: http/https only, no sign-in in the URL, no localhost/.local/.internal names, and no
private, loopback, link-local, carrier-grade, multicast or cloud-metadata address, written in the link
or returned by DNS (all answers). At most 5 redirects. Pacing and host rests apply to each hop's host.
Sign-in headers (Authorization, Cookie) are dropped when a redirect changes site.

A refused address throws `HttpError` with `code: 'blocked'`, `retryable: false`, `hopUrl` = the refused address.
No request was sent there.

### `request(url, options)` new options
- `onHop(url, { hop, from })`: called with every address before it is opened (hop 0 is the first).
  Return `false` or a reason string to refuse; may be async. A refusal throws `HttpError` with
  `code: 'refused'`, `hopUrl`, and your reason as the message. If `onHop` throws an `HttpError`, it is passed through.
  ```js
  const r = await request(url, { deadline, onHop: async (next) => {
    if (!readable(next)) return 'leads to a site the reader never opens';
    return (await robotsVerdict(next, deadline)) === 'allowed' || 'robots.txt does not allow it';
  } });
  ```
- `retryOn: number[]` (default `[429, 503]`): statuses tried again (up to `retries`). Example for a list
  download: `request(EBRD_CSV, { deadline, retryOn: [429, 500, 502, 503, 504] })`. Not needed inside
  `cached()`, which already retries 500/502/504 once.
- `responseType: 'bytes'` returns `{ status, headers, bytes, url }` instead of `text`.
- `maxRedirects` (default 5).

The body is read as a stream and dropped as soon as it passes `maxBytes` (Content-Length or not).
Text is decoded with the charset from Content-Type, else the page's `<meta charset>` / http-equiv,
else UTF-8. Bytes that are not valid UTF-8 and contain no real UTF-8 letters are read as windows-1252.
`Retry-After` is read as seconds or as an HTTP date.

### Error codes (`error.code`)
`deadline` (the caller's deadline cut it short), `timeout`, `resting`, `blocked`, `refused`, `redirects`,
`too-large`, `status` (see `error.status`), `network`.

### New exports
- `getBytes(url, options) -> Promise<Uint8Array>`: same checks, pacing and size limit.
  `const zip = await getBytes('https://example.org/list.zip', { deadline, maxBytes: 20 * 1024 * 1024 });`
- `checkTarget(url, { lookup?, deadline? }) -> Promise<URL>`: the address check alone; throws `code: 'blocked'`.
  `await checkTarget('http://10.0.0.5/')  // throws`
- `addressProblem(ip) -> string`: why an IP may not be opened, `''` when public.
  `addressProblem('169.254.169.254') // 'a link-local address'`
- `decodeBody(bytes, contentType) -> string`, `declaredCharset(contentType, bytes) -> string`.
- `decodeEntities(text) -> string`: one-pass decoding, all Latin-1 names plus common Central European ones.
  `decodeEntities('J&uuml;rgen') // 'Jürgen'`
- `retryAfterMs(value, now?) -> number`.
- `HOST_GAP_MS` (now exported; ico.org.uk 6 s and www.mas.gov.sg 2 s added), `MAX_REDIRECTS`.
- `setTransport(fn, { paced, lookup })`: `lookup(host) -> [{ address, family }]` lets a test show a
  name that resolves into a private range without touching DNS. With a fake transport and no `lookup`,
  only literal addresses are checked.

`htmlToText` is now one linear scan: megabytes of unclosed `<script>`, `<style>` or `<!--` take
milliseconds, and an unclosed block hides the rest of the page (as a browser does). Output is otherwise
the same, except that entities are decoded once (`&amp;lt;` gives `&lt;`) and more names are known.

## src/server/founder/cache.js

- `cached(key, ttlMs, loader, options)`: same as before, plus options below. Returns the value.
- `cachedEntry(key, ttlMs, loader, options) -> { value, at, fresh, ageMs }`: `at` is when the copy was
  really downloaded. `fresh: false` means an older copy stands in for a failed refresh: show "list as of <date>".
  ```js
  const { value: index, at, fresh } = await cachedEntry(list.cacheKey, DAY_MS, ({ deadline }) => list.load(deadline), { deadline: ctx.deadline });
  const asOf = fresh ? '' : ` (list as of ${new Date(at).toISOString().slice(0, 10)})`;
  ```
- The loader is now called with `{ deadline }`: its own deadline, at least 25 s away, independent of the
  caller. Use it instead of a captured caller deadline.
- Options: `deadline` (this caller's own; when it passes the caller gets an error with `code: 'deadline'`
  while the shared load goes on), `maxStaleMs` (default 7 days; an older copy is never served),
  `failureHoldMs` (default 60 s, was 5 min), `loadMs` (default and minimum 25 s), `retryPauseMs`,
  `persist`.
- A load cut short by a deadline (`code: 'deadline'` or "Out of time") is never remembered as a failure.
- A 500, 502 or 504 is retried once after 1.5 s before it counts as failed (503 is already retried by request()).
- New exports: `cachedEntry`, `isCutShort(error)`, `MAX_STALE_MS`, `MIN_LOAD_MS`, `STALE_RETRY_MS`, `RETRY_5XX_PAUSE_MS`.

## Not done
Pacing shared across server instances: not built. http.js would have to import the database helper on
every request path, which ties every source and every test to the database and adds a round trip per
paced request; a failed database call would then have to decide whether to send the request anyway.
The per-instance pacing stays.
DNS rebinding is narrowed, not closed: the address is checked just before the request, but the
connection is not pinned to the checked address (that needs a connection agent the project does not
depend on).
