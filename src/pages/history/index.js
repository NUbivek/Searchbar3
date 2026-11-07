/**
 * Search history for the signed-in user: reopen, re-run, file under a
 * workspace, or delete.
 */
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import PageShell, { SignInPrompt } from '../../components/layout/PageShell';

const fmt = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

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
      {error && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{error}</div>}
      {status === 'authenticated' && searches === null && !error && <p className="text-gray-600">Loading…</p>}
      {searches && searches.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-gray-700">No searches yet. <Link href="/" className="text-blue-600 underline">Run a search</Link>.</div>
      )}
      {searches && searches.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {searches.map((s) => (
            <div key={s.id} className="p-4 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[12rem]">
                <Link href={`/history/${s.id}`} className="font-medium text-blue-700 hover:underline">{s.query}</Link>
                <div className="text-xs text-gray-500 mt-1">
                  {fmt(s.created_at)} · {s.result_count} source{s.result_count === 1 ? '' : 's'}
                  {s.workspace_name ? <> · in <Link className="underline" href={`/workspaces/${s.workspace_id}`}>{s.workspace_name}</Link></> : null}
                </div>
              </div>
              <select
                aria-label="File under workspace"
                className="text-sm border border-gray-300 rounded-md px-2 py-1"
                value={s.workspace_id || ''}
                onChange={(e) => move(s.id, e.target.value)}
              >
                <option value="">No workspace</option>
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <Link href={`/?q=${encodeURIComponent(s.query)}${s.workspace_id ? `&workspace=${s.workspace_id}` : ''}`} className="text-sm text-blue-600 hover:underline">Run again</Link>
              <button type="button" onClick={() => remove(s.id)} className="text-sm text-red-600 hover:underline">Delete</button>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}
