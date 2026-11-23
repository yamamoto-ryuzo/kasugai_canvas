// gsimaps 内部 L.GeoJSON の生成地物数を iframe 経由で集計
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage();
const errors = [];
pg.on("pageerror", e => errors.push(String(e)));
await pg.goto("http://127.0.0.1:8520/gsimaps/?project=_qml_verify", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(9000);
const out = await pg.evaluate(() => {
  const res = {};
  // sakuzuList items → layer._leafletLayer or stored L.GeoJSON
  const ifr = document.querySelector("iframe");
  const iw = ifr?.contentWindow;
  if (!iw) return { err: "no iframe" };
  iw.document.querySelectorAll(".leaflet-tooltip").length;
  // internal map
  let map = null;
  for (const k of Object.keys(iw)) {
    try { const v = iw[k]; if (v && v._layers && v.eachLayer && v.getCenter) { map = v; break; } } catch (_) {}
  }
  if (!map) return { err: "no map", keys: Object.keys(iw).slice(0, 40) };
  let total = 0, gen = 0, tooltips = 0;
  const kinds = {};
  map.eachLayer(l => {
    if (l.eachLayer) l.eachLayer(x => {
      if (x.feature) {
        total++;
        if (x.feature.properties?.__kasc_ggen) { gen++; kinds[x.feature.geometry?.type] = (kinds[x.feature.geometry?.type]||0)+1; }
      }
    });
    if (l.getTooltip?.()?.options?.permanent) tooltips++;
  });
  return { total, gen, kinds, tooltips };
});
console.log(JSON.stringify(out), "errors:", errors.length ? errors : "none");
await browser.close();
