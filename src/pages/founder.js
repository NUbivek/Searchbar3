import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { HiOutlineSparkles, HiOutlineUserCircle, HiOutlineChevronDown } from 'react-icons/hi2';
import PageShell from '../components/layout/PageShell';
import NetworkHelpers from '../components/network/NetworkHelpers';
import DeepCheck, { displayModel } from '../components/founder/DeepCheck';
import { ExternalLink, SourceBadge } from '../components/founder/parts';
import { briefHtml } from '../components/founder/briefHtml';
import { keepDetails, keptDetails, recentJobs, detailsBody } from '../components/founder/jobs';
import { formatWhen } from '../components/founder/summary';
import { sectorKeywordsFrom } from '../utils/network/sectors';
import { normalizeCompanyKey, companyMatch, companyFormMatch } from '../utils/network/parseContacts';
import { skippedNote } from '../utils/skippedNote';

const EMPTY = 'Nothing found in available sources.';
const ICON = { width: 15, height: 15 };

// Scripts written without spaces between names: one word can be a full name.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
/**
 * Why this name cannot be checked, or '' when it can: a full name (first and last), or one word when a
 * company is given (someone known by one name) or the name is written in a script without spaces.
 */
export function nameProblem(name, company = '') {
  const n = String(name || '').trim();
  if (!n) return 'Enter the name of the person to check.';
  const tokens = n.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    if (UNSPACED.test(n) || String(company || '').trim()) return '';
    return 'Enter the full name (first and last name). For someone known by one name only, add their company too.';
  }
  if (!tokens.some((t) => t.replace(/[^\p{L}]/gu, '').length >= 2)) return 'Enter the name in full: initials alone match too many people.';
  return '';
}

/** Quick brief: POST keeps the name out of addresses and logs. */
async function quickCheck(body) {
  const r = await fetch('/api/founder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(data.error || `Request failed (${r.status})`);
    error.status = r.status;
    throw error;
  }
  return data;
}

/**
 * The same company written two ways, by the matcher the Network Map uses: equal names, a longer name holding
 * a two-word one as whole words, or only form words added ("Acme" and "Acme Inc."). Never a substring: "Ramp"
 * is not "Rampart Capital", and "X" is not "Exxon".
 */
export const sameCompany = (a, b) => {
  const x = normalizeCompanyKey(a);
  const y = normalizeCompanyKey(b);
  return Boolean(x && y) && Boolean(companyMatch(x, y) || companyFormMatch(x, y));
};

/** The quick brief's citation: "Q3", so it never reads like record 3 of the deep report. */
function Cite({ index, sources }) {
  const s = sources[index];
  if (!s) return null;
  return (
    <a href={`#source-${s.n}`} className="cite ml-1" title={`Quick brief source ${s.n}: ${s.sourceName}${s.date ? `, ${s.date}` : ''}: ${s.title}`}>
      [Q{s.n}]
    </a>
  );
}

function Flag({ item }) {
  if (item.companyUnknown) {
    return (
      <span className="chip ml-2" title="Headline-only source: it cannot confirm the company.">
        headline only
      </span>
    );
  }
  return null;
}

function Quote({ item, sources }) {
  return (
    <p className="text-sm leading-relaxed text-slate-700">
      <span>&ldquo;{item.quote}&rdquo;</span>
      {item.headline && <span className="ml-1 text-xs text-muted">(headline)</span>}
      <Cite index={item.sourceIndex} sources={sources} />
      <Flag item={item} />
    </p>
  );
}

/**
 * Items about this person, then (apart) items from pages that may describe someone else with the name: a page
 * flagged as possibly another person, and one tied to the name only (nameOnly) while other pages tie the person.
 */
