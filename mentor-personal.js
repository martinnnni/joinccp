const personalPattern = /(?:我的|我现在|我目前|我|本人|自己|个人).{0,18}(?:姓名|学号|阶段|节点|档案|进度|材料|交|提交|下一步|准备|做什么|叫什么)|(?:姓名|学号|已交|未交|没交|交了哪些|交过哪些|完成情况|我的档案)/;
const materialPattern = /材料|已交|未交|没交|提交|交了|交过|完成|进度|下一步|准备|做什么/;
const siteWords = /系统|平台|网站|页面|功能|站内|资料下载|材料提交|成长导师|通知中心|账号|注册|登录|密码/;
const helpWords = /如何|怎么|在哪|哪里|操作|使用|下载|上传|提交|查看|修改|进入|找到|做|办/;

export function isPersonalQuestion(question) {
  return personalPattern.test(String(question));
}

export function isSiteHelpQuestion(question) {
  const value = String(question);
  return siteWords.test(value) && helpWords.test(value);
}

// 用户身份问法（"我是谁 / 谁是我 / 我叫什么 / 我的姓名"）——与机器人身份 isIdentityQuestion 区分开。
const selfIdentityPattern = /我是谁|谁是我|我叫(?:什么|啥|啥名|什么名|什么名字|啥名字)|我的(?:名字|姓名|学号|身份|信息|资料)|我(?:到底|究竟)?是谁|我是(?:哪个|谁|哪一位|什么人)/;
const selfIdentityPatternEn = /who am i|who i am|what(?:'s| is) my (?:name|id|student number|number|identity|info)|what am i called|tell me who i am|do you know who i am|who is me/i;
export function isSelfIdentityQuestion(question) {
  return selfIdentityPattern.test(String(question)) || selfIdentityPatternEn.test(String(question));
}
// 判断问题是否含中文（用于确定性回答与检索策略）。
export function isChineseQuestion(question) {
  return /[\u4e00-\u9fff]/.test(String(question));
}

const safe = (value, limit = 80) => String(value ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, limit) || "未填写";

export function personalMatches(question, user, rows = [], nodeName = "") {
  if (!isPersonalQuestion(question)) return [];
  const current = rows.filter(row => row.stage_slug === user.current_stage_slug);
  const stageName = current[0]?.stage_name || "未设置";
  const profile = {
    id: "personal-profile", title: "我的实时档案", section: "当前登录学生", file: "个人档案（实时）",
    text: `当前登录学生的档案记录：姓名：${safe(user.name)}；学号：${safe(user.student_no)}；当前入党阶段：${safe(stageName)}；当前节点：${safe(nodeName)}。这些字段由当前登录学生的档案读取；如信息有误，请联系辅导员。`,
    score: 100, similarity: 1
  };
  if (!materialPattern.test(String(question))) return [profile];
  const recorded = rows.filter(row => row.status === "已交" || row.status === "已通过");
  const missing = current.filter(row => row.status !== "已交" && row.status !== "已通过");
  const list = (items, describe) => items.length ? items.map(row => `${safe(row.stage_name)}－${safe(row.name)}（${describe(row)}）`).join("；") : "无";
  const materials = {
    id: "personal-materials", title: "我的材料状态", section: "实时记录", file: "材料状态（实时）",
    text: `当前登录学生的实时材料记录。当前阶段「${safe(stageName)}」未交材料：${list(missing, () => "未交")}。本阶段共 ${current.length} 项，已交或已通过 ${current.length - missing.length} 项。系统记录为已交或已通过的材料（各阶段）：${list(recorded, row => row.status + (row.r2_key ? "，有上传文件" : "，无上传文件记录"))}。未来阶段材料不算当前欠交。系统状态可能由辅导员手动维护；「已交」不必然表示有上传文件。如记录不符，请联系辅导员核对。`,
    score: 100, similarity: 1
  };
  return [profile, materials];
}
