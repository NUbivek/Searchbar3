const { canonicalizeUrl, normalizeCompanyName } = require('./normalizer');

function createCompanyKey(signal) {
  const website = canonicalizeUrl(signal.company_website || '');
  if (website) {
    return `website:${website}`;
  }

  const companyName = normalizeCompanyName(signal.company_name || '');
  if (companyName) {
    return `name:${companyName.toLowerCase()}`;
  }

  return `source:${signal.source_id}:${signal.signal_id}`;
}

function buildAliasCandidates(signal) {
  const aliases = new Set();
  const companyName = normalizeCompanyName(signal.company_name || '');
  const evidenceTitle = normalizeCompanyName(signal.evidence?.title || '');

  if (companyName) {
    aliases.add(companyName.toLowerCase());
  }

  if (evidenceTitle) {
    aliases.add(evidenceTitle.toLowerCase());
  }

  return Array.from(aliases);
}

function ensureDedupeState(state) {
  if (!state.seen_company_keys || typeof state.seen_company_keys !== 'object') {
    state.seen_company_keys = {};
  }

  if (!state.company_aliases || typeof state.company_aliases !== 'object') {
    state.company_aliases = {};
  }

  return state;
}

function shouldEmitSignal(signal, state) {
  ensureDedupeState(state);

  const companyKey = createCompanyKey(signal);
  const aliases = buildAliasCandidates(signal);
  const aliasMatch = aliases.find((alias) => state.company_aliases[alias]);
  const effectiveKey = aliasMatch ? state.company_aliases[aliasMatch] : companyKey;

  if (state.seen_company_keys[effectiveKey]) {
    return {
      shouldEmit: false,
      companyKey: effectiveKey,
      aliases,
    };
  }

  state.seen_company_keys[effectiveKey] = signal.discovered_at;
  for (const alias of aliases) {
    state.company_aliases[alias] = effectiveKey;
  }

  return {
    shouldEmit: true,
    companyKey: effectiveKey,
    aliases,
  };
}

module.exports = {
  buildAliasCandidates,
  createCompanyKey,
  ensureDedupeState,
  shouldEmitSignal,
};
