const fs = require('fs');
const path = require('path');

const registryPath = path.join(process.cwd(), 'sources', 'registry.json');
const reconPath = path.join(process.cwd(), 'reports', 'thesis_v2_reconciliation.json');

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const recon = JSON.parse(fs.readFileSync(reconPath, 'utf8'));

const missing = (recon.reconciled || []).filter((r) => r.match_method === 'none');
const existingIds = new Set(registry.map((r) => r.id));

function normalizeRegion(region = 'Global') {
  const r = String(region).toLowerCase();
  if (r.includes('us')) return 'US';
  if (r.includes('canada')) return 'US'; // keep schema-compatible footprint with existing registry regions
  if (r.includes('uk')) return 'EU';
  if (r.includes('europe') || r.includes('eu')) return 'EU';
  if (r.includes('israel')) return 'EU';
  if (r.includes('australia') || r.includes('new zealand')) return 'Global';
  return 'Global';
}

function inferCategory(cat = '') {
  if (cat === 'university_incubator' || cat === 'accelerator') return 'accelerator_portfolio';
  if (cat === 'vc_portfolio') return 'venture_portfolio';
  if (cat === 'news_rss') return 'funding_news';
  if (cat === 'database') return 'startup_ecosystem';
  if (cat === 'industry_specialist') return 'market_analysis';
  if (cat === 'social_signal') return 'startup_news';
  return 'startup_news';
}

function inferMethod(url = '') {
  const u = String(url).toLowerCase();
  if (u.includes('/feed') || u.includes('rss')) return { type: 'rss', adapter: 'rss', queryType: 'feed' };
  if (u.includes('api')) return { type: 'api', adapter: 'api_search', queryType: 'search_api' };
  return { type: 'html', adapter: 'html_list', queryType: 'list_page' };
}

const toAdd = [];
for (const src of missing) {
  if (existingIds.has(src.id)) continue;

  const m = inferMethod(src.url);
  toAdd.push({
    id: src.id,
    name: src.name,
    region: normalizeRegion(src.region),
    category: inferCategory(src.category),
    thesis_tags: ['supply-chain', 'manufacturing', 'agtech', 'industrial-ai'],
    stage_bias: ['stealth', 'pre-seed', 'seed', 'series_a', 'series_b'],
    method: {
      type: m.type,
      url: src.url,
      selectors: {
        item: 'article, .post, .card, li',
        title: 'h1, h2, h3, a',
        link: 'a'
      }
    },
    cadence: {
      tier: 'B',
      frequency: m.type === 'rss' ? 'daily' : 'weekly'
    },
    query_strategy: {
      type: m.queryType
    },
    requires_auth: src.url.includes('linkedin.com'),
    adapter: m.adapter,
    notes: `Added from thesis v2 reconciliation gap fill (${src.category}).`,
  });
}

if (toAdd.length) {
  registry.push(...toAdd);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

console.log({ missing: missing.length, added: toAdd.length, totalRegistry: registry.length });
