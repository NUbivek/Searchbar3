/**
 * Deep background check on the Founder Check page.
 *
 * A deep check takes minutes, so the page asks the server for it one step
 * at a time (POST /api/founder/deep) and shows what is happening: the round,
 * how many lookups have run, what was found, which threads are being
 * pulled. When collecting is over it shows the report: the brief, red
 * flags, possible namesakes, claims that changed between archived versions,
 * a timeline, related parties, every record by kind, and what was and was
 * not searched.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { HiOutlineSparkles, HiOutlineShieldCheck, HiOutlineArrowPath, HiOutlineArrowTopRightOnSquare } from 'react-icons/hi2';
import { renderSafeHtml } from '../search/results/SimplifiedLLMResults';
import { skippedNote } from '../../utils/skippedNote';

const MATCH = {
  confirmed: { label: 'same person', chip: 'chip chip-good', title: 'The record names this person together with a company known to be theirs.' },
  likely: { label: 'likely same person', chip: 'chip chip-active', title: 'The record names this person together with a school, associate or handle known to be theirs.' },
  company: { label: 'company', chip: 'chip', title: 'About the company, not the person.' },
  possible: { label: 'name match only', chip: 'chip chip-warn', title: 'Only the name matches. This may be a different person with the same name.' },
};
const SEVERITY = { high: { label: 'serious', chip: 'chip chip-bad' }, medium: { label: 'notable', chip: 'chip chip-warn' }, low: { label: 'minor', chip: 'chip' } };
const CONFIDENCE_CHIP = { high: 'chip chip-good', medium: 'chip chip-warn', low: 'chip chip-bad' };
const KIND_LABEL = { company: 'Companies', school: 'Schools', associate: 'Associates', relative: 'Relatives in public roles', handle: 'Handles', domain: 'Domains', url: 'Pages' };

async function call(body) {
  const r = await fetch('/api/founder/deep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(data.error || `Request failed (${r.status})`);
    error.status = r.status;
    throw error;
  }
  return data;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One step, retried when the server hiccups: the check's state is saved between steps, so a retry loses nothing. */
async function step(jobId) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call({ action: 'step', jobId });
    } catch (error) {
      const transient = !error.status || error.status >= 500;
      if (!transient || attempt >= 2) throw error;
      await wait(1500 * (attempt + 1));
    }
  }
}

// A check that is running or just finished is picked up again after a reload instead of being started from scratch.
const RESUME_MINUTES = 30;
const resumeKey = (name, company) => `deep-check:${String(name).toLowerCase()}|${String(company).toLowerCase()}`;
function savedJob(name, company) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(resumeKey(name, company)) || 'null');
    return saved && Date.now() - saved.at < RESUME_MINUTES * 60000 ? saved.jobId : null;
  } catch {
    return null;
  }
}
function rememberJob(name, company, jobId) {
  try { window.sessionStorage.setItem(resumeKey(name, company), JSON.stringify({ jobId, at: Date.now() })); } catch { /* private window: nothing to remember */ }
}
async function resume(jobId) {
  const r = await fetch(`/api/founder/deep?jobId=${encodeURIComponent(jobId)}`);
  return r.ok ? r.json() : null;
}

