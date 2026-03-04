const { loadRegistry } = require('../src/sourcing/registry');
const { validateCoverageTargets } = require('../src/sourcing/coverage');

function main() {
  const registry = loadRegistry();
  const coverageValidation = validateCoverageTargets(registry);

  if (!coverageValidation.valid) {
    throw new Error(`Coverage targets failed:\n${coverageValidation.errors.join('\n')}`);
  }

  console.log(
    `Validated ${registry.length} sources. RSS/HTML mix ${(coverageValidation.stats.htmlLikeRatio * 100).toFixed(1)}%.`
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
