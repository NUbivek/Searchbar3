/**
 * Company profile page: /company/<name>
 * Shows only facts quoted from real sources, each with a numbered citation.
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { HiOutlineMagnifyingGlass, HiOutlineSparkles } from 'react-icons/hi2';
import NetworkHelpers from '../../components/network/NetworkHelpers';
import { sectorKeywordsFrom } from '../../utils/network/sectors';
import PageShell from '../../components/layout/PageShell';

const NOT_FOUND = 'Not found in available sources';
const NUMBER_RE = /((?:[$€£]\s?)?\d+(?:[.,]\d+)*(?:\s?(?:%|percent|billion|million|bn|mn|[BMK]\b)[€$£]?)?)/g;
const NUM_CLASS = 'rounded bg-brand-50 px-1 font-semibold text-brand-700';

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

function Highlight({ text }) {
  const parts = String(text || '').split(NUMBER_RE);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1
        ? <span key={i} className={NUM_CLASS}>{part}</span>
        : <React.Fragment key={i}>{part}</React.Fragment>))}
    </>
  );
}

function Cite({ n, sources }) {
  const s = sources[n - 1];
  if (!s) return null;
  return (
    <a href={s.url} target="_blank" rel="noopener noreferrer" className="cite" title={`${s.sourceName}${s.date ? `, ${s.date}` : ''}: ${s.title}`}>
      [{n}]
    </a>
  );
}

function Card({ title, count, children }) {
  return (
    <section className="card card-pad">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="section-title">{title}</h2>
        {typeof count === 'number' && count > 0 && <span className="chip">{count}</span>}
      </div>
      {children}
    </section>
  );
}

const Empty = () => <p className="muted">{NOT_FOUND}</p>;

function QuoteList({ items, sources, label }) {
  if (!items?.length) return <Empty />;
  return (
    <ul className="divide-y divide-line">
      {items.map((item, i) => (
        <li key={i} className="py-3 text-sm first:pt-0 last:pb-0">
          {label && label(item)}
          <p className="leading-relaxed text-slate-700">
            &ldquo;<Highlight text={item.quote} />&rdquo;
            <span className="ml-1"><Cite n={item.sourceIndex} sources={sources} /></span>
          </p>
        </li>
      ))}
    </ul>
  );
}

const NotStated = ({ children = 'Not stated' }) => <span className="text-slate-400">{children}</span>;

function FundingRounds({ rounds, sources }) {
  if (!rounds?.length) return <Empty />;
  return (
    <ul className="divide-y divide-line">
      {rounds.map((r, i) => (
        <li key={i} className="py-3 first:pt-0 last:pb-0">
          <div className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,8rem)_minmax(0,8rem)_minmax(0,7rem)_1fr]">
            <div>
              <div className="eyebrow sm:hidden">Round</div>
              <span className="font-medium text-ink">{r.round || <NotStated />}</span>
            </div>
            <div>
              <div className="eyebrow sm:hidden">Amount</div>
              {r.amount ? <span className={NUM_CLASS}>{r.amount}</span> : <NotStated />}
            </div>
            <div title="Publication date of the source reporting the round">
              <div className="eyebrow sm:hidden">Reported</div>
              <span className="whitespace-nowrap text-slate-700">{r.date || <NotStated>Unknown</NotStated>}</span>
            </div>
            <div>
              <div className="eyebrow sm:hidden">Lead investors</div>
              <span className="text-slate-700">{r.leadInvestors?.length ? r.leadInvestors.join(', ') : <NotStated />}</span>
            </div>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            &ldquo;<Highlight text={r.quote} />&rdquo; <Cite n={r.sourceIndex} sources={sources} />
          </p>
          {(r.otherSources || []).map((o, j) => (
            <p key={j} className="mt-1 text-xs leading-relaxed text-muted">
              &ldquo;<Highlight text={o.quote} />&rdquo; <Cite n={o.sourceIndex} sources={sources} />
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

const EVIDENCE_LABEL = { 'portfolio listing': 'Listed in portfolio', 'led round': 'Led a round', participated: 'Participated in a round' };
const EVIDENCE_CHIP = { 'led round': 'chip chip-active', participated: 'chip', 'portfolio listing': 'chip' };

function Investors({ investors, sources }) {
  if (!investors?.length) return <Empty />;
  return (
    <ul className="divide-y divide-line">
      {investors.map((inv, i) => (
        <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm first:pt-0 last:pb-0">
          <span className="font-medium text-ink">{inv.name}</span>
          <span className="flex items-center gap-2">
            <span className={EVIDENCE_CHIP[inv.evidence] || 'chip'}>{EVIDENCE_LABEL[inv.evidence] || inv.evidence}</span>
            <Cite n={inv.sourceIndex} sources={sources} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function PublicData({ data, sources }) {
  const sec = data?.sec;
  return (
    <div className="space-y-4 text-sm">
      {sec && (
        <div>
          <p className="font-medium text-ink">{sec.name} <span className="font-normal text-muted">(CIK {sec.cik})</span></p>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-slate-700 sm:grid-cols-[auto,1fr]">
            {sec.tickers?.length > 0 && <><dt className="text-muted">Tickers</dt><dd>{sec.tickers.join(', ')}{sec.exchanges?.length ? ` (${sec.exchanges.join(', ')})` : ''}</dd></>}
            {sec.sicDescription && <><dt className="text-muted">Industry (SIC)</dt><dd>{sec.sicDescription}</dd></>}
            {sec.stateOfIncorporation && <><dt className="text-muted">State of incorporation</dt><dd>{sec.stateOfIncorporation}</dd></>}
            {sec.fiscalYearEnd && <><dt className="text-muted">Fiscal year end (MMDD)</dt><dd>{sec.fiscalYearEnd}</dd></>}
          </dl>
          {sec.filings?.length > 0 && (
            <ul className="mt-3 space-y-1">
              {sec.filings.map((f, i) => (
                <li key={i}>
                  <a href={f.url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 hover:underline">{f.form}</a>
                  <span className="text-muted"> filed {f.filingDate}{f.reportDate ? `, period ${f.reportDate}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2"><Cite n={sec.sourceIndex} sources={sources} /></div>
        </div>
      )}
      {data?.market?.length > 0 && <QuoteList items={data.market} sources={sources} label={(m) => <p className="mb-1 font-medium text-ink">{m.title}</p>} />}
    </div>
  );
}

function ProfileSkeleton({ name }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-ink">
        <HiOutlineSparkles className="text-brand-500 animate-glow" style={{ width: 16, height: 16 }} />
        Gathering sources{name ? ` for ${name}` : ''}… this can take up to 20 seconds.
      </p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="card card-pad">
          <div className="skeleton mb-3 h-4 w-1/4" />
          <div className="space-y-2">
            <div className="skeleton h-3 w-full" />
            <div className="skeleton h-3 w-5/6" />
            <div className="skeleton h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CompanyProfilePage() {
  const router = useRouter();
  const name = typeof router.query.name === 'string' ? router.query.name : '';
  const [state, setState] = useState({ loading: true, error: null, profile: null });

  useEffect(() => {
    if (!router.isReady) return undefined;
    if (!name.trim()) {
      setState({ loading: false, error: 'No company name given.', profile: null });
      return undefined;
    }
    let cancelled = false;
    setState({ loading: true, error: null, profile: null });
    fetch(`/api/company?name=${encodeURIComponent(name)}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
        return data;
      })
      .then((profile) => { if (!cancelled) setState({ loading: false, error: null, profile }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err.message || 'Something went wrong.', profile: null }); });
    return () => { cancelled = true; };
  }, [router.isReady, name]);

  const { loading, error, profile } = state;
  const sources = profile?.sources || [];

  return (
    <PageShell
      title={name || 'Company profile'}
      subtitle="Company profile. Every fact below is quoted from a numbered source."
      actions={name ? (
        <Link href={`/?q=${encodeURIComponent(name)}`} className="btn-primary whitespace-nowrap">
          <HiOutlineMagnifyingGlass style={{ width: 15, height: 15 }} /> Search this company
        </Link>
      ) : null}
    >
      {loading && <ProfileSkeleton name={name} />}

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">
          {error}
        </div>
      )}

      {profile && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="chip">{profile.coverage.total} source{profile.coverage.total === 1 ? '' : 's'}</span>
            <span>curated registry {profile.coverage.curated} · web {profile.coverage.web} · Hacker News {profile.coverage.hn}</span>
            <span>· Generated {new Date(profile.generatedAt).toLocaleString()}</span>
            <span>· &ldquo;Reported&rdquo; dates are the source&apos;s publication date.</span>
          </div>

          <Card title="Funding rounds" count={profile.fundingRounds.length}>
            <FundingRounds rounds={profile.fundingRounds} sources={sources} />
          </Card>

          <Card title="Investors" count={profile.investors.length}>
            <Investors investors={profile.investors} sources={sources} />
          </Card>

          <NetworkHelpers
            company={name}
            related={[...profile.investors.map((i) => i.name || i.investor || i.text).filter((v) => typeof v === 'string'), ...profile.competitors.map((c) => c.name || c.text).filter((v) => typeof v === 'string')].slice(0, 20)}
            keywords={sectorKeywordsFrom([name, ...profile.otherFacts.map((f) => f.text || ''), ...profile.keyPeople.map((f) => f.text || '')].join(' '))}
            title={`Your network and ${name}`}
          />

          <Card title="Key people" count={profile.keyPeople.length}>
            <QuoteList
              items={profile.keyPeople}
              sources={sources}
              label={(p) => (p.name || p.role) && (
                <p className="mb-1 flex flex-wrap items-center gap-2">
                  {p.name && <span className="font-medium text-ink">{p.name}</span>}
                  {p.role && <span className="chip">{p.role}</span>}
                </p>
              )}
            />
          </Card>

          <Card title="Competitors" count={profile.competitors.length}>
            <QuoteList items={profile.competitors} sources={sources} />
          </Card>

          <Card title="Headcount" count={profile.headcount.length}>
            <QuoteList items={profile.headcount} sources={sources} />
          </Card>

          <Card title="Other facts" count={profile.otherFacts.length}>
            <QuoteList items={profile.otherFacts} sources={sources} />
          </Card>

          {profile.publicData && (
            <Card title="Public company data">
              <PublicData data={profile.publicData} sources={sources} />
            </Card>
          )}

          <Card title="Sources" count={sources.length}>
            {sources.length === 0 ? <Empty /> : (
              <ol className="space-y-2 text-sm">
                {sources.map((s) => (
                  <li key={s.n} className="flex items-start gap-2.5">
                    <span className="cite mt-0.5 shrink-0">[{s.n}]</span>
                    <span className="mt-0.5 shrink-0"><Favicon url={s.url} /></span>
                    <span className="min-w-0">
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-medium text-ink hover:text-brand-600 hover:underline">{s.title}</a>
                      <span className="block text-xs text-muted">{s.sourceName}{s.date ? ` · ${s.date}` : ''}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      )}
    </PageShell>
  );
}
