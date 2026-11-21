/**
 * Small pieces shared by the Founder Check report and the quick brief: the
 * collapsible card every report section uses, citation pills, safe outside
 * links and a neutral source badge.
 *
 * Links: only http and https addresses become links (a saved report from
 * before the privacy rules may still hold anything), and every outside link
 * opens with rel="noopener noreferrer nofollow". No page asks a third-party
 * service for site icons: that would tell it which sites are being
 * researched, so a source is marked with the first letter of its host.
 */
import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { safeHref } from '../../server/founder/guardrails';

export { safeHref };

export const EXTERNAL_REL = 'noopener noreferrer nofollow';

/** True while the report is being printed: every section opens and every list shows in full. */
export const PrintContext = createContext(false);
export const usePrinting = () => useContext(PrintContext);

export function hostOf(url) {
  const href = safeHref(url);
  if (!href) return '';
  try { return new URL(href).hostname.replace(/^www\./i, ''); } catch { return ''; }
}

/** An outside link when the address is http(s); otherwise the text alone. */
export function ExternalLink({ href, children, className = '', title, ...rest }) {
  const safe = safeHref(href);
  if (!safe) return <span className={className} title={title}>{children}</span>;
  return <a href={safe} target="_blank" rel={EXTERNAL_REL} className={className} title={title} {...rest}>{children}</a>;
}

/** The first letter of the source's host in a quiet square: a marker that asks no other site for anything. */
export function SourceBadge({ url, label = '' }) {
  const host = hostOf(url);
  const letter = (host || String(label || '')).replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '·';
  return (
    <span className="inline-grid h-4 w-4 place-items-center rounded bg-slate-100 text-[10px] font-semibold leading-none text-muted" aria-hidden="true" title={host || undefined}>
      {letter}
    </span>
  );
}

/** Citation pills [n] for record numbers of the deep report. */
export function Cites({ ns }) {
  return (Array.isArray(ns) ? ns : []).filter((n) => Number.isFinite(Number(n))).map((n) => (
    <a key={n} href={`#deep-source-${n}`} className="cite ml-1">[{n}]</a>
  ));
}

/** Opens the report section around `el` (a citation jumping to a record in a closed section). */
export function openBlockAround(el) {
  for (let b = el?.closest?.('[data-block]'); b; b = b.parentElement?.closest?.('[data-block]')) {
    b.dispatchEvent(new CustomEvent('founder:open'));
  }
}

/**
 * A report section. The heading holds the toggle button (so screen readers list every section as a
 * heading, and the toggle says whether it is open); the count and "Show" sit beside it. Opens itself while
 * printing, and when a citation jumps to a record inside it (openBlockAround).
 */
export function Block({ title, count, children, open = false, note = null, tone = null, id }) {
  const printing = usePrinting();
  const [isOpen, setOpen] = useState(open);
  const ref = useRef(null);
  const bodyId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onOpen = () => setOpen(true);
    el.addEventListener('founder:open', onOpen);
    return () => el.removeEventListener('founder:open', onOpen);
  }, []);
  const shown = printing || isOpen;
  const toggle = () => setOpen((v) => !v);
  return (
    <section ref={ref} data-block="" className="card card-pad scroll-mt-24" id={id}>
      <div className="flex items-center gap-2">
        <h2 className="section-title">
          <button type="button" className="text-left" aria-expanded={shown} aria-controls={bodyId} onClick={toggle}>{title}</button>
        </h2>
        {typeof count === 'number' && <span className={tone || 'chip'}>{count}</span>}
        {/* the heading's button is the control; this is the same toggle, larger to hit */}
        <span aria-hidden="true" className="founder-no-print ml-auto cursor-pointer select-none text-xs text-muted hover:text-ink" onClick={toggle}>{shown ? 'Hide' : 'Show'}</span>
      </div>
      <div id={bodyId} hidden={!shown} className="mt-3">
        {note}
        {children}
      </div>
    </section>
  );
}
