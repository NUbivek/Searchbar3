/**
 * Top-right account control: "Sign in" when signed out; when signed in, the
 * user's name with links to History, Workspaces and Watchlist, and Sign out.
 */
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import { FaUserCircle, FaHistory, FaFolderOpen, FaBell, FaSignOutAlt } from 'react-icons/fa';

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

  if (status === 'loading') return <div className="h-9" aria-hidden="true" />;

  if (status !== 'authenticated') {
    return (
      <Link href="/signin" className="inline-flex items-center text-sm font-medium text-blue-600 bg-white border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50">
        <FaUserCircle className="mr-2" /> Sign in
      </Link>
    );
  }

  const name = session.user?.name || session.user?.email || 'Account';
  const item = 'flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700';
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {session.user?.image
          ? <img src={session.user.image} alt="" className="w-5 h-5 rounded-full mr-2" referrerPolicy="no-referrer" />
          : <FaUserCircle className="mr-2 text-blue-500" />}
        <span className="max-w-[10rem] truncate">{name}</span>
        {unseen > 0 && <span className="ml-2 text-xs bg-red-500 text-white rounded-full px-1.5">{unseen}</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
          <Link href="/history" className={item} role="menuitem"><FaHistory className="mr-2" /> History</Link>
          <Link href="/workspaces" className={item} role="menuitem"><FaFolderOpen className="mr-2" /> Workspaces</Link>
          <Link href="/watchlist" className={item} role="menuitem">
            <FaBell className="mr-2" /> Watchlist{unseen > 0 ? ` (${unseen} new)` : ''}
          </Link>
          <button type="button" onClick={() => signOut({ callbackUrl: '/' })} className={`${item} w-full text-left border-t border-gray-100`} role="menuitem">
            <FaSignOutAlt className="mr-2" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
