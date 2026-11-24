import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = process.argv[2];
const target = resolve(process.argv[3] || process.env.DATABASE_PATH || "data/joinccp.sqlite");
if (!source) throw new Error("用法：node server/import-d1.mjs <D1 导出 SQL> [数据库路径]");
if (existsSync(target)) {
  const backup = target + ".before-import-" + new Date().toISOString().replaceAll(":", "-");
  copyFileSync(target, backup);
  console.log("已备份现有数据库：" + backup);
}
mkdirSync(dirname(target), { recursive: true });
const temporary = target + ".importing";
rmSync(temporary, { force: true });
const db = new DatabaseSync(temporary);
try {
  const sql = readFileSync(resolve(source), "utf8")
    .replace(/^PRAGMA writable_schema=(?:ON|OFF);\r?\n/gm, "")
    .replace(/^CREATE TABLE IF NOT EXISTS sqlite_sequence\(name,seq\);\r?\n/gm, "");
  db.exec(sql);
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  if (integrity !== "ok") throw new Error("导入后的数据库完整性检查失败：" + integrity);
  const counts = db.prepare("SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM checks) AS checks").get();
  db.close();
  renameSync(temporary, target);
  console.log(`D1 导入完成：${counts.users} 个账号，${counts.checks} 份提交记录`);
} catch (error) {
  try { db.close(); } catch {}
  throw error;
}
