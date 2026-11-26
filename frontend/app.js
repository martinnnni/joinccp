import JSZip from "jszip";
import officialForms from "../official-forms.json";
import { extractReviewText } from "./file-text.js";
import { extractRosterText, readStructuredStudentRoster } from "./roster.js";
import { deriveVerifier } from "./pbkdf2.js";
import { fileExtension, materialAccept, maxBatchBytes, maxFileBytes, normalizedAttachment, officeAccept, uploadType } from "../upload-types.js";
import { decodeImage, processImage, rotateScan, validCrop } from "./scan.js";
import { expandZip } from "./zip.js";

const root = document.getElementById("app");
const navigation = document.getElementById("navigation");
let me = null;
let config = null;
let mentorHistory = [];
let mentorEpoch = 0;
let mentorConversationId = "";
const make = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value ?? "";
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};
const mentorTitle = () => (me && (me.role === "counselor" || me.role === "admin")) ? "办公助理" : "成长导师";
const agentRouteLabel = route => ({ profile: "我的档案", forms: "资料下载", check: "材料提交", notifications: "通知中心" })[route] || route;
const mentorErrorText = (code, message) => "错误代码 " + code + "：" + message + "。请将错误代码报告给你的导员和支持部门。";
const renderMarkdown = src => {
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = s => {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
      '<a href="' + url.replace(/"/g, "&quot;") + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
    return s;
  };
  const lines = String(src ?? "").split("\n");
  let out = "";
  let inCode = false, codeBuf = [];
  let list = null, para = [];
  const closeList = () => { if (list) { out += "</" + list + ">"; list = null; } };
  const flushPara = () => { if (para.length) { out += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) { out += "<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>"; codeBuf = []; inCode = false; }
      else { inCode = true; codeBuf = []; closeList(); flushPara(); }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul) {
      flushPara();
      if (list !== "ul") { closeList(); list = "ul"; out += "<ul>"; }
      out += "<li>" + inline(ul[1]) + "</li>";
      continue;
    }
    if (ol) {
      flushPara();
      if (list !== "ol") { closeList(); list = "ol"; out += "<ol>"; }
      out += "<li>" + inline(ol[1]) + "</li>";
      continue;
    }
    closeList();
    if (/^\s*$/.test(line)) { flushPara(); continue; }
    const hh = line.match(/^(#{1,6})\s+(.*)/);
    if (hh) { flushPara(); out += "<h" + hh[1].length + ">" + inline(hh[2]) + "</h" + hh[1].length + ">"; continue; }
    para.push(line);
  }
  closeList(); flushPara();
  if (inCode) out += "<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>";
  return out;
};
const h = (text, cls = "page-title") => make("h1", { className: cls, text });
const p = text => make("p", { text });
const panel = (...children) => make("section", { className: "panel" }, children);
const pageHead = (code, title, description = "", greeting = "", titleClass = "") => make("div", { className: "page-head" },
  make("div", {}, typeof title === "string" ? h(title, titleClass) : title, greeting ? make("p", { className: "greeting-line", text: greeting }) : null, description ? p(description) : null));
const dayPart = () => {
  const h = new Date().getHours();
  return h >= 5 && h < 9 ? "早晨" : h >= 9 && h < 12 ? "上午" : h >= 12 && h < 14 ? "中午" : h >= 14 && h < 18 ? "下午" : "晚上";
};
const metric = (label, value, note = "", accent = false) => make("div", { className: "metric" },
  make("span", { className: "metric-label", text: label }),
  make("strong", { className: "metric-value" + (accent ? " accent" : ""), text: value }),
  note ? make("span", { className: "metric-note", text: note }) : null);
const tableWrap = table => make("div", { className: "data-wrap" }, table);
const button = (text, action, cls = "btn") => make("button", { type: "button", className: cls, text, onclick: action });
const field = (label, name, type = "text", required = true, value = "") => make("label", { className: "field" },
  make("span", { text: label }), make("input", { name, type, required: required ? "" : null, value }));
const select = (label, name, choices, value = "") => make("label", { className: "field" },
  make("span", { text: label }), make("select", { name, disabled: choices.length ? null : "" },
    choices.length ? choices.map(choice => make("option", { value: choice[0], text: choice[1], selected: String(choice[0]) === String(value) ? "" : null }))
      : make("option", { value: "", text: "暂无可选项" })));
const notice = (text, type = "info") => make("p", { className: "notice " + type, text });
const busy = form => {
  clearFeedback(form);
  const submit = form.querySelector("[type=submit]");
  if (submit) submit.disabled = true;
  return () => { if (submit) submit.disabled = false; };
};
async function api(path, options = {}) {
  const multipart = options.body instanceof FormData;
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: multipart ? {} : options.body ? { "content-type": "application/json" } : {},
      ...options
    });
  } catch (error) {
    if (!multipart) throw error;
    throw new Error("网络中断，未能确认文件是否上传。请先查看提交记录，再重试。");
  }
  const data = await response.json().catch(() => null);
  if (!data) {
    if (response.status === 413) throw new Error("附件太大，请缩小文件或分批上传。");
    throw new Error("服务器暂时无法确认请求结果，请稍后刷新查看。");
  }
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || "请求失败");
    if (data.code) error.code = data.code;
    throw error;
  }
  return data;
}
const post = (path, data) => api(path, { method: "POST", body: JSON.stringify(data) });
function clearFeedback(container) {
  const status = container.querySelector(":scope > .form-feedback");
  if (status) status.textContent = "";
}
function feedback(container, message, kind = "error") {
  let status = container.querySelector(":scope > .form-feedback");
  if (!status) {
    status = make("p", { className: "form-feedback", role: "status", "aria-atomic": "true" });
    container.append(status);
    container.addEventListener("input", () => clearFeedback(container));
  }
  status.dataset.kind = kind;
  status.textContent = message;
}
let operationFeedback = "";
function refreshWithFeedback(message) {
  operationFeedback = message;
  render();
}
function actionDialog(title, message, label = "确认") {
  return new Promise(resolve => {
    const dialog = make("dialog", { className: "scan-overlay-card action-dialog", "aria-label": title },
      make("h2", { text: title }), p(message));
    const cancel = button("取消", () => dialog.close(), "secondary");
    dialog.append(make("div", { className: "upload-actions" }, cancel, button(label, () => dialog.close("confirmed"))));
    dialog.addEventListener("close", () => {
      const accepted = dialog.returnValue === "confirmed";
      recordActivity(accepted ? "dialog_confirm" : "dialog_cancel");
      dialog.remove();
      resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
function uploadWithProgress(path, body, status) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.timeout = 120000;
    request.upload.onprogress = event => {
      status.textContent = event.lengthComputable ? "已上传 " + Math.round(event.loaded / event.total * 100) + "%" : "正在上传…";
    };
    request.upload.onload = () => { status.textContent = "上传完成，正在保存…"; };
    request.onload = () => {
      let result;
      try { result = JSON.parse(request.responseText); } catch {}
      if (request.status >= 200 && request.status < 300 && result?.ok) resolve(result);
      else reject(new Error(result?.error || "保存失败，请重试"));
    };
    request.onerror = request.ontimeout = request.onabort = () => reject(new Error("连接中断，请重试"));
    status.textContent = "正在上传…";
    request.send(body);
  });
}
function displayTime(value) {
  if (!value) return "";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(+date) ? value : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}
function formData(form) { return Object.fromEntries(new FormData(form)); }
function randomHex(size) {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), n => n.toString(16).padStart(2, "0")).join("");
}
async function derive(password, salt, iterations = 210000) {
  return deriveVerifier(password, salt, iterations);
}
function recordActivity(event) {
  if (me && !me.must_change_password) post("/api/activity", { event }).catch(() => {});
}
let lastVisitedPage;
let pendingScroll = null;
function navigate(page) { location.hash = page; render(); }
function nav() {
  navigation.replaceChildren();
  if (me) navigation.append(make("span", { className: "nav-label", text: me.role === "student" ? "学生工作区" : "党务工作区" }));
  const active = location.hash.slice(1) || (me ? me.role === "student" ? "profile" : "admin" : "login");
  const items = me?.must_change_password ? [["password", "设置新密码"]] : me ? (me.role === "student"
    ? [["profile", "我的档案"], ["forms", "资料下载"], ["check", "材料提交"], ...(me.is_monitor ? [["checks", "班级材料"]] : []), ["mentor", "成长导师"], ["notifications", "通知"]]
    : [["admin", "工作台"], ["forms", "资料下载"], ["checks", "已提交文件"], ["hierarchy", "管理体系"], ["recycle", "回收站"]])
    : (config?.initialized ? [] : [["bootstrap", "初始化"]]);
  const scroll = make("div", { className: "nav-scroll" });
  for (const [page, label] of items) {
    const link = make("a", { href: "#" + page, text: label, className: active === page ? "active" : "" });
    if (page === "notifications" && unreadNotifications > 0) link.append(make("span", { className: "nav-badge", text: String(unreadNotifications), "aria-label": unreadNotifications + " 条未读通知" }));
    if (page === "mentor") link.addEventListener("click", event => { event.preventDefault(); openMentor(); });
    scroll.append(link);
  }
  navigation.append(scroll);
  if (me) {
    const logout = async () => { await post("/api/logout", {}); me = null; resetMentorPanel(); navigate("login"); };
    const profileMenu = make("details", { className: "nav-profile" },
      make("summary", { text: "个人资料", "aria-label": "个人资料菜单" }),
      make("div", { className: "nav-profile-menu" },
        make("div", { className: "nav-profile-name", text: me.name || me.username }),
        make("a", { href: "#operations", text: "操作记录" }),
        make("a", { href: "#password", text: "修改密码" }),
        button("退出", logout, "linklike")));
    navigation.append(profileMenu);
  }
}
async function refreshMe() {
  try { me = (await api("/api/me")).user; } catch { me = null; }
}
let unreadNotifications = 0;
async function refreshUnreadNotifications() {
  if (!me || me.role !== "student" || me.must_change_password) { unreadNotifications = 0; return []; }
  try {
    const data = await api("/api/notifications");
    const unread = data.notifications.filter(item => !item.is_read);
    unreadNotifications = unread.length;
    return unread;
  } catch { unreadNotifications = 0; return []; }
}
function notificationPopup(unread) {
  if (!unread.length) return;
  const first = unread[0], more = unread.length - 1;
  const dialog = make("dialog", { className: "scan-overlay-card notification-popup", "aria-label": "新通知" },
    make("div", { className: "notice-popup-head" },
      make("h2", { text: "通知" }),
      make("button", { type: "button", className: "notice-popup-close", "aria-label": "关闭", onclick: () => dialog.close() }, "×")));
  const body = make("div", { className: "notice-popup-body" },
    make("p", { className: "notice-popup-title", text: first.title }),
    p(first.content),
    more > 0 ? p("另有 " + more + " 条未读通知，可在通知中心查看。") : null);
  const detail = button("详情", () => { dialog.close(); navigate("notifications"); }, "secondary");
  const markRead = button("标为已读", async () => {
    markRead.disabled = true;
    try {
      for (const item of unread) await post("/api/notifications/" + item.id + "/read", {});
      unreadNotifications = 0;
      nav();
      dialog.close();
    } catch (error) { markRead.disabled = false; }
  });
  dialog.append(body, make("div", { className: "upload-actions" }, detail, markRead));
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}
function render() {
  const prevPage = document.body.dataset.page;
  const scrollY = window.scrollY;
  document.body.dataset.surface = me ? "workspace" : "entry";
  document.body.dataset.role = me?.role || "guest";
  const fabLabel = document.querySelector("#mentorFab .mentor-fab-label");
  if (fabLabel) fabLabel.textContent = mentorTitle();
  const fab = document.getElementById("mentorFab");
  if (fab) fab.style.display = me?.must_change_password ? "none" : "";
  document.querySelector(".brand").setAttribute("href", me ? me.role === "student" ? "#profile" : "#admin" : "#login");
  nav();
  const page = location.hash.slice(1) || (me ? me.role === "student" ? "profile" : "admin" : config?.initialized ? "login" : "bootstrap");
  document.body.dataset.page = page;
  if (!me) lastVisitedPage = null;
  else if (lastVisitedPage !== page) {
    lastVisitedPage = page;
    if (["profile", "check", "checks", "forms", "notifications", "admin", "operations", "recycle", "password"].includes(page)) recordActivity("view_" + page);
  }
  if (!me) root.replaceChildren(page === "register" ? registration() : page === "bootstrap" && !config?.initialized ? bootstrap() : login());
  else if (me.must_change_password) root.replaceChildren(passwordPage());
  else if (page === "password") root.replaceChildren(passwordPage());
  else if (page === "forms") root.replaceChildren(formsPage());
  else if (page === "checks" && me.role === "student" && me.is_monitor) root.replaceChildren(checksPage(true));
  else if (me.role === "student") root.replaceChildren(
    page === "check" ? checkPage() : page === "mentor" ? mentorPage() : page === "notifications" ? notificationsPage() : page === "operations" ? recordsPage("operations") : profilePage());
  else root.replaceChildren(page === "checks" ? checksPage() : page === "hierarchy" ? hierarchyPage() : ["operations", "recycle"].includes(page) ? recordsPage(page) : adminPage());
  if (operationFeedback) {
    root.prepend(make("p", { className: "form-feedback operation-result", role: "status", "data-kind": "success", text: operationFeedback }));
    operationFeedback = "";
  }
  pendingScroll = prevPage === page ? scrollY : null;
  if (pendingScroll !== null) window.scrollTo(0, pendingScroll);
}
function accountForm(title, includeInvite = false, includeBootstrap = false) {
  const registrationFields = includeInvite ? make("div", { className: "form-grid" },
    field("姓名", "name"),
    field("用户名 / 学号", "username", "text")) : null;
  const form = make("form", { className: "auth-form" },
    includeInvite ? null : field("学号或用户名", "username"),
    includeInvite ? registrationFields : null,
    field(includeInvite ? "设置密码" : "密码", "password", "password"),
    includeInvite ? field("邀请码", "inviteCode") : null,
    includeBootstrap ? field("初始化令牌", "bootstrapToken") : null,
    make("button", { type: "submit", className: "btn", text: title })
  );
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const release = busy(form);
    try {
      const data = formData(form), username = (data.username || "").trim();
      if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || !data.password) throw new Error("请输入有效用户名和密码");
      const salt = includeInvite || includeBootstrap ? randomHex(16) : (await api("/api/auth/challenge?username=" + encodeURIComponent(username))).salt;
      const verifier = await derive(data.password, salt);
      const initialPassword = !includeInvite && !includeBootstrap && data.password === "cauc+" + username ? data.password : undefined;
      delete data.password;
      const endpoint = includeBootstrap ? "/api/bootstrap" : includeInvite ? "/api/register" : "/api/login";
      await post(endpoint, { ...data, username, salt, verifier, initialPassword });
      config = await api("/api/config");
      await refreshMe();
      resetMentorPanel();
      const unread = me?.role === "student" && !me.must_change_password ? await refreshUnreadNotifications() : [];
      navigate(me?.must_change_password ? "password" : me?.role === "student" ? "profile" : "admin");
      if (unread.length) notificationPopup(unread);
    } catch (error) { feedback(form, error.message); }
    finally { release(); }
  });
  const status = includeBootstrap ? "首次配置" : includeInvite ? "凭邀请码注册" : "受邀访问";
  const subtitle = includeBootstrap
    ? "仅首次部署时需要初始化令牌，完成后使用普通登录。"
    : includeInvite ? "仅辅导员使用管理员提供的一次性邀请码注册。" : "学生首次登录：用户名为学号，初始密码为 cauc+学号；登录后须立即修改。";
  const card = panel(make("span", { className: "auth-status", text: status }), h(title), make("p", { className: "auth-help", text: subtitle }),
    form,
    includeBootstrap ? null : make("div", { className: "auth-switch" },
      make("span", { text: includeInvite ? "已有账号？" : "辅导员收到了邀请码？" }),
      button(includeInvite ? "返回登录" : "辅导员注册", () => navigate(includeInvite ? "login" : "register"), "linklike")));
  card.classList.add("auth-card");
  const story = make("div", { className: "auth-story" },
    make("div", { className: "auth-story-copy" },
      make("span", { className: "story-intro", text: "中国民航大学 / 培养流程" }),
      make("h1", {}, "党员发展计划", make("br"), "辅助系统"),
      p("在这里统一查看培养进度、材料清单和站内通知")),
    make("ol", { className: "stage-strip", "aria-label": "培养流程的五个阶段" },
      ["申请入党", "积极分子培养", "发展对象考察", "接收预备党员", "培养考察与转正"].map(name => make("li", { text: name }))));
  return make("div", { className: "auth-layout" }, story, card);
}
function login() { return accountForm("登录"); }
function registration() { return accountForm("辅导员受邀注册", true); }
function bootstrap() { return accountForm("初始化管理员", false, true); }

