const { normalizeSignal } = require('./normalizer');
const { loadRegistry } = require('./registry');
const { createAdapter } = require('./adapters');
const { DailyRollupWriter } = require('./rollup');
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

async function runSource(source, context) {
  const adapter = createAdapter(source, { timeoutMs: context.timeoutMs });
  const items = await adapter.run({ query: context.query || '' });
  const seenBySource = context.state.seen_signal_ids[source.id] || {};
  const newSignals = [];

  for (const item of items) {
    const signal = normalizeSignal({
      source,
      item,
      query: context.query || '',
    });

    if (seenBySource[signal.signal_id]) {
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
  };

  return {
    source,
    signals: newSignals,
    summary: buildSourceSummary(source, null, newSignals.length),
  };
}

async function runPipeline(options = {}) {
  const registry = loadRegistry(options.registryPath);
  const state = loadState(options.statePath);
  const writer = new SignalWriter(options.outputPath);
  const rollupWriter = new DailyRollupWriter(options.rollupPath);
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
      state.sources[source.id] = {
        last_run_at: new Date().toISOString(),
        last_status: 'degraded',
        last_emitted_count: 0,
        last_error: error.message,
      };
      summaries.push(buildSourceSummary(source, error, 0));
    }
  }

  const rollupCount = rollupWriter.write(emittedSignals);
  saveState(state, options.statePath);

  return {
    emittedCount,
    rollupCount,
    runCount: runnableSources.length,
    skippedCount: registry.length - runnableSources.length,
    executionMode: options.executionMode || null,
    summaries,
  };
}

module.exports = {
  EXECUTION_MODES,
  matchesExecutionMode,
  runPipeline,
  shouldRunSource,
};
