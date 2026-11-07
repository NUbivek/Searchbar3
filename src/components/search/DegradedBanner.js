import React, { useState } from 'react';

const LABELS = { web: 'Web', curated: 'Curated sources', hackernews: 'Hacker News', verified: 'Verified (SEC/FMP)', linkedin: 'LinkedIn', twitter: 'X', reddit: 'Reddit', substack: 'Substack', medium: 'Medium', crunchbase: 'Crunchbase', pitchbook: 'PitchBook', carta: 'Carta', custom: 'Your URLs', file: 'Your files', 'open-search': 'Search service' };

export default function DegradedBanner({ degradedSources = [], status, sourceStatuses = [] }) {
  const [open, setOpen] = useState(false);

  if (!Array.isArray(degradedSources) || degradedSources.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 border border-yellow-300 bg-yellow-50 rounded-md p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-yellow-900">Some sources unavailable</div>
          <div className="text-sm text-yellow-800">
            {degradedSources.map((x) => LABELS[x] || x).join(', ')} {degradedSources.length === 1 ? 'is' : 'are'} unavailable for this search. Results come from the other selected sources.
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

      {open && (
        <ul className="mt-2 list-disc ml-5 text-sm text-yellow-900">
          {degradedSources.map((source) => {
            const detail = (sourceStatuses || []).find((x) => x.source === source)?.error;
            return <li key={source}><strong>{LABELS[source] || source}</strong>{detail ? `: ${detail}` : ''}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
