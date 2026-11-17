# 协作开发

本仓库的当前网站是 Cloudflare Worker。`frontend/`、`public/`、`worker.js`、`rag.js`、`mentor-*.js`、`knowledge/` 和 `migrations/` 是主要修改位置；`legacy/` 保存早期 Django 版本供对照。

## 开始开发

1. 安装 Node.js 24，运行 `npm ci`。
2. 运行 `npm run check`，确认构建与测试通过。
3. 从 `main` 建立自己的分支，提交改动后向 `main` 发起 Pull Request。仓库会自动运行 `npm run check`，并向 `@2557806318-boop` 请求审阅。

当前线上网站：[joinccp.martinzhang.asia](https://joinccp.martinzhang.asia/)。提出 PR 不会自动修改线上网站。仓库所有者批准并完成部署后，新版本才会在该域名生效。

本地运行需要自行创建 `.dev.vars` 并配置开发用密钥。不要提交 `.env`、`.dev.vars`、Cloudflare 凭据、DeepSeek Key、真实学生档案、上传材料或本地数据库。`public/app.js` 和 PDF.js 浏览器文件由 `npm run build` 生成，无需提交。

线上域名、D1 和 R2 绑定保存在 `wrangler.jsonc`。协作者请先在本地测试；线上部署由仓库所有者统一执行，避免改动共享数据和站点。
