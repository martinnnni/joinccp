// frontend/scan.js — 纯前端文档扫描（零依赖、零 token）
// 纯函数均作用于 {data,width,height} 或 Uint8Array，可在 Node 中单测；
// 仅 scanImage 依赖浏览器 Canvas。

export function grayscale(img) {
  const { data, width: w, height: h } = img;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++)
    out[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  return out;
}

export function boxBlur(src, w, h, radius = 1) {
  const r = Math.max(1, radius | 0);
  const tmp = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; } }
    tmp[y * w + x] = (s / n) | 0;
  }
  const out = new Uint8Array(src.length);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; } }
    out[y * w + x] = (s / n) | 0;
  }
  return out;
}

export function sobelMagnitude(gray, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const tl = gray[i - w - 1], t = gray[i - w], tr = gray[i - w + 1];
    const l = gray[i - 1], r = gray[i + 1];
    const bl = gray[i + w - 1], b = gray[i + w], br = gray[i + w + 1];
    const gx = -tl - 2 * l - bl + tr + 2 * r + br;
    const gy = -tl - 2 * t - tr + bl + 2 * b + br;
    out[i] = Math.hypot(gx, gy);
  }
  return out;
}

export function otsuThreshold(values) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.min(255, values[i] | 0)]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, max = -1, thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; thr = t; }
  }
  return thr;
}

// 自适应二值化（局部均值）→ 黑白扫描件
export function adaptiveThreshold(gray, w, h, block = 31, C = 10) {
  const S = w + 1;
  const integral = new Uint32Array(S * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    integral[(y + 1) * S + x + 1] = gray[y * w + x] + integral[y * S + x + 1] + integral[(y + 1) * S + x] - integral[y * S + x];
  const out = new Uint8Array(w * h);
  const half = block >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum = integral[y1 * S + x1] - integral[y0 * S + x1] - integral[y1 * S + x0] + integral[y0 * S + x0];
      out[y * w + x] = gray[y * w + x] > (sum / area) - C ? 255 : 0;
    }
  }
  return out;
}

// 自动对比度拉伸（clip 为两侧裁剪比例）
export function autoContrast(gray, w, h, clip = 0.01) {
  const n = w * h;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  const target = Math.max(1, Math.floor(n * clip));
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= target) { hi = i; break; } }
  if (hi <= lo) { hi = 255; lo = 0; }
  const out = new Uint8Array(n);
  const range = hi - lo || 1;
  for (let i = 0; i < n; i++) {
    out[i] = gray[i] <= lo ? 0 : gray[i] >= hi ? 255 : Math.round((gray[i] - lo) * 255 / range);
  }
  return out;
}

// 由 4 对点解单应矩阵（dst -> src），高斯消元 8x9
function homography(dstPts, srcPts) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dstPts[i], [x, y] = srcPts[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col] || 1;
    for (let c = col; c < 9; c++) A[col][c] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
    }
  }
  return [A[0][8], A[1][8], A[2][8], A[3][8], A[4][8], A[5][8], A[6][8], A[7][8], 1];
}

// 透视矫正：src 为 RGBA {data,width,height}，corners 为顺时针 [{x,y}×4]，输出 RGBA {data,width,height}
export function warpPerspective(src, corners, dstW, dstH) {
  const sw = src.width, sh = src.height, sdata = src.data;
  const dstPts = [[0, 0], [dstW - 1, 0], [dstW - 1, dstH - 1], [0, dstH - 1]];
  const H = homography(dstPts, corners.map(p => [p.x, p.y]));
  const out = { width: dstW, height: dstH, data: new Uint8ClampedArray(dstW * dstH * 4) };
  const od = out.data;
  for (let v = 0; v < dstH; v++) for (let u = 0; u < dstW; u++) {
    const den = H[6] * u + H[7] * v + H[8];
    const sx = (H[0] * u + H[1] * v + H[2]) / den;
    const sy = (H[3] * u + H[4] * v + H[5]) / den;
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const o = (v * dstW + u) * 4;
    if (x0 < 0 || y0 < 0 || x0 >= sw || y0 >= sh) { od[o] = od[o + 1] = od[o + 2] = od[o + 3] = 255; continue; }
    const fx = sx - x0, fy = sy - y0;
    const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
    const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
    for (let c = 0; c < 3; c++) {
      const top = sdata[i00 + c] * (1 - fx) + sdata[i01 + c] * fx;
      const bot = sdata[i10 + c] * (1 - fx) + sdata[i11 + c] * fx;
      od[o + c] = top * (1 - fy) + bot * fy;
    }
    od[o + 3] = 255;
  }
  return out;
}

