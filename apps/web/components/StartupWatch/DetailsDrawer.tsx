import React from 'react';
import { Tab } from '@headlessui/react';

export function DetailsDrawer({ signal, onClose }: any) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/10" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-[480px] bg-white border-l shadow-xl p-4 overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-lg">{signal.company_name}</h3>
            {signal.company_domain && <a className="text-xs text-blue-600" href={`https://${signal.company_domain}`} target="_blank" rel="noreferrer">{signal.company_domain}</a>}
          </div>
          <button onClick={onClose} className="px-2 py-1 border rounded">Close</button>
        </div>

        <Tab.Group>
          <Tab.List className="flex gap-2 mb-3">
            {['Overview','Enrichment','Sources','Raw JSON'].map((t) => <Tab key={t} className="px-2 py-1 border rounded text-sm">{t}</Tab>)}
          </Tab.List>
          <Tab.Panels>
            <Tab.Panel className="text-sm">{signal.summary || 'No summary'}</Tab.Panel>
            <Tab.Panel className="text-sm">Funding: {signal.funding_total || '—'} | Headcount: {signal.headcount || '—'}</Tab.Panel>
            <Tab.Panel className="text-sm">Source: {signal.source_key || '—'} · URL: {signal.source_url || '—'}</Tab.Panel>
            <Tab.Panel><pre className="text-xs bg-gray-900 text-white rounded p-2 overflow-auto">{JSON.stringify(signal, null, 2)}</pre></Tab.Panel>
          </Tab.Panels>
        </Tab.Group>

        <div className="mt-4 border-t pt-3 space-y-2">
          <label className="text-xs block">Status
            <select className="border rounded w-full px-2 py-1 mt-1" defaultValue={signal.status || 'new'}>
              {['new','reviewed','shortlisted','rejected','contacted'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-xs block"><input type="checkbox" defaultChecked={!!signal.flagged} className="mr-2" />Flagged</label>
          <label className="text-xs block">Notes<textarea className="border rounded w-full px-2 py-1 mt-1" rows={3} defaultValue={signal.notes || ''} /></label>
          <label className="text-xs block">Owner<input className="border rounded w-full px-2 py-1 mt-1" defaultValue={signal.owner || ''} /></label>
        </div>
      </div>
    </div>
  );
}
