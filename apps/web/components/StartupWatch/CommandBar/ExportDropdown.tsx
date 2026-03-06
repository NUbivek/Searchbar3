import React from 'react';

export function ExportDropdown({ onExport }: { onExport: (fmt: string) => void }) {
  return (
    <select
      className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 shadow-sm outline-none ring-blue-500/40 focus:ring"
      onChange={(e) => e.target.value && onExport(e.target.value)}
      defaultValue=""
    >
      <option value="">Export…</option>
      <option value="csv-page">Current page CSV</option>
      <option value="csv-all">All results CSV</option>
      <option value="jsonl-all">All results JSONL</option>
    </select>
  );
}
