/**
 * One deal workspace: searches filed here, analyst notes, pinned sources,
 * data-room documents with Q&A, memo export, and watchlist toggle.
 */
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import { HiOutlineMagnifyingGlass, HiOutlineTrash, HiOutlineBuildingOffice2, HiOutlineUserCircle } from 'react-icons/hi2';
import PageShell, { SignInPrompt } from '../../../components/layout/PageShell';
import WatchButton from '../../../components/watchlist/WatchButton';
import MemoExportButtons from '../../../components/workspace/MemoExportButtons';
import DataRoom from '../../../components/workspace/DataRoom';

const fmt = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const ICON = { width: 15, height: 15 };

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function Favicon({ url }) {
  const host = hostOf(url);
  if (!host) return <span className="inline-block h-4 w-4 rounded bg-slate-100" aria-hidden="true" />;
  return <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`} alt="" width={16} height={16} loading="lazy" className="inline-block h-4 w-4 rounded" />;
}

function SectionCard({ title, count, children }) {
  return (
    <section className="card card-pad">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="section-title">{title}</h2>
        {typeof count === 'number' && count > 0 && <span className="chip">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <p className="muted">Loading workspace…</p>
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="card card-pad">
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton mt-3 h-3 w-full" />
            <div className="skeleton mt-2 h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

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
        <div className="flex flex-wrap items-center justify-end gap-2">
          <WatchButton company={company} workspaceId={ws.id} />
          <MemoExportButtons workspaceId={ws.id} />
        </div>
      )}
    >
      {status === 'unauthenticated' && <SignInPrompt what="deal workspaces" />}
      {error && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{error}</div>}
      {status === 'authenticated' && !detail && !error && <DetailSkeleton />}

      {ws && (
        <div className="space-y-4">
          <div className="card card-pad flex flex-wrap items-center gap-2">
            <Link href={`/?q=${encodeURIComponent(company)}&workspace=${ws.id}`} className="btn-primary">
              <HiOutlineMagnifyingGlass style={ICON} /> Search {company} into this workspace
            </Link>
            <Link href={`/company/${encodeURIComponent(company)}`} className="btn-secondary"><HiOutlineBuildingOffice2 style={ICON} /> Company profile</Link>
            <Link href={`/founder?company=${encodeURIComponent(company)}`} className="btn-secondary"><HiOutlineUserCircle style={ICON} /> Founder check</Link>
            <button type="button" onClick={removeWorkspace} className="btn-danger sm:ml-auto"><HiOutlineTrash style={{ width: 14, height: 14 }} /> Delete workspace</button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard title="Searches" count={detail.searches.length}>
              {detail.searches.length === 0 && (
                <p className="muted">No searches yet. Choose this workspace in &ldquo;Save to&rdquo; on the search page.</p>
              )}
              <ul className="divide-y divide-line">
                {detail.searches.map((s) => (
                  <li key={s.id} className="py-2.5 first:pt-0 last:pb-0">
                    <Link href={`/history/${s.id}`} className="text-sm font-medium text-ink hover:text-brand-600 hover:underline">{s.query}</Link>
                    <div className="text-xs text-muted">{fmt(s.created_at)} · {s.result_count} sources</div>
                  </li>
                ))}
              </ul>
            </SectionCard>

            <SectionCard title="Analyst notes" count={detail.notes.length}>
              <form onSubmit={addNote} className="mb-3">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={10000}
                  placeholder="Add a note (open question, call notes, red flag…)"
                  aria-label="New note"
                  className="input resize-y"
                />
                <button type="submit" disabled={busy || !note.trim()} className="btn-primary mt-2 px-3 py-2 text-xs">Add note</button>
              </form>
              <ul className="space-y-3">
                {detail.notes.map((n) => (
                  <li key={n.id} className="rounded-xl border border-line bg-slate-50/60 px-3.5 py-3 text-sm">
                    <div className="whitespace-pre-wrap text-slate-700">{n.body}</div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
                      <span>{fmt(n.created_at)}</span>
                      <button type="button" onClick={() => deleteNote(n.id)} className="btn-danger px-2 py-1 text-xs">Delete</button>
                    </div>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>

          <SectionCard title="Saved sources" count={detail.sources.length}>
            {detail.sources.length === 0 && (
              <p className="muted">Use &ldquo;+ Save&rdquo; next to a source in Key Insights → Top Sources to pin it here.</p>
            )}
            <ul className="divide-y divide-line">
              {detail.sources.map((s) => (
                <li key={s.id} className="flex items-start gap-2.5 py-3 text-sm first:pt-0 last:pb-0">
                  <span className="mt-0.5 shrink-0"><Favicon url={s.url} /></span>
                  <div className="min-w-0 flex-1">
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-medium text-ink hover:text-brand-600 hover:underline">{s.title}</a>
                    <span className="block text-xs text-muted">{s.source_name || hostOf(s.url)}{s.published_at ? ` · ${String(s.published_at).slice(0, 10)}` : ''}</span>
                    {s.excerpt && <p className="mt-1 text-slate-600">{s.excerpt}</p>}
                  </div>
                  <button type="button" onClick={() => removeSource(s.id)} className="btn-danger shrink-0 px-2 py-1 text-xs">Remove</button>
                </li>
              ))}
            </ul>
          </SectionCard>

          <DataRoom workspaceId={ws.id} />
        </div>
      )}
    </PageShell>
  );
}
