import JSZip from "jszip";
import { extractReviewText } from "./file-text.js";

const namePattern = /^[\p{Script=Han}·]{2,20}$/u;
const numberPattern = /^\d{6,20}$/;

export function parseRosterText(text) {
  const lines = String(text || "").replace(/\r/g, "\n").split(/\n+/).map(line => line.trim()).filter(Boolean);
  const rows = [], seen = new Set(), issues = [];
  const add = (name, studentNo, line) => {
    if (!namePattern.test(name) || !numberPattern.test(studentNo)) return false;
    if (seen.has(studentNo)) issues.push("重复学号 " + studentNo + "（第 " + line + " 行）");
    else { seen.add(studentNo); rows.push({ name, studentNo }); }
    return true;
  };
  for (let index = 0; index < lines.length; index++) {
    const parts = lines[index].replace(/["“”]/g, "").split(/[\t,，;；|\s]+/).filter(Boolean);
    let matched = false;
    for (let i = 0; i < parts.length - 1; i++) {
      if (add(parts[i], parts[i + 1], index + 1) || add(parts[i + 1], parts[i], index + 1)) { matched = true; i++; }
    }
    if (!matched && parts.length === 1 && index + 1 < lines.length) {
      const next = lines[index + 1].replace(/["“”]/g, "").trim();
      if (add(parts[0], next, index + 1) || add(next, parts[0], index + 1)) { matched = true; index++; }
    }
    if (!matched && /\d{6,20}/.test(lines[index])) issues.push("第 " + (index + 1) + " 行未能确认姓名与学号：" + lines[index].slice(0, 60));
  }
  return { rows, issues };
}

export async function extractRosterText(file) {
  if (!file || file.size < 1 || file.size > 10 * 1024 * 1024) throw new Error("请选择不超过 10 MB 的名单文件");
  if (/\.(docx|pdf)$/i.test(file.name)) return extractReviewText(file, 2);
  if (/\.(csv|txt)$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text = new TextDecoder("utf-8").decode(bytes);
    if (text.includes("\ufffd")) text = new TextDecoder("gb18030").decode(bytes);
    return text.slice(0, 100000);
  }
  if (!/\.xlsx$/i.test(file.name)) throw new Error("名单支持 XLSX、CSV、TXT、DOCX 或可搜索 PDF");
  let zip;
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()); }
  catch { throw new Error("Excel 文件无法读取"); }
  if (Object.keys(zip.files).length > 2000) throw new Error("Excel 文件内部项目过多");
  const sheet = zip.file("xl/worksheets/sheet1.xml");
  if (!sheet || sheet._data?.uncompressedSize > 2 * 1024 * 1024) throw new Error("请将名单放在 Excel 第一个工作表");
  const parseXml = xml => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Excel 内容无法解析");
    return doc;
  };
  const sharedEntry = zip.file("xl/sharedStrings.xml");
  const shared = sharedEntry ? Array.from(parseXml(await sharedEntry.async("string")).getElementsByTagName("si"), item =>
    Array.from(item.getElementsByTagName("t"), node => node.textContent).join("")) : [];
  const doc = parseXml(await sheet.async("string"));
  return Array.from(doc.getElementsByTagName("row"), row => Array.from(row.getElementsByTagName("c"), cell => {
    const value = cell.getElementsByTagName("v")[0]?.textContent || "";
    return cell.getAttribute("t") === "s" ? (shared[Number(value)] || "") :
      cell.getAttribute("t") === "inlineStr" ? Array.from(cell.getElementsByTagName("t"), node => node.textContent).join("") : value;
  }).join("\t")).join("\n").slice(0, 100000);
}
