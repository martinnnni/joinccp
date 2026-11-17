export function isCurrentTimeQuestion(question) {
  const value = String(question).replace(/\s+/g, "");
  if (/培养|材料|阶段|节点|申请|谈话|考察|流程|提交|截止|时限|期限|规定|要求|多久/.test(value)) return false;
  return /(?:现在|当前|目前|此刻|此时|今天|今日|今年).{0,10}(?:时间|日期|几点|几时|几号|几月|几日|哪年|哪一年|年份|星期|周几|北京时间)/.test(value)
    || /(?:几点|几时|几号|星期几|周几|北京时间).{0,6}(?:了|现在|今天|当前|是多少|是什么|？|\?)*$/.test(value)
    || /^(?:现在时间|当前时间|今天日期|今日日期)[？?]?$/.test(value);
}

export function getCurrentTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type)?.value || "";
  return `现在北京时间是 ${value("year")} 年 ${value("month")} 月 ${value("day")} 日 ${value("weekday")} ${value("hour")}:${value("minute")}:${value("second")}。`;
}
