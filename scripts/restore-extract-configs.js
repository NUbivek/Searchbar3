const fs = require('fs');
const path = require('path');

const OLD_REGISTRY_PATH = path.join(process.cwd(), 'reports', 'registry_before_claude_reconcile_backup.json');
const CURRENT_REGISTRY_PATH = path.join(process.cwd(), 'sources', 'registry.json');
const REPORT_PATH = path.join(process.cwd(), 'reports', 'extract-restore-report.json');

const MEANINGFUL_EXTRACT_KEYS = [
  'itemSelector',
  'titleSelector',
  'linkSelector',
  'companyNameSelector',
  'companyWebsiteSelector',
];

function hasMeaningfulExtract(extract) {
  if (!extract || typeof extract !== 'object') {
    return false;
  }

  return MEANINGFUL_EXTRACT_KEYS.some((key) => {
    const value = extract[key];
    if (Array.isArray(value)) {
      return value.some(Boolean);
    }
    return Boolean(value);
  });
}

function normalizedLimit(entry, extract) {
  const category = String(entry?.category || '').toLowerCase();
  const workbookAdapter = String(entry?.workbook_adapter || '').toLowerCase();
  const currentLimit = Number(extract?.limit || 0);

  let target = 150;
  if (
    category.includes('conference')
    || category.includes('exhibitor')
    || workbookAdapter.includes('exhibitor_list')
  ) {
    target = 400;
  } else if (
    category.includes('venture_portfolio')
    || category.includes('accelerator')
  ) {
    target = 200;
  }

  if (!Number.isFinite(currentLimit) || currentLimit <= 20) {
    return target;
  }

  return currentLimit;
}

function main() {
  const oldRegistry = JSON.parse(fs.readFileSync(OLD_REGISTRY_PATH, 'utf8'));
  const currentRegistry = JSON.parse(fs.readFileSync(CURRENT_REGISTRY_PATH, 'utf8'));
  const currentById = new Map(currentRegistry.map((entry) => [entry.id, entry]));

  let totalRestored = 0;
  let totalLimitFixed = 0;
  const restoredEntries = [];

  for (const oldEntry of oldRegistry) {
    if (oldEntry?.adapter !== 'html_list') {
      continue;
    }

    if (!hasMeaningfulExtract(oldEntry?.method?.extract)) {
      continue;
    }

    const currentEntry = currentById.get(oldEntry.id);
    if (!currentEntry) {
      continue;
    }

    const currentExtract = currentEntry?.method?.extract;
    const shouldRestore =
      !currentExtract
      || Number(currentExtract.limit || 0) <= 20;

    if (!shouldRestore) {
      continue;
    }

    const transplanted = JSON.parse(JSON.stringify(oldEntry.method.extract));
    const previousLimit = Number(transplanted.limit || 0);
    transplanted.limit = normalizedLimit(currentEntry, transplanted);

    if (!currentEntry.method) {
      currentEntry.method = {};
    }
    currentEntry.method.extract = transplanted;

    totalRestored += 1;
    if (!Number.isFinite(previousLimit) || previousLimit <= 20) {
      totalLimitFixed += 1;
    }

    restoredEntries.push({
      id: currentEntry.id,
      name: currentEntry.name,
      extract_keys: Object.keys(transplanted),
      new_limit: transplanted.limit,
    });
  }

  fs.writeFileSync(CURRENT_REGISTRY_PATH, JSON.stringify(currentRegistry, null, 2));
  fs.writeFileSync(REPORT_PATH, JSON.stringify({
    total_restored: totalRestored,
    total_limit_fixed: totalLimitFixed,
    sample_restored: restoredEntries.slice(0, 20),
  }, null, 2));

  console.log(JSON.stringify({
    total_restored: totalRestored,
    total_limit_fixed: totalLimitFixed,
    sample_restored: restoredEntries.slice(0, 20),
  }, null, 2));
}

main();
