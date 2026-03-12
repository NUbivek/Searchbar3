const REQUIRED_SIGNAL_FIELDS = [
  'signal_id',
  'company_name',
  'company_website',
  'company_domain',
  'description',
  'stage',
  'thesis_tags',
  'region',
  'source_id',
  'source_name',
  'evidence_role',
  'signal_weight',
  'item_url',
  'published_at',
  'discovered_at',
  'confidence',
  'evidence',
];

const INVALID_COMPANY_NAME_PATTERN = /read story|learn more|login|portal|membership|annual report|media kit|twitter|linkedin|instagram|youtube|about us|contact us|careers|privacy|terms|newsletter|subscribe|apply now|register|follow us|watch now|view all/i;

function isValidCompanyName(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const name = value.trim();
  if (name.length < 2 || name.length > 80) {
    return false;
  }

  if (INVALID_COMPANY_NAME_PATTERN.test(name)) {
    return false;
  }

  if (/^[A-Z\s&.-]+$/.test(name) && name.split(/\s+/).filter(Boolean).length <= 4) {
    return false;
  }

  if (!/^[-A-Za-z0-9&+.'’\s]+$/.test(name)) {
    return false;
  }

  return true;
}

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

  if (!isValidCompanyName(signal.company_name)) {
    errors.push('company_name must be a valid company label');
  }

  if (!(typeof signal.company_website === 'string' || signal.company_website === null)) {
    errors.push('company_website must be a string or null');
  }

  if (typeof signal.company_domain !== 'string') {
    errors.push('company_domain must be a string');
  }

  if (typeof signal.description !== 'string') {
    errors.push('description must be a string');
  }

  if (!Array.isArray(signal.thesis_tags) || signal.thesis_tags.length === 0) {
    errors.push('thesis_tags must be a non-empty array');
  }

  if (typeof signal.stage !== 'string' || signal.stage.trim().length === 0) {
    errors.push('stage must be a non-empty string');
  }

  if (typeof signal.region !== 'string' || signal.region.trim().length === 0) {
    errors.push('region must be a non-empty string');
  }

  if (typeof signal.source_id !== 'string' || signal.source_id.trim().length === 0) {
    errors.push('source_id must be a non-empty string');
  }

  if (typeof signal.source_name !== 'string' || signal.source_name.trim().length === 0) {
    errors.push('source_name must be a non-empty string');
  }

  if (typeof signal.evidence_role !== 'string') {
    errors.push('evidence_role must be a string');
  }

  if (!['high', 'medium', 'low'].includes(signal.signal_weight)) {
    errors.push('signal_weight must be one of: high, medium, low');
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
  INVALID_COMPANY_NAME_PATTERN,
  REQUIRED_SIGNAL_FIELDS,
  isValidCompanyName,
  validateStartupSignal,
  validateStartupSignals,
};
