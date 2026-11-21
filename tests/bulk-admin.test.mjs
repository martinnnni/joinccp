import test from "node:test";
import assert from "node:assert/strict";
import { adminRoutes } from "../worker.js";

const counselor = { id: 8, role: "counselor", major_id: 2 };
const admin = { id: 1, role: "admin" };
const path = action => "/api/admin/" + action;
const request = (action, data) => new Request("https://example.test" + path(action), {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data)
});
function fakeEnv({ foreign = false, review = false } = {}) {
  const batches = [];
  const deleted = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          sql, params: [],
          bind(...params) { this.params = params; return this; },
          async first() {
            if (sql.includes("FROM users u JOIN profiles")) return { id: this.params[0], class_id: 2, major_id: foreign ? 3 : 2, class_name: "计科2301班", name: "测试学生", current_stage_slug: "application" };
            if (sql.includes("FROM users u LEFT JOIN classes")) return { major_id: foreign ? 3 : 2 };
            if (sql.includes("FROM nodes WHERE stage_slug=")) return { slug: "activist-first" };
            if (sql.includes("FROM checks WHERE student_id=")) return { id: 12 };
            if (sql.includes("FROM majors WHERE id=")) return { id: 2, college_id: 1 };
            return null;
          },
          async all() {
            if (sql.includes("FROM stages ORDER BY")) return { results: [{ slug: "application", name: "申请入党" }, { slug: "activist", name: "积极分子" }] };
            if (sql.includes("FROM checks c JOIN users")) return { results: [{ id: 12, student_id: 7, material_id: 4, major_id: foreign ? 3 : 2, monitor_approved: 1, review_status: "待审阅", filename: "申请书.docx", material_name: "入党申请书" }] };
            if (sql.includes("SELECT r2_key FROM checks")) return { results: [{ r2_key: "checks/7/one.docx" }] };
            return { results: [] };
          }
        };
      },
      async batch(statements) { batches.push(statements); return statements.map(() => ({ success: true })); }
    },
    FILES: { async delete(key) { deleted.push(key); } }
  };
  return { env, batches, deleted };
}

test("辅导员无法批量推进或删除其他院系学生，且不写入数据库", async () => {
  const { env, batches } = fakeEnv({ foreign: true });
  for (const action of ["students/bulk-advance", "students/bulk-delete"]) {
    await assert.rejects(adminRoutes(request(action, { studentIds: [7] }), env, path(action), counselor), { status: 403 });
  }
  assert.equal(batches.length, 0);
});

test("批量推进写入下一阶段并通知学生", async () => {
  const { env, batches } = fakeEnv();
  const action = "students/bulk-advance";
  const response = await adminRoutes(request(action, { studentIds: [7] }), env, path(action), counselor);
  assert.equal((await response.json()).count, 1);
  assert.equal(batches[0][0].params[0], "activist");
  assert.match(batches[0][1].sql, /INSERT INTO notifications/);
});

test("批量审阅拒绝跨院系材料和缺失退回说明", async () => {
  const action = "checks/bulk-review";
  const foreign = fakeEnv({ foreign: true });
  await assert.rejects(adminRoutes(request(action, { checkIds: [12], status: "已通过" }), foreign.env, path(action), counselor), { status: 403 });
  const local = fakeEnv();
  await assert.rejects(adminRoutes(request(action, { checkIds: [12], status: "退回修改" }), local.env, path(action), counselor), { status: 400 });
  assert.equal(foreign.batches.length + local.batches.length, 0);
});

test("批量审阅同步材料状态并发送结果通知", async () => {
  const { env, batches } = fakeEnv();
  const action = "checks/bulk-review";
  const response = await adminRoutes(request(action, { checkIds: [12], status: "已通过" }), env, path(action), counselor);
  assert.equal((await response.json()).count, 1);
  assert.equal(batches[0][1].params[0], "已通过");
  assert.match(batches[0][2].sql, /INSERT INTO notifications/);
});

test("管理员可批量生成辅导员邀请码，辅导员不可邀请", async () => {
  const { env, batches } = fakeEnv();
  const action = "invites";
  await assert.rejects(adminRoutes(request(action, { majorId: 2, role: "counselor", count: 3 }), env, path(action), counselor), { status: 403 });
  const response = await adminRoutes(request(action, { majorId: 2, role: "counselor", count: 3 }), env, path(action), admin);
  const data = await response.json();
  assert.equal(data.codes.length, 3);
  assert.equal(new Set(data.codes).size, 3);
  assert.equal(batches[0].length, 3);
  await assert.rejects(adminRoutes(request(action, { majorId: 2, role: "student" }), env, path(action), admin), { status: 400 });
});

test("批量移除记录账号编号并保留关联数据和文件", async () => {
  const { env, batches, deleted } = fakeEnv();
  const action = "students/bulk-delete";
  const response = await adminRoutes(request(action, { studentIds: [7] }), env, path(action), counselor);
  assert.equal((await response.json()).count, 1);
  assert.match(batches[0].at(-1).sql, /INSERT INTO operation_logs/);
  assert.deepEqual(deleted, []);
});
