import React from 'react';
export default function EmptyState({ activeFilterCount=0, onReset }: { activeFilterCount?: number; onReset?: () => void }) {
  return <div className="text-center p-6 text-sm text-gray-600">{activeFilterCount ? 'No results for current filters' : 'No signals yet'} {activeFilterCount>0 && <button className="ml-2 underline" onClick={onReset}>Reset All</button>}</div>;
}
