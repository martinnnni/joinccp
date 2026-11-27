import test from "node:test";
import assert from "node:assert/strict";
import { watermarkIdentity, watermarkUserId } from "../watermark.js";
import worker from "../worker.js";

test("watermark signatures bind account ID and key without exposing the key", async () => {
  const key = "watermark-test-secret-at-least-32-characters";
  const a = await watermarkIdentity({ id: 123, name: "测试学生", major_name: "信息与计算科学" }, key);
  assert.equal(watermarkUserId(a.code), 123);
  assert.equal(a.major, "信息与计算科学");
  assert.equal(a.name, "测试学生");
  assert.equal(a.code, (await watermarkIdentity({ id: 123 }, key)).code);
  assert.notEqual(a.code, (await watermarkIdentity({ id: 124 }, key)).code);
  assert.notEqual(a.code, (await watermarkIdentity({ id: 123 }, key + "changed")).code);
  assert.equal(watermarkUserId("invalid"), null);
  await assert.rejects(watermarkIdentity({ id: 123 }, "short"));
});

test("only administrators can verify a signed watermark; forgery is rejected", async () => {
  const secret = "watermark-test-secret-at-least-32-characters";
  const target = { id: 123, name: "测试学生", username: "250240076", major_name: "信息与计算科学" };
  const identity = await watermarkIdentity(target, secret);
  for (const role of ["student", "counselor", "admin"]) {
    let lookups = 0;
    const env = { AUTH_PEPPER: secret, DB: { prepare(sql) { return { bind() { return this; }, async first() {
      if (sql.includes("FROM sessions")) return { id: 1, role };
      lookups++; return target;
    } }; } } };
    const request = code => new Request("https://example.test/api/admin/watermark/lookup", { method: "POST", headers: { origin: "https://example.test", cookie: "session=" + "a".repeat(64), "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const response = await worker.fetch(request(identity.code), env);
    assert.equal(response.status, role === "admin" ? 200 : 403);
    assert.equal(lookups, role === "admin" ? 1 : 0);
    if (role === "admin") {
      assert.equal((await response.json()).identity.name, target.name);
      const fake = await worker.fetch(request(identity.code.slice(0, -1) + (identity.code.endsWith("0") ? "1" : "0")), env);
      assert.equal(fake.status, 400);
    }
  }
});