const mayBeSomeoneElse = (x) => Boolean(x?.possibleDifferentPerson || x?.nameOnly);
function OwnThenOthers({ items, render, ordered = false }) {
  const own = items.filter((x) => !mayBeSomeoneElse(x));
  const others = items.filter(mayBeSomeoneElse);
  const List = ordered ? 'ol' : 'ul';
  return (
    <>
      {own.length > 0 && <List className={ordered ? 'relative ml-2 border-l border-line pl-6' : 'divide-y divide-line'}>{own.map(render)}</List>}
      {others.length > 0 && (
        <div className={own.length ? 'mt-4 border-t border-line pt-3' : ''}>
          <p className="eyebrow mb-1">May be someone else</p>
          <p className="mb-2 text-xs text-muted">These sources do not tie the person by more than the name. They may describe the same person elsewhere, or a different person with the same name.</p>
          <List className={ordered ? 'relative ml-2 border-l border-line pl-6' : 'divide-y divide-line'}>{others.map(render)}</List>
        </div>
      )}
    </>
  );
}

function Section({ title, count, children, empty, note, emptyText = EMPTY }) {
  return (
    <section className="card card-pad">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="section-title">{title}</h2>
        {typeof count === 'number' && count > 0 && <span className="chip">{count}</span>}
      </div>
      {note}
      {empty ? <p className="muted">{emptyText}</p> : children}
    </section>
  );
}

function BriefSkeleton({ name, company }) {
  return (
    <div className="card card-pad" aria-busy="true">
      <p className="flex items-center gap-2 text-sm text-ink" aria-live="polite">
        <HiOutlineSparkles className="text-brand-500 animate-glow" style={{ width: 16, height: 16 }} />
        Reading startup news, Hacker News, the web, public profiles and court records for &ldquo;{name}&rdquo;{company ? ` at ${company}` : ''}…
      </p>
      <p className="muted mt-1">This can take up to a minute.</p>
      <div className="mt-5 space-y-2.5">
        <div className="skeleton h-4 w-2/5" />
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-11/12" />
        <div className="skeleton h-3 w-4/5" />
        <div className="mt-4 skeleton h-4 w-1/4" />
        <div className="skeleton h-3 w-3/4" />
        <div className="skeleton h-3 w-2/3" />
      </div>
    </div>
  );
}

const STATUS_LABEL = { current: 'current, as of the source', past: 'past', founded: 'founded' };
const STATUS_CHIP = { current: 'chip chip-good', founded: 'chip chip-active', past: 'chip' };
const CONFIDENCE_CHIP = { high: 'chip chip-good', medium: 'chip chip-warn', low: 'chip chip-bad' };
const DETAIL_FIELDS = [
  ['website', 'Company website', 'example.com'],
  ['profileUrl', 'Profile address', 'linkedin.com/in/…'],
  ['place', 'City or country', 'Berlin'],
  ['otherCompanies', 'Earlier companies', 'Separate with commas'],
  ['school', 'School', 'University name'],
  ['otherNames', 'Other names', 'Former or other spellings, with commas'],
];
const NO_DETAILS = { website: '', profileUrl: '', place: '', otherCompanies: '', school: '', otherNames: '' };
/** Details kept for a person (lists as arrays) back in the form's shape (lists as comma-separated text). */
function formDetailsOf(kept) {
  const out = { ...NO_DETAILS };
  if (!kept || typeof kept !== 'object') return out;
  for (const k of Object.keys(NO_DETAILS)) {
    const v = kept[k];
    out[k] = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
  }
  return out;
}

