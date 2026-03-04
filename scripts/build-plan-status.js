const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function exists(relPath) {
  return fs.existsSync(path.join(process.cwd(), relPath));
}

function fileContains(relPath, pattern) {
  const abs = path.join(process.cwd(), relPath);
  if (!fs.existsSync(abs)) return false;
  const content = fs.readFileSync(abs, 'utf-8');
  return pattern.test(content);
}

function run(cmd) {
  try {
    return execSync(cmd, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function getRegistryStats() {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'sources', 'registry.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const sources = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.sources) ? parsed.sources : []);
    const methodCounts = {};
    const tierCounts = {};
    for (const source of sources) {
      const method = source?.method?.type || 'unknown';
      const tier = source?.cadence?.tier || 'unknown';
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    }
    const htmlLike = (methodCounts.rss || 0) + (methodCounts.html || 0);
    const htmlLikeRatio = sources.length === 0 ? 0 : htmlLike / sources.length;
    return { count: sources.length, methodCounts, tierCounts, htmlLikeRatio };
  } catch {
    return { count: 0, methodCounts: {}, tierCounts: {}, htmlLikeRatio: 0 };
  }
}

function getGitDelta() {
  const unstaged = run('git diff --numstat');
  const staged = run('git diff --cached --numstat');
  let added = 0;
  let deleted = 0;
  const parse = (text) => {
    for (const line of text.split('\n')) {
      if (!line) continue;
      const [a, d] = line.split('\t');
      if (/^\d+$/.test(a)) added += Number(a);
      if (/^\d+$/.test(d)) deleted += Number(d);
    }
  };
  parse(unstaged);
  parse(staged);
  return { added, deleted };
}

function check(label, done) {
  return { label, done: Boolean(done) };
}

function phase(name, checks) {
  const doneCount = checks.filter((item) => item.done).length;
  const pct = checks.length === 0 ? 0 : Math.round((doneCount / checks.length) * 100);
  return { name, checks, doneCount, total: checks.length, pct };
}

const registryStats = getRegistryStats();
const workingTreeClean = run('git status --porcelain') === '';
const delta = getGitDelta();

const phases = [
  phase('Phase A - Search Reliability', [
    check('Fail-soft contract in /api/search', fileContains('src/pages/api/search/index.js', /normalizeSearchResponseV1/)),
    check('HackerNews safety-net fallback', fileContains('src/pages/api/search/index.js', /api\/search\/hackernews/)),
    check('Provider settled orchestration', fileContains('src/utils/sourceIntegration.js', /Promise\.allSettled/)),
    check('Upload parser route for PDF/DOCX/CSV/TXT', exists('src/pages/api/upload.js') && exists('src/utils/fileProcessing.js')),
    check('URL extraction route', exists('src/pages/api/fetch-url.js') && exists('src/utils/urlExtraction.js')),
    check('Route timeout guards in auth/search paths', fileContains('src/pages/api/auth/twitter/token.js', /timeout:\s*\w+/)),
    check('Fail-soft route tests present', exists('tests/unit/api/searchIndexFailSoftRoute.test.js')),
  ]),
  phase('Phase B - Product Gaps and Discipline', [
    check('Cross-platform smoke scripts', exists('scripts/api-smoke.js') && exists('scripts/api-smoke-local.js')),
    check('Build pipeline script', fileContains('package.json', /"build":\s*"next build"/)),
    check('Upload and fetch-url route tests', exists('tests/unit/api/uploadRoute.coverage2.test.js') && exists('tests/unit/api/fetchUrlRoute.coverage2.test.js')),
    check('Degraded banner component', exists('src/components/search/DegradedBanner.js')),
    check('Working tree clean', workingTreeClean),
  ]),
  phase('Phase C - Sourcing Foundation', [
    check('Source registry file', exists('sources/registry.json')),
    check('Registry schema validation', exists('src/sourcing/schema.js') && exists('src/sourcing/registry.js')),
    check('Adapter framework', exists('src/sourcing/adapters/baseAdapter.js') && exists('src/sourcing/adapters/index.js')),
    check('StartupSignal schema', exists('src/sourcing/signalSchema.js')),
    check('Append-only signal writer', exists('src/sourcing/writer.js')),
  ]),
  phase('Phase D - Scheduler and Incremental Crawling', [
    check('Scheduler planner', exists('src/sourcing/planner.js')),
    check('Runner orchestrator', exists('src/sourcing/runner.js')),
    check('State storage and cursors', exists('src/sourcing/state.js')),
    check('Incremental run tests', fileContains('tests/unit/sourcing.test.js', /secondRun\.rollupCount\)\.toBe\(0\)/)),
    check('Auth-required source gating', fileContains('src/sourcing/runner.js', /requires_auth/)),
  ]),
  phase('Phase E - 200+ Source Expansion', [
    check('Registry >= 200 sources', registryStats.count >= 200),
    check('Tier A/B/C present', ['A', 'B', 'C'].every((tier) => (registryStats.tierCounts[tier] || 0) > 0)),
    check('>= 70% RSS/HTML mix', registryStats.htmlLikeRatio >= 0.7),
    check('Tier-A adapter coverage (HN + templates)', exists('src/sourcing/adapters/hnAlgoliaAdapter.js') && exists('src/sourcing/adapters/rssAdapter.js') && exists('src/sourcing/adapters/htmlListAdapter.js')),
  ]),
  phase('Phase F - Enrichment, Filters, Scoring', [
    check('Enrichment module (website/funding/investor/headcount)', exists('src/sourcing/enrichment.js')),
    check('Stage + thesis enforcement filter', fileContains('src/sourcing/runner.js', /hasStage/) && fileContains('src/sourcing/runner.js', /hasThesisTags/)),
    check('Confidence scoring in normalizer', fileContains('src/sourcing/normalizer.js', /confidence/)),
    check('Daily rollup writer', exists('src/sourcing/rollup.js')),
    check('CRM export writer', exists('src/sourcing/crmExport.js')),
  ]),
  phase('Phase G - Operational Guardrails', [
    check('Per-source rate-limit runtime config', fileContains('src/sourcing/registry.js', /rateLimitWindowHours/)),
    check('No single source crash fan-out', fileContains('src/sourcing/runner.js', /Promise\.allSettled/) || fileContains('src/utils/sourceIntegration.js', /Promise\.allSettled/)),
    check('Auth-required sources feature-flagged', fileContains('src/sourcing/planner.js', /includeAuthSources/) && fileContains('src/sourcing/runner.js', /includeAuthSources/)),
    check('Minimal evidence snippet storage', fileContains('src/sourcing/normalizer.js', /slice\(0,\s*500\)/)),
  ]),
];

const totalChecks = phases.reduce((sum, item) => sum + item.total, 0);
const totalDone = phases.reduce((sum, item) => sum + item.doneCount, 0);
const overallPct = totalChecks === 0 ? 0 : Math.round((totalDone / totalChecks) * 100);

console.log(`# Build Plan Status`);
console.log(``);
console.log(`Overall completion: ${overallPct}% (${totalDone}/${totalChecks} checks)`);
console.log(`Registry sources: ${registryStats.count}`);
console.log(`RSS/HTML ratio: ${(registryStats.htmlLikeRatio * 100).toFixed(1)}%`);
console.log(`Working tree delta: +${delta.added} / -${delta.deleted}`);
console.log(``);

for (const item of phases) {
  console.log(`## ${item.name} - ${item.pct}% (${item.doneCount}/${item.total})`);
  for (const c of item.checks) {
    console.log(`- [${c.done ? 'x' : ' '}] ${c.label}`);
  }
  console.log('');
}
