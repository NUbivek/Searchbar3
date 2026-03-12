const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DEFAULT_WORKBOOK_PATH = '/Users/bivekadhikari/Downloads/final_sourcing_registry_reconciled.xlsx';
const DEFAULT_OUTPUT_PATH = path.join(process.cwd(), 'sources', 'registry.json');

const HTML_LIKE_ADAPTERS = new Set(['html_list', 'exhibitor_list', 'speaker_list', 'attendee_search']);
const API_LIKE_ADAPTERS = new Set([
  'linkedin_company_page',
  'linkedin_hashtag',
  'reddit_subreddit',
  'social_org_posts',
  'x_account_timeline',
  'x_hashtag_stream',
]);
const SEARCH_LIKE_ADAPTERS = new Set(['search_query', 'social_query']);
const SUPPORTED_RUNTIME_ADAPTERS = new Set(['html_list', 'js_rendered', 'rss']);

const DEFAULT_STAGE_BIAS_BY_CATEGORY = {
  accelerator_directory: ['pre-seed', 'seed'],
  accelerator_portfolio: ['pre-seed', 'seed'],
  conference: ['pre-seed', 'seed', 'series_a'],
  energy_climate: ['seed', 'series_a', 'series_b'],
  food_agtech: ['pre-seed', 'seed', 'series_a'],
  funding_news: ['seed', 'series_a', 'series_b'],
  innovation_hub: ['pre-seed', 'seed'],
  manufacturing: ['seed', 'series_a', 'series_b'],
  market_analysis: ['seed', 'series_a', 'series_b'],
  retail_commerce: ['seed', 'series_a', 'series_b'],
  social_org_posts: ['pre-seed', 'seed', 'series_a'],
  social_query: ['pre-seed', 'seed', 'series_a'],
  social_signal: ['pre-seed', 'seed', 'series_a'],
  startup_database: ['pre-seed', 'seed', 'series_a', 'series_b'],
  startup_innovation: ['pre-seed', 'seed'],
  supply_chain_logistics: ['pre-seed', 'seed', 'series_a', 'series_b'],
  trade_finance_payments: ['seed', 'series_a', 'series_b'],
  transportation: ['seed', 'series_a', 'series_b'],
  university_accelerator: ['pre-seed', 'seed'],
  venture_portfolio: ['seed', 'series_a', 'series_b'],
  warehouse_fulfillment: ['seed', 'series_a', 'series_b'],
};

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
}

