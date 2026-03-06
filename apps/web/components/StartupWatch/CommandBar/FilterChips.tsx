import React from 'react';

export function FilterChips({ filters, onRemove, onClearAll }: any) {
  const entries = Object.entries(filters || {}).filter(([,v]) => v != null && v !== '' && (!Array.isArray(v) || v.length));
  if (!entries.length) return null;
  return (
    <div className="flex gap-2 overflow-x-auto py-2">
      {entries.map(([k,v]) => (
        <span key={k} className="text-xs bg-blue-50 border border-blue-200 text-blue-700 rounded-full px-2 py-1 whitespace-nowrap">
          {k}: {Array.isArray(v) ? v.join(',') : String(v)}
          <button className="ml-2" onClick={() => onRemove(k)}>×</button>
        </span>
      ))}
      <button className="text-xs underline" onClick={onClearAll}>Clear all</button>
    </div>
  );
}
