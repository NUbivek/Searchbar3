import { useEffect, useState } from 'react';
import { Tab } from '@headlessui/react';
import { StartupWatchTab } from '../components/StartupWatch';

function shellCard(title: string, description: string) {
  return (
    <div className="rounded-2xl border border-white/60 bg-white/80 p-8 shadow-sm backdrop-blur">
      <h3 className="text-xl font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm text-slate-600">{description}</p>
    </div>
  );
}

export default function HomePage() {
  const [totalCount, setTotalCount] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/startup-watch/stats')
      .then((r) => r.json())
      .then((d) => setTotalCount(d.total))
      .catch(() => setTotalCount(null));
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 via-blue-50/40 to-indigo-50/40 p-6">
      <div className="mx-auto max-w-[1400px]">
        <div className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Research Platform</h1>
          <p className="mt-1 text-sm text-slate-600">Unified workspace for discovery, mapping, and startup signal tracking.</p>
        </div>

        <Tab.Group>
          <Tab.List className="mb-4 flex w-fit gap-2 rounded-2xl border border-slate-200 bg-white/70 p-1 shadow-sm backdrop-blur">
            {['Open Research', 'Network Map', 'Startup Watch'].map((label, idx) => (
              <Tab
                key={label}
                className={({ selected }) =>
                  `rounded-xl px-4 py-2 text-sm font-medium transition ${
                    selected
                      ? 'bg-slate-900 text-white shadow'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`
                }
              >
                {label}
                {idx === 2 && totalCount != null && (
                  <span className="ml-2 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-semibold text-blue-700">
                    {totalCount.toLocaleString()}
                  </span>
                )}
              </Tab>
            ))}
          </Tab.List>

          <Tab.Panels>
            <Tab.Panel>{shellCard('Open Research', 'Open Research panel is connected in the full app shell. This tab remains intentionally minimal in this build slice.')}</Tab.Panel>
            <Tab.Panel>{shellCard('Network Map', 'Network Map panel is connected in the full app shell. This tab remains intentionally minimal in this build slice.')}</Tab.Panel>
            <Tab.Panel>
              <StartupWatchTab />
            </Tab.Panel>
          </Tab.Panels>
        </Tab.Group>
      </div>
    </main>
  );
}
