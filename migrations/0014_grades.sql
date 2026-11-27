-- 在学院与专业之间插入「年级」层：学院 → 年级 → 专业 → 班级 → 学生
-- 超管管理整个学院；辅导员管理一个年级；为未来扩展多个学院预留空间。
CREATE TABLE grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(college_id, name)
);
ALTER TABLE users ADD COLUMN grade_id INTEGER REFERENCES grades(id);
ALTER TABLE invites ADD COLUMN grade_id INTEGER REFERENCES grades(id);

-- 重建 majors：唯一约束从 (college_id,name) 改为 (grade_id,name)，
-- 使不同年级可拥有同名专业（每个年级都包含相同的四个专业）。
-- 注意：不能先 RENAME 旧表（会把子表 FK 引用改指向旧名）；须建新表→复制→删旧→改名，
-- 让 classes/users/invites 的 major_id FK 继续指向 "majors"。applyMigrations 全程关闭 foreign_keys。
CREATE TABLE majors_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  grade_id INTEGER REFERENCES grades(id),
  name TEXT NOT NULL,
  UNIQUE(grade_id, name)
);
INSERT INTO majors_new(id, college_id, name) SELECT id, college_id, name FROM majors;
DROP TABLE majors;
ALTER TABLE majors_new RENAME TO majors;
