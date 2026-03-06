import React, { useState } from 'react';
import { useRouter } from 'next/router';
import { CommandBar } from './CommandBar/CommandBar';
import { FiltersPanel } from './FiltersPanel';
import { SignalsTable } from './SignalsTable';
import { DetailsDrawer } from './DetailsDrawer';
import { useSignals } from '../../hooks/useSignals';
import { useSignalFilters } from '../../hooks/useSignalFilters';

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

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
    <div className="flex h-full flex-col gap-3 rounded-2xl border border-slate-200 bg-white/80 p-3 shadow-sm backdrop-blur">
      <CommandBar
        filters={filters}
        total={total}
        selectedCount={selectedIds.size}
        onFilterChange={updateFilter}
        onClearAll={clearAllFilters}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Results" value={total.toLocaleString()} />
        <StatCard label="Visible Rows" value={rows.length} />
        <StatCard label="Active Filters" value={activeFilterCount} />
        <StatCard label="Data Mode" value={meta?.mode || 'live'} />
      </div>

      {rows.length > 0 && (
        <div className="grid gap-3 md:grid-cols-3">
          {rows.slice(0, 3).map((r: any) => (
            <button
              key={`spotlight-${r.id}`}
              onClick={() => onRowClick(r)}
              className="rounded-xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow"
            >
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Spotlight</div>
              <div className="mt-1 text-base font-semibold text-slate-900">{r.company_name}</div>
              <div className="text-xs text-slate-500">{r.company_domain}</div>
              <div className="mt-2 line-clamp-2 text-sm text-slate-700">{r.summary || 'No summary available.'}</div>
              <div className="mt-3 flex items-center justify-between text-xs">
                <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-700">{r.stage_guess}</span>
                <span className="text-slate-500">{r.source_key}</span>
              </div>
            </button>
          ))}
        </div>
      )}

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
