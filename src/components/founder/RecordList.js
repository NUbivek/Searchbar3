/**
 * Records of a deep report: one record, long lists of them, the filter bar
 * over every section, and the small card a citation opens.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { HiOutlineArrowTopRightOnSquare, HiOutlineXMark } from 'react-icons/hi2';
import { ExternalLink, usePrinting } from './parts';
import { recordKey } from './summary';

export const MATCH = {
  confirmed: { label: 'same person', chip: 'chip chip-good', title: 'The record names this person together with a company known to be theirs.' },
  likely: { label: 'likely same person', chip: 'chip chip-active', title: 'The record names this person together with a school, associate or handle known to be theirs.' },
  company: { label: 'company', chip: 'chip', title: 'About the company, not the person.' },
  possible: { label: 'name match only', chip: 'chip chip-warn', title: 'Only the name matches. This may be a different person with the same name.' },
};
export const SEVERITY = { high: { label: 'serious', chip: 'chip chip-bad' }, medium: { label: 'notable', chip: 'chip chip-warn' }, low: { label: 'minor', chip: 'chip' } };

const ICON = { width: 12, height: 12 };

export function Record({ f, withId = true, isNew = false }) {
  const m = MATCH[f.match] || MATCH.possible;
  const s = SEVERITY[f.severity];
  const also = Array.isArray(f.alsoIn) ? f.alsoIn : [];
  return (
    <li id={withId ? `deep-source-${f.n}` : undefined} tabIndex={withId ? -1 : undefined} className="scroll-mt-24 py-3 first:pt-0 last:pb-0">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="cite">[{f.n}]</span>
        {isNew && <span className="chip chip-active" title="Not in the previous run of this check">new</span>}
        {s && <span className={s.chip}>{s.label}</span>}
        <span className={m.chip} title={m.title}>{m.label}</span>
        {f.corroboration > 1 && <span className="chip" title="Independent sources reporting the same thing">{f.corroboration} sources agree</span>}
        {f.textNotRead && <span className="chip" title="The page could not be read: the record is listed from its title and address only.">text not read</span>}
        <span className="text-xs text-muted">{f.sourceLabel}{f.date ? ` · ${f.date}` : ''}</span>
      </div>
      <ExternalLink href={f.url} className="text-sm font-medium text-ink hover:text-brand-600 hover:underline">
        {f.title} <HiOutlineArrowTopRightOnSquare className="founder-no-print inline align-text-top text-muted" style={ICON} />
      </ExternalLink>
      {f.quote && <p className="mt-1 text-sm leading-relaxed text-slate-700">&ldquo;{f.quote}&rdquo;</p>}
      {f.outcome?.text && (
        <p className="mt-1 text-sm text-ink">
          <span className="eyebrow mr-1.5">Outcome</span>{f.outcome.text}{f.outcome.role ? `; their part: ${f.outcome.role}` : ''}{f.outcome.date ? ` (${f.outcome.date})` : ''}
          {Number.isFinite(f.outcome.n) && f.outcome.n !== f.n ? <a href={`#deep-source-${f.outcome.n}`} className="cite ml-1">[{f.outcome.n}]</a> : null}
        </p>
      )}
      {f.claimNote && (
        <p className="mt-1 text-xs text-muted">
          {f.claimNote.charAt(0).toUpperCase() + f.claimNote.slice(1)}
          {Number.isFinite(f.confirmedBy) ? <a href={`#deep-source-${f.confirmedBy}`} className="cite ml-1">[{f.confirmedBy}]</a> : null}
        </p>
      )}
      {typeof f.data?.ownDomainChecked === 'string' && f.data.ownDomainChecked && <p className="mt-1 text-xs text-muted">Their company&rsquo;s own domain was checked too: {f.data.ownDomainChecked}</p>}
      {f.matchReasons?.length > 0 && f.match !== 'company' && <p className="mt-1 text-xs text-muted">Matched because the record {f.matchReasons.join(', ')}.</p>}
      {also.length > 0 && (
        <p className="mt-1 text-xs text-muted">
          Also reported by:{' '}
          {also.map((c, i) => (
            <span key={c.id || `${c.url}-${i}`}>
              {i > 0 ? ', ' : ''}
              <ExternalLink href={c.url} className="hover:text-brand-600 hover:underline">{c.sourceLabel || c.title}</ExternalLink>
            </span>
          ))}
        </p>
      )}
      {f.more?.length > 0 && <MoreRecords more={f.more} />}
    </li>
  );
}

function MoreRecords({ more }) {
  const printing = usePrinting();
  return (
    <details className="mt-1.5 text-xs text-muted" open={printing || undefined}>
      <summary className="cursor-pointer select-none hover:text-ink">{more.length} more record{more.length === 1 ? '' : 's'} on the same matter</summary>
      <ul className="mt-1.5 space-y-1 border-l border-line pl-3">
        {more.map((m) => (
          <li key={m.n}>
            <a href={`#deep-source-${m.n}`} className="cite mr-1">[{m.n}]</a>
            <ExternalLink href={m.url} className="hover:text-brand-600 hover:underline">{m.title}</ExternalLink>
            <span> · {m.sourceLabel}{m.date ? ` · ${m.date}` : ''}{m.match === 'possible' ? ' · name match only' : ''}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * A long list of records: the first few, and the rest on request (a report can hold hundreds); all of them
 * while printing. Every record has one home (its kind's section), which carries the anchor citations jump
 * to: the copies listed again under red flags, company matters, namesakes and changed claims pass
 * withId={false}. `reveal` is the record a citation was just followed to: the list shows it even when it is
 * past the first few. `fresh` holds the keys of records a new run found.
 */
