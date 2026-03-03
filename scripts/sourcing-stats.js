const { loadRegistry } = require('../src/sourcing/registry');
const { computeCoverageStats } = require('../src/sourcing/coverage');

function main() {
  const registry = loadRegistry();
  console.log(JSON.stringify(computeCoverageStats(registry), null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
