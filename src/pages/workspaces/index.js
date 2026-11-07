/**
 * Deal workspaces: one per company. Searches, notes, pinned sources and
 * data-room documents build up here over time.
 */
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import PageShell, { SignInPrompt } from '../../components/layout/PageShell';

export default function WorkspacesPage() {
  const { status } = useSession();
  const [workspaces, setWorkspaces] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

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
        <>
          <form onSubmit={create} className="flex mb-4">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Company name, e.g. Mistral AI"
              maxLength={120}
              className="flex-grow p-2 border border-gray-300 rounded-l-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button type="submit" disabled={creating} className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-r-md disabled:opacity-50">
              {creating ? 'Creating…' : 'New workspace'}
            </button>
          </form>
          {error && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{error}</div>}
          {workspaces === null && !error && <p className="text-gray-600">Loading…</p>}
          {workspaces && workspaces.length === 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-6 text-gray-700">No workspaces yet. Create one for each company you are evaluating.</div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {(workspaces || []).map((w) => (
              <Link key={w.id} href={`/workspaces/${w.id}`} className="block bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-sm">
                <div className="font-semibold text-gray-800">{w.name}</div>
                <div className="text-xs text-gray-500 mt-1">Updated {new Date(w.updated_at).toLocaleDateString()}</div>
                <div className="flex gap-3 text-sm text-gray-600 mt-2">
                  <span>{w.search_count} searches</span>
                  <span>{w.note_count} notes</span>
                  <span>{w.source_count} sources</span>
                  <span>{w.document_count} documents</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </PageShell>
  );
}
