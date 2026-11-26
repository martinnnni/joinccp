import test from "node:test";
import assert from "node:assert/strict";
import { decideAgentPolicy, protectedMentorIntent } from "../agent-policy.js";
import { mentorRoutes, agentRoutes } from "../worker.js";

test("PDP separates public, personal, student-tool, and office-tool capabilities", () => {
  const decide = (role, capability, action = "", actorId = null, targetUserId = null) =>
    decideAgentPolicy({ role, capability, action, actorId, targetUserId });
  assert.equal(decide("guest", "mentor.public").allowed, true);
  assert.equal(decide("guest", "mentor.personal").reason, "student_login_required");
  assert.equal(decide("student", "mentor.personal", "", 7).allowed, true);
  assert.equal(decide("student", "student.tool", "prepare_submit", 7, 8).reason, "not_owner");
  assert.equal(decide("student", "office.tool", "review_materials", 7).reason, "staff_only");
  assert.equal(decide("counselor", "office.tool", "create_invites", 8).reason, "admin_only");
  assert.equal(decide("admin", "office.tool", "create_invites", 1).allowed, true);
  assert.equal(decide("admin", "office.tool", "unknown_tool", 1).reason, "tool_not_allowed");
  assert.equal(decide("admin", "typo", "", 1).reason, "unknown_capability");
});

test("specific personal-record requests are recognized without blocking general process questions", () => {
  assert.equal(protectedMentorIntent("我交了哪些材料，还有哪些没交？"), true);
  assert.equal(protectedMentorIntent("我现在处于哪个入党阶段？"), true);
  assert.equal(protectedMentorIntent("查看其他同学的材料"), true);
  assert.equal(protectedMentorIntent("入党申请书如何组织结构？"), false);
  assert.equal(protectedMentorIntent("党员发展有哪些阶段？"), false);
});

test("guest personal query is stopped before model or personal database access", async () => {
  let modelCalled = false, personalRead = false;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { modelCalled = true; throw Error("model must not be called"); };
  const env = { DEEPSEEK_API_KEY: "test", DB: {
    prepare(sql) { if (/material_records|profiles|FROM nodes/.test(sql)) personalRead = true; return {
      bind() { return this; }, async first() { return null; }, async run() { return { meta: { changes: 1 } }; }
    }; }, async batch() { return []; }
  } };
  const request = new Request("https://example.test/api/mentor/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "我交了哪些材料，还有哪些没交？" }) });
  const audit = {};
  try {
    const result = await (await mentorRoutes(request, env, "/api/mentor/chat", null, audit)).json();
    assert.equal(result.route, "login_required");
    assert.equal(result.requiresLogin, true);
    assert.deepEqual(result.sources, []);
    assert.equal(audit.policyDecision, "deny");
    assert.equal(audit.policyReason, "student_login_required");
    assert.equal(modelCalled, false);
    assert.equal(personalRead, false);
  } finally { globalThis.fetch = oldFetch; }
});

test("guest can still ask a public question through the mentor chat", async () => {
  const oldFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (_url, options) => {
    modelCalls++;
    const payload = JSON.parse(options.body);
    const content = payload.response_format ? '{"intent":"chitchat","reason":"公开写作建议"}' : "可以先说明申请动机，再结合个人经历展开。";
    return Response.json({ choices: [{ message: { content } }] });
  };
  const env = { DEEPSEEK_API_KEY: "test", DB: {
    prepare() { return { bind() { return this; }, async first() { return null; }, async run() { return { meta: { changes: 1 } }; } }; },
    async batch() { return []; }
  } };
  const request = new Request("https://example.test/api/mentor/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "入党申请书如何组织结构？" }) });
  try {
    const result = await (await mentorRoutes(request, env, "/api/mentor/chat", null)).json();
    assert.equal(result.route, "chitchat");
    assert.match(result.answer, /申请动机/);
    assert.equal(modelCalls, 2);
  } finally { globalThis.fetch = oldFetch; }
});

test("student plan execution rechecks the stored action against the PEP", async () => {
  const user = { id: 7, role: "student" };
  const planId = "a".repeat(32), payloadHash = "b".repeat(64);
  const env = { DEEPSEEK_API_KEY: "test", DB: { prepare(sql) { return {
    bind() { return this; },
    async first() { return sql.includes("FROM student_plans") ? {
      id: planId, user_id: 7, status: "pending", expires_at: "2999-01-01T00:00:00.000Z",
      payload_hash: payloadHash, action_type: "delete_database", payload_json: '{"type":"delete_database"}'
    } : null; },
    async run() { throw Error("must not lock or execute"); }
  }; } } };
  const request = new Request("https://example.test/api/agent/execute", { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify({ planId, payloadHash }) });
  const audit = {};
  await assert.rejects(agentRoutes(request, env, "/api/agent/execute", user, audit), { status: 403 });
  assert.equal(audit.policyDecision, "deny");
  assert.equal(audit.policyReason, "tool_not_allowed");
});
