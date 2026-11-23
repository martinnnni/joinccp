import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = resolve(process.env.DATA_DIR || join(root, "data"));
const databasePath = resolve(process.env.DATABASE_PATH || join(dataDirectory, "joinccp.sqlite"));
const filesDirectory = resolve(process.env.FILES_DIR || join(dataDirectory, "files"));
const assetsDirectory = resolve(process.env.ASSETS_DIR || join(root, "public"));

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".ttf": "font/ttf",
  ".gz": "application/gzip"
};

function resolveInside(base, relative) {
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("路径无效");
  return target;
}
class BoundStatement {
  constructor(database, sql, parameters = []) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new BoundStatement(this.database, this.sql, parameters);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.parameters) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.parameters) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.parameters);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
}

class D1Database {
  constructor(path) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  }

  prepare(sql) {
    return new BoundStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

class FileBucket {
  constructor(directory) {
    this.directory = directory;
  }

  path(key) {
    const normalized = String(key).replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalized || normalized.split("/").some(part => !part || part === "." || part === "..")) throw new Error("文件键无效");
    return resolveInside(this.directory, normalized);
  }

  async put(key, value) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = target + ".tmp-" + crypto.randomUUID();
    await writeFile(temporary, new Uint8Array(value));
    await rename(temporary, target);
  }

  async get(key) {
    try {
      return { body: await readFile(this.path(key)) };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key) {
    await rm(this.path(key), { force: true });
  }
}

class StaticAssets {
  constructor(directory) {
    this.directory = directory;
  }

  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (!relative || relative === "_headers" || relative.includes("\0")) return new Response("Not found", { status: 404 });
    let target;
    try { target = resolveInside(this.directory, relative); }
    catch { return new Response("Not found", { status: 404 }); }
    try {
      const contents = await readFile(target);
      return new Response(contents, { headers: {
        "content-type": mimeTypes[extname(target).toLowerCase()] || "application/octet-stream",
        "cache-control": relative === "index.html" ? "no-cache" : "public, max-age=3600"
      } });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EISDIR") return new Response("Not found", { status: 404 });
      throw error;
    }
  }
}

export function applyMigrations(database, migrationsDirectory = join(root, "migrations")) {
  database.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const applied = new Set(database.prepare("SELECT name FROM d1_migrations").all().map(row => row.name));
  const migrations = readdirSync(migrationsDirectory).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of migrations) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(migrationsDirectory, name), "utf8");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`迁移 ${name} 失败`, { cause: error });
    }
  }
}

export function createRuntime() {
  mkdirSyncSafe(dataDirectory);
  mkdirSyncSafe(filesDirectory);
  const db = new D1Database(databasePath);
  applyMigrations(db.database);
  const env = {
    DB: db,
    FILES: new FileBucket(filesDirectory),
    ASSETS: new StaticAssets(assetsDirectory),
    AUTH_PEPPER: process.env.AUTH_PEPPER || "",
    BOOTSTRAP_TOKEN: process.env.BOOTSTRAP_TOKEN || "",
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "",
    RAG_MIN_SIMILARITY: process.env.RAG_MIN_SIMILARITY || "0.32",
    INTENT_MODEL: process.env.INTENT_MODEL || "deepseek-flash"
  };
  return { env, db, paths: { root, dataDirectory, databasePath, filesDirectory, assetsDirectory } };
}

function mkdirSyncSafe(directory) {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
}

