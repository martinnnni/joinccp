CREATE TABLE mentor_question_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  intent TEXT NOT NULL CHECK(intent IN ('business','chitchat','out_of_scope','uncertain')),
  top_similarity REAL,
  outcome TEXT NOT NULL CHECK(outcome IN ('answered','kb_gap','refused','clarified'))
);
CREATE INDEX mentor_question_logs_created_at ON mentor_question_logs(created_at DESC);
CREATE INDEX mentor_question_logs_outcome ON mentor_question_logs(outcome, created_at DESC);
