const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_PATH = path.join(process.cwd(), 'data', 'source_state.json');

function loadState(statePath = DEFAULT_STATE_PATH) {
  if (!fs.existsSync(statePath)) {
    return {
      sources: {},
      seen_signal_ids: {},
    };
  }

  const raw = fs.readFileSync(statePath, 'utf-8');
  const parsed = JSON.parse(raw);

  return {
    sources: parsed.sources && typeof parsed.sources === 'object' ? parsed.sources : {},
    seen_signal_ids: parsed.seen_signal_ids && typeof parsed.seen_signal_ids === 'object'
      ? parsed.seen_signal_ids
      : {},
  };
}

function saveState(state, statePath = DEFAULT_STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

module.exports = {
  DEFAULT_STATE_PATH,
  loadState,
  saveState,
};
