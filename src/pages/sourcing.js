import React from 'react';
import Head from 'next/head';
import ModeTabs from '../components/ModeTabs';

const PAGE_SIZE = 25;

const TIER_LABELS = {
  A: 'Tier A — Top-Tier VCs & Accelerators',
  B: 'Tier B — Mid-Market VCs & Specialist Funds',
  C: 'Tier C — Regional & Emerging Funds',
  1: 'Tier 1 — Top-Tier VCs & Accelerators',
  2: 'Tier 2 — Mid-Market VCs & Specialist Funds',
  3: 'Tier 3 — Regional & Emerging Funds',
};

const TIER_OPTIONS = [
  { value: '', label: 'All Tiers' },
  { value: 'A', label: 'Tier A — Top-Tier VCs' },
  { value: 'B', label: 'Tier B — Mid-Market' },
  { value: 'C', label: 'Tier C — Regional' },
  { value: '1', label: 'Tier 1 — Top-Tier VCs' },
  { value: '2', label: 'Tier 2 — Mid-Market' },
  { value: '3', label: 'Tier 3 — Regional' },
];

function getTierLabel(tier) {
  if (tier == null || tier === '' || tier === 'all') return 'Tier (All)';
  const raw = String(tier);
  return TIER_LABELS[raw.toUpperCase()] || TIER_LABELS[raw] || `Tier ${raw}`;
}

function getTierBadgeLabel(tier) {
  if (tier == null || tier === '' || tier === 'all') return null;
  return String(tier).toUpperCase();
}

