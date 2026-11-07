import React, { useState, useRef, useEffect } from 'react';
import ModelSelector from './ModelSelector';
import SourceSelector from './SourceSelector';
import SimplifiedLLMResults, { FollowUpChat } from './search/results/SimplifiedLLMResults';
import { isLLMResult } from '../utils/isLLMResult';
import DegradedBanner from './search/DegradedBanner';
import { postSearchRequest } from '../utils/clientApi';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { skippedNote } from '../utils/skippedNote';

// Feature 6: limit results by publication date (undated items are kept and flagged)
const DATE_FILTERS = [
  { value: '', label: 'Any time' },
  { value: '30', label: 'Past month' },
  { value: '365', label: 'Past year' },
  { value: '1095', label: 'Past 3 years' },
];

function normalizeClientError(error) {
  const axiosMessage = error?.response?.data?.error;
  if (typeof axiosMessage === 'string' && axiosMessage.trim()) {
    return axiosMessage;
  }

  const message = String(error?.message || '').trim();
  const lower = message.toLowerCase();

  if (!message) {
    return 'Search request failed. Please try again.';
  }

  if (
    lower === 'load failed' ||
    lower.includes('failed to fetch') ||
    lower.includes('network error') ||
    lower.includes('network request failed')
  ) {
    return 'Unable to reach the search API right now. Check your connection and try again.';
  }

  return message;
}

function buildClientFallbackContent(query, results) {
  const top = Array.isArray(results) ? results.slice(0, 5) : [];
  if (top.length === 0) {
    return `No synthesized summary available for "${query}".`;
  }

  const bullets = top
    .map((item, index) => {
      const title = item?.title || `Result ${index + 1}`;
      const snippet = item?.snippet || item?.content || '';
      const url = item?.url || '';
      return `${index + 1}. ${title}${snippet ? ` - ${snippet}` : ''}${url ? ` (${url})` : ''}`;
    })
    .join('\n');

  return `## Summary\nSearch returned results, but the LLM provider is unavailable. This is a free fallback synthesis based on raw results.\n\n## Top Findings\n${bullets}`;
}

