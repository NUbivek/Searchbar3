import React from 'react';
export default function SkeletonRow({ columnCount=10 }: { columnCount?: number }) { return <tr>{Array.from({length:columnCount}).map((_,i)=><td key={i} className="p-2"><div className="h-3 bg-gray-200 animate-pulse rounded"/></td>)}</tr>; }
