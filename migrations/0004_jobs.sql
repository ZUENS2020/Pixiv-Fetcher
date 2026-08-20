CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  work_id INTEGER,
  source_hash TEXT,
  target_lang TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_jobs_work_status ON jobs (work_id, status);
CREATE INDEX idx_jobs_updated ON jobs (updated_at);