export default function OpenSearch({ selectedModel, setSelectedModel }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Curated registry sources (private-company coverage, no key needed) + Web
  const [selectedSources, setSelectedSources] = useState(['Curated', 'Web']);
  const [customUrls, setCustomUrls] = useState([]);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [apiMeta, setApiMeta] = useState({ status: null, degradedSources: [], failSoftContent: null, queryPlan: null, answerInfo: null });
  const [hasSearched, setHasSearched] = useState(false);
  const resultsContainerRef = useRef(null);
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const signedIn = sessionStatus === 'authenticated';
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [maxAgeDays, setMaxAgeDays] = useState('');
  const [savedHistoryId, setSavedHistoryId] = useState(null);
  const autoRanRef = useRef(false);

  // Signed-in users can file searches under a deal workspace
  useEffect(() => {
    if (!signedIn) return;
    fetch('/api/workspaces')
      .then((r) => (r.ok ? r.json() : { workspaces: [] }))
      .then((d) => setWorkspaces(d.workspaces || []))
      .catch(() => {});
  }, [signedIn]);

  // ?q=...&workspace=... (from History "Run again", workspaces, company pages)
  useEffect(() => {
    if (!router.isReady || autoRanRef.current) return;
    const q = typeof router.query.q === 'string' ? router.query.q.trim() : '';
    if (typeof router.query.workspace === 'string') setWorkspaceId(router.query.workspace);
    if (q) {
      autoRanRef.current = true;
      setQuery(q);
      handleSearch(q, typeof router.query.workspace === 'string' ? router.query.workspace : undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  // Scroll to bottom of results when new results are loaded
  const scrollToBottom = () => {
    if (resultsContainerRef.current) {
      resultsContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  };

  useEffect(() => {
    if (query) {
      scrollToBottom();
    }
  }, [query]);

  // Start warming the curated source index so the first search is fast.
  useEffect(() => {
    fetch('/api/sources/curated').catch(() => {});
  }, []);

  const handleSourceToggle = (source) => {
    if (selectedSources.includes(source)) {
      setSelectedSources(selectedSources.filter(s => s !== source));
    } else {
      setSelectedSources([...selectedSources, source]);
    }
  };

  const handleCustomSourceAdd = (url) => {
    if (!customUrls.includes(url)) {
      setCustomUrls([...customUrls, url]);
    }
  };

  const handleFileUpload = (files) => {
    setUploadedFiles([...uploadedFiles, ...files]);
  };

  // Pin a source from the results to the selected workspace
  const saveSourceToWorkspace = async (source) => {
    const res = await fetch(`/api/workspaces/${workspaceId}/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: source.title || source.displayTitle,
        url: source.url,
        sourceName: source.sourceName || source.displayTitle || null,
        publishedAt: source.date || source.publishedAt || null,
        excerpt: String(source.snippet || source.content || '').slice(0, 1000)
      })
    });
    return res.ok;
  };

  // Company name for the profile link: the query minus funding/topic words
  const profileName = apiMeta.queryPlan?.entity || (apiMeta.queryPlan?.mode === 'topic' ? '' : String(query || '')
    .split(/\b(?:funding|raise[sd]?|round|series [a-h]|seed|valuation|investors?|revenue|competitors?|founders?|ceo|news|ipo|acquisition)\b/i)[0]
    .replace(/[^\w&.' -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80));

  const handleModelChange = (model) => {
    setSelectedModel(model);
  };

  // Follow-up search functionality temporarily disabled
  const handleFollowUpSearch = (followUpQuery) => {
    setQuery(followUpQuery);
    setHasSearched(true); // Make sure to set hasSearched to true
    handleSearch(followUpQuery);
  };

  const handleSearch = async (searchQuery = query, workspaceOverride) => {
    if (!searchQuery.trim()) return;

    setLoading(true);
    setError(null);
    setSavedHistoryId(null);
    const activeWorkspace = workspaceOverride !== undefined ? workspaceOverride : workspaceId;

    try {
      console.log('Performing search for query:', searchQuery);
      console.log('Selected sources:', selectedSources);
      console.log('Using model:', selectedModel);
      
      // Make actual API call to the search endpoint
      const data = await postSearchRequest({
        query: searchQuery,
        mode: 'open',
        model: selectedModel,
        sources: selectedSources,
        customUrls,
        files: uploadedFiles,
        useLLM: true,
        workspaceId: activeWorkspace || undefined,
        maxAgeDays: maxAgeDays || undefined
      });
      setSavedHistoryId(data?.historyId || null);
      
      setApiMeta({
        status: data?.status || null,
        degradedSources: Array.isArray(data?.degradedSources) ? data.degradedSources : [],
        failSoftContent: data?.failSoftContent || null,
        queryPlan: data?.queryPlan || null,
        answerInfo: data?.answerInfo || null,
        sourceStatuses: Array.isArray(data?.sourceStatuses) ? data.sourceStatuses : []
      });

      // Log the response for debugging
      console.log('Search API response structure:', {
        hasLLMResults: !!data.llmResults,
        hasContent: !!data.content,
        topLevelKeys: Object.keys(data).slice(0, 8),
        llmFlags: data.isLLMResults || data.isLLMResult || data.__isImmutableLLMResult
      });
      
      // Enhanced LLM detection using utility function
      console.log('Performing LLM result detection on response data');

      if (data?.errorType === 'auth_error' && Array.isArray(data?.results) && data.results.length > 0) {
        console.warn('LLM auth failed; using client-side synthesized fallback');
        setResults({
          content: buildClientFallbackContent(searchQuery, data.results),
          isLLMResult: true,
          __isImmutableLLMResult: true,
          query: searchQuery,
          metadata: { fallback: 'client-synthesizer' }
        });
        setHasSearched(true);
        return;
      }
      
      if (isLLMResult(data)) {
        console.log('✅ Successfully detected LLM-formatted results');
        
        // Determine if we should use a property or the whole object
        if (data.llmResults && isLLMResult(data.llmResults)) {
          console.log('Using nested llmResults from response');
          setResults({
            ...data.llmResults,
            __isImmutableLLMResult: true,
            isLLMResult: true,
            query: searchQuery
          });
        } else {
          // Use the whole response when it's the LLM result itself
          console.log('Using entire response as LLM result');
          setResults({
            ...data,
            __isImmutableLLMResult: true,
            isLLMResult: true,
            query: searchQuery
          });
        }
      } else if (data.content && typeof data.content === 'string') {
        // Explicitly format as LLM result when content is present
        console.log('Formatting content property as LLM result');
        setResults({
          content: data.content,
          isLLMResult: true,
          __isImmutableLLMResult: true,
          query: searchQuery
        });
      } else if (data.results) {
        // Fallback to regular results
        console.log('Using regular search results array');
        setResults(data.results);
      } else if (typeof data === 'string') {
        // Handle case where response might be a plain string
        console.log('Handling string response');
        setResults([data]);
      } else {
        // Create empty result if nothing found
        console.log('No recognizable results format');
        setResults([]);
      }
      
      setHasSearched(true);
      
    } catch (err) {
      console.error('Search error:', err.response?.data || err.message);
      setError(normalizeClientError(err));
      // Set empty results
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6">
      <div className="mb-6">
        {/* Search interface */}
        <div className="mb-4">
          <div className="flex w-full">
            <div className="flex-grow bg-gray-100 rounded-l-md border border-gray-300">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search across sources..."
                className="w-full bg-transparent border-none focus:outline-none focus:ring-0 px-4 py-2"
              />
            </div>
            <div className="flex">
              <div className="w-[150px] bg-gray-100 border-y border-r border-gray-300">
                <ModelSelector 
                  selectedModel={selectedModel} 
                  onChange={handleModelChange}
                />
              </div>
              <button
                onClick={() => handleSearch()}
                disabled={loading}
                className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-r-md disabled:opacity-50"
              >
                {loading ? 'Searching...' : 'Search'}
              </button>
            </div>
          </div>
        </div>
        
        {/* Date filter and (signed in) workspace filing */}
        <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
          <label className="flex items-center gap-2 text-gray-600">
            Published
            <select
              value={maxAgeDays}
              onChange={(e) => setMaxAgeDays(e.target.value)}
              className="border border-gray-300 rounded-md px-2 py-1 bg-white"
            >
              {DATE_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          {signedIn ? (
            <label className="flex items-center gap-2 text-gray-600">
              Save search to
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                aria-label="Save this search to a deal workspace"
                title="Deal workspace this search is filed under (not the AI model)"
                className="border border-gray-300 rounded-md px-2 py-1 bg-white"
              >
                <option value="">History only (no workspace)</option>
                {workspaces.length > 0 && (
                  <optgroup label="Deal workspaces">
                    {workspaces.map((w) => {
                      // Same-named workspaces are told apart by creation date
                      const duplicate = workspaces.filter((x) => x.name === w.name).length > 1;
                      const created = duplicate ? ` (created ${new Date(w.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : '';
                      return <option key={w.id} value={w.id}>📁 {w.name}{created}</option>;
                    })}
                  </optgroup>
                )}
              </select>
              <Link href="/workspaces" className="text-blue-600 hover:underline">
                {workspaces.length > 0 ? 'Manage workspaces' : 'New workspace'}
              </Link>
            </label>
          ) : (
            <span className="text-gray-500">
              <Link href="/signin" className="text-blue-600 hover:underline">Sign in</Link> to save searches to your history and workspaces
            </span>
          )}
          {savedHistoryId && (
            <Link href={`/history/${savedHistoryId}`} className="text-green-700 hover:underline">✓ Saved to history</Link>
          )}
          {hasSearched && profileName && (
            <span className="text-gray-600">
              <Link href={`/company/${encodeURIComponent(profileName)}`} className="text-blue-600 hover:underline">Company profile: {profileName}</Link>
              {' · '}
              <Link href={`/founder?company=${encodeURIComponent(profileName)}`} className="text-blue-600 hover:underline">Founder check</Link>
            </span>
          )}
        </div>

        {/* Source selector */}
        <SourceSelector
          mode="open"
          selectedSources={selectedSources}
          onSourceToggle={handleSourceToggle}
          onCustomSourceAdd={handleCustomSourceAdd}
          onFileUpload={handleFileUpload}
          isLoading={loading}
        />
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-10">
          <p className="text-gray-600">Searching... This may take a moment.</p>
        </div>
      ) : (
        <div ref={resultsContainerRef}>
          {hasSearched && apiMeta.degradedSources.length > 0 && (
            <DegradedBanner degradedSources={apiMeta.degradedSources} status={apiMeta.status} sourceStatuses={apiMeta.sourceStatuses} />
          )}

          {hasSearched && apiMeta.answerInfo && (
            <div className="text-xs text-gray-500 mb-2">
              {apiMeta.answerInfo.mode === 'ai'
                ? <>Answer written by <strong>{apiMeta.answerInfo.model}</strong> ({apiMeta.answerInfo.provider}) from the cited sources{apiMeta.answerInfo.confidence ? <> · Confidence: <strong>{apiMeta.answerInfo.confidence.level}</strong>{apiMeta.answerInfo.confidence.reason ? ` (${apiMeta.answerInfo.confidence.reason})` : ''}</> : null}{skippedNote(apiMeta.answerInfo.skipped)}</>
                : <>Answer quoted directly from sources ({apiMeta.answerInfo.reason || 'no AI model'}). Add a free model key (Groq, OpenRouter or Gemini) for written analysis.</>}
              {apiMeta.queryPlan?.entity && <> · About <strong>{apiMeta.queryPlan.entity}</strong>{apiMeta.queryPlan.droppedForRelevance ? ` (${apiMeta.queryPlan.droppedForRelevance} unrelated results removed)` : ''}</>}
            </div>
          )}
          {hasSearched && query && (
            <>
              <SimplifiedLLMResults 
                query={query}
                results={results}
                onFollowUpSearch={handleFollowUpSearch}
                onSaveSource={signedIn && workspaceId ? saveSourceToWorkspace : null}
              />

              {Array.isArray(results) && results.length === 0 && (
                <div className="mt-4 border rounded-md p-4 bg-amber-50 border-amber-200 text-amber-900">
                  <div className="font-semibold mb-1">No direct results yet</div>
                  <p className="text-sm mb-2">Try refining your query or enabling additional sources. The system is in fail-soft mode, so it will keep returning a safe response.</p>
                  <ul className="list-disc ml-5 text-sm">
                    {(apiMeta.failSoftContent?.exampleQueries || [
                      'AI infrastructure Series B deals 2024',
                      'SaaS ARR multiples Q4 2024',
                      'Robotics logistics startup funding'
                    ]).map((q) => <li key={q}>{q}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
