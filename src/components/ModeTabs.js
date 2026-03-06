import React from 'react';
import Link from 'next/link';
import { FaProjectDiagram, FaSearch } from 'react-icons/fa';

function tabClass(active) {
  return [
    'w-full rounded-lg py-2.5 text-sm font-medium leading-5 flex items-center justify-center',
    active ? 'bg-white text-blue-700 shadow' : 'text-blue-500 hover:bg-white/[0.12] hover:text-blue-700'
  ].join(' ');
}

export default function ModeTabs({ activeMode = 'open' }) {
  return (
    <div className="flex space-x-2 rounded-xl bg-blue-100 p-1 mb-6 max-w-md mx-auto">
      <Link href="/" className={tabClass(activeMode === 'open')}>
        <FaSearch className="mr-2" /> Open Research
      </Link>
      <Link href="/network" className={tabClass(activeMode === 'network')}>
        <FaProjectDiagram className="mr-2" /> Network Map
      </Link>
    </div>
  );
}
