import React from 'react';

const DEFAULT_COLS = ['company_name','stage_guess','source_key','funding_total','confidence','detected_at'];

export function ColumnSelector({ columns, setColumns }: any) {
  const all = ['company_name','stage_guess','source_key','funding_total','confidence','detected_at','hq_country','status'];
  return (
    <details className="relative">
      <summary className="cursor-pointer px-2 py-1 border rounded text-sm">⚙ Columns</summary>
      <div className="absolute right-0 mt-1 bg-white border rounded shadow p-3 z-30 w-56">
        <div className="flex gap-2 mb-2 text-xs">
          <button className="underline" onClick={() => setColumns(DEFAULT_COLS)}>Default View</button>
          <button className="underline" onClick={() => setColumns(['company_name','funding_total','investors','headcount'])}>Enrichment View</button>
        </div>
        {all.map((c) => (
          <label key={c} className="block text-xs"><input type="checkbox" checked={columns.includes(c)} onChange={(e) => {
            if (e.target.checked) setColumns([...columns, c]); else setColumns(columns.filter((x: string) => x !== c));
          }} /> {c}</label>
        ))}
      </div>
    </details>
  );
}
