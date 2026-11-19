import test from "node:test";
import assert from "node:assert/strict";
import worker, { adminRoutes, checkRoutes, formRoutes } from "../worker.js";

const student = { id: 7, role: "student", department_id: 2, class_id: 2 };
const counselor = { id: 8, role: "counselor", department_id: 2, major_id: 2 };
const foreignForm = { department_id: 3, filename: "表格.pdf", r2_key: "forms/3/sample.pdf" };

function fakeEnv({ form = foreignForm, studentDepartment = 3 } = {}) {
  let r2Reads = 0;
  const env = {
    DB: { prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() {
          if (sql.includes("FROM form_templates WHERE id=")) return form;
          if (sql.includes("FROM stages WHERE slug=")) return { slug: args[0] };
          if (sql.includes("FROM users u JOIN profiles")) return { id: args[0], class_id: 2, major_id: studentDepartment, name: "测试学生" };
          if (sql.includes("FROM users u LEFT JOIN classes")) return { major_id: studentDepartment };
          return null;
        },
        async all() {
          if (sql.includes("FROM stages")) return { results: [{ slug: "application", name: "申请入党", position: 1 }] };
          if (sql.includes("FROM form_templates")) {
            const all = [{ id: 1, department_id: null }, { id: 2, department_id: 2 }, { id: 3, department_id: 3 }];
            return { results: sql.includes("WHERE department_id IS NULL") ? all.filter(row => row.department_id === null || row.department_id === args[0]) : all };
          }
          if (sql.includes("FROM checks")) return { results: [{ id: 11, filename: "申请书.docx" }] };
          return { results: [] };
        },
        async run() { return { meta: { last_row_id: 9, changes: 1 } }; }
      };
    } },
    FILES: {
      async get() { r2Reads++; return { body: new Response("file bytes").body }; },
      async put() {}, async delete() {}
    }
  };
  return { env, reads: () => r2Reads };
}

test("表格 API 未登录时拒绝访问", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/forms"), fakeEnv().env);
  assert.equal(response.status, 401);
});

test("学生仅看到本院系和通用表格，且不能上传", async () => {
  const { env } = fakeEnv();
  const response = await formRoutes(new Request("https://example.test/api/forms"), env, "/api/forms", student);
  assert.deepEqual((await response.json()).forms.map(row => row.id), [1, 2]);
  await assert.rejects(formRoutes(new Request("https://example.test/api/forms", { method: "POST" }), env, "/api/forms", student), { status: 403 });
});

test("跨院系表格下载被拒绝，R2 不会被读取", async () => {
  const { env, reads } = fakeEnv();
  await assert.rejects(formRoutes(new Request("https://example.test/api/forms/3/file"), env, "/api/forms/3/file", student), { status: 403 });
  assert.equal(reads(), 0);
});

test("本院系表格经鉴权后以附件返回", async () => {
  const { env, reads } = fakeEnv({ form: { ...foreignForm, department_id: 2 } });
  const response = await formRoutes(new Request("https://example.test/api/forms/3/file"), env, "/api/forms/3/file", counselor);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await response.text(), "file bytes");
  assert.equal(reads(), 1);
});

test("学生文件列表只向所属院系辅导员开放", async () => {
  const { env } = fakeEnv({ studentDepartment: 3 });
  const path = "/api/admin/students/7/files";
  await assert.rejects(adminRoutes(new Request("https://example.test" + path), env, path, counselor), { status: 403 });
  const own = fakeEnv({ studentDepartment: 2 });
  const response = await adminRoutes(new Request("https://example.test" + path), own.env, path, counselor);
  assert.equal((await response.json()).files[0].filename, "申请书.docx");
});

test("学生提交 DOCX 后材料状态写为已交", async () => {
  let uploaded = false;
  let savedRecord = false;
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          sql, params: [],
          bind(...params) { this.params = params; return this; },
          async first() { return { id: 4 }; },
          async all() { return { results: [] }; },
          async run() { return { meta: { last_row_id: 12 } }; }
        };
        return statement;
      },
      async batch(statements) {
        savedRecord = statements.some(item => item.sql.includes("INSERT INTO material_records") && item.params[0] === student.id && item.params[1] === 4);
      }
    },
    FILES: { async put() { uploaded = true; }, async delete() {} }
  };
  const form = new FormData();
  form.set("materialId", "4");
  form.set("docx", new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])], "申请书.docx"));
  form.set("results", "[]");
  const request = new Request("https://example.test/api/checks", { method: "POST", body: form });
  const response = await checkRoutes(request, env, "/api/checks", student);
  assert.equal(response.status, 201);
  assert.equal(uploaded, true);
  assert.equal(savedRecord, true);
});
