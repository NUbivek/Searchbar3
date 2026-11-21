/**
 * The shortcuts built from the file: "Everyone 544" first, then up to six
 * chips, then "More". Chips are toggle buttons and combine (AND): while one
 * or more are pressed, every other chip shows how many people would remain
 * if it were added, and a chip that would leave nobody is disabled.
 */
import React, { useState } from 'react';

export const MAX_ACTIVE = 3;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

function Chip({ s, active, count, disabled, onToggle }) {
  // An inactive chip shows the count that would remain, not its own total.
  const label = active || count == null ? s.label : `${fmt(count)} ${s.short}`;
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onToggle(s.id)}
      data-shortcut={s.id}
      className={`chip ${active ? 'chip-active' : 'hover:border-brand-200 hover:text-ink'} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {label}
    </button>
  );
}

export default function Shortcuts({ everyone, shortcuts = [], more = [], activeIds = [], countFor, onToggle, onEveryone, everyoneActive }) {
  const [showMore, setShowMore] = useState(false);
  const anyActive = activeIds.length > 0;
  const full = activeIds.length >= MAX_ACTIVE;
  // A pressed chip from "More" stays in view even when More is closed.
  const visibleMore = showMore ? more : more.filter((s) => activeIds.includes(s.id));
  const render = (s) => {
    const active = activeIds.includes(s.id);
    const count = anyActive && !active ? countFor(s.id) : null;
    return (
      <Chip
        key={s.id}
        s={s}
        active={active}
        count={count}
        disabled={!active && ((count != null && count === 0) || full)}
        onToggle={onToggle}
      />
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Shortcuts">
      {everyone && (
        <button
          type="button"
          aria-pressed={Boolean(everyoneActive)}
          onClick={onEveryone}
          className={`chip ${everyoneActive ? 'chip-active' : 'hover:text-ink'}`}
        >
          {everyone.label}
        </button>
      )}
      {shortcuts.map(render)}
      {visibleMore.map(render)}
      {more.length > 0 && (
        <button type="button" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)} className="btn-ghost px-2 py-1 text-xs">
          {showMore ? 'Less' : `More (${more.length})`}
        </button>
      )}
    </div>
  );
}
