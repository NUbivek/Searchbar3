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
 */
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
    async signIn({ user, account }) {
      const id = account?.provider === 'google' ? `google:${account.providerAccountId}` : user.id;
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

/** The signed-in user's id, or null. Makes sure the user row exists. */
export async function getUserId(req, res) {
  let session;
  try {
    session = await getServerSession(req, res, authOptions);
  } catch {
    return null;
  }
  const user = session?.user;
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
  try {
    const session = await getServerSession(req, res, authOptions);
    return String(session?.user?.email || '').trim().toLowerCase();
  } catch {
    return '';
  }
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
