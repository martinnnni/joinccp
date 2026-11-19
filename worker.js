import { retrieve, publicSources, modelMessages, advisoryMessages, reviewStandards, knowledgeCount } from "./rag.js";
import { mentorConfig } from "./mentor-config.js";
import { classifyIntent, decideMentorRoute, chitchatMessages, isIdentityQuestion } from "./mentor-routing.js";
import { isPersonalQuestion, isSiteHelpQuestion, personalMatches, isSelfIdentityQuestion, isChineseQuestion, isPartyDomainQuestion } from "./mentor-personal.js";
import { identifyMessages, parseIdentification, reviewMessages, parseReview, formatReview } from "./mentor-review.js";
import { isCurrentTimeQuestion, getCurrentTime } from "./mentor-time.js";
import { officeMessages, parseOfficePlan } from "./office-agent.js";

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
});
const clean = (value, limit = 200) => String(value ?? "").trim().slice(0, limit);
const iso = () => new Date().toISOString();
const randomHex = (length = 32) => Array.from(crypto.getRandomValues(new Uint8Array(length)), n => n.toString(16).padStart(2, "0")).join("");
const hex = buffer => Array.from(new Uint8Array(buffer), n => n.toString(16).padStart(2, "0")).join("");
const sha256 = async value => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
class HttpError extends Error {
  constructor(status, message, code = null) { super(message); this.status = status; this.code = code; }
}
function assert(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}
const MENTOR_CODES = {
  "M-100": "成长导师尚未启用（未配置 AI API Key）",
  "M-101": "AI API Key 无效或已失效",
  "M-102": "AI 额度或余额不足（token 不足）",
  "M-103": "请求过于频繁，已触发限流",
  "M-104": "AI 服务响应超时",
  "M-105": "AI 服务暂时不可用",
  "M-106": "AI 返回内容无效",
};
function mentorFailure(code, status = 503) {
  return new HttpError(status, MENTOR_CODES[code] || "AI 服务异常", code);
}
function id(value) {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number > 0, "无效编号");
  return number;
}
function selectedIds(value, limit = 20) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= limit, "请选择 1 至 " + limit + " 条记录");
  const ids = value.map(id);
  assert(new Set(ids).size === ids.length, "选择中有重复记录");
  return ids;
}
function validName(value) { return /^[a-zA-Z0-9_.-]{3,40}$/.test(value); }
function validHex(value, length) { return new RegExp("^[a-f0-9]{" + length + "}$").test(value); }
function sessionCookie(request) { return /(?:^|; )session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") || "")?.[1] || ""; }
const GUEST_DAILY_LIMIT = 20;
const GUEST_IP_DAILY_LIMIT = 60;
const beijingDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
function deviceCookie(request) { return /(?:^|; )device=([a-f0-9]{32})(?:;|$)/.exec(request.headers.get("cookie") || "")?.[1] || ""; }
async function currentUser(request, env) {
  const token = sessionCookie(request);
  if (!token) return null;
  return env.DB.prepare("SELECT u.id,u.username,u.role,u.department_id,u.must_change_password,COALESCE(NULLIF(u.name,''),p.name) AS name,p.student_no,p.major,p.grade,p.phone,p.applied_at,p.current_stage_slug,p.current_node_slug,p.node_entered_at,p.is_graduate FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN profiles p ON p.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?")
    .bind(await sha256(token), iso()).first();
}
const bodyJson = request => request.json().catch(() => ({}));
const isStaff = user => user?.role === "admin" || user?.role === "counselor";
async function canReadStudent(env, user, studentId) {
  if (user.role === "admin") return true;
  if (user.role === "student") return user.id === studentId;
  const student = await env.DB.prepare("SELECT department_id FROM users WHERE id=? AND role='student'").bind(studentId).first();
  return !!student && student.department_id === user.department_id;
}
async function targetStudent(env, user, studentId) {
  const student = await env.DB.prepare("SELECT u.id,u.department_id,p.* FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=?").bind(id(studentId)).first();
  assert(student, "学生不存在", 404);
  assert(await canReadStudent(env, user, student.id), "无权访问此学生资料", 403);
  return student;
}
function secured(response) {
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
function requireSecret(env) { assert(env.AUTH_PEPPER?.length >= 32, "服务器未配置认证密钥", 503); }
async function loginLimit(env, request, username, increment = false) {
  const ip = clean(request.headers.get("CF-Connecting-IP") || "local", 80);
  const key = await sha256(ip + ":" + username.toLowerCase());
  const row = await env.DB.prepare("SELECT count,reset_at FROM login_attempts WHERE key=?").bind(key).first();
  const count = row && row.reset_at > iso() ? row.count : 0;
  assert(count < 8, "尝试过多，请 15 分钟后再试", 429);
  if (increment) await env.DB.prepare("INSERT INTO login_attempts(key,count,reset_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,reset_at=excluded.reset_at")
    .bind(key, count + 1, count ? row.reset_at : new Date(Date.now() + 900000).toISOString()).run();
  return key;
}
async function startSession(env, userId) {
  const token = randomHex();
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(await sha256(token), userId, new Date(Date.now() + 7 * 86400000).toISOString()).run();
  return "session=" + token + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800";
}
async function authRoutes(request, env, path) {
  if (path === "/api/config" && request.method === "GET") {
    const count = await env.DB.prepare("SELECT count(*) AS n FROM users").first();
    const departments = await env.DB.prepare("SELECT id,name FROM departments ORDER BY name").all();
    const headers = deviceCookie(request) ? {} : { "set-cookie": "device=" + randomHex(16) + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000" };
    return json({ ok: true, initialized: count.n > 0, departments: departments.results, aiEnabled: !!env.DEEPSEEK_API_KEY }, 200, headers);
  }
  if (path === "/api/auth/challenge" && request.method === "GET") {
    requireSecret(env);
    const username = clean(new URL(request.url).searchParams.get("username"), 40);
    assert(validName(username), "请输入有效用户名");
    await loginLimit(env, request, username);
    const row = await env.DB.prepare("SELECT password_salt FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
    const salt = row?.password_salt || (await hmac(env.AUTH_PEPPER, "salt:" + username.toLowerCase())).slice(0, 32);
    return json({ ok: true, salt, iterations: 210000 });
  }
  if (path === "/api/bootstrap" && request.method === "POST") {
    requireSecret(env);
    assert(env.BOOTSTRAP_TOKEN?.length >= 24, "未配置初始化令牌", 503);
    const data = await bodyJson(request);
    assert(equal(clean(data.bootstrapToken, 200), env.BOOTSTRAP_TOKEN), "初始化令牌错误", 403);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM users").first();
    assert(count.n === 0, "管理员已建立", 409);
    const username = clean(data.username, 40);
    assert(validName(username) && validHex(data.salt, 32) && validHex(data.verifier, 64), "账号资料无效");
    const verifier = await hmac(env.AUTH_PEPPER, username.toLowerCase() + ":" + data.verifier);
    const result = await env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role) VALUES(?,?,?,'admin')").bind(username, data.salt, verifier).run();
    return json({ ok: true }, 201, { "set-cookie": await startSession(env, result.meta.last_row_id) });
  }
  if (path === "/api/register" && request.method === "POST") {
    requireSecret(env);
    const data = await bodyJson(request);
    const code = clean(data.inviteCode, 100);
    assert(validHex(data.salt, 32) && validHex(data.verifier, 64) && code.length >= 32, "注册资料无效");
    const invite = await env.DB.prepare("SELECT * FROM invites WHERE code_hash=? AND used_by IS NULL AND expires_at>?")
      .bind(await sha256(code), iso()).first();
    assert(invite, "邀请码无效或已过期", 403);
    assert(invite.role === "counselor", "此邀请码不适用于辅导员注册", 403);
    const name = clean(data.name, 50);
    const username = clean(data.username, 40);
    assert(name, "请填写姓名");
    assert(validName(username), "用户名只能包含字母、数字、点、横线或下划线，长度为 3 至 40 位");
    const verifier = await hmac(env.AUTH_PEPPER, username.toLowerCase() + ":" + data.verifier);
    let userId = null;
    try {
      const result = await env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,name) VALUES(?,?,?,?,?,?)")
        .bind(username, data.salt, verifier, invite.role, invite.department_id, name).run();
      userId = result.meta.last_row_id;
      const updated = await env.DB.prepare("UPDATE invites SET used_by=? WHERE id=? AND used_by IS NULL").bind(userId, invite.id).run();
      assert(updated.meta.changes === 1, "邀请码已被使用", 409);
      return json({ ok: true, username }, 201, { "set-cookie": await startSession(env, userId) });
    } catch (error) {
      if (userId) await env.DB.prepare("DELETE FROM users WHERE id=?").bind(userId).run();
      if (String(error).includes("UNIQUE")) throw new HttpError(409, "用户名已存在");
      throw error;
    }
  }
  if (path === "/api/login" && request.method === "POST") {
    requireSecret(env);
    const data = await bodyJson(request);
    const username = clean(data.username, 40), verifier = clean(data.verifier, 64);
    assert(validName(username) && validHex(verifier, 64), "账号资料无效");
    const limitKey = await loginLimit(env, request, username, true);
    const row = await env.DB.prepare("SELECT id,password_verifier,must_change_password,reset_password FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
    const initialPassword = clean(data.initialPassword, 100);
    const got = row?.must_change_password && !row?.reset_password
      ? await hmac(env.AUTH_PEPPER, "initial:" + username.toLowerCase() + ":" + initialPassword)
      : await hmac(env.AUTH_PEPPER, username.toLowerCase() + ":" + verifier);
    assert(row && equal(row.password_verifier, got), "用户名或密码错误", 401);
    await env.DB.prepare("DELETE FROM login_attempts WHERE key=?").bind(limitKey).run();
    return json({ ok: true }, 200, { "set-cookie": await startSession(env, row.id) });
  }
  if (path === "/api/logout" && request.method === "POST") {
    const token = sessionCookie(request);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": "session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });
  }
  return null;
}

async function changePassword(request, env, user) {
  requireSecret(env);
  const data = await bodyJson(request);
  assert(validHex(data.newVerifier, 64) && validHex(data.newSalt, 32), "密码资料无效");
  const row = await env.DB.prepare("SELECT password_verifier,must_change_password,reset_password FROM users WHERE id=?").bind(user.id).first();
  const old = row?.must_change_password && !row?.reset_password
    ? await hmac(env.AUTH_PEPPER, "initial:" + user.username.toLowerCase() + ":" + clean(data.oldPassword, 100))
    : await hmac(env.AUTH_PEPPER, user.username.toLowerCase() + ":" + data.oldVerifier);
  assert(row && equal(row.password_verifier, old), "当前密码错误", 403);
  if (row.must_change_password && !row.reset_password) {
    assert(clean(data.oldPassword, 100) === "cauc+" + user.username, "初始密码错误", 403);
    assert(clean(data.newPassword, 100) && clean(data.newPassword, 100) !== data.oldPassword, "新密码不能与初始密码相同");
  } else assert(validHex(data.oldVerifier, 64), "密码资料无效");
  const replacement = await hmac(env.AUTH_PEPPER, user.username.toLowerCase() + ":" + data.newVerifier);
  await env.DB.prepare("UPDATE users SET password_salt=?,password_verifier=?,must_change_password=0,reset_password=0 WHERE id=?").bind(data.newSalt, replacement, user.id).run();
  const tokenHash = await sha256(sessionCookie(request));
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").bind(user.id, tokenHash).run();
  return json({ ok: true });
}

async function studentRoutes(request, env, path, user) {
  if (path === "/api/me" && request.method === "GET") return json({ ok: true, user });
  if (path === "/api/profile" && request.method === "GET") {
    assert(user.role === "student", "仅学生可查看个人档案", 403);
    const stage = await env.DB.prepare("SELECT * FROM stages WHERE slug=?").bind(user.current_stage_slug).first();
    const node = await env.DB.prepare("SELECT * FROM nodes WHERE slug=?").bind(user.current_node_slug).first();
    const next = node ? await env.DB.prepare("SELECT * FROM nodes WHERE stage_slug=? AND position>? ORDER BY position LIMIT 1").bind(node.stage_slug, node.position).first() : null;
    const materials = await env.DB.prepare("SELECT m.*,r.status,r.id AS record_id,r.r2_key FROM materials m LEFT JOIN material_records r ON r.material_id=m.id AND r.student_id=? WHERE m.stage_slug=? ORDER BY m.id").bind(user.id, user.current_stage_slug).all();
    const department = await env.DB.prepare("SELECT name FROM departments WHERE id=?").bind(user.department_id).first();
    return json({ ok: true, profile: user, department: department?.name || "", stage, node, next, materials: materials.results });
  }
  if (path === "/api/materials" && request.method === "GET") {
    const materials = await env.DB.prepare("SELECT id,slug,name,stage_slug,category,fill_method FROM materials ORDER BY id").all();
    return json({ ok: true, materials: materials.results });
  }
  if (path === "/api/notifications" && request.method === "GET") {
    assert(user.role === "student", "仅学生可查看通知", 403);
    const items = await env.DB.prepare("SELECT * FROM notifications WHERE student_id=? ORDER BY created_at DESC LIMIT 100").bind(user.id).all();
    return json({ ok: true, notifications: items.results });
  }
  const notificationMatch = /^\/api\/notifications\/(\d+)\/read$/.exec(path);
  if (notificationMatch && request.method === "POST") {
    assert(user.role === "student", "仅学生可操作通知", 403);
    await env.DB.prepare("UPDATE notifications SET is_read=1 WHERE id=? AND student_id=?").bind(id(notificationMatch[1]), user.id).run();
    return json({ ok: true });
  }
  return null;
}

async function deepSeekContent(env, payload) {
  let response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "authorization": "Bearer " + env.DEEPSEEK_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw mentorFailure("M-104");
    throw mentorFailure("M-105");
  }
  if (!response.ok) {
    let bodyError = "";
    try { bodyError = String((await response.json())?.error?.message || "").toLowerCase(); } catch {}
    const status = response.status;
    const code = status === 401 || status === 403 ? "M-101"
      : status === 402 ? "M-102"
        : status === 429 ? (/insufficient|quota|balance|exceed/.test(bodyError) ? "M-102" : "M-103")
          : status === 400 && /context|token|length|too long/i.test(bodyError) ? "M-102"
            : "M-105";
    console.error("DeepSeek request failed", status, bodyError);
    throw mentorFailure(code);
  }
  const data = await response.json().catch(() => ({}));
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw mentorFailure("M-106");
  return content.trim();
}
async function logMentorQuestion(env, user, question, decision) {
  try {
    await env.DB.prepare("INSERT INTO mentor_question_logs(user_id,question,intent,top_similarity,outcome) VALUES(?,?,?,?,?)")
      .bind(user?.id ?? null, question, decision.intent, decision.topSimilarity, decision.outcome).run();
  } catch (error) { console.error("mentor question log failed", error); }
}
async function mentorMatches(env, user, question, previousQuestion) {
  const shared = retrieve(question, { stageSlug: user?.current_stage_slug, previousQuestion });
  if (!user || user.role !== "student" || !isPersonalQuestion(question)) return shared;
  const records = await env.DB.prepare("SELECT m.name,m.stage_slug,s.name AS stage_name,r.status,r.r2_key FROM materials m JOIN stages s ON s.slug=m.stage_slug LEFT JOIN material_records r ON r.material_id=m.id AND r.student_id=? ORDER BY s.position,m.id")
    .bind(user.id).all();
  const node = await env.DB.prepare("SELECT name FROM nodes WHERE slug=?").bind(user.current_node_slug).first();
  return [...personalMatches(question, user, records.results, node?.name || ""), ...shared.slice(0, 2)];
}
export async function mentorRoutes(request, env, path, user) {
  if (!path.startsWith("/api/mentor")) return null;
  if (user && !["student", "counselor", "admin"].includes(user.role)) assert(false, "仅学生、辅导员和管理员可使用成长导师", 403);
  const enabled = !!env.DEEPSEEK_API_KEY;
  if (path === "/api/mentor" && request.method === "GET") {
    return json({ ok: true, enabled, knowledgeCount, message: enabled ? "成长导师已启用" : "知识库检索已就绪，AI 回答等待配置 API Key" });
  }
  if (path === "/api/mentor/review" && request.method === "POST") {
    assert(user, "请先登录", 401);
    assert(user.role === "student", "仅学生可使用文件检查", 403);
    if (!enabled) throw mentorFailure("M-100");
    const data = await bodyJson(request);
    const filename = clean(data.filename, 150);
    const content = String(data.text ?? "").replace(/\0/g, "").trim();
    assert(/\.(docx|pdf)$/i.test(filename), "只支持 Word DOCX 或 PDF 文件");
    assert(content.length >= 20 && content.length <= 20000, "文档可识别文字需在 20 至 20000 字之间");
    const catalog = (await env.DB.prepare("SELECT m.id,m.name,s.name AS stage_name FROM materials m JOIN stages s ON s.slug=m.stage_slug ORDER BY s.position,m.id").all()).results;
    const identification = await deepSeekContent(env, { model: mentorConfig(env).classifierModel,
      messages: identifyMessages(filename, content, catalog), response_format: { type: "json_object" }, reasoning_effort: "none", stream: false, max_tokens: 160 });
    const form = parseIdentification(identification, catalog);
    const standards = reviewStandards(form?.name || "");
    const response = await deepSeekContent(env, { model: "deepseek-flash", messages: reviewMessages(content, form, standards, user),
      response_format: { type: "json_object" }, reasoning_effort: "none", stream: false, max_tokens: 2300, temperature: 0.1 });
    let report;
    try { report = parseReview(response, content, standards.length); }
    catch { throw mentorFailure("M-106"); }
    await logMentorQuestion(env, user, "文件检查：" + filename, { intent: "business", topSimilarity: 1, outcome: "answered" });
    return json({ ok: true, answer: formatReview(filename, form, report), sources: publicSources(standards), route: "document_review", form: form?.name || null });
  }
  if ((path === "/api/mentor/retrieve" || path === "/api/mentor/chat") && request.method === "POST") {
    const data = await bodyJson(request), question = clean(data.question, 500);
    assert(question.length >= 2, "请输入至少两个字的问题");
    if (!user) {
      const ip = clean(request.headers.get("CF-Connecting-IP") || "local", 80);
      let device = deviceCookie(request);
      if (!device) device = await sha256("ip:" + ip);
      // 设备 Cookie 可被用户清除后重新获得，因此额外按来源 IP 封顶，
      // 避免清 Cookie 即重置额度、持续消耗 DeepSeek 额度。
      const ipKey = "ip:" + await sha256("ip:" + ip);
      const today = beijingDay();
      const [deviceRow, ipRow] = await Promise.all([
        env.DB.prepare("SELECT count, day FROM guest_usage WHERE device_key=?").bind(device).first(),
        env.DB.prepare("SELECT count, day FROM guest_usage WHERE device_key=?").bind(ipKey).first()
      ]);
      const deviceUsed = deviceRow && deviceRow.day === today ? deviceRow.count : 0;
      const ipUsed = ipRow && ipRow.day === today ? ipRow.count : 0;
      if (deviceUsed >= GUEST_DAILY_LIMIT || ipUsed >= GUEST_IP_DAILY_LIMIT) return json({ ok: false, error: "您已超出限额，请登录后继续使用", limitExceeded: true }, 429);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO guest_usage(device_key,day,count) VALUES(?,?,1) ON CONFLICT(device_key) DO UPDATE SET day=excluded.day, count=CASE WHEN guest_usage.day=excluded.day THEN guest_usage.count+1 ELSE 1 END").bind(device, today),
        env.DB.prepare("INSERT INTO guest_usage(device_key,day,count) VALUES(?,?,1) ON CONFLICT(device_key) DO UPDATE SET day=excluded.day, count=CASE WHEN guest_usage.day=excluded.day THEN guest_usage.count+1 ELSE 1 END").bind(ipKey, today)
      ]);
    }
    const history = Array.isArray(data.history) ? data.history.slice(-6) : [];
    const previousQuestion = history.filter(item => item?.role === "user").at(-1)?.content || "";
    if (path === "/api/mentor/retrieve") {
      const matches = await mentorMatches(env, user, question, previousQuestion);
      return json({ ok: true, sources: publicSources(matches) });
    }
    if (isCurrentTimeQuestion(question)) {
      const decision = { intent: "chitchat", outcome: "answered", topSimilarity: null };
      await logMentorQuestion(env, user, question, decision);
      return json({ ok: true, answer: getCurrentTime(), sources: [], route: "current_time", intent: "chitchat" });
    }
    if (isSelfIdentityQuestion(question)) {
      const decision = { intent: "business", outcome: "answered", topSimilarity: null };
      await logMentorQuestion(env, user, question, decision);
      const en = !isChineseQuestion(question);
      if (!user) return json({ ok: true, answer: en ? "I don't know. Log in and I can tell you." : "不知道。登录后我才能告诉你。", sources: [], route: "identity", intent: "business" });
      const dept = await env.DB.prepare("SELECT name FROM departments WHERE id=?").bind(user.department_id).first();
      let answer;
      if (user.role === "student") {
        const [stage, node] = await Promise.all([
          env.DB.prepare("SELECT name FROM stages WHERE slug=?").bind(user.current_stage_slug).first(),
          env.DB.prepare("SELECT name FROM nodes WHERE slug=?").bind(user.current_node_slug).first()
        ]);
        answer = en
          ? "You are " + (user.name || "—") + ", student number " + (user.student_no || "—") + ", " + (dept?.name || "department unset") + ", currently at the \u201c" + (stage?.name || "unset") + "\u201d stage, node \u201c" + (node?.name || "unset") + "\u201d. Contact your counselor if anything is wrong."
          : "你是" + (user.name || "未填") + "，学号 " + (user.student_no || "未填") + "，" + (dept?.name || "院系未填") + "，当前处于「" + (stage?.name || "未设置") + "」阶段，节点「" + (node?.name || "未设置") + "」。如信息有误，请联系辅导员。";
      } else {
        const roleName = user.role === "admin" ? "管理员" : "辅导员";
        answer = en
          ? "You are " + (user.name || user.username) + " (" + (user.role === "admin" ? "administrator" : "counselor") + "), " + (dept?.name || "—") + "."
          : "你是" + (user.name || user.username) + "，用户名 " + user.username + "，角色：" + roleName + "，" + (dept?.name || "院系未填") + "。";
      }
      return json({ ok: true, answer, sources: [], route: "identity", intent: "business" });
    }
    if (!enabled) throw mentorFailure("M-100");
    const config = mentorConfig(env);
    const classification = isIdentityQuestion(question)
      ? { intent: "chitchat", reason: "身份问题" }
      : await classifyIntent(question, history, payload => deepSeekContent(env, payload), config);
    if (classification.intent === "chitchat" && (isPersonalQuestion(question) || isSiteHelpQuestion(question))) {
      classification.intent = "business";
      classification.reason = "需要当前档案或系统操作依据";
    }
    if ((classification.intent === "out_of_scope" || classification.intent === "uncertain") && isPartyDomainQuestion(question)) {
      classification.intent = "business";
      classification.reason = "涉及党员发展相关事项，先检索后自主回答";
    }
    const matches = classification.intent === "business" && !isIdentityQuestion(question)
      ? await mentorMatches(env, user, question, previousQuestion) : null;
    const decision = decideMentorRoute({ question, classification, history, stageSlug: user?.current_stage_slug, previousQuestion, config,
      retrieveFn: matches ? () => matches : retrieve });
    let answer = decision.answer || "";
    try {
      if (decision.route === "chitchat") {
        const relevant = /入党|党员|思想汇报|自传|培养|党课|支部|党组织|积极分子|预备|转正/.test(question)
          ? retrieve(question, { stageSlug: user?.current_stage_slug, previousQuestion }).filter(item => item.similarity >= config.similarityThreshold).slice(0, 3) : [];
        decision.sources = publicSources(relevant);
        decision.topSimilarity = relevant.length ? Math.max(...relevant.map(item => item.similarity)) : null;
        answer = clean(await deepSeekContent(env, { model: config.classifierModel, messages: chitchatMessages(question, config, relevant), stream: false, reasoning_effort: "none", max_tokens: 850 }), 4000);
      } else if (decision.route === "business" || decision.route === "advisory") {
        const node = user ? await env.DB.prepare("SELECT name FROM nodes WHERE slug=?").bind(user.current_node_slug).first() : null;
        const messages = decision.route === "advisory"
          ? advisoryMessages(question, { stageSlug: user?.current_stage_slug, nodeName: node?.name || "", history })
          : modelMessages(question, decision.matches, { stageSlug: user?.current_stage_slug, nodeName: node?.name || "", history });
        answer = clean(await deepSeekContent(env, { model: "deepseek-flash", messages, stream: false, reasoning_effort: "none", max_tokens: 1100, temperature: 0.2 }), 4000);
      }
    } catch (error) {
      if (error instanceof HttpError && typeof error.code === "string" && /^M-/.test(error.code)) {
        decision.outcome = "refused";
        decision.sources = [];
        await logMentorQuestion(env, user, question, decision);
        throw error;
      }
      answer = config.serviceFailureReply;
      decision.outcome = "refused";
      decision.sources = [];
    }
    await logMentorQuestion(env, user, question, decision);
    return json({ ok: true, answer, sources: decision.sources, route: decision.route, intent: decision.intent });
  }
  return null;
}

