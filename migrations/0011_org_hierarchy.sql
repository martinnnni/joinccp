-- 组织架构：学院(旧 departments 表) -- 专业 -- 班级
CREATE TABLE majors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(college_id, name)
);
CREATE TABLE classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  major_id INTEGER NOT NULL REFERENCES majors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  monitor_user_id INTEGER,
  UNIQUE(major_id, name)
);
-- 用户归属：辅导员 -> 专业；学生 -> 班级
ALTER TABLE users ADD COLUMN major_id INTEGER REFERENCES majors(id);
ALTER TABLE users ADD COLUMN class_id INTEGER REFERENCES classes(id);
-- 邀请码挂到专业
ALTER TABLE invites ADD COLUMN major_id INTEGER REFERENCES majors(id);

-- 数据迁移：每个旧“院系”下建一个默认专业 + 默认班级，旧成员归入
INSERT INTO majors(college_id, name) SELECT id, '默认专业' FROM departments;
INSERT INTO classes(major_id, name) SELECT id, '默认班级' FROM majors;
UPDATE users SET major_id = (SELECT m.id FROM majors m WHERE m.college_id = users.department_id)
  WHERE role = 'counselor' AND department_id IS NOT NULL;
UPDATE users SET class_id = (SELECT c.id FROM classes c JOIN majors m ON m.id = c.major_id WHERE m.college_id = users.department_id)
  WHERE role = 'student' AND department_id IS NOT NULL;
UPDATE invites SET major_id = (SELECT m.id FROM majors m WHERE m.college_id = invites.department_id)
  WHERE role = 'counselor' AND department_id IS NOT NULL;

-- 材料提交增加“班长审核”环节
ALTER TABLE checks ADD COLUMN monitor_approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checks ADD COLUMN monitor_approved_at TEXT;
