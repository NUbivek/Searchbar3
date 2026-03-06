export interface StartupSignal {
  id: string;
  company_name: string;
  company_domain?: string;
  stage_guess?: string;
  thesis_tags?: string[];
  source_key?: string;
  source_tier?: number;
  summary?: string;
  funding_total?: number;
  confidence?: number;
  detected_at?: string;
  status?: string;
  flagged?: boolean;
  notes?: string;
  owner?: string;
  [key: string]: any;
}

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

export interface SortState { col: string; dir: 'asc' | 'desc' }
export interface PaginationState { page: number; page_size: number; total: number }
export interface ExportJob { id: string; status: 'pending'|'running'|'done'|'error'; row_count?: number; download_url?: string }
export interface SavedView { id: string; name: string; filters: FilterState; sort: SortState; columns: string[] }
export interface SignalMeta { status: string; flagged: boolean; notes?: string; owner?: string }
