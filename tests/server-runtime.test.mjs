import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Node 服务器运行时兼容 D1、R2 与静态资源接口", async t => {
  const temporary = mkdtempSync(join(tmpdir(), "joinccp-runtime-"));
  process.env.DATA_DIR = join(temporary, "data");
  process.env.ASSETS_DIR = join(temporary, "assets");
  process.env.AUTH_PEPPER = "x".repeat(40);
  process.env.BOOTSTRAP_TOKEN = "bootstrap";
  t.after(() => {
    delete process.env.DATA_DIR;
    delete process.env.ASSETS_DIR;
    delete process.env.AUTH_PEPPER;
    delete process.env.BOOTSTRAP_TOKEN;
  });
  writeFileSync(join(temporary, "placeholder"), "");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(process.env.ASSETS_DIR, { recursive: true });
  writeFileSync(join(process.env.ASSETS_DIR, "index.html"), "<h1>test</h1>");

  const { createRuntime } = await import("../server/runtime.mjs?test=" + Date.now());
  const { env, db, paths } = createRuntime();
  t.after(() => {
    db.close();
    rmSync(temporary, { recursive: true, force: true });
  });
  assert.ok((await env.DB.prepare("SELECT COUNT(*) AS count FROM stages").first()).count > 0);
  const inserted = await env.DB.prepare("INSERT INTO departments(name) VALUES(?)").bind("运行时测试学院").run();
  assert.ok(inserted.meta.last_row_id > 0);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO departments(name) VALUES(?)").bind("批次学院一"),
    env.DB.prepare("INSERT INTO departments(name) VALUES(?)").bind("批次学院二")
  ]);
  await env.FILES.put("checks/1/test.pdf", new TextEncoder().encode("%PDF-1.7").buffer);
  assert.equal(new TextDecoder().decode((await env.FILES.get("checks/1/test.pdf")).body), "%PDF-1.7");
  await env.FILES.delete("checks/1/test.pdf");
  assert.equal(await env.FILES.get("checks/1/test.pdf"), null);
  assert.equal((await env.ASSETS.fetch(new Request("http://localhost/"))).status, 200);
  assert.equal((await env.ASSETS.fetch(new Request("http://localhost/../secret"))).status, 404);
  assert.ok(readFileSync(paths.databasePath).length > 0);
});
