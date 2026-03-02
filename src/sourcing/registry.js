const fs = require('fs');
const path = require('path');
const { validateRegistry } = require('./schema');

const DEFAULT_REGISTRY_PATH = path.join(process.cwd(), 'sources', 'registry.json');

function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  const raw = fs.readFileSync(registryPath, 'utf-8');
  const entries = JSON.parse(raw);
  const validation = validateRegistry(entries);

  if (!validation.valid) {
    const error = new Error(`Invalid registry:\n${validation.errors.join('\n')}`);
    error.validation = validation;
    throw error;
  }

  return entries;
}

module.exports = {
  DEFAULT_REGISTRY_PATH,
  loadRegistry,
};