export function Records({ items, first = 12, withId = true, reveal = null, fresh = null }) {
  const printing = usePrinting();
  const [all, setAll] = useState(false);
  const forced = withId && reveal != null && items.findIndex((f) => f.n === reveal) >= first;
  useEffect(() => { if (forced) setAll(true); }, [forced]);
  const full = all || forced || printing;
  const shown = full ? items : items.slice(0, first);
  return (
    <>
      <ul className="divide-y divide-line">{shown.map((f) => <Record key={`${f.id}-${f.n}`} f={f} withId={withId} isNew={Boolean(fresh?.has(recordKey(f)))} />)}</ul>
      {items.length > first && !printing && (
        <button type="button" className="founder-no-print btn-ghost mt-3 px-2 py-1 text-xs" onClick={() => setAll((v) => !v)} aria-expanded={full}>
          {full ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}

// ------------------------------------------------------------ filters
export const NO_FILTER = { ties: [], severities: [], source: '', text: '' };
const TIES = [['confirmed', 'same person'], ['likely', 'likely'], ['company', 'company']];
const SEVERITIES = [['high', 'serious'], ['medium', 'notable'], ['low', 'minor'], ['none', 'no severity']];
export const isFiltered = (v) => Boolean(v && (v.ties.length || v.severities.length || v.source || v.text.trim()));

/** The records that pass the filter: any chosen tie, any chosen severity, the source, and every word of the search. */
export function filterRecords(items, v = NO_FILTER) {
  if (!isFiltered(v)) return items;
  const words = v.text.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((f) => {
    if (v.ties.length && !v.ties.includes(f.match)) return false;
    if (v.severities.length && !v.severities.includes(SEVERITY[f.severity] ? f.severity : 'none')) return false;
    if (v.source && f.sourceLabel !== v.source) return false;
    if (words.length) {
      const hay = `${f.title || ''} ${f.quote || ''} ${f.sourceLabel || ''} ${f.date || ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export function RecordFilters({ value, onChange, items, shown }) {
  const id = useId();
  const count = (pred) => items.filter(pred).length;
  const toggle = (key, x) => onChange({ ...value, [key]: value[key].includes(x) ? value[key].filter((y) => y !== x) : [...value[key], x] });
  const sources = [...new Set(items.map((f) => f.sourceLabel).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const chip = (on) => (on ? 'chip chip-active' : 'chip');
  return (
    <div className="founder-no-print card card-pad space-y-3" role="search" aria-label="Filter the records">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-q`} className="sr-only">Search the records</label>
        <input id={`${id}-q`} type="search" className="input min-w-0 flex-1" placeholder="Search the records" value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} />
        <label htmlFor={`${id}-s`} className="sr-only">Source</label>
        <select id={`${id}-s`} className="select max-w-full sm:w-56" value={value.source} onChange={(e) => onChange({ ...value, source: e.target.value })}>
          <option value="">All sources</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="eyebrow mr-1">Tie</span>
        {TIES.map(([k, label]) => (
          <button key={k} type="button" className={chip(value.ties.includes(k))} aria-pressed={value.ties.includes(k)} onClick={() => toggle('ties', k)}>
            {label} · {count((f) => f.match === k)}
          </button>
        ))}
        <span className="eyebrow ml-2 mr-1">Severity</span>
        {SEVERITIES.map(([k, label]) => (
          <button key={k} type="button" className={chip(value.severities.includes(k))} aria-pressed={value.severities.includes(k)} onClick={() => toggle('severities', k)}>
            {label} · {count((f) => (SEVERITY[f.severity] ? f.severity : 'none') === k)}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted" aria-live="polite">
        {isFiltered(value) ? `Showing ${shown} of ${items.length} records.` : `${items.length} records tied to the person or their company.`}
        {isFiltered(value) && <button type="button" className="ml-2 font-medium text-brand-600 hover:underline" onClick={() => onChange(NO_FILTER)}>Clear filters</button>}
      </p>
    </div>
  );
}

// ------------------------------------------------------------ the card a citation opens
/**
 * A small card beside a clicked citation: the record's title, source and date, how it is tied to the person,
 * and its link. "Show in report" goes to the record; Escape or Close returns focus to the citation.
 */
export function CitationCard({ record, n, at, onClose, onShow }) {
  const ref = useRef(null);
  const titleId = useId();
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!at || typeof window === 'undefined') return;
    const r = at.getBoundingClientRect();
    const width = Math.min(352, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - width - 16));
    setPos({ top: r.bottom + window.scrollY + 6, left, width });
  }, [at]);
  useEffect(() => {
    ref.current?.querySelector('button, a')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && e.target !== at) onClose(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [onClose, at]);
  const m = record ? (MATCH[record.match] || MATCH.possible) : null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      className="founder-no-print absolute z-40 rounded-2xl border border-line bg-white p-4 text-sm shadow-card"
      style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { position: 'fixed', bottom: 16, left: 16, right: 16 }}
    >
      <div className="mb-2 flex items-start gap-2">
        <span className="cite">[{n}]</span>
        <p id={titleId} className="min-w-0 flex-1 font-medium text-ink">{record ? record.title : `Record ${n}`}</p>
        <button type="button" className="btn-ghost -mr-1 -mt-1 px-1.5 py-1" aria-label="Close" onClick={() => onClose()}><HiOutlineXMark style={{ width: 14, height: 14 }} /></button>
      </div>
      {record ? (
        <>
          <p className="text-xs text-muted">{record.sourceLabel}{record.date ? ` · ${record.date}` : ''}</p>
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className={m.chip}>{m.label}</span>
            {SEVERITY[record.severity] && <span className={SEVERITY[record.severity].chip}>{SEVERITY[record.severity].label}</span>}
          </p>
          <p className="mt-1 text-xs text-muted">{record.matchReasons?.length && record.match !== 'company' ? `Tied because the record ${record.matchReasons.join(', ')}.` : m.title}</p>
          {record.quote && <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-slate-700">&ldquo;{record.quote}&rdquo;</p>}
        </>
      ) : <p className="text-xs text-muted">This record is not listed in this report.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {record && <ExternalLink href={record.url} className="btn-secondary px-2.5 py-1 text-xs">Open source <HiOutlineArrowTopRightOnSquare style={ICON} /></ExternalLink>}
        {record && <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={onShow}>Show in report</button>}
      </div>
    </div>
  );
}
