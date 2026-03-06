import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import type { FilterState } from '../types/startup-watch';

export function useSignalFilters() {
  const router = useRouter();
  const initial = useMemo(() => ({ ...router.query } as FilterState), [router.query]);
  const [filters, setFilters] = useState<FilterState>(initial);

  const updateFilter = (key: keyof FilterState, value: any) => {
    const next = { ...filters, [key]: value };
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) delete (next as any)[key];
    setFilters(next);
    router.replace({ pathname: router.pathname, query: next as any }, undefined, { shallow: true });
  };

  const clearAllFilters = () => {
    setFilters({});
    router.replace({ pathname: router.pathname, query: {} }, undefined, { shallow: true });
  };

  const activeFilterCount = Object.keys(filters || {}).length;
  return { filters, updateFilter, clearAllFilters, activeFilterCount };
}