function Record({ f }) {
  const m = MATCH[f.match] || MATCH.possible;
  const s = SEVERITY[f.severity];
  return (
    <li id={`deep-source-${f.n}`} className="scroll-mt-24 py-3 first:pt-0 last:pb-0">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="cite">[{f.n}]</span>
        {s && <span className={s.chip}>{s.label}</span>}
        <span className={m.chip} title={m.title}>{m.label}</span>
        {f.corroboration > 1 && <span className="chip" title="Independent sources reporting the same thing">{f.corroboration} sources agree</span>}
        <span className="text-xs text-muted">{f.sourceLabel}{f.date ? ` · ${f.date}` : ''}</span>
      </div>
      <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" className="text-sm font-medium text-ink hover:text-brand-600 hover:underline">
        {f.title} <HiOutlineArrowTopRightOnSquare className="inline align-text-top text-muted" style={{ width: 12, height: 12 }} />
      </a>
      {f.quote && <p className="mt-1 text-sm leading-relaxed text-slate-700">&ldquo;{f.quote}&rdquo;</p>}
      {f.matchReasons?.length > 0 && f.match !== 'company' && <p className="mt-1 text-xs text-muted">Matched because the record {f.matchReasons.join(', ')}.</p>}
      {f.more?.length > 0 && (
        <details className="mt-1.5 text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-ink">{f.more.length} more record{f.more.length === 1 ? '' : 's'} on the same matter</summary>
          <ul className="mt-1.5 space-y-1 border-l border-line pl-3">
            {f.more.map((m) => (
              <li key={m.n}>
                <a href={`#deep-source-${m.n}`} className="cite mr-1">[{m.n}]</a>
                <a href={m.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-brand-600 hover:underline">{m.title}</a>
                <span> · {m.sourceLabel}{m.date ? ` · ${m.date}` : ''}{m.match === 'possible' ? ' · name match only' : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** A long list of records: the first few, and the rest on request (a report can hold hundreds). */
function Records({ items, first = 12 }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, first);
  return (
    <>
      <ul className="divide-y divide-line">{shown.map((f) => <Record key={f.id} f={f} />)}</ul>
      {items.length > first && (
        <button type="button" className="btn-ghost mt-3 px-2 py-1 text-xs" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}

function Block({ title, count, children, open = false, note = null, tone = null }) {
  return (
    <details className="card card-pad group" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <h2 className="section-title">{title}</h2>
        {typeof count === 'number' && <span className={tone || 'chip'}>{count}</span>}
        <span className="ml-auto text-xs text-muted group-open:hidden">Show</span>
        <span className="ml-auto hidden text-xs text-muted group-open:inline">Hide</span>
      </summary>
      <div className="mt-3">
        {note}
        {children}
      </div>
    </details>
  );
}

function Progress({ progress, name }) {
  const total = (progress?.tasksRun || 0) + (progress?.queued || 0);
  const pct = progress?.phase === 'collect' ? Math.min(96, Math.round(((progress?.tasksRun || 0) / Math.max(1, total)) * 100)) : 98;
  const threads = Object.entries(progress?.threads || {});
  const log = (progress?.log || []).slice(-4);
  return (
    <section className="card card-pad" aria-live="polite" aria-busy="true">
      <div className="flex flex-wrap items-center gap-2">
        <HiOutlineSparkles className="animate-glow text-brand-500" style={{ width: 16, height: 16 }} />
        <h2 className="section-title">Deep background check</h2>
        <span className="chip">{progress?.phase === 'collect' ? `round ${(progress?.step || 0) + 1}` : 'writing the report'}</span>
        <span className="ml-auto text-xs text-muted">{progress ? `${progress.tasksRun} lookups · ${progress.findings} records` : `Starting on ${name}…`}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-brand-500 transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      {threads.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          Pulling threads:
          {threads.map(([kind, n]) => <span key={kind} className="chip">{n} {(KIND_LABEL[kind] || kind).toLowerCase()}</span>)}
        </p>
      )}
      {log.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {log.map((l, i) => <li key={`${l.step}-${i}`}>{l.text}</li>)}
        </ul>
      )}
      <p className="muted mt-3 text-xs">A full check takes a few minutes. The quick brief below is ready sooner.</p>
    </section>
  );
}

function Report({ report, onRerun }) {
  const { totals, coverage, briefInfo } = report;
  const confidence = briefInfo?.confidence;
  return (
    <>
      <section className="ai-card p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="ai-badge"><HiOutlineShieldCheck style={{ width: 13, height: 13 }} /> Deep background check</span>
          {briefInfo?.mode === 'ai' ? (
            <>
              {briefInfo.model && <span className="chip" title={briefInfo.provider ? `via ${briefInfo.provider}` : undefined}>{briefInfo.model}</span>}
              {confidence?.level && <span className={CONFIDENCE_CHIP[String(confidence.level).toLowerCase()] || 'chip'} title={confidence.reason || undefined}>{confidence.level} confidence</span>}
              {skippedNote(briefInfo.skipped) && <span className="text-xs text-muted">{skippedNote(briefInfo.skipped).replace(/^\s*·\s*/, '')}</span>}
            </>
          ) : (
            <span className="chip chip-active" title={briefInfo?.reason || undefined}>Assembled from the records</span>
          )}
          <button type="button" onClick={onRerun} className="btn-ghost ml-auto px-2 py-1 text-xs"><HiOutlineArrowPath style={{ width: 13, height: 13 }} /> Run again</button>
        </div>
        <h2 className="text-lg font-semibold tracking-tight text-ink">
          {report.name}{report.company ? <span className="font-normal text-muted"> · {report.company}</span> : null}
        </h2>
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span className="chip">{totals.records} records</span>
          <span className="chip chip-good">{totals.confirmed + totals.likely} tied to this person</span>
          {totals.company > 0 && <span className="chip">{totals.company} about the company</span>}
          {totals.possible > 0 && <span className="chip chip-warn">{totals.possible} name match only</span>}
          <span className={totals.redFlags ? 'chip chip-bad' : coverage.searched.length ? 'chip chip-good' : 'chip chip-warn'} title={totals.seriousRecords ? `${totals.seriousRecords} serious records, grouped by matter` : undefined}>{totals.redFlags} red flag{totals.redFlags === 1 ? '' : 's'}</span>
          <span>{coverage.lookups} lookups in {coverage.rounds} rounds across {coverage.searched.length} sources</span>
        </p>
        {report.identity?.note && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">{report.identity.note}</p>}
        {report.brief && (
          <div
            className="founder-brief mt-3 space-y-2 text-sm leading-relaxed text-slate-700 [&_a]:cite"
            dangerouslySetInnerHTML={{ __html: renderSafeHtml(String(report.brief).replace(/\[Source (\d+)\]/g, '[[$1]](#deep-source-$1)')) }}
          />
        )}
      </section>

      <Block title="Red flags" count={report.redFlags.length} tone={report.redFlags.length ? 'chip chip-bad' : coverage.searched.length ? 'chip chip-good' : 'chip chip-warn'} open>
        {report.redFlags.length === 0
          ? (
            <p className="muted">
              {coverage.searched.length === 0
                ? 'No source answered, so nothing was checked. This says nothing about the person: run the check again.'
                : 'No serious record is tied to this person in the sources searched. That is not proof of a clean record; see what was not covered below.'}
            </p>
          )
          : <Records items={report.redFlags} />}
      </Block>

      {report.companyMatters?.length > 0 && (
        <Block
          title="About their companies"
          count={report.companyMatters.length}
          tone="chip chip-warn"
          note={<p className="muted mb-3 text-xs">Serious records about a company this person founded or runs, where the record does not name them. Context for the company, not a finding about the person.</p>}
        >
          <Records items={report.companyMatters} first={8} />
        </Block>
      )}

      {report.possibleNamesake.length > 0 && (
        <Block
          title="Possible namesakes to rule out"
          count={report.possibleNamesake.length}
          tone="chip chip-warn"
          note={<p className="muted mb-3 text-xs">Serious records that match the name only. They may be about a different person; confirm before relying on any of them.</p>}
        >
          <Records items={report.possibleNamesake} first={8} />
        </Block>
      )}

      {report.claimChanges.length > 0 && (
        <Block title="Claims that changed over time" count={report.claimChanges.length} open note={<p className="muted mb-3 text-xs">Differences between archived versions of the same page.</p>}>
          <Records items={report.claimChanges} />
        </Block>
      )}

      {report.relatedParties.length > 0 && (
        <Block title="Related parties" count={report.relatedParties.length} note={<p className="muted mb-3 text-xs">Associates, and relatives who hold a business, political or philanthropic role in the public record. Each was screened against watchlists and searched together with {report.name}.</p>}>
          <ul className="divide-y divide-line">
            {report.relatedParties.map((p) => (
              <li key={p.name} className="py-2.5 first:pt-0 last:pb-0 text-sm">
                <span className="font-medium text-ink">{p.name}</span>
                <span className="ml-2 chip">{p.relation || (p.kind === 'associate' ? 'associate' : 'relative')}</span>
                {p.role && <span className="ml-2 text-muted">{p.role}</span>}
                {p.why && <span className="block text-xs text-muted">{p.why}</span>}
                {p.records.length > 0 && (
                  <span className="mt-1 block text-xs text-slate-700">
                    {p.records.map((r) => <a key={r.n} href={`#deep-source-${r.n}`} className="cite mr-1" title={r.title}>[{r.n}]</a>)}
                    {p.records.some((r) => r.severity === 'high' || r.severity === 'medium') ? 'records to review' : 'records found'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {report.timeline.length > 0 && (
        <Block title="Timeline from dated records" count={report.timeline.length}>
          <ol className="relative ml-2 border-l border-line pl-6">
            {report.timeline.map((t, i) => (
              <li key={`${t.n}-${i}`} className="relative pb-4 last:pb-0">
                <span className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-white bg-brand-500 ring-1 ring-brand-200" aria-hidden="true" />
                <span className="text-sm font-semibold text-brand-700">{t.date}</span>
                <span className="ml-2 text-sm text-slate-700">{t.title}</span>
                <a href={`#deep-source-${t.n}`} className="cite ml-1">[{t.n}]</a>
              </li>
            ))}
          </ol>
        </Block>
      )}

      {report.sections.map((s) => (
        <Block key={s.key} title={s.title} count={s.items.length}>
          <Records items={s.items} first={15} />
        </Block>
      ))}

      <Block title="What was searched" count={coverage.searched.length}>
        <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {coverage.searched.map((s) => (
            <li key={s.id} className="flex items-baseline justify-between gap-3">
              <span className="text-ink">{s.label}</span>
              <span className="shrink-0 text-xs text-muted">{s.records} record{s.records === 1 ? '' : 's'} · {s.lookups} lookup{s.lookups === 1 ? '' : 's'}{s.failed ? ` · ${s.failed} failed` : ''}</span>
            </li>
          ))}
        </ul>
        {coverage.notSearched.length > 0 && (
          <div className="mt-4">
            <p className="eyebrow mb-1">Did not answer</p>
            <ul className="space-y-1 text-sm text-muted">{coverage.notSearched.map((s) => <li key={s.label}><span className="font-medium text-ink">{s.label}</span>: {s.reason}</li>)}</ul>
          </div>
        )}
        <div className="mt-4">
          <p className="eyebrow mb-1">Not covered by any free source</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{coverage.notCovered.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
        {(coverage.dropped.tasks > 0 || coverage.dropped.findings > 0 || coverage.dropped.threads > 0) && (
          <p className="mt-4 text-xs text-muted">
            Limits reached in this run: {[coverage.dropped.tasks && `${coverage.dropped.tasks} lookups not run`, coverage.dropped.findings && `${coverage.dropped.findings} records not kept`, coverage.dropped.threads && `${coverage.dropped.threads} threads not followed`].filter(Boolean).join(', ')}.
          </p>
        )}
        <p className="mt-4 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-muted">{report.notice}</p>
      </Block>
    </>
  );
}

export default function DeepCheck({ name, company = '', runKey = 0 }) {
  const { status } = useSession();
  const [state, setState] = useState({ phase: 'idle', progress: null, report: null, error: '', needSignIn: false });
  const active = useRef(0);

  const run = useCallback(async ({ fresh = false } = {}) => {
    const token = active.current + 1;
    active.current = token;
    const alive = () => active.current === token;
    setState({ phase: 'running', progress: null, report: null, error: '', needSignIn: false });
    try {
      const saved = fresh ? null : savedJob(name, company);
      let data = saved ? await resume(saved).catch(() => null) : null;
      if (!data) {
        data = await call({ action: 'start', name, company });
        rememberJob(name, company, data.jobId);
      }
      const { jobId } = data;
      for (let i = 0; i < 40 && alive(); i += 1) {
        if (data.done) break;
        setState((s) => ({ ...s, progress: data.progress }));
        data = await step(jobId);
      }
      if (!alive()) return;
      if (data.done) setState({ phase: 'done', progress: data.progress, report: data.report, error: '', needSignIn: false });
      else setState((s) => ({ ...s, phase: 'error', error: 'The check did not finish. Run it again.' }));
    } catch (error) {
      if (!alive()) return;
      setState((s) => ({ ...s, phase: 'error', error: error.message || 'The deep check failed.', needSignIn: error.status === 401 }));
    }
  }, [name, company]);

  // A new name (or "run again") starts a new check once we know the visitor is signed in.
  useEffect(() => {
    active.current += 1; // stop any check still running for the previous name
    if (!name || status === 'loading') return undefined;
    if (status !== 'authenticated') { setState({ phase: 'idle', progress: null, report: null, error: '', needSignIn: true }); return undefined; }
    run();
    return () => { active.current += 1; };
  }, [name, company, runKey, status, run]);

  if (!name) return null;
  if (state.needSignIn) {
    return (
      <section className="card card-pad">
        <div className="flex flex-wrap items-center gap-2">
          <HiOutlineShieldCheck className="text-brand-500" style={{ width: 16, height: 16 }} />
          <h2 className="section-title">Deep background check</h2>
        </div>
        <p className="muted mt-1">
          Courts and regulators, sanctions and watchlists, archived versions of profiles and bios, company and patent records, related parties, and published leak databases, pulled thread by thread.{' '}
          <Link href="/signin" className="font-medium text-brand-600 hover:underline">Sign in to run it</Link>.
        </p>
      </section>
    );
  }
  if (state.phase === 'running') return <Progress progress={state.progress} name={name} />;
  if (state.phase === 'error') {
    return (
      <section className="card card-pad">
        <h2 className="section-title">Deep background check</h2>
        <p className="mt-1 text-sm text-rose-700" role="alert">{state.error}</p>
        <button type="button" className="btn-secondary mt-3" onClick={() => run()}><HiOutlineArrowPath style={{ width: 14, height: 14 }} /> Try again</button>
      </section>
    );
  }
  if (state.phase === 'done' && state.report) return <Report report={state.report} onRerun={() => run({ fresh: true })} />;
  return null;
}
