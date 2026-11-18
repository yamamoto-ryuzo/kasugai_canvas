// engine-maplibre 監査の検証:
//  1) terrain: 行 → url= 指定 DEM + shading=both → hillshade + color-relief レイヤ
//  2) light: 行 → map.getLight() 反映
//  3) raster 色調整 opts(brightness/saturation/contrast/hue/resampling/fade-duration)
//  4) 投影セレクト → setProjection(globe) + setSky
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/ml_audit_terrain/kasugai_canvas.kasc`);
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 250)));
page.on("console", m => { const t = m.text(); if (/error|fail/i.test(t)) console.log("[con]", t.slice(0, 200)); });

try {
  await page.goto(`${BASE}/maplibre/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap?.loaded?.() && window.kasugaiApi, { timeout: 60000 });
  await page.waitForTimeout(8000); // DEM タイル + ラスタ読込待ち
  const r = await page.evaluate(() => {
    const st = window.kascMap.getStyle();
    const rasterPaints = st.layers.filter(l => l.type === "raster")
      .map(l => ({ id: l.id, paint: l.paint }));
    return {
      sources: Object.keys(st.sources),
      hillshade: st.layers.filter(l => l.type === "hillshade").map(l => ({ id: l.id, ex: l.paint?.["hillshade-exaggeration"] })),
      relief: st.layers.filter(l => l.type === "color-relief").map(l => ({ id: l.id })),
      rasterPaints,
      terrain: window.kascMap.getTerrain?.() || null,
      light: window.kascMap.getLight?.() || null,
      proj: window.kascMap.getProjection?.() || null,
      demSource: st.sources?.["kasc-terrain-dem"] || null,
      layerOrder: st.layers.map(l => `${l.type}:${l.id}`),
      uiVals: {
        hillshade: document.querySelector("#display-hillshade")?.checked,
        relief: document.querySelector("#display-relief")?.checked,
        terrainSrc: document.querySelector("#display-terrain-source")?.value,
        terrainOn: document.querySelector("#display-terrain")?.checked,
      },
    };
  });
  console.log("RESULT:", JSON.stringify(r, null, 1));
  // ---- 投影切替(非表示タブ内の select のため DOM 直叩き+change 発火) ----
  await page.evaluate(() => {
    const s = document.querySelector("#display-projection");
    s.value = "globe";
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(3000);
  const g = await page.evaluate(() => ({
    proj: window.kascMap.getProjection?.() || null,
    sky: window.kascMap.getSky?.() || null,
  }));
  console.log("GLOBE:", JSON.stringify(g));
  await page.screenshot({ path: `${OUT}ml-audit-globe.png` });
  // mercator に戻して hillshade スクリーンショット
  await page.evaluate(() => {
    const s = document.querySelector("#display-projection");
    s.value = "mercator";
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}ml-audit-terrain.png` });
} catch (e) {
  console.log("FAILED:", String(e).slice(0, 300));
}
await browser.close();
