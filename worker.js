import { matchesUploadType, maxBatchBytes, maxFileBytes, uploadType } from "./upload-types.js";
import { retrieve, publicSources, modelMessages, advisoryMessages, reviewStandards, knowledgeCount } from "./rag.js";
import { mentorConfig } from "./mentor-config.js";
import { classifyIntent, decideMentorRoute, chitchatMessages, isIdentityQuestion } from "./mentor-routing.js";
import { isPersonalQuestion, isSiteHelpQuestion, personalMatches, isSelfIdentityQuestion, isChineseQuestion, isPartyDomainQuestion } from "./mentor-personal.js";
import { identifyMessages, parseIdentification, reviewMessages, parseReview, formatReview } from "./mentor-review.js";
import { isCurrentTimeQuestion, getCurrentTime } from "./mentor-time.js";
import { officeMessages, parseOfficePlan } from "./office-agent.js";
import { FORM_SCHEMA, redactPhone, looksLikeActionRequest, isAccountDeletionRequest, isProxyRequest, studentActionMessages, parseStudentAction } from "./mentor-actions.js";

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
  return env.DB.prepare("SELECT u.id,u.username,u.role,u.department_id,u.major_id,u.class_id,u.must_change_password,COALESCE(NULLIF(u.name,''),p.name) AS name,p.student_no,p.major,p.grade,p.phone,p.applied_at,p.current_stage_slug,p.current_node_slug,p.node_entered_at,p.is_graduate,cl.name AS class_name,cl.major_id AS class_major_id,m.name AS major_name,m.college_id AS major_college_id,d.name AS college_name,CASE WHEN cl.monitor_user_id=u.id THEN 1 ELSE 0 END AS is_monitor FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN profiles p ON p.user_id=u.id LEFT JOIN classes cl ON cl.id=u.class_id LEFT JOIN majors m ON m.id=COALESCE(u.major_id,cl.major_id) LEFT JOIN departments d ON d.id=COALESCE(u.department_id,m.college_id) WHERE s.token_hash=? AND s.expires_at>? AND u.deleted_at IS NULL")
    .bind(await sha256(token), iso()).first();
}
const bodyJson = request => request.json().catch(() => ({}));
const isStaff = user => user?.role === "admin" || user?.role === "counselor";
async function canReadStudent(env, user, studentId) {
  if (user.role === "admin") return true;
  if (user.role === "student") {
    if (user.id === studentId) return true;
    if (!user.is_monitor || !user.class_id) return false;
    const target = await env.DB.prepare("SELECT class_id FROM users WHERE id=? AND role='student' AND deleted_at IS NULL").bind(studentId).first();
    return !!target && target.class_id === user.class_id;
  }
  const student = await env.DB.prepare("SELECT cl.major_id FROM users u LEFT JOIN classes cl ON cl.id=u.class_id WHERE u.id=? AND u.role='student' AND u.deleted_at IS NULL").bind(studentId).first();
  return !!student && student.major_id === user.major_id;
}
async function targetStudent(env, user, studentId) {
  const student = await env.DB.prepare("SELECT u.id,u.class_id,cl.major_id,cl.name AS class_name,p.* FROM users u JOIN profiles p ON p.user_id=u.id LEFT JOIN classes cl ON cl.id=u.class_id WHERE u.id=? AND u.deleted_at IS NULL AND u.role='student'").bind(id(studentId)).first();
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
async function authRoutes(request, env, path, audit) {
  if (path === "/api/config" && request.method === "GET") {
    const count = await env.DB.prepare("SELECT count(*) AS n FROM users").first();
    const colleges = await env.DB.prepare("SELECT id,name FROM departments ORDER BY name").all();
    const majors = await env.DB.prepare("SELECT id,college_id,name FROM majors ORDER BY id").all();
    const classes = await env.DB.prepare("SELECT id,major_id,name,monitor_user_id FROM classes ORDER BY id").all();
    const headers = deviceCookie(request) ? {} : { "set-cookie": "device=" + randomHex(16) + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000" };
    return json({ ok: true, initialized: count.n > 0, colleges: colleges.results, majors: majors.results, classes: classes.results, aiEnabled: !!env.DEEPSEEK_API_KEY }, 200, headers);
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
      const result = await env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,major_id,name) VALUES(?,?,?,?,?,?,?)")
        .bind(username, data.salt, verifier, invite.role, invite.department_id, invite.major_id, name).run();
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
    const row = await env.DB.prepare("SELECT id,role,password_verifier,must_change_password,reset_password FROM users WHERE username=? COLLATE NOCASE AND deleted_at IS NULL").bind(username).first();
    const initialPassword = clean(data.initialPassword, 100);
    const got = row?.must_change_password && !row?.reset_password
      ? await hmac(env.AUTH_PEPPER, "initial:" + username.toLowerCase() + ":" + initialPassword)
      : await hmac(env.AUTH_PEPPER, username.toLowerCase() + ":" + verifier);
    assert(row && equal(row.password_verifier, got), "用户名或密码错误", 401);
    await env.DB.prepare("DELETE FROM login_attempts WHERE key=?").bind(limitKey).run();
    audit.user = { id: row.id, role: row.role };
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
    const materials = await env.DB.prepare("SELECT m.*,r.status,r.id AS record_id,r.r2_key,c.review_status,c.review_note,c.monitor_approved,c.checked_at,c.monitor_approved_at,c.reviewed_at FROM materials m LEFT JOIN material_records r ON r.material_id=m.id AND r.student_id=? LEFT JOIN checks c ON c.id=(SELECT id FROM checks WHERE student_id=r.student_id AND material_id=m.id ORDER BY id DESC LIMIT 1) WHERE m.stage_slug=? ORDER BY m.id").bind(user.id, user.current_stage_slug).all();
    const history = await env.DB.prepare("SELECT id,material_id,filename,checked_at,monitor_approved_at,reviewed_at,review_status,review_note FROM checks WHERE student_id=? AND material_id IN (SELECT id FROM materials WHERE stage_slug=?) ORDER BY id DESC LIMIT 150").bind(user.id, user.current_stage_slug).all();
    return json({ ok: true, profile: user, college: user.college_name || "", major: user.major_name || "", className: user.class_name || "", stage, node, next, materials: materials.results, submissionHistory: history.results });
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
      const org = [user.college_name, user.major_name, user.class_name].filter(Boolean).join(" · ") || "学院/专业/班级未填";
      let answer;
      if (user.role === "student") {
        const [stage, node] = await Promise.all([
          env.DB.prepare("SELECT name FROM stages WHERE slug=?").bind(user.current_stage_slug).first(),
          env.DB.prepare("SELECT name FROM nodes WHERE slug=?").bind(user.current_node_slug).first()
        ]);
        answer = en
          ? "You are " + (user.name || "—") + ", student number " + (user.student_no || "—") + ", " + (org || "—") + ", currently at the \u201c" + (stage?.name || "unset") + "\u201d stage, node \u201c" + (node?.name || "unset") + "\u201d. Contact your counselor if anything is wrong."
          : "你是" + (user.name || "未填") + "，学号 " + (user.student_no || "未填") + "，" + org + "，当前处于「" + (stage?.name || "未设置") + "」阶段，节点「" + (node?.name || "未设置") + "」。如信息有误，请联系辅导员。";
      } else {
        const roleName = user.role === "admin" ? "管理员" : "辅导员";
        answer = en
          ? "You are " + (user.name || user.username) + " (" + (user.role === "admin" ? "administrator" : "counselor") + ")" + (user.role === "counselor" ? ", " + (user.major_name || "—") : "") + "."
          : "你是" + (user.name || user.username) + "，用户名 " + user.username + "，角色：" + roleName + (user.role === "counselor" ? "，" + (user.major_name || "专业未填") : "") + "。";
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
export async function checkRoutes(request, env, path, user, audit = {}) {
  if (path === "/api/checks" && request.method === "POST") {
    assert(user.role === "student", "仅学生可上传材料", 403);
    const form = await request.formData();
    const file = form.get("file") ?? form.get("docx"), materialId = id(form.get("materialId"));
    assert(file && typeof file.arrayBuffer === "function", "请选择 Word、PDF 或图片");
    const filename = clean(file.name, 150), type = uploadType(filename);
    assert(type && file.size > 0 && file.size <= maxFileBytes, "仅支持不超过 10 MB 的 Word、PDF 或图片");
    assert(await matchesUploadType(file, type), "文件内容与扩展名不符");
    const uploadId = form.get("uploadId");
    assert(uploadId === null || /^[0-9a-f]{32}$/.test(uploadId), "提交编号无效");
    const existingUpload = async () => uploadId && await env.DB.prepare("SELECT check_id,material_id FROM upload_receipts WHERE student_id=? AND upload_id=?").bind(user.id, uploadId).first();
    const receipt = await existingUpload();
    if (receipt) {
      assert(receipt.material_id === materialId, "此提交编号已用于其他材料", 409);
      audit.targets = "check:" + receipt.check_id;
      return json({ ok: true, id: receipt.check_id, repeated: true });
    }
    const material = await env.DB.prepare("SELECT id,name FROM materials WHERE id=?").bind(materialId).first();
    assert(material, "材料类型不存在", 404);
    let results;
    try { results = validateResults(JSON.parse(String(form.get("results") || "[]"))); }
    catch { throw new HttpError(400, "质检结果无效"); }
    const key = "checks/" + user.id + "/" + randomHex(16) + "." + type.ext;
    // 本班设了班长则需班长先审核，否则直接进入辅导员审核
    const cls = await env.DB.prepare("SELECT cl.monitor_user_id FROM classes cl JOIN users m ON m.id=cl.monitor_user_id AND m.deleted_at IS NULL WHERE cl.id=?").bind(user.class_id || 0).first();
    const monitorApproved = cls?.monitor_user_id ? 0 : 1;
    await env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type.mime } });
    let checkId = null;
    try {
      const insert = env.DB.prepare("INSERT INTO checks(student_id,material_id,r2_key,filename,monitor_approved,upload_id) VALUES(?,?,?,?,?,?)")
        .bind(user.id, materialId, key, filename, monitorApproved, uploadId);
      const materialRecord = env.DB.prepare("INSERT INTO material_records(student_id,material_id,status,r2_key,filename,submitted_at) VALUES(?,?,'已交',?,?,?) ON CONFLICT(student_id,material_id) DO UPDATE SET status='已交',r2_key=excluded.r2_key,filename=excluded.filename,submitted_at=excluded.submitted_at")
        .bind(user.id, materialId, key, filename, iso());
      if (uploadId) {
        const [saved] = await env.DB.batch([
          insert,
          ...results.map(result => env.DB.prepare("INSERT INTO check_results(check_id,kind,code,message,severity,suggestion) SELECT id,?,?,?,?,? FROM checks WHERE student_id=? AND upload_id=?")
            .bind(result.kind, result.code, result.message, result.severity, result.suggestion, user.id, uploadId)),
          materialRecord,
          env.DB.prepare("INSERT INTO upload_receipts(student_id,upload_id,check_id,material_id) SELECT student_id,upload_id,id,material_id FROM checks WHERE student_id=? AND upload_id=?").bind(user.id, uploadId)
        ]);
        checkId = saved.meta.last_row_id;
      } else {
        checkId = (await insert.run()).meta.last_row_id;
        await env.DB.batch([
          ...results.map(result => env.DB.prepare("INSERT INTO check_results(check_id,kind,code,message,severity,suggestion) VALUES(?,?,?,?,?,?)")
            .bind(checkId, result.kind, result.code, result.message, result.severity, result.suggestion)),
          materialRecord
        ]);
      }
      audit.targets = "check:" + checkId;
      return json({ ok: true, id: checkId, results }, 201);
    } catch (error) {
      if (checkId) await env.DB.prepare("DELETE FROM checks WHERE id=?").bind(checkId).run();
      await env.FILES.delete(key);
      const duplicate = await existingUpload();
      if (duplicate?.material_id === materialId) return json({ ok: true, id: duplicate.check_id, repeated: true });
      throw error;
    }
  }
  if (path === "/api/checks" && request.method === "GET") {
    const params = new URL(request.url).searchParams;
    const allClasses = user.role === "admin";
    const classScope = user.role === "student"
      ? user.is_monitor ? ["u.class_id=?", user.class_id] : ["c.student_id=?", user.id]
      : allClasses ? null : ["cl.major_id=?", user.major_id];
    const currentCheckCondition = "c.id=(SELECT MAX(previous.id) FROM checks previous WHERE previous.student_id=c.student_id AND previous.material_id=c.material_id)";
    const conditions = ["u.deleted_at IS NULL", currentCheckCondition], values = [];
    if (classScope) { conditions.push(classScope[0]); values.push(classScope[1]); }
    if (params.get("classId")) { conditions.push("u.class_id=?"); values.push(id(params.get("classId"))); }
    const statuses = {
      staff: "c.review_status='待审阅' AND c.monitor_approved=1",
      monitor: "c.review_status='待审阅' AND c.monitor_approved=0",
      approved: "c.review_status='已通过'", returned: "c.review_status='退回修改'"
    };
    if (Object.hasOwn(statuses, params.get("status"))) conditions.push(statuses[params.get("status")]);
    if (params.get("since")) {
      assert(/^\d{4}-\d{2}-\d{2}$/.test(params.get("since")), "日期无效");
      conditions.push("datetime(c.checked_at)>=datetime(?)");
      const since = Date.parse(params.get("since") + "T00:00:00+08:00");
      assert(Number.isFinite(since), "日期无效");
      values.push(new Date(since).toISOString());
    }
    if (params.get("before")) { conditions.push("c.id<?"); values.push(id(params.get("before"))); }
    const query = "SELECT c.id,c.student_id,c.material_id,c.filename,c.checked_at,c.review_status,c.review_note,c.monitor_approved,m.name AS material_name,p.name AS student_name,u.class_id,cl.name AS class_name FROM checks c JOIN materials m ON m.id=c.material_id JOIN profiles p ON p.user_id=c.student_id JOIN users u ON u.id=c.student_id LEFT JOIN classes cl ON cl.id=u.class_id WHERE ";
    const { results } = await env.DB.prepare(query + conditions.join(" AND ") + " ORDER BY c.id DESC LIMIT 51").bind(...values).all();
    const classes = user.role === "student" ? { results: [] } : allClasses
      ? await env.DB.prepare("SELECT id,name FROM classes ORDER BY name").all()
      : await env.DB.prepare("SELECT id,name FROM classes WHERE major_id=? ORDER BY name").bind(user.major_id).all();
    return json({ ok: true, checks: results.slice(0, 50), classes: classes.results, next: results.length > 50 ? results[49].id : null });
  }
  if (path === "/api/checks/monitor-approve" && request.method === "POST") {
    assert(user.role === "student" && user.is_monitor && user.class_id, "仅班长可执行此操作", 403);
    const ids = selectedIds((await bodyJson(request)).checkIds);
    audit.targets = ids.join(",");
    const marks = ids.map(() => "?").join(",");
    const rows = await env.DB.prepare("SELECT c.id,c.student_id,c.monitor_approved,c.review_status,u.class_id FROM checks c JOIN users u ON u.id=c.student_id WHERE u.deleted_at IS NULL AND c.id IN (" + marks + ") AND c.id=(SELECT MAX(previous.id) FROM checks previous WHERE previous.student_id=c.student_id AND previous.material_id=c.material_id)").bind(...ids).all();
    assert(rows.results.length === ids.length, "部分材料不存在", 404);
    for (const row of rows.results) {
      assert(row.class_id === user.class_id, "只能审核本班同学提交的材料", 403);
      assert(row.review_status === "待审阅" && row.monitor_approved === 0, "该材料已审核或不是待班长审核状态", 409);
    }
    await env.DB.batch(rows.results.map(row => env.DB.prepare("UPDATE checks SET monitor_approved=1,monitor_approved_at=? WHERE id=?").bind(iso(), row.id)));
    return json({ ok: true, count: rows.results.length });
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
    return fileResponse(object, row.filename, uploadType(row.filename, true)?.mime || "application/octet-stream");
  }
  return null;
}

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
    const uploadId = form.get("uploadId");
    assert(uploadId === null || /^[0-9a-f]{32}$/.test(uploadId), "提交编号无效");
    const existing = () => uploadId ? env.DB.prepare("SELECT id FROM form_templates WHERE uploaded_by=? AND upload_id=?").bind(user.id, uploadId).first() : null;
    const previous = await existing();
    if (previous) return json({ ok: true, id: previous.id, repeated: true });
    const title = clean(form.get("title"), 100), stageSlug = clean(form.get("stageSlug"), 80);
    const stage = await env.DB.prepare("SELECT slug FROM stages WHERE slug=?").bind(stageSlug).first();
    assert(stage && title, "请选择阶段并填写表格名称");
    const file = form.get("file");
    assert(file && typeof file.arrayBuffer === "function", "请选择表格文件");
    const filename = clean(file.name, 150), type = uploadType(filename, true);
    assert(type && file.size > 0 && file.size <= maxFileBytes, "仅支持不超过 10 MB 的 Word、Excel、PDF 或图片");
    assert(await matchesUploadType(file, type), "文件内容与扩展名不符");
    const departmentId = user.role === "admin" ? null : user.department_id;
    assert(user.role === "admin" || departmentId, "辅导员尚未分配院系", 403);
    const key = "forms/" + (departmentId || "global") + "/" + randomHex(16) + "." + filename.split(".").at(-1).toLowerCase();
    await env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type.mime } });
    try {
      const saved = await env.DB.prepare("INSERT INTO form_templates(stage_slug,department_id,title,filename,r2_key,uploaded_by,upload_id) VALUES(?,?,?,?,?,?,?)")
        .bind(stageSlug, departmentId, title, filename, key, user.id, uploadId).run();
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
    return fileResponse(object, row.filename, uploadType(row.filename, true)?.mime || "application/octet-stream");
  }
  return null;
}

