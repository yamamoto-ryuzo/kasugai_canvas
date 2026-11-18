import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/sample_qgis/kasugai_canvas.kasc`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, undefined, { timeout: 120000 });
await page.waitForTimeout(10000);
const info = await page.evaluate(() => {
  const viewer = window.kasugaiApi.getViewer?.() || window._viewer;
  const dss = viewer.dataSources._dataSources;
  return dss.map(ds => {
    const ents = [...ds.entities.values];
    const withLabel = ents.filter(e => e.label).length;
    const poly = ents.filter(e => e.polygon).length;
    const sample = ents.find(e => e.polygon);
    const props = sample ? Object.keys(sample.properties?.propertyNames ? {} : {}) : [];
    let pnames = [];
    try { pnames = sample?.properties?.propertyNames || []; } catch (_) {}
    return { name: ds.name, n: ents.length, poly, withLabel, pnames: pnames.slice(0, 8) };
  });
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
