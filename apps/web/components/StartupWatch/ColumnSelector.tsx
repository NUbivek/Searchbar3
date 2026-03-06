import React from 'react';

const DEFAULT_COLS = ['company_name', 'stage_guess', 'source_key', 'funding_total', 'confidence', 'detected_at'];

export function ColumnSelector({ columns, setColumns }: any) {
  const all = ['company_name', 'stage_guess', 'source_key', 'funding_total', 'confidence', 'detected_at', 'hq_country', 'status'];

  return (
    <details className="relative">
      <summary className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Columns</summary>
      <div className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
        <div className="mb-2 flex gap-2 text-xs">
          <button className="rounded bg-slate-100 px-2 py-1 hover:bg-slate-200" onClick={() => setColumns(DEFAULT_COLS)}>Default</button>
          <button className="rounded bg-slate-100 px-2 py-1 hover:bg-slate-200" onClick={() => setColumns(['company_name', 'funding_total', 'status'])}>Compact</button>
        </div>
        {all.map((c) => (
          <label key={c} className="block rounded px-1 py-1 text-xs text-slate-700 hover:bg-slate-50">
            <input
              type="checkbox"
              checked={columns.includes(c)}
              onChange={(e) => {
                if (e.target.checked) setColumns([...columns, c]);
                else setColumns(columns.filter((x: string) => x !== c));
              }}
              className="mr-2"
            />
            {c.replace('_', ' ')}
          </label>
        ))}
      </div>
    </details>
  );
}