async function registerCounselors(env, user, data) {
  requireSecret(env);
  assert(user.role === "admin", "仅管理员可批量添加辅导员", 403);
  const majorId = id(data.majorId);
  const major = await env.DB.prepare("SELECT id,college_id FROM majors WHERE id=?").bind(majorId).first();
  assert(major, "专业不存在", 404);
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
    statements.push(env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,major_id,name,must_change_password) VALUES(?,?,?,'counselor',?,?,?,1)").bind(counselor.username, salt, initial, major.college_id, majorId, counselor.name));
  }
  try { await env.DB.batch(statements); }
  catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "部分用户名已注册，请刷新名单后重试");
    throw error;
  }
  return json({ ok: true, count: counselors.length }, 201);
}

function auditStatement(env, user, action, method, status, targets = null) {
  return env.DB.prepare("INSERT INTO operation_logs(actor_id,actor_role,action,method,status,targets) VALUES(?,?,?,?,?,?)")
    .bind(user?.id ?? null, user?.role ?? null, action, method, status, targets);
}

async function archiveUsers(env, user, ids, role, finish) {
  const marks = ids.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET deleted_at=? WHERE deleted_at IS NULL AND role=? AND id IN (" + marks + ")").bind(iso(), role, ...ids),
    env.DB.prepare("DELETE FROM sessions WHERE user_id IN (" + marks + ")").bind(...ids),
    env.DB.prepare("UPDATE checks SET monitor_approved=1 WHERE review_status='待审阅' AND student_id IN (SELECT p.id FROM users p JOIN classes c ON c.id=p.class_id WHERE c.monitor_user_id IN (" + marks + "))").bind(...ids),
    auditStatement(env, user, "archive_" + role, "POST", 200, ids.join(",")),
    ...(finish ? [finish] : [])
  ]);
}

async function managementRecords(request, env, path, user) {
  if (!["/api/admin/operation-logs", "/api/admin/recycle", "/api/admin/recycle/restore"].includes(path)) return null;
  assert(isStaff(user), "仅工作人员可查看", 403);
  if (path === "/api/admin/operation-logs" && request.method === "GET") {
    const before = new URL(request.url).searchParams.get("before");
    const scope = user.role === "admin" ? "" : " AND l.actor_id=?";
    const { results } = await env.DB.prepare("SELECT l.*,COALESCE(NULLIF(u.name,''),u.username) AS actor_name FROM operation_logs l LEFT JOIN users u ON u.id=l.actor_id WHERE l.id<?" +
      scope + " ORDER BY l.id DESC LIMIT 51").bind(before ? id(before) : Number.MAX_SAFE_INTEGER, ...(scope ? [user.id] : [])).all();
    return json({ ok: true, logs: results.slice(0, 50), next: results.length > 50 ? results[49].id : null });
  }
  const scope = user.role === "admin" ? "" : " AND u.role='student' AND cl.major_id=?";
  const args = scope ? [user.major_id] : [];
  if (path === "/api/admin/recycle" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT u.id,u.username,u.name,u.role,u.deleted_at,cl.name AS class_name FROM users u LEFT JOIN classes cl ON cl.id=u.class_id WHERE u.deleted_at IS NOT NULL" +
      scope + " ORDER BY u.deleted_at DESC LIMIT 200").bind(...args).all();
    return json({ ok: true, accounts: results });
  }
  if (path === "/api/admin/recycle/restore" && request.method === "POST") {
    const accountId = id((await bodyJson(request)).userId);
    const account = await env.DB.prepare("SELECT u.id FROM users u LEFT JOIN classes cl ON cl.id=u.class_id WHERE u.id=? AND u.deleted_at IS NOT NULL" +
      scope).bind(accountId, ...args).first();
    assert(account, "找不到可恢复的账号", 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL").bind(accountId),
      auditStatement(env, user, "restore_account", "POST", 200, String(accountId))
    ]);
    return json({ ok: true });
  }
  return null;
}

