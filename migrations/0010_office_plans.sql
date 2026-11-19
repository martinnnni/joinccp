CREATE TABLE office_plans (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done')),
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX office_plans_user_created ON office_plans(user_id,created_at);
ALTER TABLE users ADD COLUMN reset_password INTEGER NOT NULL DEFAULT 0 CHECK(reset_password IN (0,1));
