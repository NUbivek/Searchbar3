const fs = require('fs');
const path = require('path');

function escapeCsv(value) {
  const normalized = String(value == null ? '' : value).replace(/"/g, '""');
  return `"${normalized}"`;
}

function buildStateMap(state) {
  return state?.sources && typeof state.sources === 'object' ? state.sources : {};
}

function buildRows(registry, summaries, state) {
  const stateBySourceId = buildStateMap(state);
  const summaryBySourceId = summaries.reduce((accumulator, summary) => {
    accumulator[summary.sourceId] = summary;
    return accumulator;
  }, {});

  return registry
    .map((source) => {
      const summary = summaryBySourceId[source.id] || {};
      const sourceState = stateBySourceId[source.id] || {};

      return [
        source.id,
        source.name,
        source.cadence?.tier || '',
        source.cadence?.frequency || '',
        source.adapter || '',
        source.method?.type || '',
        summary.status || sourceState.last_status || 'not_run',
        summary.emittedCount ?? sourceState.last_emitted_count ?? 0,
        summary.dedupedCount ?? sourceState.last_deduped_count ?? 0,
        sourceState.consecutive_degraded_count ?? 0,
        sourceState.last_run_at || '',
        sourceState.last_error || summary.error || '',
      ].map(escapeCsv).join(',');
    })
    .sort((left, right) => left.localeCompare(right));
}

class SourceHealthExportWriter {
  constructor(outputPath = path.join(process.cwd(), 'data', 'source_health.csv')) {
    this.outputPath = outputPath;
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
  }

  write({ registry, summaries, state }) {
    this.ensureDirectory();

    const header = [
      'source_id',
      'source_name',
      'tier',
      'frequency',
      'adapter',
      'method_type',
      'status',
      'emitted_count',
      'deduped_count',
      'consecutive_degraded_count',
      'last_run_at',
      'last_error',
    ].join(',');

    const rows = buildRows(
      Array.isArray(registry) ? registry : [],
      Array.isArray(summaries) ? summaries : [],
      state
    );
    const payload = [header, ...rows].join('\n') + '\n';
    fs.writeFileSync(this.outputPath, payload, 'utf-8');

    return rows.length;
  }
}

module.exports = {
  SourceHealthExportWriter,
};
