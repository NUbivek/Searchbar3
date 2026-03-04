const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_PATH = path.join(process.cwd(), 'data', 'source_state.json');

function loadState(statePath = DEFAULT_STATE_PATH) {
  if (!fs.existsSync(statePath)) {
    return {
      sources: {},
      seen_signal_ids: {},
      seen_company_keys: {},
      company_aliases: {},
    };
  }

  const raw = fs.readFileSync(statePath, 'utf-8');
  const parsed = JSON.parse(raw);

  return {
    sources: parsed.sources && typeof parsed.sources === 'object' ? parsed.sources : {},
    seen_signal_ids: parsed.seen_signal_ids && typeof parsed.seen_signal_ids === 'object'
      ? parsed.seen_signal_ids
      : {},
    seen_company_keys: parsed.seen_company_keys && typeof parsed.seen_company_keys === 'object'
      ? parsed.seen_company_keys
      : {},
    company_aliases: parsed.company_aliases && typeof parsed.company_aliases === 'object'
      ? parsed.company_aliases
      : {},
  };
}

function normalizeSourceState(sourceState) {
  if (!sourceState || typeof sourceState !== 'object') {
    return {};
  }

  const recentRunTimestamps = Array.isArray(sourceState.recent_run_timestamps)
    ? sourceState.recent_run_timestamps.filter((value) => typeof value === 'string')
    : [];

  return {
    ...sourceState,
    recent_run_timestamps: recentRunTimestamps,
  };
}

function saveState(state, statePath = DEFAULT_STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

module.exports = {
  DEFAULT_STATE_PATH,
  loadState,
  normalizeSourceState,
  saveState,
};
