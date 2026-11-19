import test from "node:test";
import assert from "node:assert/strict";
import { isPersonalQuestion, isSiteHelpQuestion, personalMatches, isSelfIdentityQuestion, isChineseQuestion } from "../mentor-personal.js";
import { retrieve, reviewStandards } from "../rag.js";
import { parseReview } from "../mentor-review.js";
import { mentorRoutes } from "../worker.js";

const student = { id: 7, role: "student", name: "张同学", student_no: "20260001", current_stage_slug: "application", current_node_slug: "apply", college_name: "理学院", major_name: "计算机科学与技术", class_name: "计科2301班" };
const rows = [
  { name: "入党申请书", stage_slug: "application", stage_name: "申请入党", status: "已交", r2_key: "private-file" },
  { name: "入党申请人登记表", stage_slug: "application", stage_name: "申请入党", status: null, r2_key: null },
  { name: "思想汇报", stage_slug: "activist", stage_name: "积极分子", status: null, r2_key: null }
];
const request = (path, body) => new Request("https://example.test" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("本人档案与材料状态形成实时检索片段，未来阶段不算欠交", () => {
  assert.equal(isPersonalQuestion("我叫什么、学号是多少？"), true);
  assert.equal(isPersonalQuestion("我交了哪些材料，还有哪些没交？"), true);
  const matches = personalMatches("我交了哪些材料，还有哪些没交？", student, rows, "提出入党申请");
  assert.equal(matches.length, 2);
  assert.match(matches[0].text, /张同学.*20260001.*申请入党/);
  assert.match(matches[1].text, /入党申请书（已交，有上传文件）/);
  assert.match(matches[1].text, /入党申请人登记表（未交）/);
  assert.doesNotMatch(matches[1].text.split("未交材料：")[1], /思想汇报/);
});

test("网站操作指南可检索，规范检索包含填写依据", () => {
  assert.equal(isSiteHelpQuestion("材料提交页面在哪里？"), true);
  const result = retrieve("材料提交页面在哪里？");
  assert.equal(result[0].file, "系统使用指南.md");
  assert.ok(result[0].similarity >= 0.4);
  assert.ok(reviewStandards("入党申请书").some(item => item.file === "填写规范.md"));
});

test("个人问题只查询当前登录学生并把实时来源交给回答模型", async () => {
  const binds = [], sent = [];
  const env = { DEEPSEEK_API_KEY: "test-key", DB: { prepare(sql) {
    return { bind(...values) { binds.push({ sql, values }); return this; },
      async all() { return { results: rows }; },
      async first() { return { name: "提出入党申请" }; },
      async run() { return { meta: { changes: 1 } }; } };
  } } };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body); sent.push(payload);
    const content = payload.response_format ? '{"intent":"chitchat","reason":"问题"}' : "你的入党申请书已交【2】。";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  try {
    const response = await mentorRoutes(request("/api/mentor/chat", { question: "我交了哪些材料，还有哪些没交？" }), env, "/api/mentor/chat", student);
    const data = await response.json();
    assert.equal(data.route, "business");
    assert.equal(data.sources[0].file, "个人档案（实时）");
    assert.equal(data.sources[1].file, "材料状态（实时）");
    assert.ok(binds.some(item => item.sql.includes("material_records") && item.values[0] === student.id));
    assert.match(sent[1].messages.at(-1).content, /20260001/);
    assert.doesNotMatch(sent[0].messages.at(-1).content, /20260001/);
  } finally { globalThis.fetch = oldFetch; }
});

test("党务写作建议可直接回答，同时引用命中的知识片段", async () => {
  const env = { DEEPSEEK_API_KEY: "test-key", DB: { prepare() { return { bind() { return this; }, async run() { return { meta: { changes: 1 } }; } }; } } };
  const sent = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body); sent.push(payload);
    const content = payload.response_format ? '{"intent":"chitchat","reason":"写作建议"}' : "可以先写申请动机，再结合个人经历展开【1】。";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  try {
    const result = await (await mentorRoutes(request("/api/mentor/chat", { question: "入党申请书如何组织结构？" }), env, "/api/mentor/chat", student)).json();
    assert.equal(result.route, "chitchat");
    assert.ok(result.sources.length > 0);
    assert.match(sent[1].messages.at(-1).content, /可参考的检索片段/);
  } finally { globalThis.fetch = oldFetch; }
});

