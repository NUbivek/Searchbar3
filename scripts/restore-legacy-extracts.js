const fs = require('fs');
const path = require('path');

const NEW_REGISTRY_PATH = path.join(process.cwd(), 'sources', 'registry.json');
const OLD_REGISTRY_PATH = path.join(process.cwd(), 'reports', 'registry_before_claude_reconcile_backup.json');
const REPORT_PATH = path.join(process.cwd(), 'reports', 'restored_legacy_extracts.json');

function normalizeUrl(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

function getHost(value = '') {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function samePathFamily(left = '', right = '') {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const pa = (a.pathname || '/').replace(/\/$/, '');
    const pb = (b.pathname || '/').replace(/\/$/, '');
    if (pa === pb) return true;
    const family = ['/portfolio', '/companies', '/programs', '/accelerators', '/exhibitors', '/speakers'];
    return family.some((prefix) => pa.startsWith(prefix) && pb.startsWith(prefix));
  } catch {
    return false;
  }
}

function legacyNote(source) {
  return `legacy_extract_restored_from: ${source.id} (${source.name})`;
}

function normalizeExtractLimit(entry, extract) {
  const pathValue = String(entry?.method?.url || '').toLowerCase();
  const currentLimit = Number(extract?.limit || 0);
  let desiredLimit = 120;

  if (
    /\/(portfolio|companies|startups|residents|alumni|ventures|exhibitors|speakers|programs)/.test(pathValue)
    || ['venture_portfolio', 'accelerator_portfolio', 'startup_database', 'university_accelerator', 'accelerator_directory'].includes(String(entry?.category || '').toLowerCase())
  ) {
    desiredLimit = 200;
  }

  if (!Number.isFinite(currentLimit) || currentLimit < desiredLimit) {
    extract.limit = desiredLimit;
  }

  return extract;
}

function main() {
  const current = JSON.parse(fs.readFileSync(NEW_REGISTRY_PATH, 'utf8'));
  const legacy = JSON.parse(fs.readFileSync(OLD_REGISTRY_PATH, 'utf8')).filter((entry) => entry.method?.extract);

  const byExactUrl = new Map();
  const byHost = new Map();
  for (const entry of legacy) {
    if (entry.method?.url) {
      byExactUrl.set(normalizeUrl(entry.method.url), entry);
      const host = getHost(entry.method.url);
      if (host) {
        if (!byHost.has(host)) byHost.set(host, []);
        byHost.get(host).push(entry);
      }
    }
  }

  const restored = [];
  const skipped = [];
  const normalized = [];

  for (const entry of current) {
    if (entry.disabled || entry.adapter !== 'html_list') {
      continue;
    }

    if (entry.method?.extract) {
      const before = Number(entry.method.extract.limit || 0);
      entry.method.extract = normalizeExtractLimit(entry, entry.method.extract);
      const after = Number(entry.method.extract.limit || 0);
      if (after !== before) {
        normalized.push({
          id: entry.id,
          name: entry.name,
          url: entry.method?.url || '',
          previousLimit: before || null,
          normalizedLimit: after,
        });
      }
      continue;
    }

    const currentUrl = entry.method?.url || '';
    const exact = byExactUrl.get(normalizeUrl(currentUrl));
    let match = exact || null;
    let strategy = exact ? 'exact_url' : '';

    if (!match) {
      const hostMatches = byHost.get(getHost(currentUrl)) || [];
      if (hostMatches.length === 1 && samePathFamily(hostMatches[0].method?.url || '', currentUrl)) {
        match = hostMatches[0];
        strategy = 'host_family_single';
      }
    }

    if (!match) {
      skipped.push({
        id: entry.id,
        name: entry.name,
        url: currentUrl,
        reason: 'no_safe_legacy_match',
      });
      continue;
    }

    entry.method.extract = normalizeExtractLimit(entry, JSON.parse(JSON.stringify(match.method.extract)));
    entry.fetch_notes = entry.fetch_notes
      ? `${entry.fetch_notes} | ${legacyNote(match)}`
      : legacyNote(match);

    restored.push({
      id: entry.id,
      name: entry.name,
      url: currentUrl,
      strategy,
      legacySourceId: match.id,
      legacySourceName: match.name,
      legacyUrl: match.method?.url || '',
    });
  }

  fs.writeFileSync(NEW_REGISTRY_PATH, JSON.stringify(current, null, 2));
  fs.writeFileSync(REPORT_PATH, JSON.stringify({
    restoredCount: restored.length,
    normalizedLimitCount: normalized.length,
    skippedCount: skipped.length,
    restored,
    normalized,
    skipped: skipped.slice(0, 200),
  }, null, 2));

  console.log(JSON.stringify({ restoredCount: restored.length, normalizedLimitCount: normalized.length, reportPath: REPORT_PATH }, null, 2));
}

main();
