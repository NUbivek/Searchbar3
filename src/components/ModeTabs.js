import React from 'react';
import Link from 'next/link';
import { FaProjectDiagram, FaSearch, FaDatabase } from 'react-icons/fa';

function tabClass(active) {
  return [
    'w-full rounded-xl py-2.5 text-sm font-medium leading-5 flex items-center justify-center transition',
    active
      ? 'bg-slate-900 text-white shadow'
      : 'text-slate-600 hover:bg-white hover:text-slate-900'
  ].join(' ');
}

export default function ModeTabs({ activeMode = 'open' }) {
  return (
    <div className="mx-auto mb-6 flex max-w-2xl space-x-2 rounded-2xl border border-slate-200 bg-white/80 p-1 shadow-sm backdrop-blur">
      <Link href="/" className={tabClass(activeMode === 'open')}>
        <FaSearch className="mr-2" /> Open Research
      </Link>
      <Link href="/network" className={tabClass(activeMode === 'network')}>
        <FaProjectDiagram className="mr-2" /> Network Map
      </Link>
      <Link href="/sourcing" className={tabClass(activeMode === 'sourcing')}>
        <FaDatabase className="mr-2" /> Sourcing Output
      </Link>
    </div>
  );
}
