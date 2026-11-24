/**
 * The shortcuts built from the file: "Everyone 544" first, then up to six
 * chips, then "More". A chip switches the list to its people (ROUND2 R1):
 * pressing another chip goes straight to that one, pressing the pressed chip
 * again (or Everyone) goes back to everyone. A chip's label and count never
 * change and a chip is never disabled, so the card always describes the
 * whole file. Narrowing one list by another lives in the people list.
 * Below the sm breakpoint every chip is at least 36px tall, a size a thumb can hit.
 */
import React, { useState } from 'react';

function Chip({ s, active, onToggle }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onToggle(s.id)}
      data-shortcut={s.id}
      className={`chip min-h-9 sm:min-h-0 ${active ? 'chip-active' : 'hover:border-brand-200 hover:text-ink'}`}
    >
      {s.label}
    </button>
  );
}

/** `pressedId` is the shortcut in use (one at most), or null. */
export default function Shortcuts({ everyone, shortcuts = [], more = [], pressedId = null, onToggle, onEveryone, everyoneActive }) {
  const [showMore, setShowMore] = useState(false);
  // A pressed chip from "More" stays in view even when More is closed.
  const visibleMore = showMore ? more : more.filter((s) => s.id === pressedId);
  const render = (s) => <Chip key={s.id} s={s} active={s.id === pressedId} onToggle={onToggle} />;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Shortcuts">
      {everyone && (
        <button
          type="button"
          aria-pressed={Boolean(everyoneActive)}
          onClick={onEveryone}
          className={`chip min-h-9 sm:min-h-0 ${everyoneActive ? 'chip-active' : 'hover:text-ink'}`}
        >
          {everyone.label}
        </button>
      )}
      {shortcuts.map(render)}
      {visibleMore.map(render)}
      {more.length > 0 && (
        <button type="button" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)} className="btn-ghost min-h-9 px-2 py-1 text-xs sm:min-h-0">
          {showMore ? 'Less' : `More (${more.length})`}
        </button>
      )}
    </div>
  );
}
