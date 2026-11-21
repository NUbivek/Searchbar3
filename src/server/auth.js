/**
 * Sign-in with Google (NextAuth v4) so users keep their history, workspaces,
 * notes and watchlists across devices.
 *
 * Production env (Vercel): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 * NEXTAUTH_SECRET, NEXTAUTH_URL. Google redirect URI:
 *   https://<your-domain>/api/auth/callback/google
 *
 * Local development also offers "Local test user" so saved history can be
 * tested on localhost before Google credentials exist. It is only enabled
 * when NODE_ENV is "development" and the request comes from localhost; it is
 * never available in a production build.
 *
 * Who may sign in: FOUNDER_ALLOWED_EMAILS optionally lists the accounts that
 * may use the site, as whole addresses ("owner@example.com") or domains
 * ("@example.com" or "example.com"), separated by commas, spaces or
 * semicolons. Empty (the default), everyone may sign in, as before. Set, an
 * account outside it is refused at sign-in, and a session issued before the
 * list was set stops counting as signed in. Set but unreadable (nothing in it
 * is a whole address or domain), it refuses everyone: it fails closed.
 */
import crypto from 'crypto';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { getServerSession } from 'next-auth/next';
import { query, persistenceMode } from './db';

const isDev = process.env.NODE_ENV === 'development';

// NextAuth builds callback URLs from NEXTAUTH_URL and otherwise assumes port
// 3000. In development, default it to the port this server is running on.
// Production must set NEXTAUTH_URL (e.g. https://searchbar3.vercel.app).
if (isDev && !process.env.NEXTAUTH_URL) {
  process.env.NEXTAUTH_URL = `http://localhost:${process.env.PORT || 3000}`;
}
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const providers = [];
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(GoogleProvider({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  }));
}
// The local test account is opt-in: ALLOW_DEV_LOGIN=true in development only.
const devLoginAllowed = isDev && process.env.ALLOW_DEV_LOGIN === 'true';
if (devLoginAllowed) {
  providers.push(CredentialsProvider({
    id: 'dev-login',
    name: 'Local test user (development only)',
    credentials: {},
    async authorize(_credentials, req) {
      const host = String(req?.headers?.host || '');
      if (!devLoginAllowed || !LOCAL_HOSTS.test(host)) return null;
      return { id: 'dev:local-test-user', name: 'Local test user', email: 'local-test-user@localhost' };
    },
  }));
}

/**
 * Read an allow-list: whole addresses and domains, lower-cased. Quotes, angle brackets and a "mailto:" prefix
 * pasted along with an address are read through ('"owner@example.com"', 'Owner <owner@example.com>').
 * Anything that is still neither an address nor a domain (a stray word, "name@", "owner@gmail") is ignored
 * rather than widening the list, and named in `warnings` (never the item itself, which may be an address).
 * `set` is true when the raw value is not blank: a list that was set but in which nothing could be read is
 * still a list, an empty one (see allowListActive), so a mistyped value never opens the site to everyone.
 * @returns {{ emails: string[], domains: string[], set: boolean, warnings: string[] }}
 */
