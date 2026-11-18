import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { adminRoutes } from "../worker.js";
import { parseRosterText } from "../frontend/roster.js";

const pepper = "t".repeat(40);
const counselor = { id: 8, role: "counselor", department_id: 2 };
const admin = { id: 1, role: "admin", department_id: null };
const secret = value => createHmac("sha256", pepper).update(value).digest("hex");
const request = (path, data) => new Request("https://example.test" + path, {
  method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify(data)
});

test("名单解析识别顺序不同的姓名学号，并提示重复项", () => {
  const result = parseRosterText("姓名,学号\n张三,123456789\n987654321 李四\n张三 123456789");
  assert.deepEqual(result.rows, [{ name: "张三", studentNo: "123456789" }, { name: "李四", studentNo: "987654321" }]);
  assert.equal(result.issues.length, 1);
});

test("仅本院系辅导员可确认批量建号；数据库批次包含用户与档案", async () => {
  const batches = [];
  const env = { AUTH_PEPPER: pepper, DB: {
    prepare(sql) { return { sql, params: [], bind(...params) { this.params = params; return this; }, async all() { return { results: [] }; } }; },
    async batch(statements) { batches.push(statements); }
  } };
  const path = "/api/admin/students/auto-register";
  const body = { students: [{ name: "张三", studentNo: "123456789" }, { name: "李四", studentNo: "987654321" }] };
  await assert.rejects(adminRoutes(request(path, body), env, path, admin), { status: 403 });
  const response = await adminRoutes(request(path, body), env, path, counselor);
  assert.equal((await response.json()).count, 2);
  assert.equal(batches[0].length, 4);
  assert.equal(batches[0][0].params[0], "123456789");
  assert.equal(batches[0][0].params[2], secret("initial:123456789:cauc+123456789"));
  assert.match(batches[0][1].sql, /INSERT INTO profiles/);
  assert.equal(batches[0][2].params[3], 2);
});

test("旧学生邀请码无法继续用于自助注册", async () => {
  let written = false;
  const env = { AUTH_PEPPER: pepper, DB: { prepare(sql) { return {
    bind() { return this; }, async first() { return sql.includes("FROM invites") ? { role: "student" } : null; },
    async run() { written = true; }
  }; } } };
  const response = await worker.fetch(request("/api/register", { inviteCode: "a".repeat(48), salt: "a".repeat(32), verifier: "b".repeat(64), name: "张三", username: "123456789" }), env);
  assert.equal(response.status, 403);
  assert.equal(written, false);
});

test("初始密码登录后业务接口被锁定，改密后解除强制状态", async () => {
  const statements = [];
  const username = "123456789";
  const env = { AUTH_PEPPER: pepper, DB: { prepare(sql) { return {
    sql, params: [], bind(...params) { this.params = params; return this; },
    async first() {
      if (sql.includes("FROM login_attempts")) return null;
      if (sql.includes("FROM users WHERE username")) return { id: 7, password_verifier: secret("initial:" + username + ":cauc+" + username), must_change_password: 1 };
      if (sql.includes("FROM sessions s JOIN users")) return { id: 7, username, role: "student", must_change_password: 1 };
      if (sql.includes("FROM users WHERE id=")) return { password_verifier: secret("initial:" + username + ":cauc+" + username), must_change_password: 1 };
      return null;
    },
    async run() { statements.push(this); return { meta: { last_row_id: 7, changes: 1 } }; }
  }; } } };
  const login = await worker.fetch(request("/api/login", { username, verifier: "a".repeat(64), initialPassword: "cauc+" + username }), env);
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /session=/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const profile = await worker.fetch(new Request("https://example.test/api/profile", { headers: { cookie } }), env);
  assert.equal(profile.status, 403);
  const change = await worker.fetch(new Request("https://example.test/api/change-password", {
    method: "POST", headers: { origin: "https://example.test", cookie, "content-type": "application/json" },
    body: JSON.stringify({ oldPassword: "cauc+" + username, newPassword: "new-pass", newSalt: "b".repeat(32), newVerifier: "c".repeat(64) })
  }), env);
  assert.equal(change.status, 200);
  assert.ok(statements.some(item => item.sql.includes("must_change_password=0")));
});
