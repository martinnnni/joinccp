# 党员发展计划辅助系统 · Cloudflare 测试版

**线上网站：**[joinccp.martinzhang.asia](https://joinccp.martinzhang.asia/) · [成长导师](https://joinccp.martinzhang.asia/#mentor)

**协作发布：**朋友从分支提出 Pull Request，GitHub 自动运行测试并请求仓库所有者审阅。所有者在 GitHub 批准后，把 PR 链接交给 Codex；Codex 核对批准记录与测试结果，再合并并部署到上述网站。操作细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。Cloudflare 部署凭据仅保留在所有者本机，不写入 GitHub。

此目录将原 Django 项目改写为 Cloudflare Worker。原业务源码保存在 legacy/，未复制压缩包中的密钥文件、本机虚拟环境、工具源码和日志。

页眉使用[中国民航大学官网](https://www.cauc.edu.cn/zhv5/)的校徽与校名题字图片（`public/cauc-wordmark.png`）；项目名称沿用原项目的“党员发展计划辅助系统”。当前界面借鉴 martinzhang.asia 博客的大字号排版、细网格与轨道图形，保持白底。拉丁字形使用开源的 [Space Grotesk](https://github.com/floriankarsten/space-grotesk) 与 [DM Mono](https://github.com/googlefonts/dm-mono)，授权文本位于 `public/fonts/`。

当前界面使用 `public/site.css` 与成长导师专用的 `public/mentor.css`，设计原则记录于 `DESIGN.md`。旧版预览入口 `/design-preview.html` 会跳转到当前网站。

## 运行架构

- Worker：页面、认证和业务接口；静态文件来自 public/。
- D1：账号、院系、流程、材料、质检结果、通知和院系表格目录。迁移中的流程种子数据由原项目 flow_data.py 生成。
- 私有 R2：学生提交的 DOCX 与辅导员上传的表格；下载均经过登录及院系权限检查。
- 定时任务：每天北京时间 09:00 生成临近截止通知。
- 成长导师：四份知识文件在构建时切成 25 个可检索片段；当前登录学生的档案与材料状态按需从 D1 实时组成专属检索片段。配置 DeepSeek Secret 后启用带来源的 AI 回答和 DOCX/PDF 文字检查。当前不使用原包中的密钥。
- 资料下载：按五个培养阶段展示 21 份中国民航大学党委组织部公开附件的原始下载链接；管理员可上传全校通用表格，辅导员可上传本院系表格。公开附件可能早于现行要求，使用前须由辅导员核对。

## 本地运行

1. 运行 npm ci。
2. 创建 .dev.vars，分别设置至少 32 字符的 AUTH_PEPPER 和至少 24 字符的 BOOTSTRAP_TOKEN。两者均不可提交。
3. 运行 npx wrangler d1 migrations apply joinccp-preview --local。
4. 运行 npm run dev。

可在 `.dev.vars` 中额外设置 `DEEPSEEK_API_KEY` 测试 AI 回答；不设置时仍可验证知识库检索。

访问 http://127.0.0.1:8787。首次打开“初始化管理员”页面，输入 BOOTSTRAP_TOKEN 并设置用户名密码。之后在工作台创建院系、生成一次性邀请码。注册时需邀请码，邀请码七天过期。学生受邀注册仅填写姓名、学号、初始密码和邀请码，登录时以学号作为用户名。院系由邀请码确定，专业、年级、联系电话和申请日期由辅导员在学生档案中维护。辅导员受邀注册后会看到系统分配的登录用户名，须妥善保存。

## 部署

1. Cloudflare 账户须有 Workers、D1、R2 权限，且已开通 R2 订阅。wrangler.jsonc 中 D1 ID、R2 bucket 和 Custom Domain 指向本项目资源。
2. 运行 npx wrangler d1 migrations apply joinccp-preview --remote。
3. 运行 npx wrangler secret put AUTH_PEPPER 与 npx wrangler secret put BOOTSTRAP_TOKEN。
4. 运行 npm run deploy。
5. 打开 https://joinccp.martinzhang.asia，初始化管理员并建立受邀测试账号。

成长导师使用 `knowledge/` 下四份 Markdown 作为共享测试知识库，另按登录身份读取本人档案和材料状态。更新知识文件后运行 `npm run build`，会重新生成 `knowledge.generated.js`。需要启用 AI 回答时，由管理员执行 `npx wrangler secret put DEEPSEEK_API_KEY`，在终端输入密钥；不要把密钥写入仓库。接口使用 DeepSeek Chat Completions 的 `deepseek-flash` 非思考模式，不设每日提问次数限制。测试版资料只作参考，校内要求应按学校和党组织现行文件核对。

### 成长导师路由

- `/api/mentor/chat` 先用 DeepSeek JSON 模式分类为 `business`、`chitchat`、`out_of_scope` 或 `uncertain`。分类失败视为 `uncertain`；身份问题由服务器固定回复。闲聊直接回答，无关问题说明服务范围，模糊问题只追问一次。
- `business` 检索共享知识库；本人档案和材料问题还会读取当前登录学生的 D1 实时记录，系统操作问题检索《系统使用指南》。党务写作等开放问题可由模型直接回答，同时附上命中的相关知识片段。`rag.js` 计算 0–1 查询词覆盖度；业务检索最高值低于阈值时返回知识库缺口及人工/官方渠道，不调用回答模型。命中时回答附检索来源。
- 当前时间类问题由 Worker 的 `getCurrentTime()` 读取北京时间后直接回答，不请求 RAG 或 DeepSeek。
- `/api/mentor/review` 接收浏览器从 DOCX 或可搜索 PDF 提取的文字，先调用模型识别材料类型，再从《填写规范》与材料清单取依据，最后检查疑似错别字及填写内容问题。仅提交文字，不存储原文件；扫描版 PDF 和旧版 `.doc` 须先转换。最多 10 MB、30 页、20000 字；不能通过纯文字核实字体、版式和签章。
- `wrangler.jsonc` 的 `RAG_MIN_SIMILARITY` 默认 `0.40`，改为 `0.50` 会更严格，改为 `0.30` 会更宽松；改动后运行 `npm run deploy`。`INTENT_MODEL` 是分类模型名。兜底话术和身份回复集中在 `mentor-config.js`。
- `mentor_question_logs` D1 表记录时间、原问题、意图、最高相似度和走向。仅服务器写入，不提供公开查询接口；排查缺口可使用 `npx wrangler d1 execute joinccp-preview --remote --command "SELECT created_at,question,intent,top_similarity,outcome FROM mentor_question_logs ORDER BY id DESC LIMIT 50"`。原问题可能包含用户输入的个人信息，应限制数据库访问。
- 运行 `npm run check` 执行路由、分类异常、权限和现有 RAG 测试。

`official-forms.json` 记录学校组织部附件及来源页；这些文件仍由学校网站提供。新增院系表格经 `/api/forms` 上传到私有 R2，学生只看到通用表格及本院系表格。学生在“材料提交”页上传 DOCX 后，材料状态更新为“已交”；辅导员可在“已提交文件”和学生档案中下载所属院系学生的文件。

上线后使用“修改密码”页轮换管理员密码。不要在聊天、日志或代码仓库中粘贴密码、邀请码、令牌或上传材料。

## 权限与限制

- 仅持有效邀请码者可注册；学生只能读取自己的资料，辅导员只能读取同院系学生，管理员可管理全部院系。
- 「材料提交」页的 DOCX 格式检查在浏览器中执行，提交文件及结果保存到 R2/D1。成长导师的文件检查只传输提取出的文字到 DeepSeek，不保存原文件。规则和模型提示不是组织审批意见。成长导师仅允许学生账号调用；AI 未配置时聊天接口拒绝请求，资料检索仍可使用。聊天记录只保留在当前页面内存，不写入 D1；本人档案查询和文件检查会向 DeepSeek 发送所需姓名、学号、材料状态或文件文字，不发送电话。日志仅记录问题或检查文件名，不记录文件正文。
- Workers Free 每次请求 CPU 上限为 10 ms，D1 与 R2 有各自免费额度。管理员应在 Cloudflare 面板查看请求错误、D1 用量和 R2 用量；超额或 R2 订阅失效时上传可能失败。
- legacy/ 的 Ubuntu、MySQL、Neo4j 和 Celery 部署文档仅供追溯，当前部署不使用这些服务。
