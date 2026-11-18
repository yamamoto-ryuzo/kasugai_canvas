// engine-navara 監査 Phase E: 地物別ラベル/破線の FeatureEvaluator 反映検証
// - addInitScript で FeatureEvaluator.prototype.evaluate を先回りフックし、
//   app.js の applyStyle が返した EvaluatedValue を featureCreated 時に機械検査
// - text: color/outlineColor/outlineWidth(1/64em)/anchor/textAlign/offset
// - polyline: dashArray/cap (ルール別破線)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const results = { checks: [] };
const ok = (name, cond, extra = "") => { results.checks.push({ name, pass: !!cond, extra }); console.log(cond ? "PASS" : "FAIL", name, extra); };
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 200)));

await page.addInitScript(() => {
  window.__cap = [];
  window.__capReady = false;
  (async () => {
    for (let i = 0; i < 600 && !window.__capReady; i++) {
      try {
        const mod = await import("/vendor/navara/@navaramap/three/dist/index.js");
        const orig = mod.FeatureEvaluator.prototype.evaluate;
        mod.FeatureEvaluator.prototype.evaluate = function (f, opts) {
          return orig.call(this, info => {
            const v = f(info) || {};
            try {
              const plain = {};
              for (const [k, x] of Object.entries(v)) {
                const hexOf = c => typeof c?.toHex === "function" ? c.toHex()
                  : typeof c?.getHex === "function" ? c.getHex() : null;
                plain[k] = hexOf(x) != null ? "#" + hexOf(x).toString(16).padStart(6, "0")
                  : (x instanceof Float32Array ? [...x] : x);
              }
              window.__cap.push({ gt: info?.meshGeomType, props: info?.properties, v: plain });
            } catch (_) {}
            return v;
          }, opts);
        };
        window.__capReady = true;
      } catch (e) { await new Promise(r => setTimeout(r, 500)); }
    }
  })();
});

await page.goto(`${BASE}/navara/?kasc=${encodeURIComponent("/verify/navara-qml/qml-verify.kasc")}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kascView, { timeout: 120000 });
await page.waitForFunction(() => window.__capReady, { timeout: 120000 });
await page.waitForTimeout(20000); // WASM起動・フォント取得・地物メッシュ生成の安定待ち

const cap = await page.evaluate(() => window.__cap || []);
console.log("captured:", cap.length);
writeFileSync(OUT + "navara-qml-captured.json", JSON.stringify(cap, null, 2));

// ---- 機械検査 ----
const byProps = cap.filter(c => c.props?.kind);
const texts = byProps.filter(c => c.gt === "text" || c.gt === "sdfText");
const city = texts.find(c => c.props.kind === "city" && c.v.text === "甲府");
const peak = texts.find(c => c.props.kind === "peak" && c.v.text === "富士山");
ok("地物が評価された", byProps.length > 0, `${byProps.length}件`);
ok("ラベル地物が評価された(city)", !!city, JSON.stringify(city?.v));
ok("ラベル地物が評価された(peak)", !!peak, JSON.stringify(peak?.v));
if (city) {
  ok("city: anchor=bottom-left (quadOffset=2 AboveRight)", city.v.anchor === "bottom-left", city.v.anchor);
  ok("city: outlineColor=#ffffff", String(city.v.outlineColor).toLowerCase() === "#ffffff", city.v.outlineColor);
  ok("city: outlineWidth が 1/64em 換算値(3〜30)", Number(city.v.outlineWidth) > 3 && Number(city.v.outlineWidth) < 30, city.v.outlineWidth);
  ok("city: offset が quad+dist を含む", city.v.offset && Math.abs(city.v.offset.x) + Math.abs(city.v.offset.y) > 0, JSON.stringify(city.v.offset));
  ok("city: color がルール色(赤系)", /^#(c8|cc|d)/.test(String(city.v.color)), city.v.color);
}
if (peak) {
  ok("peak: anchor=top (quadOffset=7 Below)", peak.v.anchor === "top", peak.v.anchor);
  ok("peak: outlineColor=#000000", String(peak.v.outlineColor).toLowerCase() === "#000000", peak.v.outlineColor);
  ok("peak: color が白", String(peak.v.color).toLowerCase() === "#ffffff", peak.v.color);
}
const lines = byProps.filter(c => c.gt === "polyline" || c.gt === "line");
const road2 = lines.find(c => c.props.kind === "road2");
const road = lines.find(c => c.props.kind === "road");
if (road2) {
  ok("road2: dashArray が地物別に返る", Array.isArray(road2.v.dashArray) && road2.v.dashArray.length >= 2, JSON.stringify(road2.v.dashArray));
  ok("road2: cap=round", road2.v.cap === "round", road2.v.cap);
}
if (road) {
  ok("road(実線): dashArray を返さない", !Array.isArray(road.v.dashArray) || road.v.dashArray.length === 0, JSON.stringify(road.v.dashArray));
}
await page.screenshot({ path: OUT + "navara-qml-verify.png" });
const fails = results.checks.filter(c => !c.pass);
console.log(`--- ${results.checks.length - fails.length}/${results.checks.length} PASS`);
writeFileSync(OUT + "navara-qml-verify-results.json", JSON.stringify(results, null, 2));
await browser.close();
process.exit(fails.length ? 1 : 0);
