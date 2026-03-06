import React from 'react';

export function ExportDropdown({ onExport }: { onExport: (fmt: string) => void }) {
  return (
    <select className="border rounded px-2 py-2 text-sm" onChange={(e) => e.target.value && onExport(e.target.value)} defaultValue="">
      <option value="">Export…</option>
      <option value="csv-page">Current page CSV</option>
      <option value="csv-all">All results CSV</option>
      <option value="jsonl-all">All results JSONL</option>
    </select>
  );
}