async function deleteCounselors(env, user, data, expectedIds = null) {
  assert(user.role === "admin", "仅管理员可删除辅导员", 403);
  const usernames = Array.isArray(data.usernames) ? data.usernames.map(value => clean(value, 40)).filter(Boolean) : [];
  assert(usernames.length >= 1 && usernames.length <= 50, "请输入 1 至 50 个用户名");
  const marks = usernames.map(() => "?").join(",");
  const rows = await env.DB.prepare("SELECT id,username FROM users WHERE role='counselor' AND deleted_at IS NULL AND username IN (" + marks + ")").bind(...usernames).all();
  assert(rows.results.length === usernames.length, "部分辅导员用户名不存在", 404);
  const ids = rows.results.map(row => row.id);
  if (expectedIds) assert(ids.every(value => expectedIds.includes(value)), "辅导员账号已变更，请重新核对名单", 409);
  await archiveUsers(env, user, ids, "counselor");
  return json({ ok: true, count: ids.length });
}

async function advanceStudents(env, user, data, approved = null, finish = null) {
  const ids = selectedIds(data.studentIds);
  const stages = (await env.DB.prepare("SELECT slug,name FROM stages ORDER BY position").all()).results;
  const students = await Promise.all(ids.map(studentId => targetStudent(env, user, studentId)));
  const updates = [];
  for (const student of students) {
    if (approved) assert(approved.find(item => item.id === student.id)?.stage === student.current_stage_slug, student.name + "的阶段已变化，请重新预览", 409);
    const next = stages[stages.findIndex(stage => stage.slug === student.current_stage_slug) + 1];
    assert(next, student.name + "已在最后阶段，无法继续推进", 409);
    const firstNode = await env.DB.prepare("SELECT slug FROM nodes WHERE stage_slug=? ORDER BY position LIMIT 1").bind(next.slug).first();
    assert(firstNode, next.name + "尚无培养节点", 409);
    updates.push({ student, next, firstNode });
  }
  const today = iso().slice(0, 10);
  await env.DB.batch([...updates.flatMap(({ student, next, firstNode }) => [
    env.DB.prepare("UPDATE profiles SET current_stage_slug=?,current_node_slug=?,node_entered_at=? WHERE user_id=?").bind(next.slug, firstNode.slug, today, student.id),
    env.DB.prepare("INSERT INTO notifications(student_id,kind,title,content) VALUES(?,'lesson',?,?)").bind(student.id, "培养阶段已更新", "你的培养档案已推进至「" + next.name + "」，请查看本阶段材料清单。")
  ]), ...(finish ? [finish] : [])]);
  return json({ ok: true, count: updates.length });
}

async function deleteStudents(env, user, data, finish = null) {
  const ids = selectedIds(data.studentIds);
  await Promise.all(ids.map(studentId => targetStudent(env, user, studentId)));
  await archiveUsers(env, user, ids, "student", finish);
  return json({ ok: true, count: ids.length });
}

async function reviewChecks(env, user, data, finish = null) {
  const ids = selectedIds(data.checkIds);
  const status = clean(data.status, 20), note = clean(data.note, 500);
  assert(["已通过", "退回修改"].includes(status), "审阅状态无效");
  assert(status !== "退回修改" || note, "退回材料时请填写修改说明");
  const marks = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare("SELECT c.id,c.student_id,c.material_id,c.review_status,c.monitor_approved,c.filename,m.name AS material_name,cl.major_id FROM checks c JOIN users u ON u.id=c.student_id JOIN materials m ON m.id=c.material_id LEFT JOIN classes cl ON cl.id=u.class_id WHERE u.deleted_at IS NULL AND c.id IN (" + marks + ")").bind(...ids).all();
  assert(rows.results.length === ids.length, "部分材料不存在", 404);
  const updates = [];
  for (const row of rows.results) {
    assert(user.role === "admin" || row.major_id === user.major_id, "无权审阅其他专业材料", 403);
    assert(row.monitor_approved === 1, row.filename + "尚未经班长审核", 409);
    assert(row.review_status === "待审阅", row.filename + "已审阅，请刷新列表", 409);
    const latest = await env.DB.prepare("SELECT id FROM checks WHERE student_id=? AND material_id=? ORDER BY id DESC LIMIT 1").bind(row.student_id, row.material_id).first();
    assert(latest?.id === row.id, row.filename + "已被新提交版本替代", 409);
    updates.push(row);
  }
  await env.DB.batch([...updates.flatMap(row => [
    env.DB.prepare("UPDATE checks SET review_status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?").bind(status, note, user.id, iso(), row.id),
    env.DB.prepare("UPDATE material_records SET status=? WHERE student_id=? AND material_id=?").bind(status === "已通过" ? "已通过" : "未交", row.student_id, row.material_id),
    env.DB.prepare("INSERT INTO notifications(student_id,kind,title,content) VALUES(?,'lesson',?,?)").bind(row.student_id, "材料审阅结果：" + row.material_name, status === "已通过" ? "你提交的「" + row.material_name + "」已通过审阅。" : "你提交的「" + row.material_name + "」需修改：" + note)
  ]), ...(finish ? [finish] : [])]);
  return json({ ok: true, count: updates.length });
}

async function createDepartment(env, user, data, finish = null) {
  assert(user.role === "admin", "仅管理员可维护学院", 403);
  const name = clean(data.name, 100);
  assert(name, "请输入学院名称");
  const insert = env.DB.prepare("INSERT INTO departments(name) VALUES(?)").bind(name);
  const result = finish ? (await env.DB.batch([insert, finish]))[0] : await insert.run();
  return json({ ok: true, departmentId: result.meta.last_row_id }, 201);
}

async function createMajor(env, user, data) {
  assert(user.role === "admin", "仅管理员可维护专业", 403);
  const collegeId = id(data.collegeId), name = clean(data.name, 100);
  assert(name, "请输入专业名称");
  assert(await env.DB.prepare("SELECT id FROM departments WHERE id=?").bind(collegeId).first(), "学院不存在", 404);
  const result = await env.DB.prepare("INSERT INTO majors(college_id,name) VALUES(?,?)").bind(collegeId, name).run();
  return json({ ok: true, majorId: result.meta.last_row_id }, 201);
}

async function createClass(env, user, data) {
  assert(isStaff(user), "仅辅导员或管理员可维护班级", 403);
  const majorId = id(data.majorId), name = clean(data.name, 100);
  assert(name, "请输入班级名称");
  const major = await env.DB.prepare("SELECT id FROM majors WHERE id=?").bind(majorId).first();
  assert(major && (user.role === "admin" || majorId === user.major_id), "专业不存在或不在管理范围内", 404);
  const result = await env.DB.prepare("INSERT INTO classes(major_id,name) VALUES(?,?)").bind(majorId, name).run();
  return json({ ok: true, classId: result.meta.last_row_id }, 201);
}

async function setMonitor(env, user, data) {
  assert(isStaff(user), "仅辅导员或管理员可设置班长", 403);
  const classId = id(data.classId), studentId = id(data.studentId);
  const cls = await env.DB.prepare("SELECT id,major_id FROM classes WHERE id=?").bind(classId).first();
  assert(cls && (user.role === "admin" || cls.major_id === user.major_id), "班级不存在或不在管理范围内", 404);
  const student = await env.DB.prepare("SELECT id,class_id FROM users WHERE id=? AND role='student' AND deleted_at IS NULL").bind(studentId).first();
  assert(student && student.class_id === classId, "学生不存在或不在该班级", 404);
  await env.DB.prepare("UPDATE classes SET monitor_user_id=? WHERE id=?").bind(studentId, classId).run();
  return json({ ok: true });
}

async function createInvites(env, user, data, finish = null) {
  assert(user.role === "admin", "仅管理员可邀请辅导员", 403);
  const role = clean(data.role, 20), majorId = id(data.majorId);
  assert(role === "counselor", "邀请码仅用于辅导员注册");
  const major = await env.DB.prepare("SELECT id,college_id FROM majors WHERE id=?").bind(majorId).first();
  assert(major, "专业不存在", 404);
  const count = Number(data.count ?? 1);
  assert(Number.isSafeInteger(count) && count >= 1 && count <= 50, "一次可生成 1 至 50 个邀请码");
  const codes = Array.from({ length: count }, () => randomHex(24));
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const inserts = await Promise.all(codes.map(async code => env.DB.prepare("INSERT INTO invites(code_hash,role,department_id,major_id,expires_at,created_by) VALUES(?,?,?,?,?,?)")
    .bind(await sha256(code), role, major.college_id, majorId, expiresAt, user.id)));
  await env.DB.batch([...inserts, ...(finish ? [finish] : [])]);
  return json({ ok: true, codes, code: codes[0], expiresInDays: 7 }, 201);
}

