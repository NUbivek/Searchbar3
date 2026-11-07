/**
 * One deal workspace: searches filed here, analyst notes, pinned sources,
 * data-room documents with Q&A, memo export, and watchlist toggle.
 */
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import PageShell, { SignInPrompt } from '../../../components/layout/PageShell';
import WatchButton from '../../../components/watchlist/WatchButton';
import MemoExportButtons from '../../../components/workspace/MemoExportButtons';
import DataRoom from '../../../components/workspace/DataRoom';

const fmt = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const card = 'bg-white border border-gray-200 rounded-lg p-4 mb-4';

export default function WorkspacePage() {
  const router = useRouter();
  const { id } = router.query;
  const { status } = useSession();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await fetch(`/api/workspaces/${id}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load workspace');
      setDetail(d);
    } catch (e) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => { if (status === 'authenticated') load(); }, [status, load]);

  const addNote = async (e) => {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    const r = await fetch(`/api/workspaces/${id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: note }) });
    setBusy(false);
    if (r.ok) { setNote(''); load(); } else { setError((await r.json()).error || 'Could not save note'); }
  };
  const deleteNote = async (noteId) => { await fetch(`/api/workspaces/${id}/notes?noteId=${noteId}`, { method: 'DELETE' }); load(); };
  const removeSource = async (sourceId) => { await fetch(`/api/workspaces/${id}/sources?sourceId=${sourceId}`, { method: 'DELETE' }); load(); };
  const removeWorkspace = async () => {
    if (!window.confirm('Delete this workspace with its notes, saved sources and documents? Searches stay in your history.')) return;
    const r = await fetch(`/api/workspaces/${id}`, { method: 'DELETE' });
    if (r.ok) router.push('/workspaces');
  };

  const ws = detail?.workspace;
  const company = ws?.company || ws?.name || '';

  return (
    <PageShell
      title={ws ? ws.name : 'Workspace'}
      subtitle={ws ? `Created ${fmt(ws.created_at)} · last updated ${fmt(ws.updated_at)}` : null}
      actions={ws && (
        <div className="flex flex-wrap gap-2 justify-end items-center">
          <WatchButton company={company} workspaceId={ws.id} />
          <MemoExportButtons workspaceId={ws.id} />
        </div>
      )}
    >
      {status === 'unauthenticated' && <SignInPrompt what="deal workspaces" />}
      {error && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{error}</div>}
      {status === 'authenticated' && !detail && !error && <p className="text-gray-600">Loading…</p>}

      {ws && (
        <>
          <div className={`${card} flex flex-wrap gap-3 items-center`}>
            <Link href={`/?q=${encodeURIComponent(company)}&workspace=${ws.id}`} className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm">Search {company} into this workspace</Link>
            <Link href={`/company/${encodeURIComponent(company)}`} className="text-sm text-blue-600 hover:underline">Company profile</Link>
            <Link href={`/founder?company=${encodeURIComponent(company)}`} className="text-sm text-blue-600 hover:underline">Founder check</Link>
            <button type="button" onClick={removeWorkspace} className="ml-auto text-sm text-red-600 hover:underline">Delete workspace</button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <section className={card}>
              <h2 className="font-semibold text-gray-800 mb-2">Searches ({detail.searches.length})</h2>
              {detail.searches.length === 0 && <p className="text-sm text-gray-600">No searches yet. Choose this workspace in "Save to" on the search page.</p>}
              <ul className="divide-y divide-gray-100">
                {detail.searches.map((s) => (
                  <li key={s.id} className="py-2">
                    <Link href={`/history/${s.id}`} className="text-blue-700 hover:underline">{s.query}</Link>
                    <div className="text-xs text-gray-500">{fmt(s.created_at)} · {s.result_count} sources</div>
                  </li>
                ))}
              </ul>
            </section>

            <section className={card}>
              <h2 className="font-semibold text-gray-800 mb-2">Analyst notes ({detail.notes.length})</h2>
              <form onSubmit={addNote} className="mb-3">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={10000}
                  placeholder="Add a note (open question, call notes, red flag…)"
                  className="w-full p-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button type="submit" disabled={busy || !note.trim()} className="mt-2 bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm disabled:opacity-50">Add note</button>
              </form>
              <ul className="space-y-2">
                {detail.notes.map((n) => (
                  <li key={n.id} className="text-sm border-l-2 border-blue-200 pl-3">
                    <div className="whitespace-pre-wrap text-gray-800">{n.body}</div>
                    <div className="text-xs text-gray-500 mt-1">{fmt(n.created_at)} · <button type="button" onClick={() => deleteNote(n.id)} className="text-red-600 hover:underline">Delete</button></div>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className={card}>
            <h2 className="font-semibold text-gray-800 mb-2">Saved sources ({detail.sources.length})</h2>
            {detail.sources.length === 0 && <p className="text-sm text-gray-600">Use "+ Save" next to a source in Key Insights → Top Sources to pin it here.</p>}
            <ul className="divide-y divide-gray-100">
              {detail.sources.map((s) => (
                <li key={s.id} className="py-2 text-sm">
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">{s.title}</a>
                  <span className="text-xs text-gray-500"> · {s.source_name || new URL(s.url).hostname}{s.published_at ? ` · ${String(s.published_at).slice(0, 10)}` : ''}</span>
                  {s.excerpt && <p className="text-gray-600 mt-1">{s.excerpt}</p>}
                  <button type="button" onClick={() => removeSource(s.id)} className="ml-2 text-xs text-red-600 hover:underline">Remove</button>
                </li>
              ))}
            </ul>
          </section>

          <section className="mb-4">
            <DataRoom workspaceId={ws.id} />
          </section>
        </>
      )}
    </PageShell>
  );
}
