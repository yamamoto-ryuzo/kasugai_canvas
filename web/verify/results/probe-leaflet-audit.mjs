// engine-leaflet 監査 Phase E: 実装したオプション群の実 DOM/実レイヤ検証
// 使い方: node web/verify/results/probe-leaflet-audit.mjs  (サーバー :8510 起動中)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/verify/leaflet-audit/audit.kasc`);
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(`${OUT}leaflet-audit`, { recursive: true });
const result = { checks: {}, errors: [] };
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => result.errors.push(String(e).slice(0, 200)));

await page.goto(`${BASE}/leaflet/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.L && window.kascMap && window.kasugaiApi, { timeout: 90000 });
await page.waitForTimeout(3000);

// ---- 1. cluster-qml (QML pointCluster tolerance=8MM → maxClusterRadius≈30, divIcon) ----
result.checks.clusterQml = await page.evaluate(async () => {
  await new Promise(r => setTimeout(r, 800)); // lazy plugin load 待ち
  const groups = [];
  window.kascMap.eachLayer(l => { if (l instanceof L.MarkerClusterGroup) groups.push(l); });
  const g = groups[0];
  if (!g) return { ok: false, reason: "no MarkerClusterGroup on map" };
  const icon = g.options.iconCreateFunction?.({ getChildCount: () => 42, getAllChildMarkers: () => [] });
  return {
    ok: true,
    maxClusterRadius: g.options.maxClusterRadius,
    iconIsDivIcon: icon instanceof L.DivIcon,
    iconHtml: icon?.options?.html?.slice(0, 120) || "",
    childMarkerCount: g.getLayers().length,
    coverage: g.options.showCoverageOnHover,
  };
});
await page.screenshot({ path: `${OUT}leaflet-audit/cluster-qml.png` });

// ---- 2. cluster-opts (opts 上書き) ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("cluster-qml", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("cluster-opts", true));
await page.waitForTimeout(1500);
result.checks.clusterOpts = await page.evaluate(() => {
  let g = null;
  window.kascMap.eachLayer(l => { if (l instanceof L.MarkerClusterGroup) g = l; });
  if (!g) return { ok: false };
  return {
    ok: true,
    maxClusterRadius: g.options.maxClusterRadius,
    disableClusteringAtZoom: g.options.disableClusteringAtZoom,
    showCoverageOnHover: g.options.showCoverageOnHover,
  };
});
await page.screenshot({ path: `${OUT}leaflet-audit/cluster-opts.png` });

// ---- 3. heat-opts ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("cluster-opts", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("heat-opts", true));
await page.waitForTimeout(1500);
result.checks.heatOpts = await page.evaluate(() => {
  let h = null;
  window.kascMap.eachLayer(l => { if (l instanceof L.HeatLayer) h = l; });
  if (!h) return { ok: false };
  return {
    ok: true,
    radius: h.options.radius, blur: h.options.blur,
    minOpacity: h.options.minOpacity, maxZoom: h.options.maxZoom,
    gradient: h.options.gradient,
    intensity1: h._latlngs?.[0]?.[2],
  };
});
await page.screenshot({ path: `${OUT}leaflet-audit/heat-opts.png` });

// ---- 4. heat-qml (ramp/radius QML 引継ぎ) ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("heat-opts", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("heat-qml", true));
await page.waitForTimeout(1500);
result.checks.heatQml = await page.evaluate(() => {
  let h = null;
  window.kascMap.eachLayer(l => { if (l instanceof L.HeatLayer) h = l; });
  if (!h) return { ok: false };
  return { ok: true, radius: h.options.radius, gradient: h.options.gradient };
});
await page.screenshot({ path: `${OUT}leaflet-audit/heat-qml.png` });

// ---- 5. heat-qml-w (weight_expression="w" → 強度正規化) ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("heat-qml", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("heat-qml-w", true));
await page.waitForTimeout(1500);
result.checks.heatQmlW = await page.evaluate(() => {
  let h = null;
  window.kascMap.eachLayer(l => { if (l instanceof L.HeatLayer) h = l; });
  if (!h) return { ok: false };
  const ints = (h._latlngs || []).map(p => p[2]);
  return { ok: true, min: Math.min(...ints), max: Math.max(...ints), first3: ints.slice(0, 3) };
});

// ---- 6. path-opts (fillrule/classname/smoothfactor/noclip) ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("heat-qml-w", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("path-opts", true));
await page.waitForTimeout(1200);
result.checks.pathOpts = await page.evaluate(() => {
  const paths = [...document.querySelectorAll("#map svg path")];
  const mine = paths.filter(p => (p.getAttribute("class") || "").includes("my-poly"));
  let geo = null;
  window.kascMap.eachLayer(l => { if (l instanceof L.GeoJSON) geo = geo || l; });
  const sub = [];
  // path-opts レイヤのサブレイヤを pane 経由で探す: className 付き path の owner
  const found = mine.map(p => ({
    fillRule: p.getAttribute("fill-rule") || p.style.fillRule || null,
    cls: p.getAttribute("class"),
  }));
  return { ok: true, paths: found, count: mine.length };
});
await page.screenshot({ path: `${OUT}leaflet-audit/path-opts.png` });

// smoothFactor/noClip は Path options — 該当 GeoJSON のサブレイヤ options を直接確認
result.checks.pathOptsOptions = await page.evaluate(() => {
  const out = [];
  window.kascMap.eachLayer(l => {
    if (l instanceof L.GeoJSON) {
      l.eachLayer(s => {
        const cls = s.getElement?.()?.getAttribute?.("class") || "";
        if (cls.includes("my-poly")) out.push({ smoothFactor: s.options.smoothFactor, noClip: s.options.noClip, fillRule: s.options.fillRule });
      });
    }
  });
  return out;
});

// ---- 7. canvas-renderer ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("path-opts", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("canvas-renderer", true));
await page.waitForTimeout(1200);
result.checks.canvasRenderer = await page.evaluate(() => {
  let n = 0;
  window.kascMap.eachLayer(l => {
    if (l instanceof L.GeoJSON) {
      l.eachLayer(s => {
        if (s.options?.renderer && s.options.renderer instanceof L.Canvas) n++;
      });
    }
  });
  const canvases = document.querySelectorAll("#map canvas.leaflet-zoom-animated");
  return { canvasPaths: n, canvasEls: canvases.length };
});
await page.screenshot({ path: `${OUT}leaflet-audit/canvas-renderer.png` });

// ---- 8. tile-opts / image-opts ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("canvas-renderer", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("tile-opts", true));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("image-opts", true));
await page.waitForTimeout(1500);
result.checks.tileImageOpts = await page.evaluate(() => {
  const out = {};
  window.kascMap.eachLayer(l => {
    if (l instanceof L.TileLayer && !(l instanceof L.TileLayer.WMS)) {
      out.tile = { tms: l.options.tms, zoomOffset: l.options.zoomOffset, noWrap: l.options.noWrap,
        subdomains: l.options.subdomains, zIndex: l.options.zIndex, referrerPolicy: l.options.referrerPolicy };
    }
    if (l instanceof L.ImageOverlay) {
      out.image = { alt: l.options.alt, interactive: l.options.interactive,
        crossOrigin: l.options.crossOrigin, zIndex: l.options.zIndex,
        elAlt: l.getElement?.()?.getAttribute("alt") };
    }
  });
  return out;
});

// ---- 9. URL パラメータ → Map options ----
await page.goto(`${BASE}/leaflet/?kasc=${KASC}&zoomsnap=0.5&zoomdelta=0.5&minzoom=5&maxzoom=14&maxbounds=139,35,140,36&worldcopyjump=1&prefercanvas=1`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kascMap, { timeout: 90000 });
await page.waitForTimeout(1200);
result.checks.mapOpts = await page.evaluate(() => {
  const o = window.kascMap.options;
  return {
    zoomSnap: o.zoomSnap, zoomDelta: o.zoomDelta, minZoom: o.minZoom, maxZoom: o.maxZoom,
    maxBounds: o.maxBounds ? [[o.maxBounds.getSouth(), o.maxBounds.getWest()], [o.maxBounds.getNorth(), o.maxBounds.getEast()]] : null,
    worldCopyJump: o.worldCopyJump, preferCanvas: o.preferCanvas,
    wheelPxPerZoomLevel: o.wheelPxPerZoomLevel,
  };
});
await page.screenshot({ path: `${OUT}leaflet-audit/mapopts.png` });

writeFileSync(`${OUT}leaflet-audit/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
