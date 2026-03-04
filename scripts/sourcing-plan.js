const { buildPlan } = require('../src/sourcing/planner');

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--mode' && next) {
      options.executionMode = next;
      index += 1;
    } else if (arg === '--within-hours' && next) {
      options.withinHours = Number(next);
      index += 1;
    } else if (arg === '--tier' && next) {
      options.tier = next;
      index += 1;
    } else if (arg === '--frequency' && next) {
      options.frequency = next;
      index += 1;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--full') {
      options.full = true;
    } else if (arg === '--include-auth-sources') {
      options.includeAuthSources = true;
    }
  }

  return options;
}

function summarizeBy(items, key) {
  return items.reduce((accumulator, item) => {
    const value = item[key] || 'unknown';
    accumulator[value] = (accumulator[value] || 0) + 1;
    return accumulator;
  }, {});
}

function summarizePlan(plan) {
  return {
    generatedAt: plan.generatedAt,
    executionMode: plan.executionMode,
    withinHours: plan.withinHours,
    totalSources: plan.totalSources,
    counts: {
      due: plan.dueCount,
      dueSoon: plan.dueSoonCount,
      deferred: plan.deferredCount,
    },
    dueByTier: summarizeBy(plan.dueSources, 'tier'),
    dueSoonByTier: summarizeBy(plan.dueSoonSources, 'tier'),
    deferredByReason: summarizeBy(plan.deferredSources, 'reason'),
    nextDueByTier: plan.nextDueByTier,
    nextDueByFrequency: plan.nextDueByFrequency,
    sample: {
      dueSourceIds: plan.dueSources.slice(0, 20).map((source) => source.id),
      dueSoonSourceIds: plan.dueSoonSources.slice(0, 20).map((source) => source.id),
    },
    note: 'Use --full to print full due/deferred source lists.',
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = buildPlan(options);
  const output = options.full ? result : summarizePlan(result);
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
