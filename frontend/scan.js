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

// 积分图均值滤波（O(n)，任意大半径都快）
export function boxBlur(src, w, h, radius = 1) {
  const r = Math.max(1, radius | 0);
  const S = w + 1;
  const integral = new Uint32Array(S * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    integral[(y + 1) * S + x + 1] = src[y * w + x] + integral[y * S + x + 1] + integral[(y + 1) * S + x] - integral[y * S + x];
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * S + x1 + 1] - integral[y0 * S + x1 + 1] - integral[(y1 + 1) * S + x0] + integral[y0 * S + x0];
      out[y * w + x] = sum / count;
    }
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

// 光照展平：背景 = 大半径均值滤波，flat = gray - 背景 + 128，消除阴影与不均匀光照
export function illuminationFlatten(gray, w, h, radius) {
  const bg = boxBlur(gray, w, h, Math.max(1, radius | 0));
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = gray[i] - bg[i] + 128;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

// Bradley 自适应阈值（积分图，mean*(1-t)），比固定 C 更稳
export function bradleyThreshold(gray, w, h, window = 15, t = 0.15) {
  const S = w + 1;
  const integral = new Uint32Array(S * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    integral[(y + 1) * S + x + 1] = gray[y * w + x] + integral[y * S + x + 1] + integral[(y + 1) * S + x] - integral[y * S + x];
  const out = new Uint8Array(w * h);
  const half = window >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * S + x1 + 1] - integral[y0 * S + x1 + 1] - integral[(y1 + 1) * S + x0] + integral[y0 * S + x0];
      const mean = sum / count;
      out[y * w + x] = gray[y * w + x] < mean * (1 - t) ? 0 : 255;
    }
  }
  return out;
}

// 自适应二值化（局部均值 - C），保留供兼容/测试
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

// ---- 边缘 + Hough 直线检测找文档四角 ----

function houghLines(mag, w, h, maxLines = 16) {
  const thr = Math.max(20, otsuThreshold(mag));
  const diag = Math.hypot(w, h);
  const nTheta = 180, nRho = Math.ceil(diag * 2);
  const acc = new Int32Array(nTheta * nRho);
  const cosT = new Float64Array(nTheta), sinT = new Float64Array(nTheta);
  for (let t = 0; t < nTheta; t++) { const a = t * Math.PI / 180; cosT[t] = Math.cos(a); sinT[t] = Math.sin(a); }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mag[y * w + x] < thr) continue;
    for (let t = 0; t < nTheta; t++) {
      const rho = Math.round(x * cosT[t] + y * sinT[t] + diag);
      acc[t * nRho + rho]++;
    }
  }
  const peaks = [];
  for (let t = 0; t < nTheta; t++) for (let r = 1; r < nRho - 1; r++) {
    const v = acc[t * nRho + r];
    if (v < 30) continue;
    if (v >= acc[t * nRho + r - 1] && v >= acc[t * nRho + r + 1] &&
        v >= acc[((t + 1) % nTheta) * nRho + r] && v >= acc[((t - 1 + nTheta) % nTheta) * nRho + r])
      peaks.push({ theta: t, rho: r - diag, score: v });
  }
  peaks.sort((a, b) => b.score - a.score);
  return peaks.slice(0, maxLines);
}

const angleDiff = (a, b) => {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
};

function lineIntersection(l1, l2) {
  const a1 = Math.cos(l1.theta * Math.PI / 180), b1 = Math.sin(l1.theta * Math.PI / 180);
  const a2 = Math.cos(l2.theta * Math.PI / 180), b2 = Math.sin(l2.theta * Math.PI / 180);
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (l1.rho * b2 - l2.rho * b1) / det, y: (a1 * l2.rho - a2 * l1.rho) / det };
}

function orderCorners(pts) {
  let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
  for (const p of pts) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.y - p.x < tr.y - tr.x) tr = p;
    if (p.y - p.x > bl.y - bl.x) bl = p;
  }
  return [tl, tr, br, bl];
}

