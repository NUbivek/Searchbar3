/**
 * One line about where the contacts came from: "544 contacts from LinkedIn ·
 * saved to your account · Add or replace · Remove all". "Add or replace"
 * opens the connector cards; with more than one source, the source chips
 * (and "direct only" for firm-wide CRM contacts) narrow the map.
 */
import React, { useState } from 'react';
import Link from 'next/link';
import { HiOutlineTrash, HiOutlineArrowUpTray } from 'react-icons/hi2';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const ORDER = ['linkedin', 'csv', 'x', 'attio'];

/** "LinkedIn", "LinkedIn and X", "LinkedIn, X and Attio". */
function joinNames(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export default function SourceStrip({
  total, counts, labels, colors = {}, saved, showSignIn, busy, onRemoveAll, connectors,
  sourceFilter, onToggleSource, firmCount = 0, directOnly, onToggleDirect, dropProps = {}, dragging,
}) {
  const [open, setOpen] = useState(false);
  const present = ORDER.filter((s) => counts[s]);
  return (
    <section
      className={`card ${dragging ? 'ring-2 ring-brand-300' : ''}`}
      aria-label="Your contacts"
      {...dropProps}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm sm:px-5">
        <span className="text-ink">
          <span className="font-semibold">{fmt(total)}</span> contacts from {joinNames(present.map((s) => labels[s] || s))}
        </span>
        <span className="text-muted">·</span>
        <span className="text-muted">{saved ? 'saved to your account' : 'kept in this tab only'}</span>
        {showSignIn && (
          <>
            <span className="text-muted">·</span>
            <Link href="/signin" className="font-medium text-brand-600 hover:underline">Sign in to save your network</Link>
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="btn-ghost px-2 py-1 text-xs">
            <HiOutlineArrowUpTray style={{ width: 13, height: 13 }} /> Add or replace
          </button>
          <button type="button" onClick={onRemoveAll} disabled={Boolean(busy)} className="btn-danger px-2 py-1 text-xs disabled:opacity-50">
            <HiOutlineTrash style={{ width: 13, height: 13 }} /> {busy === 'delete' ? 'Removing…' : 'Remove all'}
          </button>
        </span>
      </div>
      {(present.length > 1 || firmCount > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-2 sm:px-5" role="group" aria-label="Which contacts the map shows">
          {present.length > 1 && present.map((s) => (
            <button
              key={s}
              type="button"
              role="checkbox"
              aria-checked={Boolean(sourceFilter[s])}
              onClick={() => onToggleSource(s)}
              className={`chip ${sourceFilter[s] ? 'chip-active' : ''}`}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: colors[s] }} />
              {labels[s] || s} <span className="text-muted">{fmt(counts[s])}</span>
            </button>
          ))}
          {firmCount > 0 && (
            <>
              <button
                type="button"
                role="checkbox"
                aria-checked={Boolean(directOnly)}
                title="Hide firm-wide CRM contacts held by colleagues"
                onClick={onToggleDirect}
                className={`chip ${directOnly ? 'chip-active' : ''}`}
              >
                My direct connections only
              </button>
              <span className="ml-auto text-xs text-muted">
                <span className="inline-block h-2 w-2 rounded-full border border-brand-400 bg-white align-middle" /> hollow = firm contact
              </span>
            </>
          )}
        </div>
      )}
      {open && <div className="space-y-2 border-t border-line px-4 py-3 sm:px-5">{connectors}</div>}
    </section>
  );
}