export function parseAllowList(raw = process.env.FOUNDER_ALLOWED_EMAILS) {
  const emails = [];
  const domains = [];
  const warnings = [];
  const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
  const text = String(raw || '');
  for (const part of text.toLowerCase().split(/[\s,;]+/)) {
    const item = part.trim().replace(/^["'`<(\[]+|["'`>)\].]+$/g, '').replace(/^mailto:/, '').replace(/^["'`<]+/, '');
    if (!item) continue;
    const at = item.lastIndexOf('@');
    let ok = false;
    if (at > 0) {
      if (DOMAIN.test(item.slice(at + 1)) && !item.slice(0, at).includes('@')) { emails.push(item); ok = true; }
    } else {
      const domain = at === 0 ? item.slice(1) : item;
      if (DOMAIN.test(domain)) { domains.push(domain); ok = true; }
    }
    if (!ok) warnings.push(at >= 0 ? 'an entry that is not a whole address or domain was ignored' : 'a word that is not an address or domain was ignored');
  }
  const set = text.trim().length > 0;
  if (set && !emails.length && !domains.length) warnings.push('nothing in the list could be read, so every account is refused');
  return { emails, domains, set, warnings };
}

/**
 * Whether an allow-list is in force. With none (blank), nothing is restricted. A list that was set but in which
 * nothing valid could be read is in force and empty: it fails closed, refusing every account but the local
 * test user, rather than silently letting every account in.
 */
export function allowListActive(list = parseAllowList()) {
  return Boolean(list.emails.length || list.domains.length || list.set);
}

// Say once, at start, when the list is set but unreadable: the owner believes the site is restricted, and it
// now refuses everyone, so the reason must be easy to find in the logs. No entry is printed (it may be an address).
{
  const startList = parseAllowList();
  if (startList.set && !startList.emails.length && !startList.domains.length) {
    console.error('FOUNDER_ALLOWED_EMAILS is set but holds no whole address or domain, so every account is refused. Write it as owner@example.com or @example.com, separated by commas.');
  } else if (startList.warnings.length) {
    console.warn(`FOUNDER_ALLOWED_EMAILS: ${startList.warnings.length} ${startList.warnings.length === 1 ? 'entry was' : 'entries were'} ignored.`);
  }
}

/**
 * Whether an address is on the list. A domain covers that exact domain only, not
 * its subdomains or a longer name ending the same way ("evilexample.com").
 * With no list set every address is allowed.
 */
export function emailAllowed(email, list = parseAllowList()) {
  if (!allowListActive(list)) return true;
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return false;
  return list.emails.includes(e) || list.domains.includes(e.slice(at + 1));
}

/** The local test account exists only in development on localhost, so the list does not apply to it. */
const isLocalTestUser = (id) => devLoginAllowed && String(id || '').startsWith('dev:');

async function upsertUser({ id, email, name, image }) {
  if (persistenceMode() === 'none') return;
  await query(
    `INSERT INTO users (id, email, name, image) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
       image = EXCLUDED.image, last_seen_at = now()`,
    [id, email || null, name || null, image || null]
  );
}

export const authOptions = {
  providers,
  session: { strategy: 'jwt' },
  // NEXTAUTH_SECRET is required in production; development uses a fixed
  // local-only secret so sessions survive dev-server restarts.
  secret: process.env.NEXTAUTH_SECRET || (isDev ? 'searchbar3-local-development-only' : undefined),
  pages: { signIn: '/signin' },
  callbacks: {
    async signIn({ user, account, profile }) {
      const id = account?.provider === 'google' ? `google:${account.providerAccountId}` : user.id;
      const list = parseAllowList();
      if (allowListActive(list) && !isLocalTestUser(id)) {
        // The list is matched on the address, so the address must be one Google has verified.
        const verified = account?.provider !== 'google' || profile?.email_verified === true || profile?.email_verified === 'true';
        // A refused account is not written to the database: it never used the site.
        if (!verified || !emailAllowed(user?.email, list)) return false;
      }
      try {
        await upsertUser({ id, email: user.email, name: user.name, image: user.image });
      } catch (error) {
        // Signing in must still work if the database is briefly unavailable.
        console.error('Could not record user:', error.message);
      }
      return true;
    },
    async jwt({ token, account, user }) {
      if (account && user) {
        token.uid = account.provider === 'google' ? `google:${account.providerAccountId}` : user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.uid || null;
      return session;
    },
  },
};

export function availableProviders() {
  // Custom ids/names live in p.options until NextAuth merges them.
  return providers.map((p) => ({ id: p.options?.id || p.id, name: p.options?.name || p.name }));
}

const ensuredUsers = new Set();

/**
 * The session's user, or null when signed out. A session whose address is not on
 * the allow-list (one issued before the list was set) counts as signed out.
 * `refused` is true in that case, so a caller can say why.
 */
async function sessionUser(req, res) {
  let session;
  try {
    session = await getServerSession(req, res, authOptions);
  } catch {
    return { user: null, refused: false };
  }
  const user = session?.user;
  if (!user?.id) return { user: null, refused: false };
  if (!isLocalTestUser(user.id) && !emailAllowed(user.email)) return { user: null, refused: true };
  return { user, refused: false };
}

/** The signed-in user's id, or null. Makes sure the user row exists. */
export async function getUserId(req, res) {
  const { user } = await sessionUser(req, res);
  if (!user?.id) return null;
  // A session can outlive a failed insert at sign-in (e.g. database briefly
  // down), so make sure the row exists before any foreign-keyed write.
  if (!ensuredUsers.has(user.id) && persistenceMode() !== 'none') {
    try {
      await upsertUser({ id: user.id, email: user.email, name: user.name, image: user.image });
      ensuredUsers.add(user.id);
    } catch (error) {
      // The write that follows will report the database problem cleanly.
      console.error('Could not record user:', error.message);
    }
  }
  return user.id;
}

/** The signed-in user's email (lower-cased), or '' when signed out. */
export async function getUserEmail(req, res) {
  const { user } = await sessionUser(req, res);
  return String(user?.email || '').trim().toLowerCase();
}

/**
 * The signed-in person's { name, email } as Google gave them at sign-in, or null when signed out (or refused by
 * the allow-list, like everything else here). The deep check names this contact to the few official sites that
 * ask automated readers for one (server/founder/contact.js, which also cleans it); it is used for nothing else.
 */
export async function getUserContact(req, res) {
  const { user } = await sessionUser(req, res);
  if (!user?.id || !user.email) return null;
  return { name: String(user.name || ''), email: String(user.email) };
}

/**
 * For API routes that need a signed-in user: returns the user id, or sends
 * 401 and returns null.
 */
export async function requireUser(req, res) {
  const userId = await getUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: 'Sign in to use this feature.' });
    return null;
  }
  return userId;
}

/**
 * For the background check's routes: returns the user id, or sends 401 (signed
 * out) or 403 (an account the allow-list does not include) and returns null.
 */
export async function requireFounderUser(req, res) {
  const { user, refused } = await sessionUser(req, res);
  if (refused) {
    res.status(403).json({ error: 'The background check is not enabled for this account.' });
    return null;
  }
  if (!user?.id) {
    res.status(401).json({ error: 'Sign in to use this feature.', signIn: true });
    return null;
  }
  return getUserId(req, res);
}

// ---------------------------------------------------------------------------
// A small hit counter, for limits that must hold across server instances.

const memoryHits = new Map();

/** A one-way label for the caller, so an address or account id is never stored as it is. */
const label = (who) => crypto.createHash('sha256').update(`searchbar3-rate|${who}`).digest('hex').slice(0, 24);

function countInMemory(key, windowEnds) {
  const now = Date.now();
  if (memoryHits.size > 5000) for (const [k, v] of memoryHits) if (v.ends <= now) memoryHits.delete(k);
  const hit = memoryHits.get(key);
  const next = hit && hit.ends > now ? hit.count + 1 : 1;
  memoryHits.set(key, { count: next, ends: windowEnds });
  return next;
}

/**
 * Take one slot from `who`'s allowance in `bucket`: at most `max` in each window
 * of `windowMs`. Counted in the database when there is one, so every server
 * instance sees the same count (a row per caller and window in learning_stats,
 * under its own kind "rate:<bucket>", which nothing else reads); otherwise, or
 * when the database fails, counted in this instance's memory, which still holds
 * a single instance to the limit.
 * @returns {Promise<{ ok: boolean, count: number, retryAfter: number }>} retryAfter in seconds
 */
export async function takeSlot(bucket, who, { max = 10, windowMs = 3600000 } = {}) {
  const now = Date.now();
  const window = Math.floor(now / windowMs);
  const windowEnds = (window + 1) * windowMs;
  const retryAfter = Math.max(1, Math.ceil((windowEnds - now) / 1000));
  const kind = `rate:${bucket}`;
  const key = `${label(who)}|${window}`;
  let count = null;
  if (persistenceMode() !== 'none') {
    try {
      const rows = await query(
        `INSERT INTO learning_stats (kind, key, tries) VALUES ($1, $2, 1)
         ON CONFLICT (kind, key) DO UPDATE SET tries = learning_stats.tries + 1, updated_at = now()
         RETURNING tries`,
        [kind, key],
      );
      count = Number(rows?.[0]?.tries) || null;
      // Old windows are of no use; clear them now and then so the table stays small.
      if (count === 1 && Math.random() < 0.1) {
        query('DELETE FROM learning_stats WHERE kind = $1 AND updated_at < now() - interval \'2 days\'', [kind]).catch(() => {});
      }
    } catch (error) {
      console.error('Could not count a request:', error.message);
      count = null;
    }
  }
  if (count === null) count = countInMemory(`${kind}|${key}`, windowEnds);
  return { ok: count <= max, count, retryAfter };
}

/**
 * The caller's address as the host set it. A client can write anything into the
 * front of x-forwarded-for, so the host's own headers come first (x-real-ip,
 * x-vercel-forwarded-for), then the last x-forwarded-for hop (added by the host's
 * proxy), then the socket. Otherwise a caller could dodge a limit by sending a
 * new made-up address with every request.
 */
export function callerAddress(req) {
  const h = req?.headers || {};
  const first = (v) => String(v || '').split(',')[0].trim();
  const last = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).pop() || '';
  return first(h['x-real-ip']) || first(h['x-vercel-forwarded-for']) || last(h['x-forwarded-for']) || String(req?.socket?.remoteAddress || '') || 'unknown';
}

/**
 * The gate for the debug routes (/api/debug/*).
 * - Development and tests: open, no limits.
 * - A preview deployment (VERCEL_ENV=preview): open without the site's own sign-in,
 *   since the host's sign-in sits in front of previews, but limited per caller
 *   and per deployment each hour.
 * - Production: the same model as the rest of the site: whoever is signed in may use
 *   them. When the owner has set FOUNDER_ALLOWED_EMAILS, an account outside it is
 *   refused (403) by the same sign-in check every other route uses; signed out gets
 *   401 with { signIn: true }, so the page can offer sign-in. Still limited per
 *   account each hour, and model runs share one hourly allowance across accounts.
 * `costly` marks a request that calls a model (a tighter limit).
 * Sends the refusal itself and returns false, or returns true.
 */
export async function debugAccess(req, res, { route = 'debug', costly = false } = {}) {
  if (process.env.NODE_ENV !== 'production') return true;
  const preview = process.env.VERCEL_ENV === 'preview';
  let who;
  if (preview) {
    const userId = await getUserId(req, res);
    who = userId ? `user:${userId}` : `ip:${callerAddress(req)}`;
  } else {
    // Production: any signed-in account, as everywhere else on the site. requireFounderUser applies the allow-list
    // when one is set (403) and asks a signed-out caller to sign in (401, signIn: true). The hourly limits below
    // are what keep one account, or several together, from running up the models' allowance.
    const userId = await requireFounderUser(req, res);
    if (!userId) return false;
    who = `user:${userId}`;
  }
  const hour = 3600000;
  const mine = await takeSlot(`${route}${costly ? ':run' : ''}`, who, { max: costly ? 10 : 30, windowMs: hour });
  // Every model run, on a preview or in production, also counts against one shared allowance, so several
  // accounts (or callers behind the host's sign-in) cannot use up the models' allowance between them.
  const shared = mine.ok && costly ? await takeSlot(`${route}:run:all`, 'all', { max: 40, windowMs: hour }) : { ok: true };
  if (!mine.ok || !shared.ok) {
    res.setHeader('Retry-After', String(mine.ok ? shared.retryAfter : mine.retryAfter));
    res.status(429).json({ error: 'Too many checks in the last hour. Try again later.' });
    return false;
  }
  return true;
}