function validateResults(value) {
  assert(Array.isArray(value) && value.length <= 20, "质检结果无效");
  return value.map(item => {
    const code = clean(item.code, 50), kind = clean(item.kind, 10);
    assert(kind === "rule" && /^[a-z0-9-]{1,50}$/.test(code), "质检结果无效");
    return { kind, code, message: clean(item.message, 500), severity: clean(item.severity, 10), suggestion: clean(item.suggestion, 500) };
  });
}
export async function checkRoutes(request, env, path, user) {
  if (path === "/api/checks" && request.method === "POST") {
    assert(user.role === "student", "仅学生可上传材料", 403);
    const form = await request.formData();
    const file = form.get("docx"), materialId = id(form.get("materialId"));
    assert(file && typeof file === "object" && typeof file.stream === "function", "请选择 DOCX 文件");
    assert(/\.docx$/i.test(file.name) && file.size > 0 && file.size <= 10 * 1024 * 1024, "仅支持不超过 10 MB 的 DOCX");
    const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    assert(signature[0] === 0x50 && signature[1] === 0x4b, "文件格式无效");
    const material = await env.DB.prepare("SELECT id FROM materials WHERE id=?").bind(materialId).first();
    assert(material, "材料类型不存在", 404);
    let results;
    try { results = validateResults(JSON.parse(String(form.get("results") || "[]"))); }
    catch { throw new HttpError(400, "质检结果无效"); }
    const key = "checks/" + user.id + "/" + randomHex(16) + ".docx";
    await env.FILES.put(key, file.stream(), { httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
    let checkId = null;
    try {
      const row = await env.DB.prepare("INSERT INTO checks(student_id,material_id,r2_key,filename) VALUES(?,?,?,?)")
        .bind(user.id, materialId, key, clean(file.name, 150)).run();
      checkId = row.meta.last_row_id;
      await env.DB.batch([
        ...results.map(result => env.DB.prepare("INSERT INTO check_results(check_id,kind,code,message,severity,suggestion) VALUES(?,?,?,?,?,?)")
          .bind(checkId, result.kind, result.code, result.message, result.severity, result.suggestion)),
        env.DB.prepare("INSERT INTO material_records(student_id,material_id,status,r2_key,filename,submitted_at) VALUES(?,?,'已交',?,?,?) ON CONFLICT(student_id,material_id) DO UPDATE SET status='已交',r2_key=excluded.r2_key,filename=excluded.filename,submitted_at=excluded.submitted_at")
          .bind(user.id, materialId, key, clean(file.name, 150), iso())
      ]);
      return json({ ok: true, id: checkId, results }, 201);
    } catch (error) {
      if (checkId) await env.DB.prepare("DELETE FROM checks WHERE id=?").bind(checkId).run();
      await env.FILES.delete(key);
      throw error;
    }
  }
  if (path === "/api/checks" && request.method === "GET") {
    const rows = user.role === "student"
      ? await env.DB.prepare("SELECT c.id,c.student_id,c.material_id,c.filename,c.checked_at,c.review_status,c.review_note,m.name AS material_name FROM checks c JOIN materials m ON m.id=c.material_id WHERE c.student_id=? ORDER BY c.checked_at DESC LIMIT 50").bind(user.id).all()
      : user.role === "admin"
        ? await env.DB.prepare("SELECT c.id,c.student_id,c.material_id,c.filename,c.checked_at,c.review_status,c.review_note,m.name AS material_name,p.name AS student_name FROM checks c JOIN materials m ON m.id=c.material_id JOIN profiles p ON p.user_id=c.student_id ORDER BY c.checked_at DESC LIMIT 100").all()
        : await env.DB.prepare("SELECT c.id,c.student_id,c.material_id,c.filename,c.checked_at,c.review_status,c.review_note,m.name AS material_name,p.name AS student_name FROM checks c JOIN materials m ON m.id=c.material_id JOIN profiles p ON p.user_id=c.student_id JOIN users u ON u.id=c.student_id WHERE u.department_id=? ORDER BY c.checked_at DESC LIMIT 100").bind(user.department_id).all();
    return json({ ok: true, checks: rows.results });
  }
  const match = /^\/api\/checks\/(\d+)\/(file|results)$/.exec(path);
  if (match && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM checks WHERE id=?").bind(id(match[1])).first();
    assert(row, "质检记录不存在", 404);
    assert(await canReadStudent(env, user, row.student_id), "无权访问此材料", 403);
    if (match[2] === "results") {
      const results = await env.DB.prepare("SELECT kind,code,message,severity,suggestion FROM check_results WHERE check_id=? ORDER BY id").bind(row.id).all();
      return json({ ok: true, results: results.results });
    }
    const object = await env.FILES.get(row.r2_key);
    assert(object, "文件不存在", 404);
    return fileResponse(object, row.filename, formType(row.filename)?.mime || "application/octet-stream");
  }
  return null;
}

const formTypes = {
  doc: { mime: "application/msword", magic: [0xd0, 0xcf, 0x11, 0xe0] },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: [0x50, 0x4b] },
  xls: { mime: "application/vnd.ms-excel", magic: [0xd0, 0xcf, 0x11, 0xe0] },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: [0x50, 0x4b] },
  pdf: { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] }
};
function formType(filename) { return formTypes[/\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase()] || null; }
function fileResponse(object, filename, mime) {
  return new Response(object.body, { headers: {
    "content-type": mime,
    "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(filename.replace(/[\r\n"]/g, "")),
    "cache-control": "private, no-store"
  } });
}
export async function formRoutes(request, env, path, user) {
  if (path === "/api/forms" && request.method === "GET") {
    const stages = await env.DB.prepare("SELECT slug,position,name FROM stages ORDER BY position").all();
    const rows = user.role === "admin"
      ? await env.DB.prepare("SELECT id,stage_slug,department_id,title,filename,created_at FROM form_templates ORDER BY created_at DESC,id DESC").all()
      : await env.DB.prepare("SELECT id,stage_slug,department_id,title,filename,created_at FROM form_templates WHERE department_id IS NULL OR department_id=? ORDER BY created_at DESC,id DESC").bind(user.department_id).all();
    return json({ ok: true, stages: stages.results, forms: rows.results });
  }
  if (path === "/api/forms" && request.method === "POST") {
    assert(isStaff(user), "仅辅导员或管理员可上传表格", 403);
    const form = await request.formData();
    const title = clean(form.get("title"), 100), stageSlug = clean(form.get("stageSlug"), 80);
    const stage = await env.DB.prepare("SELECT slug FROM stages WHERE slug=?").bind(stageSlug).first();
    assert(stage && title, "请选择阶段并填写表格名称");
    const file = form.get("file");
    assert(file && typeof file.stream === "function", "请选择表格文件");
    const filename = clean(file.name, 150), type = formType(filename);
    assert(type && file.size > 0 && file.size <= 10 * 1024 * 1024, "仅支持不超过 10 MB 的 DOC、DOCX、XLS、XLSX 或 PDF");
    const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    assert(type.magic.every((value, index) => signature[index] === value), "文件格式与扩展名不符");
    const departmentId = user.role === "admin" ? null : user.department_id;
    assert(user.role === "admin" || departmentId, "辅导员尚未分配院系", 403);
    const key = "forms/" + (departmentId || "global") + "/" + randomHex(16) + "." + filename.split(".").at(-1).toLowerCase();
    await env.FILES.put(key, file.stream(), { httpMetadata: { contentType: type.mime } });
    try {
      const saved = await env.DB.prepare("INSERT INTO form_templates(stage_slug,department_id,title,filename,r2_key,uploaded_by) VALUES(?,?,?,?,?,?)")
        .bind(stageSlug, departmentId, title, filename, key, user.id).run();
      return json({ ok: true, id: saved.meta.last_row_id }, 201);
    } catch (error) { await env.FILES.delete(key); throw error; }
  }
  const fileMatch = /^\/api\/forms\/(\d+)\/file$/.exec(path);
  if (fileMatch && request.method === "GET") {
    const row = await env.DB.prepare("SELECT department_id,filename,r2_key FROM form_templates WHERE id=?").bind(id(fileMatch[1])).first();
    assert(row, "表格不存在", 404);
    assert(user.role === "admin" || row.department_id === null || row.department_id === user.department_id, "无权下载此表格", 403);
    const object = await env.FILES.get(row.r2_key);
    assert(object, "文件不存在", 404);
    return fileResponse(object, row.filename, formType(row.filename)?.mime || "application/octet-stream");
  }
  return null;
}

