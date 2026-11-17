ALTER TABLE checks ADD COLUMN review_status TEXT NOT NULL DEFAULT '待审阅' CHECK(review_status IN ('待审阅','已通过','退回修改'));
ALTER TABLE checks ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
ALTER TABLE checks ADD COLUMN reviewed_by INTEGER REFERENCES users(id);
ALTER TABLE checks ADD COLUMN reviewed_at TEXT;
CREATE INDEX checks_student_material_latest ON checks(student_id, material_id, id DESC);
