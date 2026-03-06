import React from 'react';
export default function SourceBadge({ sourceKey='unknown', tier=7 }: { sourceKey?: string; tier?: number }) {
  return <span className="px-2 py-1 rounded text-xs bg-blue-50 text-blue-700 border border-blue-200">T{tier} · {sourceKey}</span>;
}
