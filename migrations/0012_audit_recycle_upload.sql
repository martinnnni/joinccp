ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE checks ADD COLUMN upload_id TEXT;
CREATE UNIQUE INDEX checks_upload_request ON checks(student_id, upload_id) WHERE upload_id IS NOT NULL;
CREATE TABLE upload_receipts (
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL,
  check_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  PRIMARY KEY(student_id,upload_id)
);
CREATE TABLE operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_id INTEGER,
  actor_role TEXT,
  action TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  targets TEXT
);
CREATE INDEX operation_logs_actor ON operation_logs(actor_id,id);
CREATE INDEX users_recycle ON users(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX checks_student_material_history ON checks(student_id,material_id,id DESC);
ALTER TABLE form_templates ADD COLUMN upload_id TEXT;
CREATE UNIQUE INDEX forms_upload_request ON form_templates(uploaded_by,upload_id) WHERE upload_id IS NOT NULL;