async function registerCounselors(env, user, data) {
  requireSecret(env);
  assert(user.role === "admin", "仅管理员可批量添加辅导员", 403);
  const departmentId = id(data.departmentId);
  assert(await env.DB.prepare("SELECT id FROM departments WHERE id=?").bind(departmentId).first(), "院系不存在", 404);
  assert(Array.isArray(data.counselors) && data.counselors.length >= 1 && data.counselors.length <= 50, "每次可添加 1 至 50 名辅导员");
  const counselors = data.counselors.map(item => ({ name: clean(item?.name, 50), username: clean(item?.username, 40) }));
  for (const counselor of counselors) {
    assert(/^[\p{Script=Han}·]{2,20}$/u.test(counselor.name), "姓名须为 2 至 20 个汉字或间隔号");
    assert(validName(counselor.username), "用户名只能包含字母、数字、点、横线或下划线，长度为 3 至 40 位");
  }
  const usernames = counselors.map(c => c.username);
  assert(new Set(usernames).size === usernames.length, "名单中有重复用户名");
  const marks = usernames.map(() => "?").join(",");
  const existing = await env.DB.prepare("SELECT username FROM users WHERE username IN (" + marks + ")").bind(...usernames).all();
  assert(existing.results.length === 0, "已有用户名注册，请移除重复项后重试：" + existing.results.map(row => row.username).join("、"), 409);
  const statements = [];
  for (const counselor of counselors) {
    const salt = randomHex(16);
    const initial = await hmac(env.AUTH_PEPPER, "initial:" + counselor.username.toLowerCase() + ":cauc+" + counselor.username);
    statements.push(env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,name,must_change_password) VALUES(?,?,?,'counselor',?,?,1)").bind(counselor.username, salt, initial, departmentId, counselor.name));
  }
  try { await env.DB.batch(statements); }
  catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "部分用户名已注册，请刷新名单后重试");
    throw error;
  }
  return json({ ok: true, count: counselors.length }, 201);
}

