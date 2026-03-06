import React from 'react';
export function CommandBar({ total, selectedCount }: any) {
  return <div className="bg-white border rounded p-3 text-sm flex justify-between"><span>Startup Watch</span><span>Total: {total} · Selected: {selectedCount}</span></div>;
}
