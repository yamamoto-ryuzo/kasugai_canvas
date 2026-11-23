import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const [engine, layer] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 900, height: 700 } });
await pg.goto(`http://127.0.0.1:8520/${engine}/?project=_qml_verify`, { waitUntil: "domcontentloaded", timeout: 30000 });
await pg.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0, undefined, { timeout: 90000, polling: 800 }).catch(() => {});
await pg.waitForTimeout(5000);
const r = await pg.evaluate(async (layer) => {
  const api = window.kasugaiApi;
  const ls = api.listLayers();
  const vis = [];
  for (const l of ls) {
    const t = String(l.title || l.id || "");
    if (t !== layer) api.setLayerVisible(t, false);
  }
  api.setLayerVisible(layer, true);
  await new Promise(r => setTimeout(r, 800));
  // 表示中レイヤを map から収集
  const map = window.map || window._map;
  const on = [];
  map?.eachLayer?.(l => {
    const cnt = { n: 0, gen: 0, polys: 0 };
    l.eachLayer?.(x => { if (x.feature) { cnt.n++; if (x.feature.properties?.__kasc_ggen) cnt.gen++; if (/Polygon/.test(x.feature.geometry?.type||"")) cnt.polys++; } });
    if (cnt.n) on.push(cnt);
  });
  const paths = document.querySelectorAll(".leaflet-overlay-pane path").length;
  const markers = document.querySelectorAll(".leaflet-marker-pane .leaflet-marker-icon").length;
  return { zoom: map?.getZoom?.(), onLayers: on, paths, markers, center: map?.getCenter?.() };
}, layer);
console.log(JSON.stringify(r, null, 1));
await browser.close();
