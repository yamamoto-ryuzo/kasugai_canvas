import { chromium } from "file:///C:/devin/qgis_live_harness/node_modules/playwright/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push("err: " + m.text()); });
page.on("pageerror", e => errors.push("pageerror: " + String(e)));
page.on("requestfailed", r => { const u = r.url(); if (/pmtiles|tiles\.json|\.pbf|\.tif|\.mvt/.test(u)) errors.push("reqfail: " + u.slice(0, 140)); });
const url = "http://127.0.0.1:8510/openlayers/?kasc=" + encodeURIComponent("http://127.0.0.1:8510/verify/openlayers-audit.kasc");
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kascMap && window.kascMap.getLayers().getArray().length > 0, { timeout: 30000 });
// rendercomplete: 全タイル読込完了まで待つ(最大60s)
try {
  await page.evaluate(() => new Promise(res => {
    const map = window.kascMap;
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; res("timeout"); } }, 55000);
    map.once("rendercomplete", () => { if (!done) { done = true; clearTimeout(t); res("ok"); } });
  }));
} catch (e) {}
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const map = window.kascMap;
  const size = map.getSize();
  // 画面中央・複数ピクセルで MVT 地物ヒット確認
  const hits = [];
  for (const px of [[700, 450], [500, 400], [900, 500], [350, 600]]) {
    map.forEachFeatureAtPixel(px, (f, l) => { hits.push({ px, layer: l?.getSource?.()?.constructor?.name, layerName: f.get?.("layer"), props: Object.keys(f.getProperties?.() || {}).slice(0, 6) }); }, { hitTolerance: 6 });
  }
  const layers = map.getLayers().getArray().map(l => {
    const src = l.getSource?.();
    let tileInfo = null;
    try { if (src?.getTileCache) { const c = src.getTileCache(); tileInfo = { entries: c?.getCount?.() }; } } catch {}
    return { cls: l.constructor?.name, srcCls: src?.constructor?.name, visible: l.getVisible?.() };
  });
  return { size, layers, hits: hits.slice(0, 8), unsupported: document.querySelector("#unsupported")?.textContent || "" };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "C:/devin/kasugai_canvas/web/verify/results/ol-audit-mvt-geotiff.png" });
console.log("=== errors ===");
for (const e of errors.slice(0, 25)) console.log(e);
await browser.close();
