let identity = null;
let observer;
let scheduled = false;
const layers = new Map();

function paint(canvas, host) {
  const width = host === document.body ? innerWidth : host.clientWidth;
  const height = host === document.body ? innerHeight : host.clientHeight;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  // 双层重复文字：姓名专业便于人工识别，签名编号用于后台核验。
  for (let y = 35; y < height + 140; y += 138) {
    for (let x = -100; x < width + 300; x += 280) {
      ctx.save();
      ctx.translate(x + (Math.floor(y / 138) % 2) * 100, y);
      ctx.rotate(-Math.PI / 10);
      ctx.fillStyle = "rgba(95, 55, 65, 0.075)";
      ctx.font = "13px Microsoft YaHei, sans-serif";
      const label = identity.name + " · " + identity.major;
      ctx.fillText(label, 0, 0, 250);
      ctx.fillStyle = "rgba(70, 45, 55, 0.055)";
      ctx.font = "12px monospace";
      ctx.fillText(identity.code, 0, 19);
      ctx.restore();
    }
  }
}

function sync() {
  scheduled = false;
  const hosts = identity ? [document.body, ...document.querySelectorAll("dialog[open]")] : [];
  for (const [host, canvas] of layers) {
    if (!hosts.includes(host)) { canvas.remove(); layers.delete(host); }
  }
  for (const host of hosts) {
    let canvas = layers.get(host);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "identity-watermark";
      canvas.setAttribute("aria-hidden", "true");
      layers.set(host, canvas);
      host.append(canvas);
    }
    paint(canvas, host);
  }
}
function schedule() {
  if (!scheduled) { scheduled = true; requestAnimationFrame(sync); }
}
export function updateWatermark(value) {
  if (identity?.code === value?.code && identity?.name === value?.name && identity?.major === value?.major) return;
  identity = value || null;
  if (!observer) {
    observer = new MutationObserver(records => {
      if (records.some(record => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && node.tagName !== "CANVAS"))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    addEventListener("resize", schedule);
  }
  sync();
}

export function watermarkInspector({ make, post }) {
  const result = make("p", { className: "form-feedback", role: "status" });
  const input = make("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  const preview = make("canvas", { className: "watermark-preview", hidden: true });
  const code = make("input", { type: "text", placeholder: "WM-000001-XXXXXXXXXXXX", required: "" });
  const form = make("form", { className: "form-grid" }, make("label", { className: "field wide" }, "追踪编号", code),
    make("button", { className: "btn", type: "submit", text: "核验账号" }), result);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const data = await post("/api/admin/watermark/lookup", { code: code.value.trim() });
      result.textContent = "编号有效，关联账号：" + data.identity.name + "；专业：" + data.identity.major + "；用户名：" + data.username + "。这表示画面关联该账号，不能单独证明由本人传播。";
    } catch (error) { result.textContent = error.message; }
  });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { result.textContent = "图片不能超过 15 MB"; return; }
    let image;
    try {
      image = await createImageBitmap(file);
      const scale = Math.min(1, 2600 / Math.max(image.width, image.height));
      preview.width = Math.round(image.width * scale); preview.height = Math.round(image.height * scale);
      const ctx = preview.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, preview.width, preview.height);
      const data = ctx.getImageData(0, 0, preview.width, preview.height);
      // 增强白色背景中的浅色水印；复杂底图或摄屏可能需要人工核对。
      for (let i = 0; i < data.data.length; i += 4) {
        const gray = (data.data[i] + data.data[i + 1] + data.data[i + 2]) / 3;
        const value = Math.max(0, Math.min(255, (gray - 225) * 8.5));
        data.data[i] = data.data[i + 1] = data.data[i + 2] = value;
      }
      ctx.putImageData(data, 0, 0); preview.hidden = false;
      result.textContent = "已在本机增强图片。可放大读取重复编号后核验；原图不会上传。摄屏、压缩或小范围裁剪可能无法恢复编号。";
    } catch { result.textContent = "无法读取这张图片，请选择 PNG、JPEG 或 WebP"; }
    finally { image?.close(); }
  });
  return make("div", { className: "view" }, make("h1", { className: "page-title", text: "水印溯源" }),
    make("section", { className: "panel" }, make("p", { text: "截图在本机增强，读取编号后由服务器核验签名。仅管理员可以查询账号。水印不具备防篡改或百分之百溯源保证。" }),
      make("label", { className: "field" }, "选择截图增强查看", input), preview, form));
}
