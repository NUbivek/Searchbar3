import React, { useState } from 'react';

export default function DegradedBanner({ degradedSources = [], status }) {
  const [open, setOpen] = useState(false);

  if (!Array.isArray(degradedSources) || degradedSources.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 border border-yellow-300 bg-yellow-50 rounded-md p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-yellow-900">Degraded mode active</div>
          <div className="text-sm text-yellow-800">
            Some providers are unavailable right now. Results will still render with available sources.
            {status ? ` (status: ${status})` : ''}
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
          {degradedSources.map((source) => (
            <li key={source}>{source}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
