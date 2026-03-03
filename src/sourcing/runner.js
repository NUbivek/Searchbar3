const { CategoryExportWriter } = require('./categoryExport');
const { CrmExportWriter } = require('./crmExport');
const { ensureDedupeState, shouldEmitSignal } = require('./dedupe');
const { normalizeSignal } = require('./normalizer');
const { loadRegistry } = require('./registry');
const { createAdapter } = require('./adapters');
const { RunReportWriter } = require('./runReport');
const { DailyRollupWriter } = require('./rollup');
const { SourceHealthExportWriter } = require('./sourceHealthExport');
const { loadState, saveState } = require('./state');
const { SignalWriter } = require('./writer');

const FREQUENCY_ORDER = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

const EXECUTION_MODES = {
  daily: {
    tiers: ['A'],
    frequencies: ['daily'],
  },
  weekly: {
    tiers: ['A', 'B'],
    frequencies: ['daily', 'weekly'],
  },
  monthly: {
    tiers: ['A', 'B', 'C'],
    frequencies: ['daily', 'weekly', 'monthly'],
  },
};

function matchesExecutionMode(source, executionMode) {
  if (!executionMode) {
    return true;
  }

  const config = EXECUTION_MODES[executionMode];
  if (!config) {
    return true;
  }

  return config.tiers.includes(source.cadence?.tier) && config.frequencies.includes(source.cadence?.frequency);
}

function getDegradedCooldownMs(source) {
  const hours = source.runtime?.cooldownHoursAfterDegraded;

  if (!Number.isFinite(hours) || hours <= 0) {
    return 0;
  }

  return hours * 60 * 60 * 1000;
}

function getEffectiveDegradedCooldownMs(source, sourceState) {
  const baseCooldownMs = getDegradedCooldownMs(source);

  if (baseCooldownMs <= 0) {
    return 0;
  }

  const degradedCount = Math.max(1, Number(sourceState?.consecutive_degraded_count) || 1);
  const multiplier = Number.isFinite(source.runtime?.cooldownBackoffMultiplier)
    ? source.runtime.cooldownBackoffMultiplier
    : 1;
  const maxCooldownHours = Number.isFinite(source.runtime?.maxCooldownHours)
    ? source.runtime.maxCooldownHours
    : null;
  const scaledCooldownMs = baseCooldownMs * Math.max(1, multiplier) * degradedCount;

  if (!Number.isFinite(maxCooldownHours) || maxCooldownHours <= 0) {
    return scaledCooldownMs;
  }

  return Math.min(scaledCooldownMs, maxCooldownHours * 60 * 60 * 1000);
}

function shouldRunSource(source, state, options = {}) {
  if (options.force) {
    return true;
  }

  if (!matchesExecutionMode(source, options.executionMode)) {
    return false;
  }

  if (options.frequency && source.cadence?.frequency !== options.frequency) {
    return false;
  }

  if (options.tier && source.cadence?.tier !== options.tier) {
    return false;
  }

  const sourceState = state.sources[source.id];
  if (!sourceState?.last_run_at) {
    return true;
  }

  const minAgeDays = FREQUENCY_ORDER[source.cadence?.frequency] || 1;
  const lastRunAt = new Date(sourceState.last_run_at).getTime();
  const now = Date.now();
  const ageMs = now - lastRunAt;
  const degradedCooldownMs = getEffectiveDegradedCooldownMs(source, sourceState);

  if (
    sourceState.last_status === 'degraded' &&
    degradedCooldownMs > 0 &&
    ageMs < degradedCooldownMs
  ) {
    return false;
  }

  return ageMs >= minAgeDays * 24 * 60 * 60 * 1000;
}

function buildSourceSummary(source, error, emittedCount) {
  return {
    sourceId: source.id,
    sourceName: source.name,
    status: error ? 'degraded' : 'ok',
    emittedCount,
    error: error ? error.message : null,
  };
}

