// engine-navara 監査 Phase B/E: 実行時 API サーフェス列挙
// - kascView プロトタイプ鎖の public メソッド全列挙
// - @navaramap/three の実行時エクスポート名
// - camera / globe / atmosphere / attribution のプロパティ
// - 登録済みメッシュ/ライト/エフェクト種別のプローブ(DefaultPlugin 登録 25/4/14)
// - fx.* コントロール DOM 列挙
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const results = {};
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrs = [];
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") consoleErrs.push(m.text().slice(0, 200)); });
page.on("pageerror", e => consoleErrs.push("PAGEERROR " + String(e).slice(0, 200)));
await page.goto(`${BASE}/navara/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kascView, { timeout: 120000 });
await page.waitForTimeout(12000); // WASM 起動と初期タイルの安定待ち

const enum_ = await page.evaluate(async () => {
  const view = window.kascView;
  const out = {};
  // プロトタイプ鎖のメソッド/プロパティ名
  const chain = [];
  let p = view;
  while (p && p !== Object.prototype) {
    chain.push(...Object.getOwnPropertyNames(p));
    p = Object.getPrototypeOf(p);
  }
  out.viewMembers = [...new Set(chain)].sort();
  // camera メンバー
  const camChain = [];
  p = view.camera;
  while (p && p !== Object.prototype) {
    camChain.push(...Object.getOwnPropertyNames(p));
    p = Object.getPrototypeOf(p);
  }
  out.cameraMembers = [...new Set(camChain)].sort();
  // globe
  const globeChain = [];
  p = view.globe;
  while (p && p !== Object.prototype) {
    globeChain.push(...Object.getOwnPropertyNames(p));
    p = Object.getPrototypeOf(p);
  }
  out.globeMembers = [...new Set(globeChain)].sort();
  // atmosphere
  const atmChain = [];
  p = view.atmosphere;
  while (p && p !== Object.prototype) {
    atmChain.push(...Object.getOwnPropertyNames(p));
    p = Object.getPrototypeOf(p);
  }
  out.atmosphereMembers = [...new Set(atmChain)].sort();
  // @navaramap/three エクスポート(importmap 解決後 URL を直接 import)
  try {
    const mod = await import("../vendor/navara/@navaramap/three/dist/index.js");
    out.moduleExports = Object.keys(mod).sort();
  } catch (e) { out.moduleExportsError = String(e); }
  try {
    const plug = await import("../vendor/navara/@navaramap/three-default-plugin/dist/index.js");
    out.pluginExports = Object.keys(plug).sort();
  } catch (e) { out.pluginExportsError = String(e); }
  // attribution 内蔵インスタンスの有無
  out.attribution = view.attribution ? Object.getOwnPropertyNames(Object.getPrototypeOf(view.attribution)).sort() : null;
  // 値系
  out.lit = view.lit;
  out.animation = view.animation;
  out.cacheBytes = view.cacheBytes;
  out.lodFog = view.lodFog;
  out.dynamicSse = view.dynamicSse;
  out.isMobileOptimized = view.isMobileOptimized();
  try { out.memoryStats = view.memoryStats(); } catch (e) { out.memoryStatsError = String(e); }
  // fx.* コントロール DOM
  out.fxControls = [...document.querySelectorAll('[id^="nv-"]')].map(el => el.id).sort();
  return out;
});
Object.assign(results, enum_);
writeFileSync(OUT + "navara-api-surface.json", JSON.stringify(results, null, 2));
console.log("viewMembers:", results.viewMembers.length);
console.log(results.viewMembers.join(", "));
console.log("---cameraMembers:", results.cameraMembers.join(", "));
console.log("---moduleExports:", (results.moduleExports || []).length, (results.moduleExports || []).join(", ").slice(0, 3000));
console.log("---fxControls:", results.fxControls.join(", "));
await page.screenshot({ path: OUT + "navara-audit-surface.png" });
console.log("---console errors:", consoleErrs.slice(0, 15));
await browser.close();
