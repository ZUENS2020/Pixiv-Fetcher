CREATE TABLE llm_settings (
  id INTEGER PRIMARY KEY,
  base_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  api_key_enc TEXT,
  target_lang TEXT NOT NULL DEFAULT 'zh-CN',
  extra_prompt TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  para_index INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  translated TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (work_id, para_index, source_hash, target_lang)
);

CREATE INDEX idx_translations_work ON translations (work_id);
