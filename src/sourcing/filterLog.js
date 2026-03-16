class FilterLog {
  constructor() {
    this.stages = [];
  }

  stage(name, beforeCount, afterCount, sampleDropped = []) {
    const safeBefore = Number(beforeCount || 0);
    const safeAfter = Number(afterCount || 0);
    this.stages.push({
      name,
      before: safeBefore,
      after: safeAfter,
      dropped: safeBefore - safeAfter,
      dropPct: safeBefore > 0 ? (((safeBefore - safeAfter) / safeBefore) * 100).toFixed(1) : '0.0',
      sampleDropped: sampleDropped.slice(0, 5),
    });
  }

  report() {
    console.log('\n=== Filter Pipeline Report ===');
    this.stages.forEach((s) => {
      console.log(`  ${s.name}: ${s.before} → ${s.after} (dropped ${s.dropped}, ${s.dropPct}%)`);
      if (s.sampleDropped.length) {
        s.sampleDropped.forEach((d) => console.log(`    dropped: ${d}`));
      }
    });
    const total = this.stages[0]?.before || 0;
    const final = this.stages[this.stages.length - 1]?.after || 0;
    console.log(`  TOTAL: ${total} → ${final} (kept ${total > 0 ? ((final / total) * 100).toFixed(1) : '0.0'}%)\n`);
    return this.stages;
  }
}

module.exports = FilterLog;
