import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowLimiter, allowedHosts, normalizeIp, requestClass, trustedClientIp, validHost } from "../server/security.mjs";

test("only accepts syntactically valid trusted proxy addresses", () => {
  assert.equal(normalizeIp("::ffff:192.0.2.4"), "192.0.2.4");
  assert.equal(normalizeIp("not-an-ip"), "local");
  assert.equal(trustedClientIp(new Headers({ "x-real-ip": "198.51.100.8" }), "127.0.0.1"), "198.51.100.8");
  assert.equal(trustedClientIp(new Headers({ "x-real-ip": "spoofed" }), "::ffff:127.0.0.1"), "127.0.0.1");
});

test("host allowlist ignores ports but rejects malformed host values", () => {
  const hosts = allowedHosts("cauc.pw,127.0.0.1");
  assert.equal(validHost("cauc.pw", hosts), true);
  assert.equal(validHost("cauc.pw:443", hosts), true);
  assert.equal(validHost("evil.example", hosts), false);
  assert.equal(validHost("cauc.pw@evil.example", hosts), false);
});

test("fixed-window limiter resets and returns a retry time", () => {
  let now = 1000;
  const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 10000, now: () => now });
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, true);
  const blocked = limiter.take("a");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 10);
  now = 11000;
  assert.equal(limiter.take("a").allowed, true);
});

test("request classes separate login, AI, uploads and mutations", () => {
  assert.equal(requestClass("/api/login", "POST"), "auth");
  assert.equal(requestClass("/api/mentor/chat", "POST"), "ai");
  assert.equal(requestClass("/api/checks", "POST"), "upload");
  assert.equal(requestClass("/api/admin/students", "POST"), "mutation");
  assert.equal(requestClass("/site.css", "GET"), "asset");
});
