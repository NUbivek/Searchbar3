import React from 'react';

export default function EmptyState({ activeFilterCount = 0, onReset }: { activeFilterCount?: number; onReset?: () => void }) {
  return (
    <div className="mx-4 my-8 rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 p-8 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white text-lg shadow-sm">✨</div>
      <div className="text-base font-semibold text-slate-800">{activeFilterCount ? 'No results match these filters' : 'No startup signals yet'}</div>
      <div className="mt-1 text-sm text-slate-500">
        {activeFilterCount
          ? 'Try removing one or two filters to broaden the results.'
          : 'Data source is currently empty or unavailable. Once signals ingest, they will appear here.'}
      </div>
      {activeFilterCount > 0 && (
        <button className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100" onClick={onReset}>
          Reset all filters
        </button>
      )}
    </div>
  );
}