function passwordPage() {
  const firstLogin = !!me?.must_change_password;
  const form = make("form", { className: "auth-form" },
    field(firstLogin ? "初始密码" : "当前密码", "oldPassword", "password"),
    field("新密码", "newPassword", "password"),
    field("再次输入新密码", "confirmPassword", "password"),
    make("button", { type: "submit", className: "btn", text: firstLogin ? "设置新密码并继续" : "修改密码" }));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const release = busy(form);
    try {
      const values = formData(form);
      if (!values.newPassword || values.newPassword !== values.confirmPassword) throw new Error("请确认两次输入的新密码一致");
      if (values.newPassword === values.oldPassword) throw new Error("新密码不能与当前密码相同");
      const challenge = await api("/api/auth/challenge?username=" + encodeURIComponent(me.username));
      const oldVerifier = await derive(values.oldPassword, challenge.salt);
      const newSalt = randomHex(16), newVerifier = await derive(values.newPassword, newSalt);
      await post("/api/change-password", { oldVerifier, newVerifier, newSalt, ...(firstLogin ? { oldPassword: values.oldPassword, newPassword: values.newPassword } : {}) });
      form.reset();
      await refreshMe();
      if (firstLogin) navigate(me?.role === "student" ? "profile" : "admin");
      else feedback(form, "密码已更新，其他设备的登录已退出。", "success");
    } catch (error) { feedback(form, error.message); }
    finally { release(); }
  });
  return make("div", { className: "view view-password" }, pageHead("ACCOUNT / SECURITY", firstLogin ? "首次登录 · 设置新密码" : "修改密码", firstLogin ? "请先修改初始密码，完成后即可使用档案与成长导师。" : "更新密码后，其他设备上的登录会自动退出。"),
    panel(make("div", { className: "panel-head" }, make("h2", { text: "账号安全" })), form));
}

function recordsPage(page) {
  const recycle = page === "recycle";
  const title = recycle ? "回收站" : "操作记录";
  const description = recycle ? "恢复已移除的账号及其档案。" : "查询访问、提交及后台操作，时间使用北京时间。";
  const body = make("div");
  const rows = make("tbody");
  const columns = recycle ? ["账号", "角色", "班级", "移除时间", "操作"] : ["时间", "操作者", "操作", "IP", "对象"];
  const table = tableWrap(make("table", { className: "data" }, make("thead", {}, make("tr", {}, columns.map(text => make("th", { text })))), rows));
  let cursor = "";
  const more = button("加载更多", load, "secondary");
  async function load() {
    const release = busy(body);
    try {
      const data = await api("/api/admin/" + (recycle ? "recycle" : "operation-logs" + (cursor ? "?before=" + cursor : "")));
      const items = recycle ? data.accounts : data.logs;
      if (!cursor) rows.replaceChildren();
      for (const item of items) {
        const cells = recycle ? [
          [item.name, item.username].filter(Boolean).join(" · "), item.role === "student" ? "学生" : "辅导员", item.class_name || "—", displayTime(item.deleted_at),
          button("恢复", async () => {
            if (!await actionDialog("恢复账号", "恢复后，" + (item.name || item.username) + "可以重新登录。", "恢复")) return;
            try { await post("/api/admin/recycle/restore", { userId: item.id }); await load(); feedback(body, "账号已恢复", "success"); }
            catch (error) { feedback(body, error.message); }
          }, "secondary")
        ] : [
          displayTime(item.occurred_at), item.actor_name || item.actor_role || "访客",
          ({
            login: "登录", submit_check: "提交材料",
            archive_student: "学生移入回收站", archive_counselor: "辅导员移入回收站", restore_account: "恢复账号",
            view_profile: "查看培养档案", view_check: "打开材料提交", view_checks: "查看审阅队列",
            view_forms: "打开资料下载", view_notifications: "查看通知", view_admin: "打开工作台",
            view_operations: "查看操作记录", view_recycle: "打开回收站", view_password: "打开密码设置",
            open_mentor: "打开助理", scan_crop: "生成扫描预览", scan_rotate: "旋转扫描页",
            scan_mode: "调整扫描效果", scan_use: "采用扫描件", scan_ocr: "发起本机文字识别",
            roster_edit: "修改名单行", roster_remove: "移除名单行", preview_submission: "预览提交材料",
            dialog_confirm: "确认操作", dialog_cancel: "取消操作", download_official_form: "下载公开表格",
            daily_reminders: "执行定时提醒"
          })[item.action] || item.method + " " + item.action,
          item.ip || "—", item.targets || "—"
        ];
        rows.append(make("tr", {}, cells.map(value => make("td", {}, value))));
      }
      cursor = data.next;
      more.hidden = !cursor;
      if (!items.length && !rows.children.length) rows.append(make("tr", {}, make("td", { colspan: columns.length, text: "暂无记录" })));
    } catch (error) { feedback(body, error.message); }
    finally { release(); }
  }
  more.hidden = true;
  body.append(table, more);
  load();
  return make("div", { className: "view" }, pageHead("STAFF", title, description), panel(body));
}

function profilePage() {
  const profileTitle = () => make("h1", { className: "page-title" },
    make("span", { text: "我的档案" }),
    make("span", { className: "greeting-title", text: " | " + dayPart() + "好！" }));
  const shell = make("div", { className: "view view-profile" }, pageHead("STUDENT / OVERVIEW", profileTitle(), "查看当前培养阶段、下一步节点和材料完成情况。"), skeleton());
  (async () => { try {
    const data = await api("/api/profile");
    const profile = data.profile;
    const stageOrder = ["application", "activist", "development-target", "probationary-acceptance", "probationary-regularization"];
    const stageNumber = Math.max(1, stageOrder.indexOf(profile.current_stage_slug) + 1);
    const materialState = x => x.review_status === "退回修改" ? "退回修改" :
      x.review_status === "已通过" || x.status === "已通过" ? "已通过" :
      x.review_status === "待审阅" ? x.monitor_approved ? "待辅导员审阅" : "待学生管理员初审" : x.status || "未提交";
    const done = data.materials.filter(x => materialState(x) === "已通过").length;
    const total = data.materials.length;
    const completion = total ? Math.round(done * 100 / total) : 0;
    const summary = panel(
      make("div", { className: "panel-head" },
        make("h2", { text: profile.name + "的培养档案" }),
        make("span", { className: "badge", text: profile.student_no })),
      p([data.college, data.major, data.className, profile.grade].filter(Boolean).join(" · ") || "学院/专业/班级未填"),
      make("div", { className: "progress-track" }, make("span", { style: "width:" + (stageNumber / 5 * 100) + "%" })),
      make("p", { className: "small", text: "培养流程 · 第 " + stageNumber + " / 5 阶段" }));
    const stats = make("div", { className: "metric-grid" },
      metric("当前阶段", data.stage?.name || "未开始", "培养进度", true),
      metric("当前节点", data.node?.name || "未设置", data.node?.duration_rule || "按计划推进"),
      metric("材料完成", done + " / " + total, "本阶段材料已通过 " + completion + "%"));
    const table = make("table", { className: "data" },
      make("thead", {}, make("tr", {}, ["材料名称", "类别", "填写方式", "状态"].map(x => make("th", { text: x })))),
      make("tbody", {}, data.materials.map(item => make("tr", {},
        make("td", { text: item.name }),
        make("td", { text: ({ A: "档案材料", B: "流程表", C: "会议记录" })[item.category] || item.category }),
        make("td", { text: ({ red: "个人填写", blue: "组织审批", black: "支部填写" })[item.fill_method] || item.fill_method }),
        make("td", {}, make("span", { className: "badge " + (materialState(item) === "已通过" ? "done" : "missing"), text: materialState(item) }),
          item.checked_at ? make("div", { className: "small", text: "已提交 · " + displayTime(item.checked_at) }) : null,
          item.reviewed_at ? make("div", { className: "small", text: "已审阅 · " + displayTime(item.reviewed_at) }) : null,
          item.review_note ? make("div", { className: "small", text: "审阅说明：" + item.review_note }) : null,
          item.checked_at ? make("details", { className: "submission-timeline" }, make("summary", { text: "提交历史" }),
            make("ol", {}, (data.submissionHistory || []).filter(entry => entry.material_id === item.id).map(entry => make("li", {},
              make("div", { className: "small", text: displayTime(entry.checked_at) + " · " + (entry.reviewed_at ? entry.review_status : "已提交") }),
              entry.monitor_approved_at ? make("div", { className: "small", text: displayTime(entry.monitor_approved_at) + " · 学生管理员初审通过" }) : null,
              entry.review_note ? make("div", { className: "small", text: entry.review_note }) : null,
              make("a", { className: "text-link small", href: "/api/checks/" + entry.id + "/file", text: "下载该版本" }))))) : null,
          materialState(item) === "退回修改" ? make("a", { href: "#check", className: "text-link small", text: "修改后重新提交" }) : null)))));
    const materials = panel(make("div", { className: "panel-head" },
      make("h2", { text: "本阶段材料" }), make("span", { className: "small", text: "共 " + total + " 项" })),
      total ? tableWrap(table) : make("div", { className: "empty-state" }, make("strong", { text: "暂无材料" }), "此阶段尚未配置材料清单。"));
    shell.replaceChildren(pageHead("STUDENT / OVERVIEW", profileTitle(), "查看当前培养阶段、下一步节点和材料完成情况。"),
      summary, stats,
      ...(data.next ? [notice("下一步：" + data.next.name + "。请按计划准备相关材料。")] : []),
      materials);
  } catch (error) { shell.replaceChildren(pageHead("STUDENT / OVERVIEW", "我的档案"), notice(error.message, "error")); } })();
  return shell;
}

const girlFrameCount = 8;
let girlFramesReady = null;
function preloadGirlFrames() {
  if (!girlFramesReady) {
    girlFramesReady = Promise.all(Array.from({ length: girlFrameCount }, (_, i) => {
      const img = new Image();
      img.decoding = "async";
      img.src = "/girl/frame_" + i + ".webp";
      return img.decode().catch(() => {});
    })).then(() => true);
  }
  return girlFramesReady;
}
function mentorGirl() {
  preloadGirlFrames();
  return make("img", { src: "/girl/frame_0.webp", alt: "", className: "mentor-girl-img", draggable: "false" });
}

