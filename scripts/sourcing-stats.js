const { loadRegistry } = require('../src/sourcing/registry');

function countBy(entries, selector) {
  return entries.reduce((accumulator, entry) => {
    const key = selector(entry);
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function main() {
  const registry = loadRegistry();
  const tierCounts = countBy(registry, (entry) => entry.cadence?.tier || 'unknown');
  const methodCounts = countBy(registry, (entry) => entry.method?.type || 'unknown');
  const adapterCounts = countBy(registry, (entry) => entry.adapter || 'unknown');
  const regionCounts = countBy(registry, (entry) => entry.region || 'unknown');

  console.log(JSON.stringify({
    totalSources: registry.length,
    tierCounts,
    methodCounts,
    adapterCounts,
    regionCounts,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
