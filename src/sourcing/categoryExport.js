const fs = require('fs');
const path = require('path');

function escapeCsv(value) {
  const normalized = String(value == null ? '' : value).replace(/"/g, '""');
  return `"${normalized}"`;
}

function rankCounts(counts) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function buildRows(signals) {
  const grouped = signals.reduce((accumulator, signal) => {
    const category = signal.category_guess || 'unknown';

    if (!accumulator[category]) {
      accumulator[category] = {
        signalCount: 0,
        companyNames: new Set(),
        stageCounts: {},
        thesisTagCounts: {},
        highConfidenceCount: 0,
      };
    }

    const bucket = accumulator[category];
    bucket.signalCount += 1;
    bucket.companyNames.add(signal.company_name);

    const stage = signal.stage_guess || 'unknown';
    bucket.stageCounts[stage] = (bucket.stageCounts[stage] || 0) + 1;

    for (const tag of signal.thesis_tags || []) {
      bucket.thesisTagCounts[tag] = (bucket.thesisTagCounts[tag] || 0) + 1;
    }

    if ((signal.confidence || 0) >= 0.75) {
      bucket.highConfidenceCount += 1;
    }

    return accumulator;
  }, {});

  return Object.entries(grouped)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([category, bucket]) => {
      const topStage = rankCounts(bucket.stageCounts)[0]?.[0] || 'unknown';
      const topThesisTag = rankCounts(bucket.thesisTagCounts)[0]?.[0] || 'unknown';

      return [
        category,
        bucket.signalCount,
        bucket.companyNames.size,
        topStage,
        topThesisTag,
        bucket.highConfidenceCount,
      ].map(escapeCsv).join(',');
    });
}

class CategoryExportWriter {
  constructor(outputPath = path.join(process.cwd(), 'data', 'category_rollup.csv')) {
    this.outputPath = outputPath;
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
  }

  write(signals) {
    this.ensureDirectory();

    const header = [
      'category',
      'signal_count',
      'unique_companies',
      'top_stage',
      'top_thesis_tag',
      'high_confidence_count',
    ].join(',');

    const rows = Array.isArray(signals) ? buildRows(signals) : [];
    const payload = [header, ...rows].join('\n') + '\n';
    fs.writeFileSync(this.outputPath, payload, 'utf-8');

    return rows.length;
  }
}

module.exports = {
  CategoryExportWriter,
};
