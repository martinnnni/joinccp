import test from "node:test";
import assert from "node:assert/strict";
import { grayscale, adaptiveThreshold, autoContrast, illuminationFlatten, bradleyThreshold, warpPerspective, findDocumentCorners, contentBBox } from "../frontend/scan.js";

const solid = (w, h, rgb) => ({ width: w, height: h, data: (() => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = 255; } return d; })() });

test("grayscale 加权转灰度", () => {
  const g = grayscale(solid(2, 1, [255, 0, 0]));
  assert.equal(g.length, 2);
  assert.ok(g[0] > 70 && g[0] < 80);
});

test("warpPerspective 把已知四边形拉成矩形并保留像素", () => {
  const out = warpPerspective(solid(4, 4, [128, 128, 128]), [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }], 2, 2);
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.equal(out.data[0], 128);
});

test("findDocumentCorners 在白色纸张暗背景下找到近似矩形四角", () => {
  const w = 200, h = 260;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = x >= 40 && x <= 160 && y >= 30 && y <= 230;
    const v = inside ? 245 : 20;
    d[(y * w + x) * 4] = d[(y * w + x) * 4 + 1] = d[(y * w + x) * 4 + 2] = v; d[(y * w + x) * 4 + 3] = 255;
  }
  const gray = grayscale({ width: w, height: h, data: d });
  const corners = findDocumentCorners(gray, w, h);
  assert.ok(corners, "应能找到四角");
  assert.equal(corners.length, 4);
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  assert.ok(Math.min(...xs) > 30 && Math.max(...xs) < 170, "x 范围应落在纸张内");
  assert.ok(Math.min(...ys) > 20 && Math.max(...ys) < 240, "y 范围应落在纸张内");
});

test("adaptiveThreshold 输出黑白两级", () => {
  const out = adaptiveThreshold(new Uint8Array([200, 210, 20, 10]), 4, 1, 3, 5);
  assert.ok(out.every(v => v === 0 || v === 255));
});

test("autoContrast 拉伸到满对比度", () => {
  const out = autoContrast(new Uint8Array([50, 100, 150, 200]), 4, 1);
  assert.equal(Math.min(...out), 0);
  assert.equal(Math.max(...out), 255);
});

test("contentBBox 裁掉四周留白", () => {
  const w = 10, h = 10;
  const g = new Uint8Array(w * h).fill(255);
  for (let y = 3; y <= 6; y++) for (let x = 2; x <= 7; x++) g[y * w + x] = 0;
  const box = contentBBox(g, w, h);
  assert.ok(box.x <= 2 && box.y <= 3 && box.x + box.w >= 8 && box.y + box.h >= 7);
});

test("illuminationFlatten 抹平左右亮度渐变", () => {
  // 左暗右亮的光照渐变，展平后应趋于一致
  const w = 128, h = 32;
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 100 + x; // 100..227 渐变
  const flat = illuminationFlatten(g, w, h, 32);
  let min = 255, max = 0;
  for (let i = 0; i < flat.length; i++) { if (flat[i] < min) min = flat[i]; if (flat[i] > max) max = flat[i]; }
  assert.ok(max - min < 60, "展平后整体亮度差应显著缩小，实际 " + (max - min));
});

test("bradleyThreshold 输出黑白两级且暗字变黑", () => {
  const w = 4, h = 2;
  // 白底(230) + 深色字(60)
  const g = new Uint8Array([230, 230, 60, 230, 230, 60, 230, 230]);
  const out = bradleyThreshold(g, w, h, 3, 0.15);
  assert.ok(out.every(v => v === 0 || v === 255));
  assert.equal(out[2], 0); // 深色像素应为黑
  assert.equal(out[0], 255); // 白底像素应为白
});
