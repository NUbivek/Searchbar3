import React, { useState } from 'react';
import { HiOutlineExclamationTriangle } from 'react-icons/hi2';

const LABELS = { web: 'Web', curated: 'Curated sources', hackernews: 'Hacker News', verified: 'Verified (SEC/FMP)', linkedin: 'LinkedIn', twitter: 'X', reddit: 'Reddit', substack: 'Substack', medium: 'Medium', crunchbase: 'Crunchbase', pitchbook: 'PitchBook', carta: 'Carta', custom: 'Your URLs', file: 'Your files', 'open-search': 'Search service' };

const NOT_CONFIGURED_NOTE = 'Web search is not enabled on this deployment; showing curated sources and Hacker News';

/**
 * Amber banner for sources that failed; a quiet one-line note for sources
 * that are simply not enabled on this deployment, which is not a failure.
 */
export default function DegradedBanner({ degradedSources = [], status, sourceStatuses = [] }) {
  const [open, setOpen] = useState(false);
  const failed = Array.isArray(degradedSources) ? degradedSources : [];
  const notConfigured = (Array.isArray(sourceStatuses) ? sourceStatuses : []).filter((s) => s && s.status === 'not_configured');

  if (failed.length === 0) {
    if (notConfigured.length === 0) return null;
    return (
      <div className="mb-3 text-xs text-muted" data-testid="not-configured-note">
        {notConfigured.some((s) => s.source === 'web')
          ? NOT_CONFIGURED_NOTE
          : `${notConfigured.map((s) => LABELS[s.source] || s.source).join(', ')} ${notConfigured.length === 1 ? 'is' : 'are'} not enabled on this deployment; searching the other selected sources`}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 animate-fadeIn">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <HiOutlineExclamationTriangle className="mt-0.5 shrink-0 text-amber-600" style={{ width: 17, height: 17 }} />
          <div>
            <div className="text-sm font-semibold text-amber-900">Some sources unavailable</div>
            <div className="mt-0.5 text-sm">
              {failed.map((x) => LABELS[x] || x).join(', ')} {failed.length === 1 ? 'is' : 'are'} unavailable for this search. Results come from the other selected sources.
            </div>
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium text-amber-900 transition hover:bg-amber-100"
          onClick={() => setOpen(v => !v)}
        >
          {open ? 'Hide details' : 'Show details'}
        </button>
      </div>

      {notConfigured.length > 0 && (
        <div className="mt-2 pl-7 text-xs text-amber-800/80">{NOT_CONFIGURED_NOTE}</div>
      )}

      {open && (
        <ul className="mt-2 list-disc pl-11 text-sm text-amber-900">
          {failed.map((source) => {
            const detail = (sourceStatuses || []).find((x) => x.source === source)?.error;
            return <li key={source}><strong>{LABELS[source] || source}</strong>{detail ? `: ${detail}` : ''}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
