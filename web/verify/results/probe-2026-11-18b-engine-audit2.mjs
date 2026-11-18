// engine-cesium 監査 Phase E 検証(2026-11-18 第2弾): 追加分ギャップの機械検証
// - scene3d: blur=/brightness= → API ステージ postProcessStages
// - scene3d: matuniforms= → globe.material uniforms 個別上書き
// - scene3d: minzoom=/maxzoom=/tilt= → ScreenSpaceCameraController
// - terrain: url= → 任意 CesiumTerrainProvider
// - model: modelopts= → ModelGraphics 残り引数(JSON 変換)
// - 3dtiles: osm → createOsmBuildingsAsync 経路
// - kasugaiApi.setEffect: depthview/autoexposure/silhouette + クリック選択配線
// - TMS: {reverseY} テンプレート到達確認
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
await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent("/projects/audit_effects2/audit_effects2.kasc")}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi?.isReady, { timeout: 120000 });
await page.waitForTimeout(6000);

// ---- 1. scene3d: blur=on / brightness=on → postProcessStages ----
const ppsInfo = await page.evaluate(() => {
  const pps = window._viewer.scene.postProcessStages;
  const names = [];
  for (let i = 0; i < pps.length; i++) {
    const s = pps.get(i);
    names.push(s.name || s.constructor?.name || "?");
  }
  return { count: pps.length, names };
});
ok("scene3d blur=on/brightness=on → API ステージ 2件以上", ppsInfo.count >= 2, JSON.stringify(ppsInfo.names));

// ---- 2. scene3d: material=elevationcontour + matuniforms ----
const mat = await page.evaluate(() => {
  const m = window._viewer.scene.globe.material;
  return m ? { type: m.type, spacing: m.uniforms?.spacing, width: m.uniforms?.width } : null;
});
ok("material=elevationcontour → globe.material", mat?.type === "ElevationContour", JSON.stringify(mat));
ok("matuniforms spacing=200/width=3 → uniforms 上書き", mat?.spacing === 200 && mat?.width === 3, `spacing=${mat?.spacing} width=${mat?.width}`);

// ---- 3. scene3d: minzoom=/maxzoom=/tilt= → ScreenSpaceCameraController ----
const ssec = await page.evaluate(() => {
  const s = window._viewer.scene.screenSpaceCameraController;
  return { min: s.minimumZoomDistance, max: s.maximumZoomDistance, tilt: s.enableTilt };
});
ok("minzoom=50 → minimumZoomDistance", ssec.min === 50, String(ssec.min));
ok("maxzoom=500000 → maximumZoomDistance", ssec.max === 500000, String(ssec.max));
ok("tilt=on → enableTilt", ssec.tilt === true, String(ssec.tilt));

