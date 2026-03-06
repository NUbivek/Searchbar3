CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TYPE stage_enum AS ENUM (
 'stealth', 'pre-seed', 'seed', 'series-a', 'series-b', 'series-c', 'unknown'
);

CREATE TABLE startup_signals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 hash_key TEXT UNIQUE NOT NULL,
 company_name TEXT NOT NULL,
 company_domain TEXT,
 linkedin_url TEXT,
 geography TEXT,
 hq_country TEXT,
 hq_region TEXT,
 hq_city TEXT,
 stage_guess stage_enum DEFAULT 'unknown',
 thesis_tags TEXT[] DEFAULT '{}',
 signal_type TEXT,
 source_key TEXT NOT NULL,
 source_tier SMALLINT,
 source_url TEXT,
 item_url TEXT,
 summary TEXT,
 founders TEXT[],
 investors TEXT[],
 investor_tier TEXT,
 headcount INT,
 headcount_range TEXT,
 funding_total NUMERIC(16,2),
 last_round TEXT,
 last_round_date DATE,
 confidence NUMERIC(4,3),
 detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 published_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ DEFAULT now(),
 raw JSONB,
 search_vector TSVECTOR
);

CREATE INDEX idx_signals_detected ON startup_signals (detected_at DESC);
CREATE INDEX idx_signals_stage ON startup_signals (stage_guess);
CREATE INDEX idx_signals_tier ON startup_signals (source_tier);
CREATE INDEX idx_signals_country ON startup_signals (hq_country);
CREATE INDEX idx_signals_funding ON startup_signals (funding_total DESC);
CREATE INDEX idx_signals_confidence ON startup_signals (confidence DESC);
CREATE INDEX idx_signals_tags ON startup_signals USING GIN (thesis_tags);
CREATE INDEX idx_signals_investors ON startup_signals USING GIN (investors);
CREATE INDEX idx_signals_search ON startup_signals USING GIN (search_vector);
CREATE INDEX idx_signals_trgm_name ON startup_signals USING GIN (company_name gin_trgm_ops);

CREATE OR REPLACE FUNCTION update_search_vector() RETURNS trigger AS $$
BEGIN
 NEW.search_vector :=
 setweight(to_tsvector('english', coalesce(NEW.company_name,'')), 'A') ||
 setweight(to_tsvector('english', coalesce(NEW.summary,'')), 'B') ||
 setweight(to_tsvector('english', coalesce(NEW.company_domain,'')), 'C') ||
 setweight(to_tsvector('english', coalesce(array_to_string(NEW.thesis_tags,' '),'')), 'B');
 NEW.updated_at := now();
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_vector BEFORE INSERT OR UPDATE ON startup_signals
 FOR EACH ROW EXECUTE FUNCTION update_search_vector();
