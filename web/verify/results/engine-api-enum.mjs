// エンジン API 実行時列挙: cesium/maplibre/leaflet/navara/gsimaps
// 出力: engine-api-enum.json
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const result = {};
const launchOpts = {};
try { /* 検出は不要: OS インストール chrome 優先 */ } catch {}
let browser;
try { browser = await chromium.launch({ channel: "chrome", ...launchOpts }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 160)));

const proto = o => { try { return Object.getOwnPropertyNames(Object.getPrototypeOf(o)).filter(n => !n.startsWith("_") && n !== "constructor"); } catch { return []; } };

// ---- cesium ----
try {
  await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
  result.cesium = await page.evaluate(() => {
    const keys = Object.keys(Cesium);
    const graphics = {};
    for (const k of keys.filter(k => k.endsWith("Graphics"))) {
      try { graphics[k] = Object.getOwnPropertyNames(Cesium[k].prototype).filter(n => !n.startsWith("_") && n !== "constructor"); } catch {}
    }
    const pick = k => { try { return Object.getOwnPropertyNames(Cesium[k].prototype).filter(n => !n.startsWith("_") && n !== "constructor"); } catch { return []; } };
    return {
      exportCount: keys.length,
      exports: keys,
      graphics,
      camera: pick("Camera"),
      viewer: pick("Viewer"),
      scene: pick("Scene"),
      globe: pick("Globe"),
      tileset: pick("Cesium3DTileset"),
      imageryProviders: keys.filter(k => k.includes("ImageryProvider") || k.endsWith("Imagery")),
      dataSources: keys.filter(k => k.includes("DataSource")),
      postProcess: (() => { try { return Object.keys(Cesium.PostProcessStageLibrary); } catch { return ["<none>"]; } })(),
      materials: (() => { try { return Object.keys(Cesium.Material).filter(k => k.endsWith("Type")).map(k => k.slice(0, -4)); } catch { return []; } })(),
    };
  });
  console.log("cesium:", result.cesium.exportCount, "exports");
} catch (e) { result.cesium = { error: String(e).slice(0, 200) }; console.log("cesium FAILED", String(e).slice(0, 150)); }

// ---- maplibre ----
try {
  await page.goto(`${BASE}/maplibre/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap, { timeout: 90000 });
  result.maplibre = await page.evaluate(async () => {
    const ml = await import("https://cdn.jsdelivr.net/npm/maplibre-gl@6.18.0/dist/maplibre-gl.mjs");
    let spec = null;
    try {
      const r = await fetch("https://cdn.jsdelivr.net/gh/maplibre/maplibre-gl-js@v6.18.0/src/style-spec/reference/v8.json");
      const v8 = await r.json();
      const layers = {};
      for (const [k, v] of Object.entries(v8)) {
        const m = k.match(/^(paint|layout)_(.+)$/);
        if (m) (layers[m[2]] ??= { paint: [], layout: [] })[m[1]] = Object.keys(v);
      }
      spec = {
        layerTypes: Object.keys(v8.layer?.type?.values ?? v8.layer?.values?.type?.values ?? {}),
        layers, sourceTypes: Object.keys(v8).filter(k => k.startsWith("source_")),
        rootPaint: Object.keys(v8.paint ?? {}), rootLayout: Object.keys(v8.layout ?? {}),
        expressions: Object.keys(v8.expression_name?.values ?? {}),
      };
    } catch (e) { spec = { error: String(e) }; }
    return {
      exports: Object.keys(ml),
      mapProto: Object.getOwnPropertyNames(ml.Map.prototype).filter(n => n !== "constructor"),
      controls: Object.keys(ml).filter(k => k.endsWith("Control") || k === "Marker" || k === "Popup"),
      spec,
    };
  });
  console.log("maplibre:", result.maplibre.mapProto?.length, "Map methods");
} catch (e) { result.maplibre = { error: String(e).slice(0, 200) }; console.log("maplibre FAILED", String(e).slice(0, 150)); }

// ---- leaflet ----
try {
  await page.goto(`${BASE}/leaflet/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.L, { timeout: 90000 });
  result.leaflet = await page.evaluate(() => {
    const proto = c => { try { return Object.getOwnPropertyNames(c.prototype).filter(n => !n.startsWith("_") && n !== "constructor"); } catch { return []; } };
    const opts = c => { try { return Object.keys(c.prototype.options ?? {}); } catch { return []; } };
    return {
      exports: Object.keys(L),
      map: { methods: proto(L.Map), options: opts(L.Map) },
      tileLayer: { methods: proto(L.TileLayer), options: opts(L.TileLayer) },
      wms: { options: opts(L.TileLayer.WMS) },
      path: { options: opts(L.Path) },
      polyline: { options: opts(L.Polyline) },
      circleMarker: { options: opts(L.CircleMarker) },
      tooltip: { options: opts(L.Tooltip) },
      popup: { options: opts(L.Popup) },
      icon: { options: opts(L.Icon) },
      divIcon: { options: opts(L.DivIcon) },
      geojson: { methods: proto(L.GeoJSON), options: opts(L.GeoJSON) },
      canvas: { options: opts(L.Canvas) },
      controls: Object.keys(L).filter(k => k.toLowerCase().includes("control") || k in (L.control ?? {})),
      markerCluster: typeof L.markerClusterGroup === "function" ? "available(lazy)" : "not loaded",
      heat: typeof L.heatLayer === "function" ? "available(lazy)" : "not loaded",
    };
  });
  console.log("leaflet:", result.leaflet.exports?.length, "exports");
} catch (e) { result.leaflet = { error: String(e).slice(0, 200) }; console.log("leaflet FAILED", String(e).slice(0, 150)); }

