import React from 'react';
export default function StatusBadge({ status='new' }: { status?: string }) { return <span className="px-2 py-1 rounded text-xs bg-purple-100 text-purple-700">{status}</span>; }
