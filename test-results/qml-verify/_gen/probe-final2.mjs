import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
const base = "http://127.0.0.1:8510";
const outDir = "C:/devin/kasugai_canvas/test-results/qml-verify/shots-gaps";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 300)));
page.on("console", m => { if (m.type() === "error" && !/404|429/.test(m.text())) console.log("[console]", m.text().slice(0, 200)); });

// Navara: svgmarker(categorized) → billboard image + evaluator
await page.goto(`${base}/navara/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
await page.evaluate(() => window.kascView.setCamera({ lng: 139.60, lat: 35.595, height: 3000, pitch: -55, heading: 0 }));
await page.waitForTimeout(3000);
await page.screenshot({ path: `${outDir}/navara-svg.png` });
console.log("navara svg shot OK");

// Cesium: d25 extrudedHeight + mapunit
await page.goto(`${base}/cesium/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
const cz = await page.evaluate(() => {
  const out = { d25: null, svg: null };
  for (let i = 0; i < window._viewer.dataSources.length; i++) {
    const ds = window._viewer.dataSources.get(i);
    for (const e of ds.entities.values) {
      if (e.polygon?.extrudedHeight != null && !out.d25) {
        const h = e.polygon.extrudedHeight.getValue?.(Cesium.JulianDate.now()) ?? e.polygon.extrudedHeight;
        out.d25 = h;
      }
    }
    if (ds.name === "svgmarker") {
      const e = ds.entities.values[0];
      out.svg = e?.billboard?.image ? "billboard-image-set" : e?.point ? "point-fallback" : "none";
    }
  }
  return out;
});
console.log("cesium:", JSON.stringify(cz));
await page.evaluate(() => {
  window._viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139.615, 35.585, 2500),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45) } });
});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outDir}/cesium-tilt.png` });
console.log("cesium tilt OK");
await browser.close();
