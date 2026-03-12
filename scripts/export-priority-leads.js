const fs = require('fs');
const path = require('path');

const API_BASE = process.env.RAISE_CANDIDATES_API_BASE || 'http://localhost:3000/api/startups/raise-candidates';
const OUT_DIR = path.join(process.cwd(), 'reports');

const TARGET_STAGES = new Set(['stealth', 'pre-seed', 'pre_seed', 'seed', 'series_a', 'series_b']);
const EUROPE_COUNTRIES = new Set([
  'United Kingdom', 'Ireland', 'Germany', 'France', 'Netherlands', 'Belgium', 'Luxembourg', 'Spain', 'Portugal',
  'Italy', 'Switzerland', 'Austria', 'Denmark', 'Sweden', 'Norway', 'Finland', 'Poland', 'Czech Republic',
  'Estonia', 'Latvia', 'Lithuania', 'Romania', 'Bulgaria', 'Greece', 'Hungary', 'Slovakia', 'Slovenia',
  'Croatia', 'Serbia', 'Ukraine'
]);

function normalizeStage(stage = '') {
  return String(stage || '').toLowerCase().replace(/\s+/g, '_');
}

function regionOf(country = '') {
  if (country === 'United States') return 'US';
  if (country === 'Israel') return 'Israel';
  if (EUROPE_COUNTRIES.has(country)) return 'Europe';
  return null;
}

async function fetchAll() {
  let page = 1;
  const all = [];
  while (true) {
    const u = `${API_BASE}?likely_only=false&min_score=0&page_size=200&page=${page}`;
    const r = await fetch(u);
    const j = await r.json();
    const rows = j.rows || [];
    all.push(...rows);
    if (rows.length < 200) break;
    page += 1;
  }
  return all;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

(async () => {
  const rows = await fetchAll();
  const filtered = rows
    .filter((r) => TARGET_STAGES.has(normalizeStage(r.stage)))
    .map((r) => ({ ...r, target_region: regionOf(r.hq_country) }))
    .filter((r) => r.target_region);

  const seen = new Set();
  const deduped = [];
  for (const row of filtered) {
    const key = `${String(row.startup_name || '').trim().toLowerCase()}|${row.hq_country || ''}|${row.source_host || ''}`;
    if (!row.startup_name || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  deduped.sort((a, b) => {
    if (b.raise_likelihood_score !== a.raise_likelihood_score) return b.raise_likelihood_score - a.raise_likelihood_score;
    return new Date(b.last_signal_at).getTime() - new Date(a.last_signal_at).getTime();
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const slim = deduped.map((r) => ({
    startup_name: r.startup_name,
    stage: r.stage,
    country: r.hq_country,
    region: r.target_region,
    sector: r.sector,
    score: r.raise_likelihood_score,
    forecast: r.forecast_6m_label,
    source_host: r.source_host,
    startup_url: r.startup_url,
    source_url: r.source_url,
    source_summary: r.source_summary,
  }));

  const jsonPath = path.join(OUT_DIR, 'priority_leads_us_europe_israel.json');
  const csvPath = path.join(OUT_DIR, 'priority_leads_us_europe_israel.csv');
  fs.writeFileSync(jsonPath, JSON.stringify(slim, null, 2));
  fs.writeFileSync(csvPath, toCsv(slim));

  const byRegion = slim.reduce((a, r) => ((a[r.region] = (a[r.region] || 0) + 1), a), {});
  const byCountry = slim.reduce((a, r) => ((a[r.country] = (a[r.country] || 0) + 1), a), {});

  const summaryPath = path.join(OUT_DIR, 'priority_leads_us_europe_israel_summary.md');
  const lines = [];
  lines.push('# Priority Leads Summary (US + Europe + Israel)');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total leads: ${slim.length}`);
  lines.push('');
  lines.push('## By region');
  for (const [k, v] of Object.entries(byRegion).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('## Top countries');
  for (const [k, v] of Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 20)) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push(`JSON: ${jsonPath}`);
  lines.push(`CSV: ${csvPath}`);
  fs.writeFileSync(summaryPath, lines.join('\n'));

  console.log({ total: slim.length, byRegion, jsonPath, csvPath, summaryPath });
})();
