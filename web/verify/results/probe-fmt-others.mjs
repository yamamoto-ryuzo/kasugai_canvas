import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));

async function probe(name, url, ready, evalFn, wait = 12000) {
  try {
    await page.goto(`${BASE}/${url}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(ready, { timeout: 90000 });
    await page.waitForTimeout(wait);
    const r = await page.evaluate(evalFn);
    console.log(name + ":", JSON.stringify(r).slice(0, 500));
    await page.screenshot({ path: `fmt-${name}.png` });
  } catch (e) { console.log(name + " FAILED", String(e).slice(0, 200)); }
}

await probe("openlayers", `openlayers/?kasc=${KASC}`, () => window.kascMap || window.kascOl, () => {
  const m = window.kascMap || window.kascOl;
  const ls = m.getLayers().getArray().map(l => { const fc = l.getSource && l.getSource().getFeatures ? l.getSource().getFeatures().length : -1; return (l.get("title") || l.get("name") || "?") + "=" + fc; });
  return ls;
});

await probe("leaflet", `leaflet/?kasc=${KASC}`, () => window.kascMap || window.leafletMap, () => {
  const m = window.kascMap || window.leafletMap;
  const out = [];
  m.eachLayer(l => { if (l.feature || l.getGeoJSON) out.push((l.options && l.options.title) || l.constructor.name); });
  return { n: out.length, layers: out.slice(0, 15) };
});

await probe("navara", `navara/?kasc=${KASC}`, () => window.kascView, () => {
  const v = window.kascView;
  const out = { methods: 0, sources: 0, layers: [] };
  try { out.sources = Object.keys(v.sources || v._sources || {}).length; } catch {}
  try { out.layers = (v.listLayers ? v.listLayers() : (v.getLayers ? v.getLayers() : [])).map(l => l.id || l.name || "?"); } catch {}
  return out;
});

await probe("gsimaps", `gsimaps/?kasc=${KASC}`, () => window.GSI && window.GSI.GLOBALS, () => {
  const g = window.GSI;
  const out = {};
  try { out.layers = Object.keys(g.GLOBALS.mapLayerList || {}).length; } catch {}
  try { out.ll = (g.GLOBALS.mapLayerList ? Array.from(g.GLOBALS.mapLayerList).length : -1); } catch {}
  return out;
});
await browser.close();
