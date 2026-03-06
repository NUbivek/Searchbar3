CREATE TYPE review_status AS ENUM (
 'new', 'reviewed', 'shortlisted', 'rejected', 'contacted'
);

CREATE TABLE startup_signal_meta (
 signal_id UUID PRIMARY KEY REFERENCES startup_signals(id) ON DELETE CASCADE,
 status review_status DEFAULT 'new',
 owner TEXT,
 flagged BOOLEAN DEFAULT false,
 notes TEXT,
 last_touched TIMESTAMPTZ DEFAULT now(),
 updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_meta_status ON startup_signal_meta (status);
CREATE INDEX idx_meta_flagged ON startup_signal_meta (flagged) WHERE flagged = true;
