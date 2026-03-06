import React from 'react';
import { SearchInput } from './SearchInput';
import { FilterChips } from './FilterChips';
import { ExportDropdown } from './ExportDropdown';
import { SavedViews } from './SavedViews';
import { BulkActionBar } from './BulkActionBar';

export function CommandBar({ filters, total, selectedCount, onFilterChange, onClearAll }: any) {
  return (
    <div className="bg-white border rounded p-3 text-sm space-y-2">
      <div className="flex gap-2 items-center">
        <div className="flex-1"><SearchInput value={filters?.q || ''} onChange={(v) => onFilterChange('q', v)} /></div>
        <SavedViews onSelect={() => {}} />
        <ExportDropdown onExport={() => {}} />
      </div>
      <FilterChips
        filters={filters}
        onRemove={(k: string) => onFilterChange(k, undefined)}
        onClearAll={onClearAll}
      />
      <div className="flex justify-between items-center">
        <span>Total: {total?.toLocaleString?.() ?? total}</span>
      </div>
      <BulkActionBar count={selectedCount} onClear={() => onFilterChange('selected', [])} />
    </div>
  );
}
