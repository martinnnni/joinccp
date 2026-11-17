# 党员发展计划辅助系统

面向高校学生党员发展与辅导员管理的工具网站。后端 Django + MySQL + Neo4j + Celery/Redis，AI 能力接 DeepSeek（OpenAI SDK 兼容）。

## 功能模块
- **材料与节点管家**：发展党员五阶段流程，学生注册自动建档，档案页展示当前阶段、材料清单（已有/缺失）与截止节点，定时提醒生成站内通知。
- **智能材料质检员**：上传 .docx，规则引擎查格式（字体/字号/标题居中/落款），AI 辅助提示易错点（只列问题、不改原文，结果标注"仅供参考"）。
- **个性化成长导师**：聊天式问答，注入学生阶段与专业上下文，历史存 `ChatMessage` 表。
- **辅导员工作台**：复用 Django Admin，辅导员组仅看本院系学生，提供材料完成率等只读统计。

## 技术栈
Django 5 · MySQL 8 · Neo4j 5（流程图结构）· Redis 7 · Celery 5 · DeepSeek（`openai` SDK）· python-docx · 手写 CSS

## 快速开始（本地 Docker 试跑）
```bash
cp .env.example .env        # 填写 DEEPSEEK_API_KEY、SECRET_KEY 等
docker compose up --build
```
首次启动会自动执行迁移、初始化流程图数据（`seed_flow`）。访问 http://127.0.0.1:8000 。

## Windows 本地快速运行（已配好便携服务）
本机已装好 MySQL/Redis 便携版与 `.venv`，可一键启动：
```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1
```
停止：`powershell -ExecutionPolicy Bypass -File scripts\stop-local.ps1`。
详细说明（服务目录、账号、常见问题）见 [docs/本地开发.md](docs/本地开发.md)。

## 本地开发（非 Docker）
1. 建虚拟环境并安装依赖：`python -m venv .venv && .venv/bin/pip install -r requirements.txt`（Windows 用 `.venv\Scripts\pip`）。
2. 准备 MySQL、Redis、Neo4j（可用 Docker 单起：`docker compose up mysql redis neo4j`）。
3. `cp .env.example .env` 并填写。
4. 初始化：
```bash
python manage.py migrate
python manage.py seed_flow            # 写入五阶段/节点/材料 + 同步 Neo4j
python manage.py collectstatic --noinput
python manage.py createsuperuser      # 管理员
python manage.py runserver
```

## 数据库迁移步骤
- 首次：`python manage.py makemigrations` 生成迁移 → `python manage.py migrate` 建表 → `python manage.py seed_flow` 灌流程图数据。
- 改模型后：`python manage.py makemigrations` → `python manage.py migrate`。

## 目录结构
```
config/            Django 配置（settings/urls/wsgi/celery）
apps/accounts/     账号、院系、学生档案、辅导员
apps/flow/         阶段、节点、材料模板、材料记录、通知、定时任务、种子数据
apps/quality/      材料质检（规则 + AI）
apps/mentor/       成长导师（会话、消息）
services/          ai_client / rules_engine / quality_check / graph(Neo4j)
templates/ static/  前端页面与样式
deploy/            生产部署脚本与配置
skill/             党员发展计划知识库 + frontend-design 技能
docs/              项目计划
```

## 面向维护者的三件事
### 1. 如何重启服务（生产）
```bash
sudo systemctl restart gunicorn celery celery-beat
# 或分别重启
sudo systemctl restart gunicorn
sudo systemctl restart celery
```
改代码后先 `sudo systemctl restart gunicorn`；改了定时任务再重启 `celery`/`celery-beat`。

### 2. 如何备份
```bash
sudo /srv/party/deploy/backup.sh
```
备份脚本导出 MySQL 全库 + 打包 `media/` 上传文件，输出到 `/srv/backups/`。建议配合 cron 每日执行：
`0 3 * * * sudo /srv/party/deploy/backup.sh`

### 3. 如何看日志
```bash
# 网站日志（gunicorn 标准输出）
sudo journalctl -u gunicorn -f
# 后台任务日志
sudo journalctl -u celery -f
sudo journalctl -u celery-beat -f
# Nginx 访问/错误日志
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

## 生产部署
完整步骤（服务器初始化、systemd、Nginx、Neo4j、备份）见 [deploy/README.md](deploy/README.md)。

## 脱敏约定
知识库 / 示例 / 测试数据一律化名（张某、李某），材料模板个人信息用 `{{占位符}}`；涉密材料不入代码、不入对话。详见 [docs/项目计划.md](docs/项目计划.md) §四。
