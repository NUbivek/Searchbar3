/**
 * A saved search, shown in the standard results view (All Results + Key
 * Insights) from the summary and sources saved at search time.
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
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
        <Link href={`/?q=${encodeURIComponent(search.query)}${search.workspace_id ? `&workspace=${search.workspace_id}` : ''}`} className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm">Run again</Link>
      )}
    >
      {status === 'unauthenticated' && <SignInPrompt what="search history" />}
      {error && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{error}</div>}
      {results && <SimplifiedLLMResults query={search.query} results={results} />}
    </PageShell>
  );
}
