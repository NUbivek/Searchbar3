const fs = require('fs');
const path = require('path');
const { ingestFilteredPitchbook, normalizeKey } = require('../src/sourcing/adapters/filteredPitchbookAdapter');

const SIGNALS_PATH = path.join(__dirname, '..', 'data', 'signals.jsonl');
const UPLOAD_PATH = path.join(__dirname, '..', 'data', 'uploads', 'Startups_to_upload.xlsx');
const REPORT_PATH = path.join(__dirname, '..', 'reports', 'upload_merge_report.json');

async function main() {
  console.log('Loading existing signals...');
  const existingLines = fs.readFileSync(SIGNALS_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const existingSignals = existingLines.map((l) => JSON.parse(l));
  console.log(`  Existing: ${existingSignals.length} signals`);

  const existingByKey = {};
  const existingByDomain = {};
  existingSignals.forEach((s, i) => {
    const key = normalizeKey(s.company_name);
    if (key) existingByKey[key] = i;
    if (s.company_domain) existingByDomain[String(s.company_domain).toLowerCase()] = i;
  });

  console.log('\nIngesting Filtered Pitchbook upload...');
  const uploadSignals = await ingestFilteredPitchbook(UPLOAD_PATH);
  console.log(`  Upload: ${uploadSignals.length} unique companies`);

  let dupByName = 0;
  let dupByDomain = 0;
  let enriched = 0;
  let netNew = 0;
  const newSignals = [];
  const queuedKeys = new Set();
  const queuedDomains = new Set();

  for (const us of uploadSignals) {
    const key = normalizeKey(us.company_name);
    const domain = String(us.company_domain || '').toLowerCase();
    let existingIdx = null;
    if (key && existingByKey[key] !== undefined) {
      existingIdx = existingByKey[key];
      dupByName++;
    } else if (domain && domain.length > 3 && existingByDomain[domain] !== undefined) {
      existingIdx = existingByDomain[domain];
      dupByDomain++;
    }

    if (existingIdx !== null) {
      const existing = existingSignals[existingIdx];
      let didEnrich = false;
      for (const field of ['description', 'stage', 'region', 'company_website']) {
        if (!existing[field] && us[field]) {
          existing[field] = us[field];
          didEnrich = true;
        }
      }
      if (us.enrichment) {
        if (!existing.enrichment) existing.enrichment = {};
        for (const [k, v] of Object.entries(us.enrichment)) {
          if (v && !existing.enrichment[k]) {
            existing.enrichment[k] = v;
            didEnrich = true;
          }
        }
      }
      if (!existing.evidence) existing.evidence = '';
      const evidenceText = typeof existing.evidence === 'string' ? existing.evidence : JSON.stringify(existing.evidence);
      if (!evidenceText.includes('Filtered Pitchbook')) {
        existing.evidence = `${evidenceText}; also in Filtered Pitchbook`;
      }
      if (didEnrich) enriched++;
    } else {
      if ((key && queuedKeys.has(key)) || (domain && queuedDomains.has(domain))) {
        continue;
      }
      newSignals.push(us);
      netNew++;
      if (key) queuedKeys.add(key);
      if (domain) queuedDomains.add(domain);
    }
  }

  console.log('\n=== Merge Report ===');
  console.log(`  Upload unique companies: ${uploadSignals.length}`);
  console.log(`  Duplicates by name:     ${dupByName}`);
  console.log(`  Duplicates by domain:   ${dupByDomain}`);
  console.log(`  Existing enriched:      ${enriched}`);
  console.log(`  Net new added:          ${netNew}`);
  console.log(`  Final total:            ${existingSignals.length + newSignals.length}`);

  const allSignals = [...existingSignals, ...newSignals];
  fs.writeFileSync(SIGNALS_PATH, allSignals.map((s) => JSON.stringify(s)).join('\n') + '\n');
  console.log(`\nWrote ${allSignals.length} signals to ${SIGNALS_PATH}`);

  const report = {
    timestamp: new Date().toISOString(),
    upload_file: 'Startups_to_upload.xlsx',
    source_name: 'Filtered Pitchbook',
    upload_unique: uploadSignals.length,
    dup_by_name: dupByName,
    dup_by_domain: dupByDomain,
    existing_enriched: enriched,
    net_new: netNew,
    total_before: existingSignals.length,
    total_after: allSignals.length,
    confidence_distribution: {
      high: allSignals.filter((s) => s.source_name === 'Filtered Pitchbook' && s.confidence >= 0.7).length,
      medium: allSignals.filter((s) => s.source_name === 'Filtered Pitchbook' && s.confidence >= 0.4 && s.confidence < 0.7).length,
      low: allSignals.filter((s) => s.source_name === 'Filtered Pitchbook' && s.confidence < 0.4).length,
    },
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Wrote merge report to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
