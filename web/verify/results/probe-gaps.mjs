// ギャップ解消の検証:
//  1) MapLibre: extrude= → fill-extrusion レイヤ生成 + InterpolatedLine → lineMetrics+line-gradient
//  2) Navara: <labeling> → text マテリアル + FeatureEvaluator ラベル（ベースマップなしで確認）
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC_EX = encodeURIComponent(`${BASE}/projects/extrude_test/extrude_test.kasc`);
const KASC_SQ = encodeURIComponent(`${BASE}/projects/sample_qgis/kasugai_canvas.kasc`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));
page.on("console", m => { const t = m.text(); if (/warn|error|fail|font/i.test(t)) console.log("[con]", t.slice(0, 180)); });

// ---- 1) MapLibre ----
try {
  await page.goto(`${BASE}/maplibre/?kasc=${KASC_EX}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap?.loaded?.() && window.kasugaiApi, { timeout: 60000 });
  await page.waitForTimeout(5000);
  const ml = await page.evaluate(() => {
    const st = window.kascMap.getStyle();
    const ex = st.layers.filter(l => l.type === "fill-extrusion").map(l => ({
      id: l.id, height: l.paint?.["fill-extrusion-height"], base: l.paint?.["fill-extrusion-base"] }));
    const grad = st.layers.filter(l => l.paint?.["line-gradient"]).map(l => ({ id: l.id }));
    const metrics = Object.entries(st.sources).filter(([, s]) => s.lineMetrics).map(([id]) => id);
    const baked = window.kascMap.queryRenderedFeatures?.({ layers: grad.map(g => g.id) })?.[0]?.properties || null;
    return { ex, grad, metrics, lgc: baked ? [baked.__kasc_lgc1, baked.__kasc_lgc2] : null };
  });
  console.log("maplibre:", JSON.stringify(ml));
  await page.screenshot({ path: `${OUT}gap-ml-extrude.png` });
} catch (e) { console.log("maplibre: FAILED", String(e).slice(0, 250)); }

// ---- 2) Navara: QML <labeling> → text マテリアル ----
try {
  await page.goto(`${BASE}/navara/?kasc=${KASC_SQ}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascView && window.kasugaiApi, { timeout: 90000 });
  await page.waitForTimeout(12000); // gpkg + フォント登録 + evaluator 待ち
  // 足立区へ移動（setCamera は即時・トップダウン）
  await page.evaluate(() => {
    window.kascView.setCamera({ lng: 139.805, lat: 35.775, height: 4000, heading: 0, pitch: -90 });
  });
  await page.waitForTimeout(4000);
  const nv = await page.evaluate(() => {
    // layersManager から vector レイヤの desc を拾い text マテリアル有無を確認
    const v = window.kascView;
    const lm = v.layersManager || v._layersManager;
    const out = { layers: [], textLayers: 0 };
    const seen = new Set();
    const walk = o => {
      if (!o || typeof o !== "object" || seen.has(o)) return;
      seen.add(o);
      if (seen.size > 4000) return;
      for (const [k, val] of Object.entries(o)) {
        if (k === "text" && val && typeof val === "object" && ("font" in val || "size" in val)) {
          out.textLayers++;
          out.layers.push({ font: val.font ?? val._font, size: val.size ?? val._size });
        }
        if (val && typeof val === "object" && !(val instanceof Float32Array) && !(val instanceof HTMLElement)) walk(val);
      }
    };
    try { walk(lm || v); } catch (_) {}
    return out;
  });
  console.log("navara:", JSON.stringify(nv));
  await page.screenshot({ path: `${OUT}gap-navara-label.png` });
} catch (e) { console.log("navara: FAILED", String(e).slice(0, 250)); }

await browser.close();
