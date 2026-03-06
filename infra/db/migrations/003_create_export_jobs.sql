CREATE TYPE export_status AS ENUM ('pending', 'running', 'done', 'error');

CREATE TABLE export_jobs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 status export_status DEFAULT 'pending',
 filter_params JSONB,
 row_count INT,
 file_path TEXT,
 format TEXT DEFAULT 'csv',
 created_at TIMESTAMPTZ DEFAULT now(),
 completed_at TIMESTAMPTZ
);
