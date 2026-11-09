/**
 * Top-right account control: "Sign in" when signed out; when signed in, the
 * user's avatar and name with links to History, Workspaces and Watchlist, and
 * Sign out. Unseen watchlist alerts show as a count.
 */
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import { HiOutlineClock, HiOutlineFolder, HiOutlineBell, HiOutlineArrowRightOnRectangle, HiOutlineUserCircle } from 'react-icons/hi2';

export default function AccountMenu() {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const ref = useRef(null);

  useEffect(() => {
    if (status !== 'authenticated') return undefined;
    let cancelled = false;
    fetch('/api/alerts?unseen=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.alerts) setUnseen(d.alerts.length); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [status]);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (status === 'loading') return <div className="h-9 w-24 skeleton rounded-full" aria-hidden="true" />;

  if (status !== 'authenticated') {
    return (
      <Link href="/signin" className="btn-primary py-2">Sign in</Link>
    );
  }

  const name = session.user?.name || session.user?.email || 'Account';
  const item = 'flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-ink';
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-full border border-line bg-white py-1 pl-1 pr-3 text-sm font-medium text-ink shadow-sm hover:bg-slate-50"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {session.user?.image
          ? <img src={session.user.image} alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" />
          : <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-50 text-brand-600"><HiOutlineUserCircle style={{ width: 18, height: 18 }} /></span>}
        <span className="max-w-[9rem] truncate">{name}</span>
        {unseen > 0 && <span className="rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white">{unseen}</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-2xl border border-line bg-white py-1 shadow-card animate-fadeIn">
          <div className="border-b border-line px-3 py-2">
            <p className="truncate text-sm font-medium text-ink">{session.user?.name || 'Signed in'}</p>
            {session.user?.email && <p className="truncate text-xs text-muted">{session.user.email}</p>}
          </div>
          <Link href="/history" className={item} role="menuitem"><HiOutlineClock style={{ width: 16, height: 16 }} /> History</Link>
          <Link href="/workspaces" className={item} role="menuitem"><HiOutlineFolder style={{ width: 16, height: 16 }} /> Workspaces</Link>
          <Link href="/watchlist" className={item} role="menuitem">
            <HiOutlineBell style={{ width: 16, height: 16 }} /> Watchlist{unseen > 0 ? ` · ${unseen} new` : ''}
          </Link>
          <button type="button" onClick={() => signOut({ callbackUrl: '/' })} className={`${item} w-full border-t border-line text-left`} role="menuitem">
            <HiOutlineArrowRightOnRectangle style={{ width: 16, height: 16 }} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
