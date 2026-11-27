-- 材料撤销重发：记录老师/学生管理员首次查看（打开或下载）时间，之后学生不可撤销
ALTER TABLE checks ADD COLUMN viewed_at TEXT;
ALTER TABLE checks ADD COLUMN viewed_by INTEGER REFERENCES users(id);
