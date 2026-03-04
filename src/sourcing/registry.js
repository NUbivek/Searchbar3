const fs = require('fs');
const path = require('path');
const { validateRegistry } = require('./schema');

const DEFAULT_REGISTRY_PATH = path.join(process.cwd(), 'sources', 'registry.json');

const METHOD_RUNTIME_PRESETS = {
  rss: {
    maxRunsPerWindow: 4,
    rateLimitWindowHours: 6,
    cooldownHoursAfterDegraded: 12,
    cooldownBackoffMultiplier: 1.5,
    maxCooldownHours: 72,
  },
  html: {
    maxRunsPerWindow: 2,
    rateLimitWindowHours: 8,
    cooldownHoursAfterDegraded: 24,
    cooldownBackoffMultiplier: 2,
    maxCooldownHours: 120,
  },
  api: {
    maxRunsPerWindow: 6,
    rateLimitWindowHours: 4,
    cooldownHoursAfterDegraded: 8,
    cooldownBackoffMultiplier: 1.5,
    maxCooldownHours: 48,
  },
  js: {
    maxRunsPerWindow: 1,
    rateLimitWindowHours: 12,
    cooldownHoursAfterDegraded: 24,
    cooldownBackoffMultiplier: 2,
    maxCooldownHours: 120,
  },
  search: {
    maxRunsPerWindow: 3,
    rateLimitWindowHours: 6,
    cooldownHoursAfterDegraded: 12,
    cooldownBackoffMultiplier: 1.5,
    maxCooldownHours: 72,
  },
};

const TIER_RUNTIME_OVERRIDES = {
  A: {
    maxRunsPerWindow: 4,
    rateLimitWindowHours: 4,
  },
  B: {
    maxRunsPerWindow: 3,
    rateLimitWindowHours: 8,
  },
  C: {
    maxRunsPerWindow: 2,
    rateLimitWindowHours: 24,
  },
};

function applyRuntimePreset(entry) {
  const methodType = entry.method?.type || 'rss';
  const tier = entry.cadence?.tier || 'C';
  const methodPreset = METHOD_RUNTIME_PRESETS[methodType] || {};
  const tierOverride = TIER_RUNTIME_OVERRIDES[tier] || {};

  return {
    ...entry,
    runtime: {
      ...methodPreset,
      ...tierOverride,
      ...(entry.runtime || {}),
    },
  };
}

function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  const raw = fs.readFileSync(registryPath, 'utf-8');
  const entries = JSON.parse(raw);
  const validation = validateRegistry(entries);

  if (!validation.valid) {
    const error = new Error(`Invalid registry:\n${validation.errors.join('\n')}`);
    error.validation = validation;
    throw error;
  }

  return entries.map(applyRuntimePreset);
}

module.exports = {
  DEFAULT_REGISTRY_PATH,
  applyRuntimePreset,
  loadRegistry,
};
