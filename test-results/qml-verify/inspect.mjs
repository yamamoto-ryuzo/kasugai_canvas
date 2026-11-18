import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// --- MapLibre ---
await page.goto("http://127.0.0.1:8510/maplibre/?project=qml-verify", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
const ml = await page.evaluate(() => {
  const map = window.map || window._map || window.mlmap;
  if (!map) return { err: "no map global", keys: Object.keys(window).filter(k => /map/i.test(k)) };
  const layers = map.getStyle().layers.filter(l => /qml|kasc|trim|dash|glow/i.test(JSON.stringify(l)));
  const srcs = Object.keys(map.getStyle().sources);
  const trimSrc = srcs.find(s => /trim/i.test(s));
  const feats = trimSrc ? map.querySourceFeatures(trimSrc) : [];
  return {
    globals: Object.keys(window).filter(k => /map/i.test(k)),
    layerIds: layers.map(l => ({ id: l.id, type: l.type, src: l.source, paint: l.paint })),
    srcs, trimFeatCount: feats.length,
    trimCoords: feats.map(f => f.geometry.coordinates),
  };
});
console.log("ML", JSON.stringify(ml, null, 1).slice(0, 4000));
await browser.close();
