const { runPipeline } = require('../src/sourcing/runner');

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--query' && next) {
      options.query = next;
      index += 1;
    } else if (arg === '--mode' && next) {
      options.executionMode = next;
      index += 1;
    } else if (arg === '--tier' && next) {
      options.tier = next;
      index += 1;
    } else if (arg === '--frequency' && next) {
      options.frequency = next;
      index += 1;
    } else if (arg === '--timeout-ms' && next) {
      options.timeoutMs = Number(next);
      index += 1;
    } else if (arg === '--force') {
      options.force = true;
    }
  }

  return options;
}

async function main() {
  const result = await runPipeline(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