export async function adminRoutes(request, env, path, user, audit = {}) {
  if (!path.startsWith("/api/admin/")) return null;
  assert(isStaff(user), "需要辅导员或管理员权限", 403);
  if (path === "/api/admin/students/auto-register" && request.method === "POST") {
    requireSecret(env);
    assert(user.role === "counselor", "仅辅导员可执行自动注册", 403);
    assert(user.major_id, "辅导员尚未分配专业", 403);
    const data = await bodyJson(request);
    const classId = id(data.classId);
    const cls = await env.DB.prepare("SELECT id,major_id FROM classes WHERE id=?").bind(classId).first();
    assert(cls && cls.major_id === user.major_id, "班级不存在或不属于你的专业", 404);
    const collegeId = (await env.DB.prepare("SELECT college_id FROM majors WHERE id=?").bind(cls.major_id).first())?.college_id;
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
      statements.push(env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,class_id,name,must_change_password) VALUES(?,?,?,'student',?,?,?,1)")
        .bind(student.studentNo, salt, initial, collegeId, classId, student.name));
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
    const filters = new URL(request.url).searchParams;
    const q = clean(filters.get("q") || "", 50);
    const cond = ["u.deleted_at IS NULL"], args = [];
    if (user.role !== "admin") { cond.push("cl.major_id=?"); args.push(user.major_id); }
    if (filters.has("classId")) { cond.push("u.class_id=?"); args.push(id(filters.get("classId"))); }
    if (q) { cond.push("(p.name LIKE ? OR p.student_no LIKE ?)"); args.push("%" + q + "%", "%" + q + "%"); }
    const where = cond.length ? " WHERE " + cond.join(" AND ") : "";
    const students = await env.DB.prepare("SELECT u.id,u.username,u.class_id,cl.name AS class_name,cl.major_id,m.name AS major_name,m.college_id,d.name AS college_name,p.* FROM users u JOIN profiles p ON p.user_id=u.id LEFT JOIN classes cl ON cl.id=u.class_id LEFT JOIN majors m ON m.id=cl.major_id LEFT JOIN departments d ON d.id=m.college_id" + where + " ORDER BY p.student_no LIMIT 500").bind(...args).all();
    const colleges = await env.DB.prepare("SELECT id,name FROM departments ORDER BY name").all();
    const majors = await env.DB.prepare("SELECT id,college_id,name FROM majors ORDER BY id").all();
    const classes = await env.DB.prepare("SELECT id,major_id,name,monitor_user_id FROM classes ORDER BY id").all();
    const nodes = await env.DB.prepare("SELECT slug,stage_slug,name,position FROM nodes ORDER BY stage_slug,position").all();
    const materials = await env.DB.prepare("SELECT id,name,stage_slug FROM materials ORDER BY id").all();
    const invites = user.role === "admin"
      ? await env.DB.prepare("SELECT i.id,i.role,i.major_id,m.name AS major_name,i.expires_at,i.used_by FROM invites i LEFT JOIN majors m ON m.id=i.major_id ORDER BY i.id DESC LIMIT 100").all()
      : await env.DB.prepare("SELECT i.id,i.role,i.major_id,m.name AS major_name,i.expires_at,i.used_by FROM invites i LEFT JOIN majors m ON m.id=i.major_id WHERE i.major_id=? ORDER BY i.id DESC LIMIT 100").bind(user.major_id).all();
    const counselors = user.role === "admin"
      ? await env.DB.prepare("SELECT u.id,u.username,u.major_id,m.name AS major_name,m.college_id,d.name AS college_name,u.name,u.created_at FROM users u LEFT JOIN majors m ON m.id=u.major_id LEFT JOIN departments d ON d.id=m.college_id WHERE u.role='counselor' AND u.deleted_at IS NULL ORDER BY u.id").all()
      : await env.DB.prepare("SELECT u.id,u.username,u.major_id,m.name AS major_name,m.college_id,d.name AS college_name,u.name,u.created_at FROM users u LEFT JOIN majors m ON m.id=u.major_id LEFT JOIN departments d ON d.id=m.college_id WHERE u.role='counselor' AND u.deleted_at IS NULL AND u.major_id=?").bind(user.major_id).all();
    return json({ ok: true, students: students.results, counselors: counselors.results, colleges: colleges.results, majors: majors.results, classes: classes.results, nodes: nodes.results, materials: materials.results, invites: invites.results });
  }
  if (path === "/api/admin/students/bulk-advance" && request.method === "POST") {
    const data = await bodyJson(request);
    audit.targets = selectedIds(data.studentIds).join(",");
    return advanceStudents(env, user, data);
  }
  if (path === "/api/admin/students/bulk-delete" && request.method === "POST") {
    return deleteStudents(env, user, await bodyJson(request));
  }
  if (path === "/api/admin/students" && request.method === "POST") {
    requireSecret(env);
    const data = await bodyJson(request);
    const name = clean(data.name, 50), studentNo = clean(data.studentNo, 40);
    assert(/^[\p{Script=Han}·]{2,20}$/u.test(name), "姓名须为 2 至 20 个汉字或间隔号");
    assert(/^\d{6,20}$/.test(studentNo), "学号须为 6 至 20 位数字");
    const classId = id(data.classId);
    const cls = await env.DB.prepare("SELECT id,major_id FROM classes WHERE id=?").bind(classId).first();
    assert(cls && (user.role === "admin" || cls.major_id === user.major_id), "班级不存在或不在管理范围内", 404);
    const collegeId = (await env.DB.prepare("SELECT college_id FROM majors WHERE id=?").bind(cls.major_id).first())?.college_id;
    const existing = await env.DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(studentNo).first();
    assert(!existing, "该学号已注册", 409);
    const salt = randomHex(16);
    const initial = await hmac(env.AUTH_PEPPER, "initial:" + studentNo.toLowerCase() + ":cauc+" + studentNo);
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,class_id,name,must_change_password) VALUES(?,?,?,'student',?,?,?,1)").bind(studentNo, salt, initial, collegeId, classId, name),
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
    const majorId = id(data.majorId);
    const major = await env.DB.prepare("SELECT id,college_id FROM majors WHERE id=?").bind(majorId).first();
    assert(major, "专业不存在", 404);
    const existing = await env.DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
    assert(!existing, "该用户名已存在", 409);
    const salt = randomHex(16);
    const initial = await hmac(env.AUTH_PEPPER, "initial:" + username.toLowerCase() + ":cauc+" + username);
    await env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,major_id,name,must_change_password) VALUES(?,?,?,'counselor',?,?,?,1)").bind(username, salt, initial, major.college_id, majorId, name).run();
    return json({ ok: true, name, username }, 201);
  }
  if (path === "/api/admin/counselors/auto-register" && request.method === "POST") {
    return registerCounselors(env, user, await bodyJson(request));
  }
  if (path === "/api/admin/counselors/bulk-delete" && request.method === "POST") {
    return deleteCounselors(env, user, await bodyJson(request));
  }
  if (path === "/api/admin/checks/bulk-review" && request.method === "POST") {
    const data = await bodyJson(request);
    audit.targets = selectedIds(data.checkIds).join(",");
    return reviewChecks(env, user, data);
  }
  const filesMatch = /^\/api\/admin\/students\/(\d+)\/files$/.exec(path);
  if (filesMatch && request.method === "GET") {
    const student = await targetStudent(env, user, filesMatch[1]);
    const rows = await env.DB.prepare("SELECT c.id,c.filename,c.checked_at,c.review_status,c.review_note,m.name AS material_name,s.name AS stage_name FROM checks c JOIN materials m ON m.id=c.material_id JOIN stages s ON s.slug=m.stage_slug WHERE c.student_id=? ORDER BY c.checked_at DESC,c.id DESC LIMIT 100").bind(student.id).all();
    return json({ ok: true, files: rows.results });
  }
  if (path === "/api/admin/departments" && request.method === "POST") {
    return createDepartment(env, user, await bodyJson(request));
  }
  if (path === "/api/admin/majors" && request.method === "POST") {
    return createMajor(env, user, await bodyJson(request));
  }
  if (path === "/api/admin/classes" && request.method === "POST") {
    return createClass(env, user, await bodyJson(request));
  }
  if (path === "/api/admin/classes/monitor" && request.method === "POST") {
    return setMonitor(env, user, await bodyJson(request));
  }
  if (path === "/api/admin/invites" && request.method === "POST") {
    return createInvites(env, user, await bodyJson(request));
  }
  const studentMatch = /^\/api\/admin\/students\/(\d+)$/.exec(path);
  const profileMatch = /^\/api\/admin\/students\/(\d+)\/profile$/.exec(path);
  if (profileMatch && request.method === "POST") {
    const student = await targetStudent(env, user, profileMatch[1]);
    const data = await bodyJson(request);
    const classId = id(data.classId);
    const cls = await env.DB.prepare("SELECT id,major_id FROM classes WHERE id=?").bind(classId).first();
    assert(cls && (user.role === "admin" || cls.major_id === user.major_id), "班级不存在或不在管理范围内", 404);
    const collegeId = (await env.DB.prepare("SELECT college_id FROM majors WHERE id=?").bind(cls.major_id).first())?.college_id;
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET class_id=?,department_id=? WHERE id=?").bind(classId, collegeId, student.id),
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
    audit.targets = String(student.id);
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
    ? await env.DB.prepare("SELECT u.id,u.username,u.class_id,p.name,p.student_no,p.current_stage_slug,p.grade FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.role='student' AND u.deleted_at IS NULL AND (p.student_no=? OR p.name=?) LIMIT 3").bind(value, value).all()
    : await env.DB.prepare("SELECT u.id,u.username,u.class_id,p.name,p.student_no,p.current_stage_slug,p.grade FROM users u JOIN profiles p ON p.user_id=u.id LEFT JOIN classes cl ON cl.id=u.class_id WHERE u.role='student' AND u.deleted_at IS NULL AND cl.major_id=? AND (p.student_no=? OR p.name=?) LIMIT 3").bind(user.major_id, value, value).all();
  assert(rows.results.length, "找不到可管理的学生：" + value, 404);
  assert(rows.results.length === 1, "姓名“" + value + "”对应多位学生，请使用学号", 409);
  return rows.results[0];
}

const studentLabel = student => student.name + "（" + student.student_no + "）";

async function officeAudience(env, user, action, limit) {
  if (action.students !== undefined) {
    assert(action.audience === undefined, "请选择学生名单或筛选条件中的一种");
    const list = action.students;
    assert(Array.isArray(list) && list.length > 0 && list.length <= limit &&
      list.every(item => typeof item?.student === "string" && item.student.trim()), "请提供 1 至 " + limit + " 名学生的姓名或学号");
    const identifiers = list.map(item => clean(item.student, 50));
    const scope = user.role === "admin" ? "" : " AND cl.major_id=?";
    const { results } = await env.DB.prepare("WITH targets(value) AS (SELECT value FROM json_each(?)) " +
      "SELECT u.id,p.name,p.student_no,p.grade,p.current_stage_slug FROM users u JOIN profiles p ON p.user_id=u.id LEFT JOIN classes cl ON cl.id=u.class_id WHERE u.role='student' AND u.deleted_at IS NULL" +
      " AND (p.student_no IN (SELECT value FROM targets) OR p.name IN (SELECT value FROM targets))" + scope)
      .bind(JSON.stringify(identifiers), ...(scope ? [user.major_id] : [])).all();
    const students = identifiers.map(value => {
      const matches = results.filter(student => student.student_no === value || student.name === value);
      assert(matches.length, "找不到可管理的学生：" + value, 404);
      assert(matches.length === 1, "姓名“" + value + "”对应多位学生，请使用学号", 409);
      return matches[0];
    });
    assert(new Set(students.map(student => student.id)).size === students.length, "名单中有重复的学生");
    return students;
  }
  const filters = action.audience ?? {};
  assert(filters && typeof filters === "object" && !Array.isArray(filters), "学生筛选条件无效");
  const clauses = ["u.role='student'","u.deleted_at IS NULL"], args = [];
  if (filters.majorId !== undefined) {
    const majorId = id(filters.majorId);
    assert(user.role === "admin" || majorId === user.major_id, "无权访问其他专业学生", 403);
    clauses.push("cl.major_id=?"); args.push(majorId);
  } else if (filters.classId !== undefined) {
    const classId = id(filters.classId);
    clauses.push("u.class_id=?"); args.push(classId);
    if (user.role !== "admin") assert(await env.DB.prepare("SELECT id FROM classes WHERE id=? AND major_id=?").bind(classId, user.major_id).first(), "无权访问其他班级学生", 403);
  } else if (user.role !== "admin") {
    clauses.push("cl.major_id=?"); args.push(user.major_id);
  }
  for (const [field, column, max] of [["stageSlug", "p.current_stage_slug", 80], ["grade", "p.grade", 20]]) {
    if (filters[field] === undefined) continue;
    const value = clean(filters[field], max);
    assert(value, "学生筛选条件不能为空");
    clauses.push(column + "=?"); args.push(value);
  }
  if (action.type === "send_notifications") {
    assert(["majorId", "classId", "stageSlug", "grade"].some(field => filters[field] !== undefined), "请提供收件人名单，或指定专业、班级、阶段或年级");
  }
  return (await env.DB.prepare("SELECT u.id,p.name,p.student_no,p.grade,p.current_stage_slug FROM users u JOIN profiles p ON p.user_id=u.id LEFT JOIN classes cl ON cl.id=u.class_id WHERE " +
    clauses.join(" AND ") + " ORDER BY p.student_no LIMIT ?").bind(...args, limit + 1).all()).results;
}