async function deleteCounselors(env, user, data, expectedIds = null) {
  assert(user.role === "admin", "仅管理员可删除辅导员", 403);
  const usernames = Array.isArray(data.usernames) ? data.usernames.map(value => clean(value, 40)).filter(Boolean) : [];
  assert(usernames.length >= 1 && usernames.length <= 50, "请输入 1 至 50 个用户名");
  const marks = usernames.map(() => "?").join(",");
  const rows = await env.DB.prepare("SELECT id,username FROM users WHERE role='counselor' AND username IN (" + marks + ")").bind(...usernames).all();
  assert(rows.results.length === usernames.length, "部分辅导员用户名不存在", 404);
  const ids = rows.results.map(row => row.id);
  if (expectedIds) assert(ids.every(value => expectedIds.includes(value)), "辅导员账号已变更，请重新核对名单", 409);
  const idMarks = ids.map(() => "?").join(",");
  const keys = await env.DB.prepare("SELECT r2_key FROM form_templates WHERE uploaded_by IN (" + idMarks + ")").bind(...ids).all();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM form_templates WHERE uploaded_by IN (" + idMarks + ")").bind(...ids),
    env.DB.prepare("DELETE FROM invites WHERE used_by IN (" + idMarks + ")").bind(...ids),
    env.DB.prepare("DELETE FROM mentor_question_logs WHERE user_id IN (" + idMarks + ")").bind(...ids),
    env.DB.prepare("DELETE FROM users WHERE role='counselor' AND id IN (" + idMarks + ")").bind(...ids)
  ]);
  let cleanupFailed = 0;
  for (let offset = 0; offset < keys.results.length; offset += 20) {
    const results = await Promise.allSettled(keys.results.slice(offset, offset + 20).map(row => env.FILES.delete(row.r2_key)));
    cleanupFailed += results.filter(result => result.status === "rejected").length;
  }
  if (cleanupFailed) console.error("R2 cleanup failed after counselor removal", { count: cleanupFailed });
  return json({ ok: true, count: ids.length, cleanupFailed });
}

