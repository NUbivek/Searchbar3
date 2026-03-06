import { useEffect, useState } from 'react';
import { Tab } from '@headlessui/react';
import { StartupWatchTab } from '../components/StartupWatch';

export default function HomePage() {
  const [totalCount, setTotalCount] = useState<number | null>(null);
  useEffect(() => {
    fetch('/api/startup-watch/stats').then((r) => r.json()).then((d) => setTotalCount(d.total)).catch(() => setTotalCount(null));
  }, []);

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <Tab.Group>
        <Tab.List className="flex gap-2 mb-4">
          <Tab className="px-3 py-2 bg-white border rounded">Open Research</Tab>
          <Tab className="px-3 py-2 bg-white border rounded">Network Map</Tab>
          <Tab className="px-3 py-2 bg-white border rounded">Startup Watch {totalCount != null && <span className='ml-2 bg-blue-100 text-blue-800 text-xs font-medium px-2 py-0.5 rounded-full'>{totalCount.toLocaleString()}</span>}</Tab>
        </Tab.List>
        <Tab.Panels>
          <Tab.Panel><div className="bg-white border rounded p-6">Open Research panel placeholder</div></Tab.Panel>
          <Tab.Panel><div className="bg-white border rounded p-6">Network Map panel placeholder</div></Tab.Panel>
          <Tab.Panel><StartupWatchTab /></Tab.Panel>
        </Tab.Panels>
      </Tab.Group>
    </main>
  );
}
