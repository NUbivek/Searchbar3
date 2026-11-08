/**
 * Sign-in page: Google only. A local test account exists only when the
 * server runs in development with ALLOW_DEV_LOGIN=true (see src/server/auth.js).
 */
import React from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { HiOutlineClock, HiOutlineFolder, HiOutlineBell, HiOutlineShare } from 'react-icons/hi2';
import PageShell from '../components/layout/PageShell';

const ERRORS = {
  OAuthSignin: 'Could not start Google sign-in. Please try again.',
  OAuthCallback: 'Google sign-in did not complete. Please try again.',
  OAuthAccountNotLinked: 'This email is already linked to another sign-in method.',
  AccessDenied: 'Access was denied.',
  Configuration: 'Sign-in is not available right now.',
  Default: 'Sign-in failed. Please try again.',
};

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-2.8-.4-4.1H24v7.8h12.7c-.3 2.1-1.7 5.3-4.8 7.4l7.4 5.7c4.4-4.1 7.2-10.1 7.2-16.8z" />
      <path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.8-6z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2 1.4-4.7 2.4-8.5 2.4-6.3 0-11.7-4.1-13.6-9.9l-7.8 6C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

const PERKS = [
  { Icon: HiOutlineClock, text: 'Every search saved to your history' },
  { Icon: HiOutlineFolder, text: 'Deal workspaces with notes, documents and memos' },
  { Icon: HiOutlineBell, text: 'Watchlists with daily alerts' },
  { Icon: HiOutlineShare, text: 'Your network, kept private and matched to founders' },
];

export default function SignInPage({ providers }) {
  const router = useRouter();
  const { status } = useSession();
  const callbackUrl = typeof router.query.callbackUrl === 'string' && router.query.callbackUrl.startsWith('/')
    ? router.query.callbackUrl
    : '/';
  const error = typeof router.query.error === 'string' ? (ERRORS[router.query.error] || ERRORS.Default) : null;
  const list = Object.values(providers || {});
  const google = list.find((p) => p.id === 'google');
  const dev = list.find((p) => p.id === 'dev-login');

  return (
    <PageShell headTitle="Sign in · Research Hub">
      <div className="mx-auto max-w-md">
        <div className="card p-7 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Welcome back</h1>
          <p className="muted mt-1">Sign in to keep your research with you.</p>

          {status === 'authenticated' ? (
            <p className="mt-6 text-sm text-ink">You are signed in. <a className="text-brand-600 font-medium hover:underline" href={callbackUrl}>Continue</a></p>
          ) : (
            <>
              {error && <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
              {google ? (
                <button
                  type="button"
                  onClick={() => signIn('google', { callbackUrl })}
                  className="btn-secondary mt-6 w-full py-3 text-[15px]"
                >
                  <GoogleMark /> Continue with Google
                </button>
              ) : (
                <p className="mt-6 rounded-xl bg-slate-50 px-3 py-3 text-sm text-muted">
                  Google sign-in is not available on this deployment yet.
                </p>
              )}
              {dev && (
                <button
                  type="button"
                  onClick={() => signIn('dev-login', { callbackUrl })}
                  className="btn-ghost mt-3 w-full justify-center"
                >
                  Continue as local test user
                </button>
              )}
            </>
          )}

          <ul className="mt-7 space-y-2.5 text-left">
            {PERKS.map(({ Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-slate-600">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon style={{ width: 15, height: 15 }} /></span>
                {text}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-xs text-muted">We store your name, email and profile picture to identify your account. Nothing is posted on your behalf.</p>
        </div>
      </div>
    </PageShell>
  );
}

export async function getServerSideProps() {
  // Read the configured providers directly (server-only import).
  const { availableProviders } = await import('../server/auth');
  const providers = Object.fromEntries(availableProviders().map((p) => [p.id, p]));
  return { props: { providers } };
}
