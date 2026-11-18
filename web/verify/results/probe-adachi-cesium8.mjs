import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/sample_qgis/kasugai_canvas.kasc`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, undefined, { timeout: 120000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.kasugaiApi.setBasemap("ベースマップなし"));
// まず中間高度でラベル位置を特定
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 35.775, longitude: 139.805, height: 12000, pitch: -90, heading: 0, instant: true }));
await page.waitForTimeout(8000);
const ll = await page.evaluate(() => {
  const viewer = window.kasugaiApi.getViewer?.() || window._viewer;
  for (const ds of viewer.dataSources._dataSources)
    for (const e of ds.entities.values)
      if (e.label?.text?.getValue?.() === "足立区") {
        const c = Cesium.Cartographic.fromCartesian(e.position.getValue(Cesium.JulianDate.now()));
        return { lat: c.latitude * 180 / Math.PI, lon: c.longitude * 180 / Math.PI };
      }
  return null;
});
console.log("labelPos:", JSON.stringify(ll));
if (ll) {
  await page.evaluate(v => window.kasugaiApi.flyTo({ latitude: v.lat, longitude: v.lon, height: 1600, pitch: -90, heading: 0, instant: true }), ll);
  await page.waitForTimeout(8000);
  const font = await page.evaluate(() => {
    const viewer = window.kasugaiApi.getViewer?.() || window._viewer;
    for (const ds of viewer.dataSources._dataSources)
      for (const e of ds.entities.values)
        if (e.label?.text?.getValue?.() === "足立区")
          return { font: e.label.font?.getValue?.(), show: e.label.show?.getValue?.() };
    return null;
  });
  console.log("font:", JSON.stringify(font));
  await page.evaluate(() => { (window.kasugaiApi.getViewer?.() || window._viewer).scene.requestRender(); });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}adachi-cesium-px19b.png` });
}
await browser.close();
console.log("done");
