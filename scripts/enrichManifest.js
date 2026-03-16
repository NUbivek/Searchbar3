const fs = require('fs');
const path = require('path');
const { ApiSearchAdapter } = require('../src/sourcing/adapters/apiSearchAdapter');

const SIGNALS_PATH = path.join(__dirname, '..', 'data', 'signals.jsonl');
const FUNDING_CACHE_PATH = path.join(__dirname, '..', 'data', 'funding_cache.json');
const DESC_CACHE_PATH = path.join(__dirname, '..', 'data', 'description_cache.json');

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function evidenceText(row) {
  return typeof row.evidence === 'string' ? row.evidence : JSON.stringify(row.evidence || '');
}

async function enrichFromWeb(companyName) {
  const adapterHint = ApiSearchAdapter ? 'ApiSearchAdapter is available' : 'No search adapter export found';
  console.log(`[todo] Web enrichment for "${companyName}" is not implemented yet. ${adapterHint}.`);
  return null;
}

async function main() {
  const lines = fs.readFileSync(SIGNALS_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const rows = lines.map((line) => JSON.parse(line));

  const fundingCache = JSON.parse(fs.readFileSync(FUNDING_CACHE_PATH, 'utf8'));
  const descCache = fs.existsSync(DESC_CACHE_PATH)
    ? JSON.parse(fs.readFileSync(DESC_CACHE_PATH, 'utf8'))
    : {};

  const unenriched = rows.filter((row) => {
    if (!evidenceText(row).includes('Manifest2026')) return false;
    return !row.description && !row.company_website && !(row.enrichment && row.enrichment.funding_total_m);
  });

  console.log('Unenriched Manifest2026 rows:', unenriched.length);
  console.log('Web enrichment requires search API setup using the existing adapter pattern.');
  console.log('Next step: wire enrichFromWeb() to the same configured search backend used by the sourcing adapters.');

  let enriched = 0;
  for (let i = 0; i < unenriched.length; i++) {
    const row = unenriched[i];
    if (i > 0 && i % 100 === 0) {
      console.log(`  Progress: ${i}/${unenriched.length} (${enriched} enriched)`);
    }

    const result = await enrichFromWeb(row.company_name);
    if (!result) continue;

    if (result.description) {
      row.description = result.description;
      descCache[row.company_name] = { description: result.description, website: result.website || row.company_website || null };
    }
    if (result.website) {
      row.company_website = result.website;
      row.company_domain = result.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '');
    }
    if (result.funding_total_m) {
      if (!row.enrichment) row.enrichment = {};
      row.enrichment.funding_total_m = result.funding_total_m;
      fundingCache[row.company_name] = result;
    }
    if (result.stage) {
      row.stage = result.stage;
      row.stage_guess = result.stage;
    }

    enriched++;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  fs.writeFileSync(SIGNALS_PATH, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(FUNDING_CACHE_PATH, JSON.stringify(fundingCache, null, 2));
  fs.writeFileSync(DESC_CACHE_PATH, JSON.stringify(descCache, null, 2));

  console.log(`\nEnriched ${enriched} of ${unenriched.length} Manifest rows from web`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { enrichFromWeb, normalizeName };