// ---- navara ----
try {
  await page.goto(`${BASE}/navara/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascView, { timeout: 120000 });
  await page.waitForTimeout(8000);
  result.navara = await page.evaluate(async () => {
    const view = window.kascView;
    const deep = (o, d) => { if (!o || d < 0) return []; try { return Object.getOwnPropertyNames(o).filter(n => !n.startsWith("_")); } catch { return []; } };
    const protoChain = [];
    let p = Object.getPrototypeOf(view);
    while (p && p !== Object.prototype) { protoChain.push(...Object.getOwnPropertyNames(p)); p = Object.getPrototypeOf(p); }
    let exports = [];
    try { const m = await import("@navaramap/three"); exports = Object.keys(m); } catch (e) { exports = ["<import failed>", String(e).slice(0, 80)]; }
    return {
      exports,
      viewProto: [...new Set(protoChain)].filter(n => n !== "constructor"),
      viewKeys: deep(view, 0),
      sky: view.sky ? { keys: deep(view.sky, 0), proto: deep(Object.getPrototypeOf(view.sky), 0) } : null,
    };
  });
  console.log("navara:", result.navara.viewProto?.length, "view methods");
} catch (e) { result.navara = { error: String(e).slice(0, 200) }; console.log("navara FAILED", String(e).slice(0, 150)); }

// ---- gsimaps ----
try {
  await page.goto(`${BASE}/gsimaps/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const f = document.getElementById("gsi-frame");
    return f?.contentWindow?.GSI?.GLOBALS;
  }, { timeout: 120000 });
  await page.waitForTimeout(6000);
  result.gsimaps = await page.evaluate(() => {
    const w = document.getElementById("gsi-frame").contentWindow;
    const g = w.GSI.GLOBALS;
    const safe = o => { try { return Object.keys(o); } catch { return []; } };
    const gm = g.gsimaps;
    return {
      GSI: safe(w.GSI),
      GLOBALS: safe(g),
      mainMapKeys: gm?._mainMap ? safe(gm._mainMap) : [],
      layerListKeys: gm?._mainMap?._mapLayerList ? safe(gm._mainMap._mapLayerList) : [],
      classes: safe(w.GSI).filter(k => /^[A-Z]/.test(k)),
    };
  });
  console.log("gsimaps: GSI keys", result.gsimaps.GSI?.length);
} catch (e) { result.gsimaps = { error: String(e).slice(0, 200) }; console.log("gsimaps FAILED", String(e).slice(0, 150)); }

writeFileSync(`${OUT}engine-api-enum.json`, JSON.stringify(result, null, 2));
console.log("WROTE engine-api-enum.json");
await browser.close();
