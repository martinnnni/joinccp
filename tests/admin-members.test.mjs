import test from "node:test";
import assert from "node:assert/strict";
import { adminRoutes } from "../worker.js";
import { parseCounselorRoster } from "../frontend/roster.js";

const counselor = { id: 8, role: "counselor", grade_id: 2 };
const admin = { id: 1, role: "admin" };
const request = (path, data) => new Request("https://example.test" + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data)
});

function makeEnv({ existingUser = false, counselorRows = [] } = {}) {
  const batches = [], runs = [], deleted = [];
  const db = {
    prepare(sql) {
      return {
        sql, params: [],
        bind(...params) { this.params = params; return this; },
        async first() {
          if (sql.includes("FROM classes c LEFT JOIN majors")) return { id: Number(this.params[0]), major_id: 2, grade_id: 2 };
          if (sql.includes("SELECT college_id FROM majors")) return { college_id: 1 };
          if (sql.includes("FROM grades WHERE id=")) return { id: Number(this.params[0]), college_id: 1 };
          if (sql.includes("FROM users WHERE username=")) return existingUser ? { id: 99 } : null;
          return null;
        },
        async all() {
          if (sql.includes("role='counselor' AND deleted_at IS NULL AND username IN")) return { results: counselorRows.map((row, i) => ({ id: row.id ?? i + 5, username: row.username ?? this.params[i] })) };
          if (sql.includes("FROM form_templates WHERE uploaded_by")) return { results: [{ r2_key: "forms/2/one.docx" }] };
          if (sql.includes("FROM users WHERE username IN")) return { results: existingUser ? [{ username: this.params[0] }] : [] };
          return { results: [] };
        },
        async run() { runs.push({ sql, params: this.params }); return { meta: { changes: 1 } }; }
      };
    },
    async batch(stmts) { batches.push(stmts.map(s => ({ sql: s.sql, params: s.params }))); return []; }
  };
  return { env: { AUTH_PEPPER: "x".repeat(40), DB: db, FILES: { async delete(key) { deleted.push(key); } } }, batches, runs, deleted };
}

test("管理员可手动添加学生并写入用户与档案", async () => {
  const { env, batches } = makeEnv();
  const res = await adminRoutes(request("/api/admin/students", { name: "张三", studentNo: "2025001", classId: 2 }), env, "/api/admin/students", admin);
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.equal(data.studentNo, "2025001");
  assert.equal(batches[0].length, 2);
  assert.match(batches[0][0].sql, /INSERT INTO users/);
  assert.match(batches[0][1].sql, /INSERT INTO profiles/);
});

test("辅导员可手动添加学生到本专业班级", async () => {
  const { env, batches } = makeEnv();
  const res = await adminRoutes(request("/api/admin/students", { name: "李四", studentNo: "2025002", classId: 2 }), env, "/api/admin/students", counselor);
  assert.equal(res.status, 201);
  assert.match(batches[0][0].sql, /'student'/);
  assert.equal(batches[0][0].params[3], 1); // 学院
  assert.equal(batches[0][0].params[4], 2); // 班级
  assert.equal(batches[0][0].params[5], "李四");
});

test("手动添加学生校验姓名学号与重复学号", async () => {
  const bad = makeEnv();
  await assert.rejects(adminRoutes(request("/api/admin/students", { name: "A", studentNo: "2025001", classId: 2 }), bad.env, "/api/admin/students", admin), { status: 400 });
  const dup = makeEnv({ existingUser: true });
  await assert.rejects(adminRoutes(request("/api/admin/students", { name: "张三", studentNo: "2025001", classId: 2 }), dup.env, "/api/admin/students", admin), { status: 409 });
});

test("仅管理员可手动添加辅导员，辅导员被拒绝", async () => {
  await assert.rejects(adminRoutes(request("/api/admin/counselors", { name: "王老师", username: "wanglaoshi", gradeId: 2 }), makeEnv().env, "/api/admin/counselors", counselor), { status: 403 });
  const { env, runs } = makeEnv();
  const res = await adminRoutes(request("/api/admin/counselors", { name: "王老师", username: "wanglaoshi", gradeId: 2 }), env, "/api/admin/counselors", admin);
  assert.equal(res.status, 201);
  assert.match(runs[0].sql, /INSERT INTO users/);
  assert.match(runs[0].sql, /'counselor'/);
  assert.equal(runs[0].params[0], "wanglaoshi");
  assert.equal(runs[0].params[4], 2);
});

test("管理员可批量添加辅导员到指定专业", async () => {
  const { env, batches } = makeEnv();
  const res = await adminRoutes(request("/api/admin/counselors/auto-register", { gradeId: 2, counselors: [{ name: "王老师", username: "wang1" }, { name: "赵老师", username: "zhao1" }] }), env, "/api/admin/counselors/auto-register", admin);
  const data = await res.json();
  assert.equal(data.count, 2);
  assert.equal(batches[0].length, 2);
  assert.match(batches[0][0].sql, /INSERT INTO users/);
  await assert.rejects(adminRoutes(request("/api/admin/counselors/auto-register", { gradeId: 2, counselors: [{ name: "王老师", username: "wang1" }] }), env, "/api/admin/counselors/auto-register", counselor), { status: 403 });
});

test("仅管理员可移除辅导员，上传表格仍保留", async () => {
  await assert.rejects(adminRoutes(request("/api/admin/counselors/bulk-delete", { usernames: ["wang1"] }), makeEnv().env, "/api/admin/counselors/bulk-delete", counselor), { status: 403 });
  const { env, batches, deleted } = makeEnv({ counselorRows: [{ id: 5, username: "wang1" }] });
  const res = await adminRoutes(request("/api/admin/counselors/bulk-delete", { usernames: ["wang1"] }), env, "/api/admin/counselors/bulk-delete", admin);
  assert.equal((await res.json()).count, 1);
  assert.match(batches[0][0].sql, /UPDATE users SET deleted_at/);
  assert.match(batches[0].at(-1).sql, /INSERT INTO operation_logs/);
  assert.deepEqual(deleted, []);
});

test("辅导员名单解析姓名+用户名或纯用户名", () => {
  const result = parseCounselorRoster("张老师 zhangsan\nlisi\n王老师, wangwu");
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[0], { name: "张老师", username: "zhangsan" });
  assert.deepEqual(result.rows[1], { name: "", username: "lisi" });
  assert.deepEqual(result.rows[2], { name: "王老师", username: "wangwu" });
});
