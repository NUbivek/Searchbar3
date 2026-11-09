/**
 * Base URL for this app calling its own API from the server.
 *
 * Several routes call sibling routes over HTTP. They used to hardcode ports
 * (3001, 3002, 3010) that never matched the port the server ran on, so those
 * calls failed with "fetch failed". This deliberately ignores the request's
 * Host / X-Forwarded-Host headers: they are client-controlled, and using them
 * would let a caller point server-side requests at arbitrary hosts (SSRF).
 */
export function selfBaseUrl() {
  const localUrl = `http://localhost:${process.env.PORT || 3000}`;
  if (process.env.NODE_ENV === 'development') return localUrl;
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return localUrl;
}
