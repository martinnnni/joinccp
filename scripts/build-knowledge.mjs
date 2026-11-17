import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["流程图.md", "材料清单.md", "填写规范.md", "系统使用指南.md"];
const chunks = [];

for (const file of files) {
  const markdown = readFileSync(resolve(root, "knowledge", file), "utf8").replace(/\r\n/g, "\n").trim();
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || file.replace(/\.md$/, "");
  const sections = markdown.split(/(?=^##\s+)/m);
  for (const section of sections) {
    const text = section.trim();
    if (!text) continue;
    const heading = /^##\s+(.+)$/m.exec(text)?.[1]?.trim() || "概述";
    chunks.push({ id: `${file.replace(/\.md$/, "")}-${chunks.length + 1}`, file, title, section: heading, text });
  }
}

if (chunks.length < 12 || chunks.some(chunk => chunk.text.length > 2500)) {
  throw new Error("知识库分段异常，请检查 Markdown 标题和段落长度");
}

writeFileSync(resolve(root, "knowledge.generated.js"),
  `// 由 scripts/build-knowledge.mjs 生成；请编辑 knowledge/*.md。\nexport const KNOWLEDGE = ${JSON.stringify(chunks, null, 2)};\n`);
console.log(`知识库：${files.length} 份文件，${chunks.length} 个片段`);
