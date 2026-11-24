import { createServer } from "node:http";
import { Readable } from "node:stream";
import worker from "../worker.js";
import { createRuntime } from "./runtime.mjs";
import { FixedWindowLimiter, allowedHosts, requestClass, trustedClientIp, validHost } from "./security.mjs";

const { env, db } = createRuntime();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const hosts = allowedHosts(process.env.ALLOWED_HOSTS);
const maximumBodyBytes = Number(process.env.MAX_BODY_BYTES || 36 * 1024 * 1024);
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
const rateLimits = {
  asset: new FixedWindowLimiter({ limit: Number(process.env.RATE_ASSET_PER_MINUTE || 1200), windowMs: 60000 }),
  api: new FixedWindowLimiter({ limit: Number(process.env.RATE_API_PER_MINUTE || 600), windowMs: 60000 }),
  mutation: new FixedWindowLimiter({ limit: Number(process.env.RATE_MUTATION_PER_MINUTE || 300), windowMs: 60000 }),
  auth: new FixedWindowLimiter({ limit: Number(process.env.RATE_AUTH_PER_15_MINUTES || 80), windowMs: 15 * 60000 }),
  ai: new FixedWindowLimiter({ limit: Number(process.env.RATE_AI_PER_MINUTE || 60), windowMs: 60000 }),
  upload: new FixedWindowLimiter({ limit: Number(process.env.RATE_UPLOAD_PER_10_MINUTES || 120), windowMs: 10 * 60000 })
};

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
    if (!validHost(incoming.headers.host, hosts)) {
      outgoing.writeHead(421, { "content-type": "application/json; charset=utf-8", connection: "close" });
      return outgoing.end(JSON.stringify({ ok: false, error: "访问地址无效" }));
    }
    const declaredLength = Number(incoming.headers["content-length"] || 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maximumBodyBytes) {
      outgoing.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
      return outgoing.end(JSON.stringify({ ok: false, error: "请求内容过大" }));
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
      else if (value !== undefined) headers.set(name, value);
    }
    const clientIp = trustedClientIp(headers, incoming.socket.remoteAddress);
    headers.set("cf-connecting-ip", clientIp);
    headers.set("x-real-ip", clientIp);
    const method = incoming.method || "GET";
    const pathname = new URL(requestUrl(incoming)).pathname;
    const category = requestClass(pathname, method);
    const allowance = rateLimits[category].take(clientIp);
    if (!allowance.allowed) {
      outgoing.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": String(allowance.retryAfter)
      });
      return outgoing.end(JSON.stringify({ ok: false, error: "请求过于频繁，请稍后再试" }));
    }
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

server.headersTimeout = 10000;
server.requestTimeout = 120000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 100;
server.maxConnections = Number(process.env.MAX_CONNECTIONS || 256);
server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(port, host, () => console.log(`joinccp listening on http://${host}:${port}`));

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
