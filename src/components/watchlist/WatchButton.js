/**
 * "Watch" / "Watching ✓" toggle for a company. Signed-in users only; renders
 * nothing when signed out. Adding a watch also runs a first check, so new
 * alerts show up on /watchlist right away.
 */
import React, { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';

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
        className={watch
          ? 'text-sm px-3 py-1.5 rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-60'
          : 'text-sm px-3 py-1.5 rounded-md bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-60'}
      >
        {busy ? (watch ? 'Removing…' : 'Adding…') : watch ? 'Watching ✓' : 'Watch'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
