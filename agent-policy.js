import { OFFICE_ACTIONS } from "./office-agent.js";
import { STUDENT_ACTIONS } from "./mentor-actions.js";

// PDP: a small, deterministic policy for the agent-facing capabilities.
// Resource ownership and department/grade scope are checked again where records are loaded.
const roles = new Set(["guest", "student", "counselor", "admin"]);
const staff = new Set(["counselor", "admin"]);
const studentActions = STUDENT_ACTIONS;
const officeActions = OFFICE_ACTIONS;
const adminOnly = new Set(["register_counselors", "delete_counselors", "create_invites", "create_department", "create_grade", "create_major"]);

const allow = () => ({ allowed: true, reason: "allowed" });
const deny = reason => ({ allowed: false, reason });

export function decideAgentPolicy({ role = "guest", capability, action = "", actorId = null, targetUserId = null }) {
  if (!roles.has(role)) return deny("unknown_role");
  if (capability === "mentor.public") return allow();
  if (capability === "mentor.personal" || capability === "mentor.review") {
    return role === "student" && actorId != null ? allow() : deny("student_login_required");
  }
  if (capability === "student.agent") return role === "student" && actorId != null ? allow() : deny("student_only");
  if (capability === "student.tool") {
    if (role !== "student" || actorId == null) return deny("student_only");
    if (!studentActions.has(action)) return deny("tool_not_allowed");
    return targetUserId == null || targetUserId === actorId ? allow() : deny("not_owner");
  }
  if (capability === "office.agent") return staff.has(role) && actorId != null ? allow() : deny("staff_only");
  if (capability === "office.tool") {
    if (!staff.has(role) || actorId == null) return deny("staff_only");
    if (!officeActions.has(action)) return deny("tool_not_allowed");
    return adminOnly.has(action) && role !== "admin" ? deny("admin_only") : allow();
  }
  return deny("unknown_capability");
}

// A deterministic data-intent guard before calling the classifier/model.
// It only marks requests for a *specific account's* records, not general process questions.
export function protectedMentorIntent(question) {
  const value = String(question ?? "").replace(/\s+/g, " ").slice(0, 500);
  return /(?:我的|本人|我现在|我目前).{0,20}(?:姓名|学号|档案|当前阶段|培养阶段|培养节点|材料状态|已交|未交|提交记录|通知)/.test(value)
    || /(?:我|本人).{0,8}(?:交了哪些|提交了哪些|还缺哪些|处于(?:什么|哪个|哪一)阶段|在哪个阶段|处于哪个入党阶段)/.test(value)
    || /(?:我的|本人).{0,12}(?:入党进度|培养进度|提交情况|材料完成情况)/.test(value)
    || /(?:其他同学|别的学生|他人的).{0,20}(?:档案|学号|材料|进度|通知)/.test(value);
}