// 找纸张四角：Otsu 二值化 → 最大连通域 → 四边最小二乘拟合 → 交点。
// 返回顺时针 [{x,y}×4]，或 null（失败则调用方走 contentBBox 回退）。
export function findDocumentCorners(gray, w, h) {
  const thr = otsuThreshold(gray);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = gray[i] > thr ? 1 : 0;
  let white = 0;
  for (let i = 0; i < w * h; i++) white += bin[i];
  if (white > w * h * 0.7) for (let i = 0; i < w * h; i++) bin[i] = bin[i] ? 0 : 1; // 纸张偏暗则反转
  // 最大连通域（BFS 于下采样图上，规模可控）
  const label = new Int32Array(w * h).fill(-1);
  const q = new Int32Array(w * h);
  let best = { count: 0, id: 0 };
  let nextId = 0;
  for (let s = 0; s < w * h; s++) {
    if (bin[s] !== 1 || label[s] !== -1) continue;
    const id = nextId++;
    let head = 0, tail = 0, count = 0;
    q[tail++] = s; label[s] = id;
    while (head < tail) {
      const c = q[head++]; count++;
      const x = c % w, y = (c / w) | 0;
      if (x > 0 && bin[c - 1] === 1 && label[c - 1] === -1) { label[c - 1] = id; q[tail++] = c - 1; }
      if (x < w - 1 && bin[c + 1] === 1 && label[c + 1] === -1) { label[c + 1] = id; q[tail++] = c + 1; }
      if (y > 0 && bin[c - w] === 1 && label[c - w] === -1) { label[c - w] = id; q[tail++] = c - w; }
      if (y < h - 1 && bin[c + w] === 1 && label[c + w] === -1) { label[c + w] = id; q[tail++] = c + w; }
    }
    if (count > best.count) best = { count, id };
  }
  if (best.count < w * h * 0.05) return null;
  // 四边点集：每行的最左/最右、每列的最上/最下
  const leftPts = [], rightPts = [], topPts = [], botPts = [];
  for (let y = 0; y < h; y++) {
    let L = -1, R = -1;
    for (let x = 0; x < w; x++) if (label[y * w + x] === best.id) { L = x; break; }
    for (let x = w - 1; x >= 0; x--) if (label[y * w + x] === best.id) { R = x; break; }
    if (L >= 0) { leftPts.push([L, y]); rightPts.push([R, y]); }
  }
  for (let x = 0; x < w; x++) {
    let T = -1, B = -1;
    for (let y = 0; y < h; y++) if (label[y * w + x] === best.id) { T = y; break; }
    for (let y = h - 1; y >= 0; y--) if (label[y * w + x] === best.id) { B = y; break; }
    if (T >= 0) { topPts.push([x, T]); botPts.push([x, B]); }
  }
  // 竖边用 x = m y + b 拟合（x 随 y），横边用 y = m x + b 拟合
  const fitX = pts => { // 竖边：x = m y + b  ->  x - m y = b
    const n = pts.length;
    let sy = 0, sx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) { sy += y; sx += x; syy += y * y; sxy += x * y; }
    const den = n * syy - sy * sy;
    if (Math.abs(den) < 1e-9) return { a: 1, b: 0, c: sx / n };
    const m = (n * sxy - sx * sy) / den;
    const b = (sx - m * sy) / n;
    return { a: 1, b: -m, c: b };
  };
  const fitY = pts => { // 横边：y = m x + b  ->  -m x + y = b
    const n = pts.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return { a: 0, b: 1, c: sy / n };
    const m = (n * sxy - sx * sy) / den;
    const b = (sy - m * sx) / n;
    return { a: -m, b: 1, c: b };
  };
  const L = fitX(leftPts), R = fitX(rightPts), T = fitY(topPts), B = fitY(botPts);
  const isect = (l1, l2) => {
    const d = l1.a * l2.b - l2.a * l1.b;
    if (Math.abs(d) < 1e-9) return null;
    return { x: (l1.c * l2.b - l2.c * l1.b) / d, y: (l1.a * l2.c - l2.a * l1.c) / d };
  };
  const TL = isect(T, L), TR = isect(T, R), BR = isect(B, R), BL = isect(B, L);
  const corners = [TL, TR, BR, BL];
  if (corners.some(c => !c || !isFinite(c.x) || !isFinite(c.y) || c.x < -w * 0.2 || c.x > w * 1.2 || c.y < -h * 0.2 || c.y > h * 1.2)) return null;
  return corners;
}

