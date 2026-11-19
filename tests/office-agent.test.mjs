import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { officeMessages, parseOfficePlan } from "../office-agent.js";
import { officeRoutes } from "../worker.js";

const request = (path, data) => new Request("https://example.test" + path, {
  method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify(data)
});
const counselor = { id: 8, role: "counselor", department_id: 2 };

test("办公助理使用独立人格和仅规划不执行的提示词", () => {
  const messages = officeMessages("为张三重置密码", "", [], "counselor", { stages: [], materials: [] });
  assert.match(messages[0].content, /办公助理/);
  assert.match(messages[0].content, /所有写入都需要用户查看预览并点击确认/);
  assert.match(messages[0].content, /不能猜测学号/);
});

test("管理员的对话计划保留辅导员名单和指定院系", () => {
  const action = { type: "register_counselors", departmentId: 2, counselors: [{ name: "张三", username: "teacher1" }] };
  assert.deepEqual(parseOfficePlan(JSON.stringify({ reply: "请核对名单", action })).action, action);
  assert.match(officeMessages("", "", [], "admin", {})[0].content, /delete_counselors/);
  assert.doesNotMatch(officeMessages("", "", [], "counselor", {})[0].content, /delete_counselors/);
});

test("辅导员不能通过对话为其他辅导员生成删除计划", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: {
    content: JSON.stringify({ reply: "请确认", action: { type: "delete_counselors", counselors: [{ username: "teacher1" }] } })
  } }] }));
  let writes = 0;
  const env = { DEEPSEEK_API_KEY: "test", DB: { prepare() { return {
    async all() { return { results: [] }; },
    async run() { writes++; }
  }; } } };
  try {
    const response = await officeRoutes(request("/api/office/plan", { question: "删除辅导员 teacher1" }), env, "/api/office/plan", counselor);
    const result = await response.json();
    assert.equal(result.plan, null);
    assert.match(result.answer, /仅管理员/);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("办公规划拒绝未知工具和无效清单，允许澄清", () => {
  assert.deepEqual(parseOfficePlan('{"reply":"请提供学号","action":null}'), { reply: "请提供学号", action: null });
  assert.throws(() => parseOfficePlan('{"reply":"执行","action":{"type":"delete_database"}}'), /不支持/);
  assert.throws(() => parseOfficePlan('{"reply":"执行","action":{"type":"register_students","students":[]}}'), /1 至 50/);
  assert.equal(parseOfficePlan('{"reply":"请核对","action":{"type":"reset_password","student":"123456789"}}').action.student, "123456789");
});

test("学生不能调用办公操作", async () => {
  await assert.rejects(officeRoutes(request("/api/office/plan", { question: "重置密码" }), {}, "/api/office/plan", { id: 7, role: "student" }), { status: 403 });
});

test("办公助理被问模型身份时固定回答，不调用外部模型", async () => {
  const response = await officeRoutes(request("/api/office/plan", { question: "你是什么模型？" }), {}, "/api/office/plan", counselor);
  const data = await response.json();
  assert.match(data.answer, /中国民航大学理学院独立开发/);
  assert.equal(data.plan, null);
});

test("办公助理的当前时间来自服务器时钟", async () => {
  const response = await officeRoutes(request("/api/office/plan", { question: "现在几点？" }), {}, "/api/office/plan", counselor);
  const data = await response.json();
  assert.match(data.answer, /现在北京时间是/);
  assert.equal(data.plan, null);
});

test("办公助理仅生成待确认计划，不在规划阶段重置密码", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"请核对目标学生","action":{"type":"reset_password","student":"123456789"}}' } }] }), { status: 200 });
  const writes = [];
  const env = { DEEPSEEK_API_KEY: "test", DB: { prepare(sql) { return {
    sql, params: [], bind(...params) { this.params = params; return this; },
    async all() {
      if (sql.includes("FROM users u JOIN profiles p")) return { results: [{ id: 7, name: "张三", student_no: "123456789", department_id: 2 }] };
      return { results: [] };
    },
    async run() { writes.push(this); return { meta: { changes: 1 } }; }
  }; } } };
  try {
    const response = await officeRoutes(request("/api/office/plan", { question: "重置学号 123456789 的密码" }), env, "/api/office/plan", counselor);
    const data = await response.json();
    assert.equal(data.plan.type, "reset_password");
    assert.match(data.plan.preview, /123456789/);
    assert.deepEqual(writes.map(item => item.sql.split(" ")[0]), ["INSERT"]);
  } finally { globalThis.fetch = previousFetch; }
});

test("辅导员不能为其他院系学生生成可执行计划", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"将重置密码","action":{"type":"reset_password","student":"999999999"}}' } }] }), { status: 200 });
  let writes = 0;
  const env = { DEEPSEEK_API_KEY: "test", DB: { prepare(sql) { return {
    bind() { return this; },
    async all() { return { results: [] }; },
    async run() { writes++; return { meta: { changes: 1 } }; }
  }; } } };
  try {
    const response = await officeRoutes(request("/api/office/plan", { question: "重置学号 999999999 的密码" }), env, "/api/office/plan", counselor);
    const data = await response.json();
    assert.equal(data.plan, null);
    assert.match(data.answer, /找不到可管理的学生/);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("已确认的密码重置只保存校验值并注销该学生会话", async () => {
  const pepper = "p".repeat(40), planId = "a".repeat(32), newSalt = "b".repeat(32), newVerifier = "c".repeat(64);
  const operations = [], batches = [];
  const env = { AUTH_PEPPER: pepper, DB: {
    prepare(sql) { return {
      sql, params: [], bind(...params) { this.params = params; return this; },
      async first() {
        if (sql.includes("FROM office_plans")) return { id: planId, user_id: 8, status: "pending", expires_at: "2999-01-01T00:00:00.000Z", payload_json: JSON.stringify({ type: "reset_password", studentId: 7, studentNo: "123456789" }) };
        if (sql.includes("FROM users u JOIN profiles p")) return { id: 7, department_id: 2, student_no: "123456789" };
        if (sql.includes("FROM users WHERE id=? AND role='student'")) return { department_id: 2 };
        return null;
      },
      async run() { operations.push(this); return { meta: { changes: 1 } }; }
    }; },
    async batch(statements) { batches.push(statements); }
  } };
  const response = await officeRoutes(request("/api/office/execute", { planId, newSalt, newVerifier }), env, "/api/office/execute", counselor);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).temporaryPassword, undefined);
  assert.equal(batches[0].length, 2);
  assert.match(batches[0][0].sql, /reset_password=1/);
  assert.equal(batches[0][0].params[1], createHmac("sha256", pepper).update("123456789:" + newVerifier).digest("hex"));
  assert.match(batches[0][1].sql, /DELETE FROM sessions/);
  assert.ok(operations.some(item => item.sql.includes("status='done'")));
});
