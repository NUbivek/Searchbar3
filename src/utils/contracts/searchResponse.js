const VALID_STATUSES = new Set(['ok', 'degraded', 'fail-soft']);

function normalizeSearchResponseV1(payload = {}) {
  const degradedSources = Array.isArray(payload.degradedSources)
    ? Array.from(new Set(payload.degradedSources.filter(Boolean)))
    : [];

  const synthesisInput = payload.synthesis && typeof payload.synthesis === 'object'
    ? payload.synthesis
    : {};

  return {
    ...payload,
    status: VALID_STATUSES.has(payload.status) ? payload.status : 'fail-soft',
    results: Array.isArray(payload.results) ? payload.results : [],
    degradedSources,
    synthesis: {
      enabled: Boolean(synthesisInput.enabled),
      provider: synthesisInput.provider ?? null,
      model: synthesisInput.model ?? null,
      content: synthesisInput.content ?? null,
    },
    llmProcessed: Boolean(payload.llmProcessed),
  };
}

function validateSearchResponseV1(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['payload must be an object'] };
  }

  if (!VALID_STATUSES.has(payload.status)) {
    errors.push('status must be one of: ok, degraded, fail-soft');
  }

  if (!Array.isArray(payload.results)) {
    errors.push('results must be an array');
  }

  if (!Array.isArray(payload.degradedSources)) {
    errors.push('degradedSources must be an array');
  }

  if (!payload.synthesis || typeof payload.synthesis !== 'object' || Array.isArray(payload.synthesis)) {
    errors.push('synthesis must be an object');
  } else if (typeof payload.synthesis.enabled !== 'boolean') {
    errors.push('synthesis.enabled must be a boolean');
  }

  if (typeof payload.llmProcessed !== 'boolean') {
    errors.push('llmProcessed must be a boolean');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  normalizeSearchResponseV1,
  validateSearchResponseV1,
};
