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

test("metric cards respond to their container instead of viewport only", () => {
  assert.match(responsive, /\.metric-grid\s*\{\s*container-type:\s*inline-size;/);
  assert.match(responsive, /@container\s*\(max-width:\s*620px\)/);
  assert.match(responsive, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/);
  assert.match(responsive, /\.metric-grid \.metric-value[\s\S]*text-align:\s*right/);
});

test("touch desktop mode and extreme narrow screens have fallbacks", () => {
  assert.match(responsive, /@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)\s*and\s*\(max-width:\s*1180px\)/);
  assert.match(responsive, /@media\s*\(max-width:\s*380px\)/);
  assert.match(responsive, /\.review-preview, \.action-dialog, \.scan-overlay-card[\s\S]*max-height:\s*calc\(100dvh - 12px\)/);
});

test("the mobile mentor character stays available without covering card content", () => {
  assert.match(responsive, /\.mentor-fab\s*\{[\s\S]*width:\s*32px;[\s\S]*height:\s*38px;/);
  assert.match(responsive, /\.mentor-fab-girl\s*\{\s*width:\s*28px;\s*height:\s*34px;/);
  assert.match(responsive, /\.mentor-fab-label\s*\{[\s\S]*clip:\s*rect\(0 0 0 0\)/);
});