function rosterEditor(initial, alive, onDone) {
  const draft = make("div", { className: "office-roster" });
  const rosterForm = make("form", { className: "office-roster-form" });
  const fields = [];
  const list = make("div", { className: "office-roster-list" });
  const result = make("div");
  const classSelect = select("所属班级", "classId", [["", "请选择班级"], ...initial.classes.map(item => [item.id, item.name])], initial.classId);
  const invalidated = () => result.replaceChildren();
  initial.rows.forEach(row => {
    const name = field("姓名", "name", "text", false, row.name);
    const number = field("学号", "studentNo", "text", false, row.studentNo);
    number.querySelector("input").inputMode = "numeric";
    const error = make("p", { className: "form-feedback", role: "status", text: row.issues.join("；") });
    const current = { line: row.line, name: name.querySelector("input"), number: number.querySelector("input"), error };
    const section = make("div", { className: "office-roster-row" }, make("span", { className: "small", text: "第 " + row.line + " 行" }),
      name, number, button("移除此行", () => {
        recordActivity("roster_remove");
        section.remove();
        fields.splice(fields.indexOf(current), 1);
        invalidated();
      }, "linklike"), error);
    fields.push(current);
    list.append(section);
  });
  rosterForm.addEventListener("input", event => {
    invalidated();
    const changed = fields.find(field => field.name === event.target || field.number === event.target);
    if (changed) changed.error.textContent = "请重新校验此行";
  });
  list.addEventListener("change", () => recordActivity("roster_edit"));
  rosterForm.addEventListener("submit", async event => {
    event.preventDefault();
    invalidated();
    if (!alive()) return;
    if (!fields.length) return feedback(rosterForm, "名单已清空，请重新上传。");
    const release = busy(rosterForm);
    const checkedFields = [...fields];
    const rows = checkedFields.map(field => ({ line: field.line, name: field.name.value, studentNo: field.number.value }));
    const classId = rosterForm.elements.classId.value;
    try {
      const preview = await post("/api/office/roster-preview", { rows, classId });
      if (!alive() || !draft.isConnected || classId !== rosterForm.elements.classId.value ||
        fields.length !== rows.length || rows.some((row, index) => fields[index] !== checkedFields[index] || fields[index].name.value !== row.name || fields[index].number.value !== row.studentNo)) return;
      preview.roster.rows.forEach((row, index) => { fields[index].error.textContent = row.issues.join("；"); });
      if (!preview.plan) return feedback(rosterForm, classId ? "请修正标出的行，再校验名单。" : "请选择所属班级，再校验名单。");
      const confirm = button("确认登记", async () => {
        confirm.disabled = true;
        const controls = [...rosterForm.elements].filter(control => control !== confirm && !control.disabled);
        controls.forEach(control => { control.disabled = true; });
        try {
          const outcome = await post("/api/office/execute", { planId: preview.plan.id, jitToken: preview.plan.jitToken });
          if (draft.isConnected && alive()) { rosterForm.remove(); onDone(outcome.message); }
        } catch (error) { confirm.disabled = false; feedback(rosterForm, error.message + "。可重新校验后再试。"); }
        finally { controls.forEach(control => { control.disabled = false; }); }
      });
      result.append(p(preview.plan.preview), confirm);
    } catch (error) { feedback(rosterForm, error.message); }
    finally { release(); }
  });
  rosterForm.append(classSelect, list, make("button", { type: "submit", className: "secondary", text: "校验名单" }), result);
  draft.append(rosterForm);
  return draft;
}

