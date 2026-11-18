import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/maplibre/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi, { timeout: 60000 });
const r = await page.evaluate(async () => {
  const { loadCompiledQml, maplibreApplyQml } = await import("../shared/qml-2d.js");
  const compiled = await loadCompiledQml("DATA/layer_cat.qml", `${location.origin}/projects/sample_qgis/`);
  const gj = { type: "FeatureCollection", features: [{
    type: "Feature",
    properties: { N03_004: "足立区" },
    geometry: { type: "Polygon", coordinates: [[[139.79,35.76],[139.82,35.76],[139.82,35.79],[139.79,35.79],[139.79,35.76]]] },
  }]};
  const applied = maplibreApplyQml(gj, compiled);
  const feat = applied.geojson?.features?.[0] || gj.features[0];
  const labelProps = Object.keys(feat.properties).filter(k => k.startsWith("__kasc"));
  return {
    kinds: applied.kinds.map(k => ({ kind: k[0], filter: JSON.stringify(k[1]).slice(0,80), paint: JSON.stringify(k[2]).slice(0,200), layout: JSON.stringify(k[3]||{}).slice(0,200) })),
    kascProps: labelProps.map(k => `${k}=${JSON.stringify(feat.properties[k]).slice(0,60)}`),
  };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