export async function adminRoutes(request, env, path, user) {
  if (!path.startsWith("/api/admin/")) return null;
  assert(isStaff(user), "需要辅导员或管理员权限", 403);
  if (path === "/api/admin/students/auto-register" && request.method === "POST") {
    requireSecret(env);
    assert(user.role === "counselor", "仅辅导员可执行自动注册", 403);
    assert(user.department_id, "辅导员尚未分配院系", 403);
    const data = await bodyJson(request);
    assert(Array.isArray(data.students) && data.students.length >= 1 && data.students.length <= 50, "每次可注册 1 至 50 名学生");
    const students = data.students.map(item => ({ name: clean(item?.name, 50), studentNo: clean(item?.studentNo, 40) }));
    for (const student of students) {
      assert(/^[\p{Script=Han}·]{2,20}$/u.test(student.name), "姓名须为 2 至 20 个汉字或间隔号");
      assert(/^\d{6,20}$/.test(student.studentNo), "学号须为 6 至 20 位数字");
    }
    const numbers = students.map(student => student.studentNo);
    assert(new Set(numbers).size === numbers.length, "名单中有重复学号");
    const marks = numbers.map(() => "?").join(",");
    const existing = await env.DB.prepare("SELECT username FROM users WHERE username IN (" + marks + ")").bind(...numbers).all();
    assert(existing.results.length === 0, "已有学号注册，请移除重复项后重试：" + existing.results.map(row => row.username).join("、"), 409);
    const statements = [];
    for (const student of students) {
      const salt = randomHex(16);
      const initial = await hmac(env.AUTH_PEPPER, "initial:" + student.studentNo.toLowerCase() + ":cauc+" + student.studentNo);
      statements.push(env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,name,must_change_password) VALUES(?,?,?,'student',?,?,1)")
        .bind(student.studentNo, salt, initial, user.department_id, student.name));
      statements.push(env.DB.prepare("INSERT INTO profiles(user_id,name,student_no,major,grade,phone,applied_at,node_entered_at) SELECT id,?,?, '', '', '', NULL, ? FROM users WHERE username=?")
        .bind(student.name, student.studentNo, iso().slice(0, 10), student.studentNo));
    }
    try { await env.DB.batch(statements); }
    catch (error) {
      if (String(error).includes("UNIQUE")) throw new HttpError(409, "部分学号已注册，请刷新名单后重试");
      throw error;
    }
    return json({ ok: true, count: students.length }, 201);
  }
  if (path === "/api/admin/dashboard" && request.method === "GET") {
    const students = user.role === "admin"
      ? await env.DB.prepare("SELECT u.id,u.username,u.department_id,d.name AS department,p.* FROM users u JOIN profiles p ON p.user_id=u.id LEFT JOIN departments d ON d.id=u.department_id ORDER BY p.student_no LIMIT 500").all()
      : await env.DB.prepare("SELECT u.id,u.username,u.department_id,d.name AS department,p.* FROM users u JOIN profiles p ON p.user_id=u.id LEFT JOIN departments d ON d.id=u.department_id WHERE u.department_id=? ORDER BY p.student_no LIMIT 500").bind(user.department_id).all();
    const departments = await env.DB.prepare("SELECT id,name FROM departments ORDER BY name").all();
    const nodes = await env.DB.prepare("SELECT slug,stage_slug,name,position FROM nodes ORDER BY stage_slug,position").all();
    const materials = await env.DB.prepare("SELECT id,name,stage_slug FROM materials ORDER BY id").all();
    const invites = user.role === "admin"
      ? await env.DB.prepare("SELECT i.id,i.role,i.department_id,d.name AS department,i.expires_at,i.used_by FROM invites i LEFT JOIN departments d ON d.id=i.department_id ORDER BY i.id DESC LIMIT 100").all()
      : await env.DB.prepare("SELECT i.id,i.role,i.department_id,d.name AS department,i.expires_at,i.used_by FROM invites i LEFT JOIN departments d ON d.id=i.department_id WHERE i.department_id=? ORDER BY i.id DESC LIMIT 100").bind(user.department_id).all();
    const counselors = user.role === "admin"
      ? await env.DB.prepare("SELECT u.id,u.username,u.department_id,d.name AS department,u.name,u.created_at FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.role='counselor' ORDER BY u.id").all()
      : await env.DB.prepare("SELECT u.id,u.username,u.department_id,d.name AS department,u.name,u.created_at FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.role='counselor' AND u.department_id=?").bind(user.department_id).all();
    return json({ ok: true, students: students.results, counselors: counselors.results, departments: departments.results, nodes: nodes.results, materials: materials.results, invites: invites.results });
  }
  if (path === "/api/admin/students/bulk-advance" && request.method === "POST") {
    const ids = selectedIds((await bodyJson(request)).studentIds);
    const stages = (await env.DB.prepare("SELECT slug,name FROM stages ORDER BY position").all()).results;
    const students = await Promise.all(ids.map(studentId => targetStudent(env, user, studentId)));
    const updates = [];
    for (const student of students) {
      const next = stages[stages.findIndex(stage => stage.slug === student.current_stage_slug) + 1];
      assert(next, student.name + "已在最后阶段，无法继续推进", 409);
      const firstNode = await env.DB.prepare("SELECT slug FROM nodes WHERE stage_slug=? ORDER BY position LIMIT 1").bind(next.slug).first();
      assert(firstNode, next.name + "尚无培养节点", 409);
      updates.push({ student, next, firstNode });
    }
    const today = iso().slice(0, 10);
    await env.DB.batch(updates.flatMap(({ student, next, firstNode }) => [
      env.DB.prepare("UPDATE profiles SET current_stage_slug=?,current_node_slug=?,node_entered_at=? WHERE user_id=?").bind(next.slug, firstNode.slug, today, student.id),
      env.DB.prepare("INSERT INTO notifications(student_id,kind,title,content) VALUES(?,'lesson',?,?)").bind(student.id, "培养阶段已更新", "你的培养档案已推进至「" + next.name + "」，请查看本阶段材料清单。")
    ]));
    return json({ ok: true, count: updates.length });
  }
  if (path === "/api/admin/students/bulk-delete" && request.method === "POST") {
    const ids = selectedIds((await bodyJson(request)).studentIds);
    await Promise.all(ids.map(studentId => targetStudent(env, user, studentId)));
    const marks = ids.map(() => "?").join(",");
    const keys = await env.DB.prepare("SELECT r2_key FROM checks WHERE student_id IN (" + marks + ") UNION SELECT r2_key FROM material_records WHERE student_id IN (" + marks + ") AND r2_key IS NOT NULL").bind(...ids, ...ids).all();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM invites WHERE used_by IN (" + marks + ")").bind(...ids),
      env.DB.prepare("DELETE FROM notifications WHERE student_id IN (" + marks + ")").bind(...ids),
      env.DB.prepare("DELETE FROM material_records WHERE student_id IN (" + marks + ")").bind(...ids),
      env.DB.prepare("DELETE FROM check_results WHERE check_id IN (SELECT id FROM checks WHERE student_id IN (" + marks + "))").bind(...ids),
      env.DB.prepare("DELETE FROM checks WHERE student_id IN (" + marks + ")").bind(...ids),
      env.DB.prepare("DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE student_id IN (" + marks + "))").bind(...ids),
      env.DB.prepare("DELETE FROM chat_sessions WHERE student_id IN (" + marks + ")").bind(...ids),
      env.DB.prepare("DELETE FROM mentor_question_logs WHERE user_id IN (" + marks + ")").bind(...ids),
      env.DB.prepare("DELETE FROM mentor_usage WHERE user_id IN (" + marks + ")").bind(...ids),
      env.DB.prepare("DELETE FROM sessions WHERE user_id IN (" + marks + ")").bind(...ids),
      env.DB.prepare("DELETE FROM profiles WHERE user_id IN (" + marks + ")").bind(...ids),
      env.DB.prepare("DELETE FROM users WHERE role='student' AND id IN (" + marks + ")").bind(...ids)
    ]);
    let cleanupFailed = 0;
    for (let offset = 0; offset < keys.results.length; offset += 20) {
      const results = await Promise.allSettled(keys.results.slice(offset, offset + 20).map(row => env.FILES.delete(row.r2_key)));
      cleanupFailed += results.filter(result => result.status === "rejected").length;
    }
    if (cleanupFailed) console.error("R2 cleanup failed after student removal", { count: cleanupFailed });
    return json({ ok: true, count: ids.length, cleanupFailed });
  }
  if (path === "/api/admin/students" && request.method === "POST") {
    requireSecret(env);
    const data = await bodyJson(request);
    const name = clean(data.name, 50), studentNo = clean(data.studentNo, 40);
    assert(/^[\p{Script=Han}·]{2,20}$/u.test(name), "姓名须为 2 至 20 个汉字或间隔号");
    assert(/^\d{6,20}$/.test(studentNo), "学号须为 6 至 20 位数字");
    const departmentId = user.role === "admin" ? id(data.departmentId) : user.department_id;
    assert(departmentId, "院系无效");
    if (user.role === "admin") assert(await env.DB.prepare("SELECT id FROM departments WHERE id=?").bind(departmentId).first(), "院系不存在", 404);
    const existing = await env.DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(studentNo).first();
    assert(!existing, "该学号已注册", 409);
    const salt = randomHex(16);
    const initial = await hmac(env.AUTH_PEPPER, "initial:" + studentNo.toLowerCase() + ":cauc+" + studentNo);
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,name,must_change_password) VALUES(?,?,?,'student',?,?,1)").bind(studentNo, salt, initial, departmentId, name),
        env.DB.prepare("INSERT INTO profiles(user_id,name,student_no,major,grade,phone,applied_at,node_entered_at) SELECT id,?,?, '', '', '', NULL, ? FROM users WHERE username=?").bind(name, studentNo, iso().slice(0, 10), studentNo)
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new HttpError(409, "该学号已注册");
      throw error;
    }
    return json({ ok: true, name, studentNo }, 201);
  }
  if (path === "/api/admin/counselors" && request.method === "POST") {
    requireSecret(env);
    assert(user.role === "admin", "仅管理员可添加辅导员", 403);
    const data = await bodyJson(request);
    const name = clean(data.name, 50), username = clean(data.username, 40);
    assert(/^[\p{Script=Han}·]{2,20}$/u.test(name), "姓名须为 2 至 20 个汉字或间隔号");
    assert(validName(username), "用户名只能包含字母、数字、点、横线或下划线，长度为 3 至 40 位");
    const departmentId = id(data.departmentId);
    assert(await env.DB.prepare("SELECT id FROM departments WHERE id=?").bind(departmentId).first(), "院系不存在", 404);
    const existing = await env.DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
    assert(!existing, "该用户名已存在", 409);
    const salt = randomHex(16);
    const initial = await hmac(env.AUTH_PEPPER, "initial:" + username.toLowerCase() + ":cauc+" + username);
    await env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,name,must_change_password) VALUES(?,?,?,'counselor',?,?,1)").bind(username, salt, initial, departmentId, name).run();
    return json({ ok: true, name, username }, 201);
  }
  if (path === "/api/admin/counselors/auto-register" && request.method === "POST") {
    return registerCounselors(env, user, await bodyJson(request));
  }
  if (path === "/api/admin/counselors/bulk-delete" && request.method === "POST") {
    return deleteCounselors(env, user, await bodyJson(request));
  }
  if (path === "/api/admin/checks/bulk-review" && request.method === "POST") {
    const data = await bodyJson(request), ids = selectedIds(data.checkIds);
    const status = clean(data.status, 20), note = clean(data.note, 500);
    assert(["已通过", "退回修改"].includes(status), "审阅状态无效");
    assert(status !== "退回修改" || note, "退回材料时请填写修改说明");
    const marks = ids.map(() => "?").join(",");
    const rows = await env.DB.prepare("SELECT c.id,c.student_id,c.material_id,c.review_status,c.filename,m.name AS material_name,u.department_id FROM checks c JOIN users u ON u.id=c.student_id JOIN materials m ON m.id=c.material_id WHERE c.id IN (" + marks + ")").bind(...ids).all();
    assert(rows.results.length === ids.length, "部分材料不存在", 404);
    const updates = [];
    for (const row of rows.results) {
      assert(user.role === "admin" || row.department_id === user.department_id, "无权审阅其他院系材料", 403);
      assert(row.review_status === "待审阅", row.filename + "已审阅，请刷新列表", 409);
      const latest = await env.DB.prepare("SELECT id FROM checks WHERE student_id=? AND material_id=? ORDER BY id DESC LIMIT 1").bind(row.student_id, row.material_id).first();
      assert(latest?.id === row.id, row.filename + "已被新提交版本替代", 409);
      updates.push(row);
    }
    await env.DB.batch(updates.flatMap(row => [
      env.DB.prepare("UPDATE checks SET review_status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?").bind(status, note, user.id, iso(), row.id),
      env.DB.prepare("UPDATE material_records SET status=? WHERE student_id=? AND material_id=?").bind(status === "已通过" ? "已通过" : "未交", row.student_id, row.material_id),
      env.DB.prepare("INSERT INTO notifications(student_id,kind,title,content) VALUES(?,'lesson',?,?)").bind(row.student_id, "材料审阅结果：" + row.material_name, status === "已通过" ? "你提交的「" + row.material_name + "」已通过审阅。" : "你提交的「" + row.material_name + "」需修改：" + note)
    ]));
    return json({ ok: true, count: updates.length });
  }
  const filesMatch = /^\/api\/admin\/students\/(\d+)\/files$/.exec(path);
  if (filesMatch && request.method === "GET") {
    const student = await targetStudent(env, user, filesMatch[1]);
    const rows = await env.DB.prepare("SELECT c.id,c.filename,c.checked_at,c.review_status,c.review_note,m.name AS material_name,s.name AS stage_name FROM checks c JOIN materials m ON m.id=c.material_id JOIN stages s ON s.slug=m.stage_slug WHERE c.student_id=? ORDER BY c.checked_at DESC,c.id DESC LIMIT 100").bind(student.id).all();
    return json({ ok: true, files: rows.results });
  }
  if (path === "/api/admin/departments" && request.method === "POST") {
    assert(user.role === "admin", "仅管理员可维护院系", 403);
    const data = await bodyJson(request), name = clean(data.name, 100);
    assert(name, "请输入院系名称");
    const result = await env.DB.prepare("INSERT INTO departments(name) VALUES(?)").bind(name).run();
    return json({ ok: true, departmentId: result.meta.last_row_id }, 201);
  }
  if (path === "/api/admin/invites" && request.method === "POST") {
    assert(user.role === "admin", "仅管理员可邀请辅导员", 403);
    const data = await bodyJson(request), role = clean(data.role, 20), departmentId = id(data.departmentId);
    assert(role === "counselor", "邀请码仅用于辅导员注册");
    const department = await env.DB.prepare("SELECT id FROM departments WHERE id=?").bind(departmentId).first();
    assert(department, "院系不存在", 404);
    const count = Number(data.count ?? 1);
    assert(Number.isSafeInteger(count) && count >= 1 && count <= 50, "一次可生成 1 至 50 个邀请码");
    const codes = Array.from({ length: count }, () => randomHex(24));
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    await env.DB.batch(await Promise.all(codes.map(async code => env.DB.prepare("INSERT INTO invites(code_hash,role,department_id,expires_at,created_by) VALUES(?,?,?,?,?)")
      .bind(await sha256(code), role, departmentId, expiresAt, user.id))));
    return json({ ok: true, codes, code: codes[0], expiresInDays: 7 }, 201);
  }
  const studentMatch = /^\/api\/admin\/students\/(\d+)$/.exec(path);
  const profileMatch = /^\/api\/admin\/students\/(\d+)\/profile$/.exec(path);
  if (profileMatch && request.method === "POST") {
    const student = await targetStudent(env, user, profileMatch[1]);
    const data = await bodyJson(request);
    const departmentId = user.role === "admin" ? id(data.departmentId) : user.department_id;
    assert(departmentId, "院系无效");
    if (user.role === "admin") assert(await env.DB.prepare("SELECT id FROM departments WHERE id=?").bind(departmentId).first(), "院系不存在", 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET department_id=? WHERE id=?").bind(departmentId, student.id),
      env.DB.prepare("UPDATE profiles SET major=?,grade=?,phone=?,applied_at=? WHERE user_id=?")
        .bind(clean(data.major, 100), clean(data.grade, 20), clean(data.phone, 20), clean(data.appliedAt, 10) || null, student.id)
    ]);
    return json({ ok: true });
  }
  if (studentMatch && request.method === "POST") {
    const student = await targetStudent(env, user, studentMatch[1]);
    const data = await bodyJson(request), nodeSlug = clean(data.nodeSlug, 80);
    const node = await env.DB.prepare("SELECT slug,stage_slug FROM nodes WHERE slug=?").bind(nodeSlug).first();
    assert(node, "节点不存在", 404);
    await env.DB.prepare("UPDATE profiles SET current_stage_slug=?,current_node_slug=?,node_entered_at=? WHERE user_id=?")
      .bind(node.stage_slug, node.slug, iso().slice(0, 10), student.id).run();
    return json({ ok: true });
  }
  const materialMatch = /^\/api\/admin\/students\/(\d+)\/materials\/(\d+)$/.exec(path);
  if (materialMatch && request.method === "POST") {
    const student = await targetStudent(env, user, materialMatch[1]);
    const materialId = id(materialMatch[2]), data = await bodyJson(request), status = clean(data.status, 10);
    assert(["未交", "已交", "已通过"].includes(status), "状态无效");
    const material = await env.DB.prepare("SELECT id FROM materials WHERE id=?").bind(materialId).first();
    assert(material, "材料不存在", 404);
    await env.DB.prepare("INSERT INTO material_records(student_id,material_id,status,submitted_at) VALUES(?,?,?,?) ON CONFLICT(student_id,material_id) DO UPDATE SET status=excluded.status,submitted_at=excluded.submitted_at")
      .bind(student.id, materialId, status, status === "未交" ? null : iso()).run();
    return json({ ok: true });
  }
  if (path === "/api/admin/notifications" && request.method === "POST") {
    const data = await bodyJson(request), student = await targetStudent(env, user, data.studentId);
    const title = clean(data.title, 200), content = clean(data.content, 2000);
    assert(title && content, "标题和内容不能为空");
    await env.DB.prepare("INSERT INTO notifications(student_id,kind,title,content) VALUES(?,'lesson',?,?)").bind(student.id, title, content).run();
    return json({ ok: true }, 201);
  }
  return null;
}