function mentorPage() {
  const staffAgent = me?.role === "counselor" || me?.role === "admin";
  const shell = make("div", { className: "mentor-app" + (staffAgent ? " office-agent" : "") }, notice("正在打开" + (staffAgent ? "办公助理" : "成长导师") + "…"));
  (async () => { try {
    const epoch = mentorEpoch;
    const alive = () => epoch === mentorEpoch;
    const status = await api("/api/mentor");
    const icon = (path, label) => { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.8"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", path); svg.append(p); return svg; };
    const links = me?.role === "counselor" || me?.role === "admin"
      ? [["admin", "工作台"], ["forms", "资料下载"], ["checks", "已提交文件"]]
      : me?.role === "student" ? [["profile", "我的档案"], ["forms", "资料下载"], ["check", "材料提交"], ["notifications", "通知中心"]]
        : [["login", "登录"], ["register", "辅导员注册"]];
    const navLinks = () => links.map(([page, label]) => make("a", { href: "#" + page, text: label, onclick: closeMentor }));
    const log = make("div", { className: "mentor-thread", role: "log", "aria-live": "polite", "aria-label": "成长导师对话", tabindex: "0" });
    const empty = make("div", { className: "mentor-empty" },
      make("span", { className: "mentor-kicker", text: staffAgent ? "OFFICE ASSISTANT / 办公助理" : "GROWTH MENTOR / 成长导师" }),
      make("h1", { text: staffAgent ? "今天想处理什么？" : "今天想了解什么？" }),
      make("p", { text: staffAgent ? "告诉我任务，或上传名单与文件。我会整理执行清单，待你确认后处理。" : "从培养流程到写作思路，直接说出你的问题。" }));
    const prompts = make("div", { className: "mentor-prompts" },
      (staffAgent ? ["批量登记学生", "发送站内信", "批量推进培养阶段", "查询学生名单"] : ["我现在处于哪个入党阶段？", "我交了哪些材料，还有哪些没交？", "这个系统怎么使用？", "入党申请书如何组织结构？"])
        .map(question => button(question, () => { textarea.value = question; form.requestSubmit(); }, "mentor-prompt")));
    empty.append(prompts);
    const sourceView = sources => make("details", { className: "mentor-sources" },
      make("summary", { text: "查看依据 · " + sources.length + " 条" }),
      make("div", { className: "mentor-source-items" }, sources.map((source, index) => make("div", { className: "mentor-source" },
        make("strong", { text: (index + 1) + ". " + source.title + " · " + source.section }), make("p", { text: source.excerpt })))));
    const appendMessage = item => {
      const row = make("div", { className: "mentor-row " + item.role });
      const msg = make("div", { className: "mentor-message" });
      if (item.role === "assistant" && !staffAgent) msg.innerHTML = renderMarkdown(item.content || "");
      else msg.textContent = item.content || "";
      const body = make("div", { className: "mentor-bubble" }, msg);
      if (item.sources?.length) body.append(sourceView(item.sources));
      row.append(body); log.append(row); return row;
    };
    const textarea = make("textarea", { name: "question", rows: "1", maxlength: "1000", required: "", "aria-label": staffAgent ? "向办公助理描述任务" : "向成长导师提问", placeholder: staffAgent ? "描述要完成的办公任务…" : status.enabled ? "向成长导师提问…" : "检索培养资料…" });
    const send = make("button", { type: "submit", className: "mentor-send", "aria-label": "发送问题", title: "发送问题" }, icon("M4 12 20 4 14 20 11 13 4 12Z M11 13 20 4", "发送"));
    let pendingOfficePlan = null;
    let pendingOfficeButton = null;
    let officeHistory = [];
    let selectedFile = null;
    let selectedFiles = [];
    const fileInput = make("input", { type: "file", accept: ".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document", className: "mentor-file-input", "aria-label": "选择 Word DOCX 或 PDF 文件" });
    const attachment = make("div", { className: "mentor-attachment", hidden: "" });
    let selectedFromZip = false;
    const clearFile = () => { selectedFile = null; selectedFiles = []; selectedFromZip = false; fileInput.value = ""; attachment.hidden = true; attachment.replaceChildren(); textarea.required = true; };
    const attach = make("button", { type: "button", className: "mentor-attach", "aria-label": "上传 Word 或 PDF 文件", title: "上传 Word DOCX 或 PDF" }, icon("M8 12.5 14.5 6a3 3 0 0 1 4.2 4.2l-8.1 8.1a5 5 0 0 1-7.1-7.1l8.4-8.4", "附件"));
    const acceptStaffFiles = (incoming, zipNote) => {
      if (!incoming.length) { clearFile(); appendMessage({ role: "assistant", content: "没有可用的文件。支持 Word、PDF、图片及 Excel、CSV、TXT，也可直接上传包含这些文件的 ZIP 压缩包。" }); return; }
      if (incoming.length > 30 || incoming.some(item => (!uploadType(item.name, true) && !/\.(csv|txt)$/i.test(item.name)) || item.size < 1 || item.size > maxFileBytes)) {
        clearFile(); appendMessage({ role: "assistant", content: "每次最多 30 份文件，每份最大 10 MB。支持 Word、PDF、图片及 Excel、CSV、TXT 名单，或包含这些文件的 ZIP 压缩包。" }); return;
      }
      if (incoming.reduce((total, item) => total + item.size, 0) > maxBatchBytes) {
        clearFile(); appendMessage({ role: "assistant", content: "这批附件超过 30 MB，请分批发送。" }); return;
      }
      if (new Set(incoming.map(item => item.name.toLowerCase())).size !== incoming.length) {
        clearFile(); appendMessage({ role: "assistant", content: "有多份附件同名，请改名或分批发送。" }); return;
      }
      selectedFiles = incoming; textarea.required = false; attachment.hidden = false;
      attachment.replaceChildren(make("span", { text: (zipNote ? zipNote + "：" : "") + incoming.map(item => item.name).join("、") }), button("移除", clearFile, "mentor-remove-attachment"));
    };
    const acceptFile = file => {
      if (!file || (Array.isArray(file) && !file.length)) return;
      if (staffAgent) {
        const raw = Array.isArray(file) ? file : [file];
        const zips = raw.filter(item => /\.zip$/i.test(item.name));
        const rest = raw.filter(item => !/\.zip$/i.test(item.name)).map(item => normalizedAttachment(item, true));
        if (!zips.length) { selectedFromZip = false; acceptStaffFiles(rest, null); return; }
        attachment.hidden = false;
        attachment.replaceChildren(make("span", { text: "正在解包压缩包…" }));
        (async () => {
          try {
            const all = rest.slice(), skippedAll = [];
            for (const item of zips) {
              const { files, skipped } = await expandZip(item);
              all.push(...files); skippedAll.push(...skipped);
            }
            selectedFromZip = true;
            acceptStaffFiles(all, "已从压缩包解出 " + all.length + " 份文件" + (skippedAll.length ? "（跳过不支持：" + skippedAll.join("、") + "）" : ""));
          } catch (error) { clearFile(); appendMessage({ role: "assistant", content: error.message }); }
        })();
        return;
      }
      const allowed = /\.(docx|pdf)$/i;
      if (!allowed.test(file.name) || file.size > 10 * 1024 * 1024 || file.size < 1) {
        clearFile(); appendMessage({ role: "assistant", content: "请上传不超过 10 MB 的 Word DOCX 或 PDF。旧版 .doc 请另存为 .docx。" }); return;
      }
      selectedFile = file; textarea.required = false; attachment.hidden = false;
      attachment.replaceChildren(make("span", { text: file.name }), button("移除", clearFile, "mentor-remove-attachment"));
    };
    attach.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => acceptFile(staffAgent ? Array.from(fileInput.files || []) : fileInput.files?.[0]));
    const form = make("form", { className: "mentor-composer" }, fileInput, attachment,
      make("div", { className: "mentor-composer-box" }, attach, textarea, send),
      make("p", { className: "mentor-composer-note", text: "校内要求以辅导员通知为准" }));
    let dragDepth = 0;
    form.addEventListener("dragenter", event => { event.preventDefault(); dragDepth++; form.classList.add("mentor-dragging"); });
    form.addEventListener("dragleave", event => { event.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; form.classList.remove("mentor-dragging"); } });
    form.addEventListener("dragover", event => { event.preventDefault(); });
    form.addEventListener("drop", event => { event.preventDefault(); dragDepth = 0; form.classList.remove("mentor-dragging"); acceptFile(staffAgent ? Array.from(event.dataTransfer?.files || []) : event.dataTransfer?.files?.[0]); });
    let userReading = false;
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) log.addEventListener(type, () => { userReading = true; }, { passive: true });
    const scrollEnd = () => { log.scrollTop = log.scrollHeight; };
    const focusReplyTop = row => {
      if (userReading || !row?.isConnected) return;
      const padding = parseFloat(getComputedStyle(log).paddingTop) || 0;
      const offset = row.getBoundingClientRect().top - log.getBoundingClientRect().top;
      log.scrollTop += offset - padding - 10;
    };
    const reset = () => {
      mentorHistory = []; officeHistory = []; pendingOfficePlan = null; pendingOfficeButton = null; userReading = false;
      mentorConversationId = randomHex(16);
      log.replaceChildren(empty);
      textarea.value = ""; clearFile(); textarea.focus();
    };
    const newChat = () => button("新对话", reset, "mentor-new-chat");
    const aside = make("aside", { className: "mentor-sidebar" },
      make("a", { className: "mentor-school", href: "#profile", "aria-label": "返回我的档案" }, make("img", { src: "/cauc-wordmark.png", alt: "中国民航大学" })),
      make("div", { className: "mentor-sidebar-title", text: "党员发展计划辅助系统" }), newChat(),
      make("div", { className: "mentor-nav-label", text: "工作区" }), make("nav", { className: "mentor-sidebar-nav", "aria-label": "学生工作区" }, navLinks()),
      make("div", { className: "mentor-sidebar-bottom" }, make("span", { text: "当前会话" }), make("strong", { text: me?.name || me?.username || "学生" })));
    const menu = make("details", { className: "mentor-mobile-menu" }, make("summary", { "aria-label": "打开工作区菜单" }, icon("M4 7h16 M4 12h16 M4 17h16", "菜单")), make("nav", { "aria-label": "学生工作区" }, navLinks()));
    const girlImg = mentorGirl();
    let girlRaf = 0;
    const setGirlFrame = n => { girlImg.src = "/girl/frame_" + n + ".webp"; };
    const stopGirl = () => { if (girlRaf) cancelAnimationFrame(girlRaf); girlRaf = 0; };
    // 用 requestAnimationFrame 驱动帧动画：与显示器刷新同步，比 setTimeout 更可靠，
    // 且帧图在 mentorGirl() 已预解码，低配机上不会因解码卡顿而看不到动画。
    const playGirlTyping = () => {
      stopGirl();
      const start = performance.now();
      const intro = [320, 300, 260, 240];
      const loopDur = 240;
      const step = now => {
        const elapsed = now - start;
        let frame;
        let introTotal = 0;
        for (let i = 0; i < 4; i++) { introTotal += intro[i]; if (elapsed < introTotal) { frame = 1 + i; break; } }
        if (frame === undefined) frame = 5 + Math.floor(((elapsed - introTotal) / loopDur) % 3);
        setGirlFrame(frame);
        girlRaf = requestAnimationFrame(step);
      };
      girlRaf = requestAnimationFrame(step);
    };
    const playGirlBack = () => {
      stopGirl();
      const start = performance.now();
      const backDur = 180;
      const step = now => {
        const idx = Math.min(4, Math.floor((now - start) / backDur));
        setGirlFrame(4 - idx);
        if (idx < 4) girlRaf = requestAnimationFrame(step);
      };
      girlRaf = requestAnimationFrame(step);
    };
    const collapseHero = make("button", { type: "button", className: "mentor-hero-close", "aria-label": "收起顶部", title: "收起顶部", text: "×" });
    const expandHero = make("button", { type: "button", className: "mentor-hero-restore", "aria-label": "展开顶部", title: "展开顶部", text: "＋", hidden: "" });
    const setHeroCollapsed = collapsed => { shell.classList.toggle("hero-collapsed", collapsed); expandHero.hidden = !collapsed; };
    collapseHero.onclick = () => setHeroCollapsed(true);
    expandHero.onclick = () => setHeroCollapsed(false);
    const hero = make("div", { className: "mentor-hero" },
      make("div", { className: "mentor-girl", "aria-hidden": "true" }, girlImg),
      make("div", { className: "mentor-titlebox" },
        collapseHero,
        make("strong", { text: mentorTitle() }),
        make("span", { text: me ? "党员发展计划辅助系统" : "访客模式 · 登录后可知你的档案" })));
    const header = make("header", { className: "mentor-topbar" },
      make("div", { className: "mentor-topbar-left" }, menu, newChat(), expandHero));
    if (staffAgent) {
      fileInput.multiple = true;
      fileInput.accept = officeAccept;
      fileInput.setAttribute("aria-label", "选择办公任务文件");
      attach.setAttribute("aria-label", "选择办公任务文件");
      attach.title = "选择最多 30 份文件，或包含文件的 ZIP 压缩包";
    }
    const content = make("div", { className: "mentor-content" }, log, form);
    shell.replaceChildren(aside, make("section", { className: "mentor-main", "aria-label": "成长导师" }, hero, header, content));
    if (mentorHistory.length) for (const item of mentorHistory) appendMessage(item); else log.append(empty);
    const resize = () => { textarea.style.height = "auto"; textarea.style.height = Math.min(textarea.scrollHeight, 176) + "px"; };
    textarea.addEventListener("input", resize);
    textarea.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
    const handleOfficeSubmit = async (question, files) => {
      if (!question && !files.length) return;
      if (pendingOfficeButton) pendingOfficeButton.disabled = true;
      pendingOfficeButton = null;
      pendingOfficePlan = null;
      userReading = false;
      if (log.contains(empty)) empty.remove();
      appendMessage({ role: "user", content: question + (files.length ? "\n附件：" + files.map(file => file.name).join("、") : "") });
      const loading = appendMessage({ role: "assistant", content: "正在整理可执行的任务清单…" });
      const release = busy(form);
      attach.disabled = true;
      textarea.value = ""; textarea.blur(); resize(); playGirlTyping(); scrollEnd();
      try {
        let documentText = "";
        let structuredRoster = null;
        const task = [...officeHistory.filter(item => item.role === "user").slice(-2).map(item => item.content), question].join("\n");
        if (files.length && !/归档|资料下载|上传.*表格/.test(question) &&
          (/名单|登记|注册|添加辅导员|删除|群发|收件人|站内信|推进|审阅|更新|修改|导入/.test(task) ||
          files.every(file => /\.(xlsx|csv|txt)$/i.test(file.name)) && !/上传|归档|资料下载/.test(task))) {
          for (const file of files) {
            if (!/\.(xlsx|csv|txt|docx|pdf)$/i.test(file.name)) continue;
            try {
              const extracted = await extractRosterText(file);
              documentText += "\n文件：" + file.name + "\n" + extracted.slice(0, 10000);
              if (files.length === 1 && /登记|注册|导入|添加.*学生/.test(task) && !/辅导员|删除|通知|更新/.test(question)) {
                if (/\.xlsx$/i.test(file.name)) structuredRoster = readStructuredStudentRoster(extracted, "\t");
                if (/\.csv$/i.test(file.name)) structuredRoster = readStructuredStudentRoster(extracted, /[,，]/);
              }
            } catch {
              documentText += "\n未能从附件「" + file.name + "」提取文字。仍可按文件名安排归档；如需提取名单，请提供可搜索的文档或粘贴文字。";
            }
          }
        }
        const result = structuredRoster?.length
          ? { ...await post("/api/office/roster-preview", { rows: structuredRoster }), answer: "请逐行核对名单，选择班级后校验。" }
          : await post("/api/office/plan", { question, documentText: documentText.slice(0, 25000), files: files.map(file => ({ name: file.name })), history: officeHistory.slice(-12) });
        if (!alive()) return;
        officeHistory.push({ role: "user", content: question }, { role: "assistant", content: result.answer });
        if (officeHistory.length > 24) officeHistory = officeHistory.slice(-24);
        loading.remove();
        const row = appendMessage({ role: "assistant", content: result.answer + (result.plan ? "\n\n待确认操作\n" + result.plan.preview : "") });
        if (result.roster) row.querySelector(".mentor-bubble").append(rosterEditor(result.roster, alive, message => {
          officeHistory = [];
          clearFile();
          focusReplyTop(appendMessage({ role: "assistant", content: message }));
        }));
        if (result.plan) {
          pendingOfficePlan = result.plan.id;
          const plannedFiles = files.slice();
          const label = ["delete_students", "delete_counselors"].includes(result.plan.type) ? "移入回收站" :
            result.plan.type === "send_notifications" ? "确认发送" : "确认执行";
          const confirm = button(label, async () => {
            if (pendingOfficePlan !== result.plan.id || confirm.disabled) return;
            confirm.disabled = true;
            const progress = appendMessage({ role: "assistant", content: "正在执行已确认的任务…" });
            const releaseExecution = busy(form);
            attach.disabled = true;
            playGirlTyping(); scrollEnd();
            try {
              let outcome, temporaryPassword;
              if (result.plan.type === "reset_password") {
                temporaryPassword = randomHex(12);
                const newSalt = randomHex(16), newVerifier = await derive(temporaryPassword, newSalt);
                outcome = await post("/api/office/execute", { planId: result.plan.id, jitToken: result.plan.jitToken, newSalt, newVerifier });
              } else if (result.plan.type === "upload_forms" || result.plan.type === "upload_student_files") {
                const body = new FormData();
                body.append("planId", result.plan.id);
                body.append("jitToken", result.plan.jitToken);
                plannedFiles.forEach(file => body.append("file", file, file.name));
                outcome = await uploadWithProgress("/api/office/execute", body, progress.querySelector(".mentor-bubble") || progress);
              } else outcome = await post("/api/office/execute", { planId: result.plan.id, jitToken: result.plan.jitToken });
              if (!alive()) return;
              progress.remove();
              pendingOfficePlan = null;
              pendingOfficeButton = null;
              clearFile();
              focusReplyTop(appendMessage({ role: "assistant", content: outcome.message + (temporaryPassword ? "\n\n本次临时密码（仅显示在此处）： " + temporaryPassword : "") }));
            } catch (error) {
              progress.remove();
              confirm.disabled = false;
              focusReplyTop(appendMessage({ role: "assistant", content: "执行未完成：" + error.message + "。请核对后重试。" }));
            } finally { playGirlBack(); releaseExecution(); attach.disabled = false; }
          }, "btn");
          pendingOfficeButton = confirm;
          row.querySelector(".mentor-bubble").append(confirm);
        }
        focusReplyTop(row);
      } catch (error) { loading.remove(); focusReplyTop(appendMessage({ role: "assistant", content: error.message + "。请补充信息后重试。" })); }
      finally { playGirlBack(); release(); attach.disabled = false; }
    };
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const question = form.elements.question.value.trim();
      const file = selectedFile;
      if (staffAgent) {
        const zipHint = selectedFromZip && !question ? "请把这批文件按培养阶段上传到资料下载专区" : question;
        await handleOfficeSubmit(zipHint, selectedFiles); return;
      }
      if (!file && question.length < 2) { textarea.setCustomValidity("请输入至少两个字的问题"); textarea.reportValidity(); textarea.setCustomValidity(""); return; }
      const release = busy(form);
      attach.disabled = true;
      const history = mentorHistory.slice(-6);
      userReading = false;
      if (log.contains(empty)) empty.remove();
      const submitIntent = /(提交|上传|交|归档|递交)/.test(question) && /(材料|文件|申请书|附件|思想汇报|自传|表)/.test(question);
      const displayQuestion = file ? (submitIntent ? "提交文件" : "检查文件") + "：" + file.name + (question ? "\n" + question : "") : question;
      appendMessage({ role: "user", content: displayQuestion });
      const loading = appendMessage({ role: "assistant", content: file ? (submitIntent ? "正在准备提交…" : "正在读取文档文字…") : status.enabled ? "正在思考…" : "正在检索…" });
      playGirlTyping();
      textarea.value = ""; textarea.blur(); resize(); scrollEnd();
      try {
        let result;
        if (file) {
          if (submitIntent && status.enabled) {
            const stageForm = new FormData();
            stageForm.append("file", file, file.name);
            const staged = await uploadWithProgress("/api/agent/upload", stageForm, loading.querySelector(".mentor-bubble") || loading);
            result = await post("/api/agent/plan", { question, files: [{ name: file.name, ref: staged.file_ref }], conversationId: mentorConversationId ||= randomHex(16) });
            clearFile();
          } else {
            const text = await extractReviewText(file);
            loading.querySelector(".mentor-message").textContent = "正在识别表单并核对填写规范…";
            result = await post("/api/mentor/review", { filename: file.name, text });
            clearFile();
          }
        } else {
          result = await post(status.enabled ? "/api/agent/plan" : "/api/mentor/retrieve", status.enabled ? { question, history, conversationId: mentorConversationId ||= randomHex(16) } : { question, history });
          if (status.enabled && result.deferred) result = await post("/api/mentor/chat", { question, history });
        }
        if (!alive()) return;
        loading.remove();
        if (status.enabled || file) {
          mentorHistory.push({ role: "user", content: displayQuestion }, { role: "assistant", content: result.answer || "", route: result.route, sources: result.sources || [] });
          const row = appendMessage({ role: "assistant", content: "", sources: result.sources });
          const msg = row.querySelector(".mentor-message");
          focusReplyTop(row);
          // 先按 markdown 渲染成最终排版，再逐字回填渲染后的文本，避免用户看到原始 markdown 符号
          msg.innerHTML = renderMarkdown(result.answer || "");
          const pending = [];
          const walker = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.nodeValue && node.nodeValue.length) { pending.push({ node, text: node.nodeValue }); node.nodeValue = ""; }
          }
          let tick = 0;
          for (const item of pending) {
            for (const ch of item.text) {
              if (!alive()) return;
              item.node.nodeValue += ch;
              if (tick % 8 === 0) focusReplyTop(row);
              tick++;
              await new Promise(r => setTimeout(r, 14));
            }
          }
          focusReplyTop(row);
          if (result.action?.type === "navigate") {
            row.querySelector(".mentor-bubble").append(button("打开「" + agentRouteLabel(result.action.route) + "」", () => { closeMentor(); location.hash = result.action.route; }, "btn"));
          }
          if (result.plan) {
            const confirm = button("确认执行", async () => {
              if (confirm.disabled) return;
              confirm.disabled = true;
              const progress = appendMessage({ role: "assistant", content: "正在执行已确认的操作…" });
              const releaseExecution = busy(form);
              attach.disabled = true; playGirlTyping(); scrollEnd();
              try {
                const outcome = await post("/api/agent/execute", { planId: result.plan.id, payloadHash: result.plan.payloadHash });
                if (!alive()) return;
                progress.remove();
                focusReplyTop(appendMessage({ role: "assistant", content: outcome.message }));
              } catch (error) {
                progress.remove();
                confirm.disabled = false;
                focusReplyTop(appendMessage({ role: "assistant", content: "执行未完成：" + error.message + "。请核对后重试。" }));
              } finally { playGirlBack(); releaseExecution(); attach.disabled = false; }
            }, "btn");
            row.querySelector(".mentor-bubble").append(make("div", { className: "mentor-plan-preview" }, p(result.plan.preview)), confirm);
          }
        } else {
          mentorHistory.push({ role: "user", content: displayQuestion });
          focusReplyTop(appendMessage({ role: "assistant", content: result.sources?.length ? "找到以下相关资料：" : "目前没有找到相关资料，请换个更具体的问法。", sources: result.sources }));
        }
      } catch (error) { loading.remove(); focusReplyTop(appendMessage({ role: "assistant", content: error.code && /^M-/.test(error.code) ? mentorErrorText(error.code, error.message) : error.message + "。请稍后重试。" })); }
      finally { playGirlBack(); release(); attach.disabled = false; }
    });
  } catch (error) { shell.replaceChildren(notice(error.message, "error")); } })();
  return shell;
}

let mentorPanelOpen = false;
function openMentor() {
  recordActivity("open_mentor");
  const panel = document.getElementById("mentorPanel");
  const body = document.getElementById("mentorPanelBody");
  const fab = document.getElementById("mentorFab");
  if (!panel || !body) return;
  if (!body.dataset.built) { body.dataset.built = "1"; body.replaceChildren(mentorPage()); }
  panel.hidden = false;
  mentorPanelOpen = true;
  if (fab) { fab.setAttribute("aria-expanded", "true"); fab.classList.add("mentor-fab--open"); }
}
function closeMentor() {
  const panel = document.getElementById("mentorPanel");
  const fab = document.getElementById("mentorFab");
  if (panel) panel.hidden = true;
  mentorPanelOpen = false;
  if (fab) { fab.setAttribute("aria-expanded", "false"); fab.classList.remove("mentor-fab--open"); }
}
function resetMentorPanel() {
  closeMentor();
  mentorEpoch++;
  mentorHistory = [];
  const body = document.getElementById("mentorPanelBody");
  if (body) { body.replaceChildren(); delete body.dataset.built; }
}

