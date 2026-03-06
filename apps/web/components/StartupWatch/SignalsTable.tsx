import React from 'react';
export function SignalsTable({ rows = [], isLoading, onRowClick }: any) {
  if (isLoading) return <div className="p-4">Loading...</div>;
  if (!rows.length) return <div className="p-4">No results yet.</div>;
  return <table className="w-full text-sm"><thead><tr><th className="text-left">Company</th><th className="text-left">Stage</th><th className="text-left">Source</th></tr></thead><tbody>{rows.map((r: any) => <tr key={r.id} className="border-t cursor-pointer" onClick={() => onRowClick(r)}><td>{r.company_name}</td><td>{r.stage_guess}</td><td>{r.source_key}</td></tr>)}</tbody></table>;
}
