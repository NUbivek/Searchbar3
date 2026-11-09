import React, { useState, useRef, useEffect } from 'react';
import { HiOutlineSparkles, HiOutlineMagnifyingGlass, HiOutlineCheckCircle, HiOutlineBuildingOffice2, HiOutlineUserCircle, HiOutlineExclamationCircle } from 'react-icons/hi2';
import NetworkHelpers from './network/NetworkHelpers';
import { tavusMark } from './tavus/debug';
import { sectorKeywordsFrom } from '../utils/network/sectors';
import SourceSelector from './SourceSelector';
import SimplifiedLLMResults, { FollowUpChat } from './search/results/SimplifiedLLMResults';
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

// Progress line shown while a search runs (no bare spinner)
const PROGRESS_STEPS = ['Reading sources…', 'Writing the answer…'];
const CONFIDENCE_CHIP = { high: 'chip-good', medium: 'chip-warn', low: 'chip-bad' };

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
    return 'Unable to reach the search service right now. Check your connection and try again.';
  }

  return message;
}

/** Skeleton of the answer card with a progress line that advances. */
function AnswerSkeleton({ step }) {
  return (
    <div className="ai-card animate-fadeIn" aria-busy="true" aria-live="polite">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <HiOutlineSparkles className="animate-glow text-brand-500" style={{ width: 16, height: 16 }} />
          <span>{PROGRESS_STEPS[step] || PROGRESS_STEPS[0]}</span>
        </div>
        <div className="skeleton h-5 w-20" />
      </div>
      <div className="px-5 py-5">
        <div className="skeleton mb-3 h-3 w-24" />
        <div className="skeleton mb-2 h-4 w-full" />
        <div className="skeleton mb-2 h-4 w-11/12" />
        <div className="skeleton mb-5 h-4 w-4/5" />
        <div className="skeleton mb-3 h-3 w-28" />
        <div className="skeleton mb-2 h-4 w-10/12" />
        <div className="skeleton mb-2 h-4 w-9/12" />
        <div className="skeleton h-4 w-7/12" />
      </div>
    </div>
  );
}

