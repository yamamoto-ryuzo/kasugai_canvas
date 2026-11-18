// 行政区域ポリゴン N03_004 ラベル(足立区)の縮尺連動検証 — ベースマップなし
// if(@map_scale>=50000,6, if(@map_scale>=10000,10,14))pt → 約8/13/19px 期待
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/sample_qgis/kasugai_canvas.kasc`);
const ADACHI = { lat: 35.775, lng: 139.805 };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));

const STEPS = [
  ["wide",   11,   15000], // ~220k → 6pt≈8px
  ["mid",    13.5,  4000], // ~30k  → 10pt≈13px
  ["detail", 16.5,   800], // ~3k   → 14pt≈19px
];

for (const eng of ["leaflet", "maplibre", "openlayers", "cesium"]) {
  try {
    await page.goto(`${BASE}/${eng}/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, { timeout: 90000 });
    await page.waitForTimeout(6000);
    // 背景なしへ切替(スキル検証手順)
    await page.evaluate(() => window.kasugaiApi.setBasemap("ベースマップなし"));
    await page.waitForTimeout(1200);
    for (const [name, zoom, h] of STEPS) {
      await page.evaluate(([lat, lng, z, h]) => {
        if (window.kasugaiApi?.getViewer) {
          const v = window.kasugaiApi.getViewer();
          v.camera.cancelFlight();
          v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(lng, lat, h), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 } });
          v.scene.requestRender();
        } else window.kasugaiApi?.flyTo({ latitude: lat, longitude: lng, zoom: z, instant: true });
      }, [ADACHI.lat, ADACHI.lng, zoom, h]);
      await page.waitForTimeout(2600);
      const info = await page.evaluate(() => {
        const out = { scale: null, dom: null, sym: null };
        try { out.dom = [...document.querySelectorAll(".kasc-label.leaflet-tooltip, .leaflet-tooltip")]
          .filter(t => /足立区/.test(t.textContent || ""))
          .map(t => ({ text: t.textContent.trim(), font: getComputedStyle(t).fontSize, shown: t.offsetParent !== null })); } catch (_) {}
        return out;
      });
      await page.screenshot({ path: `${OUT}adachi-${eng}-${name}.png` });
      console.log(`${eng}/${name}:`, JSON.stringify(info.dom));
    }
  } catch (e) { console.log(`${eng}: FAILED`, String(e).slice(0, 250)); }
}
await browser.close();
console.log("done");
