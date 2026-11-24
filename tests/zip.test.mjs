import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { expandZip, zipMaxEntries } from "../frontend/zip.js";

async function makeZip(entries) {
  const zip = new JSZip();
  for (const [name, content] of entries) zip.file(name, content);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return new File([buf], "打包.zip");
}

test("zip 解包出常规文件，跳过不支持的类型", async () => {
  const file = await makeZip([
    ["01-入党申请书.docx", "PK fake docx bytes"],
    ["02-思想汇报.pdf", "%PDF-1.4 fake"],
    ["说明.txt", " plain text "],
    ["恶意.exe", "MZ not allowed"]
  ]);
  const { files, skipped } = await expandZip(file);
  assert.deepEqual(files.map(item => item.name), ["01-入党申请书.docx", "02-思想汇报.pdf", "说明.txt"]);
  assert.deepEqual(skipped, ["恶意.exe"]);
});

test("zip 内文件夹同名文件用父目录去重，macOS 垃圾条目被过滤", async () => {
  const file = await makeZip([
    ["阶段一/模板.docx", "a"],
    ["阶段二/模板.docx", "b"],
    ["__MACOSX/._模板.docx", "junk"],
    [".hidden/x.docx", "junk"]
  ]);
  const { files, skipped } = await expandZip(file);
  assert.deepEqual(files.map(item => item.name).sort(), ["阶段一-模板.docx", "阶段二-模板.docx"].sort());
  assert.equal(skipped.length, 0);
});

test("空压缩包与超大条目数被拒绝", async () => {
  const empty = await makeZip([]);
  await assert.rejects(() => expandZip(empty), /没有任何文件/);
  const many = await makeZip(Array.from({ length: zipMaxEntries + 1 }, (_, i) => ["f" + i + ".txt", "x"]));
  await assert.rejects(() => expandZip(many), /单次最多/);
});

test("非 zip 内容给出友好错误", async () => {
  await assert.rejects(() => expandZip(new File(["not a zip"], "坏.zip")), /有效的 ZIP/);
});