function notificationsPage() {
  const shell = make("div", { className: "view view-notifications" }, pageHead("STUDENT / INBOX", "通知中心", "重要节点和材料提醒会集中显示在这里。"), skeleton());
  (async () => { try {
    const data = await api("/api/notifications");
    shell.replaceChildren(pageHead("STUDENT / INBOX", "通知中心", "重要节点和材料提醒会集中显示在这里。"));
    if (!data.notifications.length) shell.append(panel(make("div", { className: "empty-state" },
      make("strong", { text: "通知已清空" }), "新的节点提醒会在这里出现。")));
    for (const item of data.notifications) {
      const read = button("标记已读", async () => {
        read.disabled = true;
        try {
          await post("/api/notifications/" + item.id + "/read", {});
          unreadNotifications = Math.max(0, unreadNotifications - 1);
          nav();
          row.classList.add("read");
          read.remove();
        } catch (error) {
          read.disabled = false;
          row.querySelector("[role=status]").textContent = error.message;
        }
      });
      const row = make("div", { className: "notice-item" + (item.is_read ? " read" : "") },
        make("span", { className: "notice-dot" }),
        make("div", {}, make("h2", { text: item.title }), p(item.content), make("time", { text: displayTime(item.created_at) }), make("p", { className: "small", role: "status" })),
        item.is_read ? null : read);
      shell.append(panel(row));
    }
  } catch (error) { shell.replaceChildren(pageHead("STUDENT / INBOX", "通知中心"), notice(error.message, "error")); } })();
  return shell;
}

const wns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
function wAttr(node, name) { return node?.getAttributeNS(wns, name) || node?.getAttribute("w:" + name) || ""; }
function descendants(node, name) { return Array.from(node?.getElementsByTagNameNS(wns, name) || []); }
function runText(run) { return descendants(run, "t").map(x => x.textContent).join(""); }
async function inspectDocx(file) {
  const zip = await JSZip.loadAsync(file);
  if (Object.keys(zip.files).length > 2000) throw new Error("DOCX 内部文件过多");
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("DOCX 缺少正文内容");
  if (entry._data?.uncompressedSize > 2 * 1024 * 1024) throw new Error("DOCX 正文过大");
  const xml = new DOMParser().parseFromString(await entry.async("string"), "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("DOCX 正文无法解析");
  const paragraphs = descendants(xml, "p").map(node => {
    const runs = descendants(node, "r").map(run => {
      const props = descendants(run, "rPr")[0], fonts = descendants(props, "rFonts")[0], size = descendants(props, "sz")[0];
      return { text: runText(run), font: wAttr(fonts, "eastAsia") || wAttr(fonts, "ascii"), size: size ? Number(wAttr(size, "val")) / 2 : null };
    });
    const alignment = wAttr(descendants(node, "jc")[0], "val");
    return { text: runs.map(r => r.text).join(""), runs, alignment };
  }).filter(x => x.text.trim());
  const results = [];
  const add = (code, message, suggestion, severity = "中") => results.push({ kind: "rule", code, message, severity, suggestion });
  if (!paragraphs.length) {
    add("empty", "文档为空或无法解析出段落。", "请上传内容完整的材料。", "高");
    return results;
  }
  if (paragraphs[0].alignment !== "center") add("title-not-centered", "标题未居中。", "将标题段落设置为居中对齐。");
  const bodyFonts = new Set(["仿宋", "仿宋_GB2312", "FangSong", "FangSong_GB2312"]);
  const fonts = new Set(), sizes = new Set();
  for (const para of paragraphs.slice(1)) for (const run of para.runs) {
    if (run.font && !bodyFonts.has(run.font)) fonts.add(run.font);
    if (run.size !== null && Math.abs(run.size - 16) > 0.5) sizes.add(run.size + "pt");
  }
  if (fonts.size) add("font-mismatch", "正文存在字体不规范：" + Array.from(fonts).join("、") + "。", "正文应使用仿宋_GB2312。");
  if (sizes.size) add("size-mismatch", "正文存在字号不规范：" + Array.from(sizes).join("、") + "。", "正文应使用三号（16pt）。");
  const tail = paragraphs.slice(-2).map(x => x.text).join("");
  if (!/\d{4}\s*[年./-]\s*\d{1,2}/.test(tail) || !/(申请人|汇报人|签名|署名|：)/.test(tail))
    add("missing-signature", "文末缺少落款（署名与日期）。", "在文末补充署名与日期。");
  return results;
}
function editScan(initialCanvas, onSelect) {
  let canvas = initialCanvas;
  let points, previewUrl;
  const dialog = make("dialog", { className: "scan-overlay-card", "aria-labelledby": "scan-title" });
  const heading = make("h2", { id: "scan-title" });
  const message = make("p", { className: "small", role: "status" });
  const content = make("div", { className: "scan-content" });
  const actions = make("div", { className: "upload-actions" });
  const cancel = () => dialog.close();
  dialog.append(make("div", { className: "scan-heading" }, heading, message), content, actions);
  dialog.addEventListener("close", () => { URL.revokeObjectURL(previewUrl); dialog.remove(); }, { once: true });

  function crop(reset = false) {
    URL.revokeObjectURL(previewUrl);
    if (reset || !points) points = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    heading.textContent = "调整纸张边缘";
    message.textContent = "拖动四角裁剪。纸张已拍完整，可以直接预览。";
    const stage = make("div", { className: "crop-stage" });
    stage.style.setProperty("--scan-ratio", String(canvas.width / canvas.height));
    const svgNS = "http://www.w3.org/2000/svg";
    const border = document.createElementNS(svgNS, "svg");
    const outline = document.createElementNS(svgNS, "polygon");
    border.setAttribute("class", "crop-border");
    border.setAttribute("viewBox", "0 0 100 100");
    border.setAttribute("preserveAspectRatio", "none");
    border.setAttribute("aria-hidden", "true");
    outline.setAttribute("fill", "#a51f2d18");
    outline.setAttribute("stroke", "#a51f2d");
    outline.setAttribute("stroke-width", "2");
    outline.setAttribute("vector-effect", "non-scaling-stroke");
    border.append(outline);
    stage.append(canvas, border);
    const corners = () => points.map(p => ({ x: p.x * (canvas.width - 1), y: p.y * (canvas.height - 1) }));
    const confirm = button("预览扫描件", async () => {
      confirm.disabled = true;
      message.textContent = "正在生成扫描预览…";
      try {
        const full = points.every((p, index) => p.x === (index === 1 || index === 2 ? 1 : 0) && p.y === (index > 1 ? 1 : 0));
        const result = await processImage(canvas, full ? null : corners());
        if (dialog.open && confirm.isConnected) { recordActivity("scan_crop"); preview(result); }
      } catch (error) { message.textContent = error.message; confirm.disabled = false; }
    });
    const handles = ["左上", "右上", "右下", "左下"].map((label, i) => {
      const handle = make("button", { type: "button", className: "crop-handle", "aria-label": label + "角，方向键微调" });
      let drag = null;
      const move = (x, y) => {
        points[i] = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
        draw();
      };
      handle.addEventListener("pointerdown", event => {
        if (drag || event.button !== 0 || confirm.disabled) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        handle.setPointerCapture(event.pointerId);
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: points[i].x, startY: points[i].y };
      });
      handle.addEventListener("pointermove", event => {
        if (event.pointerId !== drag?.id) return;
        const rect = stage.getBoundingClientRect();
        move(drag.startX + (event.clientX - drag.x) / rect.width, drag.startY + (event.clientY - drag.y) / rect.height);
      });
      handle.addEventListener("lostpointercapture", () => { drag = null; });
      handle.addEventListener("keydown", event => {
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!step || confirm.disabled) return;
        event.preventDefault();
        move(points[i].x + step[0] * .01, points[i].y + step[1] * .01);
      });
      stage.append(handle);
      return handle;
    });
    function draw() {
      const polygon = points.map(({ x, y }, i) => {
        handles[i].style.left = x * 100 + "%";
        handles[i].style.top = y * 100 + "%";
        return x * 100 + "," + y * 100;
      }).join(" ");
      outline.setAttribute("points", polygon);
      const valid = validCrop(corners(), canvas.width, canvas.height);
      confirm.disabled = !valid;
      message.textContent = valid ? "拖动四角裁剪。纸张已拍完整，可以直接预览。" : "四角不能交叉或挤在一起，请调整后预览。";
    }
    draw();
    content.replaceChildren(stage);
    actions.replaceChildren(button("取消", cancel, "secondary"), button("旋转", () => { recordActivity("scan_rotate"); canvas = rotateScan(canvas); crop(true); }, "secondary"),
      button("重置四角", () => crop(true), "secondary"), confirm);
  }

  function preview(result) {
    heading.textContent = "扫描预览";
    message.textContent = "默认保留彩色印章，可切换灰度或黑白。";
    const img = make("img", { className: "scan-preview", alt: "扫描件预览" });
    const selectMode = make("select", { "aria-label": "扫描效果" }, [["color", "原色"], ["gray", "灰度增强"], ["bw", "黑白"]].map(([value, text]) => make("option", { value, text })));
    const cached = { color: result.color };
    let selected = result.color;
    const use = button("使用扫描件", () => { recordActivity("scan_use"); onSelect(new File([selected], result.name, { type: "image/jpeg" })); cancel(); });
    const show = blob => {
      URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      img.src = previewUrl;
      selected = blob;
    };
    show(selected);
    selectMode.addEventListener("change", async () => {
      const mode = selectMode.value;
      recordActivity("scan_mode");
      selectMode.disabled = use.disabled = true;
      try {
        cached[mode] ??= await result.enhance(mode);
        if (img.isConnected) show(cached[mode]);
      } catch (error) { message.textContent = error.message; selectMode.value = Object.keys(cached).find(key => cached[key] === selected); }
      finally { selectMode.disabled = use.disabled = false; }
    });
    const recognized = make("textarea", { rows: 6, "aria-label": "可编辑的识别文字" });
    const ocrStatus = make("p", { className: "small", role: "status" });
    const copy = button("复制文字", async () => {
      try { await navigator.clipboard.writeText(recognized.value); ocrStatus.textContent = "文字已复制。"; }
      catch { recognized.select(); ocrStatus.textContent = "请手动复制选中的文字。"; }
    }, "secondary");
    const resultPanel = make("div", { className: "scan-ocr", hidden: "" }, recognized, copy);
    const ocr = button("识别文字", async () => {
      let engine;
      recordActivity("scan_ocr");
      ocr.disabled = true;
      ocrStatus.textContent = "正在准备本机识字…";
      try {
        const { default: { createWorker } } = await import("/ocr/tesseract.esm.min.js");
        engine = await createWorker("chi_sim+eng", 1, {
          workerPath: "/ocr/worker.min.js", corePath: "/ocr", langPath: "/ocr", workerBlobURL: false,
          logger: event => {
            if (event.status === "recognizing text") ocrStatus.textContent = "正在识别 " + Math.round(event.progress * 100) + "%";
          }
        });
        const { data } = await engine.recognize(selected);
        recognized.value = data.text.trim();
        resultPanel.hidden = !recognized.value;
        ocrStatus.textContent = recognized.value ? "整体置信度 " + Math.round(data.confidence) + "%，请核对姓名、学号和日期。" : "未识别到文字，可返回裁剪或换一张清晰照片。";
      } catch { ocrStatus.textContent = "识字失败，请重试或继续使用扫描件。"; }
      finally { if (engine) await engine.terminate(); ocr.disabled = false; }
    }, "secondary");
    content.replaceChildren(img, ocrStatus, resultPanel);
    actions.replaceChildren(button("返回裁剪", () => crop(), "secondary"), selectMode, ocr, use);
  }

  crop();
  document.body.append(dialog);
  dialog.showModal();
}

