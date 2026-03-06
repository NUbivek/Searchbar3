import React, { useState } from 'react';
import { useRouter } from 'next/router';
import { CommandBar } from './CommandBar/CommandBar';
import { FiltersPanel } from './FiltersPanel';
import { SignalsTable } from './SignalsTable';
import { DetailsDrawer } from './DetailsDrawer';
import { useSignals } from '../../hooks/useSignals';
import { useSignalFilters } from '../../hooks/useSignalFilters';

export function StartupWatchTab() {
  const router = useRouter();
  const { filters, updateFilter, clearAllFilters, activeFilterCount } = useSignalFilters();
  const { rows, total, isLoading, page, page_size, meta } = useSignals(filters);
  const [selectedSignal, setSelectedSignal] = useState<any | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const onRowClick = (signal: any) => {
    setSelectedSignal(signal);
    router.replace({ pathname: router.pathname, query: { ...router.query, signal: signal.id } }, undefined, { shallow: true });
  };

  const onCloseDrawer = () => {
    setSelectedSignal(null);
    const q = { ...router.query } as any;
    delete q.signal;
    router.replace({ pathname: router.pathname, query: q }, undefined, { shallow: true });
  };

  return (
    <div className="flex h-full flex-col gap-3 rounded-2xl border border-slate-200 bg-white/70 p-3 shadow-sm backdrop-blur">
      <CommandBar
        filters={filters}
        total={total}
        selectedCount={selectedIds.size}
        onFilterChange={updateFilter}
        onClearAll={clearAllFilters}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><div className="text-xs text-slate-500">Results</div><div className="text-xl font-semibold text-slate-900">{total.toLocaleString()}</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><div className="text-xs text-slate-500">Visible Rows</div><div className="text-xl font-semibold text-slate-900">{rows.length}</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><div className="text-xs text-slate-500">Active Filters</div><div className="text-xl font-semibold text-slate-900">{activeFilterCount}</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><div className="text-xs text-slate-500">Data Mode</div><div className="text-xl font-semibold text-slate-900">{meta?.mode || 'live'}</div></div>
      </div>
      <div className="flex flex-1 gap-3 overflow-hidden">
        <FiltersPanel filters={filters} onFilterChange={updateFilter} />
        <div className="flex-1 overflow-auto">
          <SignalsTable
            rows={rows}
            total={total}
            isLoading={isLoading}
            page={page}
            pageSize={page_size}
            onPageChange={(p: number) => updateFilter('page', p)}
            onPageSizeChange={(s: number) => updateFilter('page_size', s)}
            onRowClick={onRowClick}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />
        </div>
      </div>
      {selectedSignal && <DetailsDrawer signal={selectedSignal} onClose={onCloseDrawer} />}
    </div>
  );
}
