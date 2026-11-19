import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mentorRoutes } from "../worker.js";

const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const ip = "1.2.3.4";
const ipKey = "ip:" + createHash("sha256").update("ip:" + ip).digest("hex");
const device = "aaaabbbbccccddddeeeeffff00001111";

function guestRequest(question) {
  return new Request("https://example.test/api/mentor/chat", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "device=" + device, "CF-Connecting-IP": ip },
    body: JSON.stringify({ question })
  });
}

function guestDB(initialState = {}) {
  const state = new Map(Object.entries(initialState));
  const calls = { firsts: [], batches: [] };
  function statement(sql) {
    const stmt = {
      _args: [],
      bind(...args) { stmt._args = args; return stmt; },
      async first() { calls.firsts.push({ sql, args: [...stmt._args] }); return state.get(stmt._args[0]) ?? null; },
      async run() { return { meta: { changes: 1 } }; }
    };
    return stmt;
  }
  return {
    calls,
    DB: {
      prepare(sql) { return statement(sql); },
      async batch(stmts) { calls.batches.push(stmts.map(s => [...s._args])); return []; }
    }
  };
}

test("访客提问同时按设备与来源 IP 记录额度", async () => {
  const db = guestDB();
  const env = { DEEPSEEK_API_KEY: "test-key", DB: db.DB };
  const res = await mentorRoutes(guestRequest("who am i"), env, "/api/mentor/chat", null);
  assert.equal(res.status, 200);
  assert.equal(db.calls.batches.length, 1);
  assert.equal(db.calls.batches[0].length, 2); // 设备 + IP 两条记录
});

test("清除 Cookie 换新设备标识后仍受来源 IP 封顶限制", async () => {
  const db = guestDB({ [ipKey]: { count: 60, day: today } });
  const env = { DEEPSEEK_API_KEY: "test-key", DB: db.DB };
  const res = await mentorRoutes(guestRequest("who am i"), env, "/api/mentor/chat", null);
  assert.equal(res.status, 429);
  assert.equal(db.calls.batches.length, 0); // 未放行，不累计
  assert.equal((await res.json()).limitExceeded, true);
});

test("设备自身达到单日上限时同样拒绝", async () => {
  const db = guestDB({ [device]: { count: 20, day: today } });
  const env = { DEEPSEEK_API_KEY: "test-key", DB: db.DB };
  const res = await mentorRoutes(guestRequest("who am i"), env, "/api/mentor/chat", null);
  assert.equal(res.status, 429);
  assert.equal(db.calls.batches.length, 0);
});
