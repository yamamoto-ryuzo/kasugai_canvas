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
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 35.73, longitude: 139.75, height: 55000, pitch: -90, heading: 0, instant: true }));
await page.waitForTimeout(10000);
const labels = await page.evaluate(() => {
  const viewer = window.kasugaiApi.getViewer?.() || window._viewer;
  let shown = 0, total = 0;
  for (const ds of viewer.dataSources._dataSources)
    for (const e of ds.entities.values)
      if (e.label?.text?.getValue?.()) { total++; if (e.label.show?.getValue?.()) shown++; }
  return { shown, total };
});
console.log("labels:", JSON.stringify(labels));
await page.screenshot({ path: `${OUT}adachi-cesium-mid3.png` });
await browser.close();
console.log("done");