async function officeStudent(env, user, identifier) {
  const value = clean(identifier, 50);
  assert(value, "请提供学生姓名或学号");
  const rows = user.role === "admin"
    ? await env.DB.prepare("SELECT u.id,u.username,u.department_id,p.name,p.student_no FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.role='student' AND (p.student_no=? OR p.name=?) LIMIT 3").bind(value, value).all()
    : await env.DB.prepare("SELECT u.id,u.username,u.department_id,p.name,p.student_no FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.role='student' AND u.department_id=? AND (p.student_no=? OR p.name=?) LIMIT 3").bind(user.department_id, value, value).all();
  assert(rows.results.length, "找不到可管理的学生：" + value, 404);
  assert(rows.results.length === 1, "姓名“" + value + "”对应多位学生，请使用学号", 409);
  return rows.results[0];
}

async function normalizeOfficeAction(env, user, action, files) {
  const type = action.type;
  if (type === "register_counselors") {
    assert(user.role === "admin", "仅管理员可批量添加辅导员", 403);
    const department = await env.DB.prepare("SELECT id,name FROM departments WHERE id=?").bind(id(action.departmentId)).first();
    assert(department, "院系不存在", 404);
    const counselors = action.counselors.map(item => ({ name: clean(item.name, 50), username: clean(item.username, 40) }));
    assert(counselors.every(item => /^[\p{Script=Han}·]{2,20}$/u.test(item.name) && validName(item.username)), "名单须包含有效的姓名和用户名");
    assert(new Set(counselors.map(item => item.username.toLowerCase())).size === counselors.length, "名单中有重复用户名");
    return { type, departmentId: department.id, counselors, preview: "将为" + department.name + "注册辅导员：\n" +
      counselors.map(item => item.name + "（" + item.username + "）").join("\n") + "\n初始密码为 cauc+用户名，首次登录须修改。" };
  }
  if (type === "delete_counselors") {
    assert(user.role === "admin", "仅管理员可删除辅导员", 403);
    const usernames = action.counselors.map(item => clean(item.username, 40));
    assert(usernames.every(validName) && new Set(usernames.map(value => value.toLowerCase())).size === usernames.length, "请提供有效且不重复的辅导员用户名");
    const marks = usernames.map(() => "?").join(",");
    const { results } = await env.DB.prepare("SELECT id,username,name FROM users WHERE role='counselor' AND username IN (" + marks + ")").bind(...usernames).all();
    assert(results.length === usernames.length, "部分辅导员用户名不存在", 404);
    return { type, usernames: results.map(item => item.username), ids: results.map(item => item.id), preview: "将删除以下辅导员账号及其上传的资料下载表格，此操作不可恢复：\n" +
      results.map(item => (item.name || "辅导员") + "（" + item.username + "）").join("\n") };
  }
  if (type === "register_students") {
    const departmentId = user.role === "admin" ? Number(action.departmentId) : user.department_id;
    assert(Number.isSafeInteger(departmentId) && departmentId > 0, "管理员请说明学生所属院系");
    assert(await env.DB.prepare("SELECT id FROM departments WHERE id=?").bind(departmentId).first(), "院系不存在", 404);
    const students = action.students.map(item => ({ name: clean(item.name, 50), studentNo: clean(item.studentNo, 40) }));
    assert(students.every(item => /^[\p{Script=Han}·]{2,20}$/u.test(item.name) && /^\d{6,20}$/.test(item.studentNo)), "名单须包含有效的姓名和学号");
    assert(new Set(students.map(item => item.studentNo)).size === students.length, "名单中有重复学号");
    const existing = await env.DB.prepare("SELECT username FROM users WHERE username IN (" + students.map(() => "?").join(",") + ")").bind(...students.map(item => item.studentNo)).all();
    assert(!existing.results.length, "以下学号已有账号：" + existing.results.map(item => item.username).join("、"), 409);
    return { type, departmentId, students, preview: "将注册 " + students.length + " 名学生：" + students.map(item => item.name + "（" + item.studentNo + "）").join("、") + "。初始密码为 cauc+学号，首次登录强制修改。" };
  }
  if (type === "reset_password") {
    const student = await officeStudent(env, user, action.student);
    return { type, studentId: student.id, studentNo: student.student_no, preview: "将重置 " + student.name + "（" + student.student_no + "）的密码，并退出该账号所有已登录设备。确认后生成一次性显示的随机临时密码。" };
  }
  if (type === "update_students") {
    assert(action.rows.length <= 20, "一次最多更新 20 名学生");
    const rows = [];
    for (const item of action.rows) {
      const student = await officeStudent(env, user, item.student);
      const row = { studentId: student.id, studentNo: student.student_no, name: student.name };
      if (item.major !== undefined) row.major = clean(item.major, 100);
      if (item.grade !== undefined) row.grade = clean(item.grade, 20);
      if (item.phone !== undefined) {
        row.phone = clean(item.phone, 20);
        assert(/^[0-9+()\- ]{0,20}$/.test(row.phone), "联系电话格式无效：" + student.student_no);
      }
      if (item.appliedAt !== undefined) {
        row.appliedAt = clean(item.appliedAt, 10);
        assert(/^\d{4}-\d{2}-\d{2}$/.test(row.appliedAt) && !Number.isNaN(Date.parse(row.appliedAt)), "申请日期格式无效：" + student.student_no);
      }
      if (item.stageSlug !== undefined || item.nodeSlug !== undefined) {
        const node = item.nodeSlug
          ? await env.DB.prepare("SELECT slug,stage_slug FROM nodes WHERE slug=?").bind(clean(item.nodeSlug, 80)).first()
          : await env.DB.prepare("SELECT slug,stage_slug FROM nodes WHERE stage_slug=? ORDER BY position LIMIT 1").bind(clean(item.stageSlug, 80)).first();
        assert(node && (!item.stageSlug || node.stage_slug === item.stageSlug), "培养阶段或节点无效：" + student.student_no);
        row.nodeSlug = node.slug; row.stageSlug = node.stage_slug;
      }
      if (item.materialName !== undefined || item.status !== undefined) {
        const material = await env.DB.prepare("SELECT id,name FROM materials WHERE name=?").bind(clean(item.materialName, 100)).first();
        assert(material, "材料不存在：" + clean(item.materialName, 100), 404);
        assert(["未交", "已交", "已通过"].includes(item.status), "材料状态无效");
        row.materialId = material.id; row.materialName = material.name; row.status = item.status;
      }
      assert(Object.keys(row).length > 3, "没有可更新的字段：" + student.student_no);
      rows.push(row);
    }
    assert(new Set(rows.map(item => item.studentId)).size === rows.length, "同一学生在清单中重复，请合并后重试");
    return { type, rows, preview: "将更新 " + rows.length + " 名学生：\n" + rows.map(row => row.name + "（" + row.studentNo + "）：" + [row.major !== undefined && "专业 " + row.major, row.grade !== undefined && "年级 " + row.grade, row.phone !== undefined && "电话 " + row.phone, row.appliedAt && "申请日期 " + row.appliedAt, row.stageSlug && "阶段 " + row.stageSlug, row.materialName && row.materialName + "→" + row.status].filter(Boolean).join("；")).join("\n") };
  }
  assert(type === "upload_forms" || type === "upload_student_files", "不支持的办公操作");
  assert(action.files.length <= 10, "一次最多上传 10 份文件");
  assert(files.length === action.files.length, "请附上清单中的全部文件");
  const names = files.map(item => clean(item.name, 150));
  assert(new Set(names).size === names.length, "文件名重复，请重命名后重试");
  const rows = [];
  for (const item of action.files) {
    const filename = clean(item.filename, 150);
    assert(names.includes(filename), "缺少文件：" + filename);
    const fileType = formType(filename);
    assert(fileType && (type === "upload_forms" || ["docx", "pdf"].includes(filename.split(".").at(-1).toLowerCase())), "文件类型不支持：" + filename);
    if (type === "upload_forms") {
      const stage = await env.DB.prepare("SELECT slug,name FROM stages WHERE slug=?").bind(clean(item.stageSlug, 80)).first();
      assert(stage, "阶段不存在：" + clean(item.stageSlug, 80));
      const title = clean(item.title, 100);
      assert(title, "请填写表格名称：" + filename);
      rows.push({ filename, title, stageSlug: stage.slug, stageName: stage.name });
    } else {
      const student = await officeStudent(env, user, item.student);
      const material = await env.DB.prepare("SELECT id,name FROM materials WHERE name=?").bind(clean(item.materialName, 100)).first();
      assert(material, "材料不存在：" + clean(item.materialName, 100));
      rows.push({ filename, studentId: student.id, studentNo: student.student_no, studentName: student.name, materialId: material.id, materialName: material.name });
    }
  }
  assert(new Set(rows.map(item => item.filename)).size === rows.length, "一个文件不能重复上传到多个位置");
  return { type, rows, preview: "将上传 " + rows.length + " 份文件：\n" + rows.map(row => row.filename + " → " + (type === "upload_forms" ? row.stageName + " / " + row.title : row.studentName + "（" + row.studentNo + "）/ " + row.materialName)).join("\n") };
}

