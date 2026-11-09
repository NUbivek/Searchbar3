/**
 * Search history for the signed-in user: reopen, re-run, file under a
 * workspace, or delete.
 */
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { HiOutlineClock, HiOutlineArrowPath, HiOutlineTrash, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import PageShell, { SignInPrompt } from '../../components/layout/PageShell';

const fmt = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const ICON = { width: 14, height: 14 };

export default function HistoryPage() {
  const { status } = useSession();
  const [searches, setSearches] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [h, w] = await Promise.all([fetch('/api/history?limit=100'), fetch('/api/workspaces')]);
      const hd = await h.json();
      if (!h.ok) throw new Error(hd.error || 'Could not load history');
      setSearches(hd.searches);
      if (w.ok) setWorkspaces((await w.json()).workspaces || []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { if (status === 'authenticated') load(); }, [status, load]);

  const move = async (id, workspaceId) => {
    await fetch('/api/history', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, workspaceId: workspaceId || null }) });
    load();
  };
  const remove = async (id) => {
    if (!window.confirm('Delete this search from your history?')) return;
    await fetch(`/api/history?id=${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <PageShell title="Search history" subtitle="Every search you run while signed in is saved here.">
      {status === 'unauthenticated' && <SignInPrompt what="search history" />}
      {error && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{error}</div>}
      {status === 'authenticated' && searches === null && !error && (
        <div className="card divide-y divide-line" aria-busy="true" aria-live="polite">
          {[0, 1, 2].map((i) => (
            <div key={i} className="p-4">
              <div className="skeleton h-4 w-1/2" />
              <div className="skeleton mt-2 h-3 w-1/4" />
            </div>
          ))}
        </div>
      )}
      {searches && searches.length === 0 && (
        <div className="card card-pad text-center">
          <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><HiOutlineClock style={{ width: 20, height: 20 }} /></span>
          <p className="text-sm text-ink">No searches yet. Run a search and it will be saved here.</p>
          <Link href="/" className="btn-primary mt-4"><HiOutlineMagnifyingGlass style={ICON} /> Run a search</Link>
        </div>
      )}
      {searches && searches.length > 0 && (
        <div className="card divide-y divide-line">
          {searches.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-[12rem] flex-1">
                <Link href={`/history/${s.id}`} className="text-sm font-medium text-ink hover:text-brand-600 hover:underline">{s.query}</Link>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span>{fmt(s.created_at)} · {s.result_count} source{s.result_count === 1 ? '' : 's'}</span>
                  {s.workspace_name ? <Link className="chip chip-active" href={`/workspaces/${s.workspace_id}`}>{s.workspace_name}</Link> : null}
                </div>
              </div>
              <select
                aria-label="File under workspace"
                className="select py-1.5 text-xs"
                value={s.workspace_id || ''}
                onChange={(e) => move(s.id, e.target.value)}
              >
                <option value="">No workspace</option>
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <Link href={`/?q=${encodeURIComponent(s.query)}${s.workspace_id ? `&workspace=${s.workspace_id}` : ''}`} className="btn-ghost text-xs"><HiOutlineArrowPath style={ICON} /> Run again</Link>
              <button type="button" onClick={() => remove(s.id)} className="btn-danger text-xs"><HiOutlineTrash style={ICON} /> Delete</button>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}