/** The person's earlier deep checks: reopening one never starts a new check. */
function RecentChecks({ jobs }) {
  if (!jobs?.length) return null;
  const href = (j) => ({ pathname: '/founder', query: { name: j.name, ...(j.company ? { company: j.company } : {}), job: j.id } });
  return (
    <details className="card card-pad">
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className="section-title">Recent checks</span>
        <span className="chip">{jobs.length}</span>
        <HiOutlineChevronDown className="ml-auto text-muted" style={{ width: 14, height: 14 }} aria-hidden="true" />
      </summary>
      <p className="muted mt-3 text-xs">Your deep checks from the last three days. Opening one shows it as it is; it does not start a new check.</p>
      <ul className="mt-2 divide-y divide-line">
        {jobs.map((j) => (
          <li key={j.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <Link href={href(j)} className="font-medium text-ink hover:text-brand-600 hover:underline">{j.name}</Link>
            {j.company && <span className="chip">{j.company}</span>}
            {j.state === 'running' && <span className="chip chip-active">running</span>}
            {j.state === 'failed' && <span className="chip chip-warn">did not finish</span>}
            {j.state === 'done' && typeof j.redFlags === 'number' && (
              // serious records held "if this is the right person" keep a zero from reading as clean
              <span className={j.redFlags ? 'chip chip-bad' : j.ifRightPerson > 0 ? 'chip chip-warn' : 'chip'}>
                {j.redFlags} red flag{j.redFlags === 1 ? '' : 's'}{j.ifRightPerson > 0 ? ` · ${j.ifRightPerson} serious if right person` : ''}
              </span>
            )}
            {j.when && <span className="ml-auto text-xs text-muted">{formatWhen(j.when)}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Several people with the name and no company typed: which one is meant. */
function Chooser({ name, people, onChoose, onNameAlone }) {
  return (
    <section className="card card-pad" aria-label="Which person">
      <h2 className="section-title">Several people named {name}</h2>
      <p className="muted mt-1 text-sm">Pages describe more than one {name}. Choose the one you mean, or add their company above; the brief and the deep check are about one person.</p>
      <ul className="mt-3 divide-y divide-line">
        {people.map((p, i) => (
          <li key={`${p.company}-${i}`} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
            <span className="font-medium text-ink">{p.company || 'Unknown organisation'}</span>
            {p.role && <span className="text-slate-700">· {p.role}</span>}
            <span className="text-xs text-muted">{p.sources} page{p.sources === 1 ? '' : 's'}</span>
            {p.source?.title && (
              <ExternalLink href={p.source.url} className="min-w-0 truncate text-xs text-muted hover:text-brand-600 hover:underline">{p.source.title}</ExternalLink>
            )}
            {p.company && <button type="button" className="btn-secondary ml-auto px-2.5 py-1 text-xs" onClick={() => onChoose(p.company)}>This one</button>}
          </li>
        ))}
      </ul>
      <button type="button" className="btn-ghost mt-3 px-2 py-1 text-xs" onClick={onNameAlone}>Run the deep check on the name alone</button>
    </section>
  );
}

export default function FounderPage() {
  const router = useRouter();
  const { status } = useSession();
  const nameInput = useRef(null);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [details, setDetails] = useState(NO_DETAILS);
  const [detailsEdited, setDetailsEdited] = useState(false); // typed since the page last loaded a person's details
  const [showMore, setShowMore] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [briefPending, setBriefPending] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState(0);
  const [deepReport, setDeepReport] = useState(null);
  const [nameAlone, setNameAlone] = useState(false);
  const [jobs, setJobs] = useState(null);

  const qName = typeof router.query.name === 'string' ? router.query.name.trim() : '';
  const qCompany = typeof router.query.company === 'string' ? router.query.company.trim() : '';
  const qJob = typeof router.query.job === 'string' && /^[\w-]{1,80}$/.test(router.query.job) ? router.query.job : '';
  const nameIssue = qName ? nameProblem(qName, qCompany) : '';

  useEffect(() => {
    if (status !== 'authenticated') return undefined;
    let live = true;
    recentJobs().then((list) => { if (live) setJobs(list); }).catch(() => {});
    return () => { live = false; };
  }, [status, deepReport]);

  // A new person on the page: the details shown are those kept for this person, never the last person's.
  useEffect(() => {
    if (!router.isReady) return;
    const kept = qName && typeof window !== 'undefined' ? formDetailsOf(keptDetails(qName, qCompany)) : NO_DETAILS;
    setDetails(kept);
    setDetailsEdited(false);
    if (Object.keys(detailsBody(kept)).length) setShowMore(true); // details that will be sent are in sight
  }, [router.isReady, qName, qCompany]);

  useEffect(() => {
    if (!router.isReady) return undefined;
    setName(qName);
    setCompany(qCompany);
    setDeepReport(null);
    setNameAlone(false);
    setBriefPending(false);
    if (!qName || nameIssue) { setData(null); setError(nameIssue); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);
    const ask = { name: qName, ...(qCompany ? { company: qCompany } : {}) };
    // Sources and facts first (seconds), then the brief, written from the same sources.
    quickCheck({ ...ask, brief: '0' })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setLoading(false);
        if (body.briefInfo?.mode !== 'pending') return;
        setBriefPending(true);
        quickCheck({ ...ask, brief: 'only' })
          .then((out) => {
            if (cancelled) return;
            // the sources were no longer held, so the whole check ran again: take all of it
            setData((d) => (out.fromCache === false || !d ? out : { ...d, brief: out.brief, briefInfo: out.briefInfo }));
          })
          .catch(() => { if (!cancelled) setData((d) => d && { ...d, briefInfo: { mode: 'failed', reason: 'The brief could not be written just now. The sources and facts below stand on their own.' } }); })
          .finally(() => { if (!cancelled) setBriefPending(false); });
      })
      .catch((e) => { if (!cancelled) { setError(e.message || 'Request failed'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [router.isReady, qName, qCompany, run, nameIssue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Details loaded for the person on the page belong to them: once another name or company is typed, and no
  // detail has been typed since, the form shows (and sends) none.
  const otherPerson = name.trim() !== qName || company.trim() !== qCompany;
  const formDetails = otherPerson && !detailsEdited ? NO_DETAILS : details;
  const filledDetails = Object.keys(detailsBody(formDetails)).length;
  const editDetail = (key, value) => {
    setDetails((d) => ({ ...(otherPerson && !detailsEdited ? NO_DETAILS : d), [key]: value }));
    setDetailsEdited(true);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const n = name.trim();
    const c = company.trim();
    const problem = nameProblem(n, c);
    if (problem) { setError(problem); return; }
    keepDetails(n, c, formDetails);
    setDetailsEdited(false); // sent for this person: a name typed next does not inherit them
    const query = { name: n };
    if (c) query.company = c;
    if (n === qName && c === qCompany) {
      setRun((x) => x + 1); // same query: run it again
      return;
    }
    router.push({ pathname: '/founder', query }, undefined, { shallow: true });
  };
  const choose = (co) => {
    // the details typed for the name are kept for the person chosen: this is the case they were typed for
    keepDetails(qName, co, filledDetails ? formDetails : (keptDetails(qName, '') || NO_DETAILS));
    router.push({ pathname: '/founder', query: { name: qName, company: co } }, undefined, { shallow: true });
  };
  // The check on the page goes in the address, so a reload or Back opens it and not an older one the link named.
  const onJob = (id) => {
    if (!id || id === qJob) return;
    router.replace({ pathname: '/founder', query: { name: qName, ...(qCompany ? { company: qCompany } : {}), job: id } }, undefined, { shallow: true });
  };

  // the optional details typed for this person (kept in this tab, so they survive the sign-in round trip)
  const startDetails = useMemo(() => (qName && typeof window !== 'undefined' ? keptDetails(qName, qCompany) : null), [qName, qCompany, run]); // eslint-disable-line react-hooks/exhaustive-deps

  const sources = data?.sources || [];
  const noSources = data && sources.length === 0;
  const searched = (data?.searchedSources || []).map((s) => `${s.source} (${s.results} result${s.results === 1 ? '' : 's'})`);
  const notSearched = (data?.unavailableSources || []).map((u) => u.source);
  const companies = data?.pastCompanies || [];
  const mentions = data?.mentions || [];
  const briefInfo = data?.briefInfo;
  const confidence = briefInfo?.confidence;
  const choosing = Boolean(data?.people?.length) && !qCompany;
  // Profiles listed are the person's own: none while the person is not chosen, none from another person's page,
  // and (with a company typed) none that places them at another company.
  const otherPages = new Set([...(data?.timeline || []), ...companies, ...(data?.education || []), ...(data?.litigation || []), ...(data?.press || []), ...mentions]
    .filter((x) => x.possibleDifferentPerson).map((x) => x.sourceIndex));
  const allProfiles = data?.profiles || [];
  // a profile the server flags as possibly another person is never listed as theirs
  const ownProfiles = choosing ? [] : allProfiles.filter((p) => !p.possibleDifferentPerson && !otherPages.has(p.sourceIndex) && (!qCompany || !p.company || sameCompany(p.company, qCompany)));
  const profilesLeftOut = choosing ? 0 : allProfiles.length - ownProfiles.length;
  const namesakePages = data?.namesakePages || [];
  const namesakeCourt = data?.namesakeCourtRecords && Number(data.namesakeCourtRecords.count) > 0 ? data.namesakeCourtRecords : null;
  // While several people share the name and none is chosen, the quick brief's sections would show one of them as
  // this person: only the sources and the chooser are shown until a choice (or "the name alone").
  const undecided = choosing && !nameAlone;

  // The deep check starts once it is known who it is about: at once with a company or a saved check; otherwise
  // after the quick look, unless that found several people (then after the choice, or on the name alone).
  const deepOn = Boolean(qName) && !nameIssue && (Boolean(qCompany) || Boolean(qJob) || nameAlone || (!loading && (Boolean(error) || (data && !choosing))));
  const folded = Boolean(deepReport);

  const quickBrief = data && !noSources && (
    <>
      {data.brief && (
        <section className="ai-card p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {briefInfo?.mode === 'ai' ? (
              <>
                <span className="ai-badge"><HiOutlineSparkles style={{ width: 13, height: 13 }} /> AI brief</span>
                {briefInfo.model && <span className="chip" title={briefInfo.provider ? `via ${briefInfo.provider}` : undefined}>{displayModel(briefInfo.model)}</span>}
                {confidence?.level && (
                  <span className={CONFIDENCE_CHIP[String(confidence.level).toLowerCase()] || 'chip'} title={confidence.reason || undefined}>
                    {confidence.level} confidence
                  </span>
                )}
                {skippedNote(briefInfo.skipped) && <span className="text-xs text-muted">{skippedNote(briefInfo.skipped).replace(/^\s*·\s*/, '')}</span>}
              </>
            ) : (
              <span className="chip chip-active" title={briefInfo?.reason || undefined}>Quoted from sources</span>
            )}
          </div>
          <h2 className="text-lg font-semibold tracking-tight text-ink">
            {data.name}{data.company ? <span className="font-normal text-muted"> · {data.company}</span> : null}
          </h2>
          {data.currentRole && !choosing && (
            <p className="mt-3 rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm text-ink">
              <span className="eyebrow mr-2 text-brand-700">Most recent role found</span>
              {data.currentRole.role} at {data.currentRole.company}
              <Cite index={data.currentRole.sourceIndex} sources={sources} />
            </p>
          )}
          <div
            className="founder-brief mt-3 space-y-2 text-sm leading-relaxed text-slate-700"
            dangerouslySetInnerHTML={{ __html: briefHtml(data.brief, { anchor: 'source', label: 'Q' }) }}
          />
          {briefInfo?.mode === 'ai' && (
            <p className="mt-3 text-xs text-muted">AI-written; check it against the cited records. Written from the cited sources{briefInfo.provider ? ` by ${displayModel(briefInfo.model)} (${briefInfo.provider})` : ''}{confidence?.reason ? `. ${confidence.reason}` : ''}.</p>
          )}
        </section>
      )}
      {!data.brief && briefPending && (
        <section className="card card-pad" aria-busy="true">
          <p className="flex items-center gap-2 text-sm text-ink" aria-live="polite">
            <HiOutlineSparkles className="text-brand-500 animate-glow" style={{ width: 16, height: 16 }} />
            Writing the brief from the sources below…
          </p>
          <div className="mt-4 space-y-2.5"><div className="skeleton h-3 w-full" /><div className="skeleton h-3 w-11/12" /><div className="skeleton h-3 w-4/5" /></div>
        </section>
      )}
      {!data.brief && briefInfo?.mode === 'failed' && <p className="muted px-1 text-sm">{briefInfo.reason}</p>}

      {ownProfiles.length > 0 && (
        <Section title="Public profiles" count={ownProfiles.length} empty={false}>
          <ul className="divide-y divide-line">
            {ownProfiles.map((p, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-sm text-slate-700">
                <span className="chip">{p.platform}</span>
                <span className="text-ink">{[p.role, p.company].filter(Boolean).join(' at ') || 'Profile'}</span>
                {p.location ? <span className="text-muted">· {p.location}</span> : null}
                {p.education ? <span className="text-muted">· {p.education}</span> : null}
                <Cite index={p.sourceIndex} sources={sources} />
              </li>
            ))}
          </ul>
          <p className="muted mt-2 text-xs">From public profile pages as they appear in web search results; check that each profile is the same person.{profilesLeftOut > 0 ? ` ${profilesLeftOut} profile${profilesLeftOut === 1 ? '' : 's'} at another company ${profilesLeftOut === 1 ? 'is' : 'are'} left out: ${profilesLeftOut === 1 ? 'it' : 'they'} may be someone else.` : ''}</p>
        </Section>
      )}

      {!choosing && (
        <NetworkHelpers
          company={data.currentRole?.company || data.company || ownProfiles[0]?.company || ''}
          related={[...new Set([...ownProfiles.map((p) => p.company), ...companies.filter((p) => !p.possibleDifferentPerson).map((p) => p.company)].filter((v) => v && v !== (data.currentRole?.company || data.company)))].slice(0, 12)}
          person={data.name}
          keywords={sectorKeywordsFrom([data.currentRole?.role, data.currentRole?.company, ...companies.map((p) => `${p.role || ''} ${p.company || ''}`), ...(data.press || []).map((p) => p.text || p.title || '')].join(' '))}
          title={`Who can help diligence ${data.name}`}
        />
      )}

      {(data.warnings?.length > 0 || data.unavailableSources?.length > 0) && (
        <section className="card card-pad">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="section-title">Notes on this check</h2>
            <span className="chip chip-warn">Read first</span>
          </div>
          {data.warnings?.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
              {data.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          {data.unavailableSources?.length > 0 && (
            <div className={data.warnings?.length ? 'mt-3' : ''}>
              <p className="eyebrow mb-1">Sources not searched</p>
              <ul className="space-y-1 text-sm text-muted">
                {data.unavailableSources.map((u) => <li key={u.source}><span className="font-medium text-ink">{u.source}</span>: {u.reason}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}

      <Section
        title="Career timeline"
        count={(data.timeline || []).length}
        empty={!(data.timeline || []).length}
        note={(data.timeline || []).some((t) => t.yearFrom === 'source') ? <p className="muted mb-3 text-xs">Years marked &ldquo;source date&rdquo; come from when the source was published, not from the sentence.</p> : null}
      >
        <OwnThenOthers
          ordered
          items={data.timeline || []}
          render={(t, i) => (
            <li key={i} className="relative pb-5 last:pb-0">
              <span className="absolute -left-[31px] top-1 grid h-3 w-3 place-items-center rounded-full border-2 border-white bg-brand-500 ring-1 ring-brand-200" aria-hidden="true" />
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-brand-700">{t.year}</span>
                {t.yearFrom === 'source' && <span className="chip">source date</span>}
              </div>
              <Quote item={t} sources={sources} />
            </li>
          )}
        />
      </Section>

      <Section title="Companies and roles" count={companies.length} empty={!companies.length}>
        <OwnThenOthers
          items={companies}
          render={(c, i) => (
            <li key={i} className="py-3 first:pt-0 last:pb-0">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{c.company}</span>
                {c.role && <span className="chip">{c.role}</span>}
                {c.status && <span className={STATUS_CHIP[c.status] || 'chip'}>{STATUS_LABEL[c.status] || c.status}</span>}
              </div>
              <Quote item={c} sources={sources} />
            </li>
          )}
        />
      </Section>

      <Section title="Education" count={(data.education || []).length} empty={!(data.education || []).length}>
        <OwnThenOthers
          items={data.education || []}
          render={(e, i) => (
            <li key={i} className="py-3 first:pt-0 last:pb-0">
              <p className="mb-1 font-medium text-ink">{e.school}</p>
              <Quote item={e} sources={sources} />
            </li>
          )}
        />
      </Section>

      <Section
        title="Litigation and regulatory mentions"
        count={(data.litigation || []).length}
        empty={!(data.litigation || []).length}
        emptyText={namesakeCourt ? 'No litigation or regulatory mention tied to this person; the court records under the name are listed above.' : 'No litigation or regulatory mentions in the available sources.'}
        note={(
          <>
            <p className="mb-3 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-muted">{data.litigationDisclaimer}</p>
            {namesakeCourt && (
              <div className="mb-3 rounded-xl border border-line px-3.5 py-2.5" data-testid="namesake-court">
                <p className="eyebrow mb-1">Court records under the name, not tied to this person</p>
                <p className="mb-2 text-xs text-muted">{namesakeCourt.count} court record{namesakeCourt.count === 1 ? ' names' : 's name'} someone with this name but not the company. Check {namesakeCourt.count === 1 ? 'it' : 'them'} directly.</p>
                <ul className="space-y-1 text-sm text-muted">
                  {(namesakeCourt.records || []).map((c, i) => <li key={`${c.url}-${i}`}><ExternalLink href={c.url} className="hover:text-brand-600 hover:underline">{c.title}</ExternalLink></li>)}
                </ul>
              </div>
            )}
          </>
        )}
      >
        <OwnThenOthers items={data.litigation || []} render={(l, i) => <li key={i} className="py-3 first:pt-0 last:pb-0"><Quote item={l} sources={sources} /></li>} />
      </Section>

      <Section title={`Press about ${data.name}`} count={(data.press || []).length} empty={!(data.press || []).length} emptyText="No headline names this person in the available sources.">
        <OwnThenOthers
          items={data.press || []}
          render={(p, i) => (
            <li key={i} className="py-3 first:pt-0 last:pb-0">
              <p className="mb-1 text-sm font-medium text-ink">{p.title}</p>
              <Quote item={p} sources={sources} />
            </li>
          )}
        />
      </Section>

      {mentions.length > 0 && (
        <Section title="Other mentions" count={mentions.length} empty={false} note={<p className="muted mb-3 text-xs">Articles that mention the name in the text but are about something else.</p>}>
          <OwnThenOthers
            items={mentions}
            render={(p, i) => (
              <li key={i} className="py-3 first:pt-0 last:pb-0">
                <p className="mb-1 text-sm font-medium text-ink">{p.title}</p>
                <Quote item={p} sources={sources} />
              </li>
            )}
          />
        </Section>
      )}
    </>
  );

  const sourcesCard = data && (
    <section className="card card-pad">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="section-title">Quick brief sources</h2>
        {sources.length > 0 && <span className="chip">{sources.length}</span>}
      </div>
      {sources.length === 0 ? (
        <p className="muted">{EMPTY}</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {sources.map((s) => (
            <li key={s.n} id={`source-${s.n}`} className="flex scroll-mt-24 items-start gap-2.5">
              <span className="cite mt-0.5 shrink-0">[Q{s.n}]</span>
              <span className="mt-0.5 shrink-0"><SourceBadge url={s.url} label={s.sourceName} /></span>
              <span className="min-w-0">
                <ExternalLink href={s.url} className="font-medium text-ink hover:text-brand-600 hover:underline">{s.title}</ExternalLink>
                <span className="block text-xs text-muted">{s.sourceName}{s.via && s.via !== s.sourceName ? ` (${s.via})` : ''}{s.date ? ` · ${s.dateLabel === 'posted' ? 'posted ' : ''}${s.date}` : ''}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {noSources && searched.length > 0 && (
        <p className="muted mt-2 text-xs">Searched: {searched.join(', ')}.</p>
      )}
      {namesakePages.length > 0 && (
        <details className="mt-4 text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-ink">Pages about other people with this name ({namesakePages.length}), left out</summary>
          <ul className="mt-1.5 space-y-1 border-l border-line pl-3">
            {namesakePages.map((p, i) => <li key={`${p.url}-${i}`}><ExternalLink href={p.url} className="hover:text-brand-600 hover:underline">{p.title}</ExternalLink></li>)}
          </ul>
        </details>
      )}
      <p className="mt-3 text-xs text-muted">Generated {formatWhen(data.generatedAt)}</p>
    </section>
  );

  return (
    <PageShell flows
      title="Founder Check"
      subtitle="Career, companies, education, litigation and press for a person, every line cited."
    >
      <div className="space-y-4">
        <form onSubmit={onSubmit} className="founder-no-print card card-pad">
          <div className="grid gap-3 md:grid-cols-[1fr_minmax(0,18rem)_auto]">
            <input
              ref={nameInput}
              type="text"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name (exact spelling, e.g. Arthur Mensch)"
              aria-label="Full name"
              className="input-hero"
            />
            <input
              type="text"
              value={company}
              maxLength={120}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Company (optional)"
              aria-label="Company"
              className="input py-3.5 text-base"
            />
            <button type="submit" disabled={loading} className="btn-primary">
              <HiOutlineUserCircle style={ICON} />
              {loading ? 'Checking…' : 'Run check'}
            </button>
          </div>
          <button type="button" className="btn-ghost mt-2 px-2 py-1 text-xs" aria-expanded={showMore} aria-controls="founder-more" onClick={() => setShowMore((v) => !v)}>
            <HiOutlineChevronDown style={{ width: 13, height: 13 }} className={showMore ? 'rotate-180' : ''} /> More details
            {filledDetails > 0 && <span className="chip ml-1">{filledDetails} added</span>}
          </button>
          <div id="founder-more" hidden={!showMore} className="mt-3">
            <p className="muted mb-2 text-xs">Optional. Each detail you know helps the deep check tell this person apart from others with the name.</p>
            <div className="grid gap-3 md:grid-cols-3">
              {DETAIL_FIELDS.map(([key, label, hint]) => (
                <label key={key} className="block text-xs text-muted">
                  {label}
                  <input type="text" className="input mt-1 w-full" maxLength={key === 'otherCompanies' || key === 'otherNames' ? 400 : 200} value={formDetails[key]} placeholder={hint} onChange={(e) => editDetail(key, e.target.value)} />
                </label>
              ))}
            </div>
          </div>
        </form>

        {status === 'authenticated' && <div className="founder-no-print"><RecentChecks jobs={jobs} /></div>}

        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{error}</div>}
        {choosing && !nameAlone && <Chooser name={data.name || qName} people={data.people} onChoose={choose} onNameAlone={() => setNameAlone(true)} />}
        {deepOn && <DeepCheck name={qName} company={qCompany} runKey={run} jobId={qJob || null} details={startDetails} onReport={setDeepReport} onJob={onJob} />}
        {loading && <BriefSkeleton name={qName} company={qCompany} />}

        {noSources && (
          <section className="card card-pad">
            <h2 className="section-title">No source names {data.name}</h2>
            <p className="muted mt-1">
              Searched: {searched.length ? searched.join(', ') : 'no sources'}.
              {notSearched.length ? ` Not searched: ${notSearched.join(', ')}.` : ''}
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
              <li>Check the spelling and use the full first and last name; initials and nicknames are not matched.</li>
              {qCompany ? <li>Try without the company, in case sources describe the person elsewhere.</li> : <li>Add the company to find mentions that only use the company name alongside the person.</li>}
              {notSearched.some((s) => /web/i.test(s)) && <li>Web search is not enabled on this deployment, so only startup-news feeds and Hacker News were checked; people outside funding news are rarely in them.</li>}
            </ul>
            <div className="mt-4">
              {qCompany ? (
                <button type="button" className="btn-secondary" onClick={() => router.push({ pathname: '/founder', query: { name: qName } }, undefined, { shallow: true })}>
                  Try without the company
                </button>
              ) : (
                <button type="button" className="btn-secondary" onClick={() => nameInput.current?.focus()}>
                  Edit the name
                </button>
              )}
            </div>
          </section>
        )}

        {data && (folded ? (
          // Once the deep report is on the page, the quick brief folds to one line: its pages are not identity-checked.
          <details className="card card-pad" data-testid="quick-folded">
            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <span className="section-title">First look: quick brief</span>
              <span className="chip">{sources.length} sources</span>
              <span className="text-xs text-muted">not identity-checked; citations marked Q</span>
              <HiOutlineChevronDown className="ml-auto text-muted" style={{ width: 14, height: 14 }} aria-hidden="true" />
            </summary>
            <div className="mt-4 space-y-4">{quickBrief}{sourcesCard}</div>
          </details>
        ) : (
          <>{undecided ? null : quickBrief}{sourcesCard}</>
        ))}
      </div>
    </PageShell>
  );
}
