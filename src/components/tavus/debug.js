/**
 * Timing logs for diagnosing Tavus call latency. Off by default.
 *
 * Turn on in a browser by opening any page with `?tavusDebug=1` (stored in
 * localStorage until `?tavusDebug=0`). Each mark goes to the console as
 * `[tavus-debug] <event> +<ms since previous mark> { ... }` and is kept in
 * `window.__tavusTimeline` so it can be copied with
 * `copy(JSON.stringify(window.__tavusTimeline, null, 2))`.
 */
const KEY = 'tavusDebug';

export function tavusDebugEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    const param = new URLSearchParams(window.location.search).get(KEY);
    if (param === '1') window.localStorage.setItem(KEY, '1');
    if (param === '0') window.localStorage.removeItem(KEY);
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let last = 0;

export function tavusMark(event, data = {}) {
  if (!tavusDebugEnabled()) return;
  const now = performance.now();
  const entry = { event, at: new Date().toISOString(), t: Math.round(now), sincePrev: last ? Math.round(now - last) : 0, ...data };
  last = now;
  window.__tavusTimeline = window.__tavusTimeline || [];
  window.__tavusTimeline.push(entry);
  // eslint-disable-next-line no-console
  console.info(`[tavus-debug] ${event} +${entry.sincePrev}ms`, data);
}
