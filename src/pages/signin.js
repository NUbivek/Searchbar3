/**
 * Sign-in page. Google is the sign-in method; "Local test user" only appears
 * in local development (see src/server/auth.js).
 */
import React from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { FaGoogle, FaUserCog } from 'react-icons/fa';
import PageShell from '../components/layout/PageShell';

const ERRORS = {
  OAuthSignin: 'Could not start Google sign-in. Check the Google OAuth settings.',
  OAuthCallback: 'Google sign-in did not complete. Please try again.',
  OAuthAccountNotLinked: 'This email is already linked to another sign-in method.',
  AccessDenied: 'Access was denied.',
  Configuration: 'Sign-in is not configured correctly on the server.',
  Default: 'Sign-in failed. Please try again.',
};

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
    <PageShell title="Sign in" subtitle="Sign in to keep your search history, deal workspaces, notes and watchlists.">
      <div className="max-w-md mx-auto bg-white border border-gray-200 rounded-lg p-6">
        {status === 'authenticated' ? (
          <p className="text-gray-700">You are signed in. <a className="text-blue-600 underline" href={callbackUrl}>Continue</a></p>
        ) : (
          <>
            {error && <div className="bg-red-100 border border-red-400 text-red-700 px-3 py-2 rounded mb-4 text-sm">{error}</div>}
            {google ? (
              <button
                type="button"
                onClick={() => signIn('google', { callbackUrl })}
                className="w-full flex items-center justify-center bg-white border border-gray-300 hover:bg-gray-50 text-gray-800 font-medium px-4 py-2 rounded-md"
              >
                <FaGoogle className="mr-2 text-red-500" /> Continue with Google
              </button>
            ) : (
              <p className="text-sm text-gray-600 mb-2">
                Google sign-in is not configured on this server yet (it needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and NEXTAUTH_SECRET).
              </p>
            )}
            {dev && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => signIn('dev-login', { callbackUrl })}
                  className="w-full flex items-center justify-center bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md"
                >
                  <FaUserCog className="mr-2" /> Sign in as local test user
                </button>
                <p className="text-xs text-gray-500 mt-2">Only available when running locally in development.</p>
              </div>
            )}
          </>
        )}
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
