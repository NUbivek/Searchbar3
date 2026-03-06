const VALID_SORT_COLS = [
  'detected_at', 'funding_total', 'confidence', 'company_name',
  'stage_guess', 'source_tier', 'headcount', 'last_round_date', 'published_at'
] as const;
type SortCol = typeof VALID_SORT_COLS[number];

export interface FilterState {
  q?: string;
  stage?: string[];
  tags?: string[];
  tags_all?: boolean;
  tier?: number[];
  source_key?: string[];
  signal_type?: string[];
  date_from?: string;
  date_to?: string;
  min_funding?: number;
  max_funding?: number;
  min_headcount?: number;
  max_headcount?: number;
  hq_country?: string[];
  investor_tier?: string[];
  min_confidence?: number;
  status?: string[];
  flagged?: boolean;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}

export interface QueryResult {
  sql: string;
  params: any[];
  countSql: string;
  countParams: any[];
}

export function buildQuery(filters: FilterState): QueryResult {
  const params: any[] = [];
  const conditions: string[] = [];

  const p = (val: any): string => {
    params.push(val);
    return `$${params.length}`;
  };

  if (filters.q) conditions.push(`search_vector @@ plainto_tsquery('english', ${p(filters.q)})`);
  if (filters.stage?.length) conditions.push(`stage_guess = ANY(${p(filters.stage)}::stage_enum[])`);
  if (filters.tags?.length) {
    const op = filters.tags_all ? '@>' : '&&';
    conditions.push(`thesis_tags ${op} ${p(filters.tags)}::text[]`);
  }
  if (filters.tier?.length) conditions.push(`source_tier = ANY(${p(filters.tier)}::int[])`);
  if (filters.source_key?.length) conditions.push(`source_key = ANY(${p(filters.source_key)})`);
  if (filters.signal_type?.length) conditions.push(`signal_type = ANY(${p(filters.signal_type)})`);
  if (filters.date_from) conditions.push(`detected_at >= ${p(filters.date_from)}`);
  if (filters.date_to) conditions.push(`detected_at <= ${p(filters.date_to)}`);
  if (filters.min_funding != null) conditions.push(`funding_total >= ${p(filters.min_funding)}`);
  if (filters.max_funding != null) conditions.push(`funding_total <= ${p(filters.max_funding)}`);
  if (filters.min_headcount != null) conditions.push(`headcount >= ${p(filters.min_headcount)}`);
  if (filters.max_headcount != null) conditions.push(`headcount <= ${p(filters.max_headcount)}`);
  if (filters.hq_country?.length) conditions.push(`hq_country = ANY(${p(filters.hq_country)})`);
  if (filters.investor_tier?.length) conditions.push(`investor_tier = ANY(${p(filters.investor_tier)})`);
  if (filters.min_confidence != null) conditions.push(`confidence >= ${p(filters.min_confidence)}`);
  if (filters.status?.length) conditions.push(`meta.status = ANY(${p(filters.status)}::review_status[])`);
  if (filters.flagged != null) conditions.push(`meta.flagged = ${p(filters.flagged)}`);

  const sortCol: SortCol = VALID_SORT_COLS.includes(filters.sort as SortCol)
    ? (filters.sort as SortCol)
    : 'detected_at';
  const sortDir = filters.dir === 'asc' ? 'ASC' : 'DESC';

  const pageSize = Math.min(filters.page_size ?? 50, 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const SELECT_COLS = `
 s.id, s.company_name, s.company_domain, s.linkedin_url, s.geography,
 s.hq_country, s.hq_region, s.hq_city, s.stage_guess, s.thesis_tags,
 s.signal_type, s.source_key, s.source_tier, s.source_url, s.item_url,
 s.summary, s.founders, s.investors, s.investor_tier, s.headcount,
 s.headcount_range, s.funding_total, s.last_round, s.last_round_date,
 s.confidence, s.detected_at, s.published_at,
 meta.status, meta.flagged, meta.notes, meta.owner, meta.last_touched
 `;

  const sql = `
 SELECT ${SELECT_COLS}
 FROM startup_signals s
 LEFT JOIN startup_signal_meta meta ON meta.signal_id = s.id
 ${whereClause}
 ORDER BY s.${sortCol} ${sortDir}
 LIMIT ${p(pageSize)} OFFSET ${p(offset)}
 `;

  const countSql = `
 SELECT COUNT(*) as total
 FROM startup_signals s
 LEFT JOIN startup_signal_meta meta ON meta.signal_id = s.id
 ${whereClause}
 `;

  return { sql, params, countSql, countParams: [...params].slice(0, params.length - 2) };
}
