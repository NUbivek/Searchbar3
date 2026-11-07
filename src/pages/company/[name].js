/**
 * Company profile page: /company/<name>
 * Shows only facts quoted from real sources, each with a numbered citation.
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import PageShell from '../../components/layout/PageShell';

const NOT_FOUND = 'Not found in available sources';
const NUMBER_STYLE = { fontWeight: 'bold', color: '#0066cc', background: '#0066cc15', padding: '2px 4px', borderRadius: '3px' };
const NUMBER_RE = /((?:[$€£]\s?)?\d+(?:[.,]\d+)*(?:\s?(?:%|percent|billion|million|bn|mn|[BMK]\b)[€$£]?)?)/g;

function Highlight({ text }) {
  const parts = String(text || '').split(NUMBER_RE);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1
        ? <span key={i} style={NUMBER_STYLE}>{part}</span>
        : <React.Fragment key={i}>{part}</React.Fragment>))}
    </>
  );
}

function Cite({ n, sources }) {
  const s = sources[n - 1];
  if (!s) return null;
  return (
    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700 text-xs whitespace-nowrap" title={`${s.sourceName}${s.date ? `, ${s.date}` : ''}: ${s.title}`}>
      [{n}] {s.sourceName}{s.date ? `, ${s.date}` : ''}
    </a>
  );
}

function Card({ title, count, children }) {
  return (
    <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h2 className="text-lg font-semibold text-gray-800 mb-3">
        {title}
        {typeof count === 'number' && count > 0 && <span className="ml-2 text-sm font-normal text-gray-500">({count})</span>}
      </h2>
      {children}
    </section>
  );
}

const Empty = () => <p className="text-sm text-gray-500 italic">{NOT_FOUND}</p>;

function QuoteList({ items, sources, label }) {
  if (!items?.length) return <Empty />;
  return (
    <ul className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="text-sm text-gray-700">
          {label && label(item)}
          <blockquote className="border-l-2 border-gray-200 pl-3">&ldquo;<Highlight text={item.quote} />&rdquo;</blockquote>
          <div className="pl-3 mt-1"><Cite n={item.sourceIndex} sources={sources} /></div>
        </li>
      ))}
    </ul>
  );
}

function FundingTable({ rounds, sources }) {
  if (!rounds?.length) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-200">
            <th className="py-2 pr-4 font-medium">Round</th>
            <th className="py-2 pr-4 font-medium">Amount</th>
            <th className="py-2 pr-4 font-medium" title="Publication date of the source reporting the round">Reported</th>
            <th className="py-2 pr-4 font-medium">Lead investors</th>
            <th className="py-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((r, i) => (
            <React.Fragment key={i}>
              <tr className="border-t border-gray-100 align-top">
                <td className="py-2 pr-4 text-gray-800">{r.round || <span className="text-gray-400">Not stated</span>}</td>
                <td className="py-2 pr-4">{r.amount ? <span style={NUMBER_STYLE}>{r.amount}</span> : <span className="text-gray-400">Not stated</span>}</td>
                <td className="py-2 pr-4 text-gray-700 whitespace-nowrap">{r.date || <span className="text-gray-400">Unknown</span>}</td>
                <td className="py-2 pr-4 text-gray-700">{r.leadInvestors?.length ? r.leadInvestors.join(', ') : <span className="text-gray-400">Not stated</span>}</td>
                <td className="py-2">
                  <Cite n={r.sourceIndex} sources={sources} />
                  {(r.otherSources || []).map((o, j) => o.sourceIndex !== r.sourceIndex && (
                    <div key={j}><Cite n={o.sourceIndex} sources={sources} /></div>
                  ))}
                </td>
              </tr>
              <tr>
                <td colSpan={5} className="pb-3 text-xs text-gray-600">
                  &ldquo;<Highlight text={r.quote} />&rdquo;
                  {(r.otherSources || []).map((o, j) => (
                    <div key={j} className="mt-1">&ldquo;<Highlight text={o.quote} />&rdquo; <span className="text-gray-400">[{o.sourceIndex}]</span></div>
                  ))}
                </td>
              </tr>
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EVIDENCE_LABEL = { 'portfolio listing': 'Listed in portfolio', 'led round': 'Led a round', participated: 'Participated in a round' };

function Investors({ investors, sources }) {
  if (!investors?.length) return <Empty />;
  return (
    <ul className="divide-y divide-gray-100">
      {investors.map((inv, i) => (
        <li key={i} className="py-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="text-gray-800 font-medium">{inv.name}</span>
          <span className="text-gray-500">{EVIDENCE_LABEL[inv.evidence] || inv.evidence} · <Cite n={inv.sourceIndex} sources={sources} /></span>
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
          <p className="text-gray-800 font-medium">{sec.name} <span className="text-gray-500 font-normal">(CIK {sec.cik})</span></p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 mt-2 text-gray-700">
            {sec.tickers?.length > 0 && <><dt className="text-gray-500">Tickers</dt><dd>{sec.tickers.join(', ')}{sec.exchanges?.length ? ` (${sec.exchanges.join(', ')})` : ''}</dd></>}
            {sec.sicDescription && <><dt className="text-gray-500">Industry (SIC)</dt><dd>{sec.sicDescription}</dd></>}
            {sec.stateOfIncorporation && <><dt className="text-gray-500">State of incorporation</dt><dd>{sec.stateOfIncorporation}</dd></>}
            {sec.fiscalYearEnd && <><dt className="text-gray-500">Fiscal year end (MMDD)</dt><dd>{sec.fiscalYearEnd}</dd></>}
          </dl>
          {sec.filings?.length > 0 && (
            <ul className="mt-3 space-y-1">
              {sec.filings.map((f, i) => (
                <li key={i}>
                  <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700">{f.form}</a>
                  <span className="text-gray-500"> filed {f.filingDate}{f.reportDate ? `, period ${f.reportDate}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2"><Cite n={sec.sourceIndex} sources={sources} /></div>
        </div>
      )}
      {data?.market?.length > 0 && <QuoteList items={data.market} sources={sources} label={(m) => <p className="text-gray-800 font-medium mb-1">{m.title}</p>} />}
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
        <Link href={`/?q=${encodeURIComponent(name)}`} className="inline-block bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm whitespace-nowrap">
          Search this company
        </Link>
      ) : null}
    >
      {loading && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-gray-600">
          <div className="inline-block h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-2" />
          <p>Gathering sources for {name}… this can take up to 20 seconds.</p>
        </div>
      )}

      {error && (
        <div className="bg-white border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}

      {profile && (
        <>
          <p className="text-xs text-gray-500 mb-4">
            {profile.coverage.total} source{profile.coverage.total === 1 ? '' : 's'} mention {profile.name}
            {' '}(curated registry {profile.coverage.curated}, web {profile.coverage.web}, Hacker News {profile.coverage.hn}).
            {' '}Generated {new Date(profile.generatedAt).toLocaleString()}.
            {' '}&ldquo;Reported&rdquo; dates are the source&apos;s publication date.
          </p>

          <Card title="Funding rounds" count={profile.fundingRounds.length}>
            <FundingTable rounds={profile.fundingRounds} sources={sources} />
          </Card>

          <Card title="Investors" count={profile.investors.length}>
            <Investors investors={profile.investors} sources={sources} />
          </Card>

          <Card title="Key people" count={profile.keyPeople.length}>
            <QuoteList
              items={profile.keyPeople}
              sources={sources}
              label={(p) => (p.name || p.role) && (
                <p className="text-gray-800 font-medium mb-1">{p.name}{p.name && p.role ? ' · ' : ''}{p.role && <span className="text-gray-500 font-normal">{p.role}</span>}</p>
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
              <ol className="space-y-1 text-sm">
                {sources.map((s) => (
                  <li key={s.n} className="flex gap-2">
                    <span className="text-gray-500 w-8 shrink-0 text-right">[{s.n}]</span>
                    <span>
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700">{s.title}</a>
                      <span className="text-gray-500"> · {s.sourceName}{s.date ? ` · ${s.date}` : ''}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      )}
    </PageShell>
  );
}
