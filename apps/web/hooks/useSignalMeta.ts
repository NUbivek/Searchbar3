import { useState } from 'react';
import type { SignalMeta } from '../types/startup-watch';

export function useSignalMeta() {
  const [cache, setCache] = useState<Record<string, SignalMeta>>({});

  const updateMeta = async (signalId: string, changes: Partial<SignalMeta>) => {
    const prev = cache[signalId];
    setCache((c) => ({ ...c, [signalId]: { ...(c[signalId] || { status: 'new', flagged: false }), ...changes } as SignalMeta }));
    try {
      const res = await fetch(`/api/startup-watch/meta/${signalId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      });
      if (!res.ok) throw new Error('Meta update failed');
    } catch (e) {
      setCache((c) => ({ ...c, [signalId]: prev }));
      throw e;
    }
  };

  return { cache, updateMeta };
}