// 兜底：内容边界框裁剪 + 留白 margin（不做透视）
export function contentBBox(gray, w, h, margin = 0.02) {
  const thr = otsuThreshold(gray);
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (gray[y * w + x] < thr) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX <= minX || maxY <= minY) return { x: 0, y: 0, w, h };
  const mx = Math.round(w * margin), my = Math.round(h * margin);
  return { x: Math.max(0, minX - mx), y: Math.max(0, minY - my), w: Math.min(w, maxX - minX + 2 * mx), h: Math.min(h, maxY - minY + 2 * my) };
}

// ---- 浏览器入口（依赖 Canvas） ----

async function decodeToCanvas(file) {
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = () => rej(new Error("无法解码图片"));
        el.src = url;
      });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }
}

function canvasToBlob(canvas, quality = 0.9) {
  return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error("编码失败"))), "image/jpeg", quality));
}

export async function scanImage(file, { maxDim = 1000, bw = true } = {}) {
  const full = await decodeToCanvas(file);
  const scale = Math.min(1, maxDim / Math.max(full.width, full.height));
  const w = Math.max(1, Math.round(full.width * scale));
  const h = Math.max(1, Math.round(full.height * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(full, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const gray = grayscale(img);

  let warped, outW, outH;
  const corners = findDocumentCorners(gray, w, h);
  if (corners) {
    const wTop = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    const wBot = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
    const hL = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
    const hR = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);
    outW = Math.max(1, Math.round((wTop + wBot) / 2));
    outH = Math.max(1, Math.round((hL + hR) / 2));
    warped = warpPerspective(img, corners, outW, outH);
  } else {
    const box = contentBBox(gray, w, h);
    outW = box.w; outH = box.h;
    const oc = document.createElement("canvas"); oc.width = outW; oc.height = outH;
    oc.getContext("2d").drawImage(c, box.x, box.y, box.w, box.h, 0, 0, outW, outH);
    warped = oc.getContext("2d").getImageData(0, 0, outW, outH);
  }

  const g2 = grayscale(warped);
  const enhanced = bw
    ? adaptiveThreshold(autoContrast(g2, outW, outH), outW, outH)
    : autoContrast(g2, outW, outH);

  const out = document.createElement("canvas");
  out.width = outW; out.height = outH;
  const octx = out.getContext("2d");
  const outImg = octx.createImageData(outW, outH);
  for (let i = 0; i < outW * outH; i++) {
    const v = enhanced[i];
    outImg.data[i * 4] = outImg.data[i * 4 + 1] = outImg.data[i * 4 + 2] = v;
    outImg.data[i * 4 + 3] = 255;
  }
  octx.putImageData(outImg, 0, 0);
  const blob = await canvasToBlob(out);
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 14);
  return { blob, width: outW, height: outH, dataURL: out.toDataURL("image/jpeg", 0.9), name: "扫描_" + ts + ".jpg" };
}
