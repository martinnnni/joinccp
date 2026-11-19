export const maxFileBytes = 10 * 1024 * 1024;
export const maxBatchBytes = 30 * 1024 * 1024;

const types = {
  doc: ["application/msword", /^d0cf11e0a1b11ae1/],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", /^504b0304/],
  xls: ["application/vnd.ms-excel", /^d0cf11e0a1b11ae1/],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", /^504b0304/],
  pdf: ["application/pdf", /^255044462d/],
  jpg: ["image/jpeg", /^ffd8ff/],
  png: ["image/png", /^89504e470d0a1a0a/],
  webp: ["image/webp", /^52494646.{8}57454250/],
  gif: ["image/gif", /^474946383[79]61/],
  heic: ["image/heic", /^.{8}66747970(?:68656963|68656978|68657663|68657678|6d696631|6d736631)/],
  heif: ["image/heif", /^.{8}66747970(?:68656963|68656978|68657663|68657678|6d696631|6d736631)/]
};
const imageExtensions = ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"];
const materialExtensions = ["doc", "docx", "pdf", ...imageExtensions];
const formExtensions = [...materialExtensions, "xls", "xlsx"];

export function fileExtension(name) {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() || "";
}

export function uploadType(name, forms = false) {
  const ext = fileExtension(name);
  if (!(forms ? formExtensions : materialExtensions).includes(ext)) return null;
  const [mime, signature] = types[ext === "jpeg" ? "jpg" : ext];
  return { ext, mime, signature };
}

export function attachmentName(file, forms = false) {
  const original = file.name.trim() || "附件";
  if (uploadType(original, forms) || (forms && /\.(csv|txt)$/i.test(original))) {
    const suffix = "." + fileExtension(original);
    return original.length <= 150 ? original : original.slice(0, 150 - suffix.length) + suffix;
  }
  const ext = Object.keys(types).find(ext => types[ext][0] === file.type);
  const name = ext ? original.slice(0, 149 - ext.length) + "." + ext : original;
  return uploadType(name, forms) ? name : original;
}

export function normalizedAttachment(file, forms = false) {
  const name = attachmentName(file, forms);
  return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
}

export const materialAccept = [...materialExtensions.map(ext => "." + ext), ...new Set(materialExtensions.map(ext => uploadType("." + ext).mime))].join(",");
export const officeAccept = materialAccept + ",.xls,.xlsx,.csv,.txt";

export async function matchesUploadType(file, type) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const header = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return type.signature.test(header);
}
