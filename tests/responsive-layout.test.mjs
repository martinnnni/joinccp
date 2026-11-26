import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const responsive = await readFile(new URL("../public/responsive.css", import.meta.url), "utf8");
const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("mobile viewport and document roots cannot force horizontal overflow", () => {
  assert.match(index, /name="viewport"[^>]*width=device-width/);
  assert.match(index, /viewport-fit=cover/);
  assert.match(responsive, /html\s*\{[^}]*min-width:\s*0;/s);
  assert.match(responsive, /body\s*\{[^}]*min-width:\s*0;/s);
  assert.doesNotMatch(responsive, /html\s*\{[^}]*min-width:\s*320px;/s);
});

test("high-risk application surfaces use intrinsic containment", () => {
  for (const selector of [".view > *", ".panel > *", ".metric-grid", ".form-upload", ".bulk-tools", ".mentor-app"]) {
    assert.ok(responsive.includes(selector), selector + " must be covered by the containment layer");
  }
  assert.match(responsive, /min-width:\s*0;\s*\n\s*max-width:\s*100%;/);
  assert.match(responsive, /overflow-wrap:\s*anywhere/);
});

test("mobile metric cards keep their original vertical left-aligned layout", () => {
  assert.doesNotMatch(responsive, /\.metric-grid\s*\{\s*container-type:/);
  assert.doesNotMatch(responsive, /@container\s*\(max-width:/);
  assert.match(responsive, /\.metric-grid \.metric\s*\{\s*display:\s*block !important;/);
  assert.match(responsive, /\.metric-grid \.metric-value[\s\S]*text-align:\s*left !important/);
  assert.match(responsive, /font-size:\s*clamp\(24px,\s*8vw,\s*30px\) !important/);
});

test("touch desktop mode and extreme narrow screens have fallbacks", () => {
  assert.match(responsive, /@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)\s*and\s*\(max-width:\s*1180px\)/);
  assert.match(responsive, /@media\s*\(max-width:\s*380px\)/);
  assert.match(responsive, /\.review-preview, \.action-dialog, \.scan-overlay-card[\s\S]*max-height:\s*calc\(100dvh - 12px\)/);
});

