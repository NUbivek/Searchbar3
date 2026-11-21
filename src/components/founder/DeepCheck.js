/**
 * Deep background check on the Founder Check page.
 *
 * A deep check takes minutes, so the page asks the server for it one step
 * at a time (POST /api/founder/deep) and shows what is happening. A check
 * survives a reload, a closed tab and a sign-in: the page asks for the
 * check it already has for this person (this browser's saved id, then the
 * account's latest check of the person) before it starts a new one.
 *
 * The report, top to bottom: a one-screen summary with honest counts, the
 * brief, red flags and matters about their companies, the profile as a
 * résumé, the company, the public-record screens, the user's network,
 * supporting sections, every record (with filters and search; name-only
 * matches collapsed apart), and what was and was not searched.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useSession } from 'next-auth/react';
import {
  HiOutlineSparkles, HiOutlineShieldCheck, HiOutlineArrowPath, HiOutlinePrinter, HiOutlineClipboardDocument, HiOutlineArrowUturnLeft,
} from 'react-icons/hi2';
import { skippedNote } from '../../utils/skippedNote';
import NetworkLinks from './NetworkLinks';
import { Block, Cites, ExternalLink, PrintContext, openBlockAround, usePrinting } from './parts';
import { briefHtml } from './briefHtml';
import { ProfileCard, CompanyCard, yearsOf } from './Resume';
import { Records, RecordFilters, CitationCard, filterRecords, isFiltered, NO_FILTER } from './RecordList';
import { summaryChips, redFlagChip, recordsByNumber, compareReports, formatWhen, savedReport } from './summary';
import { reportAsText } from './reportText';
import {
  step, startJob, readJob, latestJob, patiently, savedJob, rememberJob, forgetJob, wait, detailsBody, detailsUse,
} from './jobs';

export { step, yearsOf };

const CONFIDENCE_CHIP = { high: 'chip chip-good', medium: 'chip chip-warn', low: 'chip chip-bad' };
const KIND_LABEL = { company: 'Companies', school: 'Schools', associate: 'Associates', relative: 'Relatives in public roles', handle: 'Handles', domain: 'Domains', url: 'Pages', affiliate: 'Organisations', alias: 'Other names' };
const MATCH_ORDER = { confirmed: 0, likely: 1, company: 2 };
const SOURCE_LINK = 'a[href^="#deep-source-"]';

/** "llama-3.3-70b-instruct" for "meta-llama/llama-3.3-70b-instruct:free": the model's own name, without the vendor path or suffix. */
export function displayModel(model) {
  return String(model || '').split('/').pop().replace(/:free$/i, '');
}

/** What the related-parties list may claim: a person is called screened only when a watchlist lookup for them ran. */
export function relatedNote(parties, name) {
  const lead = 'Associates, and relatives who hold a business, political or philanthropic role in the public record.';
  if (!parties.some((p) => typeof p.screened === 'boolean')) {
    return `${lead} They were looked up as far as this run's limits allowed; a name with no records here is not proof of a clean record.`;
  }
  const screened = parties.filter((p) => p.screened === true).length;
  return `${lead} Screened against watchlists and searched together with ${name}: ${screened} of ${parties.length}.`;
}

/** The wording for the hourly limit: when another check can start, and nothing that offers to try at once. */
export function limitMessage(retryAfter, now = Date.now()) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    const at = new Date(now + seconds * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `You have started the most checks allowed in an hour. You can start another check at ${at}. Checks you already ran are under Recent checks.`;
  }
  return 'You have started the most checks allowed in an hour. Start this one when the hour is up; checks you already ran are under Recent checks.';
}

/** Where the sign-in page should send the visitor back to: this same check. */
export function signInHref() {
  const here = typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : '/founder';
  return `/signin?callbackUrl=${encodeURIComponent(here.startsWith('/') && !here.startsWith('//') ? here : '/founder')}`;
}

// ------------------------------------------------------------ progress
function Progress({ progress, name, note = '', compact = false }) {
  // New threads queue more lookups, which would pull the bar back: it keeps the highest point it reached.
  const best = useRef(0);
  const total = (progress?.tasksRun || 0) + (progress?.queued || 0);
  const raw = !progress ? 0 : progress.phase === 'collect' ? Math.min(96, Math.round(((progress.tasksRun || 0) / Math.max(1, total)) * 100)) : 98;
  best.current = Math.max(best.current, raw);
  const pct = best.current;
  const round = progress?.phase === 'collect' ? (progress.step || 0) + 1 : null;
  // Screen readers hear one line per round (and when the report is being written), not every update.
  const [said, setSaid] = useState('');
  const sayKey = !progress ? 'start' : round != null ? `round-${round}` : 'report';
  useEffect(() => {
    if (!progress) return;
    setSaid(round != null ? `Round ${round}: ${progress.tasksRun || 0} lookups, ${progress.findings || 0} records.` : 'Collecting is done; writing the report.');
  }, [sayKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const threads = Object.entries(progress?.threads || {});
  const log = (progress?.log || []).slice(-4);
  const valueText = progress ? `${progress.tasksRun || 0} lookups done, ${progress.queued || 0} queued${round != null ? `, round ${round}` : ', writing the report'}` : 'Starting';
  return (
    <section className="founder-no-print card card-pad">
      <div className="flex flex-wrap items-center gap-2">
        <HiOutlineSparkles className="animate-glow text-brand-500" style={{ width: 16, height: 16 }} />
        <h2 className="section-title">{compact ? 'Running the check again' : 'Deep background check'}</h2>
        <span className="chip">{!progress ? 'round 1' : progress.phase === 'collect' ? `round ${round}` : 'writing the report'}</span>
        <span className="ml-auto text-xs text-muted">{progress ? `${progress.tasksRun} lookups · ${progress.findings} records` : `Starting on ${name}…`}</span>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label="Deep check progress"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueText}
      >
        <div className="h-full rounded-full bg-brand-500 transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <p className="sr-only" aria-live="polite">{said}</p>
      {note && <p className="mt-3 text-xs text-amber-700">{note}</p>}
      {!compact && threads.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          Pulling threads:
          {threads.map(([kind, n]) => <span key={kind} className="chip">{n} {(KIND_LABEL[kind] || kind).toLowerCase()}</span>)}
        </p>
      )}
      {!compact && log.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {log.map((l, i) => <li key={`${l.step}-${i}`}>{l.text}</li>)}
        </ul>
      )}
      <p className="muted mt-3 text-xs">
        {compact ? 'The report below stays until the new one is ready; records the new run finds are then marked new.' : 'A full check takes a few minutes. It keeps running if you close this tab; open this page again to see it.'}
      </p>
    </section>
  );
}

