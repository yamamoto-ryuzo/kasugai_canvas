import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://localhost:8520";
const browser = await chromium.launch();
const pg = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
pg.on("pageerror", e => errors.push(String(e)));
await pg.goto(`${BASE}/cesium/?kasc=${encodeURIComponent(`${BASE}/projects/_primtest/kasugai_canvas.kasc`)}`, { waitUntil: "domcontentloaded" });
await pg.waitForFunction(() => window.kasugaiApi?.isReady === true, undefined, { timeout: 120000, polling: 800 }).catch(() => {});
await pg.waitForFunction(() => {
  const v = window._viewer; if (!v) return false;
  let n = 0; v.scene.primitives?.length && (() => { for (let i = 0; i < v.scene.primitives.length; i++) { const p = v.scene.primitives.get(i); if (p instanceof Cesium.GeoJsonPrimitive) n++; } })();
  return n >= 10;
}, undefined, { timeout: 120000, polling: 800 }).catch(() => {});
await pg.waitForTimeout(3000);
const out = await pg.evaluate(async () => {
  const api = window.kasugaiApi, v = window._viewer;
  const layers = api.listLayers();
  const cat = layers.find(l => String(l.title ?? "").includes("Cat-prim"));
  if (!cat) return { err: "Cat-prim not found", layers: layers.map(l => l.title) };
  const it = api._item ? null : null;
  // decor ds for Cat-prim
  const decorOf = (id) => {
    for (let i = 0; i < v.scene.primitives.length; i++) {
      const p = v.scene.primitives.get(i);
      if (p._kasugaiLayerId === id && p._decorDs) return p._decorDs;
    }
    return null;
  };
  const id = cat.id ?? cat.name;
  const d0 = decorOf(id);
  const c0 = d0 ? d0.entities.values.length : -1;
  const r = await api.setLayerFilter(id, "cat = 'Z'");
  await new Promise(res => setTimeout(res, 6000));
  const d1 = decorOf(id);
  const c1 = d1 ? d1.entities.values.length : -1;
  // prim feature count (batched) — check _decorDs and primitives count
  let primFound = 0;
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p._kasugaiLayerId === id) primFound++;
  }
  // clear filter
  await api.setLayerFilter(id, null);
  await new Promise(res => setTimeout(res, 6000));
  const d2 = decorOf(id);
  const c2 = d2 ? d2.entities.values.length : -1;
  return { c0, c1, c2, r, primFound };
});
console.log(JSON.stringify(out, null, 1));
console.log("errors:", errors.length);
await browser.close();
