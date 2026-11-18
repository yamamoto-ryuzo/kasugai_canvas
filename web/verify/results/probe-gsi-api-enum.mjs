// gsimaps エンジン API サーフェス実行時列挙 (engine-gsimaps 監査 Phase B)
// 2D (vendored index_pm.html iframe) と Globe (enterGlobe後) の両方で GSI.* を列挙
// 出力: gsi-api-enum-YYYYMMDD.json / スクリーンショット
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const result = { date: new Date().toISOString() };

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 160)));

const safeKeys = o => { try { return Object.keys(o); } catch { return []; } };
const protoKeys = o => {
  try {
    const s = new Set();
    let p = o;
    while (p && p !== Object.prototype) {
      for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor") s.add(n);
      p = Object.getPrototypeOf(p);
    }
    return [...s];
  } catch { return []; }
};

// ---- 2D 列挙 ----
await page.goto(`${BASE}/gsimaps/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const f = document.getElementById("gsi-frame");
  return f?.contentWindow?.GSI?.GLOBALS?.gsimaps?._mainMap;
}, { timeout: 120000 });
await page.waitForTimeout(5000);

result.d2 = await page.evaluate(({ safeKeysSrc, protoKeysSrc }) => {
  const safeKeys = eval(`(${safeKeysSrc})`);
  const protoKeys = eval(`(${protoKeysSrc})`);
  const w = document.getElementById("gsi-frame").contentWindow;
  const G = w.GSI, g = G.GLOBALS, gm = g.gsimaps;
  const out = {};
  out.GSI_keys = safeKeys(G);
  // GSI の各エントリの型分類
  out.GSI_types = {};
  for (const k of out.GSI_keys) {
    try { out.GSI_types[k] = typeof G[k]; } catch { out.GSI_types[k] = "<throw>"; }
  }
  out.GLOBALS_keys = safeKeys(g);
  out.mainMap_keys = gm?._mainMap ? safeKeys(gm._mainMap) : [];
  out.mapLayerList_keys = gm?._mainMap?._mapLayerList ? protoKeys(gm._mainMap._mapLayerList) : [];
  out.layersJSON_keys = gm?._mainMap?._layersJSON ? protoKeys(gm._mainMap._layersJSON) : [];
  out.mapMenu_keys = gm?._mainMap?._mapMenu ? protoKeys(gm._mainMap._mapMenu) : [];
  out.sakuzuList_keys = gm?._mainMap?._sakuzuList ? protoKeys(gm._mainMap._sakuzuList) : [];
  // layersJSON スキーマ: 先頭エントリの構造
  try {
    const lh = gm?._mainMap?._layersJSON?.layersHash || g.layersJSON?.layersHash || {};
    const first = Object.values(lh)[0];
    out.layersHash_count = Object.keys(lh).length;
    out.layersHash_sample_keys = first ? safeKeys(first) : [];
    out.layersHash_sample = first ? JSON.parse(JSON.stringify(first, (k, v) => typeof v === "function" ? "<fn>" : v, 0)) : null;
  } catch (e) { out.layersHash_err = String(e).slice(0, 120); }
  // ベースレイヤ情報
  try {
    const bl = gm?._mainMap?._baseLayer;
    out.baseLayer_keys = bl ? protoKeys(bl) : [];
    out.baseLayer_ids = bl?._list ? Object.keys(bl._list) : (bl?.list ? Object.keys(bl.list) : []);
  } catch (e) { out.baseLayer_err = String(e).slice(0, 120); }
  // CONFIG
  out.CONFIG_keys = safeKeys(w.CONFIG);
  // GSI 関数クラスのうちインスタンス化可能なもののプロトタイプ面（主要なもののみ）
  const probeClasses = ["ElevationLoader", "CrossSectionView", "CrossSectionViewDialog",
    "MeasureDialog", "DrawManager", "EditManager", "Searcher", "KML", "GeoJSON",
    "CSVLoadDialog", "VectorTileLayer", "GeoTIFFImageOverlay", "COCOTileLayer",
    "MapCompareSeparater", "PagePrinter", "MapToImage", "ShareDialog", "LocationWatcher",
    "LatLngGrid", "ChiikiMesh", "UTM", "TileGridLayer", "EvacDialog", "SakuzuList",
    "SakuzuDialog", "LayerOpacitySetter", "FooterElevationLoader", "DEMLoader",
    "CrossSectionDEMLoader", "LakeDataLoader", "LakeDepthLoader", "LocalFileLoader",
    "MultiLayer", "GeoJpegMarker", "MapMouse", "MiniMap", "GPS", "AddrLoader"];
  out.classProtos = {};
  for (const name of probeClasses) {
    const c = G[name];
    if (typeof c !== "function") { out.classProtos[name] = null; continue; }
    try { out.classProtos[name] = protoKeys(c.prototype); } catch { out.classProtos[name] = "<no proto>"; }
  }
  return out;
}, { safeKeysSrc: safeKeys.toString(), protoKeysSrc: protoKeys.toString() });
console.log("2D: GSI keys =", result.d2.GSI_keys.length, "| GLOBALS =", result.d2.GLOBALS_keys.length);
await page.screenshot({ path: `${OUT}gsi-audit-2d.png` });

// ---- Globe 列挙 (enterGlobe 経由) ----
try {
  const globeOn = await page.evaluate(() => {
    try { return window.kasugaiApi?.setGsiGlobe?.(true)?.globe === true; }
    catch (e) { return String(e); }
  });
  console.log("setGsiGlobe(true):", globeOn);
  await page.waitForFunction(() => {
    const f = document.getElementById("gsi-frame");
    return f?.contentWindow?.GSI?.GLOBALS?.mapLayerList;
  }, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(8000);
  result.globe = await page.evaluate(({ safeKeysSrc, protoKeysSrc }) => {
    const safeKeys = eval(`(${safeKeysSrc})`);
    const protoKeys = eval(`(${protoKeysSrc})`);
    const w = document.getElementById("gsi-frame").contentWindow;
    const G = w.GSI;
    if (!G) return { error: "no GSI in globe frame" };
    const g = G.GLOBALS;
    const out = {};
    out.GSI_keys = safeKeys(G);
    out.GLOBALS_keys = g ? safeKeys(g) : [];
    out.GLOBALS_types = {};
    if (g) for (const k of out.GLOBALS_keys) {
      try { out.GLOBALS_types[k] = typeof g[k]; } catch { out.GLOBALS_types[k] = "<throw>"; }
    }
    out.mapLayerList_keys = g?.mapLayerList ? protoKeys(g.mapLayerList) : [];
    out.layersJSON_keys = g?.layersJSON ? protoKeys(g.layersJSON) : [];
    // globe 側の Cesium viewer
    try {
      out.globe_keys = safeKeys(w.gsi?.globe ?? {});
      const viewer = w.gsi?.globe?.viewer || w.gsiGlobe?.viewer;
      out.viewer_present = !!viewer;
      if (viewer) out.viewer_keys = protoKeys(viewer).filter(k => !k.startsWith("_")).slice(0, 80);
    } catch (e) { out.viewer_err = String(e).slice(0, 120); }
    // 2D との差分用に gsimaps 参照の有無
    out.gsimaps_present = !!g?.gsimaps;
    return out;
  }, { safeKeysSrc: safeKeys.toString(), protoKeysSrc: protoKeys.toString() });
  console.log("globe: GSI keys =", result.globe.GSI_keys?.length, "| GLOBALS =", result.globe.GLOBALS_keys?.length);
  await page.screenshot({ path: `${OUT}gsi-audit-globe.png` });
  // 2D↔Globe の GLOBALS 差分
  if (result.d2?.GLOBALS_keys && result.globe?.GLOBALS_keys) {
    const a = new Set(result.d2.GLOBALS_keys), b = new Set(result.globe.GLOBALS_keys);
    result.globeDiff = {
      onlyIn2D: [...a].filter(k => !b.has(k)),
      onlyInGlobe: [...b].filter(k => !a.has(k)),
    };
  }
} catch (e) {
  result.globe = { error: String(e).slice(0, 200) };
  console.log("globe FAILED:", String(e).slice(0, 150));
}

writeFileSync(`${OUT}gsi-api-enum-${stamp}.json`, JSON.stringify(result, null, 2));
console.log("WROTE", `gsi-api-enum-${stamp}.json`);
await browser.close();
