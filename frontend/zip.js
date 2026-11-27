// frontend/zip.js — 办公助理 ZIP 解包（浏览器/Node 通用，纯逻辑可单测）
// 解压全程在本机完成，压缩包不离开设备。
import JSZip from "jszip";
import { maxBatchBytes, maxFileBytes, uploadType } from "../upload-types.js";

export const zipMaxEntries = 30;

const usable = name => {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() || "";
  return uploadType(name, true) || ext === "csv" || ext === "txt";
};

// 返回 { files: File[], skipped: string[] }；不合法时抛错。
export async function expandZip(file) {
  if (file.size > maxBatchBytes) throw new Error("压缩包「" + file.name + "」超过 30 MB，请分批处理。");
  const zip = await JSZip.loadAsync(file).catch(() => { throw new Error("无法读取压缩包「" + file.name + "」，请确认是有效的 ZIP 文件。"); });
  const entries = Object.values(zip.files).filter(entry => !entry.dir && !entry.name.split("/").some(part => part.startsWith(".") || part === "__MACOSX"));
  if (!entries.length) throw new Error("压缩包「" + file.name + "」里没有任何文件。");
  if (entries.length > zipMaxEntries) throw new Error("压缩包「" + file.name + "」内有 " + entries.length + " 份文件，单次最多 " + zipMaxEntries + " 份，请拆分后再传。");
  const used = new Set(), files = [], skipped = [];
  const baseCount = new Map();
  for (const entry of entries) {
    const base = (entry.name.split("/").pop() || entry.name).toLowerCase();
    baseCount.set(base, (baseCount.get(base) || 0) + 1);
  }
  for (const entry of entries) {
    const base = entry.name.split("/").pop() || entry.name;
    let name = base;
    // 同名文件全部带上父目录前缀，避免第一份裸名、后续才加前缀的不一致
    if (baseCount.get(base.toLowerCase()) > 1) {
      const parent = entry.name.split("/").slice(-2, -1)[0];
      if (parent) name = parent + "-" + base;
    }
    if (used.has(name.toLowerCase())) { skipped.push(base + "（重名）"); continue; }
    const item = new File([await entry.async("blob")], name);
    if (!usable(item.name) || item.size < 1 || item.size > maxFileBytes) { skipped.push(base); continue; }
    used.add(name.toLowerCase());
    files.push(item);
  }
  return { files, skipped };
}
