import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/\/([A-Za-z]:)/, "$1").replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/sample_qgis/kasugai_canvas.kasc`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, undefined, { timeout: 120000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.kasugaiApi.setBasemap("ベースマップなし"));
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 35.73, longitude: 139.75, height: 55000, pitch: -90, heading: 0, instant: true }));
await page.waitForTimeout(8000);
const dbg = await page.evaluate(() => {
  const viewer = window.kasugaiApi.getViewer?.() || window._viewer;
  const out = [];
  for (const ds of viewer.dataSources._dataSources) {
    for (const e of ds.entities.values) {
      const t = e.label?.text?.getValue?.();
      if (t !== "足立区") continue;
      const l = e.label;
      const pos = e.position?.getValue?.(Cesium.JulianDate.now());
      let win = null;
      try {
        if (pos) {
          const w = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, pos);
          win = w ? [Math.round(w.x), Math.round(w.y)] : null;
        }
      } catch (err) { win = "err:" + err.message; }
      out.push({
        dsShow: ds.show, show: l.show?.getValue?.(),
        font: l.font?.getValue?.(), pos: !!pos, win,
        ddc: l.distanceDisplayCondition?.getValue?.() ?? null,
        fill: l.fillColor?.getValue?.()?.toCssColorString?.(),
        pixelOffset: l.pixelOffset?.getValue?.(),
      });
    }
  }
  return out.slice(0, 5);
});
console.log(JSON.stringify(dbg, null, 1));
await page.evaluate(() => { (window.kasugaiApi.getViewer?.() || window._viewer).scene.requestRender(); });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}adachi-cesium-mid4.png` });
await browser.close();
console.log("done");
