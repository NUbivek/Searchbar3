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
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-[520px] overflow-auto border-l border-slate-200 bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-xl font-semibold tracking-tight text-slate-900">{signal.company_name}</h3>
            {signal.company_domain && (
              <a className="text-sm text-blue-600 hover:text-blue-800" href={`https://${signal.company_domain}`} target="_blank" rel="noreferrer">
                {signal.company_domain}
              </a>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">Close</button>
        </div>

        <Tab.Group>
          <Tab.List className="mb-3 flex gap-2 rounded-xl border border-slate-200 bg-slate-50 p-1">
            {['Overview', 'Enrichment', 'Sources', 'Raw JSON'].map((t) => (
              <Tab
                key={t}
                className={({ selected }) =>
                  `rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    selected ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-200/60'
                  }`
                }
              >
                {t}
              </Tab>
            ))}
          </Tab.List>
          <Tab.Panels>
            <Tab.Panel className="text-sm text-slate-700">{signal.summary || 'No summary available.'}</Tab.Panel>
            <Tab.Panel className="text-sm text-slate-700">Funding: {signal.funding_total || '—'} | Headcount: {signal.headcount || '—'}</Tab.Panel>
            <Tab.Panel className="text-sm text-slate-700">Source: {signal.source_key || '—'} · URL: {signal.source_url || '—'}</Tab.Panel>
            <Tab.Panel>
              <pre className="overflow-auto rounded-xl bg-slate-900 p-3 text-xs text-white">{JSON.stringify(signal, null, 2)}</pre>
            </Tab.Panel>
          </Tab.Panels>
        </Tab.Group>

        <div className="mt-5 space-y-3 border-t border-slate-100 pt-4">
          <label className="block text-xs font-semibold text-slate-500">
            Status
            <select className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" defaultValue={signal.status || 'new'}>
              {['new', 'reviewed', 'shortlisted', 'rejected', 'contacted'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-slate-700"><input type="checkbox" defaultChecked={!!signal.flagged} className="mr-2" />Flagged</label>
          <label className="block text-xs font-semibold text-slate-500">
            Notes
            <textarea className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" rows={3} defaultValue={signal.notes || ''} />
          </label>
          <label className="block text-xs font-semibold text-slate-500">
            Owner
            <input className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" defaultValue={signal.owner || ''} />
          </label>
        </div>
      </div>
    </div>
  );
}