function splitTags(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function inferMethodType(adapter, method) {
  if (adapter === 'rss' || method === 'rss') {
    return 'rss';
  }

  if (adapter === 'js_rendered') {
    return 'js';
  }

  if (HTML_LIKE_ADAPTERS.has(adapter) || method === 'html') {
    return 'html';
  }

  if (API_LIKE_ADAPTERS.has(adapter) || ['linkedin', 'social', 'x'].includes(method)) {
    return 'api';
  }

  if (SEARCH_LIKE_ADAPTERS.has(adapter) || method === 'web') {
    return 'search';
  }

  return 'html';
}

function inferRuntimeAdapter(adapter, methodType) {
  if (adapter === 'rss' || methodType === 'rss') {
    return 'rss';
  }

  if (adapter === 'js_rendered') {
    return 'js_rendered';
  }

  return 'html_list';
}

function inferQueryStrategy(methodType) {
  if (methodType === 'rss') {
    return { type: 'feed' };
  }

  if (methodType === 'search') {
    return { type: 'search_api' };
  }

  if (methodType === 'api') {
    return { type: 'api' };
  }

  return { type: 'list_page' };
}

function inferUrl(row) {
  if (row['Primary URL']) {
    return row['Primary URL'];
  }

  if (row['LinkedIn Page URL']) {
    return row['LinkedIn Page URL'];
  }

  if (row['Twitter / X Handle']) {
    return `https://x.com/${slugify(row['Twitter / X Handle'])}`;
  }

  const sourceId = slugify(row['Source ID']);
  const adapter = row.Adapter || 'source';

  if (adapter === 'linkedin_hashtag') {
    return `linkedin://hashtag/${sourceId}`;
  }

  if (adapter === 'x_hashtag_stream') {
    return `x://hashtag/${sourceId}`;
  }

  if (adapter === 'reddit_subreddit') {
    return `reddit://subreddit/${sourceId}`;
  }

  if (SEARCH_LIKE_ADAPTERS.has(adapter)) {
    return `search://${sourceId}`;
  }

  if (API_LIKE_ADAPTERS.has(adapter)) {
    return `api://${sourceId}`;
  }

  return `source://${sourceId}`;
}

function inferStageBias(category, tier, evidenceRole) {
  if (DEFAULT_STAGE_BIAS_BY_CATEGORY[category]) {
    return DEFAULT_STAGE_BIAS_BY_CATEGORY[category];
  }

  if (evidenceRole === 'primary') {
    return tier === 'A' ? ['pre-seed', 'seed', 'series_a'] : ['seed', 'series_a', 'series_b'];
  }

  return ['pre-seed', 'seed', 'series_a'];
}

function loadSheetRows(workbookPath, sheetName, headerRowIndex, dataStartIndex) {
  const wb = XLSX.readFile(workbookPath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  const header = rows[headerRowIndex];

  return rows
    .slice(dataStartIndex)
    .filter((row) => row[0])
    .map((row) => Object.fromEntries(header.map((column, index) => [column, row[index]])));
}

function normalizeMasterRows(rows) {
  return rows.filter((row) => row.Name);
}

function buildDisableMap(rows) {
  return rows.reduce((accumulator, row) => {
    accumulator[row['Source ID']] = row.Reason || 'Workbook disable candidate';
    return accumulator;
  }, {});
}

function convertRow(row, disableMap) {
  const workbookAdapter = row.Adapter || '';
  const methodType = inferMethodType(workbookAdapter, row.Method || '');
  const runtimeAdapter = inferRuntimeAdapter(workbookAdapter, methodType);
  const workbookDisabled = parseBoolean(row.Disabled);
  const disableReason = disableMap[row['Source ID']] || null;
  const unsupportedAdapter = !SUPPORTED_RUNTIME_ADAPTERS.has(runtimeAdapter) || API_LIKE_ADAPTERS.has(workbookAdapter) || SEARCH_LIKE_ADAPTERS.has(workbookAdapter);
  const disabled = workbookDisabled || Boolean(disableReason) || unsupportedAdapter;
  const notes = row.Notes || row['Fetch Notes'] || `${row['Evidence Role'] || 'source'} source`;
  const category = row.Category || 'startup_ecosystem';

  const entry = {
    id: row['Source ID'],
    name: row.Name,
    region: row.Region || 'Global',
    category,
    thesis_tags: splitTags(row['Thesis Tags']),
    stage_bias: inferStageBias(category, row.Tier || 'C', row['Evidence Role'] || ''),
    method: {
      type: methodType,
      url: inferUrl(row),
    },
    cadence: {
      tier: row.Tier || 'C',
      frequency: row['Update Cadence'] === 'event_anchor' ? 'weekly' : (row['Update Cadence'] || 'weekly'),
    },
    query_strategy: inferQueryStrategy(methodType),
    requires_auth: parseBoolean(row['Requires Auth']),
    adapter: runtimeAdapter,
    notes,
    disabled,
    disabled_reason: disableReason || (unsupportedAdapter ? `Pending adapter implementation for workbook adapter '${workbookAdapter || 'unknown'}'.` : undefined),
    update_cadence: row['Update Cadence'] || '',
    cron_expression: row.Cron || '',
    schedule_type: row['Schedule Type'] || '',
    incremental_strategy: row['Incremental Strategy'] || '',
    dedup_key: row['Dedup Key'] || '',
    signal_type: row['Signal Type'] || '',
    staleness_threshold_days: Number(row['Staleness (days)']) || 0,
    url: row['Primary URL'] || '',
    linkedin_page_url: row['LinkedIn Page URL'] || '',
    twitter_handle: row['Twitter / X Handle'] || '',
    evidence_role: row['Evidence Role'] || '',
    signal_weight: row['Signal Weight'] || '',
    review_rule: row['Review Rule'] || '',
    fetch_notes: row['Fetch Notes'] || '',
    source_file: row['Source File'] || '',
    workbook_adapter: workbookAdapter,
    workbook_method: row.Method || '',
  };

  if (entry.thesis_tags.length === 0) {
    entry.thesis_tags = splitTags(category.replace(/_/g, ','));
  }

  if (entry.disabled_reason == null) {
    delete entry.disabled_reason;
  }

  return entry;
}

function countBy(entries, selector) {
  return Object.entries(entries.reduce((accumulator, entry) => {
    const key = selector(entry);
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {})).sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])));
}

function main() {
  const workbookPath = process.argv[2] || DEFAULT_WORKBOOK_PATH;
  const outputPath = process.argv[3] || DEFAULT_OUTPUT_PATH;
  const masterRows = normalizeMasterRows(loadSheetRows(workbookPath, '01_Master_Registry', 2, 4));
  const disableRows = loadSheetRows(workbookPath, '05_Disable_Candidates', 2, 3);
  const disableMap = buildDisableMap(disableRows);
  const registry = masterRows.map((row) => convertRow(row, disableMap));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify({
    workbookPath,
    outputPath,
    importedRows: masterRows.length,
    disabledCount: registry.filter((entry) => entry.disabled).length,
    requiresAuthCount: registry.filter((entry) => entry.requires_auth).length,
    byAdapter: countBy(registry, (entry) => entry.adapter),
    byMethodType: countBy(registry, (entry) => entry.method.type),
    disabledReasons: countBy(registry.filter((entry) => entry.disabled), (entry) => entry.disabled_reason || 'disabled'),
  }, null, 2));
}

main();