async function executeOfficeTask(env, user, plan, planId) {
  const count = plan.studentIds?.length ?? plan.checkIds?.length ?? plan.count ?? 1;
  const finish = env.DB.prepare("UPDATE office_plans SET status='done',result_json=? WHERE id=?")
    .bind(JSON.stringify({ count }), planId);
  switch (plan.type) {
    case "delete_students": {
      await deleteStudents(env, user, plan, finish);
      return { count, message: "已将 " + count + " 名学生移入回收站。" };
    }
    case "send_notifications": {
      const ids = selectedIds(plan.studentIds, 50);
      const marks = ids.map(() => "?").join(",");
      const scope = user.role === "admin" ? "" : " AND id IN (SELECT u.id FROM users u LEFT JOIN classes cl ON cl.id=u.class_id WHERE cl.major_id=?)";
      const { results } = await env.DB.prepare("SELECT id FROM users WHERE role='student' AND deleted_at IS NULL AND id IN (" + marks + ")" + scope)
        .bind(...ids, ...(scope ? [user.major_id] : [])).all();
      assert(results.length === ids.length, "部分收件人已变更或不在管理范围内，请重新预览", 409);
      await env.DB.batch([...ids.map(studentId => env.DB.prepare("INSERT INTO notifications(student_id,kind,title,content) VALUES(?,'lesson',?,?)")
        .bind(studentId, plan.title, plan.content)), finish]);
      return { count, message: "站内信已发送给 " + count + " 名学生，可在学生端通知中心查看。" };
    }
    case "advance_students":
      await advanceStudents(env, user, plan, plan.approved, finish);
      return { count, message: "已推进 " + count + " 名学生的培养阶段，并发送站内通知。" };
    case "review_materials":
      await reviewChecks(env, user, plan, finish);
      return { count, message: "已审阅 " + count + " 份材料，并发送站内通知。" };
    case "create_invites": {
      const { codes } = await (await createInvites(env, user, plan, finish)).json();
      return { count, message: "已生成 " + count + " 个辅导员邀请码，有效期 7 天：\n" + codes.join("\n") };
    }
    case "create_department":
      await createDepartment(env, user, plan, finish);
      return { count, message: "已新增学院「" + plan.name + "」。" };
    case "create_major":
      await createMajor(env, user, plan);
      await finish.run();
      return { count, message: "已新增专业「" + plan.name + "」。" };
    case "create_class":
      await createClass(env, user, plan);
      await finish.run();
      return { count, message: "已新增班级「" + plan.name + "」。" };
    case "set_monitor":
      await setMonitor(env, user, plan);
      await finish.run();
      return { count, message: "已设置班长。" };
  }
}

