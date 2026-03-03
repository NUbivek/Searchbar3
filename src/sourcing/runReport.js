const fs = require('fs');
const path = require('path');

class RunReportWriter {
  constructor(outputPath = path.join(process.cwd(), 'data', 'latest_run_summary.json')) {
    this.outputPath = outputPath;
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
  }

  write(report) {
    this.ensureDirectory();
    fs.writeFileSync(this.outputPath, JSON.stringify(report, null, 2), 'utf-8');
    return report;
  }
}

module.exports = {
  RunReportWriter,
};
