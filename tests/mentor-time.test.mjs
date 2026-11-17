import test from "node:test";
import assert from "node:assert/strict";
import { isCurrentTimeQuestion, getCurrentTime } from "../mentor-time.js";
import { mentorRoutes } from "../worker.js";

test("当前时间问法命中专用路由，流程时限问题不误判", () => {
  for (const question of ["现在几点？", "今天几号", "现在是什么时间？", "今天星期几？", "北京时间是多少", "现在是几月几日？", "此刻的时间", "今年是哪一年？"]) assert.equal(isCurrentTimeQuestion(question), true, question);
  for (const question of ["我现在处于哪个阶段？", "首次谈话的时间要求是什么？", "今天要交哪些材料？"]) assert.equal(isCurrentTimeQuestion(question), false, question);
  assert.equal(getCurrentTime(new Date("2026-11-17T04:34:56Z")), "现在北京时间是 2026 年 11 月 17 日 星期二 12:34:56。");
});

test("提问当前时间不调用检索或 DeepSeek", async () => {
  const student = { id: 7, role: "student", current_stage_slug: "application" };
  const env = { DEEPSEEK_API_KEY: "test-key", DB: { prepare() { return { bind() { return this; }, async run() { return { meta: { changes: 1 } }; } }; } } };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("不应调用 DeepSeek"); };
  try {
    const request = new Request("https://example.test/api/mentor/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "现在几点？" }) });
    const result = await (await mentorRoutes(request, env, "/api/mentor/chat", student)).json();
    assert.equal(result.route, "current_time");
    assert.match(result.answer, /北京时间/);
    assert.deepEqual(result.sources, []);
  } finally { globalThis.fetch = oldFetch; }
});
