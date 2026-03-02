const fs = require('fs');
const path = require('path');

class SignalWriter {
  constructor(outputPath = path.join(process.cwd(), 'data', 'signals.jsonl')) {
    this.outputPath = outputPath;
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
  }

  appendMany(signals) {
    if (!Array.isArray(signals) || signals.length === 0) {
      return 0;
    }

    this.ensureDirectory();
    const payload = signals.map((signal) => JSON.stringify(signal)).join('\n') + '\n';
    fs.appendFileSync(this.outputPath, payload, 'utf-8');
    return signals.length;
  }
}

module.exports = {
  SignalWriter,
};
