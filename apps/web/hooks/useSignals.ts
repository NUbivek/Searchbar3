import useSWR from 'swr';
import { useMemo } from 'react';
import type { FilterState } from '../types/startup-watch';

const fetcher = async (url: string) => {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  if (!res.ok) throw new Error('Failed to fetch signals');
  return res.json();
};

export function useSignals(filters: FilterState) {
  const url = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters || {}).forEach(([k, v]) => {
      if (v == null || v === '') return;
      if (Array.isArray(v)) v.forEach((item) => params.append(k, String(item)));
      else params.set(k, String(v));
    });
    return `/api/startup-watch/signals?${params.toString()}`;
  }, [filters]);

  const { data, error, isLoading } = useSWR(url, fetcher, { revalidateOnFocus: false });
  return {
    rows: data?.rows || [],
    total: data?.total || 0,
    meta: data?.meta || null,
    isLoading,
    isError: Boolean(error),
  };
}