test("文件检查依次识别表单和查询规范，拒绝伪造原文中的问题", async () => {
  const sent = [], logs = [];
  const catalog = [{ id: 1, name: "入党申请书", stage_name: "申请入党" }];
  const env = { DEEPSEEK_API_KEY: "test-key", DB: { prepare(sql) {
    return { bind(...values) { if (sql.includes("mentor_question_logs")) logs.push(values); return this; },
      async all() { return { results: catalog }; }, async run() { return { meta: { changes: 1 } }; } };
  } } };
  const text = "入党申请书\n我志愿加入中国共产党。我会认真学习，不断提高思想认识。申请人：张同学。";
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body); sent.push(payload);
    const content = sent.length === 1 ? '{"materialId":1,"reason":"标题"}' : JSON.stringify({
      summary: "已经完成文字检查。", typos: [{ original: "不存在的字", suggestion: "正确", reason: "测试" }],
      issues: [{ excerpt: "申请人：张同学", problem: "缺少日期", suggestion: "补充日期", source: 2 }], limitations: "无法核对字体。"
    });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  try {
    const response = await mentorRoutes(request("/api/mentor/review", { filename: "入党申请书.docx", text }), env, "/api/mentor/review", student);
    const result = await response.json();
    assert.equal(result.form, "入党申请书");
    assert.equal(sent.length, 2);
    assert.match(sent[0].messages[0].content, /识别/);
    assert.match(sent[1].messages.at(-1).content, /填写规范/);
    assert.match(result.answer, /缺少日期/);
    assert.doesNotMatch(result.answer, /不存在的字/);
    assert.ok(result.sources.some(item => item.file === "填写规范.md"));
    assert.match(logs[0][1], /^文件检查：/);
    assert.doesNotMatch(logs[0][1], /我志愿加入/);
  } finally { globalThis.fetch = oldFetch; }
  assert.equal(parseReview('{"typos":[{"original":"伪造","suggestion":"改"}],"issues":[]}', text, 3).typos.length, 0);
  await assert.rejects(mentorRoutes(request("/api/mentor/review", { filename: "file.txt", text }), env, "/api/mentor/review", student), /只支持/);
});

test("我是谁：未登录答不知道，登录后答 SQL 档案，英文提问用英文回答", async () => {
  assert.equal(isSelfIdentityQuestion("我是谁"), true);
  assert.equal(isSelfIdentityQuestion("who am i"), true);
  assert.equal(isSelfIdentityQuestion("what's my student number"), true);
  assert.equal(isSelfIdentityQuestion("入党申请书怎么写"), false);
  assert.equal(isChineseQuestion("我是谁"), true);
  assert.equal(isChineseQuestion("who am i"), false);
  const env = { DEEPSEEK_API_KEY: "test-key", DB: { prepare(sql) {
    return { bind() { return this; },
      async first() {
        if (sql.includes("stages")) return { name: "申请入党" };
        if (sql.includes("nodes")) return { name: "提出入党申请" };
        return null;
      },
      async run() { return { meta: { changes: 1 } }; } };
  }, async batch() { return []; } } };
  const guest = await (await mentorRoutes(request("/api/mentor/chat", { question: "我是谁" }), env, "/api/mentor/chat", null)).json();
  assert.match(guest.answer, /不知道/);
  const guestEn = await (await mentorRoutes(request("/api/mentor/chat", { question: "who am i" }), env, "/api/mentor/chat", null)).json();
  assert.match(guestEn.answer, /don't know/i);
  const logged = await (await mentorRoutes(request("/api/mentor/chat", { question: "我是谁" }), env, "/api/mentor/chat", student)).json();
  assert.match(logged.answer, /张同学.*20260001.*理学院.*申请入党/);
  const loggedEn = await (await mentorRoutes(request("/api/mentor/chat", { question: "who am i" }), env, "/api/mentor/chat", student)).json();
  assert.match(loggedEn.answer, /You are 张同学.*20260001.*理学院/i);
});
