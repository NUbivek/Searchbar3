const { buildPlan } = require('../src/sourcing/planner');

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--mode' && next) {
      options.executionMode = next;
      index += 1;
    } else if (arg === '--tier' && next) {
      options.tier = next;
      index += 1;
    } else if (arg === '--frequency' && next) {
      options.frequency = next;
      index += 1;
    } else if (arg === '--force') {
      options.force = true;
    }
  }

  return options;
}

try {
  const result = buildPlan(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
