import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const b = await chromium.launch({ channel: "chrome", headless: true });
const pg = await b.newPage({ viewport: { width: 1514, height: 913 } });
await pg.goto("http://127.0.0.1:8510/gsimaps/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(12000);
const r = await pg.evaluate(() => {
  const api = window.kasugaiApi;
  const out = { api: !!api };
  if (api?.listLayers) out.layers = api.listLayers().slice(0, 5).map(l => l.name || l.id || l);
  out.layerCount = api?.listLayers?.().length;
  // find the leaflet-like map internals
  const g = window.gmap || window._gmap || window.map;
  out.gmapType = g ? g.constructor?.name : null;
  if (g?._layers) {
    const kinds = {};
    for (const k in g._layers) { const L = g._layers[k]; kinds[L.constructor?.name || "?"] = (kinds[L.constructor?.name || "?"] || 0) + 1; }
    out.layerKinds = kinds;
  }
  if (api?.getCamera) out.cam = api.getCamera();
  return out;
});
console.log(JSON.stringify(r, null, 1).slice(0, 2500));
await pg.screenshot({ path: "probe-gsimaps.png" });
await b.close();
