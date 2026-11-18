import JSZip from "jszip";

const maxBytes = 10 * 1024 * 1024;
const maxText = 20000;
const wordNs = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export async function extractReviewText(file, minimumTextLength = 20) {
  if (!file || file.size < 10 || file.size > maxBytes) throw new Error("请选择不超过 10 MB 的 Word DOCX 或 PDF 文件");
  if (/\.doc$/i.test(file.name)) throw new Error("旧版 .doc 暂不能可靠读取，请在 Word 中另存为 .docx 后上传");
  const isWord = /\.docx$/i.test(file.name);
  const isPdf = /\.pdf$/i.test(file.name);
  if (!isWord && !isPdf) throw new Error("只支持 Word DOCX 或 PDF 文件");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isWord && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error("Word 文件格式无效");
  if (isPdf && new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("PDF 文件格式无效");
  const content = isWord ? await readDocx(bytes) : await readPdf(bytes);
  const text = content.replace(/\u0000/g, "").trim();
  if (text.length < minimumTextLength) throw new Error("未能提取足够文字；扫描版 PDF 请先转为可搜索 PDF 或 DOCX");
  if (text.length > maxText) throw new Error("文档文字超过 20000 字，请拆分后检查");
  return text;
}

async function readDocx(bytes) {
  let zip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw new Error("Word 文件无法读取"); }
  if (Object.keys(zip.files).length > 2000) throw new Error("Word 文件内部项目过多");
  const entry = zip.file("word/document.xml");
  if (!entry || entry._data?.uncompressedSize > 2 * 1024 * 1024) throw new Error("Word 正文缺失或过大");
  const xml = new DOMParser().parseFromString(await entry.async("string"), "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Word 正文无法解析");
  const paragraphs = Array.from(xml.getElementsByTagNameNS(wordNs, "p"));
  return paragraphs.map(paragraph => Array.from(paragraph.getElementsByTagNameNS(wordNs, "t"), node => node.textContent).join("")).filter(Boolean).join("\n");
}

async function readPdf(bytes) {
  const pdfjs = await import("/pdf.min.js");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  const task = pdfjs.getDocument({ data: bytes });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 30) throw new Error("PDF 超过 30 页，请拆分后检查");
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join(""));
      if (pages.join("\n").length > maxText) throw new Error("PDF 文字超过 20000 字，请拆分后检查");
    }
    return pages.join("\n");
  } catch (error) {
    if (error.message?.includes("超过")) throw error;
    throw new Error("PDF 无法读取；请检查文件是否加密或为扫描件");
  } finally { await task.destroy(); }
}
