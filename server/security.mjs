import { isIP } from "node:net";

const firstHeader = value => String(value || "").split(",", 1)[0].trim();

export function normalizeIp(value, fallback = "local") {
  let address = firstHeader(value);
  if (address.startsWith("::ffff:")) address = address.slice(7);
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);
  return isIP(address) ? address : fallback;
}

export function trustedClientIp(headers, socketAddress) {
  return normalizeIp(headers.get("x-real-ip"), normalizeIp(socketAddress));
}

export function allowedHosts(value, defaults = ["cauc.pw", "localhost", "127.0.0.1"]) {
  return new Set(String(value || defaults.join(","))
    .split(",")
    .map(host => host.trim().toLowerCase())
    .filter(Boolean));
}

export function validHost(value, allowed) {
  const raw = firstHeader(value).toLowerCase();
  if (!raw || /[\s/@\\]/.test(raw)) return false;
  let hostname = raw;
  try { hostname = new URL("http://" + raw).hostname.toLowerCase(); }
  catch { return false; }
  return allowed.has(raw) || allowed.has(hostname);
}

export class FixedWindowLimiter {
  constructor({ limit, windowMs, maxKeys = 20000, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.entries = new Map();
  }

  take(key) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + this.windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    if (this.entries.size > this.maxKeys) this.sweep(now);
    return {
      allowed: entry.count <= this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    };
  }

  sweep(now = this.now()) {
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value);
  }
}

export function requestClass(pathname, method) {
  if (["/api/login", "/api/auth/challenge", "/api/register", "/api/bootstrap"].includes(pathname)) return "auth";
  if (pathname.startsWith("/api/mentor/") || pathname.startsWith("/api/office/")) return "ai";
  if (method !== "GET" && method !== "HEAD" && (pathname === "/api/checks" || pathname === "/api/forms" || pathname === "/api/office/execute")) return "upload";
  if (pathname.startsWith("/api/")) return method === "GET" || method === "HEAD" ? "api" : "mutation";
  return "asset";
}
