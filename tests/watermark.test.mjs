import test from "node:test";
import assert from "node:assert/strict";
import { watermarkIdentity, watermarkUserId } from "../watermark.js";

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
