import JSZip from "jszip";
import officialForms from "../official-forms.json";
import { extractReviewText } from "./file-text.js";
import { extractRosterText, parseRosterText, parseCounselorRoster } from "./roster.js";
import { deriveVerifier } from "./pbkdf2.js";

const root = document.getElementById("app");
const navigation = document.getElementById("navigation");
let me = null;
let config = null;
let mentorHistory = [];
let mentorEpoch = 0;
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
const mentorTitle = () => (me && (me.role === "counselor" || me.role === "admin")) ? "知行 · 办公助理" : "成长导师";
const mentorErrorText = (code, message) => "错误代码 " + code + "：" + message + "。请将错误代码报告给你的导员和支持部门。";
const renderMarkdown = src => {
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = s => {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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
const h = text => make("h1", { className: "page-title", text });
const p = text => make("p", { text });
const panel = (...children) => make("section", { className: "panel" }, children);
const pageHead = (code, title, description = "") => make("div", { className: "page-head" },
  make("div", {}, h(title), description ? p(description) : null));
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
  const submit = form.querySelector("[type=submit]");
  if (submit) submit.disabled = true;
  return () => { if (submit) submit.disabled = false; };
};
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: options.body instanceof FormData ? {} : options.body ? { "content-type": "application/json" } : {},
    ...options
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || "请求失败");
    if (data.code) error.code = data.code;
    throw error;
  }
  return data;
}
const post = (path, data) => api(path, { method: "POST", body: JSON.stringify(data) });
function feedback(form, message, kind = "error") {
  const old = form.querySelector(".notice");
  if (old) old.remove();
  form.prepend(notice(message, kind));
}
function formData(form) { return Object.fromEntries(new FormData(form)); }
function randomHex(size) {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), n => n.toString(16).padStart(2, "0")).join("");
}
async function derive(password, salt, iterations = 210000) {
  return deriveVerifier(password, salt, iterations);
}
function navigate(page) { location.hash = page; render(); }
function nav() {
  navigation.replaceChildren();
  if (me) navigation.append(make("span", { className: "nav-label", text: me.role === "student" ? "学生工作区" : "党务工作区" }));
  const active = location.hash.slice(1) || (me ? me.role === "student" ? "profile" : "admin" : "login");
  const items = me?.must_change_password ? [["password", "设置新密码"]] : me ? (me.role === "student"
    ? [["profile", "我的档案"], ["forms", "资料下载"], ["check", "材料提交"], ["mentor", "成长导师"], ["notifications", "通知"]]
    : [["admin", "工作台"], ["forms", "资料下载"], ["checks", "已提交文件"]])
    : (config?.initialized ? [] : [["bootstrap", "初始化"]]);
  const scroll = make("div", { className: "nav-scroll" });
  for (const [page, label] of items) {
    const link = make("a", { href: "#" + page, text: label, className: active === page ? "active" : "" });
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
        make("a", { href: "#password", text: "修改密码" }),
        button("登出", logout, "linklike")));
    navigation.append(profileMenu);
  }
}
async function refreshMe() {
  try { me = (await api("/api/me")).user; } catch { me = null; }
}
function render() {
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
  if (!me) root.replaceChildren(page === "register" ? registration() : page === "bootstrap" && !config?.initialized ? bootstrap() : login());
  else if (me.must_change_password) root.replaceChildren(passwordPage());
  else if (page === "password") root.replaceChildren(passwordPage());
  else if (page === "forms") root.replaceChildren(formsPage());
  else if (me.role === "student") root.replaceChildren(
    page === "check" ? checkPage() : page === "mentor" ? mentorPage() : page === "notifications" ? notificationsPage() : profilePage());
  else root.replaceChildren(page === "checks" ? checksPage() : adminPage());
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
      navigate(me?.must_change_password ? "password" : me?.role === "student" ? "profile" : "admin");
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
    make("div", { className: "orbit-field", "aria-hidden": "true" },
      make("span", { className: "orbit-ring orbit-ring-one" }),
      make("span", { className: "orbit-ring orbit-ring-two" }),
      make("span", { className: "orbit-ring orbit-ring-three" }),
      make("span", { className: "orbit-center" }),
      make("span", { className: "orbit-node orbit-node-one" }),
      make("span", { className: "orbit-node orbit-node-two" }),
      make("span", { className: "orbit-node orbit-node-three" }),
      make("span", { className: "orbit-node orbit-node-four" }),
      make("span", { className: "orbit-node orbit-node-five" })),
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

function profilePage() {
  const shell = make("div", { className: "view view-profile" }, pageHead("STUDENT / OVERVIEW", "我的档案", "查看当前培养阶段、下一步节点和材料完成情况。"), notice("正在读取档案…"));
  (async () => { try {
    const data = await api("/api/profile");
    const profile = data.profile;
    const stageOrder = ["application", "activist", "development-target", "probationary-acceptance", "probationary-regularization"];
    const stageNumber = Math.max(1, stageOrder.indexOf(profile.current_stage_slug) + 1);
    const done = data.materials.filter(x => x.status === "已交" || x.status === "已通过").length;
    const total = data.materials.length;
    const completion = total ? Math.round(done * 100 / total) : 0;
    const summary = panel(
      make("div", { className: "panel-head" },
        make("h2", { text: profile.name + "的培养档案" }),
        make("span", { className: "badge", text: profile.student_no })),
      p(data.department + " · " + (profile.major || "专业未填") + " · " + (profile.grade || "年级未填")),
      make("div", { className: "progress-track" }, make("span", { style: "width:" + (stageNumber / 5 * 100) + "%" })),
      make("p", { className: "small", text: "培养流程 · 第 " + stageNumber + " / 5 阶段" }));
    const stats = make("div", { className: "metric-grid" },
      metric("当前阶段", data.stage?.name || "未开始", "培养进度", true),
      metric("当前节点", data.node?.name || "未设置", data.node?.duration_rule || "按计划推进"),
      metric("材料完成", done + " / " + total, "本阶段材料已完成 " + completion + "%"));
    const table = make("table", { className: "data" },
      make("thead", {}, make("tr", {}, ["材料名称", "类别", "填写方式", "状态"].map(x => make("th", { text: x })))),
      make("tbody", {}, data.materials.map(item => make("tr", {},
        make("td", { text: item.name }),
        make("td", { text: ({ A: "档案材料", B: "流程表", C: "会议记录" })[item.category] || item.category }),
        make("td", { text: ({ red: "个人填写", blue: "组织审批", black: "支部填写" })[item.fill_method] || item.fill_method }),
        make("td", {}, make("span", { className: "badge " + (item.status === "已交" || item.status === "已通过" ? "done" : "missing"), text: item.status || "未交" }))))));
    const materials = panel(make("div", { className: "panel-head" },
      make("h2", { text: "本阶段材料" }), make("span", { className: "small", text: "共 " + total + " 项" })),
      total ? tableWrap(table) : make("div", { className: "empty-state" }, make("strong", { text: "暂无材料" }), "此阶段尚未配置材料清单。"));
    shell.replaceChildren(pageHead("STUDENT / OVERVIEW", "我的档案", "查看当前培养阶段、下一步节点和材料完成情况。"),
      summary, stats,
      ...(data.next ? [notice("下一步：" + data.next.name + "。请按计划准备相关材料。")] : []),
      materials);
  } catch (error) { shell.replaceChildren(pageHead("STUDENT / OVERVIEW", "我的档案"), notice(error.message, "error")); } })();
  return shell;
}

function mentorGirl() {
  for (let i = 1; i <= 7; i++) { const img = new Image(); img.src = "/girl/frame_" + i + ".webp"; }
  return make("img", { src: "/girl/frame_0.webp", alt: "", className: "mentor-girl-img", draggable: "false" });
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
      make("span", { className: "mentor-kicker", text: staffAgent ? "ZHI XING / OFFICE ASSISTANT" : "GROWTH MENTOR / 成长导师" }),
      make("h1", { text: staffAgent ? "今天想处理什么？" : "今天想了解什么？" }),
      make("p", { text: staffAgent ? "告诉我任务，或上传名单与文件。我会整理执行清单，待你确认后处理。" : "从培养流程到写作思路，直接说出你的问题。" }));
    const prompts = make("div", { className: "mentor-prompts" },
      (staffAgent ? ["批量登记学生", "批量更新学生档案", "上传培养表格", "为学生重置密码"] : ["我现在处于哪个入党阶段？", "我交了哪些材料，还有哪些没交？", "这个系统怎么使用？", "入党申请书如何组织结构？"])
        .map(question => button(question, () => { textarea.value = question; form.requestSubmit(); }, "mentor-prompt")));
    empty.append(prompts);
    const sourceView = sources => make("details", { className: "mentor-sources" },
      make("summary", { text: "查看依据 · " + sources.length + " 条" }),
      make("div", { className: "mentor-source-items" }, sources.map((source, index) => make("div", { className: "mentor-source" },
        make("strong", { text: (index + 1) + ". " + source.title + " · " + source.section }), make("p", { text: source.excerpt })))));
    const appendMessage = item => {
      const row = make("div", { className: "mentor-row " + item.role });
      const msg = make("div", { className: "mentor-message" });
      if (item.role === "assistant") msg.innerHTML = renderMarkdown(item.content || "");
      else msg.textContent = item.content || "";
      const body = make("div", { className: "mentor-bubble" }, msg);
      if (item.sources?.length) body.append(sourceView(item.sources));
      row.append(body); log.append(row); return row;
    };
    const textarea = make("textarea", { name: "question", rows: "1", maxlength: "1000", required: "", "aria-label": staffAgent ? "向办公助理描述任务" : "向成长导师提问", placeholder: staffAgent ? "描述要完成的办公任务…" : status.enabled ? "向成长导师提问…" : "检索培养资料…" });
    const send = make("button", { type: "submit", className: "mentor-send", "aria-label": "发送问题", title: "发送问题" }, icon("M4 12 20 4 14 20 11 13 4 12Z M11 13 20 4", "发送"));
    let workflowMode = staffAgent ? "office" : "chat";
    let pendingRoster = null;
    let pendingOfficePlan = null;
    let pendingOfficeButton = null;
    let officeHistory = [];
    const rosterPrompt = () => workflowMode === "counselor-register"
      ? "请上传或粘贴辅导员名单，每行“姓名 用户名”。选择院系后，我会先列出识别结果，等你确认后再创建账号。"
      : workflowMode === "counselor-delete"
        ? "请上传或粘贴要删除的辅导员用户名，每行一个。我会先列出识别结果，等你确认后再删除。"
        : "请上传 Excel、Word 或 PDF 入围名单。也可以直接粘贴“姓名 学号”，每行一人；我会先列出识别结果，等你确认后再注册。";
    let selectedFile = null;
    let selectedFiles = [];
    const fileInput = make("input", { type: "file", accept: ".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document", className: "mentor-file-input", "aria-label": "选择 Word DOCX 或 PDF 文件" });
    const attachment = make("div", { className: "mentor-attachment", hidden: "" });
    const clearFile = () => { selectedFile = null; selectedFiles = []; fileInput.value = ""; attachment.hidden = true; attachment.replaceChildren(); textarea.required = true; };
    const attach = make("button", { type: "button", className: "mentor-attach", "aria-label": "上传 Word 或 PDF 文件", title: "上传 Word DOCX 或 PDF" }, icon("M8 12.5 14.5 6a3 3 0 0 1 4.2 4.2l-8.1 8.1a5 5 0 0 1-7.1-7.1l8.4-8.4", "附件"));
    const acceptFile = file => {
      if (!file) return;
      if (workflowMode === "office") {
        const incoming = Array.isArray(file) ? file : [file];
        if (incoming.length > 10 || incoming.some(item => !/\.(doc|docx|xls|xlsx|pdf|csv|txt)$/i.test(item.name) || item.size < 1 || item.size > 10 * 1024 * 1024)) {
          clearFile(); appendMessage({ role: "assistant", content: "一次最多选择 10 份文件，每份不超过 10 MB；支持 DOC、DOCX、XLS、XLSX、PDF、CSV、TXT。" }); return;
        }
        selectedFiles = incoming; textarea.required = false; attachment.hidden = false;
        attachment.replaceChildren(make("span", { text: incoming.map(item => item.name).join("、") }), button("移除", clearFile, "mentor-remove-attachment"));
        return;
      }
      const allowed = workflowMode !== "chat" ? /\.(xlsx|csv|txt|docx|pdf)$/i : /\.(docx|pdf)$/i;
      if (!allowed.test(file.name) || file.size > 10 * 1024 * 1024 || file.size < 1) {
        clearFile(); appendMessage({ role: "assistant", content: workflowMode !== "chat" ? "名单请上传不超过 10 MB 的 XLSX、CSV、TXT、DOCX 或可搜索 PDF。" : "请上传不超过 10 MB 的 Word DOCX 或 PDF。旧版 .doc 请另存为 .docx。" }); return;
      }
      selectedFile = file; textarea.required = false; attachment.hidden = false;
      attachment.replaceChildren(make("span", { text: file.name }), button("移除", clearFile, "mentor-remove-attachment"));
      if (workflowMode !== "chat") form.requestSubmit();
    };
    attach.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => acceptFile(workflowMode === "office" ? Array.from(fileInput.files || []) : fileInput.files?.[0]));
    const form = make("form", { className: "mentor-composer" }, fileInput, attachment,
      make("div", { className: "mentor-composer-box" }, attach, textarea, send),
      make("p", { className: "mentor-composer-note", text: "校内要求以辅导员通知为准" }));
    let dragDepth = 0;
    form.addEventListener("dragenter", event => { event.preventDefault(); dragDepth++; form.classList.add("mentor-dragging"); });
    form.addEventListener("dragleave", event => { event.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; form.classList.remove("mentor-dragging"); } });
    form.addEventListener("dragover", event => { event.preventDefault(); });
    form.addEventListener("drop", event => { event.preventDefault(); dragDepth = 0; form.classList.remove("mentor-dragging"); acceptFile(workflowMode === "office" ? Array.from(event.dataTransfer?.files || []) : event.dataTransfer?.files?.[0]); });
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
      mentorHistory = []; officeHistory = []; pendingRoster = null; pendingOfficePlan = null; pendingOfficeButton = null; pendingConfirm = null; userReading = false; log.replaceChildren();
      if (workflowMode !== "chat" && workflowMode !== "office") appendMessage({ role: "assistant", content: rosterPrompt() });
      else log.append(empty);
      textarea.value = ""; clearFile();
      if (workflowMode === "chat" || workflowMode === "office") textarea.focus(); else textarea.blur();
    };
    const newChat = () => button("新对话", reset, "mentor-new-chat");
    const aside = make("aside", { className: "mentor-sidebar" },
      make("a", { className: "mentor-school", href: "#profile", "aria-label": "返回我的档案" }, make("img", { src: "/cauc-wordmark.png", alt: "中国民航大学" })),
      make("div", { className: "mentor-sidebar-title", text: "党员发展计划辅助系统" }), newChat(),
      make("div", { className: "mentor-nav-label", text: "工作区" }), make("nav", { className: "mentor-sidebar-nav", "aria-label": "学生工作区" }, navLinks()),
      make("div", { className: "mentor-sidebar-bottom" }, make("span", { text: "当前会话" }), make("strong", { text: me?.name || me?.username || "学生" })));
    const menu = make("details", { className: "mentor-mobile-menu" }, make("summary", { "aria-label": "打开工作区菜单" }, icon("M4 7h16 M4 12h16 M4 17h16", "菜单")), make("nav", { "aria-label": "学生工作区" }, navLinks()));
    const girlImg = mentorGirl();
    let girlTimers = [];
    const setGirlFrame = n => { girlImg.src = "/girl/frame_" + n + ".webp"; };
    const clearGirlTimers = () => { girlTimers.forEach(clearTimeout); girlTimers = []; };
    const playGirlTyping = () => {
      clearGirlTimers();
      let i = 1;
      const introDurs = [320, 300, 260, 240];
      const step = () => {
        if (i <= 4) { setGirlFrame(i); girlTimers.push(setTimeout(step, introDurs[i - 1])); i++; }
        else { let t = 0; const loop = () => { setGirlFrame(5 + (t % 3)); t++; girlTimers.push(setTimeout(loop, 240)); }; loop(); }
      };
      step();
    };
    const playGirlBack = () => {
      clearGirlTimers();
      [4, 3, 2, 1, 0].forEach((n, idx) => { girlTimers.push(setTimeout(() => setGirlFrame(n), idx * 180)); });
    };
    const hero = make("div", { className: "mentor-hero" },
      staffAgent ? make("div", { className: "office-avatar", "aria-hidden": "true", text: "知行" }) : make("div", { className: "mentor-girl", "aria-hidden": "true" }, girlImg),
      make("div", { className: "mentor-titlebox" },
        make("strong", { text: mentorTitle() }),
        make("span", { text: me ? "党员发展计划辅助系统" : "访客模式 · 登录后可知你的档案" })));
    const header = make("header", { className: "mentor-topbar" }, make("div", { className: "mentor-topbar-left" }, menu, newChat()));
    const canWorkflow = me?.role === "counselor" || me?.role === "admin";
    const workflowToggle = canWorkflow ? make("input", { type: "checkbox", "aria-label": "启用工作流" }) : null;
    const workflowChoices = me?.role === "admin"
      ? [["counselor-register", "批量添加辅导员"], ["counselor-delete", "批量删除辅导员"]]
      : [["auto-register", "自动注册学生"]];
    const workflowChoice = workflowToggle ? make("select", { "aria-label": "选择工作流", disabled: "" },
      workflowChoices.map(([value, text]) => make("option", { value, text }))) : null;
    const counselorDeptSelect = (me?.role === "admin" && config?.departments?.length)
      ? make("select", { "aria-label": "辅导员所属院系", disabled: "" }, config.departments.map(department => make("option", { value: department.id, text: department.name })))
      : null;
    const workflow = workflowToggle ? make("div", { className: "mentor-workflow-bar" },
      make("label", { className: "mentor-workflow-toggle" }, workflowToggle, make("span", { text: "启用工作流" })),
      make("label", { className: "mentor-workflow-choice" }, make("span", { text: "执行" }), workflowChoice),
      ...(counselorDeptSelect ? [make("label", { className: "mentor-workflow-choice" }, make("span", { text: "院系" }), counselorDeptSelect)] : [])) : null;
    const syncWorkflow = () => {
      workflowChoice.disabled = !workflowToggle.checked;
      workflowMode = workflowToggle.checked ? workflowChoice.value : "office";
      const roster = workflowMode !== "chat";
      fileInput.multiple = workflowMode === "office";
      fileInput.accept = workflowMode === "office" ? ".doc,.docx,.xls,.xlsx,.pdf,.csv,.txt" : roster ? ".xlsx,.csv,.txt,.docx,.pdf" : ".docx,.pdf";
      fileInput.setAttribute("aria-label", workflowMode === "office" ? "选择办公任务文件" : roster ? "上传名单" : "选择 Word DOCX 或 PDF 文件");
      attach.setAttribute("aria-label", workflowMode === "office" ? "选择办公任务文件" : roster ? "上传名单" : "上传 Word 或 PDF 文件");
      attach.title = workflowMode === "office" ? "选择最多 10 份文件" : roster ? "上传 XLSX、CSV、TXT、DOCX 或 PDF 名单" : "上传 Word DOCX 或 PDF";
      textarea.placeholder = workflowMode === "office" ? "描述要完成的办公任务…" : roster
        ? (workflowMode === "auto-register" ? "也可粘贴名单，每行：姓名 学号" : workflowMode === "counselor-register" ? "也可粘贴名单，每行：姓名 用户名" : "也可粘贴名单，每行：用户名")
        : status.enabled ? "向成长导师提问…" : "检索培养资料…";
      if (counselorDeptSelect) counselorDeptSelect.disabled = !workflowToggle.checked || workflowMode !== "counselor-register";
      reset();
    };
    if (workflow) { workflowToggle.addEventListener("change", syncWorkflow); workflowChoice.addEventListener("change", syncWorkflow); }
    if (staffAgent) { fileInput.multiple = true; fileInput.accept = ".doc,.docx,.xls,.xlsx,.pdf,.csv,.txt"; }
    const content = make("div", { className: "mentor-content" }, log, workflow, form);
    shell.replaceChildren(aside, make("section", { className: "mentor-main", "aria-label": "成长导师" }, hero, header, content));
    if (mentorHistory.length) for (const item of mentorHistory) appendMessage(item); else log.append(empty);
    const resize = () => { textarea.style.height = "auto"; textarea.style.height = Math.min(textarea.scrollHeight, 176) + "px"; };
    textarea.addEventListener("input", resize);
    textarea.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
    let pendingConfirm = null;
    const showRosterPreview = result => {
      const row = appendMessage({ role: "assistant", content: "我识别到 " + result.rows.length + " 人。请直接核对、修改或移除表格中的记录，确认后才会创建账号。" });
      row.classList.add("roster-message");
      const body = row.querySelector(".mentor-bubble");
      if (result.issues.length) body.append(make("p", { className: "roster-issues", text: "需要核对：" + result.issues.slice(0, 5).join("；") }));
      const table = make("table", { className: "data roster-table" },
        make("thead", {}, make("tr", {}, ["姓名", "学号", "操作"].map(label => make("th", { text: label })))),
        make("tbody", {}, result.rows.map(item => make("tr", { className: "roster-row" },
          make("td", {}, make("input", { className: "roster-name", value: item.name, "aria-label": "学生姓名" })),
          make("td", {}, make("input", { className: "roster-number", value: item.studentNo, inputmode: "numeric", "aria-label": "学号" })),
          make("td", {}, button("移除", event => event.currentTarget.closest("tr").remove(), "secondary"))))));
      let confirmAction;
      const confirm = button("确认并注册", () => confirmAction(), "btn");
      pendingRoster = table;
      confirmAction = async () => {
        if (workflowMode !== "auto-register" || pendingRoster !== table || confirm.disabled) return;
        const students = Array.from(table.querySelectorAll(".roster-row"), tr => ({
          name: tr.querySelector(".roster-name").value.trim(), studentNo: tr.querySelector(".roster-number").value.trim()
        }));
        if (!students.length) return appendMessage({ role: "assistant", content: "名单已清空。请重新上传或粘贴名单。" });
        if (!students.every(item => /^[\p{Script=Han}·]{2,20}$/u.test(item.name) && /^\d{6,20}$/.test(item.studentNo)) ||
          new Set(students.map(item => item.studentNo)).size !== students.length) {
          focusReplyTop(appendMessage({ role: "assistant", content: "表格里有无效姓名、学号或重复学号。请先修改，再点“确认并注册”。" }));
          return;
        }
        if (!window.confirm("确认注册 " + students.length + " 名学生？首次登录密码为 cauc+学号，登录后必须修改。")) return;
        userReading = false;
        confirm.disabled = true;
        appendMessage({ role: "assistant", content: "正在为 " + students.length + " 名学生创建账号…" });
        scrollEnd();
        try {
          const saved = await post("/api/admin/students/auto-register", { students });
          pendingRoster = null; pendingConfirm = null;
          const done = appendMessage({ role: "assistant", content: "已注册 " + saved.count + " 名学生。请通过可信渠道通知他们使用学号和 cauc+学号首次登录，并立即修改密码。" });
          done.querySelector(".mentor-bubble").append(button("查看学生档案", () => { closeMentor(); navigate("admin"); }, "secondary"));
          focusReplyTop(done);
        } catch (error) {
          confirm.disabled = false;
          focusReplyTop(appendMessage({ role: "assistant", content: "注册未完成：" + error.message + "。请修正表格后重试。" }));
        }
      };
      pendingConfirm = confirmAction;
      body.append(tableWrap(table), confirm);
      focusReplyTop(row);
    };
    const showCounselorRosterPreview = result => {
      const deleting = workflowMode === "counselor-delete";
      const row = appendMessage({ role: "assistant", content: deleting
        ? "我识别到 " + result.rows.length + " 名辅导员。请核对后确认删除（此操作不可恢复）。"
        : "我识别到 " + result.rows.length + " 名辅导员。请核对、修改或移除记录，确认后才会创建账号。" });
      row.classList.add("roster-message");
      const body = row.querySelector(".mentor-bubble");
      if (result.issues.length) body.append(make("p", { className: "roster-issues", text: "需要核对：" + result.issues.slice(0, 5).join("；") }));
      const table = make("table", { className: "data roster-table" },
        make("thead", {}, make("tr", {}, ["姓名", "用户名", "操作"].map(label => make("th", { text: label })))),
        make("tbody", {}, result.rows.map(item => make("tr", { className: "roster-row" },
          make("td", {}, make("input", { className: "roster-name", value: item.name, "aria-label": "辅导员姓名" })),
          make("td", {}, make("input", { className: "roster-number", value: item.username, "aria-label": "用户名" })),
          make("td", {}, button("移除", event => event.currentTarget.closest("tr").remove(), "secondary"))))));
      let confirmAction;
      const confirm = button(deleting ? "确认删除" : "确认并注册", () => confirmAction(), "btn");
      pendingRoster = table;
      confirmAction = async () => {
        if ((workflowMode !== "counselor-register" && workflowMode !== "counselor-delete") || pendingRoster !== table || confirm.disabled) return;
        const rows = Array.from(table.querySelectorAll(".roster-row"), tr => ({
          name: tr.querySelector(".roster-name").value.trim(), username: tr.querySelector(".roster-number").value.trim()
        }));
        if (!rows.length) return appendMessage({ role: "assistant", content: "名单已清空。请重新上传或粘贴名单。" });
        const valid = rows.every(item => (/^[\p{Script=Han}·]{2,20}$/u.test(item.name) || deleting) && /^[a-zA-Z0-9_.-]{3,40}$/.test(item.username))
          && new Set(rows.map(item => item.username.toLowerCase())).size === rows.length;
        if (!valid) { focusReplyTop(appendMessage({ role: "assistant", content: "表格里有无效姓名、用户名或重复用户名。请先修改，再点确认。" })); return; }
        if (!window.confirm(deleting ? "确认删除这 " + rows.length + " 名辅导员？" : "确认注册 " + rows.length + " 名辅导员？首次登录密码为 cauc+用户名，登录后必须修改。")) return;
        userReading = false;
        confirm.disabled = true;
        appendMessage({ role: "assistant", content: deleting ? "正在删除辅导员…" : "正在创建辅导员账号…" });
        scrollEnd();
        try {
          if (deleting) {
            const saved = await post("/api/admin/counselors/bulk-delete", { usernames: rows.map(item => item.username) });
            pendingRoster = null; pendingConfirm = null;
            focusReplyTop(appendMessage({ role: "assistant", content: "已删除 " + saved.count + " 名辅导员。" }));
          } else {
            const departmentId = counselorDeptSelect ? counselorDeptSelect.value : null;
            if (!departmentId) { confirm.disabled = false; focusReplyTop(appendMessage({ role: "assistant", content: "请先选择辅导员所属院系。" })); return; }
            const saved = await post("/api/admin/counselors/auto-register", { departmentId: Number(departmentId), counselors: rows });
            pendingRoster = null; pendingConfirm = null;
            const done = appendMessage({ role: "assistant", content: "已注册 " + saved.count + " 名辅导员。请通知他们使用用户名和 cauc+用户名 首次登录，并立即修改密码。" });
            done.querySelector(".mentor-bubble").append(button("查看辅导员", () => { closeMentor(); navigate("admin"); }, "secondary"));
            focusReplyTop(done);
          }
        } catch (error) {
          confirm.disabled = false;
          focusReplyTop(appendMessage({ role: "assistant", content: (deleting ? "删除未完成：" : "注册未完成：") + error.message + "。请修正后重试。" }));
        }
      };
      pendingConfirm = confirmAction;
      body.append(tableWrap(table), confirm);
      focusReplyTop(row);
    };
    const handleRosterSubmit = async (question, file) => {
      userReading = false;
      if (!file && !question) { focusReplyTop(appendMessage({ role: "assistant", content: rosterPrompt() })); return; }
      if (log.contains(empty)) empty.remove();
      appendMessage({ role: "user", content: file ? "上传名单：" + file.name : question });
      textarea.value = ""; textarea.blur(); resize();
      if (!file && /^(确认|确认注册|确认删除|开始注册|开始删除)$/.test(question) && pendingConfirm) { await pendingConfirm(); return; }
      pendingRoster = null; pendingConfirm = null;
      const loading = appendMessage({ role: "assistant", content: file ? "正在读取名单…" : "正在识别名单文字…" });
      const release = busy(form);
      attach.disabled = true;
      playGirlTyping(); scrollEnd();
      try {
        const text = file ? await extractRosterText(file) : question;
        if (!alive()) return;
        if (workflowMode === "auto-register") {
          const result = parseRosterText(text);
          loading.remove();
          if (!result.rows.length) focusReplyTop(appendMessage({ role: "assistant", content: "暂时没识别到有效的姓名和学号。请上传名单，或按“张三 123456789”每行一人粘贴后发送。" }));
          else if (result.rows.length > 50) focusReplyTop(appendMessage({ role: "assistant", content: "识别到 " + result.rows.length + " 人；一次最多注册 50 人。请把名单拆分后重新上传。" }));
          else showRosterPreview(result);
        } else {
          const result = parseCounselorRoster(text);
          loading.remove();
          if (!result.rows.length) focusReplyTop(appendMessage({ role: "assistant", content: "暂时没识别到有效的用户名。请上传名单，或每行粘贴“姓名 用户名”。" }));
          else if (result.rows.length > 50) focusReplyTop(appendMessage({ role: "assistant", content: "识别到 " + result.rows.length + " 人；一次最多处理 50 人。请把名单拆分后重试。" }));
          else showCounselorRosterPreview(result);
        }
        if (file) clearFile();
      } catch (error) { loading.remove(); focusReplyTop(appendMessage({ role: "assistant", content: "名单读取失败：" + error.message + "。请换文件或直接粘贴名单文字。" })); }
      finally { playGirlBack(); release(); attach.disabled = false; }
    };
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
      textarea.value = ""; textarea.blur(); resize(); scrollEnd();
      try {
        let documentText = "";
        if (files.length && /登记学生|注册学生|名单|更新数据|更新档案|批量修改/.test(question)) {
          for (const file of files) {
            if (/\.(xlsx|csv|txt|docx|pdf)$/i.test(file.name)) documentText += "\n文件：" + file.name + "\n" + (await extractRosterText(file)).slice(0, 10000);
          }
        }
        const result = await post("/api/office/plan", { question, documentText: documentText.slice(0, 25000), files: files.map(file => ({ name: file.name })), history: officeHistory.slice(-6) });
        if (!alive()) return;
        officeHistory.push({ role: "user", content: question }, { role: "assistant", content: result.answer });
        loading.remove();
        const row = appendMessage({ role: "assistant", content: result.answer + (result.plan ? "\n\n**待确认操作**\n" + result.plan.preview : "") });
        if (result.plan) {
          pendingOfficePlan = result.plan.id;
          const plannedFiles = files.slice();
          const confirm = button("确认执行", async () => {
            if (pendingOfficePlan !== result.plan.id || confirm.disabled) return;
            confirm.disabled = true;
            const progress = appendMessage({ role: "assistant", content: "正在执行已确认的任务…" });
            scrollEnd();
            try {
              let outcome, temporaryPassword;
              if (result.plan.type === "reset_password") {
                temporaryPassword = randomHex(12);
                const newSalt = randomHex(16), newVerifier = await derive(temporaryPassword, newSalt);
                outcome = await post("/api/office/execute", { planId: result.plan.id, newSalt, newVerifier });
              } else if (result.plan.type === "upload_forms" || result.plan.type === "upload_student_files") {
                const body = new FormData();
                body.append("planId", result.plan.id);
                plannedFiles.forEach(file => body.append("file", file, file.name));
                outcome = await api("/api/office/execute", { method: "POST", body });
              } else outcome = await post("/api/office/execute", { planId: result.plan.id });
              if (!alive()) return;
              progress.remove();
              pendingOfficePlan = null;
              pendingOfficeButton = null;
              clearFile();
              focusReplyTop(appendMessage({ role: "assistant", content: outcome.message + (temporaryPassword ? "\n\n**本次临时密码（仅显示在此处）：** `" + temporaryPassword + "`" : "") }));
            } catch (error) {
              progress.remove();
              confirm.disabled = false;
              focusReplyTop(appendMessage({ role: "assistant", content: "执行未完成：" + error.message + "。请核对后重试。" }));
            }
          }, "btn");
          pendingOfficeButton = confirm;
          row.querySelector(".mentor-bubble").append(confirm);
        }
        focusReplyTop(row);
      } catch (error) { loading.remove(); focusReplyTop(appendMessage({ role: "assistant", content: error.message + "。请补充信息后重试。" })); }
      finally { release(); attach.disabled = false; }
    };
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const question = form.elements.question.value.trim();
      const file = selectedFile;
      if (workflowMode === "office") { await handleOfficeSubmit(question, selectedFiles); return; }
      if (workflowMode !== "chat") { await handleRosterSubmit(question, file); return; }
      if (!file && question.length < 2) { textarea.setCustomValidity("请输入至少两个字的问题"); textarea.reportValidity(); textarea.setCustomValidity(""); return; }
      const release = busy(form);
      attach.disabled = true;
      const history = mentorHistory.slice(-6);
      userReading = false;
      if (log.contains(empty)) empty.remove();
      const displayQuestion = file ? "检查文件：" + file.name + (question ? "\n" + question : "") : question;
      appendMessage({ role: "user", content: displayQuestion });
      const loading = appendMessage({ role: "assistant", content: file ? "正在读取文档文字…" : status.enabled ? "正在思考…" : "正在检索…" });
      playGirlTyping();
      textarea.value = ""; textarea.blur(); resize(); scrollEnd();
      try {
        let result;
        if (file) {
          const text = await extractReviewText(file);
          loading.querySelector(".mentor-message").textContent = "正在识别表单并核对填写规范…";
          result = await post("/api/mentor/review", { filename: file.name, text });
          clearFile();
        } else result = await post(status.enabled ? "/api/mentor/chat" : "/api/mentor/retrieve", { question, history });
        if (!alive()) return;
        loading.remove();
        if (status.enabled || file) {
          mentorHistory.push({ role: "user", content: displayQuestion }, { role: "assistant", content: result.answer, route: result.route, sources: result.sources || [] });
          const row = appendMessage({ role: "assistant", content: "", sources: result.sources });
          const msg = row.querySelector(".mentor-message");
          focusReplyTop(row);
          // 先按 markdown 渲染成最终排版，再逐字回填渲染后的文本，避免用户看到原始 markdown 符号
          msg.innerHTML = renderMarkdown(result.answer);
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
  const shell = make("div", { className: "view view-notifications" }, pageHead("STUDENT / INBOX", "通知中心", "重要节点和材料提醒会集中显示在这里。"), notice("正在读取通知…"));
  (async () => { try {
    const data = await api("/api/notifications");
    shell.replaceChildren(pageHead("STUDENT / INBOX", "通知中心", "重要节点和材料提醒会集中显示在这里。"));
    if (!data.notifications.length) shell.append(panel(make("div", { className: "empty-state" },
      make("strong", { text: "通知已清空" }), "新的节点提醒会在这里出现。")));
    for (const item of data.notifications) {
      const read = button("标记已读", async () => {
        await post("/api/notifications/" + item.id + "/read", {});
        read.remove();
      });
      const row = make("div", { className: "notice-item" + (item.is_read ? " read" : "") },
        make("span", { className: "notice-dot" }),
        make("div", {}, make("h2", { text: item.title }), p(item.content), make("time", { text: item.created_at })),
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
function checkPage() {
  const shell = make("div", { className: "view view-check" }, pageHead("STUDENT / SUBMISSION", "材料提交", "先在浏览器检查 DOCX 格式，再提交给辅导员。"), notice("正在读取材料列表…"));
  (async () => { try {
    const data = await api("/api/materials");
    const materialChoices = data.materials.map(x => [x.id, x.name]);
    const form = make("form", { className: "check-form" },
      select("选择材料", "materialId", materialChoices),
      make("label", { className: "upload-drop" },
        make("span", { className: "upload-drop-icon", "aria-hidden": "true", text: "↑" }),
        make("strong", { text: "选择 DOCX 文件" }),
        make("span", { className: "small", text: "点击选择 · 仅 DOCX · 最大 10 MB · 上传后存入私有空间" }),
        make("input", { name: "docx", type: "file", accept: ".docx", required: "", "aria-label": "材料文件" })),
      make("button", { className: "btn", type: "submit", text: "检查并提交" }));
    const output = panel(make("div", { className: "panel-head" }, make("h2", { text: "质检结果" })),
      make("div", { className: "empty-state" }, make("strong", { text: "等待检查" }), "选择材料并上传 DOCX，结果将在这里显示。"));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const release = busy(form);
      try {
        const file = form.querySelector("[name=docx]").files[0];
        if (!file || file.size > 10 * 1024 * 1024 || !/\.docx$/i.test(file.name)) throw new Error("请选择不超过 10 MB 的 DOCX");
        const results = await inspectDocx(file);
        const data = new FormData(form);
        data.set("results", JSON.stringify(results));
        const saved = await api("/api/checks", { method: "POST", body: data });
        output.replaceChildren(make("div", { className: "panel-head" }, make("h2", { text: "质检结果" }), make("span", { className: "small", text: results.length + " 项结果" })),
          make("div", { className: "results-list" },
            results.length ? results.map(r => make("div", { className: "result-row" }, make("strong", { text: r.message }), p(r.suggestion))) :
              [make("div", { className: "result-row" }, make("strong", { text: "未发现格式问题" }), p("已完成当前规则检查。"))]),
          notice("文件已提交，辅导员可在后台下载。格式检查在你的浏览器中完成。", "success"),
          make("a", { className: "text-link", href: "/api/checks/" + saved.id + "/file", text: "下载已保存的材料 →" }));
      } catch (error) { feedback(form, error.message); }
      finally { release(); }
    });
    shell.replaceChildren(pageHead("STUDENT / SUBMISSION", "材料提交", "先在浏览器检查 DOCX 格式，再提交给辅导员。"),
      panel(make("div", { className: "panel-head" }, make("h2", { text: "上传并提交材料" })),
        p("检查标题居中、正文字体字号与文末落款。"), form), output);
  } catch (error) { shell.replaceChildren(pageHead("STUDENT / SUBMISSION", "材料提交"), notice(error.message, "error")); } })();
  return shell;
}

function checksPage() {
  const shell = make("div", { className: "view view-checks" }, pageHead("STAFF / DOCUMENTS", "已提交文件", "按权限查看并下载学生提交的材料。"), notice("正在读取记录…"));
  (async () => { try {
    const data = await api("/api/checks");
    const selected = new Set();
    const count = make("span", { className: "bulk-count", text: "已选 0 份" });
    const checks = data.checks.filter(x => x.review_status === "待审阅");
    const table = make("table", { className: "data" },
      make("thead", {}, make("tr", {},
        make("th", { className: "bulk-select" }, make("input", { type: "checkbox", "aria-label": "选择全部待审阅材料", onchange: event => {
          table.querySelectorAll("tbody input[type=checkbox]").forEach(box => { box.checked = event.target.checked; box.dispatchEvent(new Event("change")); });
        } })),
        ["学生", "材料", "文件", "审阅状态", "检查时间"].map(x => make("th", { text: x })))),
      make("tbody", {}, data.checks.map(x => make("tr", {},
        make("td", { className: "bulk-select" }, x.review_status === "待审阅" ? make("input", { type: "checkbox", value: x.id, "aria-label": "选择 " + (x.student_name || x.student_id) + " 的 " + x.material_name, onchange: event => {
          if (event.target.checked) selected.add(x.id); else selected.delete(x.id);
          count.textContent = "已选 " + selected.size + " 份";
        } }) : null),
        make("td", { text: x.student_name || String(x.student_id) }),
        make("td", { text: x.material_name }),
        make("td", {}, make("a", { href: "/api/checks/" + x.id + "/file", text: x.filename })),
        make("td", {}, make("span", { className: "review-pill " + (x.review_status === "已通过" ? "approved" : x.review_status === "退回修改" ? "returned" : ""), text: x.review_status || "待审阅", title: x.review_note || "" })),
        make("td", { text: x.checked_at })))));
    const note = field("退回修改说明", "reviewNote", "text", false);
    const review = async status => {
      if (!selected.size) return feedback(tools, "请先选择待审阅材料");
      if (status === "退回修改" && !note.querySelector("input").value.trim()) return feedback(tools, "请填写退回修改说明");
      if (!confirm("确认将 " + selected.size + " 份材料标记为「" + status + "」？")) return;
      try {
        const result = await post("/api/admin/checks/bulk-review", { checkIds: [...selected], status, note: note.querySelector("input").value });
        alert("已审阅 " + result.count + " 份材料，学生将收到站内通知。");
        render();
      } catch (error) { feedback(tools, error.message); }
    };
    const tools = make("div", { className: "bulk-tools" }, count,
      button("批量通过", () => review("已通过")), note,
      button("批量退回", () => review("退回修改"), "secondary"));
    shell.replaceChildren(pageHead("STAFF / DOCUMENTS", "已提交文件", "按权限查看并下载学生提交的材料。"),
      panel(make("div", { className: "panel-head" }, make("h2", { text: "学生提交记录" }), make("span", { className: "small", text: "待审阅 " + checks.length + " / 共 " + data.checks.length + " 条" })),
        data.checks.length ? tools : null,
        data.checks.length ? tableWrap(table) : make("div", { className: "empty-state" }, make("strong", { text: "暂无质检记录" }), "学生上传材料后会在这里显示。")));
  } catch (error) { shell.replaceChildren(pageHead("STAFF / DOCUMENTS", "已提交文件"), notice(error.message, "error")); } })();
  return shell;
}

function formsPage() {
  const shell = make("div", { className: "view view-forms" }, pageHead("LIBRARY / DOWNLOADS", "资料下载", "按培养阶段查找和下载所需表格。"), notice("正在读取表格…"));
  (async () => { try {
    const data = await api("/api/forms");
    const upload = isStaffUser() ? make("form", { className: "form-grid form-upload" },
      select("所属阶段", "stageSlug", data.stages.map(stage => [stage.slug, stage.name])),
      field("表格名称", "title"),
      field("文件（DOC / DOCX / XLS / XLSX / PDF，最大 10 MB）", "file", "file"),
      make("button", { className: "btn", type: "submit", text: "上传院系表格" })) : null;
    if (upload) {
      upload.querySelector("[name=file]").setAttribute("accept", ".doc,.docx,.xls,.xlsx,.pdf");
      upload.addEventListener("submit", async event => {
        event.preventDefault();
        const release = busy(upload);
        try {
          const file = upload.querySelector("[name=file]").files[0];
          if (!file || file.size > 10 * 1024 * 1024) throw new Error("请选择不超过 10 MB 的表格文件");
          await api("/api/forms", { method: "POST", body: new FormData(upload) });
          render();
        } catch (error) { feedback(upload, error.message); }
        finally { release(); }
      });
    }
    const stages = data.stages.map(stage => {
      const uploaded = data.forms.filter(item => item.stage_slug === stage.slug).map(item =>
        make("li", { className: "form-item" },
          make("div", {}, make("strong", { text: item.title }), make("span", { className: "small", text: item.department_id ? "院系提供 · " + item.filename : "平台提供 · " + item.filename })),
          make("a", { className: "secondary", href: "/api/forms/" + item.id + "/file", text: "下载文件 ↓" })));
      const official = officialForms.filter(item => item.stage === stage.slug).map(item => {
        const actions = make("div", { className: "form-actions" },
          make("a", { className: "secondary", href: item.url, target: "_blank", rel: "noopener noreferrer", text: "下载原件 ↗" }),
          make("a", { className: "text-link small", href: item.source, target: "_blank", rel: "noopener noreferrer", text: "来源" }));
        return make("li", { className: "form-item" },
          make("div", {}, make("strong", { text: item.title }), make("span", { className: "small", text: "中国民航大学党委组织部 · " + item.filename })), actions);
      });
      return panel(make("div", { className: "panel-head" }, make("h2", { text: stage.position.toString().padStart(2, "0") + " / " + stage.name }),
        make("span", { className: "small", text: uploaded.length + official.length + " 份文件" })),
        uploaded.length + official.length ? make("ul", { className: "form-list" }, uploaded, official) :
          make("div", { className: "empty-state" }, make("strong", { text: "暂无电子表格" }), "请向辅导员确认纸质材料或等待院系上传。"));
    });
    shell.replaceChildren(pageHead("LIBRARY / DOWNLOADS", "资料下载", "按培养阶段查找和下载所需表格。"),
      notice("学校组织部公开附件的版本可能早于现行要求；填写前请与辅导员确认使用版本。"),
      ...(upload ? [panel(make("div", { className: "panel-head" }, make("h2", { text: me.role === "admin" ? "上传全校通用表格" : "上传本院系表格" })), upload)] : []),
      ...stages);
  } catch (error) { shell.replaceChildren(pageHead("LIBRARY / DOWNLOADS", "资料下载"), notice(error.message, "error")); } })();
  return shell;
}
const isStaffUser = () => me?.role === "admin" || me?.role === "counselor";

function adminPage() {
  const adminTitle = me.role === "admin" ? "管理员控制台" : "辅导员控制台";
  const adminCode = me.role === "admin" ? "ADMIN / CONSOLE" : "COUNSELOR / CONSOLE";
  const shell = make("div", { className: "view view-admin" }, pageHead(adminCode, adminTitle, "管理学生档案、辅导员与培养进度。"), notice("正在读取数据…"));
  (async () => { try {
    const data = await api("/api/admin/dashboard");
    const departmentChoices = data.departments.map(x => [x.id, x.name]);
    let needsDepartment = me.role === "admin" && departmentChoices.length === 0;
    const inviteForm = make("form", { className: "inline-form" },
      needsDepartment ? field("新院系名称", "departmentName") : select("院系", "departmentId", departmentChoices, me.department_id || departmentChoices[0]?.[0]),
      select("角色", "role", [["counselor", "辅导员"]]),
      field("邀请数量（1–50）", "count", "number", true, "1"),
      make("button", { className: "btn", type: "submit", text: needsDepartment ? "创建院系并生成邀请码" : "生成邀请码" }));
    const countInput = inviteForm.querySelector("[name=count]");
    countInput.min = "1"; countInput.max = "50";
    const inviteOutput = make("div", { className: "muted invite-output", text: needsDepartment ? "尚未设置院系。输入真实院系名称后，即可生成第一个邀请码。" : "邀请码仅显示一次，有效期 7 天。" });
    inviteForm.addEventListener("submit", async event => {
      event.preventDefault();
      const release = busy(inviteForm);
      try {
        const values = formData(inviteForm);
        if (needsDepartment) {
          const created = await post("/api/admin/departments", { name: values.departmentName.trim() });
          values.departmentId = created.departmentId;
          const selector = select("院系", "departmentId", [[values.departmentId, values.departmentName.trim()]], values.departmentId);
          inviteForm.querySelector("[name=departmentName]").closest(".field").replaceWith(selector);
          inviteForm.querySelector("[type=submit]").textContent = "生成邀请码";
          needsDepartment = false;
        }
        const result = await post("/api/admin/invites", values);
        inviteOutput.replaceChildren("已生成 " + result.codes.length + " 个邀请码，有效期 7 天。请逐一通过可信渠道发送给受邀人。",
          make("textarea", { className: "invite-codes", readOnly: "", "aria-label": "本次生成的邀请码", text: result.codes.join("\n") }),
          button("复制全部邀请码", async () => { await navigator.clipboard.writeText(result.codes.join("\n")); }, "secondary"));
      } catch (error) { feedback(inviteForm, error.message); }
      finally { release(); }
    });
    const departmentForm = make("form", { className: "inline-form" },
      field("新院系名称", "name"), make("button", { className: "btn", type: "submit", text: "添加院系" }));
    departmentForm.addEventListener("submit", async event => {
      event.preventDefault();
      try { await post("/api/admin/departments", formData(departmentForm)); render(); }
      catch (error) { feedback(departmentForm, error.message); }
    });
    const canAddStudent = me.role === "counselor" || departmentChoices.length > 0;
    const addStudentForm = canAddStudent ? make("form", { className: "inline-form" },
      field("姓名", "name"), field("学号", "studentNo", "text"),
      me.role === "admin" ? select("院系", "departmentId", departmentChoices, departmentChoices[0]?.[0]) : null,
      make("button", { className: "btn", type: "submit", text: "添加学生" })) : null;
    if (addStudentForm) addStudentForm.addEventListener("submit", async event => {
      event.preventDefault();
      const release = busy(addStudentForm);
      try {
        await post("/api/admin/students", formData(addStudentForm));
        feedback(addStudentForm, "学生已添加，初始密码 cauc+学号。", "success");
        render();
      } catch (error) { feedback(addStudentForm, error.message); }
      finally { release(); }
    });
    const addCounselorForm = (me.role === "admin" && departmentChoices.length) ? make("form", { className: "inline-form" },
      field("姓名", "name"), field("用户名", "username", "text"),
      select("院系", "departmentId", departmentChoices, departmentChoices[0]?.[0]),
      make("button", { className: "btn", type: "submit", text: "添加辅导员" })) : null;
    if (addCounselorForm) addCounselorForm.addEventListener("submit", async event => {
      event.preventDefault();
      const release = busy(addCounselorForm);
      try {
        await post("/api/admin/counselors", formData(addCounselorForm));
        feedback(addCounselorForm, "辅导员已添加，初始密码 cauc+用户名。", "success");
        render();
      } catch (error) { feedback(addCounselorForm, error.message); }
      finally { release(); }
    });
    const selectedStudents = new Set();
    const studentCount = make("span", { className: "bulk-count", text: "已选 0 人" });
    const students = make("table", { className: "data" },
      make("thead", {}, make("tr", {}, make("th", { className: "bulk-select" }, make("input", { type: "checkbox", "aria-label": "选择全部学生", onchange: event => {
        students.querySelectorAll("tbody input[type=checkbox]").forEach(box => { box.checked = event.target.checked; box.dispatchEvent(new Event("change")); });
      } })), ["学号", "姓名", "院系", "当前节点", "操作"].map(x => make("th", { text: x })))),
      make("tbody", {}, data.students.map(student => make("tr", {},
        make("td", { className: "bulk-select" }, make("input", { type: "checkbox", value: student.id, "aria-label": "选择 " + student.name, onchange: event => {
          if (event.target.checked) selectedStudents.add(student.id); else selectedStudents.delete(student.id);
          studentCount.textContent = "已选 " + selectedStudents.size + " 人";
        } })),
        make("td", { text: student.student_no }), make("td", { text: student.name }),
        make("td", { text: student.department || "" }),
        make("td", { text: data.nodes.find(x => x.slug === student.current_node_slug)?.name || "" }),
        make("td", {}, button("管理", () => showStudent(student, data), "secondary"),
          button("删除", async () => {
            if (!confirm("确认删除学生 " + student.name + "（学号 " + student.student_no + "）？此操作不可恢复。")) return;
            try { await post("/api/admin/students/bulk-delete", { studentIds: [student.id] }); render(); }
            catch (error) { alert(error.message); }
          }, "secondary"))))));
    const counselorsTable = make("table", { className: "data" },
      make("thead", {}, make("tr", {}, ["姓名", "用户名", "院系", "操作"].map(x => make("th", { text: x })))),
      make("tbody", {}, data.counselors.map(counselor => make("tr", {},
        make("td", { text: counselor.name || "—" }),
        make("td", { text: counselor.username }),
        make("td", { text: counselor.department || "" }),
        make("td", {}, button("删除", async () => {
          if (!confirm("确认删除辅导员 " + (counselor.name || counselor.username) + "？其上传的表格也会一并删除。此操作不可恢复。")) return;
          try { await post("/api/admin/counselors/bulk-delete", { usernames: [counselor.username] }); render(); }
          catch (error) { alert(error.message); }
        }, "secondary"))))));
    const bulkAction = async action => {
      if (!selectedStudents.size) return feedback(bulkTools, "请先选择学生");
      if (selectedStudents.size > 20) return feedback(bulkTools, "每次最多处理 20 名学生");
      if (action === "advance" && !confirm("确认将所选 " + selectedStudents.size + " 名学生推进至下一培养阶段？")) return;
      if (action === "delete" && prompt("将永久删除所选 " + selectedStudents.size + " 名学生的账号、档案、材料和对话。请输入“删除”确认：") !== "删除") return;
      try {
        const result = await post("/api/admin/students/bulk-" + action, { studentIds: [...selectedStudents] });
        alert("已" + (action === "delete" ? "删除" : "推进") + " " + result.count + " 名学生。" + (result.cleanupFailed ? "有 " + result.cleanupFailed + " 份文件清理失败，已记录到服务器日志。" : ""));
        render();
      } catch (error) { feedback(bulkTools, error.message); }
    };
    const bulkTools = make("div", { className: "bulk-tools" }, studentCount,
      button("批量推进下一阶段", () => bulkAction("advance")),
      button("批量删除账号", () => bulkAction("delete"), "secondary"));
    const metrics = make("div", { className: "metric-grid" },
      metric("学生档案", String(data.students.length), "当前可管理的学生"),
      ...(me.role === "admin" ? [metric("辅导员", String(data.counselors.length), "已注册辅导员")] : []),
      metric("院系", String(data.departments.length), "已配置院系"),
      ...(me.role === "admin" ? [metric("有效邀请", String(data.invites.filter(x => x.role === "counselor" && !x.used_by && new Date(x.expires_at) > new Date()).length), "未使用的辅导员邀请码", true)] : []));
    shell.replaceChildren(pageHead(adminCode, adminTitle, "管理学生档案、辅导员与培养进度。"),
      metrics,
      ...(addStudentForm ? [panel(make("div", { className: "panel-head" }, make("h2", { text: "手动添加学生" }), make("span", { className: "small", text: "单独添加一名学生，初始密码 cauc+学号。" })), addStudentForm)] : []),
      ...(me.role === "admin" ? [
        ...(addCounselorForm ? [panel(make("div", { className: "panel-head" }, make("h2", { text: "手动添加辅导员" }), make("span", { className: "small", text: "单独添加一名辅导员，初始密码 cauc+用户名。" })), addCounselorForm)] : []),
        panel(make("div", { className: "panel-head" }, make("h2", { text: "辅导员管理" }), make("span", { className: "small", text: "共 " + data.counselors.length + " 人 · 批量增删请用右下角办公助理" })),
          data.counselors.length ? tableWrap(counselorsTable) : make("div", { className: "empty-state" }, make("strong", { text: "尚无辅导员" }), "可手动添加，或打开办公助理批量添加。"))
      ] : []),
      ...(me.role === "admin" && !needsDepartment ? [panel(make("div", { className: "panel-head" }, make("h2", { text: "院系设置" })), departmentForm)] : []),
      ...(me.role === "admin" ? [panel(make("div", { className: "panel-head" }, make("h2", { text: "邀请辅导员" })), inviteForm, inviteOutput)] : []),
      panel(make("div", { className: "panel-head" }, make("h2", { text: "学生档案" }), make("span", { className: "small", text: "共 " + data.students.length + " 人" })),
        data.students.length ? bulkTools : null,
        data.students.length ? tableWrap(students) : make("div", { className: "empty-state" }, make("strong", { text: "尚无学生" }), "打开办公助理上传入围名单，或在上方手动添加。")));
  } catch (error) { shell.replaceChildren(pageHead(adminCode, adminTitle), notice(error.message, "error")); } })();
  return shell;
}
function showStudent(student, data) {
  const wrap = make("div", { className: "view view-student-detail" },
    pageHead("STAFF / STUDENT PROFILE", student.name + "的档案", "学号 " + student.student_no + " · " + student.department),
    button("← 返回工作台", () => navigate("admin"), "secondary"));
  const profileForm = make("form", { className: "form-grid" },
    me.role === "admin" ? select("院系", "departmentId", data.departments.map(x => [x.id, x.name]), student.department_id) : field("院系", "departmentName", "text", false, student.department || ""),
    field("专业", "major", "text", false, student.major || ""),
    field("年级", "grade", "text", false, student.grade || ""),
    field("联系电话", "phone", "tel", false, student.phone || ""),
    field("申请入党日期", "appliedAt", "date", false, student.applied_at || ""),
    make("button", { className: "btn", type: "submit", text: "保存基本资料" }));
  if (me.role !== "admin") profileForm.querySelector("[name=departmentName]").disabled = true;
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
        make("td", { text: file.checked_at })))));
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
