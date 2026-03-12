const fs = require('fs');
const path = require('path');

const strategyPath = path.join(process.cwd(), 'sources', 'thesis_v2_strategy.json');
const registryPath = path.join(process.cwd(), 'sources', 'registry.json');
const outJson = path.join(process.cwd(), 'reports', 'thesis_v2_reconciliation.json');
const outMd = path.join(process.cwd(), 'reports', 'thesis_v2_reconciliation.md');

function host(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function norm(s = '') {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const strategy = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

const registryRows = registry.map((r) => ({
  id: r.id,
  name: r.name,
  region: r.region,
  category: r.category,
  stage_bias: r.stage_bias || [],
  url: r.method?.url || '',
  host: host(r.method?.url || ''),
  adapter: r.adapter,
  tier: r.cadence?.tier,
  frequency: r.cadence?.frequency,
}));

function matchTarget(t) {
  const thost = host(t.url || '');
  const tname = norm(t.name || '');

  let matched = registryRows.filter((r) => thost && (r.host === thost || r.host.endsWith(`.${thost}`) || thost.endsWith(`.${r.host}`)));
  if (matched.length) return { method: 'host', matches: matched };

  matched = registryRows.filter((r) => {
    const rn = norm(r.name);
    return rn.includes(tname) || tname.includes(rn);
  });
  if (matched.length) return { method: 'name', matches: matched.slice(0, 5) };

  return { method: 'none', matches: [] };
}

const targets = strategy.must_have_targets || [];
const reconciled = targets.map((t) => {
  const m = matchTarget(t);
  return {
    ...t,
    match_method: m.method,
    matched_count: m.matches.length,
    matched_sources: m.matches.map((x) => ({
      id: x.id,
      name: x.name,
      host: x.host,
      region: x.region,
      category: x.category,
      tier: x.tier,
      frequency: x.frequency,
    })),
  };
});

const byCategory = {};
for (const row of reconciled) {
  const key = row.category || 'unknown';
  if (!byCategory[key]) byCategory[key] = { total: 0, matched: 0, missing: 0, rows: [] };
  byCategory[key].total += 1;
  if (row.match_method === 'none') byCategory[key].missing += 1;
  else byCategory[key].matched += 1;
  byCategory[key].rows.push(row);
}

const summary = {
  generated_at: new Date().toISOString(),
  total_targets: reconciled.length,
  matched_targets: reconciled.filter((x) => x.match_method !== 'none').length,
  missing_targets: reconciled.filter((x) => x.match_method === 'none').length,
  by_category: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, { total: v.total, matched: v.matched, missing: v.missing }])),
};

const out = { summary, reconciled };
fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(out, null, 2));

const lines = [];
lines.push('# Thesis v2 Reconciliation Report');
lines.push('');
lines.push(`Generated: ${summary.generated_at}`);
lines.push(`- Total targets: ${summary.total_targets}`);
lines.push(`- Matched in active registry: ${summary.matched_targets}`);
lines.push(`- Missing from active registry: ${summary.missing_targets}`);
lines.push('');
lines.push('## Coverage by category');
for (const [k, v] of Object.entries(summary.by_category)) {
  lines.push(`- ${k}: matched ${v.matched}/${v.total}, missing ${v.missing}`);
}
lines.push('');
lines.push('## Missing targets');
for (const r of reconciled.filter((x) => x.match_method === 'none')) {
  lines.push(`- [${r.id}] ${r.name} | ${r.region} | ${r.url}`);
}
lines.push('');
lines.push('## Ambiguous/multi-match targets');
for (const r of reconciled.filter((x) => x.match_method !== 'none' && x.matched_count > 1)) {
  lines.push(`- [${r.id}] ${r.name} => ${r.matched_count} matches`);
}

fs.writeFileSync(outMd, lines.join('\n'));
console.log(`Wrote ${outJson}`);
console.log(`Wrote ${outMd}`);
console.log(summary);
