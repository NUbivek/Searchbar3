const { loadRegistry } = require('../src/sourcing/registry');

function main() {
  const registry = loadRegistry();
  console.log(`Validated ${registry.length} sources.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
