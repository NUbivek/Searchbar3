const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const ROOT = process.cwd();
const RAW_CSV = process.env.SOURCE_SIGNALS_CSV || path.resolve(ROOT, '..', 'sourcing101', 'startup_watch', 'output', 'startup_watch_20260308_194001.csv');
const OUT_DIR = path.join(ROOT, 'reports');

const EUROPE_COUNTRIES = new Set([
  'United Kingdom','Ireland','Germany','France','Netherlands','Belgium','Luxembourg','Spain','Portugal',
  'Italy','Switzerland','Austria','Denmark','Sweden','Norway','Finland','Poland','Czech Republic',
  'Estonia','Latvia','Lithuania','Romania','Bulgaria','Greece','Hungary','Slovakia','Slovenia','Croatia','Serbia','Ukraine'
]);

function normCountry(v='') {
  const s = String(v || '').trim();
  if (!s) return '';
  const upper = s.toUpperCase();
  if (upper === 'UNITED STATES' || upper === 'USA' || upper === 'U.S.' || upper === 'US') return 'United States';
  if (upper === 'UK') return 'United Kingdom';
  if (upper === 'UAE') return 'United Arab Emirates';
  if (upper === 'KOREA') return 'South Korea';
  return s.split(' ').map((w) => w ? (w[0].toUpperCase() + w.slice(1).toLowerCase()) : w).join(' ');
}

function getHost(v='') {
  try {
    const u = new URL(v.startsWith('http') ? v : `https://${v}`);
    return (u.hostname || '').toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function inferCountry(row) {
  const c = normCountry(row.location || '');
  if (c) return { country: c, confidence: 'high', basis: 'row.location' };

  const websiteHost = getHost(row.website || '');
  if (websiteHost.endsWith('.co.uk') || websiteHost.endsWith('.uk')) return { country: 'United Kingdom', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.de')) return { country: 'Germany', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.fr')) return { country: 'France', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.nl')) return { country: 'Netherlands', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.se')) return { country: 'Sweden', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.fi')) return { country: 'Finland', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.no')) return { country: 'Norway', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.it')) return { country: 'Italy', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.es')) return { country: 'Spain', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.ch')) return { country: 'Switzerland', confidence: 'high', basis: 'website_tld' };
  if (websiteHost.endsWith('.il')) return { country: 'Israel', confidence: 'high', basis: 'website_tld' };

  const sourceHost = getHost(row.source_url || '');
  const sourceName = String(row.source_name || '').toLowerCase();

  const usSources = ['skydeck.berkeley.edu', 'entrepreneurship.mit.edu', 'alchemistaccelerator.com', '500.co', 'masschallenge.org'];
  if (usSources.some((h) => sourceHost === h || sourceHost.endsWith(`.${h}`))) {
    return { country: 'United States', confidence: 'assumed', basis: 'source_host_us' };
  }

  const israelSources = ['t3.technion.ac.il', 'yissum.co.il', 'globes.co.il'];
  if (israelSources.some((h) => sourceHost === h || sourceHost.endsWith(`.${h}`)) || /\bisrael\b/.test(sourceName)) {
    return { country: 'Israel', confidence: 'assumed', basis: 'source_host_israel' };
  }

  const euSources = ['sifted.eu', 'tech.eu'];
  if (euSources.some((h) => sourceHost === h || sourceHost.endsWith(`.${h}`))) {
    return { country: 'United Kingdom', confidence: 'assumed', basis: 'source_host_europe' };
  }

  return { country: 'Unknown', confidence: 'unknown', basis: 'none' };
}

function regionOf(country='') {
  if (country === 'United States') return 'US';
  if (country === 'Israel') return 'Israel';
  if (EUROPE_COUNTRIES.has(country)) return 'Europe';
  return null;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

(function main() {
  const content = fs.readFileSync(RAW_CSV, 'utf8');
  const parsed = parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });

  const out = [];
  const seen = new Set();
  for (const row of parsed) {
    const name = String(row.company_name || '').trim();
    if (!name) continue;
    if (name.length > 80) continue;

    const inferred = inferCountry(row);
    const country = inferred.country;
    const region = regionOf(country);
    if (!region) continue;

    const key = `${name.toLowerCase()}|${country}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      startup_name: name,
      country,
      region,
      geo_confidence: inferred.confidence,
      geo_basis: inferred.basis,
      stage: row.stage || 'unknown',
      source_name: row.source_name || '',
      source_url: row.source_url || '',
      startup_url: row.website || '',
      description: row.description || '',
      notes: row.notes || '',
    });
  }

  out.sort((a, b) => a.startup_name.localeCompare(b.startup_name));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, 'priority_leads_us_europe_israel_max_recall.json');
  const csvPath = path.join(OUT_DIR, 'priority_leads_us_europe_israel_max_recall.csv');
  const summaryPath = path.join(OUT_DIR, 'priority_leads_us_europe_israel_max_recall_summary.md');

  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  fs.writeFileSync(csvPath, toCsv(out));

  const byRegion = out.reduce((a, r) => ((a[r.region] = (a[r.region] || 0) + 1), a), {});
  const byCountry = out.reduce((a, r) => ((a[r.country] = (a[r.country] || 0) + 1), a), {});
  const byGeoConfidence = out.reduce((a, r) => ((a[r.geo_confidence] = (a[r.geo_confidence] || 0) + 1), a), {});

  const lines = [];
  lines.push('# Priority Leads Summary (US + Europe + Israel) — MAX RECALL');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Raw source CSV: ${RAW_CSV}`);
  lines.push(`Total leads: ${out.length}`);
  lines.push('');
  lines.push('## By region');
  for (const [k, v] of Object.entries(byRegion).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('## Top countries');
  for (const [k, v] of Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 25)) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('## Geo confidence');
  for (const [k, v] of Object.entries(byGeoConfidence).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push(`JSON: ${jsonPath}`);
  lines.push(`CSV: ${csvPath}`);
  fs.writeFileSync(summaryPath, lines.join('\n'));

  console.log({ total: out.length, byRegion, jsonPath, csvPath, summaryPath });
})();
