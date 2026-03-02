const fs = require('fs');
const path = require('path');

function escapeCsv(value) {
  const normalized = String(value == null ? '' : value).replace(/"/g, '""');
  return `"${normalized}"`;
}

function buildRow(signal) {
  return [
    signal.discovered_at.slice(0, 10),
    signal.company_name,
    signal.stage_guess,
    (signal.thesis_tags || []).join('|'),
    signal.source_id,
    signal.source_name,
    signal.item_url,
    signal.company_website,
    signal.confidence,
  ].map(escapeCsv).join(',');
}

class DailyRollupWriter {
  constructor(outputPath = path.join(process.cwd(), 'data', 'daily_rollup.csv')) {
    this.outputPath = outputPath;
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
  }

  write(signals) {
    this.ensureDirectory();

    const header = [
      'run_date',
      'company_name',
      'stage_guess',
      'thesis_tags',
      'source_id',
      'source_name',
      'item_url',
      'company_website',
      'confidence',
    ].join(',');

    const rows = Array.isArray(signals) ? signals.map(buildRow) : [];
    const payload = [header, ...rows].join('\n') + '\n';
    fs.writeFileSync(this.outputPath, payload, 'utf-8');

    return rows.length;
  }
}

module.exports = {
  DailyRollupWriter,
};
