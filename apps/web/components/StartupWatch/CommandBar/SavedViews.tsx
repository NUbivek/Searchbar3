import React from 'react';

const PRESETS = ['New This Week', 'Tier 1+Seed/A', 'Supply Chain', 'AgTech', 'Needs Review', 'Shortlisted'];

export function SavedViews({ onSelect }: { onSelect: (name: string) => void }) {
  return (
    <select className="border rounded px-2 py-2 text-sm" onChange={(e) => e.target.value && onSelect(e.target.value)} defaultValue="">
      <option value="">Saved views…</option>
      {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  );
}
