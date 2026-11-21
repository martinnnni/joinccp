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

export async function scanImage(file, { maxDim = 1200 } = {}) {
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

  // 1) 找角 + 透视摆正（失败则整幅兜底，绝不强行 warp）
  let regionGray, regionW, regionH;
  const corners = findDocumentCorners(gray, w, h);
  if (corners) {
    const wTop = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    const wBot = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
    const hL = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
    const hR = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);
    regionW = Math.max(1, Math.round((wTop + wBot) / 2));
    regionH = Math.max(1, Math.round((hL + hR) / 2));
    regionGray = grayscale(warpPerspective(img, corners, regionW, regionH));
  } else {
    regionGray = gray; regionW = w; regionH = h;
  }

  // 2) 光照展平 → 消除阴影，再增强
  const radius = Math.max(8, Math.round(Math.min(regionW, regionH) / 12));
  const flat = illuminationFlatten(regionGray, regionW, regionH, radius);
  const grayEnhanced = autoContrast(flat, regionW, regionH);
  const win = oddClamp(Math.round(Math.min(regionW, regionH) / 16), 15, 255);
  const bw = bradleyThreshold(flat, regionW, regionH, win, 0.15);

  const grayCanvas = grayToCanvas(grayEnhanced, regionW, regionH);
  const bwCanvas = grayToCanvas(bw, regionW, regionH);
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 14);
  const name = "扫描_" + ts + ".jpg";
  return {
    width: regionW, height: regionH, name,
    gray: { dataURL: grayCanvas.toDataURL("image/jpeg", 0.9), blob: await canvasToBlob(grayCanvas) },
    bw: { dataURL: bwCanvas.toDataURL("image/jpeg", 0.9), blob: await canvasToBlob(bwCanvas) }
  };
}
