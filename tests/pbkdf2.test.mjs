import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sha256, deriveVerifier } from "../frontend/pbkdf2.js";
import { pbkdf2Sync, randomBytes } from "node:crypto";

test("纯 JS PBKDF2-HMAC-SHA256 与 Node crypto 逐字节一致（210000 次迭代）", () => {
  const password = new TextEncoder().encode("cauc+2025001");
  const salt = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00]);
  const expected = pbkdf2Sync(password, salt, 210000, 32, "sha256");
  const actual = pbkdf2Sha256(password, salt, 210000, 32);
  assert.deepEqual(Buffer.from(actual), expected);
});

test("纯 JS PBKDF2 在多种盐值与迭代次数下均与 Node crypto 一致", () => {
  for (let i = 0; i < 5; i++) {
    const password = new TextEncoder().encode("pwd-" + i);
    const salt = randomBytes(16);
    const iterations = 1 + i * 97;
    const expected = pbkdf2Sync(password, salt, iterations, 32, "sha256");
    const actual = pbkdf2Sha256(password, salt, iterations, 32);
    assert.deepEqual(Buffer.from(actual), expected, "迭代 " + iterations + " 不一致");
  }
});

test("deriveVerifier 输出 64 位十六进制并与 Node crypto 一致", async () => {
  const saltHex = "112233445566778899aabbccddeeff00";
  const verifier = await deriveVerifier("cauc+2025001", saltHex, 210000);
  assert.match(verifier, /^[a-f0-9]{64}$/);
  const expected = pbkdf2Sync("cauc+2025001", Buffer.from(saltHex, "hex"), 210000, 32, "sha256").toString("hex");
  assert.equal(verifier, expected);
});
