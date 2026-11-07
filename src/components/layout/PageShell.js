/**
 * Layout for secondary pages (history, workspaces, company profile, founder
 * check, watchlist), matching the home page: gray background, centered
 * "Research Hub" heading, blue accents, account menu top right.
 */
import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import AccountMenu from '../account/AccountMenu';

const NAV = [
  { href: '/', label: 'Open Research' },
  { href: '/network', label: 'Network Map' },
  { href: '/workspaces', label: 'Workspaces' },
  { href: '/watchlist', label: 'Watchlist' },
  { href: '/founder', label: 'Founder Check' },
];

export default function PageShell({ title, subtitle, children, actions = null }) {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-gray-50">
      <Head>
        <title>{title ? `${title} · Research Hub` : 'Research Hub'}</title>
      </Head>
      <main className="container mx-auto px-4 py-6">
        <div className="flex justify-end mb-2"><AccountMenu /></div>
        <div className="text-center mb-4">
          <Link href="/" className="text-2xl font-bold text-gray-800 hover:text-blue-700">Research Hub</Link>
        </div>
        <nav className="flex flex-wrap justify-center gap-1 rounded-xl bg-blue-100 p-1 mb-6 max-w-2xl mx-auto">
          {NAV.map((n) => {
            const active = n.href === '/' ? router.pathname === '/' : router.pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`flex-1 text-center rounded-lg py-2 px-2 text-sm font-medium ${active ? 'bg-white text-blue-700 shadow' : 'text-blue-500 hover:text-blue-700'}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        {(title || actions) && (
          <div className="max-w-5xl mx-auto flex items-start justify-between gap-4 mb-4">
            <div>
              {title && <h1 className="text-xl font-semibold text-gray-800">{title}</h1>}
              {subtitle && <p className="text-gray-600 text-sm mt-1">{subtitle}</p>}
            </div>
            {actions}
          </div>
        )}
        <div className="max-w-5xl mx-auto">{children}</div>
      </main>
    </div>
  );
}

/** Shown on pages that need sign-in. */
export function SignInPrompt({ what = 'this' }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 text-center">
      <p className="text-gray-700 mb-3">Sign in with Google to use {what}. Your history, workspaces and watchlists are saved to your account.</p>
      <Link href="/signin" className="inline-block bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm">Sign in</Link>
    </div>
  );
}
