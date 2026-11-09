/**
 * "Watch" / "Watching" toggle for a company. Signed-in users only; renders
 * nothing when signed out. Adding a watch also runs a first check, so new
 * alerts show up on /watchlist right away.
 */
import React, { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { HiOutlineBell, HiOutlineCheck } from 'react-icons/hi2';

const ICON = { width: 14, height: 14 };

export default function WatchButton({ company, workspaceId = null, className = '' }) {
  const { status } = useSession();
  const [watch, setWatch] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const name = String(company || '').trim();

  useEffect(() => {
    if (status !== 'authenticated' || !name) return undefined;
    let cancelled = false;
    fetch('/api/watchlist')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.watchlist) return;
        setWatch(d.watchlist.find((w) => w.company.toLowerCase() === name.toLowerCase()) || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [status, name]);

  if (status !== 'authenticated' || !name) return null;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (watch) {
        const r = await fetch(`/api/watchlist?id=${encodeURIComponent(watch.id)}`, { method: 'DELETE' });
        if (!r.ok && r.status !== 404) throw new Error((await r.json().catch(() => ({}))).error || 'Could not remove.');
        setWatch(null);
      } else {
        const r = await fetch('/api/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company: name, ...(workspaceId ? { workspaceId } : {}) }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not add.');
        setWatch(d.watch);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={watch ? 'Stop watching this company' : 'Get alerts about new funding, hires, filings and press'}
        aria-pressed={Boolean(watch)}
        className={watch
          ? 'btn-secondary border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-700 hover:bg-brand-100'
          : 'btn-secondary px-3 py-2 text-xs'}
      >
        {watch ? <HiOutlineCheck style={ICON} /> : <HiOutlineBell style={ICON} />}
        {busy ? (watch ? 'Removing…' : 'Adding…') : watch ? 'Watching' : 'Watch'}
      </button>
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </span>
  );
}
