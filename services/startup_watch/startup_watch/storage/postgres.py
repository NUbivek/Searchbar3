"""PostgreSQL writer for StartupSignal objects.
Uses UPSERT on hash_key to ensure idempotency across pipeline runs.
CRITICAL: This module never touches startup_signal_meta table.
Human workflow data (status, notes, flags) is never overwritten by pipeline.
"""
import hashlib, json, os
from typing import List
import psycopg2
from psycopg2.extras import execute_values
from startup_watch.schema import StartupSignal


def _compute_hash_key(s: StartupSignal) -> str:
    domain = (getattr(s, 'website', '') or '').lower().strip()
    name = s.company_name.lower().strip()
    source = s.source_name.lower().strip()
    date_bucket = (s.scraped_at or '')[:10]
    raw = f'{domain}|{name}|{source}|{date_bucket}'
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def upsert_signals(signals: List[StartupSignal], conn_string: str = None) -> int:
    conn_str = conn_string or os.environ.get('DATABASE_URL')
    if not conn_str:
        raise ValueError('DATABASE_URL not set and conn_string not provided')

    rows = []
    for s in signals:
        categories = getattr(s, 'categories', []) or []
        if isinstance(categories, str):
            categories = [c.strip() for c in categories.split('|') if c.strip()]

        rows.append((
            _compute_hash_key(s),
            s.company_name,
            getattr(s, 'website', None),
            getattr(s, 'stage', 'unknown'),
            getattr(s, 'description', None),
            s.source_name,
            getattr(s, 'source_url', None),
            categories,
            getattr(s, 'scraped_at', None),
            getattr(s, 'founders', []) or [],
            getattr(s, 'linkedin_url', None),
            getattr(s, 'location', None),
            None,
            getattr(s, 'investor_names', []) or [],
            getattr(s, 'headcount_range', None),
            getattr(s, 'investor_tier', None),
            json.dumps(s.__dict__, default=str),
        ))

    with psycopg2.connect(conn_str) as conn:
        with conn.cursor() as cur:
            execute_values(cur, '''
                INSERT INTO startup_signals (
                hash_key, company_name, company_domain, stage_guess,
                summary, source_key, source_url, thesis_tags,
                detected_at, founders, linkedin_url, geography,
                funding_total, investors, headcount_range,
                investor_tier, raw
                ) VALUES %s
                ON CONFLICT (hash_key) DO UPDATE SET
                summary = EXCLUDED.summary,
                thesis_tags = EXCLUDED.thesis_tags,
                stage_guess = EXCLUDED.stage_guess,
                investors = EXCLUDED.investors,
                investor_tier = EXCLUDED.investor_tier,
                raw = EXCLUDED.raw,
                updated_at = now()
            ''', rows)
        conn.commit()
    return len(rows)
