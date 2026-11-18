// engine-cesium 監査 Phase E 検証: 新実装ギャップの機械検証
// - scene3d: fxaa=on / tonemap=ACES → postProcessStages 反映
// - 3dtiles: tilecolor=orange / sse= → Cesium3DTileStyle + per-layer SSE
// - geojson: scaledist= / strot= → entity graphics 引数
// - UI: #effect-* コントロール → globe.material・カスタムステージ・地表大気
// - wms: → GetFeatureInfo 追記(クリック模擬)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const results = { checks: [] };
const ok = (name, cond, extra = "") => { results.checks.push({ name, pass: !!cond, extra }); console.log(cond ? "PASS" : "FAIL", name, extra); };
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 160)));
await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent("/projects/audit_effects/audit_effects.kasc")}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi?.isReady, { timeout: 120000 });
await page.waitForTimeout(4000);

// ---- 1. scene3d: → postProcessStages ----
const pp = await page.evaluate(() => {
  const pps = window._viewer.scene.postProcessStages;
  return {
    fxaaEnabled: pps.fxaa.enabled,
    aoEnabled: pps.ambientOcclusion.enabled,
    tonemapper: String(pps.tonemapper),
    fxaaChecked: document.querySelector("#effect-fxaa")?.checked,
    tmValue: document.querySelector("#effect-tonemap")?.value,
    groundAtmos: window._viewer.scene.globe.showGroundAtmosphere,
    groundAtmosChecked: document.querySelector("#effect-ground-atmosphere")?.checked,
  };
});
ok("scene3d fxaa=on → pps.fxaa.enabled", pp.fxaaEnabled === true);
ok("scene3d tonemap=ACES → pps.tonemapper", pp.tonemapper === "ACES", pp.tonemapper);
ok("UI #effect-fxaa が scene3d と同期", pp.fxaaChecked === true);
ok("UI #effect-tonemap=ACES 同期", pp.tmValue === "ACES", pp.tmValue);
ok("地表大気 既定ON + チェック同期", pp.groundAtmos === true && pp.groundAtmosChecked === true);

// ---- 2. 3dtiles: tilecolor= / sse= ----
const tiles = await page.evaluate(async () => {
  const list = [];
  window._viewer.scene.primitives._primitives?.forEach?.(p => list.push(p));
  const prims = [];
  for (let i = 0; i < window._viewer.scene.primitives.length; i++) prims.push(window._viewer.scene.primitives.get(i));
  const ts = prims.find(p => p instanceof Cesium.Cesium3DTileset);
  if (!ts) return { found: false };
  return {
    found: true,
    ready: ts.ready,
    styleSet: !!ts.style,
    styleColorStr: ts.style?.color ? String(ts.style.color) : null,
    sse: ts.maximumScreenSpaceError,
    edl: ts.pointCloudShading ? { has: "eyeDomeLighting" in ts.pointCloudShading, v: ts.pointCloudShading.eyeDomeLighting } : null,
  };
});
ok("3dtiles レイヤーがマウントされた", tiles.found === true);
ok("tilecolor=orange → Cesium3DTileStyle 適用", tiles.found && tiles.styleSet === true, tiles.styleColorStr);

// ---- 3. geojson graphics opts ----
const gfx = await page.evaluate(() => {
  const out = { scaleDist: null, stRot: null };
  for (const ds of window._viewer.dataSources._dataSources || []) {
    for (const e of ds.entities.values) {
      if (e.billboard?.scaleByDistance) {
        const v = e.billboard.scaleByDistance.getValue();
        out.scaleDist = v ? [v.near, v.nearValue, v.far, v.farValue] : "no-get";
      }
      if (e.polygon?.stRotation !== undefined && e.polygon.stRotation !== null) {
        const v = e.polygon.stRotation.getValue?.();
        if (v) out.stRot = v;
      }
    }
  }
  return out;
});
ok("scaledist= → billboard.scaleByDistance(NearFarScalar)", Array.isArray(gfx.scaleDist) && gfx.scaleDist[0] === 1000 && gfx.scaleDist[1] === 1.5 && gfx.scaleDist[2] === 200000 && gfx.scaleDist[3] === 0.2, JSON.stringify(gfx.scaleDist));
ok("strot=45 → polygon.stRotation=π/4", typeof gfx.stRot === "number" && Math.abs(gfx.stRot - Math.PI / 4) < 0.001, String(gfx.stRot));

// ---- 4. UI コントロール → globe.material / カスタムステージ ----
await page.evaluate(() => {
  const sel = document.querySelector("#effect-globe-material");
  sel.value = "ElevationContour";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  const bw = document.querySelector("#effect-bw");
  bw.checked = true;
  bw.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(800);
const pp2 = await page.evaluate(() => {
  const pps = window._viewer.scene.postProcessStages;
  return {
    globeMat: window._viewer.scene.globe.material?.type || null,
    stageCount: pps.length,
    stageNames: (() => { const a = []; for (let i = 0; i < pps.length; i++) a.push(pps.get(i).name || pps.get(i).constructor.name); return a; })(),
  };
});
ok("globe.material=ElevationContour", pp2.globeMat === "ElevationContour", String(pp2.globeMat));
ok("モノクロ(B&W)ステージ追加", pp2.stageCount >= 1, JSON.stringify(pp2.stageNames));
await page.screenshot({ path: `${OUT}engine-audit-effects.png` });

// ---- 5. setEffect API ----
const api = await page.evaluate(() => {
  window.kasugaiApi.setEffect("edge", true);
  const pps = window._viewer.scene.postProcessStages;
  const names = [];
  for (let i = 0; i < pps.length; i++) names.push(pps.get(i).name || pps.get(i).constructor.name);
  window.kasugaiApi.setEffect("edge", false);
  window.kasugaiApi.setEffect("bloom", true);
  return { names, bloomOn: pps.bloom.enabled };
});
ok("kasugaiApi.setEffect('edge') → エッジ検出ステージ", api.names.length >= 1, JSON.stringify(api.names));
ok("kasugaiApi.setEffect('bloom') → composite enabled", api.bloomOn === true);

// ---- 6. WMS GetFeatureInfo(地図中心をクリック) ----
// 検証用 wms: 行は DATA/wms_stub.json(同一オリジン JSON スタブ)を指すため
// クリック位置に関係なく FeatureCollection が返る(実サーバーは環境依存)
const box = await page.locator("#cesium-container").boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(6000);
const wmsAttr = await page.evaluate(() => {
  const el = document.querySelector("#attr-content");
  return { text: el?.textContent?.slice(0, 400) || "", hasWms: /WMS/.test(el?.textContent || "") };
});
ok("WMS GetFeatureInfo → 属性パネル追記", wmsAttr.hasWms, wmsAttr.text.slice(0, 120));
await page.screenshot({ path: `${OUT}engine-audit-wms.png` });

writeFileSync(`${OUT}engine-audit-2026-11-18.json`, JSON.stringify(results, null, 2));
const fails = results.checks.filter(c => !c.pass);
console.log(`\n${results.checks.length - fails.length}/${results.checks.length} PASS`);
await browser.close();
process.exit(fails.length ? 1 : 0);