export default function OpenSearch({ selectedModel, setSelectedModel }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [error, setError] = useState(null);
  // Curated registry sources (private-company coverage) + Web
  const [selectedSources, setSelectedSources] = useState(['Curated', 'Web']);
  const [customUrls, setCustomUrls] = useState([]);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [apiMeta, setApiMeta] = useState({ status: null, degradedSources: [], failSoftContent: null, queryPlan: null, answerInfo: null, sourceStatuses: [], olderThanFilter: 0 });
  const [hasSearched, setHasSearched] = useState(false);
  const resultsContainerRef = useRef(null);
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const signedIn = sessionStatus === 'authenticated';
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [maxAgeDays, setMaxAgeDays] = useState('');
  const [savedHistoryId, setSavedHistoryId] = useState(null);
  const autoRanRef = useRef('');

  // Signed-in users can file searches under a deal workspace
  useEffect(() => {
    if (!signedIn) return;
    fetch('/api/workspaces')
      .then((r) => (r.ok ? r.json() : { workspaces: [] }))
      .then((d) => setWorkspaces(d.workspaces || []))
      .catch(() => {});
  }, [signedIn]);

  // ?q=...&workspace=... (from History "Run again", workspaces, company pages,
  // and the guide agent's run_research tool). Each new q runs once; a q this
  // page wrote itself after a typed search (see handleSearch) does not rerun.
  useEffect(() => {
    if (!router.isReady) return;
    const q = typeof router.query.q === 'string' ? router.query.q.trim() : '';
    if (typeof router.query.workspace === 'string') setWorkspaceId(router.query.workspace);
    if (q && q !== autoRanRef.current) {
      autoRanRef.current = q;
      setQuery(q);
      handleSearch(q, typeof router.query.workspace === 'string' ? router.query.workspace : undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.q]);

  // Scroll to the results when a search completes (not while typing)
  useEffect(() => {
    if (hasSearched && !loading && resultsContainerRef.current && typeof resultsContainerRef.current.scrollIntoView === 'function') {
      resultsContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [results, hasSearched, loading]);

  // Start warming the curated source index so the first search is fast.
  useEffect(() => {
    fetch('/api/sources/curated').catch(() => {});
  }, []);

  // Advance the progress line while a search runs
  useEffect(() => {
    if (!loading) { setLoadingStep(0); return undefined; }
    const timer = setTimeout(() => setLoadingStep(1), 3500);
    return () => clearTimeout(timer);
  }, [loading]);

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

  const handleFollowUpSearch = (followUpQuery) => {
    setQuery(followUpQuery);
    setHasSearched(true); // Make sure to set hasSearched to true
    handleSearch(followUpQuery);
  };

  const handleSearch = async (searchQuery = query, workspaceOverride, maxAgeOverride) => {
    if (!searchQuery.trim()) return;
    // Keep the current query in the URL (no reload): shareable, and it is how
    // the guide agent learns what the visitor is researching.
    const trimmed = searchQuery.trim();
    if (router.isReady && router.query?.q !== trimmed && typeof router.replace === 'function') {
      autoRanRef.current = trimmed;
      router.replace({ pathname: router.pathname, query: { ...router.query, q: trimmed } }, undefined, { shallow: true, scroll: false });
    }

    setLoading(true);
    setError(null);
    setSavedHistoryId(null);
    const activeWorkspace = workspaceOverride !== undefined ? workspaceOverride : workspaceId;
    const activeMaxAge = maxAgeOverride !== undefined ? maxAgeOverride : maxAgeDays;

    tavusMark('backend start', { kind: 'research', query: searchQuery.slice(0, 80) });
    try {
      const data = await postSearchRequest({
        query: searchQuery,
        mode: 'open',
        model: selectedModel,
        sources: selectedSources,
        customUrls,
        files: uploadedFiles,
        useLLM: true,
        workspaceId: activeWorkspace || undefined,
        maxAgeDays: activeMaxAge || undefined
      });
      tavusMark('backend end', { kind: 'research', ok: true });
      setSavedHistoryId(data?.historyId || null);

      setApiMeta({
        status: data?.status || null,
        degradedSources: Array.isArray(data?.degradedSources) ? data.degradedSources : [],
        failSoftContent: data?.failSoftContent || null,
        queryPlan: data?.queryPlan || null,
        answerInfo: data?.answerInfo || null,
        sourceStatuses: Array.isArray(data?.sourceStatuses) ? data.sourceStatuses : [],
        olderThanFilter: Number(data?.olderThanFilter) || 0
      });

      // Response contract (/api/search/open): an answer is a string in
      // `content` with the ranked `results`; a fail-soft response has no
      // answer (content null, results []). Never render the raw payload.
      const hasAnswer = typeof data?.content === 'string' && data.content.trim().length > 0;
      if (data?.status === 'fail-soft' || !hasAnswer) {
        if (data?.error) setError(typeof data.message === 'string' && data.message ? data.message : String(data.error));
        setResults([]);
      } else {
        setResults({
          ...data,
          __isImmutableLLMResult: true,
          isLLMResult: true,
          query: searchQuery
        });
      }

      setHasSearched(true);
    } catch (err) {
      setError(normalizeClientError(err));
      setResults([]);
      setHasSearched(true);
    } finally {
      setLoading(false);
    }
  };

  // Changing the date filter re-runs the current search
  const handleMaxAgeChange = (value) => {
    setMaxAgeDays(value);
    if (hasSearched && query.trim()) handleSearch(query, undefined, value);
  };

  const hasAnswer = Boolean(results && !Array.isArray(results) && typeof results.content === 'string');
  const webNotConfigured = (apiMeta.sourceStatuses || []).some((s) => s.status === 'not_configured');
  const answerInfo = apiMeta.answerInfo;
  const confidenceLevel = answerInfo?.confidence?.level ? String(answerInfo.confidence.level).toLowerCase() : null;
  const skipped = answerInfo ? skippedNote(answerInfo.skipped).replace(/^\s*·\s*/, '') : '';
  const quotedReason = answerInfo?.mode !== 'ai' && answerInfo?.reason && !/No AI model/i.test(answerInfo.reason) ? answerInfo.reason : '';

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6">
      <div className="mb-6">
        {/* Search box */}
        <div className="card card-pad animate-fadeIn">
          <div className="flex flex-col gap-2 md:flex-row">
            <div className="relative flex-1">
              <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink" style={{ width: 18, height: 18 }} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Ask about a company, founder or market…"
                aria-label="Research question"
                className="input-hero pl-11 pr-4"
              />
            </div>
            <button
              type="button"
              onClick={() => handleSearch()}
              disabled={loading}
              className="btn-primary px-5 py-3 md:w-auto"
            >
              <HiOutlineSparkles style={{ width: 16, height: 16 }} />
              {loading ? 'Searching…' : 'Search'}
            </button>
          </div>

          {/* Model, date filter and (signed in) workspace filing: quiet, one line */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
            <label className="flex items-center gap-1.5 whitespace-nowrap">
              Published
              <select
                value={maxAgeDays}
                onChange={(e) => handleMaxAgeChange(e.target.value)}
                className="select-quiet"
              >
                {DATE_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            {signedIn ? (
              <label className="flex items-center gap-1.5 whitespace-nowrap">
                Save to
                <select
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  aria-label="Save this search to a deal workspace"
                  title="Deal workspace this search is filed under (not the AI model)"
                  className="select-quiet max-w-[220px]"
                >
                  <option value="">History only</option>
                  {workspaces.length > 0 && (
                    <optgroup label="Deal workspaces">
                      {workspaces.map((w) => {
                        // Same-named workspaces are told apart by creation date
                        const duplicate = workspaces.filter((x) => x.name === w.name).length > 1;
                        const created = duplicate ? ` (created ${new Date(w.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : '';
                        return <option key={w.id} value={w.id}>{w.name}{created}</option>;
                      })}
                    </optgroup>
                  )}
                </select>
                <span className="mx-0.5 select-none text-line" aria-hidden="true">|</span>
                <Link href="/workspaces" className="whitespace-nowrap font-medium text-slate-700 hover:text-ink hover:underline">
                  {workspaces.length > 0 ? 'Manage workspaces' : 'Add new workspace'}
                </Link>
              </label>
            ) : null}
            {savedHistoryId && (
              <Link href={`/history/${savedHistoryId}`} className="chip chip-good">
                <HiOutlineCheckCircle style={{ width: 13, height: 13 }} />
                Saved to history
              </Link>
            )}
            {hasSearched && profileName && (
              <span className="flex flex-wrap items-center gap-1">
                <Link href={`/company/${encodeURIComponent(profileName)}`} className="btn-ghost">
                  <HiOutlineBuildingOffice2 style={{ width: 15, height: 15 }} />
                  Company profile: {profileName}
                </Link>
                <Link href={`/founder?company=${encodeURIComponent(profileName)}`} className="btn-ghost">
                  <HiOutlineUserCircle style={{ width: 15, height: 15 }} />
                  Founder check
                </Link>
              </span>
            )}
          </div>

          {/* Source selector */}
          <div className="mt-3 border-t border-line pt-3">
            <SourceSelector
              mode="open"
              selectedSources={selectedSources}
              onSourceToggle={handleSourceToggle}
              onSelectAll={(next) => setSelectedSources(next)}
              onCustomSourceAdd={handleCustomSourceAdd}
              onFileUpload={handleFileUpload}
              isLoading={loading}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 animate-fadeIn" role="alert">
          <HiOutlineExclamationCircle className="mt-0.5 shrink-0" style={{ width: 17, height: 17 }} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <AnswerSkeleton step={loadingStep} />
      ) : (
        <div ref={resultsContainerRef}>
          {hasSearched && (apiMeta.degradedSources.length > 0 || webNotConfigured) && (
            <DegradedBanner degradedSources={apiMeta.degradedSources} status={apiMeta.status} sourceStatuses={apiMeta.sourceStatuses} />
          )}

          {hasSearched && hasAnswer && answerInfo && (
            <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted animate-fadeIn">
              {answerInfo.mode === 'ai' ? (
                <span className="ai-badge" title={`Answer written by ${answerInfo.model} (${answerInfo.provider}) from the cited sources`}>
                  <HiOutlineSparkles style={{ width: 13, height: 13 }} />
                  AI
                  <span className="font-medium opacity-90">· {answerInfo.model}</span>
                </span>
              ) : (
                <span className="chip" title={quotedReason || 'Every statement is quoted from a cited source'}>
                  <HiOutlineSparkles className="text-brand-500" style={{ width: 13, height: 13 }} />
                  Quoted from sources
                </span>
              )}
              {answerInfo.mode === 'ai' && answerInfo.confidence && (
                <span className={`chip ${CONFIDENCE_CHIP[confidenceLevel] || ''}`} title={answerInfo.confidence.reason || undefined}>
                  Confidence: {answerInfo.confidence.level}
                </span>
              )}
              {quotedReason && <span>{quotedReason}</span>}
              {skipped && <span>{skipped}</span>}
              {answerInfo.modelNote && <span>{answerInfo.modelNote}</span>}
              {apiMeta.queryPlan?.entity && (
                <span>
                  About <strong className="font-medium text-ink">{apiMeta.queryPlan.entity}</strong>
                  {apiMeta.queryPlan.confidence === 'low' ? ' (low confidence: no source clearly matches this name and your question)' : ''}
                  {apiMeta.queryPlan.droppedForRelevance ? ` · ${apiMeta.queryPlan.droppedForRelevance} unrelated results removed` : ''}
                </span>
              )}
              {apiMeta.olderThanFilter > 0 && <span>{apiMeta.olderThanFilter} result{apiMeta.olderThanFilter === 1 ? ' was' : 's were'} older than the filter</span>}
            </div>
          )}
          {hasSearched && query && profileName && apiMeta.queryPlan?.mode !== 'topic' && (
            <div className="mb-4">
              <NetworkHelpers
                company={profileName}
                keywords={sectorKeywordsFrom(`${query} ${hasAnswer ? String(results.content).slice(0, 4000) : ''}`)}
                title={`Your network and ${profileName}`}
              />
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
                <div className="card card-pad mt-4 animate-fadeIn">
                  <div className="flex items-start gap-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                      <HiOutlineMagnifyingGlass style={{ width: 18, height: 18 }} />
                    </div>
                    <div className="min-w-0">
                      <div className="section-title">No direct results yet</div>
                      <p className="muted mt-1">
                        {apiMeta.failSoftContent?.message || 'No source returned results for this search.'}
                        {apiMeta.olderThanFilter > 0 && !/older than the filter/.test(apiMeta.failSoftContent?.message || '') ? ` ${apiMeta.olderThanFilter} result${apiMeta.olderThanFilter === 1 ? ' was' : 's were'} older than the filter.` : ''}
                      </p>
                      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink">
                        {(Array.isArray(apiMeta.failSoftContent?.suggestions) && apiMeta.failSoftContent.suggestions.length > 0
                          ? apiMeta.failSoftContent.suggestions
                          : ['Check the spelling of the company or person', 'Try fewer words, e.g. just the company name', 'Enable more sources']
                        ).map((q) => <li key={q}>{q}</li>)}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
