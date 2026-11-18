import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
const r = await page.evaluate(async () => {
  const IGC = (await import("https://cdn.jsdelivr.net/npm/ol@10.11.0/format/IGC.js")).default;
  const text = await (await fetch("../projects/format_test/canvas_data/flight.igc")).text();
  const feats = new IGC().readFeatures(text, { featureProjection: "EPSG:4326", dataProjection: "EPSG:4326" });
  const f = feats[0];
  const g = f.getGeometry();
  return {
    gType: g?.getType?.(),
    layout: g?.getLayout?.(),
    stride: g?.getStride?.(),
    flatSample: (g?.getFlatCoordinates?.() || g?.getCoordinates?.() || []).slice?.(0, 10),
    coordsType: Array.isArray(g?.getCoordinates?.()) ? (Array.isArray(g.getCoordinates()[0]) ? "nested" : "flat") : "?",
  };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
