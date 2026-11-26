import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker, { checkRoutes, officeRoutes } from "../worker.js";

const counselor = { id: 8, role: "counselor", grade_id: 2 };
const admin = { id: 1, role: "admin" };
const migrations = new URL("../migrations/", import.meta.url);

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const deleted = [];
  const env = {
    DEEPSEEK_API_KEY: "test", AUTH_PEPPER: "x".repeat(40),
    DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        let params = [];
        return {
          bind(...values) { params = values; return this; },
          async first() { return statement.get(...params); },
          async all() { return { results: statement.all(...params) }; },
          async run() {
            const result = statement.run(...params);
            return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
          }
        };
      },
      async batch(statements) {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec("COMMIT");
          return results;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    },
    FILES: { async put() {}, async delete(key) { deleted.push(key); } }
  };
  db.exec(`
    INSERT INTO departments(id,name) VALUES(2,'甲院'),(3,'乙院');
    INSERT INTO grades(id,college_id,name) VALUES(2,2,'甲年级'),(3,3,'乙年级');
    INSERT INTO majors(id,college_id,grade_id,name) VALUES(2,2,2,'甲专业'),(3,3,3,'乙专业');
    INSERT INTO classes(id,major_id,name) VALUES(2,2,'甲一班'),(3,3,'乙一班');
    INSERT INTO users(id,username,password_salt,password_verifier,role,department_id,major_id,class_id,grade_id) VALUES
      (1,'admin-test','','','admin',NULL,NULL,NULL,NULL),(8,'staff-test','','','counselor',2,NULL,NULL,2),
      (11,'100011','','','student',2,NULL,2,NULL),(12,'100012','','','student',2,NULL,2,NULL),(13,'100013','','','student',3,NULL,3,NULL);
    INSERT INTO profiles(user_id,name,student_no,grade) VALUES
      (11,'测试甲','100011','2026'),(12,'测试乙','100012','2026'),(13,'测试丙','100013','2026');
  `);
  const call = (kind, payload, user = counselor) => {
    const path = "/api/office/" + kind;
    return officeRoutes(new Request("https://example.test" + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    }), env, path, user);
  };
  let desired;
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{
    message: { content: JSON.stringify({ reply: "请核对", action: desired }) }
  }] }));
  return {
    db, deleted, env, call,
    async plan(action, user = counselor) {
      desired = action;
      return (await call("plan", { question: "处理测试任务" }, user)).json();
    },
    execute: (plan, user) => call("execute", { planId: plan.id, jitToken: plan.jitToken }, user)
  };
}

