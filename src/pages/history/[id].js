/**
 * A saved search, shown in the standard results view (All Results + Key
 * Insights) from the summary and sources saved at search time.
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import { HiOutlineArrowPath } from 'react-icons/hi2';
import PageShell, { SignInPrompt } from '../../components/layout/PageShell';
import SimplifiedLLMResults from '../../components/search/results/SimplifiedLLMResults';

export default function SavedSearchPage() {
  const router = useRouter();
  const { status } = useSession();
  const [search, setSearch] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (status !== 'authenticated' || !router.query.id) return;
    fetch(`/api/history/${router.query.id}`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Not found'); setSearch(d.search); })
      .catch((e) => setError(e.message));
  }, [status, router.query.id]);

  const results = search ? {
    content: search.summary || '',
    results: (search.top_sources || []).map((s) => ({ ...s, content: s.snippet })),
    isLLMResult: true,
    __isImmutableLLMResult: true,
    query: search.query,
  } : null;

  return (
    <PageShell
      title={search ? search.query : 'Saved search'}
      subtitle={search ? `Saved ${new Date(search.created_at).toLocaleString()}` : null}
      actions={search && (
        <Link href={`/?q=${encodeURIComponent(search.query)}${search.workspace_id ? `&workspace=${search.workspace_id}` : ''}`} className="btn-primary"><HiOutlineArrowPath style={{ width: 15, height: 15 }} /> Run again</Link>
      )}
    >
      {status === 'unauthenticated' && <SignInPrompt what="search history" />}
      {error && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{error}</div>}
      {status === 'authenticated' && !search && !error && (
        <div className="card card-pad" aria-busy="true" aria-live="polite">
          <p className="muted">Opening the saved search…</p>
          <div className="mt-4 space-y-2">
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton h-3 w-full" />
            <div className="skeleton h-3 w-5/6" />
          </div>
        </div>
      )}
      {results && <SimplifiedLLMResults query={search.query} results={results} />}
    </PageShell>
  );
}
