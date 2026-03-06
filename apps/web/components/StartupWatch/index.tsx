import React, { useState } from 'react';
import { CommandBar } from './CommandBar/CommandBar';
import { FiltersPanel } from './FiltersPanel';
import { SignalsTable } from './SignalsTable';
import { DetailsDrawer } from './DetailsDrawer';
import { useSignals } from '../../hooks/useSignals';
import { useSignalFilters } from '../../hooks/useSignalFilters';

export function StartupWatchTab() {
  const { filters, updateFilter, clearAllFilters } = useSignalFilters();
  const { rows, total, isLoading } = useSignals(filters);
  const [selectedSignal, setSelectedSignal] = useState<any | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  return (
    <div className='flex flex-col h-full gap-3 p-3'>
      <CommandBar filters={filters} total={total} selectedCount={selectedIds.size} onFilterChange={updateFilter} onClearAll={clearAllFilters} />
      <div className='flex flex-1 overflow-hidden gap-3'>
        <FiltersPanel filters={filters} onFilterChange={updateFilter} />
        <div className='flex-1 overflow-auto'>
          <SignalsTable rows={rows} isLoading={isLoading} onRowClick={setSelectedSignal} selectedIds={selectedIds} onSelectionChange={setSelectedIds} />
        </div>
      </div>
      {selectedSignal && <DetailsDrawer signal={selectedSignal} onClose={() => setSelectedSignal(null)} />}
    </div>
  );
}
