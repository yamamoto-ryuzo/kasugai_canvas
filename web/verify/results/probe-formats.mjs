// 検証: 新形式 (gpx/czml/topojson/esrijson/geojsonl/wkt/wkb) の
//   (a) loadVectorItem 変換  (b) kasc パース  (c) エンジン描画
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));
page.on("console", m => { const t = m.text(); if (/error|fail/i.test(t) && !/favicon/.test(t)) console.log("[con]", t.slice(0, 180)); });

// ---- (a)+(b): vector-load + kasc パース（エンジン非依存・cesium ページで実行）----
try {
  await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
  const r = await page.evaluate(async (base) => {
    const vl = await import("../shared/vector-load.js");
    const kasc = await import("../shared/kasc.js");
    const items = [
      { type: "gpx", title: "gpx", url: `${base}/projects/format_test/canvas_data/track.gpx` },
      { type: "czml", title: "czml", url: `${base}/projects/format_test/canvas_data/sat.czml` },
      { type: "topojson", title: "topo", url: `${base}/projects/format_test/canvas_data/area.topojson` },
      { type: "esrijson", title: "esri", url: `${base}/projects/format_test/canvas_data/field.esrijson` },
      { type: "geojsonl", title: "nd", url: `${base}/projects/format_test/canvas_data/lines.geojsonl` },
      { type: "wkt", title: "wkt", url: `${base}/projects/format_test/canvas_data/shapes.wkt` },
      { type: "wkb", title: "wkb", url: `${base}/projects/format_test/canvas_data/pt.wkb` },
      { type: "igc", title: "igc", url: `${base}/projects/format_test/canvas_data/flight.igc` },
      { type: "polyline", title: "pl", url: `${base}/projects/format_test/canvas_data/line.polyline` },
      { type: "gml", title: "gml", url: `${base}/projects/format_test/canvas_data/area.gml` },
    ];
    const out = {};
    for (const it of items) {
      try {
        const r = await vl.loadVectorItem(it, "", null);
        out[it.type] = {
          n: r.geojson.features.length,
          geoms: [...new Set(r.geojson.features.map(f => f.geometry.type))].join("/"),
          props: Object.keys(r.geojson.features[0]?.properties || {}).slice(0, 4).join(","),
        };
      } catch (e) { out[it.type] = { error: String(e).slice(0, 120) }; }
    }
    // kasc パース確認
    const text = await (await fetch(`${base}/projects/format_test/format_test.kasc`)).text();
    const doc = kasc.parseKasc(text);
    out._kasc = { layers: doc.layers.map(l => l.type).join(","), unsupported: doc.unsupported.length };
    return out;
  }, BASE);
  console.log("vector-load:", JSON.stringify(r, null, 1));
} catch (e) { console.log("vector-load FAILED", String(e).slice(0, 250)); }

// ---- (c): MapLibre 描画 ----
try {
  await page.goto(`${BASE}/maplibre/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap?.loaded?.() && window.kasugaiApi, { timeout: 90000 });
  await page.waitForTimeout(8000);
  const ml = await page.evaluate(() => {
    const st = window.kascMap.getStyle();
    const srcs = Object.keys(st.sources);
    const lyrs = st.layers.filter(l => l.type !== "background" && l.type !== "raster").map(l => ({ id: l.id.slice(0, 40), type: l.type }));
    return { nSources: srcs.length, nLayers: lyrs.length, layers: lyrs.slice(0, 20) };
  });
  console.log("maplibre:", JSON.stringify(ml));
  await page.screenshot({ path: `${OUT}fmt-maplibre.png` });
} catch (e) { console.log("maplibre FAILED", String(e).slice(0, 250)); }

// ---- (c): Cesium 描画 ----
try {
  await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 90000 });
  for (let i = 0; i < 25; i++) {
    const n = await page.evaluate(() => (window.kasugaiApi.listLayers() || []).length);
    if (n >= 7) break;
    await page.waitForTimeout(3000);
  }
  const ce = await page.evaluate(() => {
    const ds = window._viewer.dataSources;
    const out = [];
    for (let i = 0; i < ds.length; i++) {
      const d = ds.get(i);
      if (d.entities.values.length) out.push({ name: (d.name || "?").slice(0, 30), n: d.entities.values.length });
    }
    return { layers: window.kasugaiApi.listLayers().map(l => l.type + ":" + l.title), ds: out };
  });
  console.log("cesium:", JSON.stringify(ce));
  await page.screenshot({ path: `${OUT}fmt-cesium.png` });
} catch (e) { console.log("cesium FAILED", String(e).slice(0, 250)); }

// ---- (d): OpenLayers 描画 ----
try {
  await page.goto(`${BASE}/openlayers/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap || window.kascOl, { timeout: 90000 });
  await page.waitForTimeout(12000);
  const ol = await page.evaluate(() => {
    const m = window.kascMap || window.kascOl;
    return m.getLayers().getArray()
      .map(l => (l.get("title") || l.get("name") || "?") + "=" + (l.getSource && l.getSource().getFeatures ? l.getSource().getFeatures().length : -1));
  });
  console.log("openlayers:", JSON.stringify(ol));
  await page.screenshot({ path: `${OUT}fmt-openlayers.png` });
} catch (e) { console.log("openlayers FAILED", String(e).slice(0, 250)); }

// ---- (e): Leaflet 描画 ----
try {
  await page.goto(`${BASE}/leaflet/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap || window.leafletMap, { timeout: 90000 });
  await page.waitForTimeout(12000);
  const lf = await page.evaluate(() => {
    const m = window.kascMap || window.leafletMap;
    let n = 0;
    m.eachLayer(l => { if (l.feature || l.getGeoJSON) n++; });
    return { vectorLayers: n };
  });
  console.log("leaflet:", JSON.stringify(lf));
  await page.screenshot({ path: `${OUT}fmt-leaflet.png` });
} catch (e) { console.log("leaflet FAILED", String(e).slice(0, 250)); }

// ---- (f): Navara 描画 ----
try {
  await page.goto(`${BASE}/navara/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascView && window.kasugaiApi?.listLayers, { timeout: 90000 });
  await page.waitForTimeout(15000);
  const nv = await page.evaluate(() =>
    window.kasugaiApi.listLayers().map(l => l.type + ":" + l.title + (l.failed ? " FAIL" : "")));
  console.log("navara:", JSON.stringify(nv));
  await page.screenshot({ path: `${OUT}fmt-navara.png` });
} catch (e) { console.log("navara FAILED", String(e).slice(0, 250)); }

// ---- (g): GSI Maps 描画（iframe 内 sakuzuList を確認）----
try {
  await page.goto(`${BASE}/gsimaps/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("gsi-frame")?.contentWindow?.GSI?.GLOBALS, { timeout: 120000 });
  await page.waitForTimeout(15000);
  const gs = await page.evaluate(() => {
    const w = document.getElementById("gsi-frame").contentWindow;
    const sk = w.GSI.GLOBALS.gsimaps?._sakuzuList;
    return {
      apiLayers: window.kasugaiApi.listLayers().map(l => l.type),
      sakuzu: (sk?._list || []).map(s => (s.title || s._title || s.fileName || "?") + (s._layer ? "[layer]" : "")),
    };
  });
  console.log("gsimaps:", JSON.stringify(gs));
  await page.screenshot({ path: `${OUT}fmt-gsimaps.png` });
} catch (e) { console.log("gsimaps FAILED", String(e).slice(0, 250)); }

await browser.close();
