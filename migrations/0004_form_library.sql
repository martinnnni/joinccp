CREATE TABLE form_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_slug TEXT NOT NULL REFERENCES stages(slug),
  department_id INTEGER REFERENCES departments(id),
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX form_templates_stage_department ON form_templates(stage_slug, department_id);