function formatSourceName(name) {
  if (!name) return 'Unknown Source';
  let value = String(name).trim();
  if (!value) return 'Unknown Source';
  if (!value.includes(' ') && value.includes('.')) {
    value = value.split('.')[0];
  }
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function cleanSectorOptions(rows = [], facetSectors = []) {
  const SAAS_MAP = {
    SaaS: 'B2B Software',
    'Enterprise SaaS': 'B2B Software',
    'B2B SaaS': 'B2B Software',
  };
  const values = [
    ...facetSectors,
    ...rows.flatMap((row) => Array.isArray(row.thesis_tags) ? row.thesis_tags : []),
  ];
  return ['all', ...Array.from(new Set(
    values
      .map((value) => SAAS_MAP[String(value || '').trim()] || String(value || '').trim())
      .filter((value) => value && !/[|_]/.test(value) && value.length <= 20)
  )).sort()];
}

function FundingCell({ row }) {
  const amt = row.funding_usd;
  const total = row.total_funding_usd;
  const round = row.last_round_type;
  const date = row.last_round_date;
  const confidence = row.funding_confidence;

  if (!amt && confidence === 'not_found') {
    return <span className="text-gray-400 text-xs">No data</span>;
  }

  const formatFundingDate = (dateStr) => {
    if (!dateStr) return null;
    if (!/^\d{4}-\d{2}/.test(String(dateStr))) return null;
    const normalized = String(dateStr).length === 7 ? `${dateStr}-01` : String(dateStr);
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };

  const formatFundingAmount = (usd) => {
    if (!usd || usd <= 0) return null;
    if (usd < 10_000) return null;
    if (usd >= 1_000_000_000) return `$${Math.round(usd / 1_000_000_000)}B`;
    if (usd >= 1_000_000) return `$${Math.round(usd / 1_000_000)}M`;
    if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
    return `$${usd}`;
  };

  const formattedAmount = formatFundingAmount(amt);
  const formattedDate = formatFundingDate(date);
  const formattedTotal = total && total !== amt ? formatFundingAmount(total) : null;
  const inlineParts = [formattedAmount, round && round !== 'Unknown' ? round : null, formattedDate].filter(Boolean);

  return (
    <div className="text-sm flex flex-wrap items-center gap-x-1 gap-y-1">
      {inlineParts.length
        ? <span><span className="font-medium">{inlineParts[0]}</span>{inlineParts.slice(1).map((part) => ` · ${part}`).join('')}</span>
        : null}
      {confidence === 'low'
        ? <span className="text-yellow-400 text-xs" title="Estimated">~</span>
        : null}
      {formattedTotal
        ? <div className="basis-full text-gray-400 text-xs">Total: {formattedTotal}</div>
        : null}
    </div>
  );
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

export default function SourcingPage() {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [result, setResult] = React.useState(null);

  const [q, setQ] = React.useState('');
  const [stage, setStage] = React.useState('all');
  const [country, setCountry] = React.useState('all');
  const [sector, setSector] = React.useState('all');
  const [sourceTier, setSourceTier] = React.useState('all');
  const [sourceName, setSourceName] = React.useState('all');
  const [minFunding, setMinFunding] = React.useState('');
  const [maxFunding, setMaxFunding] = React.useState('');
  const [minScore, setMinScore] = React.useState('0');
  const [qualityScore, setQualityScore] = React.useState('30');
  const [likelyOnly, setLikelyOnly] = React.useState(false);
  const [page, setPage] = React.useState(1);

  const runQuery = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('page_size', String(PAGE_SIZE));
      params.set('likely_only', String(likelyOnly));
      params.set('min_score', String(likelyOnly ? (minScore || 0) : 0));
      params.set('quality_score', String(qualityScore || 0));
      if (q) params.set('q', q);
      if (stage !== 'all') params.set('stage', stage);
      if (country !== 'all') params.set('country', country);
      if (sector !== 'all') params.set('sector', sector);
      if (sourceTier !== 'all') params.set('source_tier', sourceTier);
      if (sourceName !== 'all') params.set('source_name', sourceName);
      if (minFunding) params.set('min_funding', minFunding);
      if (maxFunding) params.set('max_funding', maxFunding);

      const r = await fetch(`/api/startups/raise-candidates?${params.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Failed to fetch raise candidates');
      setResult(j);
    } catch (e) {
      setError(e.message || 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [page, likelyOnly, minScore, qualityScore, q, stage, country, sector, sourceTier, sourceName, minFunding, maxFunding]);

  React.useEffect(() => { runQuery(); }, [runQuery]);

  const refreshIngestion = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/startups/raise-candidates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Refresh failed');
      await runQuery();
    } catch (e) {
      setError(e.message || 'Refresh failed');
      setLoading(false);
    }
  };

  const rows = result?.rows || [];
  const total = result?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const effectiveMinScore = likelyOnly ? Number(minScore || 0) : 0;

  const stageValues = ((result?.facets?.stages) || Array.from(new Set(rows.map((r) => r.stage).filter(Boolean))));
  const stages = ['all', 'Stealth', 'Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Unknown']
    .filter((value) => value === 'all' || stageValues.includes(value));
  const countryBase = ((result?.facets?.countries) || Array.from(new Set(rows.map((r) => r.hq_country).filter(Boolean))));
  const countries = ['all', ...Array.from(new Set(['United States', ...countryBase].filter(Boolean)))];
  const sectors = cleanSectorOptions(rows, result?.facets?.sectors || []);
  const sourceTierValues = new Set(((result?.facets?.sourceTiers) || Array.from(new Set(rows.map((r) => r.source_tier).filter(Boolean))))
    .filter((value) => value && value !== 'Unknown'));
  const sourceTiers = TIER_OPTIONS.filter((option) => !option.value || sourceTierValues.has(option.value));
  const sourceNames = ['all', ...((result?.facets?.sources) || Array.from(new Set(rows.map((r) => r.source_name).filter(Boolean))))];

  const downloadRawTable = () => {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `raise-candidates-page-${page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-blue-50/30 to-indigo-50/20">
      <Head>
        <title>Sourcing Output - Research Hub</title>
      </Head>

      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Sourcing Control Center</h1>
          <p className="mt-2 text-slate-600">12-month retained lead intelligence with next-6-month raise-likelihood scoring.</p>
        </div>

        <ModeTabs activeMode="sourcing" />

        <div className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Raise Candidates</h2>
              <p className="text-sm text-slate-600">Real source-fed startup signals only. Ranked by raise likelihood + recency.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={runQuery} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm hover:bg-slate-50">Refresh View</button>
              <button onClick={refreshIngestion} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">Run Local Ingestion</button>
            </div>
          </div>

          {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Lead Summary</div>
            <div className="mt-1 text-sm text-slate-700">
              These are startups with signals indicating potential fundraising in the next 6 months: time since last round, momentum, accelerator activity,
              investor quality, and confidence from source evidence. Results are selected by your active filters and sorted by likelihood then recency.
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
            <div className="overflow-x-auto pb-1 scrollbar-hide">
              <div className="flex flex-nowrap gap-2 items-center min-w-max">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-10 flex-shrink-0 min-w-[13rem] rounded-lg border border-slate-200 bg-white px-3 text-sm" />
                <select value={stage} onChange={(e) => setStage(e.target.value)} className="h-10 flex-shrink-0 min-w-[8rem] rounded-lg border border-slate-200 bg-white px-3 text-sm">{stages.map((s) => <option key={s} value={s}>{s === 'all' ? 'Stage (All)' : s}</option>)}</select>
                <select value={country} onChange={(e) => setCountry(e.target.value)} className="h-10 flex-shrink-0 min-w-[9rem] rounded-lg border border-slate-200 bg-white px-3 text-sm">{countries.map((s) => <option key={s} value={s}>{s === 'all' ? 'Country (All)' : s}</option>)}</select>
                <select value={sector} onChange={(e) => setSector(e.target.value)} className="h-10 flex-shrink-0 min-w-[9rem] rounded-lg border border-slate-200 bg-white px-3 text-sm">{sectors.map((s) => <option key={s} value={s}>{s === 'all' ? 'Sector (All)' : s}</option>)}</select>
                <select value={sourceTier} onChange={(e) => setSourceTier(e.target.value)} className="h-10 flex-shrink-0 min-w-[9rem] rounded-lg border border-slate-200 bg-white px-3 text-sm">{sourceTiers.map((option) => <option key={option.value || 'all'} value={option.value || 'all'}>{option.label}</option>)}</select>
                <select value={sourceName} onChange={(e) => setSourceName(e.target.value)} className="h-10 flex-shrink-0 min-w-[10rem] rounded-lg border border-slate-200 bg-white px-3 text-sm">{sourceNames.map((s) => <option key={s} value={s}>{s === 'all' ? 'Source (All)' : s}</option>)}</select>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-12">
              <input value={minFunding} onChange={(e) => setMinFunding(e.target.value)} placeholder="Min funding $" type="number" className="h-10 md:col-span-2 rounded-lg border border-slate-200 bg-white px-3 text-sm" />
              <input value={maxFunding} onChange={(e) => setMaxFunding(e.target.value)} placeholder="Max funding $" type="number" className="h-10 md:col-span-2 rounded-lg border border-slate-200 bg-white px-3 text-sm" />
              <label className="h-10 md:col-span-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm"><input type="checkbox" checked={likelyOnly} onChange={(e) => { const v=e.target.checked; setLikelyOnly(v); if (!v) setMinScore('0'); if (v && Number(minScore) < 30) setMinScore('30'); }} /> {'Raising <6months'}</label>
              <button onClick={() => { setQ(''); setStage('all'); setCountry('all'); setSector('all'); setSourceTier('all'); setSourceName('all'); setMinFunding(''); setMaxFunding(''); setMinScore('0'); setQualityScore('30'); setLikelyOnly(false); setPage(1); }} className="h-10 md:col-span-2 rounded-lg border border-slate-200 bg-white px-3 text-sm hover:bg-slate-50">Reset filters</button>
              <div className="h-10 md:col-span-2 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 flex items-center justify-between gap-2">
                <span>Total: <span className="font-semibold">{total}</span></span>
                <span>Page: <span className="font-semibold">{page}/{pageCount}</span></span>
                {loading ? <span className="inline-flex items-center gap-1 text-[10px] text-indigo-600"><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600" />WIP</span> : null}
              </div>
              <div className="h-10 md:col-span-2 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-700 flex items-center">
                <span className="mr-2 whitespace-nowrap">Quality</span>
                <input value={qualityScore} onChange={(e) => setQualityScore(e.target.value)} min="0" max="100" step="1" type="range" className="w-full" />
                <span className="ml-2 font-semibold whitespace-nowrap">{qualityScore}%</span>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-12">
              <div className="md:col-span-10 rounded-xl border border-slate-200 bg-white p-2 text-xs text-slate-700">
                <div className="leading-5 break-words">Query: <span className="font-medium">{q || 'none'}</span> · Stage: <span className="font-medium">{stage}</span> · Country: <span className="font-medium">{country}</span> · Sector: <span className="font-medium">{sector}</span> · Source Tier: <span className="font-medium">{sourceTier === 'all' ? 'all' : getTierLabel(sourceTier)}</span> · Source: <span className="font-medium">{sourceName}</span> · Funding: <span className="font-medium">{minFunding || 0} - {maxFunding || 'max'}</span> · Min Score: <span className="font-medium">{effectiveMinScore}</span> · Quality: <span className="font-medium">{qualityScore}</span> · Likely Only: <span className="font-medium">{likelyOnly ? 'yes' : 'no'}</span></div>
                <div className="mt-1 text-[10px] text-slate-500">Sorting: raise_likelihood_score desc, then last_signal_at desc.</div>
              </div>
              <div className="md:col-span-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm md:justify-self-end md:w-full">
                <div>
                  <div className="flex items-center justify-between text-[11px] text-slate-600">
                    <span>Raise Probability</span>
                    <span className="font-semibold">{effectiveMinScore}%</span>
                  </div>
                  <input value={minScore} onChange={(e) => setMinScore(e.target.value)} min="0" max="100" step="1" type="range" className="mt-1 w-full" />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-slate-200">
            <div className="border-b bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Startup Raise Candidates</div>
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-white">
                  <tr className="text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3 text-left">Startup</th>
                    <th className="px-4 py-3 text-left">URL</th>
                    <th className="px-4 py-3 text-left">Description Summary</th>
                    <th className="px-4 py-3 text-left">Stage</th>
                    <th className="px-4 py-3 text-left">Funding ($)</th>
                    <th className="px-4 py-3 text-left">Country</th>
                    <th className="px-4 py-3 text-left">Score</th>
                    <th className="px-4 py-3 text-left">6m Forecast</th>
                    <th className="px-4 py-3 text-left">Why Selected</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td className="px-4 py-6 text-slate-500" colSpan={9}>{loading ? 'Loading…' : 'No rows match current filters.'}</td></tr>
                  ) : rows.map((row) => (
                    <tr key={row.id} className="border-t odd:bg-white even:bg-slate-50/40">
                      <td className="px-4 py-3 font-semibold text-slate-900">{row.startup_name}</td>
                      <td className="px-4 py-3 text-blue-700">
                        {(() => {
                          const rawUrl = row.startup_url;
                          if (!rawUrl) return <span className="text-slate-400">—</span>;
                          const href = String(rawUrl).startsWith('http') ? rawUrl : `https://${rawUrl}`;
                          return <a href={href} target="_blank" rel="noreferrer" className="hover:underline">{rawUrl}</a>;
                        })()}
                      </td>
                      <td className="px-4 py-3 text-slate-700 align-top">
                        <div className="space-y-1 text-xs leading-5">
                          <div>{row.description_summary || row.description || 'No summary available.'}</div>
                          <div className="text-slate-500">Source: {formatSourceName(row.source_name || row.source_key || 'unknown')}</div>
                          {row.source_tier && row.source_tier !== 'Unknown' ? (
                            <div className="text-slate-400 text-[11px]" title={row.tier_display_label || ''}>
                              <span className="inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800 mr-1">{getTierBadgeLabel(row.source_tier)}</span>
                              {row.tier_display_label || ''}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{row.stage}</td>
                      <td className="px-4 py-3 text-slate-700"><FundingCell row={row} /></td>
                      <td className="px-4 py-3 text-slate-700">{row.hq_country}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${row.raise_likelihood_score >= 80 ? 'bg-emerald-100 text-emerald-700' : row.raise_likelihood_score >= 65 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-700'}`}>
                          {row.raise_likelihood_score}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        <div className="text-xs font-medium">{row.forecast_6m_label || (row.likely_raising_6m ? 'Likely in ≤6 months' : 'Not likely in ≤6 months')}</div>
                        <div className="text-xs text-slate-500">{row.forecast_6m_probability || '—'}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        <details>
                          <summary className="cursor-pointer text-sm text-slate-700 hover:text-slate-900">View rationale</summary>
                          <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">
                            {(row.reasons || []).map((reason, i) => (
                              <li key={`${row.id}-reason-${i}`}>{reason}</li>
                            ))}
                          </ul>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <div>Showing {total ? (page - 1) * PAGE_SIZE + 1 : 0}-{Math.min(page * PAGE_SIZE, total)} of {total}</div>
            <div className="flex items-center gap-2">
              <button disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} className="rounded border border-slate-200 px-3 py-1 disabled:opacity-40">Prev</button>
              <span>{page}/{pageCount}</span>
              {loading ? <span className="inline-flex items-center gap-1 text-[11px] text-indigo-600"><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600" />WIP</span> : null}
              <button disabled={page >= pageCount || loading} onClick={() => setPage((p) => p + 1)} className="rounded border border-slate-200 px-3 py-1 disabled:opacity-40">Next</button>
            </div>
          </div>

          <details className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <summary className="flex cursor-pointer list-none items-center justify-between border-b bg-slate-50 px-4 py-3">
              <div className="text-sm font-semibold text-slate-700">Raw Response (Table Format)</div>
              <button type="button" onClick={(e) => { e.preventDefault(); downloadRawTable(); }} className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs hover:bg-slate-50">Download CSV</button>
            </summary>
            <div className="overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-white">
                  <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                    {rows.length ? Object.keys(rows[0]).map((k) => <th key={k} className="px-3 py-2 text-left">{k}</th>) : <th className="px-3 py-2 text-left">No data</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.id}-${i}`} className="border-t odd:bg-white even:bg-slate-50/30">
                      {Object.keys(rows[0]).map((k) => <td key={k} className="px-3 py-2 whitespace-nowrap">{Array.isArray(r[k]) ? r[k].join('; ') : String(r[k] ?? '')}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </main>
    </div>
  );
}
