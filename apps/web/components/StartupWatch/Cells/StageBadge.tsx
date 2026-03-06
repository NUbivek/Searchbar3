import React from 'react';
const STAGE_COLORS: Record<string, any> = {
  'stealth': { bg: '#F3F4F6', text: '#374151', border: '#D1D5DB' },
  'pre-seed': { bg: '#FEF9C3', text: '#854D0E', border: '#FDE047' },
  'seed': { bg: '#DCFCE7', text: '#166534', border: '#86EFAC' },
  'series-a': { bg: '#DBEAFE', text: '#1E40AF', border: '#93C5FD' },
  'series-b': { bg: '#EDE9FE', text: '#5B21B6', border: '#C4B5FD' },
  'series-c': { bg: '#FEE2E2', text: '#991B1B', border: '#FCA5A5' },
  'unknown': { bg: '#F9FAFB', text: '#6B7280', border: '#E5E7EB' },
};
export default function StageBadge({ stage='unknown' }: { stage?: string }) {
  const c = STAGE_COLORS[stage] || STAGE_COLORS.unknown;
  return <span style={{ backgroundColor:c.bg,color:c.text,borderColor:c.border }} className="px-2 py-1 border rounded-full text-xs">{stage}</span>;
}
