-- 材料截止时间：辅导员/办公助理为材料设置截止时间，学生端显示倒计时
ALTER TABLE materials ADD COLUMN deadline TEXT;