// ------------------------------------------------------------ summary
function Summary({ report, onPrint, onCopy, copied, onRerun, rerunning, assumed, onRunWithout, changes }) {
  const p = report.profile || {};
  const chips = summaryChips(report);
  const note = report.identityNote || report.identity?.note;
  const common = report.commonName;
  const seeded = assumed || report.network?.seededCompany;
  return (
    <section className="card card-pad" aria-label="Summary">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ai-badge"><HiOutlineShieldCheck style={{ width: 13, height: 13 }} /> Deep background check</span>
        {report.generatedAt && <span className="text-xs text-muted">Report from {formatWhen(report.generatedAt)}</span>}
        <div className="founder-no-print ml-auto flex flex-wrap gap-1.5">
          <button type="button" onClick={onPrint} className="btn-ghost px-2 py-1 text-xs"><HiOutlinePrinter style={{ width: 13, height: 13 }} /> Print or save as PDF</button>
          <button type="button" onClick={onCopy} className="btn-ghost px-2 py-1 text-xs"><HiOutlineClipboardDocument style={{ width: 13, height: 13 }} /> {copied ? 'Copied' : 'Copy as text'}</button>
          <button type="button" onClick={onRerun} disabled={rerunning} className="btn-ghost px-2 py-1 text-xs" title="Starts a new check, which counts toward the hour's checks. This report stays until the new one is ready.">
            <HiOutlineArrowPath style={{ width: 13, height: 13 }} /> Run again
          </button>
        </div>
      </div>
      <h2 tabIndex={-1} data-report-heading="" className="mt-3 text-lg font-semibold tracking-tight text-ink focus:outline-none">
        {report.name}{report.company ? <span className="font-normal text-muted"> · {report.company}</span>
          : report.assumedCompany ? <span className="font-normal text-muted" title="No company was typed; the check took this one as theirs."> · {report.assumedCompany} (assumed)</span> : null}
      </h2>
      {(p.headline || p.basedIn) && (
        <p className="mt-1 text-sm text-slate-700">
          {p.headline}{p.headline && p.basedIn ? ' · ' : ''}{p.basedIn ? `based in ${p.basedIn.text}` : ''}
        </p>
      )}
      <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid="summary-chips">
        {chips.map((c) => <span key={c.key} className={c.tone} title={c.title}>{c.text}</span>)}
        {report.coverage && <span>{report.coverage.lookups} lookups in {report.coverage.rounds} rounds across {report.coverage.searched?.length || 0} sources</span>}
      </p>
      {note && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800" data-testid="identity-note">{note}</p>}
      {common && (
        <p className="mt-3 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700">
          A common name: {common.nameOnlyRecords ?? 0} record{common.nameOnlyRecords === 1 ? '' : 's'} match the name only{common.organisations ? `, naming ${common.organisations} different organisations` : ''}. Only records tied by more than the name are treated as about this person.
        </p>
      )}
      {seeded && (
        <p className="mt-3 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700">
          No company was entered, so this check used {seeded}, the company of the contact in your network with this name, which you confirmed.
          {onRunWithout && <> <button type="button" className="founder-no-print font-medium text-brand-600 hover:underline" onClick={onRunWithout}>Run it without {seeded}</button></>}
        </p>
      )}
      {changes && (
        <p className="mt-3 text-xs text-muted" data-testid="rerun-changes">
          Compared with the run from {formatWhen(changes.since) || 'before'}: {changes.fresh.size} new record{changes.fresh.size === 1 ? '' : 's'}, marked new{changes.gone.length ? `; ${changes.gone.length} no longer found` : ''}.
        </p>
      )}
      {changes?.gone?.length > 0 && (
        <details className="mt-1 text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-ink">No longer found ({changes.gone.length})</summary>
          <ul className="mt-1.5 space-y-1 border-l border-line pl-3">
            {changes.gone.slice(0, 30).map((f) => <li key={f.id || f.url}><ExternalLink href={f.url} className="hover:text-brand-600 hover:underline">{f.title}</ExternalLink> · {f.sourceLabel}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}

// ------------------------------------------------------------ screens, parties, timeline
const SCREEN_CHIP = {
  clear: ['chip chip-good', () => 'No match'],
  records: ['chip chip-warn', (s) => `${s.records} record${s.records === 1 ? '' : 's'}`],
  'name-only': ['chip', (s) => `${s.nameOnly} name match${s.nameOnly === 1 ? '' : 'es'} to rule out`],
  partial: ['chip chip-warn', () => 'No match, answered in part'],
  failed: ['chip chip-warn', () => 'Did not answer'],
  'not-run': ['chip', () => 'Not reached in this run'],
  off: ['chip', () => 'Not enabled on this deployment'],
};

/** Every public-record screen that ran, with its result, so a clean screen is seen and a silent one is not mistaken for clean. */
function Screens({ screens }) {
  const total = screens.reduce((n, g) => n + g.items.length, 0);
  return (
    <Block title="Public-record screens" id="screens" count={total} open note={<p className="muted mb-3 text-xs">Government, court, watchlist and breach sources asked in this check. “No match” means the source answered and holds no record under this name or company; it is not proof of a clean record.</p>}>
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {screens.map((g) => (
          <div key={g.group}>
            <p className="eyebrow mb-1.5">{g.group}</p>
            <ul className="space-y-1.5 text-sm">
              {g.items.map((s) => {
                const [tone, text] = SCREEN_CHIP[s.status] || SCREEN_CHIP.failed;
                return (
                  // The result wraps under a long source name instead of squeezing it to one word a line
                  // (seen in a real browser on a screen with three citations).
                  <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="min-w-[11rem] flex-1 text-ink">{s.label}</span>
                    <span className="flex flex-wrap items-baseline justify-end gap-1 text-right">
                      <span className={tone}>{text(s)}</span>
                      {s.incomplete && (s.status === 'records' || s.status === 'name-only') && <span className="chip chip-warn ml-1">answered in part</span>}
                      {(s.status === 'records' || s.status === 'name-only') && <Cites ns={s.cites} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Block>
  );
}

function RelatedParties({ parties, name }) {
  const screenFlag = parties.some((p) => typeof p.screened === 'boolean');
  return (
    <Block title="Related parties" count={parties.length} note={<p className="muted mb-3 text-xs">{relatedNote(parties, name)}</p>}>
      <ul className="divide-y divide-line">
        {parties.map((p) => (
          <li key={p.name} className="py-2.5 text-sm first:pt-0 last:pb-0">
            <span className="font-medium text-ink">{p.name}</span>
            <span className="chip ml-2">{p.relation || (p.kind === 'associate' ? 'associate' : 'relative')}</span>
            {screenFlag && p.screened !== true && (
              p.screenedInPart
                ? <span className="chip chip-warn ml-2" title={p.missedScreens?.length ? `Did not answer: ${p.missedScreens.join(', ')}` : undefined}>screened in part</span>
                : <span className="chip chip-warn ml-2" title={p.missedScreens?.length ? `Did not answer: ${p.missedScreens.join(', ')}` : 'No watchlist lookup ran for this person before the check ended.'}>not screened in this run</span>
            )}
            {p.role && <span className="ml-2 text-muted">{p.role}</span>}
            {p.why && <span className="block text-xs text-muted">{p.why}</span>}
            {p.missedScreens?.length > 0 && <span className="block text-xs text-muted">Not answered for them: {p.missedScreens.join(', ')}.</span>}
            {p.records?.length > 0 && (
              <span className="mt-1 block text-xs text-slate-700">
                {p.records.map((r) => <a key={r.n} href={`#deep-source-${r.n}`} className="cite mr-1" title={r.title}>[{r.n}]</a>)}
                {p.records.some((r) => r.severity === 'high' || r.severity === 'medium') ? 'records to review' : 'records found'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Block>
  );
}

function Timeline({ items, omitted = 0 }) {
  return (
    <Block title="Timeline from dated records" count={items.length} note={omitted > 0 ? <p className="muted mb-3 text-xs">{omitted} more dated record{omitted === 1 ? ' is' : 's are'} left off the timeline.</p> : null}>
      <ol className="relative ml-2 border-l border-line pl-6">
        {items.map((t, i) => (
          <li key={`${t.n ?? t.title}-${i}`} className="relative pb-4 last:pb-0">
            <span className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-white bg-brand-500 ring-1 ring-brand-200" aria-hidden="true" />
            <span className="text-sm font-semibold text-brand-700">{t.date}</span>
            <span className="ml-2 text-sm text-slate-700">{t.title}</span>
            {t.cites?.length ? <Cites ns={t.cites} /> : Number.isFinite(t.n) ? <a href={`#deep-source-${t.n}`} className="cite ml-1">[{t.n}]</a> : null}
          </li>
        ))}
      </ol>
    </Block>
  );
}

// ------------------------------------------------------------ coverage
function Coverage({ report }) {
  const { coverage } = report;
  const omitted = report.omitted || {};
  const left = [
    omitted.leads > 0 && `${omitted.leads} lead${omitted.leads === 1 ? '' : 's'} to confirm past the first twelve`,
    omitted.placeholder > 0 && `${omitted.placeholder} page${omitted.placeholder === 1 ? '' : 's'} holding only template text`,
    omitted.wikiOther > 0 && `${omitted.wikiOther} encyclopedia entr${omitted.wikiOther === 1 ? 'y' : 'ies'} about other people`,
  ].filter(Boolean);
  return (
    <Block title="What was searched" id="coverage" count={coverage.searched.length}>
      <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {coverage.searched.map((s) => (
          <li key={s.id} className="flex items-baseline justify-between gap-3">
            <span className="text-ink">{s.label}</span>
            <span className="shrink-0 text-xs text-muted">{s.records} record{s.records === 1 ? '' : 's'} · {s.lookups} lookup{s.lookups === 1 ? '' : 's'}{s.failed ? ` · ${s.failed} failed` : ''}</span>
          </li>
        ))}
      </ul>
      {coverage.partlyAnswered?.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-1">Answered only in part</p>
          <ul className="space-y-1 text-sm text-muted">{coverage.partlyAnswered.map((s) => <li key={s.label}><span className="font-medium text-ink">{s.label}</span>: {s.reason}</li>)}</ul>
        </div>
      )}
      {coverage.notSearched.filter((s) => !s.off && !s.notRun).length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-1">Did not answer</p>
          <ul className="space-y-1 text-sm text-muted">{coverage.notSearched.filter((s) => !s.off && !s.notRun).map((s) => <li key={s.label}><span className="font-medium text-ink">{s.label}</span>: {s.reason}</li>)}</ul>
        </div>
      )}
      {coverage.notSearched.filter((s) => !s.off && s.notRun).length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-1">Not run before the check ended</p>
          <ul className="space-y-1 text-sm text-muted">{coverage.notSearched.filter((s) => !s.off && s.notRun).map((s) => <li key={s.label}><span className="font-medium text-ink">{s.label}</span></li>)}</ul>
        </div>
      )}
      {coverage.searchNote && <p className="mt-4 text-sm text-muted" data-testid="search-note">{coverage.searchNote}</p>}
      {coverage.notSearched.filter((s) => s.off).length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-1">Not enabled on this deployment</p>
          <ul className="space-y-1 text-sm text-muted">{coverage.notSearched.filter((s) => s.off).map((s) => <li key={s.label}><span className="font-medium text-ink">{s.label}</span></li>)}</ul>
        </div>
      )}
      {(coverage.givenCompanies || []).length > 0 && (
        <div className="mt-4" data-testid="given-companies">
          <p className="eyebrow mb-1">Earlier companies you gave</p>
          <ul className="space-y-1 text-sm text-muted">{coverage.givenCompanies.map((c) => <li key={c.name}><span className="font-medium text-ink">{c.name}</span>: {c.screened ? 'screened' : 'checked only for ties to the person'}</li>)}</ul>
        </div>
      )}
      <div className="mt-4">
        <p className="eyebrow mb-1">Not covered by the sources this check uses</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{(coverage.notCovered || []).map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
      {(coverage.dropped?.tasks > 0 || coverage.dropped?.findings > 0 || coverage.dropped?.threads > 0) && (
        <p className="mt-4 text-xs text-muted">
          Limits reached in this run: {[coverage.dropped.tasks && `${coverage.dropped.tasks} lookups not run`, coverage.dropped.findings && `${coverage.dropped.findings} records not kept`, coverage.dropped.threads && `${coverage.dropped.threads} threads not followed`].filter(Boolean).join(', ')}.
        </p>
      )}
      {left.length > 0 && <p className="mt-2 text-xs text-muted">Also left out of this report: {left.join('; ')}.</p>}
      {report.threads?.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-1">Threads followed</p>
          <ul className="space-y-1 text-sm text-muted">
            {report.threads.slice(0, 40).map((t, i) => (
              <li key={`${t.kind}-${t.value}-${i}`}>
                <span className="font-medium text-ink">{t.value}</span>{t.why ? `: ${t.why}` : ''}
                {t.suggested && <span className="chip ml-2">{t.label || 'suggested by the second reader'}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-muted">{report.notice}</p>
    </Block>
  );
}

// ------------------------------------------------------------ name-only records
function NameOnly({ items, wordOnly, company, reveal }) {
  const words = wordOnly?.count || 0;
  if (!items.length && !words) return null;
  return (
    <Block
      title="Name matches only"
      id="name-only"
      count={items.length}
      tone="chip chip-warn"
      note={(
        <div className="mb-3 space-y-1 text-xs text-muted">
          <p>Records that share the person’s name{company ? ' or the company’s name' : ''} and nothing else. They are not treated as being about this person; they are listed so you can rule them out.</p>
          {words > 0 && <p data-testid="word-only-count">{words} more record{words === 1 ? ' was' : 's were'} left out because {words === 1 ? 'it' : 'they'} matched only the ordinary word “{company}”, not the company.</p>}
        </div>
      )}
    >
      {items.length > 0 && <Records items={items} first={10} reveal={reveal} />}
      {wordOnly?.items?.length > 0 && (
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-ink">Left out: matched only the word ({wordOnly.items.length}{wordOnly.omitted ? ` of ${words}` : ''})</summary>
          <ul className="mt-1.5 space-y-1 border-l border-line pl-3">
            {wordOnly.items.map((w, i) => (
              <li key={`${w.url}-${i}`}>
                <ExternalLink href={w.url} className="hover:text-brand-600 hover:underline">{w.title}</ExternalLink>
                <span> · {w.sourceLabel}{w.date ? ` · ${w.date}` : ''}{w.reason ? ` · ${w.reason}` : ''}</span>
              </li>
            ))}
          </ul>
          {wordOnly.omitted > 0 && <p className="mt-1">{wordOnly.omitted} more not listed.</p>}
        </details>
      )}
    </Block>
  );
}

// ------------------------------------------------------------ the report
/** "RELATED PARTIES" -> "Related parties" */
const sectionName = (h) => { const t = String(h || '').replace(/^#+\s*/, '').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
/** The legal names the check learned that the company card does not already show. */
function legalNamesOnly(report) {
  const shown = new Set((report.companyFacts?.legalNames || []).map((x) => String(x.name || '').toLowerCase()));
  return [...new Set((report.legalNames || []).map((x) => String(x?.name || '').trim()).filter((n) => n && !shown.has(n.toLowerCase())))];
}

function Report({ report, fresh = null, children = null }) {
  const [reveal, setReveal] = useState(null);
  const [cite, setCite] = useState(null); // { n, at }
  const [back, setBack] = useState(null); // { y, at }
  const [filter, setFilter] = useState(NO_FILTER);
  const printing = usePrinting();
  // A printed or saved PDF is a memo: it holds every record, never a search the reader forgot was on.
  const view = printing ? NO_FILTER : filter;
  const root = useRef(null);
  const byNumber = useMemo(() => recordsByNumber(report), [report]);

  // A citation ([12]) opens a small card about its record; "Show in report" goes to the record.
  useEffect(() => {
    const onClick = (event) => {
      const link = event.target?.closest?.(SOURCE_LINK);
      if (!link || !root.current?.contains(link)) return;
      const n = Number(link.getAttribute('href').slice('#deep-source-'.length));
      if (!Number.isFinite(n)) return;
      event.preventDefault();
      setCite({ n, at: link });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  const closeCite = useCallback((refocus = true) => {
    setCite((c) => { if (refocus) c?.at?.focus?.(); return null; });
  }, []);
  const showRecord = () => {
    if (!cite) return;
    const { n, at } = cite;
    setBack({ y: typeof window !== 'undefined' ? window.scrollY : 0, at });
    setCite(null);
    setFilter(NO_FILTER); // a filter must not hide the record asked for
    setReveal({ n });
  };
  useEffect(() => {
    if (!reveal) return undefined;
    // the list shows the record on the next render when it was past the first few
    const t = setTimeout(() => {
      const target = document.getElementById(`deep-source-${reveal.n}`);
      if (target) {
        openBlockAround(target);
        for (let d = target.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
        setTimeout(() => {
          target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
          target.focus?.({ preventScroll: true });
        }, 0);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [reveal]);
  const goBack = () => {
    if (!back) return;
    if (typeof window !== 'undefined') window.scrollTo?.({ top: back.y, behavior: 'smooth' });
    back.at?.focus?.({ preventScroll: true });
    setBack(null);
  };
  const revealN = reveal?.n ?? null;

  const { coverage, briefInfo } = report;
  const confidence = briefInfo?.confidence;
  const held = report.ifRightPerson.length;
  // the chip's caveat about the screens alone: the block below says what is held "if this is the right person"
  const flagChip = redFlagChip({ ...report, ifRightPerson: [], totals: { ...(report.totals || {}), ifRightPerson: 0 } });
  const heldNote = held ? ` ${held} serious matter${held === 1 ? ' is' : 's are'} listed below under “If this is the right person”.` : '';
  // a record is listed once, even when two sections carry it
  const nameOnly = [...new Map(report.sections.flatMap((s) => s.items.filter((f) => f.match === 'possible')).map((f) => [f.id || f.n, f])).values()];
  const tiedSections = report.sections
    .map((s) => ({ ...s, items: s.items.filter((f) => f.match !== 'possible').map((f, i) => ({ f, i })).sort((a, b) => (MATCH_ORDER[a.f.match] ?? 3) - (MATCH_ORDER[b.f.match] ?? 3) || a.i - b.i).map(({ f }) => f) }))
    .filter((s) => s.items.length > 0);
  const allTied = [...new Map(tiedSections.flatMap((s) => s.items).map((f) => [f.n, f])).values()];
  const shownSections = tiedSections.map((s) => ({ ...s, items: filterRecords(s.items, view) })).filter((s) => s.items.length > 0);
  const shownCount = new Set(shownSections.flatMap((s) => s.items.map((f) => f.n))).size;

  return (
    <div ref={root} className="founder-report space-y-4">
      {children}

      {report.brief && (
        <section className="ai-card p-5" aria-label="Brief">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="section-title">Brief</h2>
            {briefInfo?.mode === 'ai' ? (
              <>
                <span className="ai-badge"><HiOutlineSparkles style={{ width: 13, height: 13 }} /> AI</span>
                {briefInfo.model && <span className="chip" title={briefInfo.provider ? `via ${briefInfo.provider}` : undefined}>{displayModel(briefInfo.model)}</span>}
                {confidence?.level && <span className={CONFIDENCE_CHIP[String(confidence.level).toLowerCase()] || 'chip'} title={confidence.reason || undefined}>{confidence.level} confidence</span>}
                {skippedNote(briefInfo.skipped) && <span className="text-xs text-muted">{skippedNote(briefInfo.skipped).replace(/^\s*·\s*/, '')}</span>}
              </>
            ) : (
              <span className="chip chip-active" title={briefInfo?.reason || undefined}>Assembled from the records</span>
            )}
          </div>
          <div
            className="founder-brief space-y-2 text-sm leading-relaxed text-slate-700"
            dangerouslySetInnerHTML={{ __html: briefHtml(report.brief, { anchor: 'deep-source' }) }}
          />
          {briefInfo?.mode === 'ai' && (
            <p className="mt-3 text-xs text-muted">
              AI-written; check it against the cited records. Each citation was checked to point to a record the model was shown, but not that the sentence reads the record rightly.
              {briefInfo.filledFromRecords?.length > 0 && ` Taken from the records rather than written by the model: ${briefInfo.filledFromRecords.map(sectionName).join(', ')}.`}
            </p>
          )}
        </section>
      )}

      <Block title="Red flags" id="red-flags" count={report.redFlags.length} tone={flagChip.tone} open>
        {report.redFlags.length === 0
          ? (
            <p className="muted">
              {!coverage
                ? `This saved report does not list which sources answered, so it cannot say that nothing was found.${heldNote} Run the check again for a full report.`
                : coverage.searched.length === 0
                  ? `No source answered, so nothing was checked. This says nothing about the person: run the check again.${heldNote}`
                  : `No serious record is tied to this person in the sources searched.${heldNote}${flagChip.tone === 'chip chip-good' ? '' : ` ${flagChip.title || ''}`} That is not proof of a clean record; see what was not covered below.`}
            </p>
          )
          : <Records items={report.redFlags} withId={false} fresh={fresh} />}
      </Block>

      {held > 0 && (
        <Block
          title="If this is the right person"
          count={report.ifRightPerson.length}
          tone="chip chip-warn"
          open
          note={<p className="muted mb-3 text-xs">Serious records tied to this person only through {report.assumedCompany ? `${report.assumedCompany}, a company the check assumed` : 'a company the check assumed'}, not through anything you typed. They hold only if this is the right person; confirm who they are first.</p>}
        >
          <Records items={report.ifRightPerson} withId={false} fresh={fresh} />
        </Block>
      )}

      {report.companyMatters?.length > 0 && (
        <Block
          title="About their companies"
          count={report.companyMatters.length}
          tone="chip chip-warn"
          open
          note={<p className="muted mb-3 text-xs">Serious records about a company this person founded or runs, where the record does not name them. Context for the company, not a finding about the person.</p>}
        >
          <Records items={report.companyMatters} first={8} withId={false} fresh={fresh} />
        </Block>
      )}

      {report.profile && <ProfileCard profile={report.profile} />}
      {report.companyFacts && <CompanyCard facts={report.companyFacts} company={report.company || report.profile?.company} />}
      {legalNamesOnly(report).length > 0 && (
        <p className="px-1 text-xs text-muted" data-testid="legal-names">
          Legal names of their company the check also searched under: {legalNamesOnly(report).join(', ')}.
        </p>
      )}
      {report.ownStatements?.length > 0 && (
        <Block title="Their own posts" count={report.ownStatements.length} note={<p className="muted mb-3 text-xs">What the person wrote themselves. Their own words, not records about them: read them for claims to confirm.</p>}>
          <Records items={report.ownStatements} withId={false} fresh={fresh} />
        </Block>
      )}
      {report.screens?.length > 0 && <Screens screens={report.screens} />}
      {report.network && <NetworkLinks network={report.network} name={report.name} company={report.company || report.assumedCompany || report.network?.seededCompany || ''} />}

      {report.claimChanges.length > 0 && (
        <Block title="Claims that changed over time" count={report.claimChanges.length} open note={<p className="muted mb-3 text-xs">Differences between archived versions of the same page.</p>}>
          <Records items={report.claimChanges} withId={false} fresh={fresh} />
        </Block>
      )}
      {report.relatedParties.length > 0 && <RelatedParties parties={report.relatedParties} name={report.name} />}
      {report.timeline.length > 0 && <Timeline items={report.timeline} omitted={report.omitted?.timeline || 0} />}

      {allTied.length > 0 && <RecordFilters value={filter} onChange={setFilter} items={allTied} shown={shownCount} />}
      {/* Records tied to the person or their company, by kind. Name-only matches are kept apart, below. */}
      {shownSections.map((s) => (
        <Block key={s.key} title={s.title} count={s.items.length} open={isFiltered(view)}>
          <Records items={s.items} first={15} reveal={revealN} fresh={fresh} />
        </Block>
      ))}
      {isFiltered(view) && shownSections.length === 0 && <p className="muted px-1 text-sm">No record matches these filters.</p>}

      {report.possibleNamesake.length > 0 && (
        <Block
          title="Possible namesakes to rule out"
          count={report.possibleNamesake.length}
          tone="chip chip-warn"
          note={<p className="muted mb-3 text-xs">Serious records that match the name only. They may be about a different person; confirm before relying on any of them.</p>}
        >
          <Records items={report.possibleNamesake} first={8} withId={false} />
        </Block>
      )}
      <NameOnly items={nameOnly} wordOnly={report.wordOnly} company={report.company} reveal={revealN} />

      {coverage ? <Coverage report={report} /> : (
        <Block title="What was searched" id="coverage">
          <p className="muted text-sm">This saved report does not list which sources answered. Run the check again for a full account of what was searched.</p>
          {report.notice && <p className="mt-4 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-muted">{report.notice}</p>}
        </Block>
      )}

      {cite && typeof document !== 'undefined' && createPortal(
        <CitationCard record={byNumber.get(cite.n) || null} n={cite.n} at={cite.at} onClose={closeCite} onShow={showRecord} />,
        document.body,
      )}
      {back && (
        <button type="button" className="founder-no-print btn-secondary fixed bottom-4 right-4 z-30 shadow-card" onClick={goBack}>
          <HiOutlineArrowUturnLeft style={{ width: 14, height: 14 }} /> Back to where you were
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------ the check
const IDLE = { phase: 'idle', progress: null, report: null, error: '', errorKind: '', needSignIn: false, note: '', assumed: null, confirm: null, changes: null, detailsUnused: '', replaced: false };

function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand?.('copy');
      area.remove();
      if (ok) resolve(); else reject(new Error('copy refused'));
    } catch (error) { reject(error); }
  });
}

/**
 * @param {object} props
 * @param {string} props.name the person
 * @param {string} [props.company]
 * @param {number} [props.runKey] changes when the same query is submitted again (a new check)
 * @param {string} [props.jobId] a check to reopen (a link from Recent checks or the Network Map)
 * @param {object} [props.details] optional start fields { website, profileUrl, place, otherCompanies, school, otherNames }
 * @param {(report: object|null) => void} [props.onReport] told when a report is on the page
 * @param {(jobId: string) => void} [props.onJob] told the id of the check on the page when it is not `jobId`
 *   (a new run, or the saved check picked up), so the page can put it in its address: a reload then opens
 *   this check, not the one the link named
 */
export default function DeepCheck({ name, company = '', runKey = 0, jobId = null, details = null, onReport = null, onJob = null }) {
  const { status } = useSession();
  const [state, setState] = useState(IDLE);
  const [printing, setPrinting] = useState(false);
  const [copied, setCopied] = useState(false);
  const active = useRef(0);
  const last = useRef({ name, company, runKey, jobId, status: undefined });
  const jobIdRef = useRef(jobId);
  jobIdRef.current = jobId;
  const following = useRef(null); // the check this page is showing or following
  const onJobRef = useRef(onJob);
  onJobRef.current = onJob;
  const reportRef = useRef(null);
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const onReportRef = useRef(onReport);
  onReportRef.current = onReport;
  reportRef.current = state.report;

  const run = useCallback(async ({ fresh = false, extra = {} } = {}) => {
    const token = active.current + 1;
    active.current = token;
    const alive = () => active.current === token;
    const before = fresh ? reportRef.current : null;
    // "Run again" keeps the report on screen until the new one is ready.
    setState((s) => ({ ...IDLE, phase: 'running', report: before ? s.report : null, assumed: before ? s.assumed : null }));
    const onRetry = () => { if (alive()) setState((s) => ({ ...s, note: 'The connection dropped. The check is saved; trying again…' })); };
    try {
      let data = null;
      let reopened = false;
      if (!fresh) {
        // The check this page already has for the person: the link's, this browser's, then the account's latest.
        // Each read is tried patiently: a page reopened while offline must not start a second check.
        const linked = jobIdRef.current;
        if (linked) data = await patiently(() => readJob(linked), { onRetry }).catch((e) => { if (e.status === 401) throw e; return null; });
        const saved = !data && savedJob(name, company);
        if (saved) {
          data = await patiently(() => readJob(saved), { onRetry }).catch((e) => { if (e.status === 401) throw e; return null; });
          if (!data) forgetJob(name, company);
        }
        if (!data && name) {
          data = await patiently(() => latestJob(name, company), { onRetry }).catch((e) => { if (e.status === 401 || e.status === 400) throw e; return null; });
        }
        if (!alive()) return;
        reopened = Boolean(data);
      }
      if (!data) {
        // With no company typed, the server may know one contact with this name: it asks first (needsConfirm)
        // and uses that company only after a yes, so a namesake in the network never decides who is checked.
        const ask = !String(company || '').trim() && !extra.confirmedCompany && extra.useNetworkCompany !== false ? { askNetwork: true } : {};
        data = await patiently(() => startJob(name, company, { ...detailsBody(detailsRef.current || {}), ...ask, ...extra }), { onRetry });
        if (!alive()) return;
        if (data.needsConfirm && !data.jobId) {
          setState((s) => ({ ...s, phase: 'confirm', confirm: data.needsConfirm }));
          return;
        }
        // The server stopped a check of this person that was still running with other details and started this
        // one with the new details. Say so, and forget the earlier check's saved id so it is never reopened here.
        if (data.replaced) {
          forgetJob(name, company);
          setState((s) => ({ ...s, replaced: true }));
        }
      }
      const id = data.jobId;
      if (id) {
        following.current = id;
        if (id !== jobIdRef.current) onJobRef.current?.(id);
      }
      // A saved check reopened while details are typed: say whether they went into it, never silently drop them.
      const unused = reopened && id ? detailsUse(id, detailsRef.current) : '';
      const detailsUnused = unused === 'unused' || unused === 'unknown' ? unused : '';
      if (data.assumed?.company) setState((s) => ({ ...s, assumed: data.assumed.company }));
      // A check may wait minutes for a source's allowance: give up after a time limit, not a number of steps
      const until = Date.now() + 25 * 60 * 1000;
      let lastRun = -1;
      while (Date.now() < until && alive() && !data.done && !data.failed) {
        if (id) rememberJob(name || data.report?.name, company, id);
        setState((s) => ({ ...s, progress: data.progress || s.progress, note: '' }));
        const ran = data.progress?.tasksRun ?? -1;
        if (ran === lastRun) await wait(5000); // nothing ran in that step: lookups are waiting for a resting source
        lastRun = ran;
        data = await step(id, 'step', { onRetry });
      }
      if (!alive()) return;
      if (data.failed) {
        const error = new Error(data.error || 'The check could not be finished.');
        error.failed = true;
        throw error;
      }
      // The written summary can outlast the first model's time on a long report: one more try with the next models
      if (data.done && data.report?.briefInfo?.retry) {
        setState((s) => ({ ...s, progress: { ...(data.progress || {}), phase: 'report' } }));
        const again = await step(id, 'brief').catch(() => null);
        if (!alive()) return;
        if (again?.done) data = again;
      }
      if (data.done) {
        const changes = before ? { ...compareReports(before, data.report), since: before.generatedAt } : null;
        setState((s) => ({ ...IDLE, phase: 'done', progress: data.progress, report: data.report, assumed: s.assumed, changes, detailsUnused, replaced: s.replaced }));
        onReportRef.current?.(data.report);
      } else {
        setState((s) => ({ ...s, phase: 'error', errorKind: 'resume', error: 'The check is still running on the server. Open this page again later to see it, or pick it up now.' }));
      }
    } catch (error) {
      if (!alive()) return;
      const kind = error.status === 401 ? 'signin'
        : error.status === 429 ? 'limit'
          : error.status === 400 ? 'input'
            : error.failed ? 'failed'
              : 'resume';
      const message = kind === 'limit' ? limitMessage(error.retryAfter)
        : kind === 'resume' && !error.status ? 'The connection to the server was lost. The check is saved on the server; pick it up when you are back online.'
          : error.message || 'The deep check failed.';
      setState((s) => ({ ...s, phase: s.report ? 'done' : 'error', errorKind: kind, error: message, needSignIn: kind === 'signin', note: '' }));
    }
  }, [name, company]);

  // A new name starts a check (or picks up the one saved for it); the same name and company submitted
  // again start a new one. A visitor who is not signed in is asked to sign in when the server says so
  // (a site can let anyone run checks).
  // A check id put in the address for the check already on the page (onJob) changes nothing: the page keeps
  // following it, and the report on screen stays.
  useEffect(() => {
    if ((!name && !jobId) || status === 'loading') { active.current += 1; return; }
    const before = last.current;
    last.current = { name, company, runKey, jobId, status };
    const onlyTheId = before.name === name && before.company === company && before.runKey === runKey && before.status === status && before.jobId !== jobId;
    if (onlyTheId && jobId && jobId === following.current) return;
    active.current += 1; // stop any check still running for the previous name
    run({ fresh: before.name === name && before.company === company && before.runKey !== runKey });
  }, [name, company, runKey, jobId, status, run]);
  useEffect(() => () => { active.current += 1; }, []); // leaving the page stops following

  // When the report arrives, take keyboard focus to it unless the visitor is busy elsewhere on the page.
  useEffect(() => {
    if (state.phase !== 'done' || typeof document === 'undefined') return;
    const at = document.activeElement;
    if (!at || at === document.body) document.querySelector('[data-report-heading]')?.focus();
  }, [state.phase]);

  // Printing opens every section and lists every record, whether from the button or the browser's own menu.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, []);
  const print = () => {
    flushSync(() => setPrinting(true));
    try { window.print?.(); } finally { setTimeout(() => setPrinting(false), 0); }
  };
  const copy = () => {
    copyText(reportAsText(state.report)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }).catch(() => setCopied(false));
  };

  if (!name && !jobId) return null;
  const announce = state.phase === 'done' && state.report && !state.error
    ? `Deep check finished: ${state.report.totals?.records ?? 0} records, ${redFlagChip(state.report).text}.`
    : '';
  // The status line stays on the page through every phase, so the end of a check is announced.
  return (
    <PrintContext.Provider value={printing}>
      <p role="status" className="sr-only">{announce}</p>
      {body()}
    </PrintContext.Provider>
  );

  function replacedNote() {
    if (!state.replaced) return null;
    return (
      <p className="founder-no-print rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-muted" data-testid="check-replaced">
        A check of {name || 'this person'} was already running with other details. It was stopped, and this new check uses the details you gave now.
      </p>
    );
  }

  function errorCard() {
    const kind = state.errorKind;
    return (
      <section className="founder-no-print card card-pad">
        <h2 className="section-title">Deep background check</h2>
        <p className="mt-1 text-sm text-rose-700" role="alert">{state.error}</p>
        {kind === 'input' && <p className="muted mt-1 text-sm">Change the details in the form above and run the check again.</p>}
        {kind === 'resume' && (
          <button type="button" className="btn-secondary mt-3" onClick={() => run()}><HiOutlineArrowPath style={{ width: 14, height: 14 }} /> Try again</button>
        )}
        {kind === 'failed' && (
          <button type="button" className="btn-secondary mt-3" onClick={() => run({ fresh: true })}><HiOutlineArrowPath style={{ width: 14, height: 14 }} /> Run the check again</button>
        )}
      </section>
    );
  }

  function body() {
    if (state.needSignIn) {
      return (
        <section className="card card-pad">
          <div className="flex flex-wrap items-center gap-2">
            <HiOutlineShieldCheck className="text-brand-500" style={{ width: 16, height: 16 }} />
            <h2 className="section-title">Deep background check</h2>
          </div>
          <p className="muted mt-1">
            Courts and regulators, sanctions and watchlists, archived versions of profiles and bios, company and patent records, related parties, and published leak databases, pulled thread by thread.{' '}
            <a href={signInHref()} className="font-medium text-brand-600 hover:underline">Sign in to run it</a>.
          </p>
        </section>
      );
    }
    if (state.phase === 'confirm' && state.confirm) {
      const co = state.confirm.company;
      return (
        <section className="card card-pad">
          <h2 className="section-title">Deep background check</h2>
          <p className="mt-1 text-sm text-ink">{state.confirm.question || `Is this the ${name} at ${co} in your network?`}</p>
          <p className="muted mt-1 text-xs">If yes, the check starts from {co}. If not, it runs on the name alone.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => run({ fresh: true, extra: { confirmedCompany: co } })}>Yes, use {co}</button>
            <button type="button" className="btn-secondary" onClick={() => run({ fresh: true, extra: { useNetworkCompany: false } })}>No, run on the name alone</button>
          </div>
        </section>
      );
    }
    const report = savedReport(state.report); // a report saved before a field was added renders too
    if (!report) {
      if (state.phase === 'running') return <div className="space-y-4">{replacedNote()}<Progress progress={state.progress} name={name} note={state.note} /></div>;
      if (state.phase === 'error') return errorCard();
      return null;
    }
    const running = state.phase === 'running';
    return (
      <div className="space-y-4">
        {replacedNote()}
        {running && <Progress progress={state.progress} name={name} note={state.note} compact />}
        {state.error && errorCard()}
        {state.detailsUnused && !running && (
          <section className="founder-no-print card card-pad" data-testid="details-unused">
            <p className="text-sm text-ink">
              {state.detailsUnused === 'unused'
                ? `This is the check from ${formatWhen(report.generatedAt) || 'earlier'}; the details you added were not used in it.`
                : `This is the check from ${formatWhen(report.generatedAt) || 'earlier'}, opened as it was saved; the details you added may not have been used in it.`}
            </p>
            <button type="button" className="btn-secondary mt-3" onClick={() => run({ fresh: true })}>
              <HiOutlineArrowPath style={{ width: 14, height: 14 }} /> Run again with them
            </button>
          </section>
        )}
        <Report report={report} fresh={state.changes?.fresh || null}>
          <Summary
            report={report}
            onPrint={print}
            onCopy={copy}
            copied={copied}
            onRerun={() => run({ fresh: true })}
            rerunning={running}
            assumed={state.assumed}
            onRunWithout={state.assumed || report.network?.seededCompany ? () => run({ fresh: true, extra: { useNetworkCompany: false } }) : null}
            changes={state.changes}
          />
        </Report>
      </div>
    );
  }
}
