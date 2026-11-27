export async function watermarkIdentity(user, secret) {
  if (!secret || secret.length < 32) throw new Error("水印签名密钥未配置");
  const id = Number(user.id).toString(16).toUpperCase().padStart(6, "0");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("watermark:v1:" + id)));
  const signature = Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("").slice(0, 12).toUpperCase();
  return { code: "WM-" + id + "-" + signature, name: user.name || user.username, major: user.major_name || user.major || "专业未填写" };
}

export function watermarkUserId(code) {
  const match = /^WM-([0-9A-F]{6,12})-([0-9A-F]{12})$/.exec(String(code).trim().toUpperCase());
  return match ? parseInt(match[1], 16) : null;
}