test("站内信预览确定收件人，确认只发送一次，执行前复核院系", async t => {
  const { db, plan, execute } = setup(t);
  const action = { type: "send_notifications", audience: { grade: "2026" }, title: "材料提醒", content: "请核对材料。\n具体日期另行通知。" };
  const first = (await plan(action)).plan;
  assert.match(first.preview, /测试甲.*测试乙/);
  assert.doesNotMatch(first.preview, /测试丙/);
  assert.ok(first.preview.includes(action.content));
  assert.equal(db.prepare("SELECT count(*) AS n FROM notifications").get().n, 0);
  await assert.rejects(execute(first, admin), { status: 409 });
  db.exec("UPDATE users SET class_id=3 WHERE id=12");
  await assert.rejects(execute(first), { status: 409 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM notifications").get().n, 0);
  db.exec("UPDATE users SET class_id=2 WHERE id=12; UPDATE users SET class_id=2 WHERE id=13");
  assert.equal((await (await execute(first)).json()).count, 2);
  await assert.rejects(execute(first), { status: 409 });
  assert.deepEqual(db.prepare("SELECT student_id FROM notifications ORDER BY id").all().map(row => row.student_id), [11, 12]);
});

test("办公 JIT 授权绑定操作者、操作内容和到期计划", async t => {
  const { db, plan, call } = setup(t);
  const grant = (await plan({ type: "send_notifications", students: [{ student: "100011" }], title: "提醒", content: "请查看材料。" })).plan;
  assert.match(grant.jitToken, /^[a-f0-9]{64}$/);
  await assert.rejects(call("execute", { planId: grant.id }), { status: 403 });
  await assert.rejects(call("execute", { planId: grant.id, jitToken: "0".repeat(64) }), { status: 403 });
  const original = db.prepare("SELECT payload_json FROM office_plans WHERE id=?").get(grant.id).payload_json;
  db.prepare("UPDATE office_plans SET payload_json=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(original), content: "已被改写" }), grant.id);
  await assert.rejects(call("execute", { planId: grant.id, jitToken: grant.jitToken }), { status: 403 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM notifications").get().n, 0);
  db.prepare("UPDATE office_plans SET payload_json=? WHERE id=?").run(original, grant.id);
  assert.equal((await (await call("execute", { planId: grant.id, jitToken: grant.jitToken })).json()).count, 1);
  await assert.rejects(call("execute", { planId: grant.id, jitToken: grant.jitToken }), { status: 409 });
});

test("回收站保留材料，跨院系名单整批拒绝", async t => {
  const { db, deleted, plan, execute } = setup(t);
  db.exec("INSERT INTO checks(student_id,material_id,r2_key,filename) SELECT 11,id,'checks/test/a.docx','a.docx' FROM materials LIMIT 1");
  const rejected = await plan({ type: "delete_students", students: [{ student: "100011" }, { student: "100013" }] });
  assert.equal(rejected.plan, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM office_plans").get().n, 0);
  const accepted = (await plan({ type: "delete_students", students: [{ student: "测试甲" }, { student: "100012" }] })).plan;
  assert.match(accepted.preview, /回收站/);
  assert.match(accepted.preview, /100011.*100012/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM profiles").get().n, 3);
  assert.equal((await (await execute(accepted)).json()).count, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM profiles").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM checks").get().n, 1);
  assert.deepEqual(db.prepare("SELECT username FROM users WHERE deleted_at IS NOT NULL ORDER BY id").all().map(row => row.username), ["100011", "100012"]);
  assert.equal(db.prepare("SELECT targets FROM operation_logs WHERE action='archive_student'").get().targets, "11,12");
  assert.deepEqual(deleted, []);
});

test("管理员新增学院和生成邀请码，辅导员仅能查询本专业学生", async t => {
  const { db, plan, execute } = setup(t);
  const listing = await plan({ type: "list_students" });
  assert.match(listing.answer, /测试甲.*申请入党/);
  assert.doesNotMatch(listing.answer, /测试丙/);
  assert.equal(listing.plan, null);
  assert.equal((await plan({ type: "create_department", name: "新学院" })).plan, null);
  const college = (await plan({ type: "create_department", name: "新学院" }, admin)).plan;
  await execute(college, admin);
  const { id: collegeId } = db.prepare("SELECT id FROM departments WHERE name='新学院'").get();
  const grade = (await plan({ type: "create_grade", collegeId, name: "新年级" }, admin)).plan;
  await execute(grade, admin);
  const { id: gradeId } = db.prepare("SELECT id FROM grades WHERE name='新年级'").get();
  const major = (await plan({ type: "create_major", gradeId, name: "新专业" }, admin)).plan;
  await execute(major, admin);
  const { id: majorId } = db.prepare("SELECT id FROM majors WHERE name='新专业'").get();
  const invites = (await plan({ type: "create_invites", gradeId, count: 2 }, admin)).plan;
  const output = await (await execute(invites, admin)).json();
  assert.equal(output.count, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM invites WHERE grade_id=? AND role='counselor'").get(gradeId).n, 2);
});

test("对话确认后推进培养阶段、审阅最新材料并通知学生", async t => {
  const { db, plan, execute } = setup(t);
  const next = (await plan({ type: "advance_students", students: [{ student: "100011" }] })).plan;
  assert.match(next.preview, /申请入党 → 积极分子/);
  await execute(next);
  assert.equal(db.prepare("SELECT current_stage_slug FROM profiles WHERE user_id=11").get().current_stage_slug, "activist");
  const material = db.prepare("SELECT id,name FROM materials LIMIT 1").get();
  db.prepare("INSERT INTO checks(student_id,material_id,r2_key,filename,monitor_approved) VALUES(11,?,'checks/old.docx','旧版.docx',1)").run(material.id);
  const reviewAction = { type: "review_materials", rows: [{ student: "100011", materialName: material.name }], status: "已通过" };
  const first = (await plan(reviewAction)).plan;
  db.prepare("INSERT INTO checks(student_id,material_id,r2_key,filename,monitor_approved) VALUES(11,?,'checks/new.docx','新版.docx',1)").run(material.id);
  await assert.rejects(execute(first), { status: 409 });
  const pending = await plan({ type: "list_submissions", pendingOnly: true });
  assert.match(pending.answer, /新版\.docx/);
  assert.doesNotMatch(pending.answer, /旧版\.docx/);
  const latest = (await plan(reviewAction)).plan;
  assert.match(latest.preview, /新版\.docx/);
  await execute(latest);
  assert.equal(db.prepare("SELECT review_status FROM checks ORDER BY id DESC LIMIT 1").get().review_status, "已通过");
  assert.equal(db.prepare("SELECT count(*) AS n FROM notifications WHERE student_id=11").get().n, 2);
});

test("批量名单逐行标记重复、缺项和已存在账号，校验通过后才创建执行计划", async t => {
  const { db, call } = setup(t);
  const bad = await (await call("roster-preview", { classId: 2, rows: [
    { name: "测试甲", studentNo: "100011", line: 4 },
    { name: "", studentNo: "100011" },
    { name: "测试丁", studentNo: "abc" }
  ] })).json();
  assert.equal(bad.plan, null);
  assert.equal(bad.roster.rows[0].line, 4);
  assert.equal(bad.roster.rows[0].issues.length, 2);
  assert.equal(bad.roster.rows[1].issues.length, 3);
  assert.equal(bad.roster.rows[2].issues.length, 1);
  const rows = [{ name: "测试丁", studentNo: "100015" }];
  assert.equal((await (await call("roster-preview", { classId: 3, rows })).json()).plan, null);
  const accepted = await (await call("roster-preview", { classId: 2, rows })).json();
  assert.equal(accepted.plan.type, "register_students");
  assert.equal(db.prepare("SELECT count(*) AS n FROM profiles WHERE student_no='100015'").get().n, 0);
  assert.equal((await (await call("execute", { planId: accepted.plan.id, jitToken: accepted.plan.jitToken })).json()).count, 1);
  assert.equal(db.prepare("SELECT must_change_password FROM users WHERE username='100015'").get().must_change_password, 1);
});

test("材料断线重试只写入一次，并保留上一版本", async t => {
  const { db, env, deleted } = setup(t);
  const path = "/api/checks";
  const user = { id: 11, role: "student", class_id: 2 };
  const material = db.prepare("SELECT id FROM materials LIMIT 1").get().id;
  const send = uploadId => {
    const form = new FormData();
    form.set("uploadId", uploadId);
    form.set("materialId", material);
    form.set("file", new File(["%PDF-1.7"], "scan.pdf", { type: "application/pdf" }));
    return checkRoutes(new Request("https://example.test" + path, { method: "POST", body: form }), env, path, user);
  };
  const first = await (await send("a".repeat(32))).json();
  const duplicate = await (await send("a".repeat(32))).json();
  assert.deepEqual(duplicate, { ok: true, id: first.id, repeated: true });
  const next = await (await send("b".repeat(32))).json();
  assert.notEqual(first.id, next.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM checks WHERE student_id=11").get().n, 2);
  assert.deepEqual(deleted, []);
});

test("无权限的请求也留下记录，查询参数不写入", async t => {
  const { db, env } = setup(t);
  const jobs = [];
  const result = await worker.fetch(new Request("https://example.test/api/admin/recycle?value=secret"), env, { waitUntil: job => jobs.push(job) });
  assert.equal(result.status, 401);
  await Promise.all(jobs);
  const row = db.prepare("SELECT action,method,status,actor_id FROM operation_logs").get();
  assert.deepEqual({ ...row }, { action: "/api/admin/recycle", method: "GET", status: 401, actor_id: null });
});

test("辅导员只能恢复自己专业的学生，恢复结果与访问审计可查询", async t => {
  const { db, env } = setup(t);
  const token = "a".repeat(64);
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,8,'2099-01-01T00:00:00Z')")
    .run(createHash("sha256").update(token).digest("hex"));
  db.exec("UPDATE users SET deleted_at=CURRENT_TIMESTAMP WHERE id IN (11,13)");
  const call = async (endpoint, body) => {
    const jobs = [];
    const response = await worker.fetch(new Request("https://example.test/api/admin/" + endpoint, {
      method: body ? "POST" : "GET",
      headers: { cookie: "session=" + token, origin: "https://example.test", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    }), env, { waitUntil: job => jobs.push(job) });
    await Promise.all(jobs);
    return response;
  };
  const listed = await (await call("recycle")).json();
  assert.deepEqual(listed.accounts.map(account => account.id), [11]);
  assert.equal((await call("recycle/restore", { userId: 13 })).status, 404);
  assert.equal((await call("recycle/restore", { userId: 11 })).status, 200);
  assert.equal(db.prepare("SELECT deleted_at FROM users WHERE id=11").get().deleted_at, null);
  const logs = await (await call("operation-logs")).json();
  assert.ok(logs.logs.some(row => row.action === "restore_account" && row.targets === "11"));
  assert.ok(logs.logs.some(row => row.action === "/api/admin/recycle/restore" && row.status === 404));
});
