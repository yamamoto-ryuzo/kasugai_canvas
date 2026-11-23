import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const [engine, layer] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 900, height: 700 } });
await pg.goto(`http://127.0.0.1:8520/${engine}/?project=_qml_verify`, { waitUntil: "domcontentloaded", timeout: 30000 });
await pg.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0, undefined, { timeout: 90000, polling: 800 }).catch(() => {});
await pg.waitForTimeout(5000);
const r = await pg.evaluate(async (layer) => {
  const api = window.kasugaiApi;
  for (const l of api.listLayers()) {
    const t = String(l.title || l.id || "");
    if (t !== layer) api.setLayerVisible(t, false);
  }
  api.setLayerVisible(layer, true);
  await new Promise(r => setTimeout(r, 800));
  // Leaflet map を内部レイヤ経由で発見
  let map = null;
  const probe = document.querySelector("#map");
  if (probe && probe._leaflet_id) {
    // L.Map インスタンスは DOM イベント経由で握れないため、グローバル探索
  }
  for (const k of Object.getOwnPropertyNames(window)) {
    try { const v = window[k]; if (v && v._layers && v.eachLayer && v.getCenter && v.getZoom) { map = v; break; } } catch (_) {}
  }
  const domPaths = document.querySelectorAll("#map svg path").length;
  const domMarkers = document.querySelectorAll("#map .leaflet-marker-icon").length;
  if (!map) return { map: false, domPaths, domMarkers };
  let mapObj = null; try { mapObj = { zoom: map.getZoom(), c: [map.getCenter().lng.toFixed(3), map.getCenter().lat.toFixed(3)] }; } catch (_) {}
  const on = [];
  map.eachLayer(l => {
    const cnt = { n: 0, gen: 0 };
    try { l.eachLayer?.(x => { if (x.feature) { cnt.n++; if (x.feature.properties?.__kasc_ggen) cnt.gen++; } }); } catch (_) {}
    if (cnt.n) on.push(cnt);
  });
  return { map: mapObj, onLayers: on, domPaths, domMarkers };
}, layer);
console.log(JSON.stringify(r, null, 1));
await browser.close();
