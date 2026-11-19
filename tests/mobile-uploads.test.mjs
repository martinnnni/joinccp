import test from "node:test";
import assert from "node:assert/strict";
import { normalizedAttachment } from "../upload-types.js";
import { checkRoutes, officeRoutes } from "../worker.js";

const pdf = new File(["%PDF-1.7"], "材料.pdf", { type: "application/pdf" });
const heic = new File([Buffer.from("00000018667479706865696300000000", "hex")], "IMG_1234", { type: "image/heic" });
const student = { id: 7, role: "student", department_id: 2 };
const staff = { id: 8, role: "counselor", department_id: 2 };
const request = (path, body) => new Request("https://example.test" + path, { method: "POST", body });

function fixture(plan) {
  const saved = [];
  return {
    saved,
    env: {
      DB: {
        prepare(sql) {
          return {
            bind() { return this; },
            async first() {
              if (sql.includes("FROM office_plans")) return {
                status: "pending", expires_at: "2999-01-01T00:00:00.000Z", payload_json: JSON.stringify(plan)
              };
              return { id: 7, department_id: 2 };
            },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 1, last_row_id: 12 } }; }
          };
        },
        async batch() {}
      },
      FILES: {
        async put(key, body, options) {
          assert.ok(body instanceof ArrayBuffer);
          saved.push({ key, body, mime: options.httpMetadata.contentType });
        },
        async delete() {}
      }
    }
  };
}

test("办公助理确认后用已知长度保存 PDF 和手机 HEIC，保留其类型", async () => {
  const photo = normalizedAttachment(heic, true);
  assert.equal(photo.name, "IMG_1234.heic");
  const { env, saved } = fixture({ type: "upload_student_files", rows: [pdf, photo].map(file => ({
    filename: file.name, studentId: 7, materialId: 4
  })) });
  const form = new FormData();
  form.set("planId", "a".repeat(32));
  for (const file of [pdf, photo]) form.append("file", file);
  const path = "/api/office/execute";
  const response = await officeRoutes(request(path, form), env, path, staff);
  assert.equal((await response.json()).count, 2);
  assert.deepEqual(saved.map(item => item.mime), ["application/pdf", "image/heic"]);
  assert.match(saved[1].key, /\.heic$/);
  assert.deepEqual(saved[0].body, await pdf.arrayBuffer());
});

test("学生可以提交 PDF，伪装成图片的内容不能写入存储", async () => {
  const { env, saved } = fixture();
  const path = "/api/checks";
  const form = new FormData();
  form.set("materialId", "4");
  form.set("file", pdf);
  assert.equal((await checkRoutes(request(path, form), env, path, student)).status, 201);
  form.set("file", new File(["not a PNG"], "伪装.png", { type: "image/png" }));
  await assert.rejects(checkRoutes(request(path, form), env, path, student), { status: 400 });
  assert.deepEqual(saved.map(item => item.mime), ["application/pdf"]);
});
