import React, { useState } from 'react';

const LABELS = { web: 'Web', curated: 'Curated sources', hackernews: 'Hacker News', verified: 'Verified (SEC/FMP)', linkedin: 'LinkedIn', twitter: 'X', reddit: 'Reddit', substack: 'Substack', medium: 'Medium', crunchbase: 'Crunchbase', pitchbook: 'PitchBook', carta: 'Carta', custom: 'Your URLs', file: 'Your files', 'open-search': 'Search service' };

const NOT_CONFIGURED_NOTE = 'Web search is off (no SERPER_API_KEY/TAVILY_API_KEY); searching curated sources and Hacker News';

/**
 * Yellow banner for sources that failed; a quiet one-line note for sources
 * that are simply not configured (no web search key), which is not a failure.
 */
export default function DegradedBanner({ degradedSources = [], status, sourceStatuses = [] }) {
  const [open, setOpen] = useState(false);
  const failed = Array.isArray(degradedSources) ? degradedSources : [];
  const notConfigured = (Array.isArray(sourceStatuses) ? sourceStatuses : []).filter((s) => s && s.status === 'not_configured');

  if (failed.length === 0) {
    if (notConfigured.length === 0) return null;
    return (
      <div className="mb-2 text-xs text-gray-500" data-testid="not-configured-note">
        {notConfigured.some((s) => s.source === 'web')
          ? NOT_CONFIGURED_NOTE
          : `${notConfigured.map((s) => LABELS[s.source] || s.source).join(', ')} ${notConfigured.length === 1 ? 'is' : 'are'} not configured (no web search key); searching the other selected sources`}
      </div>
    );
  }

  return (
    <div className="mb-4 border border-yellow-300 bg-yellow-50 rounded-md p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-yellow-900">Some sources unavailable</div>
          <div className="text-sm text-yellow-800">
            {failed.map((x) => LABELS[x] || x).join(', ')} {failed.length === 1 ? 'is' : 'are'} unavailable for this search. Results come from the other selected sources.
          </div>
        </div>
        <button
          type="button"
          className="text-sm px-2 py-1 rounded border border-yellow-400 text-yellow-900 hover:bg-yellow-100"
          onClick={() => setOpen(v => !v)}
        >
          {open ? 'Hide details' : 'Show details'}
        </button>
      </div>

      {notConfigured.length > 0 && (
        <div className="mt-1 text-xs text-yellow-800">{NOT_CONFIGURED_NOTE}</div>
      )}

      {open && (
        <ul className="mt-2 list-disc ml-5 text-sm text-yellow-900">
          {failed.map((source) => {
            const detail = (sourceStatuses || []).find((x) => x.source === source)?.error;
            return <li key={source}><strong>{LABELS[source] || source}</strong>{detail ? `: ${detail}` : ''}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
