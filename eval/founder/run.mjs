// Runs one deep Founder Check against a running server and saves the report.
//   node run.mjs "Elizabeth Holmes" "Theranos" [outDir]
// BASE=http://localhost:3009 by default (the server must allow public checks locally: FOUNDER_DEEP_PUBLIC=true).
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.BASE || 'http://localhost:3009';
const [name, company = '', outDir = '.'] = process.argv.slice(2);
if (!name) { console.error('usage: node run.mjs "<name>" "<company>" [outDir]'); process.exit(2); }
const slug = `${name}-${company}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function call(body) {
  const res = await fetch(`${base}/api/founder/deep`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json.error || text.slice(0, 300)}`);
  return json;
}

const t0 = Date.now();
let out = await call({ action: 'start', name, company });
const { jobId } = out;
console.log(`JOB ${jobId}`);
let seenLog = 0;
const show = (p) => {
  const fresh = (p.log || []).filter((l) => !shown.has(l.text));
  for (const l of fresh) { shown.add(l.text); console.log(`   · ${l.text}`); }
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] round ${p.step} · ${p.tasksRun} lookups · ${p.findings} records · queued ${p.queued} · threads ${JSON.stringify(p.threads)} · match ${JSON.stringify(p.byMatch)}`);
};
const shown = new Set();
show(out.progress);
for (let i = 0; i < 60 && !out.done; i += 1) {
  out = await call({ action: 'step', jobId });
  if (out.progress) show(out.progress);
}
if (!out.done) { console.error('did not finish in 60 steps'); process.exit(1); }
const r = out.report;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify(r, null, 1));

const line = (f) => `   [${f.n}] (${f.match}/${f.severity}) ${f.sourceLabel} · ${f.date || 'n.d.'} · ${f.title.slice(0, 150)}`;
console.log(`\n===== ${r.name}${r.company ? ` / ${r.company}` : ''} — ${Math.round((Date.now() - t0) / 1000)}s, ${r.coverage.rounds} rounds, ${r.coverage.lookups} lookups`);
console.log(`identity: ${r.identity?.status}${r.identity?.note ? ` — ${r.identity.note}` : ''}`);
console.log(`totals: ${JSON.stringify(r.totals)}`);
console.log(`dropped: ${JSON.stringify(r.coverage.dropped)}`);
console.log('\nSOURCES (lookups / records / failed):');
for (const s of r.coverage.searched) console.log(`   ${s.label}: ${s.lookups} / ${s.records} / ${s.failed}${s.lastError ? `  ← ${s.lastError.slice(0, 110)}` : ''}`);
if (r.coverage.notSearched.length) { console.log('NOT SEARCHED:'); for (const s of r.coverage.notSearched) console.log(`   ${s.label}: ${s.reason.slice(0, 120)}`); }
console.log(`\nRED FLAGS (${r.redFlags.length}):`); r.redFlags.slice(0, 25).forEach((f) => console.log(line(f)));
console.log(`\nPOSSIBLE NAMESAKES (${r.possibleNamesake.length}):`); r.possibleNamesake.slice(0, 10).forEach((f) => console.log(line(f)));
console.log(`\nCLAIMS THAT CHANGED (${r.claimChanges.length}):`); r.claimChanges.slice(0, 12).forEach((f) => { console.log(line(f)); console.log(`        ${String(f.quote).slice(0, 260)}`); });
console.log(`\nRELATED PARTIES (${r.relatedParties.length}):`); r.relatedParties.slice(0, 20).forEach((p) => console.log(`   ${p.kind}${p.relation ? ` (${p.relation})` : ''}: ${p.name} — ${p.why.slice(0, 100)} — ${p.records.length} records`));
console.log(`\nTHREADS FOLLOWED (${r.threads.length}): ${r.threads.map((t) => `${t.kind}:${t.value}`).join(' | ').slice(0, 1500)}`);
console.log('\nSECTIONS:'); for (const s of r.sections) { console.log(` ${s.title} (${s.items.length})`); s.items.slice(0, 6).forEach((f) => console.log(line(f))); }
console.log(`\nTIMELINE (${r.timeline.length}): ${r.timeline.slice(0, 14).map((t) => `${t.date} ${t.title.slice(0, 60)}`).join(' || ')}`);
console.log(`\nBRIEF (${r.briefInfo?.mode}${r.briefInfo?.model ? `, ${r.briefInfo.model}` : ''}${r.briefInfo?.reason ? `, ${r.briefInfo.reason}` : ''}):\n${String(r.brief || '').slice(0, 1800)}`);
