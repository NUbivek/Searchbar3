/**
 * Deal workspaces: one per company. Searches, notes, pinned sources and
 * data-room documents build up here over time.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { HiOutlineFolder, HiOutlinePlus } from 'react-icons/hi2';
import PageShell, { SignInPrompt } from '../../components/layout/PageShell';

const ICON = { width: 15, height: 15 };

function Stat({ value, label }) {
  return (
    <span className="text-xs text-muted"><span className="font-semibold text-ink">{value}</span> {label}</span>
  );
}

export default function WorkspacesPage() {
  const { status } = useSession();
  const [workspaces, setWorkspaces] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const nameInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/workspaces');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load workspaces');
      setWorkspaces(d.workspaces);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { if (status === 'authenticated') load(); }, [status, load]);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const r = await fetch('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), company: name.trim() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not create workspace');
      window.location.href = `/workspaces/${d.workspace.id}`;
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  };

  return (
    <PageShell title="Deal workspaces" subtitle="One workspace per company: searches, notes, saved sources and data-room documents in one place.">
      {status === 'unauthenticated' && <SignInPrompt what="deal workspaces" />}
      {status === 'authenticated' && (
        <div className="space-y-4">
          <form onSubmit={create} className="card card-pad flex flex-col gap-2 sm:flex-row">
            <input
              ref={nameInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Company name, e.g. Mistral AI"
              aria-label="Company name"
              maxLength={120}
              className="input"
            />
            <button type="submit" disabled={creating || !name.trim()} className="btn-primary shrink-0">
              <HiOutlinePlus style={ICON} /> {creating ? 'Creating…' : 'New workspace'}
            </button>
          </form>
          {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{error}</div>}
          {workspaces === null && !error && (
            <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
              {[0, 1].map((i) => (
                <div key={i} className="card card-pad">
                  <div className="skeleton h-4 w-1/2" />
                  <div className="skeleton mt-2 h-3 w-1/4" />
                  <div className="skeleton mt-3 h-3 w-3/4" />
                </div>
              ))}
            </div>
          )}
          {workspaces && workspaces.length === 0 && (
            <div className="card card-pad text-center">
              <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><HiOutlineFolder style={{ width: 20, height: 20 }} /></span>
              <p className="text-sm text-ink">No workspaces yet. Create one for each company you are evaluating.</p>
              <button type="button" className="btn-secondary mt-4" onClick={() => nameInput.current?.focus()}>Create your first workspace</button>
            </div>
          )}
          {workspaces && workspaces.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {workspaces.map((w) => (
                <Link key={w.id} href={`/workspaces/${w.id}`} className="card card-pad block transition hover:border-brand-200 hover:shadow-float">
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><HiOutlineFolder style={{ width: 17, height: 17 }} /></span>
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-ink">{w.name}</div>
                      <div className="text-xs text-muted">Updated {new Date(w.updated_at).toLocaleDateString()}</div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                    <Stat value={w.search_count} label="searches" />
                    <Stat value={w.note_count} label="notes" />
                    <Stat value={w.source_count} label="sources" />
                    <Stat value={w.document_count} label="documents" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
