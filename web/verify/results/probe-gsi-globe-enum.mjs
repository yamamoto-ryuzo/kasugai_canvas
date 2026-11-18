// gsimaps Globe 側 API 列挙 (enterGlobe 後の frame.contentWindow 棚卸し)
// globe ページのグローバル: GLOBE / GSI / GSI3D / MA / MATEST / Cesium / CONFIG
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 160)));

await page.goto(`${BASE}/gsimaps/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const f = document.getElementById("gsi-frame");
  return f?.contentWindow?.GSI?.GLOBALS?.gsimaps?._mainMap;
}, { timeout: 120000 });
await page.waitForTimeout(4000);

const r = await page.evaluate(() => window.kasugaiApi?.setGsiGlobe?.(true));
console.log("setGsiGlobe:", JSON.stringify(r));

// globe ページの GLOBE 名前空間出現を待つ
try {
  await page.waitForFunction(() => {
    const w = document.getElementById("gsi-frame")?.contentWindow;
    return w?.GLOBE && w?.GSI && w?.Cesium;
  }, { timeout: 120000, polling: 1000 });
  console.log("globe globals ready");
} catch { console.log("globe globals TIMEOUT"); }
await page.waitForTimeout(6000);

const result = await page.evaluate(() => {
  const w = document.getElementById("gsi-frame").contentWindow;
  const safeKeys = o => { try { return Object.keys(o); } catch { return []; } };
  const protoKeys = o => {
    try {
      const s = new Set(); let p = o;
      while (p && p !== Object.prototype) {
        for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor") s.add(n);
        p = Object.getPrototypeOf(p);
      }
      return [...s];
    } catch { return []; }
  };
  const out = { href: String(w.location?.href || ""), hash: String(w.location?.hash || "") };
  out.topKeys = safeKeys(w).filter(k => /^[A-Z]/.test(k)).slice(0, 80);

  // ---- GLOBE ----
  if (w.GLOBE) {
    out.GLOBE_keys = safeKeys(w.GLOBE);
    const map = w.GLOBE.MAP;
    out.GLOBE_MAP_keys = map ? protoKeys(map).filter(k => !k.startsWith("_")).slice(0, 80) : [];
    out.GLOBE_MAP_own = map ? safeKeys(map) : [];
    // viewer は GLOBE.MAP.viewer 直下 or map 内を探索
    let viewer = map?.viewer;
    if (!viewer && map) {
      for (const k of safeKeys(map)) {
        try { if (map[k]?.scene && map[k]?.camera) { viewer = map[k]; out.viewer_path = `GLOBE.MAP.${k}`; break; } } catch {}
      }
    }
    out.viewer_present = !!viewer;
    if (viewer) {
      out.viewer_keys = protoKeys(viewer).filter(k => !k.startsWith("_")).slice(0, 100);
      out.imageryLayers_count = viewer.imageryLayers?.length ?? null;
      out.dataSources_count = viewer.dataSources?.length ?? null;
      out.terrainProvider_type = viewer.terrainProvider?.constructor?.name ?? null;
    }
  }

  // ---- GSI (globe ページ側) ----
  if (w.GSI) {
    out.GSI_keys = safeKeys(w.GSI);
    out.GSI_types = {};
    for (const k of out.GSI_keys) {
      try { out.GSI_types[k] = typeof w.GSI[k]; } catch { out.GSI_types[k] = "<throw>"; }
    }
    out.GLOBALS_keys = w.GSI.GLOBALS ? safeKeys(w.GSI.GLOBALS) : [];
    out.GLOBALS_types = {};
    for (const k of out.GLOBALS_keys) {
      try { out.GLOBALS_types[k] = typeof w.GSI.GLOBALS[k]; } catch { out.GLOBALS_types[k] = "<throw>"; }
    }
    const ml = w.GSI.GLOBALS?.mapLayerList;
    out.mapLayerList_keys = ml ? protoKeys(ml) : [];
    out.mapLayerList_tileList_count = ml?.tileList?.length ?? null;
    const lj = w.GSI.GLOBALS?.layersJSON;
    out.layersJSON_keys = lj ? protoKeys(lj) : [];
    out.layersJSON_layersHash_count = lj?.layersHash ? Object.keys(lj.layersHash).length : null;
    // ベース判定 API
    out.isBaseLayer_fn = typeof w.GSI.GLOBALS?.isBaseLayer;
  }

  // ---- GSI3D / MA / MATEST ----
  for (const ns of ["GSI3D", "MA", "MATEST", "CONFIG"]) {
    const o = w[ns];
    if (!o) continue;
    out[`${ns}_keys`] = safeKeys(o).slice(0, 120);
  }
  return out;
});
console.log(JSON.stringify({
  href: result.href,
  GLOBE_keys: result.GLOBE_keys, GLOBE_MAP_own: result.GLOBE_MAP_own,
  viewer_present: result.viewer_present, viewer_path: result.viewer_path,
  GSI_keys_count: result.GSI_keys?.length, GLOBALS: result.GLOBALS_keys,
  mapLayerList_count: result.mapLayerList_tileList_count,
  layersHash_count: result.layersJSON_layersHash_count,
  GSI3D: result.GSI3D_keys?.slice(0, 30), MA: result.MA_keys?.slice(0, 30),
}, null, 1));

writeFileSync(`${OUT}gsi-globe-enum-${stamp}.json`, JSON.stringify(result, null, 2));
await page.screenshot({ path: `${OUT}gsi-audit-globe.png` });
console.log("WROTE", `gsi-globe-enum-${stamp}.json`);
await browser.close();
