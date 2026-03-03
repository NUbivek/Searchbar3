function countBy(entries, selector) {
  return entries.reduce((accumulator, entry) => {
    const key = selector(entry);
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function computeCoverageStats(registry) {
  const tierCounts = countBy(registry, (entry) => entry.cadence?.tier || 'unknown');
  const methodCounts = countBy(registry, (entry) => entry.method?.type || 'unknown');
  const adapterCounts = countBy(registry, (entry) => entry.adapter || 'unknown');
  const regionCounts = countBy(registry, (entry) => entry.region || 'unknown');
  const htmlLikeCount = (methodCounts.rss || 0) + (methodCounts.html || 0);
  const htmlLikeRatio = registry.length === 0 ? 0 : htmlLikeCount / registry.length;

  return {
    totalSources: registry.length,
    tierCounts,
    methodCounts,
    adapterCounts,
    regionCounts,
    htmlLikeCount,
    htmlLikeRatio,
  };
}

function validateCoverageTargets(registry, options = {}) {
  const stats = computeCoverageStats(registry);
  const minimumHtmlLikeRatio = Number.isFinite(options.minimumHtmlLikeRatio)
    ? options.minimumHtmlLikeRatio
    : 0.7;
  const minimumSourceCount = Number.isFinite(options.minimumSourceCount)
    ? options.minimumSourceCount
    : 20;
  const errors = [];

  if (stats.totalSources < minimumSourceCount) {
    errors.push(`Registry has ${stats.totalSources} sources; expected at least ${minimumSourceCount}.`);
  }

  if (stats.htmlLikeRatio < minimumHtmlLikeRatio) {
    errors.push(
      `Registry RSS/HTML mix is ${(stats.htmlLikeRatio * 100).toFixed(1)}%; expected at least ${(minimumHtmlLikeRatio * 100).toFixed(1)}%.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    stats,
  };
}

module.exports = {
  countBy,
  computeCoverageStats,
  validateCoverageTargets,
};
