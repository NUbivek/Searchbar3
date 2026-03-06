import React from 'react';
export function DetailsDrawer({ signal, onClose }: any) {
  return <div className="fixed right-0 top-0 h-full w-[480px] bg-white border-l shadow-xl p-4 overflow-auto z-50"><button onClick={onClose} className="mb-3">Close</button><h3 className="font-semibold">{signal.company_name}</h3><pre className="text-xs mt-3">{JSON.stringify(signal, null, 2)}</pre></div>;
}
