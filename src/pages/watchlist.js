/**
 * Watchlist: companies the user follows and the alerts found for them in the
 * curated sources and Hacker News (new funding, people moves, filings,
 * portfolio listings, press). Alerts are in-app, plus an email digest after
 * each scheduled check when the server has email enabled.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { HiOutlineBell, HiOutlineArrowPath, HiOutlineTrash, HiOutlineFolder, HiOutlinePlus } from 'react-icons/hi2';
import PageShell, { SignInPrompt } from '../components/layout/PageShell';

const KIND_STYLE = {
  funding: { label: 'Funding', cls: 'chip chip-good' },
  people: { label: 'People', cls: 'chip chip-active' },
  filing: { label: 'Filing', cls: 'chip chip-warn' },
  portfolio: { label: 'Portfolio', cls: 'chip' },
  press: { label: 'Press', cls: 'chip' },
};
const ICON = { width: 14, height: 14 };

function NewDot({ title = 'New' }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-brand-500" title={title} aria-label={title} role="img" />;
}

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
  const [emailAlerts, setEmailAlerts] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [company, setCompany] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const companyInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const [w, a] = await Promise.all([
        fetch('/api/watchlist').then((r) => r.json().then((d) => ({ ok: r.ok, d }))),
        fetch('/api/alerts?limit=300').then((r) => r.json().then((d) => ({ ok: r.ok, d }))),
      ]);
      if (!w.ok) throw new Error(w.d.error || 'Could not load your watchlist.');
      setWatchlist(w.d.watchlist || []);
      setEmailAlerts(Boolean(w.d.emailAlerts));
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

  if (status === 'loading') return <PageShell title="Watchlist"><p className="muted">Loading…</p></PageShell>;
  if (status !== 'authenticated') {
    return <PageShell title="Watchlist"><SignInPrompt what="watchlists and alerts" /></PageShell>;
  }

  return (
    <PageShell
      title="Watchlist"
      subtitle="Daily alerts for funding, people, filings and press about the companies you follow."
    >
      <div className="space-y-4">
        <form onSubmit={add} className="card card-pad">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              ref={companyInput}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Company name, e.g. Mistral"
              aria-label="Company name"
              maxLength={200}
              className="input"
            />
            <button type="submit" disabled={busy === 'add' || !company.trim()} className="btn-primary shrink-0">
              <HiOutlineBell style={ICON} /> {busy === 'add' ? 'Adding and checking…' : 'Watch company'}
            </button>
          </div>
          <p className="muted mt-2 text-xs">Names are matched with exact capitalization (e.g. “Ramp”, not “ramp up”).</p>
        </form>

        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{error}</div>}
        {message && <div className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700" role="status">{message}</div>}

        <div className="grid gap-4 md:grid-cols-3">
          <section className="md:col-span-1">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="section-title">Watching</h2>
              {watchlist.length > 0 && <span className="chip">{watchlist.length}</span>}
            </div>
            {loading ? (
              <div className="space-y-2" aria-busy="true">
                {[0, 1].map((i) => (
                  <div key={i} className="card p-3">
                    <div className="skeleton h-4 w-2/3" />
                    <div className="skeleton mt-2 h-3 w-1/3" />
                  </div>
                ))}
              </div>
            ) : watchlist.length === 0 ? (
              <div className="card card-pad text-center">
                <p className="muted">No companies yet. Add one here, or use “Watch” on a workspace.</p>
                <button type="button" className="btn-secondary mt-3" onClick={() => companyInput.current?.focus()}><HiOutlinePlus style={ICON} /> Watch a company</button>
              </div>
            ) : (
              <ul className="space-y-2">
                {watchlist.map((w) => (
                  <li key={w.id} className="card p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        {w.unseen > 0 && <NewDot title={`${w.unseen} new`} />}
                        <span className="truncate text-sm font-medium text-ink">{w.company}</span>
                      </span>
                      {w.unseen > 0 && <span className="chip chip-active">{w.unseen} new</span>}
                    </div>
                    <div className="mt-1 text-xs text-muted">{fmtWhen(w.last_checked_at)}</div>
                    <div className="mt-2 flex items-center gap-1">
                      <button type="button" onClick={() => checkNow(w)} disabled={busy === w.id} className="btn-ghost -ml-1 px-2 py-1 text-xs disabled:opacity-60">
                        <HiOutlineArrowPath style={{ width: 13, height: 13 }} /> {busy === w.id ? 'Checking…' : 'Check now'}
                      </button>
                      {w.workspace_id && <a href={`/workspaces/${w.workspace_id}`} className="btn-ghost px-2 py-1 text-xs"><HiOutlineFolder style={{ width: 13, height: 13 }} /> Workspace</a>}
                      <button type="button" onClick={() => remove(w)} disabled={busy === w.id} className="btn-danger ml-auto px-2 py-1 text-xs disabled:opacity-60"><HiOutlineTrash style={{ width: 13, height: 13 }} /> Remove</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="md:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="section-title">Alerts</h2>
                {unseenTotal > 0 && <span className="chip chip-active">{unseenTotal} new</span>}
              </div>
              {unseenTotal > 0 && (
                <button type="button" onClick={() => markSeen()} className="btn-ghost text-xs">Mark all seen</button>
              )}
            </div>
            {emailAlerts !== null && (
              <p className="muted mb-2 text-xs">
                Watched companies are checked daily. {emailAlerts
                  ? 'New alerts are also emailed to your sign-in address as a digest.'
                  : 'Alerts are shown here; email digests are not enabled on this deployment.'}
              </p>
            )}
            {!loading && grouped.length === 0 && (
              <div className="card card-pad text-center">
                <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><HiOutlineBell style={{ width: 20, height: 20 }} /></span>
                <p className="muted">No alerts yet. Alerts appear when a source publishes something new that names a watched company (last 90 days).</p>
                {watchlist.length === 0 ? (
                  <button type="button" className="btn-secondary mt-4" onClick={() => companyInput.current?.focus()}>Watch a company</button>
                ) : (
                  <button type="button" className="btn-secondary mt-4" disabled={Boolean(busy)} onClick={() => checkNow(watchlist[0])}>
                    <HiOutlineArrowPath style={ICON} /> Check {watchlist[0].company} now
                  </button>
                )}
              </div>
            )}
            <div className="space-y-4">
              {grouped.map(([name, list]) => {
                const unseenIds = list.filter((a) => !a.seen).map((a) => a.id);
                return (
                  <div key={name} className="card card-pad">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                        {name}
                        {unseenIds.length > 0 && <span className="chip chip-active">{unseenIds.length} new</span>}
                      </h3>
                      {unseenIds.length > 0 && (
                        <button type="button" onClick={() => markSeen(unseenIds)} className="btn-ghost text-xs">Mark seen</button>
                      )}
                    </div>
                    <ul className="divide-y divide-line">
                      {list.map((a) => {
                        const k = KIND_STYLE[a.kind] || KIND_STYLE.press;
                        return (
                          <li key={a.id} className="flex items-start gap-2.5 py-2.5">
                            <span className="mt-1.5 w-2 shrink-0">{!a.seen && <NewDot />}</span>
                            <span className={`${k.cls} mt-0.5 shrink-0`}>{k.label}</span>
                            <div className="min-w-0">
                              <a href={a.url} target="_blank" rel="noopener noreferrer" className={`text-sm hover:underline ${a.seen ? 'text-slate-700' : 'font-medium text-ink'}`}>
                                {a.title}
                              </a>
                              <div className="mt-0.5 text-xs text-muted">
                                {a.source_name || 'Source'}
                                {fmtDate(a.published_at) ? ` · ${fmtDate(a.published_at)}` : ' · undated listing'}
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
      </div>
    </PageShell>
  );
}
