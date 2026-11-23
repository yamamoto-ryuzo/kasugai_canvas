import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const [engine, layer, w, s, e, n, out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
pg.on("pageerror", e2 => errors.push(String(e2)));
await pg.goto(`http://127.0.0.1:8520/${engine}/?project=_qml_verify`, { waitUntil: "domcontentloaded", timeout: 30000 });
await pg.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0 || window._viewer, undefined, { timeout: 90000, polling: 800 }).catch(() => {});
await pg.waitForTimeout(5000);
await pg.evaluate(async ({ layer }) => {
  const api = window.kasugaiApi;
  for (const l of api?.listLayers?.() || []) {
    const t = String(l.title || l.id || "");
    if (t !== layer) api.setLayerVisible(t, false);
  }
  api.setLayerVisible(layer, true);
}, { layer });
await pg.waitForTimeout(500);
await pg.evaluate(async ({ w, s, e, n }) => { try { window.kasugaiApi.fitBoundsView?.(+w, +s, +e, +n); } catch (_) {} }, { w, s, e, n });
await pg.waitForTimeout(3000);
await pg.screenshot({ path: out || `_zoom_${engine}_${layer}.png` });
console.log(JSON.stringify({ errors }));
await browser.close();
