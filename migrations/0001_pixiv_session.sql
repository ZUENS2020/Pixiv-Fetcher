CREATE TABLE pixiv_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);
