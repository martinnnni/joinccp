# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- 学生：查看个人培养阶段、下载表格、提交 DOCX、查看通知并使用知识库问答。
- 辅导员：维护所属院系学生档案、节点、材料状态与通知，生成邀请，上传院系表格并下载学生提交文件。
- 管理员：管理院系及跨院系的受邀测试账号，上传全校通用表格。

## Product Purpose

党员发展计划辅助系统将培养流程、个人档案、材料与通知集中在一个按角色授权的网站中。

## Operating Context

网站部署于 `joinccp.martinzhang.asia`，与 `martinzhang.asia` 博客分离。学生由所属院系辅导员在办公助理的「自动注册」工作流中批量建号，首次使用学号和 `cauc+学号` 登录并强制改密。一次性邀请码只用于辅导员注册；专业等档案字段由辅导员填写。

## Capabilities and Constraints

- Cloudflare Worker 承载应用，D1 保存业务记录，私有 R2 保存上传文件。
- DOCX 格式检查在浏览器执行；知识库检索可用，AI 回答取决于是否配置 API Key。
- 下载专区按阶段列出校方公开附件与经辅导员上传的表格；所有私有文件均受院系权限约束。
- 保留现有角色权限和核心表单字段。
- 界面需要在桌面与手机浏览器可用，并清楚显示键盘焦点、错误和空状态。

## Brand Commitments

- 保留中国民航大学官网校徽与校名题字，以及“党员发展计划辅助系统”名称。
- 用户要求白色主调，并借鉴 martinzhang.asia 博客的大字号排版、网格与克制的动态；不使用巨大的“党”字装饰。
- 入口与日常工作页面都应便于阅读和操作。

## Evidence on Hand

- `public/cauc-wordmark.png`：官网校徽与校名题字。
- `public/site.css`：当前唯一的界面样式。
- `frontend/app.js`：现有角色页面、文案、表单和操作流程。

## Product Principles

1. 先让用户找到当前任务，再呈现补充说明。
2. 状态和权限清楚可见，装饰不能代替信息。
3. 保持大学身份与日常办事效率之间的平衡。
