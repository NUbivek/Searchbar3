import { getRaiseCandidates, refreshLocalIngestion } from '../../../lib/raiseCandidatesStore';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const action = req.body?.action || 'refresh';
    if (action === 'refresh') {
      const out = await refreshLocalIngestion();
      return res.status(200).json({ status: 'ok', action, ...out });
    }
    return res.status(400).json({ error: 'Unknown action' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const q = req.query || {};
  const filters = {
    likelyOnly: q.likely_only !== 'false',
    minScore: q.min_score ? Number(q.min_score) : 60,
    stage: q.stage || undefined,
    country: q.country || undefined,
    region: q.region || undefined,
    sector: q.sector || undefined,
    thesisTag: q.thesis_tag || q.thesis_tags || undefined,
    sourceTier: q.source_tier || q.investor_tier || undefined,
    sourceId: q.source_id || undefined,
    sourceName: q.source_name || undefined,
    signalWeight: q.signal_weight || undefined,
    evidenceRole: q.evidence_role || undefined,
    minFunding: q.min_funding ? Number(q.min_funding) : undefined,
    maxFunding: q.max_funding ? Number(q.max_funding) : undefined,
    q: q.q || undefined,
    page: q.page ? Number(q.page) : 1,
    pageSize: q.page_size ? Math.min(Number(q.page_size), 200) : 50,
    maxPerSource: q.max_per_source ? Number(q.max_per_source) : 120,
    qualityScore: q.quality_score ? Number(q.quality_score) : 30,
  };

  try {
    const out = await getRaiseCandidates(filters);
    return res.status(200).json({
      ...out,
      meta: {
        default_preset: 'likely_raising_6m',
        sort: ['raise_likelihood_score desc', 'last_signal_at desc'],
        retention_target: '12 months',
        persistence: 'append-only local store (db-ready schema included)',
      },
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch raise candidates', details: String(e?.message || e) });
  }
}
