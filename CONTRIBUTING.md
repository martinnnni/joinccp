# 协作开发

本仓库的当前网站是 Cloudflare Worker。`frontend/`、`public/`、`worker.js`、`rag.js`、`mentor-*.js`、`knowledge/` 和 `migrations/` 是主要修改位置；`legacy/` 保存早期 Django 版本供对照。

## 开始开发

1. 安装 Node.js 24，运行 `npm ci`。
2. 运行 `npm run check`，确认构建与测试通过。
3. 从 `main` 建立自己的分支，提交改动后向 `main` 发起 Pull Request。仓库会自动运行 `npm run check`，并向 `@2557806318-boop` 请求审阅。请勿直接向 `main` 推送或自行合并 PR。

当前线上网站：[joinccp.martinzhang.asia](https://joinccp.martinzhang.asia/)。提出 PR 不会自动修改线上网站。

## 批准后的发布

仓库所有者在 GitHub 审阅并批准 PR 后，将 PR 链接发给 Codex。Codex 须检查批准者为 `2557806318-boop`、批准对应 PR 最新提交、CI 测试通过，并复核本地工作区和修改内容；然后合并 PR、同步 `main`、运行 `npm run check`、使用本机 Wrangler 登录执行 `npm run deploy`，最后检查子域名和博客首页。审核未通过、PR 有新提交或测试失败时不部署。

这个私人仓库使用 GitHub Free，平台不提供私人仓库的强制分支保护。协作者技术上仍有直接推送或合并权限，所以请遵守上述约定。线上部署凭据不存放在 GitHub Actions Secrets，只有仓库所有者本机能够执行发布。

本地运行需要自行创建 `.dev.vars` 并配置开发用密钥。不要提交 `.env`、`.dev.vars`、Cloudflare 凭据、DeepSeek Key、真实学生档案、上传材料或本地数据库。`public/app.js` 和 PDF.js 浏览器文件由 `npm run build` 生成，无需提交。

线上域名、D1 和 R2 绑定保存在 `wrangler.jsonc`。协作者请先在本地测试；线上部署由仓库所有者统一执行，避免改动共享数据和站点。
