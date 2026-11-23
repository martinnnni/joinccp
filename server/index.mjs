import { createServer } from "node:http";
import { Readable } from "node:stream";
import worker from "../worker.js";
import { createRuntime } from "./runtime.mjs";

const { env, db } = createRuntime();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";

function requestUrl(request) {
  const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwarded === "https" ? "https" : "http";
  return `${protocol}://${request.headers.host || `${host}:${port}`}${request.url}`;
}

async function respond(nodeResponse, response, headOnly = false) {
  for (const [name, value] of response.headers) if (name !== "set-cookie") nodeResponse.setHeader(name, value);
  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length) nodeResponse.setHeader("set-cookie", cookies);
  nodeResponse.setHeader("content-security-policy", csp);
  nodeResponse.writeHead(response.status);
  if (headOnly) {
    await response.body?.cancel();
    return nodeResponse.end();
  }
  if (!response.body) return nodeResponse.end();
  Readable.fromWeb(response.body).pipe(nodeResponse);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
      else if (value !== undefined) headers.set(name, value);
    }
    if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", String(headers.get("x-real-ip") || incoming.socket.remoteAddress || "local"));
    const method = incoming.method || "GET";
    const request = new Request(requestUrl(incoming), {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(incoming), duplex: "half" })
    });
    const background = [];
    const response = await worker.fetch(request, env, { waitUntil(task) { background.push(Promise.resolve(task)); } });
    await respond(outgoing, response, method === "HEAD");
    Promise.allSettled(background).then(results => {
      for (const result of results) if (result.status === "rejected") console.error("background task failed", result.reason);
    });
  } catch (error) {
    console.error("request failed", error);
    if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ ok: false, error: "服务器暂不可用" }));
  }
});

server.listen(port, host, () => console.log(`joinccp listening on http://${host}:${port}`));

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
