import React from 'react';
export default function ThesisTagChips({ tags=[] }: { tags?: string[] }) {
  const visible = tags.slice(0,2);
  const more = tags.length - visible.length;
  return <div className="flex gap-1 flex-wrap">{visible.map((t) => <span key={t} className="text-xs px-2 py-0.5 rounded bg-gray-100">{t}</span>)}{more>0 && <span className="text-xs px-2 py-0.5 rounded bg-gray-200">+{more} more</span>}</div>;
}
