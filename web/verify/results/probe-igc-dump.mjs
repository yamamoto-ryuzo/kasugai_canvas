import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
const r = await page.evaluate(async (base) => {
  const vl = await import("../shared/vector-load.js");
  const out = {};
  for (const [t, f] of [["igc", "flight.igc"], ["polyline", "line.polyline"], ["gml", "area.gml"]]) {
    try {
      const r = await vl.loadVectorItem({ type: t, title: t, url: `${base}/projects/format_test/DATA/${f}` }, "", null);
      out[t] = r.geojson.features.map(ft => ({ g: ft.geometry.type, c: JSON.stringify(ft.geometry.coordinates).slice(0, 140), p: JSON.stringify(ft.properties).slice(0, 100) }));
    } catch (e) { out[t] = String(e).slice(0, 150); }
  }
  return out;
}, BASE);
console.log(JSON.stringify(r, null, 1).slice(0, 2500));
await browser.close();
