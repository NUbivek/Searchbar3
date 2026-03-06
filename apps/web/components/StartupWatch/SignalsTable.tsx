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

export function SignalsTable({ rows = [], isLoading, onRowClick, selectedIds, onSelectionChange, total = 0, page = 1, pageSize = 50, onPageChange = () => {}, onPageSizeChange = () => {} }: any) {
  const [columns, setColumns] = React.useState(['company_name','stage_guess','source_key','funding_total','confidence','detected_at','status']);

  const toggleRow = (id: string) => {
    const next = new Set(selectedIds || []);
    next.has(id) ? next.delete(id) : next.add(id);
    onSelectionChange(next);
  };

  return (
    <div className="border rounded bg-white overflow-hidden h-full flex flex-col">
      <div className="p-2 border-b flex justify-end"><ColumnSelector columns={columns} setColumns={setColumns} /></div>
      <div className="overflow-auto flex-1">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50 border-b z-10">
            <tr>
              <th className="p-2 text-left w-10">✓</th>
              <th className="p-2 text-left w-10">★</th>
              {columns.includes('company_name') && <th className="p-2 text-left">Company</th>}
              {columns.includes('stage_guess') && <th className="p-2 text-left">Stage</th>}
              {columns.includes('source_key') && <th className="p-2 text-left">Source</th>}
              {columns.includes('funding_total') && <th className="p-2 text-left">Funding</th>}
              {columns.includes('confidence') && <th className="p-2 text-left">Confidence</th>}
              {columns.includes('detected_at') && <th className="p-2 text-left">Detected</th>}
              {columns.includes('status') && <th className="p-2 text-left">Status</th>}
            </tr>
          </thead>
          <tbody>
            {isLoading && Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} columnCount={8} />)}
            {!isLoading && !rows.length && (
              <tr><td colSpan={12}><EmptyState activeFilterCount={0} /></td></tr>
            )}
            {!isLoading && rows.map((r: any) => (
              <tr key={r.id} className="border-t hover:bg-gray-50">
                <td className="p-2"><input type="checkbox" checked={(selectedIds || new Set()).has(r.id)} onChange={() => toggleRow(r.id)} /></td>
                <td className="p-2"><FlagToggle flagged={!!r.flagged} /></td>
                {columns.includes('company_name') && <td className="p-2 cursor-pointer" onClick={() => onRowClick(r)}><CompanyCell name={r.company_name} domain={r.company_domain} /></td>}
                {columns.includes('stage_guess') && <td className="p-2"><StageBadge stage={r.stage_guess || 'unknown'} /></td>}
                {columns.includes('source_key') && <td className="p-2"><SourceBadge sourceKey={r.source_key} tier={r.source_tier || 7} /></td>}
                {columns.includes('funding_total') && <td className="p-2">{r.funding_total ? `$${Number(r.funding_total).toLocaleString()}` : '—'}</td>}
                {columns.includes('confidence') && <td className="p-2"><ConfidenceBar confidence={Number(r.confidence || 0)} /></td>}
                {columns.includes('detected_at') && <td className="p-2">{r.detected_at ? new Date(r.detected_at).toLocaleDateString() : '—'}</td>}
                {columns.includes('status') && <td className="p-2"><StatusBadge status={r.status || 'new'} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationBar page={page} pageSize={pageSize} total={total} onPage={onPageChange} onSize={onPageSizeChange} />
    </div>
  );
}
