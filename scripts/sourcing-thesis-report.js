const fs = require('fs');
const path = require('path');

const strategyPath = path.join(process.cwd(), 'sources', 'thesis_v2_strategy.json');
const outPath = path.join(process.cwd(), 'reports', 'thesis_v2_report.md');

const data = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
const active = data.active_expanded_registry_sources || [];

function topCounts(rows, key, limit = 20) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] || 'unknown';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

const byRegion = topCounts(active, 'region', 20);
const byTier = topCounts(active, 'tier', 10);
const byMethod = topCounts(active, 'method_type', 10);
const byCategory = topCounts(active, 'category', 25);
const byHost = topCounts(active, 'host', 60);

const lines = [];
lines.push('# Thesis Sourcing v2 Report');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push('');
lines.push('## Strategy scope');
lines.push(`- Must-have sources from thesis doc: **${data.summary.must_have_count}**`);
lines.push(`- Active expanded registry sources: **${data.summary.active_expanded_count}**`);
lines.push(`- Total strategy sources tracked: **${data.summary.total_strategy_sources}**`);
lines.push(`- Target stages: ${data.thesis.stages.join(', ')}`);
lines.push(`- Target geographies: ${data.thesis.geographies.join(', ')}`);
lines.push(`- Target thesis sectors: ${data.thesis.primary.join(', ')}`);
lines.push('');

lines.push('## Region distribution (active sources)');
for (const [k, v] of byRegion) lines.push(`- ${k}: ${v}`);
lines.push('');

lines.push('## Tier distribution (active sources)');
for (const [k, v] of byTier) lines.push(`- ${k}: ${v}`);
lines.push('');

lines.push('## Method distribution (active sources)');
for (const [k, v] of byMethod) lines.push(`- ${k}: ${v}`);
lines.push('');

lines.push('## Top categories (active sources)');
for (const [k, v] of byCategory) lines.push(`- ${k}: ${v}`);
lines.push('');

lines.push('## Top source hosts (active sources)');
for (const [k, v] of byHost) lines.push(`- ${k}: ${v}`);
lines.push('');

lines.push('## Must-have thesis targets (explicit)');
for (const s of data.must_have_targets) {
  lines.push(`- [${s.id}] ${s.name} | region=${s.region} | category=${s.category} | ${s.url}`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`Wrote ${outPath}`);