function checkPage() {
  const shell = make("div", { className: "view view-check" }, pageHead("STUDENT / SUBMISSION", "材料提交", "上传 Word、PDF 或图片，提交后可在材料记录中查看。"), skeleton());
  (async () => { try {
    const data = await api("/api/materials");
    const materialChoices = data.materials.map(x => [x.id, x.name]);
    const scanInput = make("input", { type: "file", accept: "image/*", capture: "environment", className: "hidden-input", "aria-label": "拍照扫描" });
    const scanButton = button("拍照扫描", () => scanInput.click(), "secondary");
    const gallery = make("input", { type: "file", accept: "image/*", className: "hidden-input", tabindex: "-1", "aria-label": "扫描照片" });
    const fileStatus = make("p", { className: "small", role: "status" });
    let scannedFile = null, uploadKey = null;
    const submit = make("button", { className: "btn", type: "submit", text: "检查并提交" });
    const progress = make("p", { className: "small", role: "status" });
    const form = make("form", { className: "check-form" },
      select("选择材料", "materialId", materialChoices),
      make("label", { className: "upload-drop" },
        make("span", { className: "upload-drop-icon", "aria-hidden": "true", text: "↑" }),
        make("strong", { text: "选择 Word、PDF 或图片" }),
        make("span", { className: "small", text: "点击选择 · 每份最大 10 MB" }),
        make("input", { name: "file", type: "file", accept: materialAccept, "aria-label": "材料文件" })),
      fileStatus, progress, make("div", { className: "upload-actions" }, scanButton, button("扫描相册图片", () => gallery.click(), "secondary"), submit));
    form.append(scanInput, gallery);
    const input = form.elements.file;
    function resetUpload() {
      uploadKey = null;
      progress.textContent = "";
      submit.textContent = "检查并提交";
    }
    form.elements.materialId.addEventListener("change", resetUpload);
    input.addEventListener("change", () => {
      scannedFile = null;
      resetUpload();
      fileStatus.textContent = input.files[0]?.name || "";
    });
    async function chooseScan(event) {
      const picker = event.currentTarget;
      const file = picker.files[0];
      picker.value = "";
      if (!file) return;
      const release = busy(form);
      try {
        const canvas = await decodeImage(file);
        if (!form.isConnected) return;
        editScan(canvas, scan => {
          scannedFile = scan;
          resetUpload();
          input.value = "";
          fileStatus.textContent = "已选扫描件：" + scan.name;
        });
      } catch (error) { feedback(form, error.message); }
      finally { release(); }
    }
    scanInput.addEventListener("change", chooseScan);
    gallery.addEventListener("change", chooseScan);
    const output = panel(make("div", { className: "panel-head" }, make("h2", { text: "质检结果" })),
      make("div", { className: "empty-state" }, make("strong", { text: "等待检查" }), "选择文件后，提交结果将在这里显示。"));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const release = busy(form);
      try {
        const selected = scannedFile || input.files[0];
        const file = selected && normalizedAttachment(selected);
        if (!file || file.size < 1 || file.size > maxFileBytes || !uploadType(file.name)) throw new Error("请选择不超过 10 MB 的 Word、PDF 或图片");
        const inspected = fileExtension(file.name) === "docx";
        const results = inspected ? await inspectDocx(file) : [];
        const data = new FormData(form);
        data.set("file", file);
        data.set("results", JSON.stringify(results));
        uploadKey ??= randomHex(16);
        data.set("uploadId", uploadKey);
        const saved = await uploadWithProgress("/api/checks", data, progress);
        resetUpload();
        input.value = "";
        fileStatus.textContent = "";
        scannedFile = null;
        output.replaceChildren(make("div", { className: "panel-head" }, make("h2", { text: inspected ? "质检结果" : "提交结果" }), inspected ? make("span", { className: "small", text: results.length + " 项结果" }) : null),
          inspected ? make("div", { className: "results-list" },
            results.length ? results.map(r => make("div", { className: "result-row" }, make("strong", { text: r.message }), p(r.suggestion))) :
              [make("div", { className: "result-row" }, make("strong", { text: "未发现格式问题" }), p("已完成当前规则检查。"))]) : null,
          notice(inspected ? "文件已提交，DOCX 格式检查已完成。" : "文件已提交，等待人工审阅。", "success"),
          make("a", { className: "text-link", href: "/api/checks/" + saved.id + "/file", text: "下载已保存的材料 →" }));
      } catch (error) {
        progress.textContent = "";
        if (uploadKey) submit.textContent = "重试提交";
        feedback(form, error.message);
      }
      finally { release(); }
    });
    shell.replaceChildren(pageHead("STUDENT / SUBMISSION", "材料提交", "上传 Word、PDF 或图片，提交后可在材料记录中查看。"),
      panel(make("div", { className: "panel-head" }, make("h2", { text: "上传并提交材料" })),
        p("DOCX 会检查标题、正文和落款格式。旧版 Word、PDF 和图片提交后由人工审阅。"), form), output);
  } catch (error) { shell.replaceChildren(pageHead("STUDENT / SUBMISSION", "材料提交"), notice(error.message, "error")); } })();
  return shell;
}

