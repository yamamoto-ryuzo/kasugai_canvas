import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/sample_qgis/kasugai_canvas.kasc`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, undefined, { timeout: 120000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.kasugaiApi.setBasemap("ベースマップなし"));
const labelInfo = () => page.evaluate(() => {
  const viewer = window.kasugaiApi.getViewer?.() || window._viewer;
  const out = [];
  for (const ds of viewer.dataSources._dataSources) {
    for (const e of ds.entities.values) {
      const t = e.label?.text?.getValue?.();
      if (!t) continue;
      const n4 = (() => { try { return e.properties?.N03_004?.getValue?.(); } catch (_) { return null; } })();
      out.push({ text: t, n4, show: e.label.show?.getValue?.(), font: e.label.font?.getValue?.() });
    }
  }
  return out;
});
for (const [name, height] of [["wide", 120000], ["mid", 35000], ["detail", 3500]]) {
  await page.evaluate(h => window.kasugaiApi.flyTo({ latitude: 35.775, longitude: 139.805, height: h, instant: true }), height);
  await page.waitForTimeout(3500); // 再クエリ+declutter 待ち
  const labels = await labelInfo();
  const adachi = labels.filter(l => /足立区/.test(l.text));
  console.log(`--- ${name} (labels:${labels.length} adachi:${adachi.length})`);
  for (const a of adachi.slice(0, 3)) console.log("   ", JSON.stringify(a));
  await page.screenshot({ path: `${OUT}adachi-cesium-${name}2.png` });
}
await browser.close();
console.log("done");