export async function officeRoutes(request, env, path, user) {
  if (!path.startsWith("/api/office/")) return null;
  assert(isStaff(user), "仅辅导员和管理员可使用办公助理", 403);
  if (path === "/api/office/plan" && request.method === "POST") {
    const data = await bodyJson(request);
    const question = clean(data.question, 1000), documentText = clean(data.documentText, 25000);
    const files = Array.isArray(data.files) ? data.files.slice(0, 11).map(item => ({ name: clean(item?.name, 150) })) : [];
    const history = Array.isArray(data.history) ? data.history.slice(-6) : [];
    assert(question || documentText || files.length, "请描述任务或上传文件");
    if (isIdentityQuestion(question)) return json({ ok: true, answer: "我是中国民航大学理学院独立开发的党员发展辅助系统。作为办公助理，我可以帮你整理和执行已确认的站内任务。", plan: null });
    if (isCurrentTimeQuestion(question)) return json({ ok: true, answer: getCurrentTime(), plan: null });
    assert(env.DEEPSEEK_API_KEY, "办公助理尚未配置 AI 服务", 503);
    assert(files.length <= 10, "一次最多上传 10 个文件");
    const catalog = {
      stages: (await env.DB.prepare("SELECT slug,name FROM stages ORDER BY position").all()).results,
      materials: (await env.DB.prepare("SELECT name,stage_slug FROM materials ORDER BY id").all()).results,
      departments: user.role === "admin" ? (await env.DB.prepare("SELECT id,name FROM departments ORDER BY name").all()).results : []
    };
    const references = retrieve(question).filter(item => item.similarity >= mentorConfig(env).similarityThreshold).slice(0, 3);
    const raw = await deepSeekContent(env, { model: "deepseek-flash", messages: officeMessages(question, documentText, files, user.role, catalog, history, references), response_format: { type: "json_object" }, reasoning_effort: "none", stream: false, max_tokens: 2800, temperature: 0.1 });
    let parsed;
    try { parsed = parseOfficePlan(raw); } catch (error) { return json({ ok: true, answer: error.message + "。请补充具体信息。", plan: null }); }
    if (!parsed.action) return json({ ok: true, answer: parsed.reply, plan: null });
    let normalized;
    try { normalized = await normalizeOfficeAction(env, user, parsed.action, files); }
    catch (error) { if (error instanceof HttpError) return json({ ok: true, answer: error.message + "。请补充或修正后重试。", plan: null }); throw error; }
    const planId = randomHex(16);
    await env.DB.prepare("INSERT INTO office_plans(id,user_id,action_type,payload_json,expires_at) VALUES(?,?,?,?,?)")
      .bind(planId, user.id, normalized.type, JSON.stringify(normalized), new Date(Date.now() + 15 * 60000).toISOString()).run();
    return json({ ok: true, answer: parsed.reply, plan: { id: planId, type: normalized.type, preview: normalized.preview, expiresInMinutes: 15 } });
  }
  if (path === "/api/office/execute" && request.method === "POST") {
    const multipart = request.headers.get("content-type")?.includes("multipart/form-data");
    const data = multipart ? await request.formData() : await bodyJson(request);
    const planId = clean(multipart ? data.get("planId") : data.planId, 32);
    assert(validHex(planId, 32), "操作编号无效");
    const row = await env.DB.prepare("SELECT * FROM office_plans WHERE id=? AND user_id=?").bind(planId, user.id).first();
    assert(row && row.status === "pending" && row.expires_at > iso(), "操作已执行或已过期，请重新提出任务", 409);
    const locked = await env.DB.prepare("UPDATE office_plans SET status='running' WHERE id=? AND user_id=? AND status='pending'").bind(planId, user.id).run();
    assert(locked.meta.changes === 1, "操作已在执行中", 409);
    const plan = JSON.parse(row.payload_json);
    try {
      let result;
      if (plan.type === "register_counselors") {
        const { count } = await (await registerCounselors(env, user, plan)).json();
        result = { count, message: "已注册 " + count + " 名辅导员。初始密码为 cauc+用户名，首次登录须修改。" };
      } else if (plan.type === "delete_counselors") {
        const { count, cleanupFailed } = await (await deleteCounselors(env, user, plan, plan.ids)).json();
        result = { count, message: "已删除 " + count + " 名辅导员。" + (cleanupFailed ? "有 " + cleanupFailed + " 份文件未能完成存储清理。" : "") };
      } else if (plan.type === "register_students") {
        requireSecret(env);
        assert(user.role === "admin" || user.department_id === plan.departmentId, "院系权限已变化，请重新提出任务", 403);
        const statements = [];
        for (const student of plan.students) {
          const salt = randomHex(16), initial = await hmac(env.AUTH_PEPPER, "initial:" + student.studentNo.toLowerCase() + ":cauc+" + student.studentNo);
          statements.push(env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,name,must_change_password) VALUES(?,?,?,'student',?,?,1)").bind(student.studentNo, salt, initial, plan.departmentId, student.name));
          statements.push(env.DB.prepare("INSERT INTO profiles(user_id,name,student_no,major,grade,phone,applied_at,node_entered_at) SELECT id,?,?, '', '', '', NULL, ? FROM users WHERE username=?").bind(student.name, student.studentNo, iso().slice(0, 10), student.studentNo));
        }
        await env.DB.batch(statements);
        result = { count: plan.students.length, message: "已注册 " + plan.students.length + " 名学生。初始密码为 cauc+学号，首次登录须修改。" };
      } else if (plan.type === "update_students") {
        const statements = [];
        for (const item of plan.rows) {
          await targetStudent(env, user, item.studentId);
          if (item.major !== undefined || item.grade !== undefined || item.phone !== undefined || item.appliedAt !== undefined || item.nodeSlug) statements.push(env.DB.prepare("UPDATE profiles SET major=COALESCE(?,major),grade=COALESCE(?,grade),phone=COALESCE(?,phone),applied_at=COALESCE(?,applied_at),current_stage_slug=COALESCE(?,current_stage_slug),current_node_slug=COALESCE(?,current_node_slug),node_entered_at=CASE WHEN ? IS NULL THEN node_entered_at ELSE ? END WHERE user_id=?")
            .bind(item.major ?? null, item.grade ?? null, item.phone ?? null, item.appliedAt ?? null, item.stageSlug ?? null, item.nodeSlug ?? null, item.nodeSlug ?? null, iso().slice(0, 10), item.studentId));
          if (item.materialId) statements.push(env.DB.prepare("INSERT INTO material_records(student_id,material_id,status,submitted_at) VALUES(?,?,?,?) ON CONFLICT(student_id,material_id) DO UPDATE SET status=excluded.status,submitted_at=excluded.submitted_at")
            .bind(item.studentId, item.materialId, item.status, item.status === "未交" ? null : iso()));
          if (item.nodeSlug) statements.push(env.DB.prepare("INSERT INTO notifications(student_id,kind,title,content) VALUES(?,'lesson',?,?)")
            .bind(item.studentId, "培养阶段已更新", "你的培养档案已更新，请查看当前阶段与节点。"));
        }
        await env.DB.batch(statements);
        result = { count: plan.rows.length, message: "已更新 " + plan.rows.length + " 名学生的档案。" };
      } else if (plan.type === "reset_password") {
        requireSecret(env);
        const student = await targetStudent(env, user, plan.studentId);
        const newSalt = clean(data.newSalt, 32), newVerifier = clean(data.newVerifier, 64);
        assert(validHex(newSalt, 32) && validHex(newVerifier, 64), "临时密码资料无效");
        const verifier = await hmac(env.AUTH_PEPPER, student.student_no.toLowerCase() + ":" + newVerifier);
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET password_salt=?,password_verifier=?,must_change_password=1,reset_password=1 WHERE id=?").bind(newSalt, verifier, student.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(student.id)
        ]);
        result = { count: 1, message: "密码已重置，原登录会话已退出。请通过可信渠道将临时密码交给学生；首次登录必须修改。" };
      } else {
        assert(multipart, "请附上要上传的文件");
        const uploads = data.getAll("file");
        assert(uploads.length === plan.rows.length, "文件数量与预览不一致");
        const byName = new Map(uploads.map(file => [clean(file.name, 150), file]));
        assert(byName.size === uploads.length, "文件名重复");
        const prepared = [];
        for (const item of plan.rows) {
          const file = byName.get(item.filename), type = formType(item.filename);
          assert(file && type && file.size > 0 && file.size <= 10 * 1024 * 1024, "文件缺失或超过 10 MB：" + item.filename);
          const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
          assert(type.magic.every((byte, index) => byte === signature[index]), "文件格式与扩展名不符：" + item.filename);
          if (plan.type === "upload_student_files") await targetStudent(env, user, item.studentId);
          const key = plan.type === "upload_forms" ? "forms/" + (user.role === "admin" ? "global" : user.department_id) + "/" + randomHex(16) + "." + item.filename.split(".").at(-1).toLowerCase()
            : "checks/" + item.studentId + "/" + randomHex(16) + "." + item.filename.split(".").at(-1).toLowerCase();
          prepared.push({ item, file, type, key });
        }
        const uploaded = [];
        try {
          for (const entry of prepared) { await env.FILES.put(entry.key, entry.file.stream(), { httpMetadata: { contentType: entry.type.mime } }); uploaded.push(entry.key); }
          if (plan.type === "upload_forms") await env.DB.batch(prepared.map(entry => env.DB.prepare("INSERT INTO form_templates(stage_slug,department_id,title,filename,r2_key,uploaded_by) VALUES(?,?,?,?,?,?)")
            .bind(entry.item.stageSlug, user.role === "admin" ? null : user.department_id, entry.item.title, entry.item.filename, entry.key, user.id)));
          else {
            const checkIds = [];
            try {
              for (const entry of prepared) {
                const saved = await env.DB.prepare("INSERT INTO checks(student_id,material_id,r2_key,filename) VALUES(?,?,?,?)")
                  .bind(entry.item.studentId, entry.item.materialId, entry.key, entry.item.filename).run();
                checkIds.push(saved.meta.last_row_id);
              }
              await env.DB.batch(prepared.map(entry => env.DB.prepare("INSERT INTO material_records(student_id,material_id,status,r2_key,filename,submitted_at) VALUES(?,?,'已交',?,?,?) ON CONFLICT(student_id,material_id) DO UPDATE SET status='已交',r2_key=excluded.r2_key,filename=excluded.filename,submitted_at=excluded.submitted_at")
                .bind(entry.item.studentId, entry.item.materialId, entry.key, entry.item.filename, iso())));
            } catch (error) { for (const checkId of checkIds) await env.DB.prepare("DELETE FROM checks WHERE id=?").bind(checkId).run(); throw error; }
          }
        } catch (error) { await Promise.all(uploaded.map(key => env.FILES.delete(key))); throw error; }
        result = { count: prepared.length, message: "已将 " + prepared.length + " 份文件上传至预览中列出的指定位置。" };
      }
      await env.DB.prepare("UPDATE office_plans SET status='done',result_json=? WHERE id=?").bind(JSON.stringify({ count: result.count }), planId).run();
      return json({ ok: true, ...result });
    } catch (error) {
      await env.DB.prepare("UPDATE office_plans SET status='pending' WHERE id=? AND status='running'").bind(planId).run();
      throw error;
    }
  }
  return null;
}

