const { loadRegistry } = require('./registry');
const { loadState } = require('./state');
const { EXECUTION_MODES, matchesExecutionMode, shouldRunSource } = require('./runner');

const FREQUENCY_TO_DAYS = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

function computeNextDueAt(source, state) {
  const sourceState = state.sources?.[source.id];
  if (!sourceState?.last_run_at) {
    return null;
  }

  const days = FREQUENCY_TO_DAYS[source.cadence?.frequency] || 1;
  const nextDueAt = new Date(sourceState.last_run_at);
  nextDueAt.setUTCDate(nextDueAt.getUTCDate() + days);
  return nextDueAt.toISOString();
}

function buildPlan(options = {}) {
  const registry = loadRegistry(options.registryPath);
  const state = loadState(options.statePath);

  const dueSources = [];
  const deferredSources = [];

  for (const source of registry) {
    const due = shouldRunSource(source, state, options);
    const executionModeMatch = matchesExecutionMode(source, options.executionMode);
    const nextDueAt = computeNextDueAt(source, state);
    const sourceEntry = {
      id: source.id,
      name: source.name,
      tier: source.cadence?.tier || 'unknown',
      frequency: source.cadence?.frequency || 'unknown',
      methodType: source.method?.type || 'unknown',
      adapter: source.adapter,
      nextDueAt,
    };

    if (due) {
      dueSources.push(sourceEntry);
      continue;
    }

    deferredSources.push({
      ...sourceEntry,
      reason: executionModeMatch ? 'not_due_yet' : 'excluded_by_mode',
    });
  }

  const groupedDue = dueSources.reduce((accumulator, source) => {
    const key = source.tier;
    if (!accumulator[key]) {
      accumulator[key] = [];
    }
    accumulator[key].push(source);
    return accumulator;
  }, {});

  return {
    generatedAt: new Date().toISOString(),
    executionMode: options.executionMode || null,
    supportedModes: Object.keys(EXECUTION_MODES),
    totalSources: registry.length,
    dueCount: dueSources.length,
    deferredCount: deferredSources.length,
    groupedDue,
    dueSources,
    deferredSources,
  };
}

module.exports = {
  buildPlan,
  computeNextDueAt,
};
