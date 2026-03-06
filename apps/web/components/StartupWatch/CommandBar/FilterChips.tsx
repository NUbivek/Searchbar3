import React from 'react';

export function FilterChips({ filters, onRemove, onClearAll }: any) {
  const entries = Object.entries(filters || {}).filter(([, v]) => v != null && v !== '' && (!Array.isArray(v) || v.length));
  if (!entries.length) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {entries.map(([k, v]) => {
        const label = k.replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());
        return (
          <span key={k} className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs text-blue-700">
            <span className="font-medium">{label}</span>
            <span className="mx-1">:</span>
            <span>{Array.isArray(v) ? v.join(', ') : String(v)}</span>
            <button className="ml-2 text-blue-600 hover:text-blue-900" onClick={() => onRemove(k)}>×</button>
          </span>
        );
      })}
      <button className="text-xs font-medium text-slate-500 underline hover:text-slate-700" onClick={onClearAll}>Clear all</button>
    </div>
  );
}
