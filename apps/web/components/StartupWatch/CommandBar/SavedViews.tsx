import React from 'react';

const PRESETS = ['New This Week', 'Tier 1+Seed/A', 'Supply Chain', 'AgTech', 'Needs Review', 'Shortlisted'];

export function SavedViews({ onSelect }: { onSelect: (name: string) => void }) {
  return (
    <select
      className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 shadow-sm outline-none ring-blue-500/40 focus:ring"
      onChange={(e) => e.target.value && onSelect(e.target.value)}
      defaultValue=""
    >
      <option value="">Saved views…</option>
      {PRESETS.map((p) => (
        <option key={p} value={p}>{p}</option>
      ))}
    </select>
  );
}