function countBy(items, selector) {
  return items.reduce((accumulator, item) => {
    const key = selector(item);
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function rankCounts(counts, limit = 5) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function buildSignalBreakdowns(signals, registry) {
  const sourceById = registry.reduce((accumulator, source) => {
    accumulator[source.id] = source;
    return accumulator;
  }, {});

  const byStage = countBy(signals, (signal) => signal.stage_guess || 'unknown');
  const byCategory = countBy(signals, (signal) => sourceById[signal.source_id]?.category || 'unknown');
  const byRegion = countBy(signals, (signal) => signal.region_guess || 'unknown');
  const fundingSignals = countBy(signals, (signal) => signal.enrichment?.funding_signal || 'none');
  const hiringSignals = countBy(signals, (signal) => signal.enrichment?.hiring_signal || 'none');
  const investorSignals = countBy(signals, (signal) => signal.enrichment?.investor_signal || 'none');
  const thesisTagCounts = signals.reduce((accumulator, signal) => {
    for (const tag of signal.thesis_tags || []) {
      accumulator[tag] = (accumulator[tag] || 0) + 1;
    }
    return accumulator;
  }, {});
  const sourceCounts = countBy(signals, (signal) => signal.source_name || signal.source_id || 'unknown');

  return {
    byStage,
    byCategory,
    byRegion,
    fundingSignals,
    hiringSignals,
    investorSignals,
    topThesisTags: rankCounts(thesisTagCounts),
    topSources: rankCounts(sourceCounts),
  };
}

function buildTierHealth(summaries, registry) {
  const tierBySourceId = registry.reduce((accumulator, source) => {
    accumulator[source.id] = source.cadence?.tier || 'unknown';
    return accumulator;
  }, {});

  return summaries.reduce((accumulator, summary) => {
    const tier = tierBySourceId[summary.sourceId] || 'unknown';
    if (!accumulator[tier]) {
      accumulator[tier] = {
        ok: 0,
        degraded: 0,
        emittedCount: 0,
        dedupedCount: 0,
      };
    }

    accumulator[tier][summary.status] = (accumulator[tier][summary.status] || 0) + 1;
    accumulator[tier].emittedCount += summary.emittedCount || 0;
    accumulator[tier].dedupedCount += summary.dedupedCount || 0;
    return accumulator;
  }, {});
}

async function runSource(source, context) {
  const adapter = createAdapter(source, { timeoutMs: context.timeoutMs });
  const items = await adapter.run({ query: context.query || '' });
  const seenBySource = context.state.seen_signal_ids[source.id] || {};
  const newSignals = [];
  let dedupedCount = 0;

  for (const item of items) {
    const signal = normalizeSignal({
      source,
      item,
      query: context.query || '',
    });

    if (seenBySource[signal.signal_id]) {
      continue;
    }

    const dedupeDecision = shouldEmitSignal(signal, context.state);
    if (!dedupeDecision.shouldEmit) {
      dedupedCount += 1;
      continue;
    }

    seenBySource[signal.signal_id] = signal.discovered_at;
    newSignals.push(signal);
  }

  context.state.seen_signal_ids[source.id] = seenBySource;
  context.state.sources[source.id] = {
    last_run_at: new Date().toISOString(),
    last_status: 'ok',
    last_emitted_count: newSignals.length,
    last_deduped_count: dedupedCount,
    consecutive_degraded_count: 0,
  };

  return {
    source,
    signals: newSignals,
    summary: {
      ...buildSourceSummary(source, null, newSignals.length),
      dedupedCount,
    },
  };
}

async function runPipeline(options = {}) {
  const registry = loadRegistry(options.registryPath);
  const state = loadState(options.statePath);
  ensureDedupeState(state);
  const writer = new SignalWriter(options.outputPath);
  const rollupWriter = new DailyRollupWriter(options.rollupPath);
  const categoryExportWriter = new CategoryExportWriter(options.categoryExportPath);
  const crmExportWriter = new CrmExportWriter(options.crmExportPath);
  const runReportWriter = new RunReportWriter(options.runReportPath);
  const sourceHealthWriter = new SourceHealthExportWriter(options.sourceHealthPath);
  const runnableSources = registry.filter((source) => shouldRunSource(source, state, options));
  const summaries = [];
  const emittedSignals = [];
  let emittedCount = 0;

  for (const source of runnableSources) {
    try {
      const result = await runSource(source, {
        query: options.query,
        timeoutMs: options.timeoutMs || 10000,
        state,
      });

      emittedCount += writer.appendMany(result.signals);
      emittedSignals.push(...result.signals);
      summaries.push(result.summary);
    } catch (error) {
      const previousState = state.sources[source.id] || {};
      const nextDegradedCount = (previousState.consecutive_degraded_count || 0) + 1;
      state.sources[source.id] = {
        last_run_at: new Date().toISOString(),
        last_status: 'degraded',
        last_emitted_count: 0,
        last_deduped_count: 0,
        last_error: error.message,
        consecutive_degraded_count: nextDegradedCount,
      };
      summaries.push(buildSourceSummary(source, error, 0));
    }
  }

  const rollupCount = rollupWriter.write(emittedSignals);
  const categoryExportCount = categoryExportWriter.write(emittedSignals);
  const crmExportCount = crmExportWriter.write(emittedSignals);
  const sourceHealthCount = sourceHealthWriter.write({
    registry,
    summaries,
    state,
  });
  const runReport = runReportWriter.write({
    generatedAt: new Date().toISOString(),
    executionMode: options.executionMode || null,
    query: options.query || '',
    totalSources: registry.length,
    runCount: runnableSources.length,
    skippedCount: registry.length - runnableSources.length,
    emittedCount,
    rollupCount,
    categoryExportCount,
    crmExportCount,
    sourceHealthCount,
    degradedCount: summaries.filter((summary) => summary.status === 'degraded').length,
    dedupedCount: summaries.reduce((sum, summary) => sum + (summary.dedupedCount || 0), 0),
    tierHealth: buildTierHealth(summaries, registry),
    breakdowns: buildSignalBreakdowns(emittedSignals, registry),
    sourceSummaries: summaries,
  });
  saveState(state, options.statePath);

  return {
    emittedCount,
    rollupCount,
    categoryExportCount,
    crmExportCount,
    sourceHealthCount,
    runCount: runnableSources.length,
    skippedCount: registry.length - runnableSources.length,
    executionMode: options.executionMode || null,
    runReport,
    summaries,
  };
}

module.exports = {
  EXECUTION_MODES,
  getEffectiveDegradedCooldownMs,
  getDegradedCooldownMs,
  matchesExecutionMode,
  runPipeline,
  shouldRunSource,
};
