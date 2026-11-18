// QML ギャップ実装のランタイム状態プローブ:
// 各エンジンでレイヤ/エンティティが期待どおり生成されたか検査する
import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";

const base = "http://127.0.0.1:8510";
const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 200)));

// --- MapLibre ---
await page.goto(`${base}/maplibre/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
const ml = await page.evaluate(() => {
  const map = window.kascMap;
  if (!map) return { err: "no map global" };
  const layers = map.getStyle().layers.map(l => ({ id: l.id, type: l.type,
    icon: l.layout?.["icon-image"], pat: l.paint?.["line-pattern"],
    src: l.source }));
  const imgs = map.listImages ? map.listImages() : [];
  return {
    nLayers: layers.length,
    qmlLayers: layers.filter(l => /markerline|rasterline|mapunit|inverted|heat|cluster|d25|kasc/i.test(l.id)),
    images: imgs,
  };
});
console.log("=== maplibre ===");
console.log(JSON.stringify(ml, null, 1).slice(0, 4000));

// --- Cesium ---
await page.goto(`${base}/cesium/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
const cz = await page.evaluate(() => {
  const ds = window._viewer?.dataSources;
  const out = { sources: [], mapunit: null, rasterline: null };
  if (!ds) return { err: "no viewer" };
  for (let i = 0; i < ds.length; i++) {
    const d = ds.get(i);
    const info = { name: d.name || "?", n: d.entities.values.length,
      kinds: {} };
    let muBillboard = null, rlEntity = null, decorCount = 0;
    for (const e of d.entities.values) {
      const g = e.billboard ? "billboard" : e.polyline ? "polyline" : e.polygon ? "polygon" : e.label ? "label" : "other";
      info.kinds[g] = (info.kinds[g] || 0) + 1;
      if (e._qmlMapUnits) muBillboard = { mu: Object.keys(e._qmlMapUnits), scale: e.billboard?.scale?.getValue?.() ?? e.billboard?.scale };
      if (e.polyline?.material?.getValue?.()?.image || e.polyline?.material?.image) rlEntity = "has-image-material";
      if (e._qmlDecor) decorCount++;
    }
    info.mapunit = muBillboard;
    info.decorCount = decorCount;
    out.sources.push(info);
  }
  return out;
});
console.log("=== cesium ===");
console.log(JSON.stringify(cz, null, 1).slice(0, 4000));

// MapUnit スケーリング: カメラ距離を変えて scale が変わるか
const czScale = await page.evaluate(async () => {
  const viewer = window._viewer;
  if (!viewer) return { err: "no viewer" };
  let e0 = null;
  for (let i = 0; i < viewer.dataSources.length; i++) {
    for (const e of viewer.dataSources.get(i).entities.values) {
      if (e._qmlMapUnits?.billboard != null && e.billboard) { e0 = e; break; }
    }
    if (e0) break;
  }
  if (!e0) return { err: "no mapunit billboard entity" };
  const s1 = e0.billboard.scale?.getValue?.() ?? e0.billboard.scale;
  const cam = viewer.camera;
  const c0 = cam.positionCartographic.clone();
  cam.setView({ destination: Cesium.Cartesian3.fromRadians(c0.longitude, c0.latitude, c0.height / 4) });
  await new Promise(r => setTimeout(r, 800));
  const s2 = e0.billboard.scale?.getValue?.() ?? e0.billboard.scale;
  cam.setView({ destination: Cesium.Cartesian3.fromRadians(c0.longitude, c0.latitude, c0.height * 2) });
  await new Promise(r => setTimeout(r, 800));
  const s3 = e0.billboard.scale?.getValue?.() ?? e0.billboard.scale;
  return { s1, s2, s3 };
});
console.log("=== cesium mapunit scale (h/4, h*2) ===");
console.log(JSON.stringify(czScale));

// --- Leaflet ---
await page.goto(`${base}/leaflet/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);
const lf = await page.evaluate(() => {
  const map = window.kascMap;
  const out = { heatLayers: 0, clusterGroups: 0, geojsonLayers: 0 };
  if (!map) return { err: "no map global", keys: Object.keys(window).filter(k => /map/i.test(k)) };
  map.eachLayer(l => {
    if (l instanceof L.HeatLayer || l._heat) out.heatLayers++;
    else if (l._markerCluster || l instanceof L.MarkerClusterGroup) out.clusterGroups++;
    else if (l instanceof L.GeoJSON) out.geojsonLayers++;
  });
  return out;
});
console.log("=== leaflet ===");
console.log(JSON.stringify(lf));

// --- OpenLayers ---
await page.goto(`${base}/openlayers/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);
const ol = await page.evaluate(() => {
  const map = window.kascMap;
  const out = { layers: [] };
  if (!map) return { err: "no map global" };
  map.getLayers().forEach(l => {
    const src = l.getSource?.();
    out.layers.push({ cls: l.constructor.name, src: src?.constructor?.name });
  });
  return out;
});
console.log("=== openlayers ===");
console.log(JSON.stringify(ol));

// --- Navara ---
await page.goto(`${base}/navara/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);
const nv = await page.evaluate(() => {
  const view = window.kascView;
  return { globals: Object.keys(window).filter(k => /navara|three|view/i.test(k)).slice(0, 15) };
});
console.log("=== navara globals ===");
console.log(JSON.stringify(nv));
await page.screenshot({ path: "C:/devin/kasugai_canvas/test-results/qml-verify/shots-gaps/navara.png" });

await browser.close();