async function normalizeOfficeAction(env, user, action, files) {
  const type = action.type;
  if (type === "list_submissions") {
    const student = action.student === undefined ? null : await officeStudent(env, user, action.student);
    const conditions = ["u.role='student'", "u.deleted_at IS NULL", "c.id=(SELECT MAX(id) FROM checks WHERE student_id=c.student_id AND material_id=c.material_id)"];
    const args = [];
    if (user.role !== "admin") { conditions.push("cl.major_id=?"); args.push(user.major_id); }
    if (student) { conditions.push("c.student_id=?"); args.push(student.id); }
    if (action.pendingOnly === true) conditions.push("c.review_status='待审阅'");
    const { results } = await env.DB.prepare("SELECT p.name,p.student_no,m.name AS material_name,c.filename,c.review_status FROM checks c " +
      "JOIN materials m ON m.id=c.material_id JOIN profiles p ON p.user_id=c.student_id JOIN users u ON u.id=c.student_id LEFT JOIN classes cl ON cl.id=u.class_id WHERE " +
      conditions.join(" AND ") + " ORDER BY c.id DESC LIMIT 21").bind(...args).all();
    return { answer: results.length ? "最新材料提交记录\n" + results.slice(0, 20).map(row =>
      studentLabel(row) + " / " + row.material_name + " / " + row.filename + " / " + row.review_status).join("\n") +
      (results.length > 20 ? "\n这里只显示最近 20 份，可以指定学生缩小范围。" : "") : "没有找到符合条件的材料提交记录。" };
  }
  if (["delete_students", "send_notifications", "advance_students", "list_students"].includes(type)) {
    const limit = type === "send_notifications" ? 50 : 20;
    const students = await officeAudience(env, user, action, limit);
    if (type === "list_students") {
      if (!students.length) return { answer: "没有符合条件的学生。请核对筛选条件。" };
      const stages = (await env.DB.prepare("SELECT slug,name FROM stages ORDER BY position").all()).results;
      return { answer: "可管理的学生\n" +
        students.slice(0, limit).map(student => studentLabel(student) + " · " + (student.grade || "年级未填") +
          " · " + (stages.find(stage => stage.slug === student.current_stage_slug)?.name || "阶段未设")).join("\n") +
        (students.length > limit ? "\n这里只显示前 " + limit + " 名，可以加上院系、阶段或年级缩小范围。" : "") };
    }
    assert(students.length && students.length <= limit, "收件或操作对象须为 1 至 " + limit + " 名学生，请缩小范围");
    const studentIds = students.map(student => student.id);
    const labels = students.map(studentLabel).join("、");
    if (type === "delete_students") return { type, studentIds, preview: "将以下 " + students.length + " 名学生移入回收站。账号暂停使用，档案和材料保留。\n" + labels };
    if (type === "send_notifications") {
      const title = clean(action.title, 200), content = clean(action.content, 2000);
      assert(title && content, "请提供站内信标题和正文");
      return { type, studentIds, title, content, preview: "收件人（" + students.length + " 人）：" + labels + "\n标题：" + title + "\n正文：\n" + content };
    }
    const stages = (await env.DB.prepare("SELECT slug,name FROM stages ORDER BY position").all()).results;
    const lines = students.map(student => {
      const position = stages.findIndex(stage => stage.slug === student.current_stage_slug);
      assert(position >= 0 && position + 1 < stages.length, studentLabel(student) + "没有可推进的下一阶段", 409);
      return studentLabel(student) + "：" + stages[position].name + " → " + stages[position + 1].name;
    });
    return { type, studentIds, approved: students.map(student => ({ id: student.id, stage: student.current_stage_slug })), preview: "将推进培养阶段并通知学生：\n" + lines.join("\n") };
  }
  if (type === "review_materials") {
    assert(action.rows.length <= 20, "一次最多审阅 20 份材料");
    const status = clean(action.status, 20), note = clean(action.note, 500);
    assert(["已通过", "退回修改"].includes(status) && (status !== "退回修改" || note), "请指定审阅结果，退回时须提供修改说明");
    const rows = [];
    for (const item of action.rows) {
      const student = await officeStudent(env, user, item.student);
      const materialName = clean(item.materialName, 100);
      const check = await env.DB.prepare("SELECT c.id,c.filename,c.review_status FROM checks c JOIN materials m ON m.id=c.material_id WHERE c.student_id=? AND m.name=? ORDER BY c.id DESC LIMIT 1").bind(student.id, materialName).first();
      assert(check?.review_status === "待审阅", studentLabel(student) + "没有待审阅的「" + materialName + "」", 409);
      rows.push({ id: check.id, label: studentLabel(student) + " / " + materialName + " / " + check.filename });
    }
    const checkIds = selectedIds(rows.map(row => row.id));
    return { type, checkIds, status, note, preview: "审阅结果：" + status + (note ? "\n说明：" + note : "") +
      "\n以下学生将收到站内通知：\n" + rows.map(row => row.label).join("\n") };
  }
  if (type === "create_invites" || type === "create_department" || type === "create_major" || type === "create_class" || type === "set_monitor") {
    if (type === "create_department") {
      assert(user.role === "admin", "仅管理员可执行此操作", 403);
      const name = clean(action.name, 100);
      assert(name, "请输入学院名称");
      return { type, name, preview: "将新增学院「" + name + "」。" };
    }
    if (type === "create_major") {
      assert(user.role === "admin", "仅管理员可执行此操作", 403);
      const college = await env.DB.prepare("SELECT name FROM departments WHERE id=?").bind(id(action.collegeId)).first();
      assert(college, "学院不存在", 404);
      const name = clean(action.name, 100);
      assert(name, "请输入专业名称");
      return { type, collegeId: id(action.collegeId), name, preview: "将在「" + college.name + "」下新增专业「" + name + "」。" };
    }
    if (type === "create_class") {
      const major = await env.DB.prepare("SELECT id,name FROM majors WHERE id=?").bind(id(action.majorId)).first();
      assert(major && (user.role === "admin" || major.id === user.major_id), "专业不存在或不在管理范围内", 404);
      const name = clean(action.name, 100);
      assert(name, "请输入班级名称");
      return { type, majorId: major.id, name, preview: "将在「" + major.name + "」下新增班级「" + name + "」。" };
    }
    if (type === "set_monitor") {
      const classId = id(action.classId);
      const cls = await env.DB.prepare("SELECT id,name,major_id FROM classes WHERE id=?").bind(classId).first();
      assert(cls && (user.role === "admin" || cls.major_id === user.major_id), "班级不存在或不在管理范围内", 404);
      const student = await officeStudent(env, user, action.student);
      assert(student.class_id === classId, "该学生不属于所选班级", 409);
      return { type, classId, studentId: student.id, studentNo: student.student_no, preview: "将把 " + student.name + "（" + student.student_no + "）设为「" + cls.name + "」的班长。" };
    }
    assert(user.role === "admin", "仅管理员可执行此操作", 403);
    const majorId = id(action.majorId), count = Number(action.count);
    assert(Number.isSafeInteger(count) && count >= 1 && count <= 50, "一次可生成 1 至 50 个邀请码");
    const major = await env.DB.prepare("SELECT name FROM majors WHERE id=?").bind(majorId).first();
    assert(major, "专业不存在", 404);
    return { type, majorId, count, role: "counselor", preview: "将为「" + major.name + "」生成 " + count + " 个辅导员邀请码，有效期 7 天。" };
  }
  if (type === "register_counselors") {
    assert(user.role === "admin", "仅管理员可批量添加辅导员", 403);
    const major = await env.DB.prepare("SELECT id,name FROM majors WHERE id=?").bind(id(action.majorId)).first();
    assert(major, "专业不存在", 404);
    const counselors = action.counselors.map(item => ({ name: clean(item.name, 50), username: clean(item.username, 40) }));
    assert(counselors.every(item => /^[\p{Script=Han}·]{2,20}$/u.test(item.name) && validName(item.username)), "名单须包含有效的姓名和用户名");
    assert(new Set(counselors.map(item => item.username.toLowerCase())).size === counselors.length, "名单中有重复用户名");
    return { type, majorId: major.id, counselors, preview: "将为「" + major.name + "」注册辅导员：\n" +
      counselors.map(item => item.name + "（" + item.username + "）").join("\n") + "\n初始密码为 cauc+用户名，首次登录须修改。" };
  }
  if (type === "delete_counselors") {
    assert(user.role === "admin", "仅管理员可删除辅导员", 403);
    const usernames = action.counselors.map(item => clean(item.username, 40));
    assert(usernames.every(validName) && new Set(usernames.map(value => value.toLowerCase())).size === usernames.length, "请提供有效且不重复的辅导员用户名");
    const marks = usernames.map(() => "?").join(",");
    const { results } = await env.DB.prepare("SELECT id,username,name FROM users WHERE role='counselor' AND deleted_at IS NULL AND username IN (" + marks + ")").bind(...usernames).all();
    assert(results.length === usernames.length, "部分辅导员用户名不存在", 404);
    return { type, usernames: results.map(item => item.username), ids: results.map(item => item.id), preview: "将以下辅导员账号移入回收站，账号暂停使用：\n" +
      results.map(item => (item.name || "辅导员") + "（" + item.username + "）").join("\n") };
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
    assert(uploadType(filename, type === "upload_forms"), "文件类型不支持：" + filename);
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

async function saveOfficePlan(env, user, action) {
  const planId = randomHex(16);
  await env.DB.prepare("INSERT INTO office_plans(id,user_id,action_type,payload_json,expires_at) VALUES(?,?,?,?,?)")
    .bind(planId, user.id, action.type, JSON.stringify(action), new Date(Date.now() + 15 * 60000).toISOString()).run();
  return { id: planId, type: action.type, preview: action.preview, expiresInMinutes: 15 };
}

export async function inspectStudentRoster(env, rows) {
  assert(Array.isArray(rows) && rows.length >= 1 && rows.length <= 50, "名单须有 1 至 50 行");
  const students = rows.map((item, index) => ({
    name: clean(item?.name, 50), studentNo: clean(item?.studentNo, 40), line: Number(item?.line) || index + 1
  }));
  const numbers = students.map(row => row.studentNo).filter(no => /^\d{6,20}$/.test(no));
  const unique = [...new Set(numbers)];
  const existing = unique.length ? (await env.DB.prepare("SELECT username,deleted_at FROM users WHERE username IN (" +
    unique.map(() => "?").join(",") + ")").bind(...unique).all()).results : [];
  const accounts = new Map(existing.map(item => [item.username, item]));
  return students.map(row => {
    const account = accounts.get(row.studentNo);
    const issues = [
      !/^[\p{Script=Han}·]{2,20}$/u.test(row.name) && "请核实姓名",
      !/^\d{6,20}$/.test(row.studentNo) && "学号须为 6 至 20 位数字",
      numbers.indexOf(row.studentNo) !== numbers.lastIndexOf(row.studentNo) && "名单内重复学号",
      account && (account.deleted_at ? "该账号在回收站" : "该学号已有账号")
    ].filter(Boolean);
    return { ...row, issues };
  });
}

export async function officeRoutes(request, env, path, user, audit = {}) {
  if (!path.startsWith("/api/office/")) return null;
  assert(isStaff(user), "仅辅导员和管理员可使用办公助理", 403);
  if (path === "/api/office/roster-preview" && request.method === "POST") {
    const data = await bodyJson(request);
    const rows = await inspectStudentRoster(env, data.rows);
    const classes = user.role === "admin" ? (await env.DB.prepare("SELECT id,major_id,name FROM classes ORDER BY id").all()).results :
      (await env.DB.prepare("SELECT id,major_id,name FROM classes WHERE major_id=?").bind(user.major_id).all()).results;
    const cls = classes.find(item => String(item.id) === String(data.classId));
    const plan = cls && rows.every(row => !row.issues.length) ? await saveOfficePlan(env, user, {
      type: "register_students", classId: cls.id, students: rows.map(({name, studentNo}) => ({name, studentNo})),
      preview: "将为「" + cls.name + "」登记 " + rows.length + " 名学生。初始密码为 cauc+学号，首次登录需修改。"
    }) : null;
    return json({ ok: true, roster: { rows, classes, classId: cls?.id || "" }, plan });
  }
  if (path === "/api/office/plan" && request.method === "POST") {
    const data = await bodyJson(request);
    const question = clean(data.question, 1000), documentText = clean(data.documentText, 25000);
    const files = Array.isArray(data.files) ? data.files.slice(0, 11).map(item => ({ name: clean(item?.name, 150) })) : [];
    const history = Array.isArray(data.history) ? data.history.slice(-6) : [];
    assert(question || documentText || files.length, "请描述任务或上传文件");
    if (isIdentityQuestion(question)) return json({ ok: true, answer: "我是中国民航大学理学院独立开发的党员发展辅助系统。作为办公助理，我可以帮你整理和执行已确认的站内任务。", plan: null });
    if (isCurrentTimeQuestion(question)) return json({ ok: true, answer: getCurrentTime(), plan: null });
    if (files.length && !question && !history.some(item => item?.role === "user" && item.content?.trim?.())) {
      return json({ ok: true, answer: "附件已选好。请告诉我要怎样处理，例如归档到某位学生的材料，或放入某个阶段的资料下载区。", plan: null });
    }
    assert(env.DEEPSEEK_API_KEY, "办公助理尚未配置 AI 服务", 503);
    assert(files.length <= 10, "一次最多上传 10 个文件");
    const catalog = {
      stages: (await env.DB.prepare("SELECT slug,name FROM stages ORDER BY position").all()).results,
      materials: (await env.DB.prepare("SELECT name,stage_slug FROM materials ORDER BY id").all()).results,
      colleges: (await env.DB.prepare("SELECT id,name FROM departments ORDER BY name").all()).results,
      majors: user.role === "admin" ? (await env.DB.prepare("SELECT id,college_id,name FROM majors ORDER BY id").all()).results :
        (await env.DB.prepare("SELECT id,college_id,name FROM majors WHERE id=?").bind(user.major_id).all()).results,
      classes: user.role === "admin" ? (await env.DB.prepare("SELECT id,major_id,name FROM classes ORDER BY id").all()).results :
        (await env.DB.prepare("SELECT id,major_id,name FROM classes WHERE major_id=?").bind(user.major_id).all()).results
    };
    const references = retrieve(question).filter(item => item.similarity >= mentorConfig(env).similarityThreshold).slice(0, 3);
    const raw = await deepSeekContent(env, { model: "deepseek-flash", messages: officeMessages(question, documentText, files, user.role, catalog, history, references), response_format: { type: "json_object" }, reasoning_effort: "none", stream: false, max_tokens: 2800, temperature: 0.1 });
    let parsed;
    try { parsed = parseOfficePlan(raw); } catch (error) { return json({ ok: true, answer: error.message + "。请补充具体信息。", plan: null }); }
    if (!parsed.action) return json({ ok: true, answer: parsed.reply, plan: null });
    if (parsed.action.type === "register_students") {
      const rows = await inspectStudentRoster(env, parsed.action.students);
      const cls = catalog.classes.find(item => String(item.id) === String(parsed.action.classId));
      return json({ ok: true, answer: parsed.reply, roster: { rows, classes: catalog.classes, classId: cls?.id || "" }, plan: null });
    }
    let normalized;
    try { normalized = await normalizeOfficeAction(env, user, parsed.action, files); }
    catch (error) { if (error instanceof HttpError) return json({ ok: true, answer: error.message + "。请补充或修正后重试。", plan: null }); throw error; }
    if (normalized.answer) return json({ ok: true, answer: normalized.answer, plan: null });
    return json({ ok: true, answer: parsed.reply, plan: await saveOfficePlan(env, user, normalized) });
  }
  if (path === "/api/office/execute" && request.method === "POST") {
    const multipart = request.headers.get("content-type")?.includes("multipart/form-data");
    const data = multipart ? await request.formData() : await bodyJson(request);
    const planId = clean(multipart ? data.get("planId") : data.planId, 32);
    assert(validHex(planId, 32), "操作编号无效");
    const row = await env.DB.prepare("SELECT * FROM office_plans WHERE id=? AND user_id=?").bind(planId, user.id).first();
    if (row?.status === "done" && row.result_json && ["upload_forms", "upload_student_files"].includes(row.action_type)) {
      const result = JSON.parse(row.result_json);
      return json({ ok: true, ...result, message: "已保存 " + result.count + " 份文件。" });
    }
    assert(row && row.status === "pending" && row.expires_at > iso(), "操作已执行或已过期，请重新提出任务", 409);
    const locked = await env.DB.prepare("UPDATE office_plans SET status='running' WHERE id=? AND user_id=? AND status='pending'").bind(planId, user.id).run();
    assert(locked.meta.changes === 1, "操作已在执行中", 409);
    const plan = JSON.parse(row.payload_json);
    audit.targets = plan.type + " plan:" + planId;
    try {
      if (["delete_students", "send_notifications", "advance_students", "review_materials", "create_invites", "create_department", "create_major", "create_class", "set_monitor"].includes(plan.type)) {
        return json({ ok: true, ...await executeOfficeTask(env, user, plan, planId) });
      }
      let result;
      if (plan.type === "register_counselors") {
        const { count } = await (await registerCounselors(env, user, plan)).json();
        result = { count, message: "已注册 " + count + " 名辅导员。初始密码为 cauc+用户名，首次登录须修改。" };
      } else if (plan.type === "delete_counselors") {
        const { count } = await (await deleteCounselors(env, user, plan, plan.ids)).json();
        result = { count, message: "已将 " + count + " 名辅导员移入回收站。" };
      } else if (plan.type === "register_students") {
        requireSecret(env);
        const cls = await env.DB.prepare("SELECT id,major_id FROM classes WHERE id=?").bind(plan.classId).first();
        assert(cls && (user.role === "admin" || cls.major_id === user.major_id), "班级权限已变化，请重新提出任务", 403);
        const checked = await inspectStudentRoster(env, plan.students);
        assert(checked.every(item => !item.issues.length), "名单中的学号已有人登记，请重新校验", 409);
        const collegeId = (await env.DB.prepare("SELECT college_id FROM majors WHERE id=?").bind(cls.major_id).first())?.college_id;
        const statements = [];
        for (const student of plan.students) {
          const salt = randomHex(16), initial = await hmac(env.AUTH_PEPPER, "initial:" + student.studentNo.toLowerCase() + ":cauc+" + student.studentNo);
          statements.push(env.DB.prepare("INSERT INTO users(username,password_salt,password_verifier,role,department_id,class_id,name,must_change_password) VALUES(?,?,?,'student',?,?,?,1)").bind(student.studentNo, salt, initial, collegeId, plan.classId, student.name));
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
        assert(uploads.every(file => typeof file?.arrayBuffer === "function") &&
          uploads.reduce((total, file) => total + file.size, 0) <= maxBatchBytes, "这批附件须为文件，且总大小不能超过 30 MB");
        const byName = new Map(uploads.map(file => [clean(file.name, 150), file]));
        assert(byName.size === uploads.length, "文件名重复");
        const prepared = [];
        for (const item of plan.rows) {
          const file = byName.get(item.filename), type = uploadType(item.filename, plan.type === "upload_forms");
          assert(file && type && file.size > 0 && file.size <= maxFileBytes, "文件缺失或超过 10 MB：" + item.filename);
          assert(await matchesUploadType(file, type), "文件格式与扩展名不符：" + item.filename);
          if (plan.type === "upload_student_files") await targetStudent(env, user, item.studentId);
          const key = plan.type === "upload_forms" ? "forms/" + (user.role === "admin" ? "global" : user.department_id) + "/" + randomHex(16) + "." + item.filename.split(".").at(-1).toLowerCase()
            : "checks/" + item.studentId + "/" + randomHex(16) + "." + item.filename.split(".").at(-1).toLowerCase();
          prepared.push({ item, file, type, key });
        }
        const uploaded = [];
        try {
          for (const entry of prepared) { await env.FILES.put(entry.key, await entry.file.arrayBuffer(), { httpMetadata: { contentType: entry.type.mime } }); uploaded.push(entry.key); }
          const completed = env.DB.prepare("UPDATE office_plans SET status='done',result_json=? WHERE id=?")
            .bind(JSON.stringify({ count: prepared.length }), planId);
          const statements = plan.type === "upload_forms"
            ? prepared.map(entry => env.DB.prepare("INSERT INTO form_templates(stage_slug,department_id,title,filename,r2_key,uploaded_by) VALUES(?,?,?,?,?,?)")
              .bind(entry.item.stageSlug, user.role === "admin" ? null : user.department_id, entry.item.title, entry.item.filename, entry.key, user.id))
            : prepared.flatMap(entry => [
              env.DB.prepare("INSERT INTO checks(student_id,material_id,r2_key,filename,monitor_approved) SELECT u.id,?,?,?,CASE WHEN monitor.id IS NULL THEN 1 ELSE 0 END FROM users u LEFT JOIN classes cl ON cl.id=u.class_id LEFT JOIN users monitor ON monitor.id=cl.monitor_user_id AND monitor.deleted_at IS NULL WHERE u.id=?")
                .bind(entry.item.materialId, entry.key, entry.item.filename, entry.item.studentId),
              env.DB.prepare("INSERT INTO material_records(student_id,material_id,status,r2_key,filename,submitted_at) VALUES(?,?,'已交',?,?,?) ON CONFLICT(student_id,material_id) DO UPDATE SET status='已交',r2_key=excluded.r2_key,filename=excluded.filename,submitted_at=excluded.submitted_at")
                .bind(entry.item.studentId, entry.item.materialId, entry.key, entry.item.filename, iso())
            ]);
          await env.DB.batch([...statements, completed]);
        } catch (error) { await Promise.all(uploaded.map(key => env.FILES.delete(key))); throw error; }
        return json({ ok: true, count: prepared.length, message: "已将 " + prepared.length + " 份文件上传至预览中列出的指定位置。" });
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

function agentActionsEnabled(env) {
  return !!env.DEEPSEEK_API_KEY && String(env.AGENT_ACTIONS_ENABLED ?? "true").trim().toLowerCase() !== "false";
}
function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  assert(origin && origin === new URL(request.url).origin, "请求来源无效", 403);
}
const AGENT_MAX_ACTIONS = 6;
async function countConversationActions(env, userId, conversationId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM student_agent_actions WHERE conversation_id=? AND user_id=?").bind(conversationId, userId).first();
  return row?.n ?? 0;
}
async function recordConversationAction(env, userId, conversationId, type) {
  await env.DB.prepare("INSERT INTO student_agent_actions(user_id,conversation_id,action_type) VALUES(?,?,?)").bind(userId, conversationId, type).run();
}
async function readSection(env, user, section) {
  if (section === "profile") {
    const [stage, node] = await Promise.all([
      env.DB.prepare("SELECT name FROM stages WHERE slug=?").bind(user.current_stage_slug).first(),
      env.DB.prepare("SELECT name FROM nodes WHERE slug=?").bind(user.current_node_slug).first()
    ]);
    return "我的档案：姓名 " + (user.name || "未填") + "，学号 " + (user.student_no || "未填") + "，学院 " + (user.college_name || "未填") + "，专业 " + (user.major_name || "未填") + "，班级 " + (user.class_name || "未填") + "，当前阶段「" + (stage?.name || "未设置") + "」，当前节点「" + (node?.name || "未设置") + "」，联系电话 " + (user.phone ? redactPhone(user.phone) : "未填") + "。";
  }
  if (section === "materials") {
    const rows = await env.DB.prepare("SELECT m.name,r.status FROM materials m LEFT JOIN material_records r ON r.material_id=m.id AND r.student_id=? WHERE m.stage_slug=? ORDER BY m.id").bind(user.id, user.current_stage_slug).all();
    const results = rows.results;
    const missing = results.filter(row => row.status !== "已交" && row.status !== "已通过");
    const done = results.filter(row => row.status === "已交" || row.status === "已通过");
    return "我的材料状态（当前阶段）：共 " + results.length + " 项，已交/已通过 " + done.length + " 项，未交 " + missing.length + " 项" + (missing.length ? "：" + missing.map(row => row.name).join("、") : "") + "。";
  }
  if (section === "notifications") {
    const rows = await env.DB.prepare("SELECT title,is_read FROM notifications WHERE student_id=? ORDER BY created_at DESC LIMIT 10").bind(user.id).all();
    return rows.results.length ? "最近通知（" + rows.results.length + " 条）：" + rows.results.map(row => (row.is_read ? "[已读]" : "[未读]") + row.title).join("；") + "。" : "通知中心暂无通知。";
  }
  return "站内未找到该摘要。";
}
async function normalizeStudentAction(env, user, action) {
  if (action.type === "prepare_submit") {
    const schema = FORM_SCHEMA[action.form];
    return { type: action.type, form: action.form, fields: action.fields, preview: "将更新你的" + schema.title + "：联系电话 " + redactPhone(action.fields.phone) + "。" };
  }
  if (action.type === "prepare_upload") {
    const material = await env.DB.prepare("SELECT id,name FROM materials WHERE name=?").bind(action.material).first();
    assert(material, "材料不存在：" + action.material, 404);
    const upload = await env.DB.prepare("SELECT r2_key,filename FROM agent_uploads WHERE file_ref=? AND user_id=? AND expires_at>?").bind(action.file_ref, user.id, iso()).first();
    assert(upload, "文件暂存已失效，请在页面重新选择文件", 409);
    return { type: action.type, file_ref: action.file_ref, material_id: material.id, material_name: material.name, filename: upload.filename, preview: "将把你选择的文件「" + upload.filename + "」提交为材料「" + material.name + "」。" };
  }
  throw new HttpError(400, "不支持的操作");
}
async function saveStudentPlan(env, user, conversationId, payload) {
  const planId = randomHex(16);
  const payloadHash = await sha256(JSON.stringify(payload));
  await env.DB.prepare("INSERT INTO student_plans(id,user_id,conversation_id,action_type,payload_json,payload_hash,preview,expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(planId, user.id, conversationId, payload.type, JSON.stringify(payload), payloadHash, payload.preview, new Date(Date.now() + 15 * 60000).toISOString()).run();
  return { id: planId, type: payload.type, preview: payload.preview, payloadHash, expiresInMinutes: 15 };
}
export async function agentRoutes(request, env, path, user, audit = {}) {
  if (!path.startsWith("/api/agent/")) return null;
  assert(user, "请先登录", 401);
  assert(user.role === "student", "仅学生可使用站内操作", 403);
  if (path === "/api/agent/plan" && request.method === "POST") {
    if (!agentActionsEnabled(env)) return json({ ok: true, deferred: true, answer: null, action: null, plan: null });
    const data = await bodyJson(request);
    const question = clean(data.question, 500), documentText = clean(data.documentText, 25000);
    const files = Array.isArray(data.files) ? data.files.slice(0, 11).map(item => ({ name: clean(item?.name, 150), ref: /^[a-f0-9]{32}$/.test(String(item?.ref ?? "")) ? String(item.ref) : "" })) : [];
    const history = Array.isArray(data.history) ? data.history.slice(-6) : [];
    const conversationId = clean(data.conversationId, 64) || randomHex(16);
    assert(question || documentText || files.length, "请描述任务");
    if (isAccountDeletionRequest(question)) {
      audit.action = "agent_reject"; audit.targets = "account_deletion";
      return json({ ok: true, answer: "账号注销由辅导员或管理员处理，请直接联系你的辅导员。", action: null, plan: null });
    }
    if (isProxyRequest(question)) {
      audit.action = "agent_reject"; audit.targets = "proxy_request";
      return json({ ok: true, answer: "我只能为当前登录的你自己操作，不能代其他同学操作。请让对方登录自己的账号，或联系辅导员。", action: null, plan: null });
    }
    if (isIdentityQuestion(question) || isCurrentTimeQuestion(question) || !looksLikeActionRequest(question)) {
      return json({ ok: true, deferred: true, answer: null, action: null, plan: null });
    }
    if (await countConversationActions(env, user.id, conversationId) >= AGENT_MAX_ACTIONS) {
      audit.action = "agent_reject"; audit.targets = "action_limit";
      return json({ ok: true, answer: "本次对话的站内操作已达上限（" + AGENT_MAX_ACTIONS + " 次），请开启新对话继续，或直接在页面操作。", action: null, plan: null });
    }
    const sections = { profile: await readSection(env, user, "profile"), materials: await readSection(env, user, "materials") };
    const references = retrieve(question).filter(item => item.similarity >= mentorConfig(env).similarityThreshold).slice(0, 3);
    const raw = await deepSeekContent(env, { model: "deepseek-flash", messages: studentActionMessages(question, { documentText, files, history, references, sections }), response_format: { type: "json_object" }, reasoning_effort: "none", stream: false, max_tokens: 900, temperature: 0.1 });
    let parsed;
    try { parsed = parseStudentAction(raw); }
    catch (error) { audit.action = "agent_reject"; audit.targets = "parse"; return json({ ok: true, answer: error.message + "。请补充信息后重试。", action: null, plan: null }); }
    if (!parsed.action) { audit.action = "agent_answer"; return json({ ok: true, answer: parsed.reply, action: null, plan: null }); }
    const action = parsed.action;
    if (action.type === "navigate") {
      await recordConversationAction(env, user.id, conversationId, action.type);
      audit.action = "agent_navigate"; audit.targets = action.route;
      return json({ ok: true, answer: parsed.reply, action: { type: "navigate", route: action.route }, plan: null });
    }
    if (action.type === "read_summary") {
      await recordConversationAction(env, user.id, conversationId, action.type);
      audit.action = "agent_read_summary"; audit.targets = action.section;
      return json({ ok: true, answer: await readSection(env, user, action.section), action: { type: "read_summary", section: action.section }, plan: null });
    }
    if (action.type === "fill_field") {
      await recordConversationAction(env, user.id, conversationId, action.type);
      audit.action = "agent_fill_field"; audit.targets = action.form + "." + action.field;
      const schema = FORM_SCHEMA[action.form];
      return json({ ok: true, answer: schema.fields[action.field].label + "已填写：" + schema.fields[action.field].redact(action.value) + "。", action: { type: "fill_field", form: action.form, field: action.field, value: action.value }, plan: null });
    }
    let normalized;
    try { normalized = await normalizeStudentAction(env, user, action); }
    catch (error) {
      if (error instanceof HttpError) { audit.action = "agent_reject"; audit.targets = "normalize"; return json({ ok: true, answer: error.message + "。请补充后重试。", action: null, plan: null }); }
      throw error;
    }
    const plan = await saveStudentPlan(env, user, conversationId, normalized);
    await recordConversationAction(env, user.id, conversationId, action.type);
    audit.action = "agent_draft"; audit.targets = action.type + " plan:" + plan.id;
    return json({ ok: true, answer: parsed.reply, action: { type: action.type }, plan });
  }
  if (path === "/api/agent/execute" && request.method === "POST") {
    assert(agentActionsEnabled(env), "站内操作已关闭", 403);
    assertSameOrigin(request);
    const data = await bodyJson(request);
    const planId = clean(data.planId, 32), payloadHash = clean(data.payloadHash, 64);
    assert(validHex(planId, 32), "操作编号无效");
    const row = await env.DB.prepare("SELECT * FROM student_plans WHERE id=?").bind(planId).first();
    assert(row && row.user_id === user.id, "操作不存在或不属于你", 404);
    assert(row.status === "pending" && row.expires_at > iso(), "操作已执行或已过期，请重新提出", 409);
    assert(validHex(payloadHash, 64) && equal(payloadHash, row.payload_hash), "操作内容已变化，请重新确认", 409);
    const locked = await env.DB.prepare("UPDATE student_plans SET status='running' WHERE id=? AND user_id=? AND status='pending'").bind(planId, user.id).run();
    assert(locked.meta.changes === 1, "操作已在执行中", 409);
    const plan = JSON.parse(row.payload_json);
    audit.action = "agent_execute"; audit.targets = plan.type + " plan:" + planId;
    try {
      if (plan.type === "prepare_submit") {
        const schema = FORM_SCHEMA[plan.form];
        const phone = String(plan.fields?.phone ?? "");
        assert(schema?.fields?.phone?.validate(phone), "联系电话格式已失效", 409);
        await env.DB.batch([
          env.DB.prepare("UPDATE profiles SET phone=? WHERE user_id=?").bind(phone, user.id),
          env.DB.prepare("UPDATE student_plans SET status='done',result_json=? WHERE id=?").bind(JSON.stringify({ ok: true }), planId)
        ]);
        return json({ ok: true, message: "已更新你的联系电话为 " + redactPhone(phone) + "。" });
      }
      if (plan.type === "prepare_upload") {
        const upload = await env.DB.prepare("SELECT * FROM agent_uploads WHERE file_ref=? AND user_id=?").bind(plan.file_ref, user.id).first();
        assert(upload, "文件暂存已失效，请重新选择", 409);
        const material = await env.DB.prepare("SELECT id FROM materials WHERE id=?").bind(plan.material_id).first();
        assert(material, "材料不存在", 404);
        const object = await env.FILES.get(upload.r2_key);
        assert(object, "文件不存在", 404);
        const type = uploadType(upload.filename);
        assert(type, "文件类型不支持", 409);
        const cls = await env.DB.prepare("SELECT cl.monitor_user_id FROM classes cl JOIN users m ON m.id=cl.monitor_user_id AND m.deleted_at IS NULL WHERE cl.id=?").bind(user.class_id || 0).first();
        const monitorApproved = cls?.monitor_user_id ? 0 : 1;
        const key = "checks/" + user.id + "/" + randomHex(16) + "." + upload.filename.split(".").at(-1).toLowerCase();
        await env.FILES.put(key, object.body, { httpMetadata: { contentType: type.mime } });
        try {
          await env.DB.batch([
            env.DB.prepare("INSERT INTO checks(student_id,material_id,r2_key,filename,monitor_approved) VALUES(?,?,?,?,?)").bind(user.id, plan.material_id, key, upload.filename, monitorApproved),
            env.DB.prepare("INSERT INTO material_records(student_id,material_id,status,r2_key,filename,submitted_at) VALUES(?,?,'已交',?,?,?) ON CONFLICT(student_id,material_id) DO UPDATE SET status='已交',r2_key=excluded.r2_key,filename=excluded.filename,submitted_at=excluded.submitted_at").bind(user.id, plan.material_id, key, upload.filename, iso()),
            env.DB.prepare("DELETE FROM agent_uploads WHERE file_ref=?").bind(plan.file_ref),
            env.DB.prepare("UPDATE student_plans SET status='done',result_json=? WHERE id=?").bind(JSON.stringify({ ok: true }), planId)
          ]);
        } catch (error) { await env.FILES.delete(key); throw error; }
        await env.FILES.delete(upload.r2_key);
        return json({ ok: true, message: "已将「" + upload.filename + "」提交为材料「" + plan.material_name + "」，可在材料提交页查看。" });
      }
      throw new HttpError(400, "不支持的操作");
    } catch (error) {
      await env.DB.prepare("UPDATE student_plans SET status='pending' WHERE id=? AND status='running'").bind(planId).run();
      throw error;
    }
  }
  if (path === "/api/agent/upload" && request.method === "POST") {
    assert(agentActionsEnabled(env), "站内操作已关闭", 403);
    assertSameOrigin(request);
    const form = await request.formData();
    const file = form.get("file");
    assert(file && typeof file.arrayBuffer === "function", "请选择文件");
    const filename = clean(file.name, 150), type = uploadType(filename);
    assert(type && file.size > 0 && file.size <= maxFileBytes, "仅支持不超过 10 MB 的 Word、PDF 或图片");
    assert(await matchesUploadType(file, type), "文件内容与扩展名不符");
    const fileRef = randomHex(16);
    const key = "agent-stage/" + user.id + "/" + fileRef + "." + type.ext;
    await env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type.mime } });
    try {
      await env.DB.prepare("INSERT INTO agent_uploads(file_ref,user_id,filename,r2_key,expires_at) VALUES(?,?,?,?,?)")
        .bind(fileRef, user.id, filename, key, new Date(Date.now() + 15 * 60000).toISOString()).run();
    } catch (error) { await env.FILES.delete(key); throw error; }
    audit.action = "agent_upload_stage"; audit.targets = "ref:" + fileRef;
    return json({ ok: true, file_ref: fileRef, filename });
  }
  return null;
}

async function scheduled(env) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await env.DB.prepare("INSERT OR IGNORE INTO notifications(student_id,kind,title,content,node_slug) SELECT p.user_id,'deadline','节点提醒：' || n.name,'您当前处于「' || n.name || '」节点，时间要求：' || COALESCE(NULLIF(n.duration_rule,''),'请按计划推进') || '。请及时准备相关材料。',n.slug FROM profiles p JOIN nodes n ON n.slug=p.current_node_slug WHERE EXISTS (SELECT 1 FROM users u WHERE u.id=p.user_id AND u.deleted_at IS NULL) AND p.node_entered_at IS NOT NULL AND n.duration_days>0 AND n.remind_days_before>0 AND date(p.node_entered_at,'+' || (n.duration_days-n.remind_days_before) || ' days')<=date(?)")
    .bind(today).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(iso()).run();
  await env.DB.prepare("DELETE FROM login_attempts WHERE reset_at<?").bind(iso()).run();
  await cleanupAgentArtifacts(env);
}

// 清理学生站内操作产生的过期暂存文件与过期未确认草案，防止孤儿文件累积。
export async function cleanupAgentArtifacts(env) {
  const expiredUploads = await env.DB.prepare("SELECT r2_key FROM agent_uploads WHERE expires_at<?").bind(iso()).all();
  await Promise.all(expiredUploads.results.map(row => env.FILES.delete(row.r2_key).catch(() => {})));
  await env.DB.prepare("DELETE FROM agent_uploads WHERE expires_at<?").bind(iso()).run();
  await env.DB.prepare("DELETE FROM student_plans WHERE expires_at<? AND status='pending'").bind(iso()).run();
}

async function handleRequest(request, env, audit) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) return secured(await env.ASSETS.fetch(request));
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if (!origin || origin !== new URL(request.url).origin) return secured(json({ ok: false, error: "请求来源无效" }, 403));
    }
    try {
      const user = await currentUser(request, env);
      audit.user = user;
      let response = await authRoutes(request, env, path, audit);
      if (response) return secured(response);
      const guestMentor = !user && (path === "/api/mentor" || path === "/api/mentor/chat" || path === "/api/mentor/retrieve");
      if (!guestMentor) assert(user, "请先登录", 401);
      if (path === "/api/change-password" && request.method === "POST") return secured(await changePassword(request, env, user));
      if (user?.must_change_password && path !== "/api/me") throw new HttpError(403, "首次登录请先修改初始密码");
      if (path === "/api/activity" && request.method === "POST") {
        const event = (await bodyJson(request)).event;
        assert(["view_profile", "view_check", "view_checks", "view_forms", "view_notifications", "view_admin", "view_operations", "view_recycle", "view_password", "open_mentor", "scan_crop", "scan_rotate", "scan_mode", "scan_use", "scan_ocr", "roster_edit", "roster_remove", "preview_submission", "dialog_confirm", "dialog_cancel", "download_official_form"].includes(event), "操作无效");
        audit.action = event;
        return secured(json({ ok: true }));
      }
      response = await managementRecords(request, env, path, user)
        || await officeRoutes(request, env, path, user, audit)
        || await agentRoutes(request, env, path, user, audit)
        || await mentorRoutes(request, env, path, user)
        || await studentRoutes(request, env, path, user)
        || await checkRoutes(request, env, path, user, audit)
        || await formRoutes(request, env, path, user)
        || await adminRoutes(request, env, path, user, audit);
      return secured(response || json({ ok: false, error: "接口不存在" }, 404));
    } catch (error) {
      if (error instanceof HttpError) return secured(json({ ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status));
      console.error("request error", error);
      return secured(json({ ok: false, error: "服务器暂不可用" }, 500));
    }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const audit = {};
    const response = await handleRequest(request, env, audit);
    if (ctx && path.startsWith("/api/")) {
      const action = audit.action || (/^[/]api[/][a-z0-9/-]{1,120}$/.test(path) ? path : "/api/unknown");
      ctx.waitUntil(Promise.resolve().then(() => auditStatement(env, audit.user, action, request.method, response.status, audit.targets).run())
        .catch(error => console.error("audit write failed", error?.name)));
    }
    return response;
  },

  async scheduled(_event, env) {
    try { await scheduled(env); }
    catch (error) {
      await auditStatement(env, { role: "system" }, "daily_reminders", "CRON", 500).run();
      throw error;
    }
    await auditStatement(env, { role: "system" }, "daily_reminders", "CRON", 200).run();
  }
};
