-- 操作记录精简：只记关键操作（登录/打开页面/提交材料），并记录客户端 IP
ALTER TABLE operation_logs ADD COLUMN ip TEXT;
