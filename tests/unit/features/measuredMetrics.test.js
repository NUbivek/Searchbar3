/**
 * Measured scoring (docs/METRICS_SYSTEM.md): every component comes from
 * evidence in the result; missing evidence is "not measured", never a default.
 */
import { measureResult, buildCorpus, contextWeights } from '../../../src/components/search/metrics/MeasuredMetrics';
import MetricsCalculator from '../../../src/components/search/metrics/MetricsCalculator';

const recent = new Date(Date.now() - 3 * 86400000).toISOString();
const reuters = { title: 'Mistral AI raises €3 billion Series D', url: 'https://www.reuters.com/tech/mistral', content: 'Mistral AI raised €3 billion in a Series D round, the company said in a statement on Tuesday, valuing it at €21 billion.', publishedAt: recent, source: 'web' };
const blog = { title: 'Mistral raises €3B', url: 'https://mistral.ai/news/x', content: 'Mistral today announced that it has raised €3 billion in a Series D funding round.', publishedAt: recent, source: 'curated', sourceCategory: 'ai_ecosystem', metadata: { tier: 'A', category: 'ai_ecosystem' } };
const forum = { title: 'Mistral raises 2B?', url: 'https://news.ycombinator.com/item?id=1', content: 'I heard Mistral raised €2 billion.', publishedAt: recent, source: 'hackernews' };
const unrelated = { title: 'How we ramp up new engineers', url: 'https://randomblog.example/post', content: 'Teams onboard faster with good docs.', publishedAt: '2019-01-01T00:00:00Z', source: 'web' };
const ctx = { isBusinessQuery: true };

describe('measured components', () => {
  test('missing evidence is not measured and gets no weight (no 0.5 defaults)', () => {
    const m = measureResult({ title: 'Mistral', url: 'https://unknown-site.example/a', content: '' }, 'Mistral', { context: {} });
    expect(m.components.relevance.recency.measured).toBe(false);
    expect(m.components.credibility.authorExpertise.measured).toBe(false);
    expect(m.components.credibility.sourceReputation.measured).toBe(false);
    expect(m.components.relevance.recency.value).toBeNull();
    // relevance is computed only from what was measured
    expect(m.relevance).toBeGreaterThan(0.5);
    expect(m.coverage.measuredComponents).toBeLessThan(m.coverage.totalComponents);
  });

  test('every measured component states its evidence', () => {
    const m = measureResult(reuters, 'Mistral AI funding', { context: ctx, corpus: buildCorpus([reuters, blog]) });
    for (const group of Object.values(m.components)) {
      for (const c of Object.values(group)) {
        expect(typeof c.evidence).toBe('string');
        expect(c.evidence.length).toBeGreaterThan(3);
        if (c.measured) expect(c.value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('scores discriminate: reputable, relevant, recent beats unrelated (no 95% saturation)', () => {
    const corpus = buildCorpus([reuters, blog, forum, unrelated]);
    const good = measureResult(reuters, 'Mistral AI funding', { context: ctx, corpus });
    const bad = measureResult(unrelated, 'Mistral AI funding', { context: ctx, corpus });
    expect(good.overall).toBeGreaterThan(bad.overall + 0.15);
    expect(good.relevance).toBeGreaterThan(bad.relevance);
    expect(good.overall).toBeLessThan(0.95);
  });

  test('reputation comes from the reputation database and source tier', () => {
    expect(measureResult(reuters, 'x', {}).components.credibility.sourceReputation.value).toBeCloseTo(0.92, 2);
    expect(measureResult(forum, 'x', {}).components.credibility.sourceReputation.value).toBeCloseTo(0.35, 2);
    expect(measureResult(blog, 'x', {}).components.credibility.sourceReputation.evidence).toMatch(/curated registry source, tier A/);
  });

  test('cross-source checks: agreement raises, disagreement lowers factual consistency', () => {
    const corpus = buildCorpus([reuters, blog, forum]);
    const agreeing = measureResult(reuters, 'Mistral funding', { corpus });
    const conflicting = measureResult(forum, 'Mistral funding', { corpus });
    expect(agreeing.components.accuracy.externalValidation.value).toBeGreaterThanOrEqual(0.7);
    expect(conflicting.components.accuracy.factualConsistency.measured).toBe(true);
    expect(conflicting.components.accuracy.factualConsistency.value).toBeLessThan(0.5);
  });

  test('regulatory filings are primary records', () => {
    const filing = { title: 'Apple Inc. - 10-K', url: 'https://www.sec.gov/Archives/edgar/data/320193/x.htm', content: 'Filing Date: 2026-11-03', source: 'sec', date: '2026-11-03' };
    const m = measureResult(filing, 'Apple', { corpus: buildCorpus([filing]) });
    expect(m.components.credibility.verificationFactors.value).toBe(1);
    expect(m.components.accuracy.externalValidation.evidence).toMatch(/primary record/);
  });

  test('overall uses the documented context weights', () => {
    expect(contextWeights({ isFinancialQuery: true })).toEqual({ RELEVANCE: 0.30, ACCURACY: 0.40, CREDIBILITY: 0.30 });
    expect(contextWeights({})).toEqual({ RELEVANCE: 0.33, ACCURACY: 0.33, CREDIBILITY: 0.34 });
  });

  test('MetricsCalculator returns the measured values with no flat business boost', () => {
    const viaCalculator = MetricsCalculator.calculateMetrics(unrelated, 'Mistral AI funding', { isBusinessQuery: true });
    const direct = measureResult(unrelated, 'Mistral AI funding', { context: { isBusinessQuery: true } });
    expect(viaCalculator.relevance).toBeCloseTo(direct.relevance, 6);
    expect(viaCalculator.components).toBeDefined();
    expect(viaCalculator.coverage.totalComponents).toBe(13);
  });
});
