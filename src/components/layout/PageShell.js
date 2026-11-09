/**
 * App shell: a sticky, translucent top bar with the wordmark, the five
 * sections and the account menu; an optional page header; a centred column.
 * Every page uses it so navigation and spacing are identical everywhere.
 */
import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { HiOutlineSparkles, HiOutlineMagnifyingGlass, HiOutlineShare, HiOutlineFolder, HiOutlineBell, HiOutlineUserCircle } from 'react-icons/hi2';
import AccountMenu from '../account/AccountMenu';

export const NAV = [
  { href: '/', label: 'Research', Icon: HiOutlineMagnifyingGlass },
  { href: '/founder', label: 'Founder Check', Icon: HiOutlineUserCircle },
  { href: '/network', label: 'Network', Icon: HiOutlineShare },
  { href: '/workspaces', label: 'Workspaces', Icon: HiOutlineFolder },
  { href: '/watchlist', label: 'Watchlist', Icon: HiOutlineBell },
];

export function Wordmark({ className = '' }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2 ${className}`} aria-label="Research Hub home">
      <span className="grid h-8 w-8 place-items-center rounded-xl text-white shadow-sm" style={{ backgroundImage: 'var(--grad)' }}>
        <HiOutlineSparkles className="h-4.5 w-4.5" style={{ width: 18, height: 18 }} />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">Research Hub</span>
    </Link>
  );
}

export function TopBar() {
  const router = useRouter();
  return (
    <header className="sticky top-0 z-40 border-b border-line/80 glass">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
        <Wordmark />
        <nav className="hidden md:flex items-center gap-1 rounded-full border border-line bg-white/70 p-1" aria-label="Sections">
          {NAV.map(({ href, label, Icon }) => {
            const active = href === '/' ? router.pathname === '/' : router.pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${active ? 'bg-ink text-white shadow-sm' : 'text-muted hover:text-ink hover:bg-slate-100'}`}
              >
                <Icon style={{ width: 15, height: 15 }} />
                {label}
              </Link>
            );
          })}
        </nav>
        <AccountMenu />
      </div>
      <nav className="md:hidden flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Sections">
        {NAV.map(({ href, label }) => {
          const active = href === '/' ? router.pathname === '/' : router.pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={`chip whitespace-nowrap ${active ? 'chip-active' : ''}`}>{label}</Link>
          );
        })}
      </nav>
    </header>
  );
}

/** The three main flows, as a segmented switch under the top bar. */
export const FLOWS = [
  { href: '/', label: 'Open Research', Icon: HiOutlineMagnifyingGlass },
  { href: '/network', label: 'Network Map', Icon: HiOutlineShare },
  { href: '/founder', label: 'Founder Check', Icon: HiOutlineUserCircle },
];

export function SectionSwitch() {
  const router = useRouter();
  return (
    <div className="mb-8 flex justify-center">
      <div className="inline-flex w-full max-w-xl rounded-2xl border border-line bg-white p-1 shadow-card" role="tablist" aria-label="Main sections">
        {FLOWS.map(({ href, label, Icon }) => {
          const active = href === '/' ? router.pathname === '/' : router.pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              role="tab"
              aria-selected={active}
              className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition ${active ? 'text-white shadow-sm' : 'text-muted hover:text-ink hover:bg-slate-50'}`}
              style={active ? { backgroundImage: 'var(--grad)' } : undefined}
            >
              <Icon style={{ width: 16, height: 16 }} />
              {label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function PageShell({ title, subtitle, children, actions = null, wide = false, headTitle = null, flows = false }) {
  return (
    <div className="min-h-screen">
      <Head>
        <title>{headTitle || (title ? `${title} · Research Hub` : 'Research Hub')}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <TopBar />
      <main className={`mx-auto px-4 py-8 ${wide ? 'max-w-6xl' : 'max-w-5xl'}`}>
        {flows && <SectionSwitch />}
        {(title || actions) && (
          <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              {title && <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>}
              {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
          </div>
        )}
        <div>{children}</div>
      </main>
      <footer className="mx-auto flex max-w-5xl flex-col gap-2 px-4 pb-8 pt-4 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>Every statement is quoted from, or cited to, a numbered source. Contact data never leaves this app.</span>
        <span className="flex items-center gap-3">
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
        </span>
      </footer>
    </div>
  );
}

/** Shown on pages that need sign-in. */
export function SignInPrompt({ what = 'this' }) {
  return (
    <div className="card card-pad text-center">
      <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600">
        <HiOutlineUserCircle style={{ width: 22, height: 22 }} />
      </div>
      <p className="text-sm text-ink">Sign in with Google to use {what}.</p>
      <p className="muted mt-1">Your history, workspaces, notes and watchlists are saved to your account.</p>
      <Link href="/signin" className="btn-primary mt-4">Sign in with Google</Link>
    </div>
  );
}