// ---- 4. terrain: url= → 任意 CesiumTerrainProvider ----
const terrain = await page.evaluate(async () => {
  for (let i = 0; i < 30; i++) {
    if (!(window._viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return { ctor: window._viewer.terrainProvider?.constructor?.name, isCesiumTP: window._viewer.terrainProvider instanceof Cesium.CesiumTerrainProvider };
});
ok("terrain url= → CesiumTerrainProvider(非楕円体)", terrain.isCesiumTP === true, terrain.ctor);

// ---- 5. model: modelopts= → ModelGraphics 変換 ----
const model = await page.evaluate(() => {
  const out = {};
  for (const ds of window._viewer.dataSources._dataSources || []) {
    for (const e of ds.entities.values) {
      if (!e.model) continue;
      const g = k => { try { return e.model[k]?.getValue?.() ?? e.model[k]; } catch { return "err"; } };
      out.found = true;
      out.colorBlendMode = g("colorBlendMode");
      out.color = g("color")?.toCssColorString?.() || String(g("color"));
      out.silhouetteColor = g("silhouetteColor")?.toCssColorString?.() || String(g("silhouetteColor"));
      out.silhouetteSize = g("silhouetteSize");
      out.runAnimations = g("runAnimations");
      const ibl = g("imageBasedLightingFactor");
      out.ibl = ibl ? [ibl.x, ibl.y] : null;
      const ddc = g("distanceDisplayCondition");
      out.ddc = ddc ? [ddc.near, ddc.far] : null;
      out.heightReference = g("heightReference");
      out.uri = e.model.uri?.getValue?.() || "";
    }
  }
  return out;
});
ok("model: エンティティ存在", model.found === true, model.uri?.slice(-30));
ok("modelopts colorBlendMode=replace", model.colorBlendMode === 1, String(model.colorBlendMode)); // ColorBlendMode.REPLACE=1
ok("modelopts color=#00ff00", /rgb\(0,\s*255,\s*0\)|#00ff00/i.test(String(model.color)), String(model.color));
ok("modelopts silhouetteColor/Size", /rgb\(255,\s*0,\s*0\)|#ff0000/i.test(String(model.silhouetteColor)) && model.silhouetteSize === 2, `${model.silhouetteColor}/${model.silhouetteSize}`);
ok("modelopts runAnimations=false", model.runAnimations === false, String(model.runAnimations));
ok("modelopts imageBasedLightingFactor=[2,2]", Array.isArray(model.ibl) && model.ibl[0] === 2 && model.ibl[1] === 2, JSON.stringify(model.ibl));
ok("modelopts distanceDisplayCondition=[0,100000]", Array.isArray(model.ddc) && model.ddc[1] === 100000, JSON.stringify(model.ddc));

// ---- 6. 3dtiles: osm → createOsmBuildingsAsync 経路 ----
const osm = await page.evaluate(async () => {
  await new Promise(r => setTimeout(r, 4000));
  const prims = [];
  for (let i = 0; i < window._viewer.scene.primitives.length; i++) prims.push(window._viewer.scene.primitives.get(i));
  const ts = prims.find(p => p instanceof Cesium.Cesium3DTileset);
  return { found: !!ts, url: ts?._url || ts?.url || "", resourceUrl: ts?._resource?.url || "" };
});
ok("3dtiles osm → タイルセット生成(ion トークン依存)", osm.found === true, osm.resourceUrl || osm.url);

// ---- 7. kasugaiApi.setEffect API ステージ ----
const eff = await page.evaluate(() => {
  const pps = window._viewer.scene.postProcessStages;
  const count = () => pps.length;
  const c0 = count();
  const r1 = window.kasugaiApi.setEffect("depthview", true);
  const c1 = count();
  const r2 = window.kasugaiApi.setEffect("silhouette", true);
  const c2 = count();
  const r3 = window.kasugaiApi.setEffect("depthview", false);
  const c3 = count();
  const r4 = window.kasugaiApi.setEffect("autoexposure", true); // 1.147 では add 不可の内部型 → false 期待
  const r5 = window.kasugaiApi.setEffect("nonexistent", true);
  return { c0, c1, c2, c3, r1, r2, r3, r4, r5 };
});
ok("setEffect('depthview',true) → ステージ追加", eff.r1 === true && eff.c1 === eff.c0 + 1, `c:${eff.c0}→${eff.c1}`);
ok("setEffect('silhouette',true) → ステージ追加", eff.r2 === true && eff.c2 === eff.c1 + 1, `c:${eff.c1}→${eff.c2}`);
ok("setEffect('depthview',false) → ステージ除去", eff.r3 === true && eff.c3 === eff.c2 - 1, `c:${eff.c2}→${eff.c3}`);
ok("setEffect('autoexposure') → 未サポートで false", eff.r4 === false);
ok("setEffect 未知名 → false", eff.r5 === false);

// ---- 8. silhouette クリック選択配線(地物の画面座標を計算してクリック) ----
const ptScreen = await page.evaluate(() => {
  const c = Cesium.Cartesian3.fromDegrees(139.770, 35.688);
  const w = Cesium.SceneTransforms.worldToWindowCoordinates(window._viewer.scene, c);
  return w ? { x: w.x, y: w.y } : null;
});
const box = await page.locator("#cesium-container").boundingBox();
// worldToWindowCoordinates はキャンバス相対座標のため、コンテナの左上を足して
// ビューポート座標へ変換する。ビルボードピンは下端アンカーのため少し上を狙う
const clickX = ptScreen ? box.x + ptScreen.x : box.x + box.width / 2;
const clickY = ptScreen ? box.y + ptScreen.y - 16 : box.y + box.height / 2;
await page.mouse.click(clickX, clickY);
await page.waitForTimeout(1500);
const sil = await page.evaluate(() => {
  const pps = window._viewer.scene.postProcessStages;
  for (let i = 0; i < pps.length; i++) {
    const s = pps.get(i);
    if (Array.isArray(s.selected)) return { found: true, selected: s.selected.length };
  }
  return { found: false };
});
ok("silhouette クリック → selected に pick 結果", sil.found === true && sil.selected > 0, JSON.stringify(sil));

// ---- 9. TMS 到達: {reverseY} テンプレート ----
const tms = await page.evaluate(() => {
  try {
    const p = new Cesium.UrlTemplateImageryProvider({ url: "https://example.com/{z}/{x}/{reverseY}.png" });
    return { ok: p instanceof Cesium.UrlTemplateImageryProvider };
  } catch (e) { return { ok: false, err: String(e) }; }
});
ok("TMS 到達({reverseY} テンプレートで構築可)", tms.ok === true, tms.err || "");

await page.screenshot({ path: `${OUT}engine-audit2-scene.png` });
// 効果パネルのスクショ
await page.evaluate(() => { document.querySelector('[data-panel="settings-panel"]')?.click?.(); });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}engine-audit2-panel.png` });

writeFileSync(`${OUT}engine-audit2-2026-11-18.json`, JSON.stringify(results, null, 2));
const fails = results.checks.filter(c => !c.pass);
console.log(`\n${results.checks.length - fails.length}/${results.checks.length} PASS`);
await browser.close();
process.exit(fails.length ? 1 : 0);
