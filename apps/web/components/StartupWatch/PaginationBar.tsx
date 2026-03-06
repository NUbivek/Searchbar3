import React from 'react';

export function PaginationBar({ page, pageSize, total, onPage, onSize }: any) {
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total || 0);
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  return (
    <div className="sticky bottom-0 flex items-center justify-between border-t border-slate-100 bg-white p-3 text-sm">
      <span className="text-slate-600">Showing {start}-{end} of {(total || 0).toLocaleString()} results</span>
      <div className="flex items-center gap-2">
        <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-slate-700 disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
        <span className="text-slate-500">{page}/{pages}</span>
        <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-slate-700 disabled:opacity-40" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
        <select className="rounded-lg border border-slate-200 px-2 py-1.5" value={pageSize} onChange={(e) => onSize(Number(e.target.value))}>
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
