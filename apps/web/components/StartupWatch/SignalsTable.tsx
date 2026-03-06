import React from 'react';
import SkeletonRow from './Cells/SkeletonRow';
import EmptyState from './Cells/EmptyState';
import StageBadge from './Cells/StageBadge';
import SourceBadge from './Cells/SourceBadge';
import ConfidenceBar from './Cells/ConfidenceBar';
import CompanyCell from './Cells/CompanyCell';
import FlagToggle from './Cells/FlagToggle';
import StatusBadge from './Cells/StatusBadge';
import { PaginationBar } from './PaginationBar';
import { ColumnSelector } from './ColumnSelector';

export function SignalsTable({
  rows = [],
  isLoading,
  onRowClick,
  selectedIds,
  onSelectionChange,
  total = 0,
  page = 1,
  pageSize = 50,
  onPageChange = () => {},
  onPageSizeChange = () => {},
}: any) {
  const [columns, setColumns] = React.useState(['company_name', 'stage_guess', 'source_key', 'funding_total', 'confidence', 'detected_at', 'status']);

  const toggleRow = (id: string) => {
    const next = new Set(selectedIds || []);
    next.has(id) ? next.delete(id) : next.add(id);
    onSelectionChange(next);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Signals</div>
        <ColumnSelector columns={columns} setColumns={setColumns} />
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 border-b bg-white">
            <tr className="text-xs uppercase tracking-wide text-slate-500">
              <th className="w-10 p-3 text-left">✓</th>
              <th className="w-10 p-3 text-left">★</th>
              {columns.includes('company_name') && <th className="p-3 text-left">Company</th>}
              {columns.includes('stage_guess') && <th className="p-3 text-left">Stage</th>}
              {columns.includes('source_key') && <th className="p-3 text-left">Source</th>}
              {columns.includes('funding_total') && <th className="p-3 text-left">Funding</th>}
              {columns.includes('confidence') && <th className="p-3 text-left">Confidence</th>}
              {columns.includes('detected_at') && <th className="p-3 text-left">Detected</th>}
              {columns.includes('status') && <th className="p-3 text-left">Status</th>}
            </tr>
          </thead>
          <tbody>
            {isLoading && Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} columnCount={8} />)}
            {!isLoading && !rows.length && (
              <tr>
                <td colSpan={12}>
                  <EmptyState activeFilterCount={0} />
                </td>
              </tr>
            )}
            {!isLoading &&
              rows.map((r: any) => (
                <tr key={r.id} className="border-t border-slate-100 transition odd:bg-white even:bg-slate-50/40 hover:bg-blue-50/50">
                  <td className="p-3">
                    <input type="checkbox" checked={(selectedIds || new Set()).has(r.id)} onChange={() => toggleRow(r.id)} />
                  </td>
                  <td className="p-3">
                    <FlagToggle flagged={!!r.flagged} />
                  </td>
                  {columns.includes('company_name') && (
                    <td className="cursor-pointer p-3 font-medium text-slate-800" onClick={() => onRowClick(r)}>
                      <CompanyCell name={r.company_name} domain={r.company_domain} />
                    </td>
                  )}
                  {columns.includes('stage_guess') && (
                    <td className="p-3">
                      <StageBadge stage={r.stage_guess || 'unknown'} />
                    </td>
                  )}
                  {columns.includes('source_key') && (
                    <td className="p-3">
                      <SourceBadge sourceKey={r.source_key} tier={r.source_tier || 7} />
                    </td>
                  )}
                  {columns.includes('funding_total') && <td className="p-3 text-slate-700">{r.funding_total ? `$${Number(r.funding_total).toLocaleString()}` : '—'}</td>}
                  {columns.includes('confidence') && (
                    <td className="p-3">
                      <ConfidenceBar confidence={Number(r.confidence || 0)} />
                    </td>
                  )}
                  {columns.includes('detected_at') && <td className="p-3 text-slate-600">{r.detected_at ? new Date(r.detected_at).toLocaleDateString() : '—'}</td>}
                  {columns.includes('status') && (
                    <td className="p-3">
                      <StatusBadge status={r.status || 'new'} />
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <PaginationBar page={page} pageSize={pageSize} total={total} onPage={onPageChange} onSize={onPageSizeChange} />
    </div>
  );
}
