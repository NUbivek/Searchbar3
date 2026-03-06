import React from 'react';
import { SearchInput } from './SearchInput';
import { FilterChips } from './FilterChips';
import { ExportDropdown } from './ExportDropdown';
import { SavedViews } from './SavedViews';
import { BulkActionBar } from './BulkActionBar';

export function CommandBar({ filters, total, selectedCount, onFilterChange, onClearAll }: any) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[280px] flex-1">
          <SearchInput value={filters?.q || ''} onChange={(v) => onFilterChange('q', v)} />
        </div>
        <SavedViews onSelect={() => {}} />
        <ExportDropdown onExport={() => {}} />
      </div>

      <FilterChips filters={filters} onRemove={(k: string) => onFilterChange(k, undefined)} onClearAll={onClearAll} />

      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
        <div className="text-xs text-slate-500">Total signals</div>
        <div className="text-lg font-semibold tracking-tight text-slate-900">{total?.toLocaleString?.() ?? total}</div>
      </div>

      <BulkActionBar count={selectedCount} onClear={() => onFilterChange('selected', [])} />
    </div>
  );
}
