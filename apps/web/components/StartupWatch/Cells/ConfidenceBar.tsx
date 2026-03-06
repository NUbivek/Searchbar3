import React from 'react';
export default function ConfidenceBar({ confidence=0 }: { confidence?: number }) {
  const color = confidence < 0.5 ? 'bg-red-500' : confidence < 0.7 ? 'bg-amber-500' : 'bg-green-500';
  return <div className="flex items-center gap-2"><div className="w-20 h-2 bg-gray-200 rounded"><div className={`h-2 rounded ${color}`} style={{ width:`${Math.max(0,Math.min(100,confidence*100))}%` }} /></div><span className="text-xs">{confidence.toFixed(3)}</span></div>;
}
