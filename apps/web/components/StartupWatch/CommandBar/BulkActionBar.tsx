import React from 'react';

export function BulkActionBar({ count, onClear }: { count: number; onClear: () => void }) {
  if (!count) return null;
  return (
    <div className="bg-amber-50 border border-amber-200 rounded p-2 text-sm flex items-center justify-between">
      <span>{count} selected</span>
      <div className="flex gap-2">
        <button className="px-2 py-1 border rounded">Set status</button>
        <button className="px-2 py-1 border rounded">Assign</button>
        <button className="px-2 py-1 border rounded">Export selected</button>
        <button className="px-2 py-1 border rounded" onClick={onClear}>Deselect all</button>
      </div>
    </div>
  );
}
