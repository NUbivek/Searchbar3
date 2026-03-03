const fs = require('fs');
const path = require('path');

function escapeCsv(value) {
  const normalized = String(value == null ? '' : value).replace(/"/g, '""');
  return `"${normalized}"`;
}

function buildRow(signal) {
  return [
    signal.company_name,
    signal.company_website,
    signal.enrichment?.company_root_domain || '',
    signal.enrichment?.hiring_signal || 'none',
    signal.enrichment?.open_roles_guess ?? '',
    signal.enrichment?.employee_count_guess ?? '',
    signal.stage_guess,
    (signal.thesis_tags || []).join('|'),
    signal.region_guess,
    signal.signal_type,
    signal.source_name,
    signal.source_id,
    signal.item_url,
    signal.published_at,
    signal.confidence,
    signal.evidence?.title || '',
    signal.evidence?.excerpt || '',
  ].map(escapeCsv).join(',');
}

class CrmExportWriter {
  constructor(outputPath = path.join(process.cwd(), 'data', 'crm_export.csv')) {
    this.outputPath = outputPath;
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
  }

  write(signals) {
    this.ensureDirectory();

    const header = [
      'company_name',
      'company_website',
      'company_root_domain',
      'hiring_signal',
      'open_roles_guess',
      'employee_count_guess',
      'stage_guess',
      'thesis_tags',
      'region_guess',
      'signal_type',
      'source_name',
      'source_id',
      'item_url',
      'published_at',
      'confidence',
      'evidence_title',
      'evidence_excerpt',
    ].join(',');

    const sortedSignals = Array.isArray(signals)
      ? [...signals].sort((left, right) => right.confidence - left.confidence)
      : [];
    const rows = sortedSignals.map(buildRow);
    const payload = [header, ...rows].join('\n') + '\n';
    fs.writeFileSync(this.outputPath, payload, 'utf-8');

    return rows.length;
  }
}

module.exports = {
  CrmExportWriter,
};