// 找纸张四角：边缘 → Hough 直线 → 聚类成两组垂直线 → 交点 → 凸四边形校验。
// 返回顺时针 [{x,y}×4]，或 null（失败则调用方走整幅兜底）。
export function findDocumentCorners(gray, w, h) {
  const mag = sobelMagnitude(gray, w, h);
  const peaks = houghLines(mag, w, h);
  if (peaks.length < 4) return null;
  // 归一化：rho >= 0，theta ∈ [0, 360)，保证法线方向唯一
  const lines = peaks.map(p => {
    let t = p.theta, r = p.rho;
    if (r < 0) { t = (t + 180) % 360; r = -r; }
    return { theta: t, rho: r };
  });
  const base = lines[0].theta;
  const groupA = [], groupB = [];
  for (const l of lines) (angleDiff(l.theta, base) < 45 ? groupA : groupB).push(l);
  const extremes = group => {
    if (group.length < 2) return null;
    group.sort((a, b) => a.rho - b.rho);
    // 合并同一物理线（rho 接近的重复检测），再取最外两条
    const merged = [];
    for (const l of group) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(l.rho - last.rho) < 8) last.rho = (last.rho + l.rho) / 2;
      else merged.push({ theta: l.theta, rho: l.rho });
    }
    if (merged.length < 2) return null;
    return [merged[0], merged[merged.length - 1]];
  };
  const A = extremes(groupA), B = extremes(groupB);
  if (!A || !B) return null;
  const pts = [];
  for (const l1 of A) for (const l2 of B) {
    const p = lineIntersection(l1, l2);
    if (p && isFinite(p.x) && isFinite(p.y)) pts.push(p);
  }
  if (pts.length !== 4) return null;
  const corners = orderCorners(pts);
  // 范围校验
  if (corners.some(c => c.x < -w * 0.25 || c.x > w * 1.25 || c.y < -h * 0.25 || c.y > h * 1.25)) return null;
  // 凸性 + 面积校验
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const [p0, p1, p2, p3] = corners;
  const signs = [cross(p0, p1, p2), cross(p1, p2, p3), cross(p2, p3, p0), cross(p3, p0, p1)].map(Math.sign);
  if (signs.some(s => s === 0) || !signs.every(s => s === signs[0])) return null;
  const area = Math.abs(cross(p0, p1, p2)) + Math.abs(cross(p0, p2, p3));
  if (area < 0.12 * w * h || area > 0.98 * w * h) return null;
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

function resizedCanvas(source, width, height, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function decodeImage(file, maxDim = 2200) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      try { return resizedCanvas(bitmap, bitmap.width, bitmap.height, maxDim); }
      finally { bitmap.close(); }
    } catch { /* Some browsers support more image formats through an image element. */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("此浏览器无法解码这张图。可直接提交原图，或将 HEIC 转成 JPG 后再扫描。"));
      el.src = url;
    });
    return resizedCanvas(img, img.naturalWidth, img.naturalHeight, maxDim);
  } finally { URL.revokeObjectURL(url); }
}

export function validCrop(corners, w, h) {
  if (!Array.isArray(corners) || corners.length !== 4 ||
    corners.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y) || p.x < 0 || p.x >= w || p.y < 0 || p.y >= h)) return false;
  const min = Math.max(2, Math.min(w, h) * .04);
  return corners.every((a, i) => {
    const b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
    return Math.hypot(b.x - a.x, b.y - a.y) >= min &&
      (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) >= min * min / 2;
  });
}

export function rotateScan(canvas) {
  const rotated = document.createElement("canvas");
  rotated.width = canvas.height; rotated.height = canvas.width;
  const ctx = rotated.getContext("2d");
  ctx.translate(rotated.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, 0, 0);
  return rotated;
}

function canvasToBlob(canvas, quality = 0.9) {
  return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error("编码失败"))), "image/jpeg", quality));
}

function grayToCanvas(pixels, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const octx = c.getContext("2d");
  const img = octx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = pixels[i];
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return c;
}

const oddClamp = (v, lo, hi) => { let x = Math.max(lo, Math.min(hi, v | 0)); if ((x & 1) === 0) x++; return x; };

// The color image preserves seals and annotations; enhancement is optional.
export async function processImage(canvas, corners) {
  const { width, height } = canvas;
  if (corners && !validCrop(corners, width, height)) throw new Error("四角顺序或裁剪范围无效，请重新调整。");
  const source = canvas.getContext("2d").getImageData(0, 0, width, height);
  let region = source;
  if (corners) {
    const edge = (a, b) => Math.hypot(corners[b].x - corners[a].x, corners[b].y - corners[a].y);
    const w = Math.round((edge(0, 1) + edge(2, 3)) / 2) + 1;
    const h = Math.round((edge(0, 3) + edge(1, 2)) / 2) + 1;
    const scale = Math.min(1, 2200 / Math.max(w, h));
    region = warpPerspective(source, corners, Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale)));
  }
  const color = document.createElement("canvas");
  const w = color.width = region.width, h = color.height = region.height;
  const ctx = color.getContext("2d");
  const image = ctx.createImageData(w, h);
  image.data.set(region.data);
  ctx.putImageData(image, 0, 0);
  const name = "扫描_" + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "") + ".jpg";

  return {
    name, color: await canvasToBlob(color, .94),
    async enhance(mode) {
      const gray = grayscale(region);
      const flat = illuminationFlatten(gray, w, h, Math.max(8, Math.round(Math.min(w, h) / 12)));
      const pixels = mode === "bw" ? bradleyThreshold(flat, w, h, oddClamp(Math.round(Math.min(w, h) / 16), 15, 255), .15)
        : autoContrast(flat, w, h);
      return canvasToBlob(grayToCanvas(pixels, w, h));
    }
  };
}
