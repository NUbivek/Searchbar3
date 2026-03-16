export function scoreRaiseLikelihood(signal) {
  let score = 0;
  const reasons = [];

  function fundingConfidenceBonus(row) {
    if (row.fundingConfidence === 'high') return 8;
    if (row.fundingConfidence === 'medium') return 4;
    if (row.fundingConfidence === 'low') return 1;
    return 0;
  }

  function roundStageBonus(row) {
    const stage = String(row.lastRoundType || row.stage || '').toLowerCase();
    if (stage.includes('pre-seed') || stage.includes('pre seed')) return 5;
    if (stage === 'seed') return 8;
    if (stage.includes('series a')) return 18;
    if (stage.includes('series b')) return 22;
    if (stage.includes('series c')) return 15;
    if (stage.includes('series d')) return 8;
    if (stage.includes('growth')) return 18;
    return 0;
  }

  function fundingRecencyBonus(monthsSinceLast) {
    if (!monthsSinceLast) return 0;
    if (monthsSinceLast > 36) return -8;
    if (monthsSinceLast > 30) return -3;
    return 0;
  }

  const monthsSinceRound = Number.isFinite(signal.monthsSinceLastRound)
    ? signal.monthsSinceLastRound
    : null;
  if (monthsSinceRound != null && monthsSinceRound >= 16 && monthsSinceRound <= 30) {
    score += 25;
    reasons.push('Time since last round is in an active re-raise window');
  }
  score += fundingRecencyBonus(monthsSinceRound);
  if (monthsSinceRound != null && monthsSinceRound > 36) reasons.push('Funding history is stale without a recent round update');
  else if (monthsSinceRound != null && monthsSinceRound > 30) reasons.push('Last funding event is getting stale');

  const momentum = signal.momentumScore ?? 0;
  score += Math.min(20, Math.max(0, momentum));
  if (momentum >= 12) reasons.push('High recent momentum (hiring/product/news activity)');

  if (signal.acceleratorRecent) {
    score += 18;
    reasons.push('Recent accelerator/cohort/demo-day signal');
  }

  const tier = String(signal.sourceTier || signal.investorTier || '').toUpperCase();
  if (tier === 'A') {
    score += 12;
    reasons.push('Tier A source signal');
  } else if (tier === 'B') {
    score += 6;
    reasons.push('Tier B source signal');
  }

  const confidence = Number(signal.confidence || 0);
  score += Math.round(confidence * 15);
  if (confidence >= 0.75) reasons.push('High confidence based on source quality + enrichment');

  const fundingConfidence = fundingConfidenceBonus(signal);
  score += fundingConfidence;
  if (fundingConfidence >= 8) reasons.push('Verified funding data available');
  else if (fundingConfidence >= 4) reasons.push('Funding data available with medium confidence');

  const roundBonus = roundStageBonus(signal);
  score += roundBonus;
  if (roundBonus >= 18) reasons.push('Series A/B funding stage strongly suggests an active follow-on fundraising window');
  else if (roundBonus >= 8) reasons.push('Funding stage supports a plausible near-term raise');
  else if (roundBonus >= 3) reasons.push('Stage signal contributes modestly to fundraising likelihood');

  if (signal.negativeSignal) {
    score -= 20;
    reasons.push('Negative dampener detected (e.g., layoffs/down-round risk)');
  }

  const bounded = Math.max(0, Math.min(100, score));
  return {
    raise_likelihood_score: bounded,
    // Calibrated for current signal density so likely filter returns actionable rows.
    likely_raising_6m: bounded >= 45,
    reasons: reasons.slice(0, 3),
  };
}
