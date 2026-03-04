const REQUIRED_SIGNAL_FIELDS = [
  'signal_id',
  'company_name',
  'stage_guess',
  'thesis_tags',
  'source_id',
  'source_name',
  'item_url',
  'published_at',
  'discovered_at',
  'confidence',
  'evidence',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateStartupSignal(signal) {
  const errors = [];

  if (!isPlainObject(signal)) {
    return {
      valid: false,
      errors: ['Signal must be an object'],
    };
  }

  for (const field of REQUIRED_SIGNAL_FIELDS) {
    if (!(field in signal)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (typeof signal.signal_id !== 'string' || signal.signal_id.length < 8) {
    errors.push('signal_id must be a non-empty string');
  }

  if (typeof signal.company_name !== 'string' || signal.company_name.trim().length === 0) {
    errors.push('company_name must be a non-empty string');
  }

  if (!Array.isArray(signal.thesis_tags) || signal.thesis_tags.length === 0) {
    errors.push('thesis_tags must be a non-empty array');
  }

  if (typeof signal.source_id !== 'string' || signal.source_id.trim().length === 0) {
    errors.push('source_id must be a non-empty string');
  }

  if (typeof signal.source_name !== 'string' || signal.source_name.trim().length === 0) {
    errors.push('source_name must be a non-empty string');
  }

  if (typeof signal.item_url !== 'string' || signal.item_url.trim().length === 0) {
    errors.push('item_url must be a non-empty string');
  }

  if (Number.isNaN(Date.parse(signal.published_at))) {
    errors.push('published_at must be a valid ISO date string');
  }

  if (Number.isNaN(Date.parse(signal.discovered_at))) {
    errors.push('discovered_at must be a valid ISO date string');
  }

  if (typeof signal.confidence !== 'number' || signal.confidence < 0 || signal.confidence > 1) {
    errors.push('confidence must be a number between 0 and 1');
  }

  if (!isPlainObject(signal.evidence)) {
    errors.push('evidence must be an object');
  } else {
    if (typeof signal.evidence.title !== 'string') {
      errors.push('evidence.title must be a string');
    }
    if (typeof signal.evidence.excerpt !== 'string') {
      errors.push('evidence.excerpt must be a string');
    }
    if (typeof signal.evidence.raw_query !== 'string') {
      errors.push('evidence.raw_query must be a string');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateStartupSignals(signals) {
  if (!Array.isArray(signals)) {
    return {
      valid: false,
      errors: ['Signals payload must be an array'],
      results: [],
    };
  }

  const results = signals.map((signal, index) => {
    const validation = validateStartupSignal(signal);
    return {
      index,
      valid: validation.valid,
      errors: validation.errors,
    };
  });

  return {
    valid: results.every((entry) => entry.valid),
    errors: results.flatMap((entry) => entry.errors.map((error) => `[${entry.index}] ${error}`)),
    results,
  };
}

module.exports = {
  REQUIRED_SIGNAL_FIELDS,
  validateStartupSignal,
  validateStartupSignals,
};
