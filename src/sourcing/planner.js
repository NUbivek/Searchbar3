const { loadRegistry } = require('./registry');
const { loadState } = require('./state');
const {
  EXECUTION_MODES,
  getEffectiveDegradedCooldownMs,
  matchesExecutionMode,
  shouldRunSource,
} = require('./runner');

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

function isDueSoon(nextDueAt, withinHours) {
  if (!nextDueAt || !Number.isFinite(withinHours)) {
    return false;
  }

  const nextTime = new Date(nextDueAt).getTime();
  const now = Date.now();
  const windowMs = withinHours * 60 * 60 * 1000;
  return nextTime > now && nextTime <= now + windowMs;
}

function groupSources(items, keyName) {
  return items.reduce((accumulator, item) => {
    const key = item[keyName] || 'unknown';
    if (!accumulator[key]) {
      accumulator[key] = [];
    }
    accumulator[key].push(item);
    return accumulator;
  }, {});
}

function buildNextDueSummary(items, keyName) {
  return items.reduce((accumulator, item) => {
    if (!item.nextDueAt) {
      return accumulator;
    }

    const key = item[keyName] || 'unknown';
    const existingValue = accumulator[key];

    if (!existingValue || new Date(item.nextDueAt).getTime() < new Date(existingValue).getTime()) {
      accumulator[key] = item.nextDueAt;
    }

    return accumulator;
  }, {});
}

function getDeferredReason(source, state, options) {
  if (!matchesExecutionMode(source, options.executionMode)) {
    return 'excluded_by_mode';
  }

  if (options.frequency && source.cadence?.frequency !== options.frequency) {
    return 'excluded_by_frequency';
  }

  if (options.tier && source.cadence?.tier !== options.tier) {
    return 'excluded_by_tier';
  }

  const sourceState = state.sources?.[source.id];
  if (!sourceState?.last_run_at) {
    return 'not_due_yet';
  }

  const degradedCooldownMs = getEffectiveDegradedCooldownMs(source, sourceState);
  const ageMs = Date.now() - new Date(sourceState.last_run_at).getTime();

  if (
    sourceState.last_status === 'degraded' &&
    degradedCooldownMs > 0 &&
    ageMs < degradedCooldownMs
  ) {
    return 'cooldown_after_degraded';
  }

  return 'not_due_yet';
}

function buildPlan(options = {}) {
  const registry = loadRegistry(options.registryPath);
  const state = loadState(options.statePath);
  const withinHours = Number.isFinite(options.withinHours) ? options.withinHours : 24;

  const dueSources = [];
  const dueSoonSources = [];
  const deferredSources = [];

  for (const source of registry) {
    const due = shouldRunSource(source, state, options);
    const executionModeMatch = matchesExecutionMode(source, options.executionMode);
    const nextDueAt = computeNextDueAt(source, state);
    const deferredReason = getDeferredReason(source, state, options);
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

    if (
      executionModeMatch &&
      deferredReason !== 'cooldown_after_degraded' &&
      isDueSoon(nextDueAt, withinHours)
    ) {
      dueSoonSources.push(sourceEntry);
    }

    deferredSources.push({
      ...sourceEntry,
      reason: deferredReason,
    });
  }

  const groupedDue = groupSources(dueSources, 'tier');
  const groupedDueSoon = groupSources(dueSoonSources, 'tier');

  return {
    generatedAt: new Date().toISOString(),
    executionMode: options.executionMode || null,
    withinHours,
    supportedModes: Object.keys(EXECUTION_MODES),
    totalSources: registry.length,
    dueCount: dueSources.length,
    dueSoonCount: dueSoonSources.length,
    deferredCount: deferredSources.length,
    groupedDue,
    groupedDueSoon,
    nextDueByTier: buildNextDueSummary(deferredSources, 'tier'),
    nextDueByFrequency: buildNextDueSummary(deferredSources, 'frequency'),
    dueSoonSources,
    dueSources,
    deferredSources,
  };
}

module.exports = {
  buildPlan,
  computeNextDueAt,
  getDeferredReason,
  isDueSoon,
};
