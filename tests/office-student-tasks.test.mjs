import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { officeRoutes } from "../worker.js";

const counselor = { id: 8, role: "counselor", major_id: 2 };
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
    DEEPSEEK_API_KEY: "test",
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
    FILES: { async delete(key) { deleted.push(key); } }
  };
  db.exec(`
    INSERT INTO departments(id,name) VALUES(2,'甲院'),(3,'乙院');
    INSERT INTO majors(id,college_id,name) VALUES(2,2,'甲专业'),(3,3,'乙专业');
    INSERT INTO classes(id,major_id,name) VALUES(2,2,'甲一班'),(3,3,'乙一班');
    INSERT INTO users(id,username,password_salt,password_verifier,role,department_id,major_id,class_id) VALUES
      (1,'admin-test','','','admin',NULL,NULL,NULL),(8,'staff-test','','','counselor',2,2,NULL),
      (11,'100011','','','student',2,NULL,2),(12,'100012','','','student',2,NULL,2),(13,'100013','','','student',3,NULL,3);
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
    db, deleted,
    async plan(action, user = counselor) {
      desired = action;
      return (await call("plan", { question: "处理测试任务" }, user)).json();
    },
    execute: (plan, user) => call("execute", { planId: plan.id }, user)
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

test("删除只处理已预览的名单，跨院系名单整批拒绝，并清理关联材料", async t => {
  const { db, deleted, plan, execute } = setup(t);
  db.exec("INSERT INTO checks(student_id,material_id,r2_key,filename) SELECT 11,id,'checks/test/a.docx','a.docx' FROM materials LIMIT 1");
  const rejected = await plan({ type: "delete_students", students: [{ student: "100011" }, { student: "100013" }] });
  assert.equal(rejected.plan, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM office_plans").get().n, 0);
  const accepted = (await plan({ type: "delete_students", students: [{ student: "测试甲" }, { student: "100012" }] })).plan;
  assert.match(accepted.preview, /无法恢复/);
  assert.match(accepted.preview, /100011.*100012/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM profiles").get().n, 3);
  assert.equal((await (await execute(accepted)).json()).count, 2);
  assert.deepEqual(db.prepare("SELECT student_no FROM profiles").all().map(row => row.student_no), ["100013"]);
  assert.deepEqual(deleted, ["checks/test/a.docx"]);
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
  const major = (await plan({ type: "create_major", collegeId, name: "新专业" }, admin)).plan;
  await execute(major, admin);
  const { id: majorId } = db.prepare("SELECT id FROM majors WHERE name='新专业'").get();
  const invites = (await plan({ type: "create_invites", majorId, count: 2 }, admin)).plan;
  const output = await (await execute(invites, admin)).json();
  assert.equal(output.count, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM invites WHERE major_id=? AND role='counselor'").get(majorId).n, 2);
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
