CREATE TABLE works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pixiv_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  page_count INTEGER NOT NULL DEFAULT 1,
  x_restrict INTEGER NOT NULL DEFAULT 0,
  sl INTEGER,
  restricted INTEGER NOT NULL DEFAULT 0,
  source_url TEXT NOT NULL DEFAULT '',
  thumb_url TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT,
  r2_prefix TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  UNIQUE (pixiv_id, kind)
);

CREATE INDEX idx_works_fetched ON works (fetched_at DESC);
CREATE INDEX idx_works_pixiv ON works (pixiv_id);

CREATE TABLE work_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  page_index INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  UNIQUE (work_id, page_index)
);

CREATE INDEX idx_work_files_work ON work_files (work_id);

CREATE TABLE crawl_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  work_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL
);
