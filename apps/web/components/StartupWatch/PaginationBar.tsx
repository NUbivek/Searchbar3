import React from 'react';

export function PaginationBar({ page, pageSize, total, onPage, onSize }: any) {
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total || 0);
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  return (
    <div className="sticky bottom-0 bg-white border-t p-2 flex items-center justify-between text-sm">
      <span>Showing {start}-{end} of {(total || 0).toLocaleString()} results</span>
      <div className="flex items-center gap-2">
        <button className="px-2 py-1 border rounded" disabled={page<=1} onClick={() => onPage(page - 1)}>Prev</button>
        <span>{page}/{pages}</span>
        <button className="px-2 py-1 border rounded" disabled={page>=pages} onClick={() => onPage(page + 1)}>Next</button>
        <select className="border rounded px-1 py-1" value={pageSize} onChange={(e) => onSize(Number(e.target.value))}>
          {[25,50,100,200].map((n)=><option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </div>
  );
}
