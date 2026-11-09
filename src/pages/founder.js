import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { HiOutlineSparkles, HiOutlineUserCircle, HiOutlineArrowTopRightOnSquare } from 'react-icons/hi2';
import PageShell from '../components/layout/PageShell';
import NetworkHelpers from '../components/network/NetworkHelpers';
import { sectorKeywordsFrom } from '../utils/network/sectors';
import { renderSafeHtml } from '../components/search/results/SimplifiedLLMResults';
import { skippedNote } from '../utils/skippedNote';

const EMPTY = 'Nothing found in available sources.';
const ICON = { width: 15, height: 15 };

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function Favicon({ url }) {
  const host = hostOf(url);
  if (!host) return <span className="inline-block h-4 w-4 rounded bg-slate-100" aria-hidden="true" />;
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      className="inline-block h-4 w-4 rounded"
    />
  );
}

function Cite({ index, sources }) {
  const s = sources[index];
  if (!s) return null;
  return (
    <a href={`#source-${s.n}`} className="cite ml-1" title={`${s.sourceName}${s.date ? `, ${s.date}` : ''}: ${s.title}`}>
      [{s.n}]
    </a>
  );
}

function Flag({ item }) {
  if (item.possibleDifferentPerson) {
    return (
      <span className="chip chip-warn ml-2" title="This source does not mention the company you entered. It may describe the same person at another company, or a different person with the same name.">
        company not mentioned
      </span>
    );
  }
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
    <div className="card card-pad" aria-busy="true" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-ink">
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

function formatWhen(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const STATUS_LABEL = { current: 'current, as of the source', past: 'past', founded: 'founded' };
const STATUS_CHIP = { current: 'chip chip-good', founded: 'chip chip-active', past: 'chip' };
const CONFIDENCE_CHIP = { high: 'chip chip-good', medium: 'chip chip-warn', low: 'chip chip-bad' };

export default function FounderPage() {
  const router = useRouter();
  const nameInput = useRef(null);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState(0);

  const qName = typeof router.query.name === 'string' ? router.query.name : '';
  const qCompany = typeof router.query.company === 'string' ? router.query.company : '';

  useEffect(() => {
    if (!router.isReady) return;
    setName(qName);
    setCompany(qCompany);
    if (!qName.trim()) { setData(null); return; }
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);
    const params = new URLSearchParams({ name: qName });
    if (qCompany.trim()) params.set('company', qCompany);
    fetch(`/api/founder?${params}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
        return body;
      })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Request failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [router.isReady, qName, qCompany, run]);

  const onSubmit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError('Enter a full name.'); return; }
    if (n.split(/\s+/).length < 2) { setError('Enter the full name (first and last name).'); return; }
    const query = { name: n };
    if (company.trim()) query.company = company.trim();
    if (n === qName && (company.trim() || '') === qCompany) {
      setRun((x) => x + 1); // same query: run it again
      return;
    }
    router.push({ pathname: '/founder', query }, undefined, { shallow: true });
  };

  const sources = data?.sources || [];
  const noSources = data && sources.length === 0;
  const searched = (data?.searchedSources || []).map((s) => `${s.source} (${s.results} result${s.results === 1 ? '' : 's'})`);
  const notSearched = (data?.unavailableSources || []).map((u) => u.source);
  const companies = data?.pastCompanies || [];
  const mentions = data?.mentions || [];
  const briefInfo = data?.briefInfo;
  const confidence = briefInfo?.confidence;

  return (
    <PageShell flows
      title="Founder Check"
      subtitle="Career, companies, education, litigation and press for a person, every line cited."
    >
      <div className="space-y-4">
        <form onSubmit={onSubmit} className="card card-pad">
          <div className="grid gap-3 md:grid-cols-[1fr_minmax(0,18rem)_auto]">
            <input
              ref={nameInput}
              type="text"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name (exact spelling, e.g. Arthur Mensch)"
              aria-label="Full name"
              className="input"
            />
            <input
              type="text"
              value={company}
              maxLength={120}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Company (optional, narrows to the right person)"
              aria-label="Company"
              className="input"
            />
            <button type="submit" disabled={loading} className="btn-primary">
              <HiOutlineUserCircle style={ICON} />
              {loading ? 'Checking…' : 'Run check'}
            </button>
          </div>
        </form>

        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{error}</div>}
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

        {data && !noSources && (
          <>
            {data.brief && (
              <section className="ai-card p-5">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {briefInfo?.mode === 'ai' ? (
                    <>
                      <span className="ai-badge"><HiOutlineSparkles style={{ width: 13, height: 13 }} /> AI brief</span>
                      {briefInfo.model && <span className="chip" title={briefInfo.provider ? `via ${briefInfo.provider}` : undefined}>{briefInfo.model}</span>}
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
                {data.currentRole && (
                  <p className="mt-3 rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm text-ink">
                    <span className="eyebrow mr-2 text-brand-700">Most recent role found</span>
                    {data.currentRole.role} at {data.currentRole.company}
                    <Cite index={data.currentRole.sourceIndex} sources={sources} />
                  </p>
                )}
                <div
                  className="founder-brief mt-3 space-y-2 text-sm leading-relaxed text-slate-700 [&_a]:cite"
                  dangerouslySetInnerHTML={{ __html: renderSafeHtml(String(data.brief).replace(/\[Source (\d+)\]/g, '[[$1]](#source-$1)')) }}
                />
                {briefInfo?.mode === 'ai' && (
                  <p className="mt-3 text-xs text-muted">Written from the cited sources{briefInfo.provider ? ` by ${briefInfo.model} (${briefInfo.provider})` : ''}{confidence?.reason ? `. ${confidence.reason}` : ''}.</p>
                )}
              </section>
            )}

            {data.profiles?.length > 0 && (
              <Section title="Public profiles" count={data.profiles.length} empty={false}>
                <ul className="divide-y divide-line">
                  {data.profiles.map((p, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-sm text-slate-700">
                      <span className="chip">{p.platform}</span>
                      <span className="text-ink">{[p.role, p.company].filter(Boolean).join(' at ') || 'Profile'}</span>
                      {p.location ? <span className="text-muted">· {p.location}</span> : null}
                      {p.education ? <span className="text-muted">· {p.education}</span> : null}
                      <Cite index={p.sourceIndex} sources={sources} />
                    </li>
                  ))}
                </ul>
                <p className="muted mt-2 text-xs">From public profile pages as they appear in web search results; check that each profile is the same person.</p>
              </Section>
            )}

            <NetworkHelpers
              company={data.currentRole?.company || data.company || (data.profiles || [])[0]?.company || ''}
              related={[...new Set([...(data.profiles || []).map((p) => p.company), ...(data.pastCompanies || []).map((p) => p.company)].filter((v) => v && v !== (data.currentRole?.company || data.company)))].slice(0, 12)}
              person={data.name}
              keywords={sectorKeywordsFrom([data.currentRole?.role, data.currentRole?.company, ...(data.pastCompanies || []).map((p) => `${p.role || ''} ${p.company || ''}`), ...(data.press || []).map((p) => p.text || p.title || '')].join(' '))}
              title={`Who can help diligence ${data.name}`}
            />

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
              count={data.timeline.length}
              empty={!data.timeline.length}
              note={data.timeline.some((t) => t.yearFrom === 'source') ? <p className="muted mb-3 text-xs">Years marked &ldquo;source date&rdquo; come from when the source was published, not from the sentence.</p> : null}
            >
              <ol className="relative ml-2 border-l border-line pl-6">
                {data.timeline.map((t, i) => (
                  <li key={i} className="relative pb-5 last:pb-0">
                    <span className="absolute -left-[31px] top-1 grid h-3 w-3 place-items-center rounded-full border-2 border-white bg-brand-500 ring-1 ring-brand-200" aria-hidden="true" />
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-brand-700">{t.year}</span>
                      {t.yearFrom === 'source' && <span className="chip">source date</span>}
                    </div>
                    <Quote item={t} sources={sources} />
                  </li>
                ))}
              </ol>
            </Section>

            <Section title="Companies and roles" count={companies.length} empty={!companies.length}>
              <ul className="divide-y divide-line">
                {companies.map((c, i) => (
                  <li key={i} className="py-3 first:pt-0 last:pb-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{c.company}</span>
                      {c.role && <span className="chip">{c.role}</span>}
                      {c.status && <span className={STATUS_CHIP[c.status] || 'chip'}>{STATUS_LABEL[c.status] || c.status}</span>}
                    </div>
                    <Quote item={c} sources={sources} />
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Education" count={(data.education || []).length} empty={!(data.education || []).length}>
              <ul className="divide-y divide-line">
                {(data.education || []).map((e, i) => (
                  <li key={i} className="py-3 first:pt-0 last:pb-0">
                    <p className="mb-1 font-medium text-ink">{e.school}</p>
                    <Quote item={e} sources={sources} />
                  </li>
                ))}
              </ul>
            </Section>

            <Section
              title="Litigation and regulatory mentions"
              count={data.litigation.length}
              empty={!data.litigation.length}
              emptyText="No litigation or regulatory mentions in the available sources."
              note={<p className="mb-3 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-muted">{data.litigationDisclaimer}</p>}
            >
              <ul className="divide-y divide-line">
                {data.litigation.map((l, i) => <li key={i} className="py-3 first:pt-0 last:pb-0"><Quote item={l} sources={sources} /></li>)}
              </ul>
            </Section>

            <Section title={`Press about ${data.name}`} count={data.press.length} empty={!data.press.length} emptyText="No headline names this person in the available sources.">
              <ul className="divide-y divide-line">
                {data.press.map((p, i) => (
                  <li key={i} className="py-3 first:pt-0 last:pb-0">
                    <p className="mb-1 text-sm font-medium text-ink">{p.title}</p>
                    <Quote item={p} sources={sources} />
                  </li>
                ))}
              </ul>
            </Section>

            {mentions.length > 0 && (
              <Section title="Other mentions" count={mentions.length} empty={false} note={<p className="muted mb-3 text-xs">Articles that mention the name in the text but are about something else.</p>}>
                <ul className="divide-y divide-line">
                  {mentions.map((p, i) => (
                    <li key={i} className="py-3 first:pt-0 last:pb-0">
                      <p className="mb-1 text-sm font-medium text-ink">{p.title}</p>
                      <Quote item={p} sources={sources} />
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}

        {data && (
          <section className="card card-pad">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="section-title">Sources</h2>
              {sources.length > 0 && <span className="chip">{sources.length}</span>}
            </div>
            {sources.length === 0 ? (
              <p className="muted">{EMPTY}</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {sources.map((s) => (
                  <li key={s.n} id={`source-${s.n}`} className="flex items-start gap-2.5 scroll-mt-24">
                    <span className="cite mt-0.5 shrink-0">[{s.n}]</span>
                    <span className="mt-0.5 shrink-0"><Favicon url={s.url} /></span>
                    <span className="min-w-0">
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-medium text-ink hover:text-brand-600 hover:underline">{s.title}</a>
                      <span className="block text-xs text-muted">{s.sourceName}{s.via && s.via !== s.sourceName ? ` (${s.via})` : ''}{s.date ? ` · ${s.dateLabel === 'posted' ? 'posted ' : ''}${s.date}` : ''}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {noSources && searched.length > 0 && (
              <p className="muted mt-2 text-xs">Searched: {searched.join(', ')}.</p>
            )}
            <p className="mt-3 text-xs text-muted">Generated {formatWhen(data.generatedAt)}</p>
          </section>
        )}
      </div>
    </PageShell>
  );
}
