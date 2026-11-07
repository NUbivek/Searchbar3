/**
 * Watchlist: companies the user follows and the alerts found for them in the
 * curated sources and Hacker News (new funding, people moves, filings,
 * portfolio listings, press). Alerts are in-app only.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import PageShell, { SignInPrompt } from '../components/layout/PageShell';

const KIND_STYLE = {
  funding: { label: 'Funding', cls: 'bg-green-100 text-green-800' },
  people: { label: 'People', cls: 'bg-purple-100 text-purple-800' },
  filing: { label: 'Filing', cls: 'bg-amber-100 text-amber-800' },
  portfolio: { label: 'Portfolio', cls: 'bg-blue-100 text-blue-800' },
  press: { label: 'Press', cls: 'bg-gray-100 text-gray-700' },
};

function fmtDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtWhen(value) {
  if (!value) return 'Not checked yet';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Not checked yet';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Checked just now';
  if (mins < 60) return `Checked ${mins} min ago`;
  if (mins < 48 * 60) return `Checked ${Math.round(mins / 60)} h ago`;
  return `Checked ${fmtDate(value)}`;
}

export default function WatchlistPage() {
  const { status } = useSession();
  const [watchlist, setWatchlist] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [company, setCompany] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [w, a] = await Promise.all([
        fetch('/api/watchlist').then((r) => r.json().then((d) => ({ ok: r.ok, d }))),
        fetch('/api/alerts?limit=300').then((r) => r.json().then((d) => ({ ok: r.ok, d }))),
      ]);
      if (!w.ok) throw new Error(w.d.error || 'Could not load your watchlist.');
      setWatchlist(w.d.watchlist || []);
      setAlerts(a.ok ? a.d.alerts || [] : []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (status === 'authenticated') load(); }, [status, load]);

  const reportCheck = (name, check) => {
    if (!check) return;
    if (check.error) setMessage(`${name}: ${check.error}`);
    else setMessage(`${name}: ${check.created} new alert${check.created === 1 ? '' : 's'}${check.found > check.created ? ` (${check.found - check.created} already seen before)` : ''}.`);
  };

  async function add(e) {
    e.preventDefault();
    const name = company.trim();
    if (!name) return;
    setBusy('add');
    setMessage(null);
    try {
      const r = await fetch('/api/watchlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company: name }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not add.');
      setCompany('');
      reportCheck(d.watch?.company || name, d.check);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function checkNow(w) {
    setBusy(w.id);
    setMessage(null);
    try {
      const r = await fetch('/api/watchlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: w.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Check failed.');
      reportCheck(w.company, d.check);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(w) {
    if (!window.confirm(`Stop watching ${w.company}? Its alerts will be removed.`)) return;
    setBusy(w.id);
    try {
      await fetch(`/api/watchlist?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function markSeen(ids = null) {
    await fetch('/api/alerts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids ? { ids } : {}),
    });
    await load();
  }

  const grouped = useMemo(() => {
    const map = new Map();
    for (const a of alerts) {
      if (!map.has(a.company)) map.set(a.company, []);
      map.get(a.company).push(a);
    }
    for (const list of map.values()) {
      list.sort((x, y) => (Date.parse(y.published_at || '') || 0) - (Date.parse(x.published_at || '') || 0));
    }
    return [...map.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  }, [alerts]);

  const unseenTotal = alerts.filter((a) => !a.seen).length;

  if (status === 'loading') return <PageShell title="Watchlist"><div className="text-gray-500 text-sm">Loading…</div></PageShell>;
  if (status !== 'authenticated') {
    return <PageShell title="Watchlist"><SignInPrompt what="watchlists and alerts" /></PageShell>;
  }

  return (
    <PageShell
      title="Watchlist"
      subtitle="Alerts for new funding rounds, people moves, filings, portfolio listings and press about the companies you follow. Checked every 6 hours from the curated sources and Hacker News."
    >
      <form onSubmit={add} className="bg-white border border-gray-200 rounded-lg p-4 mb-4 flex flex-col sm:flex-row gap-2">
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Company name, e.g. Mistral"
          maxLength={200}
          className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <button type="submit" disabled={busy === 'add' || !company.trim()} className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm disabled:opacity-60">
          {busy === 'add' ? 'Adding and checking…' : 'Watch company'}
        </button>
      </form>
      <p className="text-xs text-gray-500 -mt-2 mb-4">Names are matched with exact capitalization (e.g. “Ramp”, not “ramp up”).</p>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">{error}</div>}
      {message && <div className="bg-blue-50 border border-blue-200 text-blue-800 text-sm rounded-lg p-3 mb-4">{message}</div>}

      <div className="grid gap-4 md:grid-cols-3">
        <section className="md:col-span-1">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Watching ({watchlist.length})</h2>
          {loading ? (
            <div className="text-gray-500 text-sm">Loading…</div>
          ) : watchlist.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-lg p-4 text-sm text-gray-600">No companies yet. Add one above, or use “Watch” on a workspace.</div>
          ) : (
            <ul className="space-y-2">
              {watchlist.map((w) => (
                <li key={w.id} className="bg-white border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-800 truncate">{w.company}</span>
                    {w.unseen > 0 && <span className="text-xs bg-blue-500 text-white rounded-full px-2 py-0.5">{w.unseen} new</span>}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">{fmtWhen(w.last_checked_at)}</div>
                  <div className="flex gap-3 mt-2 text-xs">
                    <button type="button" onClick={() => checkNow(w)} disabled={busy === w.id} className="text-blue-600 hover:underline disabled:opacity-60">
                      {busy === w.id ? 'Checking…' : 'Check now'}
                    </button>
                    {w.workspace_id && <a href={`/workspaces/${w.workspace_id}`} className="text-blue-600 hover:underline">Workspace</a>}
                    <button type="button" onClick={() => remove(w)} disabled={busy === w.id} className="text-red-600 hover:underline ml-auto disabled:opacity-60">Remove</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="md:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-700">Alerts{unseenTotal ? ` (${unseenTotal} new)` : ''}</h2>
            {unseenTotal > 0 && (
              <button type="button" onClick={() => markSeen()} className="text-xs text-blue-600 hover:underline">Mark all seen</button>
            )}
          </div>
          {!loading && grouped.length === 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-4 text-sm text-gray-600">
              No alerts yet. Alerts appear when a source publishes something new that names a watched company (last 90 days).
            </div>
          )}
          <div className="space-y-4">
            {grouped.map(([name, list]) => {
              const unseenIds = list.filter((a) => !a.seen).map((a) => a.id);
              return (
                <div key={name} className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-gray-800">{name}</h3>
                    {unseenIds.length > 0 && (
                      <button type="button" onClick={() => markSeen(unseenIds)} className="text-xs text-blue-600 hover:underline">Mark seen</button>
                    )}
                  </div>
                  <ul className="divide-y divide-gray-100">
                    {list.map((a) => {
                      const k = KIND_STYLE[a.kind] || KIND_STYLE.press;
                      return (
                        <li key={a.id} className="py-2 flex items-start gap-2">
                          <span className={`shrink-0 text-xs font-medium rounded px-2 py-0.5 mt-0.5 ${k.cls}`}>{k.label}</span>
                          <div className="min-w-0">
                            <a href={a.url} target="_blank" rel="noopener noreferrer" className={`text-sm hover:underline ${a.seen ? 'text-gray-700' : 'text-blue-700 font-medium'}`}>
                              {a.title}
                            </a>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {a.source_name || 'Source'}
                              {fmtDate(a.published_at) ? ` · ${fmtDate(a.published_at)}` : ' · undated listing'}
                              {!a.seen && <span className="ml-2 text-blue-600">new</span>}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </PageShell>
  );
}