async function scheduled(env) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await env.DB.prepare("INSERT OR IGNORE INTO notifications(student_id,kind,title,content,node_slug) SELECT p.user_id,'deadline','节点提醒：' || n.name,'您当前处于「' || n.name || '」节点，时间要求：' || COALESCE(NULLIF(n.duration_rule,''),'请按计划推进') || '。请及时准备相关材料。',n.slug FROM profiles p JOIN nodes n ON n.slug=p.current_node_slug WHERE p.node_entered_at IS NOT NULL AND n.duration_days>0 AND n.remind_days_before>0 AND date(p.node_entered_at,'+' || (n.duration_days-n.remind_days_before) || ' days')<=date(?)")
    .bind(today).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(iso()).run();
  await env.DB.prepare("DELETE FROM login_attempts WHERE reset_at<?").bind(iso()).run();
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) return secured(await env.ASSETS.fetch(request));
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if (!origin || origin !== new URL(request.url).origin) return secured(json({ ok: false, error: "请求来源无效" }, 403));
    }
    try {
      let response = await authRoutes(request, env, path);
      if (response) return secured(response);
      const user = await currentUser(request, env);
      const guestMentor = !user && (path === "/api/mentor" || path === "/api/mentor/chat" || path === "/api/mentor/retrieve");
      if (!guestMentor) assert(user, "请先登录", 401);
      if (path === "/api/change-password" && request.method === "POST") return secured(await changePassword(request, env, user));
      if (user?.must_change_password && path !== "/api/me") throw new HttpError(403, "首次登录请先修改初始密码");
      response = await officeRoutes(request, env, path, user)
        || await mentorRoutes(request, env, path, user)
        || await studentRoutes(request, env, path, user)
        || await checkRoutes(request, env, path, user)
        || await formRoutes(request, env, path, user)
        || await adminRoutes(request, env, path, user);
      return secured(response || json({ ok: false, error: "接口不存在" }, 404));
    } catch (error) {
      if (error instanceof HttpError) return secured(json({ ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status));
      console.error("request error", error);
      return secured(json({ ok: false, error: "服务器暂不可用" }, 500));
    }
  },
  async scheduled(_event, env) { await scheduled(env); }
};
