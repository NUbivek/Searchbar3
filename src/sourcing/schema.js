const REQUIRED_FIELDS = [
  'id',
  'name',
  'region',
  'category',
  'thesis_tags',
  'stage_bias',
  'method',
  'cadence',
  'query_strategy',
  'requires_auth',
  'notes',
];

const VALID_METHOD_TYPES = ['rss', 'html', 'js', 'api', 'search'];
const VALID_TIERS = ['A', 'B', 'C'];

function validateRegistryEntry(entry) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in entry)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (!Array.isArray(entry.thesis_tags)) {
    errors.push('thesis_tags must be an array');
  }

  if (!Array.isArray(entry.stage_bias)) {
    errors.push('stage_bias must be an array');
  }

  if (!entry.method || typeof entry.method !== 'object') {
    errors.push('method must be an object');
  } else {
    if (!VALID_METHOD_TYPES.includes(entry.method.type)) {
      errors.push(`Unsupported method.type: ${entry.method.type}`);
    }

    if (!entry.method.url || typeof entry.method.url !== 'string') {
      errors.push('method.url must be a string');
    }
  }

  if (!entry.cadence || typeof entry.cadence !== 'object') {
    errors.push('cadence must be an object');
  } else if (!VALID_TIERS.includes(entry.cadence.tier)) {
    errors.push(`Unsupported cadence.tier: ${entry.cadence.tier}`);
  }

  if (!entry.query_strategy || typeof entry.query_strategy !== 'object') {
    errors.push('query_strategy must be an object');
  }

  if (typeof entry.requires_auth !== 'boolean') {
    errors.push('requires_auth must be a boolean');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateRegistry(entries) {
  if (!Array.isArray(entries)) {
    return {
      valid: false,
      errors: ['Registry must be an array'],
      results: [],
    };
  }

  const seenIds = new Set();
  const results = entries.map((entry) => {
    const validation = validateRegistryEntry(entry);

    if (seenIds.has(entry.id)) {
      validation.valid = false;
      validation.errors.push(`Duplicate id: ${entry.id}`);
    }

    seenIds.add(entry.id);

    return {
      id: entry.id,
      ...validation,
    };
  });

  return {
    valid: results.every((result) => result.valid),
    errors: results.flatMap((result) => result.errors.map((error) => `${result.id}: ${error}`)),
    results,
  };
}

module.exports = {
  VALID_METHOD_TYPES,
  VALID_TIERS,
  validateRegistry,
  validateRegistryEntry,
};