async function previewSubmission(item) {
  recordActivity("preview_submission");
  const dialog = make("dialog", { className: "scan-overlay-card review-preview", "aria-label": "材料预览" });
  const content = make("div", { className: "scan-content" }, p("正在载入预览…"));
  const link = "/api/checks/" + item.id + "/file";
  dialog.append(make("h2", { text: item.filename }), content, make("div", { className: "upload-actions" },
    make("a", { href: link, text: "下载原件", className: "text-link" }), button("关闭", () => dialog.close(), "secondary")));
  let objectUrl, task;
  const controller = new AbortController();
  dialog.addEventListener("close", () => {
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (task) task.destroy().catch(() => {});
    dialog.remove();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  try {
    const response = await fetch(link, { signal: controller.signal });
    if (!response.ok) throw new Error();
    const blob = await response.blob();
    if (!dialog.open) return;
    if (blob.type.startsWith("image/")) {
      objectUrl = URL.createObjectURL(blob);
      content.replaceChildren(make("img", { className: "scan-preview", src: objectUrl, alt: item.material_name }));
      return;
    }
    const pdfjs = await import("/pdf.min.js");
    if (!dialog.open) return;
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
    task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
    const pdf = await task.promise;
    let number = 1;
    const canvas = make("canvas");
    const status = make("span", { role: "status", className: "small" });
    const previous = button("上一页", () => { number--; draw(); }, "secondary");
    const next = button("下一页", () => { number++; draw(); }, "secondary");
    async function draw() {
      previous.disabled = next.disabled = true;
      try {
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        const scaled = page.getViewport({ scale: Math.min(2, 1250 / viewport.width, 1700 / viewport.height) });
        canvas.width = Math.ceil(scaled.width);
        canvas.height = Math.ceil(scaled.height);
        await page.render({ canvasContext: canvas.getContext("2d"), canvas, viewport: scaled }).promise;
        status.textContent = "第 " + number + " / " + pdf.numPages + " 页";
        previous.disabled = number === 1;
        next.disabled = number === pdf.numPages;
      } catch { if (dialog.open) status.textContent = "此页无法预览，请下载原件查看。"; }
    }
    content.replaceChildren(make("div", { className: "upload-actions" }, previous, status, next), canvas);
    await draw();
  } catch { if (dialog.open) content.replaceChildren(p("无法预览，请下载原件查看。")); }
}

function checksPage(monitor = false) {
  const title = monitor ? "班级材料" : "已提交文件";
  const shell = make("div", { className: "view view-checks" }, pageHead("STAFF / DOCUMENTS", title, "按班级、提交时间和审阅状态查找材料。"));
  const rows = make("tbody");
  const selected = new Set();
  const count = make("span", { className: "bulk-count", text: "已选 0 份" });
  const canReview = x => x.review_status === "待审阅" && (monitor ? !x.monitor_approved : true);
  const note = field("退回修改说明", "reviewNote", "text", false);
  const noteInput = note.querySelector("input");
  const selectAll = make("input", { type: "checkbox", "aria-label": "选择本页待审阅材料", onchange: event => {
    rows.querySelectorAll("input[type=checkbox]").forEach(box => { box.checked = event.target.checked; box.dispatchEvent(new Event("change")); });
  } });
  const table = make("table", { className: "data" }, make("thead", {}, make("tr", {},
    make("th", { className: "bulk-select" }, selectAll),
    ["学生 / 班级", "材料", "文件", "审阅状态", "提交时间"].map(text => make("th", { text })))), rows);
  const classField = select("班级", "classId", [["", "全部班级"]]);
  const statusField = select("状态", "status", [["", "全部状态"], ["staff", "待辅导员审阅"], ["monitor", "待学生管理员初审"], ["approved", "已通过"], ["returned", "退回修改"]]);
  const since = field("提交日期起", "since", "date", false);
  const filters = make("form", { className: "bulk-tools review-filters" }, monitor ? null : classField, statusField, since,
    make("button", { type: "submit", className: "secondary", text: "筛选" }));
  let reviewing = false;
  const submit = async status => {
    if (reviewing) return;
    if (!selected.size || selected.size > 20) return feedback(tools, "请选择 1 至 20 份待审阅材料");
    if (status === "退回修改" && !noteInput.value.trim()) { noteInput.focus(); return feedback(tools, "请填写退回修改说明"); }
    const checkIds = [...selected], reason = noteInput.value;
    reviewing = true;
    try {
      if (!await actionDialog(status || "初审通过", "将处理选中的 " + checkIds.length + " 份材料。")) return;
      clearFeedback(tools);
      const result = monitor ? await post("/api/checks/monitor-approve", { checkIds }) :
        await post("/api/admin/checks/bulk-review", { checkIds, status, note: reason });
      noteInput.value = "";
      await load();
      feedback(tools, "已处理 " + result.count + " 份材料。", "success");
    } catch (error) { feedback(tools, error.message); }
    finally { reviewing = false; }
  };
  const tools = monitor ? make("div", { className: "bulk-tools" }, count, button("初审通过", () => submit(null))) :
    make("div", { className: "bulk-tools" }, count, button("批量通过", () => submit("已通过")), note, button("批量退回", () => submit("退回修改"), "secondary"));
  let before = "", appliedFilters = {};
  const more = button("下一页", () => load(before), "secondary");
  const first = button("回到第一页", () => load(), "secondary");
  first.hidden = more.hidden = true;
  async function load(cursor = "") {
    const release = busy(filters);
    try {
      const params = new URLSearchParams(appliedFilters);
      if (cursor) params.set("before", cursor);
      const data = await api("/api/checks?" + params);
      if (!monitor) {
        const selector = classField.querySelector("select");
        const current = appliedFilters.classId || "";
        selector.replaceChildren(make("option", { value: "", text: "全部班级" }),
          (data.classes || []).map(x => make("option", { value: x.id, text: x.name })));
        selector.value = current;
      }
      selected.clear();
      selectAll.checked = false;
      count.textContent = "已选 0 份";
      rows.replaceChildren(...data.checks.map(x => {
        const status = x.review_status === "待审阅" ? x.monitor_approved ? "待辅导员审阅" : "待学生管理员初审" : x.review_status;
        return make("tr", {},
          make("td", { className: "bulk-select" }, canReview(x) ? make("input", { type: "checkbox", "aria-label": "选择 " + (x.student_name || x.student_id) + " 的 " + x.material_name, onchange: event => {
            if (event.target.checked) selected.add(x.id); else selected.delete(x.id);
            count.textContent = "已选 " + selected.size + " 份";
          } }) : null),
          make("td", {}, x.student_name || String(x.student_id), make("div", { className: "small", text: x.class_name || "未分班" })),
          make("td", { text: x.material_name }),
          make("td", {}, make("a", { href: "/api/checks/" + x.id + "/file", text: x.filename }),
            /\.(pdf|jpe?g|png|webp|gif)$/i.test(x.filename) ? make("div", {}, button("预览", () => previewSubmission(x), "linklike")) : null),
          make("td", {}, make("span", { className: "review-pill", text: status }),
            x.review_note ? make("div", { className: "small", text: x.review_note }) : null),
          make("td", { text: displayTime(x.checked_at) }));
      }));
      if (!data.checks.length) rows.append(make("tr", {}, make("td", { colspan: 6, text: "暂无符合筛选条件的材料。" })));
      before = data.next;
      first.hidden = !cursor;
      more.hidden = !before;
    } catch (error) { feedback(filters, error.message); }
    finally { release(); }
  }
  filters.addEventListener("submit", event => { event.preventDefault(); appliedFilters = formData(filters); load(); });
  shell.append(panel(filters, tools, tableWrap(table), make("div", { className: "upload-actions" }, first, more)));
  load();
  return shell;
}

function formsPage() {
  const shell = make("div", { className: "view view-forms" }, pageHead("LIBRARY / DOWNLOADS", "资料下载", "按培养阶段查找和下载所需表格。"), skeleton());
  (async () => { try {
    const data = await api("/api/forms");
    const upload = isStaffUser() ? make("form", { className: "form-grid form-upload" },
      select("所属阶段", "stageSlug", data.stages.map(stage => [stage.slug, stage.name])),
      field("表格名称", "title"),
      field("文件（Word、Excel、PDF 或图片，最大 10 MB）", "file", "file"),
      make("button", { className: "btn", type: "submit", text: "上传学院表格" })) : null;
    if (upload) {
      let uploadId;
      const progress = make("p", { className: "small", role: "status" });
      upload.append(progress);
      upload.addEventListener("input", () => { uploadId = null; progress.textContent = ""; });
      upload.querySelector("[name=file]").setAttribute("accept", materialAccept + ",.xls,.xlsx");
      upload.addEventListener("submit", async event => {
        event.preventDefault();
        const release = busy(upload);
        try {
          const file = upload.querySelector("[name=file]").files[0];
          if (!file || file.size > 10 * 1024 * 1024) throw new Error("请选择不超过 10 MB 的表格文件");
          const body = new FormData(upload);
          body.set("file", normalizedAttachment(file, true));
          uploadId ??= randomHex(16);
          body.set("uploadId", uploadId);
          await uploadWithProgress("/api/forms", body, progress);
          refreshWithFeedback("表格已上传。");
        } catch (error) { progress.textContent = ""; feedback(upload, error.message + "。可保留文件再次提交。"); }
        finally { release(); }
      });
    }
    const stages = data.stages.map(stage => {
      const uploaded = data.forms.filter(item => item.stage_slug === stage.slug).map(item =>
        make("li", { className: "form-item" },
          make("div", {}, make("strong", { text: item.title }), make("span", { className: "small", text: item.department_id ? "学院提供 · " + item.filename : "平台提供 · " + item.filename })),
          make("a", { className: "secondary", href: "/api/forms/" + item.id + "/file", text: "下载文件 ↓" })));
      const official = officialForms.filter(item => item.stage === stage.slug).map(item => {
        const actions = make("div", { className: "form-actions" },
          make("a", { className: "secondary", href: item.url, target: "_blank", rel: "noopener noreferrer", text: "下载原件 ↗", onclick: () => recordActivity("download_official_form") }),
          make("a", { className: "text-link small", href: item.source, target: "_blank", rel: "noopener noreferrer", text: "来源" }));
        return make("li", { className: "form-item" },
          make("div", {}, make("strong", { text: item.title }), make("span", { className: "small", text: "中国民航大学党委组织部 · " + item.filename })), actions);
      });
      return panel(make("div", { className: "panel-head" }, make("h2", { text: stage.position.toString().padStart(2, "0") + " / " + stage.name }),
        make("span", { className: "small", text: uploaded.length + official.length + " 份文件" })),
        uploaded.length + official.length ? make("ul", { className: "form-list" }, uploaded, official) :
          make("div", { className: "empty-state" }, make("strong", { text: "暂无电子表格" }), "请向辅导员确认纸质材料或等待学院上传。"));
    });
    shell.replaceChildren(pageHead("LIBRARY / DOWNLOADS", "资料下载", "按培养阶段查找和下载所需表格。"),
      notice("学校组织部公开附件的版本可能早于现行要求；填写前请与辅导员确认使用版本。"),
      ...(upload ? [panel(make("div", { className: "panel-head" }, make("h2", { text: me.role === "admin" ? "上传全校通用表格" : "上传本学院表格" })), upload)] : []),
      ...stages);
  } catch (error) { shell.replaceChildren(pageHead("LIBRARY / DOWNLOADS", "资料下载"), notice(error.message, "error")); } })();
  return shell;
}
const isStaffUser = () => me?.role === "admin" || me?.role === "counselor";

function hierarchyPage() {
  const shell = make("div", { className: "view view-hierarchy" }, pageHead("STAFF / ORG", "管理体系", "查看各专业、班级与学生的培养状态，学生管理员置顶。"), skeleton());
  (async () => { try {
    const data = await api("/api/admin/hierarchy");
    const badge = (label, cls) => make("span", { className: "badge " + cls, text: label });
    const tree = make("div", { className: "hierarchy" });
    for (const grade of data.grades) {
      const majorTotal = grade.majors.reduce((n, m) => n + m.classes.length, 0);
      const studentTotal = grade.majors.reduce((n, m) => n + m.classes.reduce((n2, c) => n2 + c.students.length, 0), 0);
      const gradeNode = make("details", { className: "hierarchy-grade", open: "" },
        make("summary", {},
          make("strong", { text: grade.name }),
          make("span", { className: "small muted", text: (grade.college_name ? grade.college_name + " · " : "") + grade.majors.length + " 个专业 · " + majorTotal + " 个班 · " + studentTotal + " 人" })));
      for (const major of grade.majors) {
        const classTotal = major.classes.reduce((n, c) => n + c.students.length, 0);
        const majorNode = make("details", { className: "hierarchy-major" },
          make("summary", {},
            make("span", { className: "hierarchy-major-name", text: major.name }),
            make("span", { className: "small muted", text: major.classes.length + " 个班 · " + classTotal + " 人" })));
        for (const cls of major.classes) {
          const classNode = make("details", { className: "hierarchy-class" },
            make("summary", {},
              make("span", { className: "hierarchy-class-name", text: cls.name }),
              make("span", { className: "small muted", text: cls.students.length + " 人" }),
              cls.monitor ? make("span", { className: "small", text: "学生管理员：" + cls.monitor.name }) : make("span", { className: "small muted", text: "未设学生管理员" })));
          const list = make("ul", { className: "hierarchy-students" });
          for (const s of cls.students) {
            const tag = s.is_monitor ? badge("学生管理员", "monitor") : s.is_archived ? badge("已归档党员", "done") : badge("发展中", "developing");
            list.append(make("li", { className: (s.is_monitor ? "is-monitor" : "") + (s.is_archived ? " is-archived" : "") },
              make("span", { className: "hierarchy-student-name", text: s.name }),
              make("span", { className: "small muted", text: s.student_no + (s.stage_name ? " · " + s.stage_name : "") }), tag));
          }
          if (!cls.students.length) list.append(make("li", { className: "small muted", text: "暂无学生" }));
          classNode.append(list);
          majorNode.append(classNode);
        }
        gradeNode.append(majorNode);
      }
      tree.append(gradeNode);
    }
    if (!data.grades.length) tree.append(make("div", { className: "empty-state" }, "暂无可管理的年级。"));
    shell.replaceChildren(pageHead("STAFF / ORG", "管理体系", "查看各专业、班级与学生的培养状态，学生管理员置顶。"), tree);
  } catch (error) { shell.replaceChildren(pageHead("STAFF / ORG", "管理体系"), notice(error.message, "error")); } })();
  return shell;
}

function skeleton() {
  return make("div", { "aria-hidden": "true" },
    make("div", { className: "skeleton skeleton-block", style: "height:120px" }),
    make("div", { className: "skeleton skeleton-block" }),
    make("div", { className: "skeleton skeleton-block", style: "height:160px" }));
}

function adminSkeleton() {
  return make("div", { "aria-hidden": "true" },
    make("div", { className: "skeleton-stats" }, [1, 2, 3, 4].map(() => make("div", { className: "skeleton skeleton-card" }))),
    make("div", { className: "skeleton skeleton-block" }),
    make("div", { className: "skeleton skeleton-block" }));
}

function adminPage() {
  const adminTitle = make("h1", { className: "page-title" },
    make("span", { text: me.role === "admin" ? "管理员工作台" : "辅导员工作台" }),
    make("span", { className: "greeting-title", text: " | " + dayPart() + "好，您辛苦了！" }));
  const adminCode = me.role === "admin" ? "ADMIN / CONSOLE" : "COUNSELOR / CONSOLE";
  const shell = make("div", { className: "view view-admin" }, pageHead(adminCode, adminTitle, "管理学生档案、辅导员与培养进度。"), adminSkeleton());
  (async () => { try {
    const filters = new URLSearchParams(location.search);
    const data = await api("/api/admin/dashboard?" + filters);
    const collegeChoices = data.colleges.map(x => [x.id, x.name]);
    const gradeChoices = data.grades.map(x => [x.id, x.name]);
    const gradeName = id => (data.grades.find(g => g.id === id)?.name || "");
    const majorLabel = id => (data.majors.find(m => m.id === id)?.name || "") + " · " + gradeName(data.majors.find(m => m.id === id)?.grade_id);
    const majorChoices = data.majors.map(x => [x.id, majorLabel(x.id)]);
    const gradeMajorIds = new Set(me.role === "admin" ? data.majors.map(m => m.id) : data.majors.filter(m => m.grade_id === me.grade_id).map(m => m.id));
    const visibleClasses = me.role === "admin" ? data.classes : data.classes.filter(c => gradeMajorIds.has(c.major_id));
    const classChoices = visibleClasses.map(x => [x.id, (data.majors.find(m => m.id === x.major_id)?.name || "") + " · " + x.name]);
    const needCollege = me.role === "admin" && collegeChoices.length === 0;
    const needGrade = me.role === "admin" && gradeChoices.length === 0;
    const needMajor = me.role === "admin" && majorChoices.length === 0;
    const searchForm = make("form", { className: "inline-form" },
      field("检索学生（姓名或学号）", "q", "text", false, new URLSearchParams(location.search).get("q") || ""),
      make("button", { className: "btn", type: "submit", text: "检索" }));
    searchForm.addEventListener("submit", event => {
      event.preventDefault();
      const q = formData(searchForm).q.trim();
      const url = new URL(location.href); url.hash = "#admin";
      if (q) url.searchParams.set("q", q); else url.searchParams.delete("q");
      history.replaceState(null, "", url); render();
    });
    const inviteForm = make("form", { className: "inline-form" },
      select("年级", "gradeId", gradeChoices, gradeChoices[0]?.[0]),
      select("角色", "role", [["counselor", "辅导员"]]),
      field("邀请数量（1–50）", "count", "number", true, "1"),
      make("button", { className: "btn", type: "submit", text: "生成邀请码" }));
    const countInput = inviteForm.querySelector("[name=count]");
    countInput.min = "1"; countInput.max = "50";
    const inviteOutput = make("div", { className: "muted invite-output", text: "邀请码仅显示一次，有效期 7 天。" });
    inviteForm.addEventListener("submit", async event => {
      event.preventDefault();
      const release = busy(inviteForm);
      try {
        const result = await post("/api/admin/invites", formData(inviteForm));
        inviteOutput.replaceChildren("已生成 " + result.codes.length + " 个邀请码，有效期 7 天。请逐一通过可信渠道发送给受邀人。",
          make("textarea", { className: "invite-codes", readOnly: "", "aria-label": "本次生成的邀请码", text: result.codes.join("\n") }),
          button("复制全部邀请码", async () => { await navigator.clipboard.writeText(result.codes.join("\n")); }, "secondary"));
      } catch (error) { feedback(inviteForm, error.message); }
      finally { release(); }
    });
    const collegeForm = make("form", { className: "inline-form" },
      field("新学院名称", "name"), make("button", { className: "btn", type: "submit", text: "添加学院" }));
    collegeForm.addEventListener("submit", async event => {
      event.preventDefault();
      try { await post("/api/admin/departments", formData(collegeForm)); render(); }
      catch (error) { feedback(collegeForm, error.message); }
    });
    const gradeForm = make("form", { className: "inline-form" },
      select("所属学院", "collegeId", collegeChoices, collegeChoices[0]?.[0]),
      field("新年级名称（如 23级）", "name"), make("button", { className: "btn", type: "submit", text: "添加年级" }));
    gradeForm.addEventListener("submit", async event => {
      event.preventDefault();
      try { await post("/api/admin/grades", formData(gradeForm)); render(); }
      catch (error) { feedback(gradeForm, error.message); }
    });
    const majorForm = make("form", { className: "inline-form" },
      select("所属年级", "gradeId", gradeChoices, gradeChoices[0]?.[0]),
      field("新专业名称", "name"), make("button", { className: "btn", type: "submit", text: "添加专业" }));
    majorForm.addEventListener("submit", async event => {
      event.preventDefault();
      try { await post("/api/admin/majors", formData(majorForm)); render(); }
      catch (error) { feedback(majorForm, error.message); }
    });
    const classForm = make("form", { className: "inline-form" },
      select("所属专业", "majorId", me.role === "admin" ? majorChoices : data.majors.filter(m => m.grade_id === me.grade_id).map(m => [m.id, majorLabel(m.id)]), me.role === "admin" ? majorChoices[0]?.[0] : (data.majors.filter(m => m.grade_id === me.grade_id)[0]?.id)),
      field("新班级名称", "name"), make("button", { className: "btn", type: "submit", text: "添加班级" }));
    classForm.addEventListener("submit", async event => {
      event.preventDefault();
      try { await post("/api/admin/classes", formData(classForm)); render(); }
      catch (error) { feedback(classForm, error.message); }
    });
    const canAddStudent = me.role === "counselor" || classChoices.length > 0;
    const addStudentForm = canAddStudent ? make("form", { className: "inline-form" },
      field("姓名", "name"), field("学号", "studentNo", "text"),
      select("班级", "classId", classChoices, classChoices[0]?.[0]),
      make("button", { className: "btn", type: "submit", text: "添加学生" })) : null;
    if (addStudentForm) addStudentForm.addEventListener("submit", async event => {
      event.preventDefault();
      const release = busy(addStudentForm);
      try { await post("/api/admin/students", formData(addStudentForm)); feedback(addStudentForm, "学生已添加，初始密码 cauc+学号。", "success"); render(); }
      catch (error) { feedback(addStudentForm, error.message); }
      finally { release(); }
    });
    const addCounselorForm = (me.role === "admin" && gradeChoices.length) ? make("form", { className: "inline-form" },
      field("姓名", "name"), field("用户名", "username", "text"),
      select("年级", "gradeId", gradeChoices, gradeChoices[0]?.[0]),
      make("button", { className: "btn", type: "submit", text: "添加辅导员" })) : null;
    if (addCounselorForm) addCounselorForm.addEventListener("submit", async event => {
      event.preventDefault();
      const release = busy(addCounselorForm);
      try { await post("/api/admin/counselors", formData(addCounselorForm)); feedback(addCounselorForm, "辅导员已添加，初始密码 cauc+用户名。", "success"); render(); }
      catch (error) { feedback(addCounselorForm, error.message); }
      finally { release(); }
    });
    const selectedStudents = new Set();
    const studentCount = make("span", { className: "bulk-count", text: "已选 0 人" });
    const setMonitor = async (student, cls) => {
      if (!cls) return feedback(shell, "请先将学生分配到班级");
      if (!await actionDialog("设置学生管理员", "将 " + student.name + " 设为「" + cls.name + "」的学生管理员。")) return;
      try { await post("/api/admin/classes/monitor", { classId: cls.id, studentId: student.id }); render(); }
      catch (error) { feedback(shell, error.message); }
    };
    const students = make("table", { className: "data" },
      make("thead", {}, make("tr", {}, make("th", { className: "bulk-select" }, make("input", { type: "checkbox", "aria-label": "选择全部学生", onchange: event => {
        students.querySelectorAll("tbody input[type=checkbox]").forEach(box => { box.checked = event.target.checked; box.dispatchEvent(new Event("change")); });
      } })), ["学号", "姓名", "班级", "当前节点", "操作"].map(x => make("th", { text: x })))),
      make("tbody", {}, data.students.map(student => make("tr", {},
        make("td", { className: "bulk-select" }, make("input", { type: "checkbox", value: student.id, "aria-label": "选择 " + student.name, onchange: event => {
          if (event.target.checked) selectedStudents.add(student.id); else selectedStudents.delete(student.id);
          studentCount.textContent = "已选 " + selectedStudents.size + " 人";
        } })),
        make("td", { text: student.student_no }), make("td", { text: student.name }),
        make("td", { text: (student.grade_name ? student.grade_name + " · " : "") + (student.major_name ? student.major_name + " · " : "") + (student.class_name || "未分班") }),
        make("td", { text: data.nodes.find(x => x.slug === student.current_node_slug)?.name || "" }),
        make("td", {}, button("管理", () => showStudent(student, data), "secondary"),
          button("设学生管理员", () => setMonitor(student, data.classes.find(c => c.id === student.class_id)), "secondary"),
          button("移入回收站", async () => {
            if (!await actionDialog("移入回收站", student.name + " 将无法登录。可在回收站恢复账号。", "移入回收站")) return;
            try { await post("/api/admin/students/bulk-delete", { studentIds: [student.id] }); render(); }
            catch (error) { feedback(shell, error.message); }
          }, "secondary"))))));
    const counselorsTable = make("table", { className: "data" },
      make("thead", {}, make("tr", {}, ["姓名", "用户名", "年级", "操作"].map(x => make("th", { text: x })))),
      make("tbody", {}, data.counselors.map(counselor => make("tr", {},
        make("td", { text: counselor.name || "—" }),
        make("td", { text: counselor.username }),
        make("td", { text: counselor.grade_name || "未分配" }),
        make("td", {}, button("移入回收站", async () => {
          if (!await actionDialog("移入回收站", (counselor.name || counselor.username) + " 将无法登录。可在回收站恢复账号。", "移入回收站")) return;
          try { await post("/api/admin/counselors/bulk-delete", { usernames: [counselor.username] }); render(); }
          catch (error) { feedback(shell, error.message); }
        }, "secondary"))))));
    const bulkAction = async action => {
      if (!selectedStudents.size) return feedback(bulkTools, "请先选择学生");
      if (selectedStudents.size > 20) return feedback(bulkTools, "每次最多处理 20 名学生");
      if (action === "advance" && !await actionDialog("推进培养阶段", "将所选 " + selectedStudents.size + " 名学生推进至下一培养阶段。")) return;
      if (action === "delete" && !await actionDialog("批量移入回收站", "所选 " + selectedStudents.size + " 名学生将无法登录。可在回收站恢复账号。", "移入回收站")) return;
      try {
        const result = await post("/api/admin/students/bulk-" + action, { studentIds: [...selectedStudents] });
        refreshWithFeedback(action === "delete" ? "已将 " + result.count + " 个账号移入回收站。" : "已推进 " + result.count + " 名学生。");
      } catch (error) { feedback(bulkTools, error.message); }
    };
    const bulkTools = make("div", { className: "bulk-tools" }, studentCount,
      button("批量推进下一阶段", () => bulkAction("advance")),
      button("批量移入回收站", () => bulkAction("delete"), "secondary danger"));
    const metrics = make("div", { className: "metric-grid" },
      metric("学生档案", String(data.students.length), "当前可管理的学生"),
      ...(me.role === "admin" ? [metric("辅导员", String(data.counselors.length), "已注册辅导员")] : []),
      metric("班级", String(visibleClasses.length), me.role === "admin" ? "全部班级" : "本年级班级"),
      ...(me.role === "admin" ? [metric("专业", String(data.majors.length), "已配置专业"), metric("年级", String(data.grades.length), "已配置年级"), metric("学院", String(data.colleges.length), "已配置学院")] : []),
      ...(me.role === "admin" ? [metric("有效邀请", String(data.invites.filter(x => x.role === "counselor" && !x.used_by && new Date(x.expires_at) > new Date()).length), "未使用的辅导员邀请码", true)] : []));
    const notifyTargets = [
      ...(me.role === "counselor"
        ? data.majors.filter(m => m.grade_id === me.grade_id).map(m => ["major:" + m.id, "专业 · " + m.name])
        : data.majors.map(m => ["major:" + m.id, "专业 · " + m.name])),
      ...visibleClasses.map(c => ["class:" + c.id, "班级 · " + c.name])
    ];
    const notifyForm = make("form", { className: "form-grid" },
      field("通知标题", "title", "text", true, "重要提醒"),
      make("label", { className: "field wide" }, make("span", { text: "通知内容" }), make("textarea", { name: "content", required: "", rows: 4, placeholder: "填写通知正文" })),
      select("收件范围", "target", notifyTargets, notifyTargets[0]?.[0]),
      make("button", { className: "btn", type: "submit", text: "发送站内通知" }));
    notifyForm.addEventListener("submit", async event => {
      event.preventDefault();
      const release = busy(notifyForm);
      try {
        const values = formData(notifyForm);
        const [kind, raw] = (values.target || "").split(":");
        const audience = kind === "class" ? { classId: Number(raw) } : kind === "major" ? { majorId: Number(raw) } : {};
        const result = await post("/api/admin/notifications", { title: values.title, content: values.content, audience });
        feedback(notifyForm, "已发送给 " + result.count + " 名学生。", "success");
      } catch (error) { feedback(notifyForm, error.message); }
      finally { release(); }
    });
    shell.replaceChildren(pageHead(adminCode, adminTitle, "管理学生档案、辅导员与培养进度。"),
      metrics,
      panel(make("div", { className: "panel-head" }, make("h2", { text: "发送站内通知" }), make("span", { className: "small", text: "手动向学生发送站内信。" })), notifyForm),
      panel(make("div", { className: "panel-head" }, make("h2", { text: "检索学生" })), searchForm),
      ...(addStudentForm ? [panel(make("div", { className: "panel-head" }, make("h2", { text: "手动添加学生" }), make("span", { className: "small", text: "单独添加一名学生到班级，初始密码 cauc+学号。" })), addStudentForm)] : []),
      ...(me.role === "admin" ? [
        ...(addCounselorForm ? [panel(make("div", { className: "panel-head" }, make("h2", { text: "手动添加辅导员" }), make("span", { className: "small", text: "单独添加一名辅导员到年级，初始密码 cauc+用户名。" })), addCounselorForm)] : []),
        panel(make("div", { className: "panel-head" }, make("h2", { text: "辅导员管理" }), make("span", { className: "small", text: "共 " + data.counselors.length + " 人 · 批量增删请用右下角办公助理" })),
          data.counselors.length ? tableWrap(counselorsTable) : make("div", { className: "empty-state" }, make("strong", { text: "尚无辅导员" }), "可手动添加，或打开办公助理批量添加。"))
      ] : []),
      panel(make("div", { className: "panel-head" }, make("h2", { text: "班级设置" }), make("span", { className: "small", text: "创建班级并命名，学生提交后可选该班学生管理员" })),
        classForm,
        data.classes.length ? tableWrap(make("table", { className: "data" },
          make("thead", {}, make("tr", {}, ["班级", "专业", "学生管理员", "操作"].map(x => make("th", { text: x })))),
          make("tbody", {}, visibleClasses.map(cls => {
            const monitor = data.students.find(s => s.id === cls.monitor_user_id);
            return make("tr", {},
              make("td", { text: cls.name }),
              make("td", { text: data.majors.find(m => m.id === cls.major_id)?.name || "" }),
              make("td", {}, monitor ? make("span", {}, monitor.name, " ", make("a", { className: "text-link small", text: "取消", onclick: async () => {
                if (!await actionDialog("取消学生管理员", "取消「" + cls.name + "」的学生管理员 " + monitor.name + "？")) return;
                try { await post("/api/admin/classes/monitor", { classId: cls.id, studentId: null }); render(); }
                catch (error) { feedback(shell, error.message); }
              } })) : "未设置"),
              make("td", {}, button("查看学生", () => {
                history.replaceState(null, "", "?classId=" + cls.id + "#admin");
                render();
              }, "secondary")));
          })))) : null),
      ...(me.role === "admin" ? [
        panel(make("div", { className: "panel-head" }, make("h2", { text: "学院、年级与专业设置" })), collegeForm, ...(collegeChoices.length ? [gradeForm] : []), ...(gradeChoices.length ? [majorForm] : [])),
        ...(!needMajor ? [panel(make("div", { className: "panel-head" }, make("h2", { text: "邀请辅导员" })), inviteForm, inviteOutput)] : [])
      ] : []),
      panel(make("div", { className: "panel-head" }, make("h2", { text: "学生档案" }), make("span", { className: "small", text: "共 " + data.students.length + " 人" })),
        filters.has("classId") ? button("清除班级筛选", () => {
          const url = new URL(location.href);
          url.searchParams.delete("classId");
          history.replaceState(null, "", url);
          render();
        }, "secondary") : null,
        data.students.length ? bulkTools : null,
        data.students.length ? tableWrap(students) : make("div", { className: "empty-state" }, make("strong", { text: "尚无学生" }), "打开办公助理上传入围名单，或在上方手动添加。")));
    if (pendingScroll !== null) { window.scrollTo(0, pendingScroll); pendingScroll = null; }
  } catch (error) { shell.replaceChildren(pageHead(adminCode, adminTitle), notice(error.message, "error")); } })();
  return shell;
}
function showStudent(student, data) {
  const orgLine = [student.college_name, student.grade_name, student.major_name, student.class_name].filter(Boolean).join(" · ") || "未分配学院/年级/专业/班级";
  const wrap = make("div", { className: "view view-student-detail" },
    pageHead("STAFF / STUDENT PROFILE", student.name + "的档案", "学号 " + student.student_no + " · " + orgLine),
    button("← 返回工作台", () => navigate("admin"), "secondary"));
  const classChoices = (me.role === "admin" ? data.classes : data.classes.filter(c => (data.majors.find(m => m.id === c.major_id)?.grade_id) === me.grade_id)).map(x => [x.id, (data.majors.find(m => m.id === x.major_id)?.name || "") + " · " + x.name]);
  const profileForm = make("form", { className: "form-grid" },
    select("班级", "classId", classChoices, student.class_id),
    field("年级", "grade", "text", false, student.grade || ""),
    field("联系电话", "phone", "tel", false, student.phone || ""),
    field("申请入党日期", "appliedAt", "date", false, student.applied_at || ""),
    make("button", { className: "btn", type: "submit", text: "保存基本资料" }));
  profileForm.addEventListener("submit", async event => {
    event.preventDefault();
    const release = busy(profileForm);
    try { await post("/api/admin/students/" + student.id + "/profile", formData(profileForm)); feedback(profileForm, "基本资料已更新", "success"); }
    catch (error) { feedback(profileForm, error.message); }
    finally { release(); }
  });
  const nodeForm = make("form", { className: "inline-form" },
    select("当前节点", "nodeSlug", data.nodes.map(x => [x.slug, x.name]), student.current_node_slug),
    make("button", { className: "btn", type: "submit", text: "保存节点" }));
  nodeForm.addEventListener("submit", async event => {
    event.preventDefault();
    try { await post("/api/admin/students/" + student.id, formData(nodeForm)); feedback(nodeForm, "节点已更新", "success"); }
    catch (error) { feedback(nodeForm, error.message); }
  });
  const materialChoices = data.materials.filter(x => x.stage_slug === student.current_stage_slug);
  const materialForm = make("form", { className: "inline-form" },
    select("材料", "materialId", materialChoices.map(x => [x.id, x.name])),
    select("状态", "status", [["未交", "未交"], ["已交", "已交"], ["已通过", "已通过"]]),
    make("button", { className: "btn", type: "submit", text: "保存材料状态" }));
  materialForm.addEventListener("submit", async event => {
    event.preventDefault();
    const values = formData(materialForm);
    try { await post("/api/admin/students/" + student.id + "/materials/" + values.materialId, { status: values.status }); feedback(materialForm, "材料状态已更新", "success"); }
    catch (error) { feedback(materialForm, error.message); }
  });
  const notificationForm = make("form", { className: "auth-form" },
    field("通知标题", "title", "text", true, "党课提醒"),
    field("通知内容", "content", "text", true, "请按时参加党课学习，并按支部安排完成相关任务。"),
    make("button", { className: "btn", type: "submit", text: "发送站内通知" }));
  notificationForm.addEventListener("submit", async event => {
    event.preventDefault();
    try { await post("/api/admin/notifications", { ...formData(notificationForm), studentId: student.id }); feedback(notificationForm, "通知已生成", "success"); }
    catch (error) { feedback(notificationForm, error.message); }
  });
  const filesPanel = panel(make("div", { className: "panel-head" }, make("h2", { text: "已提交文件" })), notice("正在读取学生文件…"));
  wrap.append(panel(make("div", { className: "panel-head" }, make("h2", { text: "基本资料" })), profileForm),
    panel(make("div", { className: "panel-head" }, make("h2", { text: "培养节点" })), nodeForm),
    panel(make("div", { className: "panel-head" }, make("h2", { text: "材料状态" })), materialForm),
    filesPanel,
    panel(make("div", { className: "panel-head" }, make("h2", { text: "站内通知" })), notificationForm));
  root.replaceChildren(wrap);
  (async () => { try {
    const result = await api("/api/admin/students/" + student.id + "/files");
    const table = make("table", { className: "data" },
      make("thead", {}, make("tr", {}, ["阶段", "材料", "文件", "审阅状态", "提交时间"].map(text => make("th", { text })))),
      make("tbody", {}, result.files.map(file => make("tr", {},
        make("td", { text: file.stage_name }), make("td", { text: file.material_name }),
        make("td", {}, make("a", { href: "/api/checks/" + file.id + "/file", text: file.filename })),
        make("td", { text: file.review_status || "待审阅" }),
        make("td", { text: displayTime(file.checked_at) })))));
    filesPanel.replaceChildren(make("div", { className: "panel-head" }, make("h2", { text: "已提交文件" }), make("span", { className: "small", text: result.files.length + " 份" })),
      result.files.length ? tableWrap(table) : make("div", { className: "empty-state" }, "这名学生尚未提交文件。"));
  } catch (error) { filesPanel.replaceChildren(notice(error.message, "error")); } })();
}

async function init() {
  try {
    config = await api("/api/config");
    await refreshMe();
    if (config.initialized && location.hash === "#bootstrap") {
      history.replaceState(null, "", "#login");
    }
    await refreshUnreadNotifications();
    render();
    const fab = document.getElementById("mentorFab");
    if (fab) fab.addEventListener("click", () => mentorPanelOpen ? closeMentor() : openMentor());
    const close = document.getElementById("mentorPanelClose");
    if (close) close.addEventListener("click", closeMentor);
    document.addEventListener("keydown", event => { if (event.key === "Escape" && mentorPanelOpen) closeMentor(); });
  } catch (error) {
    root.replaceChildren(h("暂时无法连接"), notice(error.message, "error"));
  }
}
window.addEventListener("hashchange", render);
init();
