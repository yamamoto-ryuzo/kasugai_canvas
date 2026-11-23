// _solo_shot.mjs <engine> <layer> [out.png] — 単層 solo + 層bbox fit + 撮影
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
const [engine, layer, out] = process.argv.slice(2);
const g = JSON.parse(readFileSync(`C:/devin/kasugai_canvas/web/projects/_qml_verify/canvas_data/${layer}.geojson`, "utf8"));
const bb = [999, 999, -999, -999];
const w = c => { if (typeof c[0] === "number") { bb[0] = Math.min(bb[0], c[0]); bb[1] = Math.min(bb[1], c[1]); bb[2] = Math.max(bb[2], c[0]); bb[3] = Math.max(bb[3], c[1]); } else c.forEach(w); };
for (const f of g.features) w(f.geometry.coordinates);
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
pg.on("pageerror", e => errors.push(String(e)));
await pg.goto(`http://127.0.0.1:8520/${engine}/?project=_qml_verify`, { waitUntil: "domcontentloaded", timeout: 30000 });
await pg.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0 || window._viewer, undefined, { timeout: 90000, polling: 800 }).catch(() => {});
await pg.waitForTimeout(5000);
const r = await pg.evaluate(async ({ layer, bb }) => {
  const api = window.kasugaiApi;
  const ls = api?.listLayers?.() || [];
  let hid = 0;
  for (const l of ls) {
    const t = String(l.title || l.id || "");
    if (t === layer) continue;
    if (api.setLayerVisible(t, false)) hid++;
  }
  api.setLayerVisible(layer, true);
  await new Promise(r => setTimeout(r, 600));
  try { api.fitBoundsView?.(bb[0], bb[1], bb[2], bb[3]); } catch (_) {}
  return { total: ls.length, hid };
}, { layer, bb });
await pg.waitForTimeout(3500);
await pg.screenshot({ path: out || `_solo_${engine}_${layer}.png` });
console.log(JSON.stringify({ ...r, errors }));
await browser.close();
