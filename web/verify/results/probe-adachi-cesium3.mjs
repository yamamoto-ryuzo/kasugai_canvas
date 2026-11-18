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
const dump = () => page.evaluate(() => {
  const viewer = window.kasugaiApi.getViewer?.() || window._viewer;
  const dss = viewer.dataSources._dataSources;
  const out = { dss: [], labels: [] };
  for (const ds of dss) {
    const ents = [...ds.entities.values];
    const nl = ents.filter(e => e.label).length;
    const np = ents.filter(e => e.polygon).length;
    if (ents.length) out.dss.push(`${ents.length}e/${np}poly/${nl}lab/${(ds._qmlLabels||[]).length}cand`);
    for (const e of ents) {
      const t = e.label?.text?.getValue?.();
      if (t) out.labels.push({ text: t, show: e.label.show?.getValue?.(), font: e.label.font?.getValue?.() });
    }
  }
  return out;
});
for (const [name, height] of [["wide", 120000], ["mid", 35000], ["detail", 3500]]) {
  await page.evaluate(h => window.kasugaiApi.flyTo({ latitude: 35.775, longitude: 139.805, height: h, pitch: -90, heading: 0, instant: true }), height);
  await page.waitForTimeout(8000);
  const info = await dump();
  console.log(`--- ${name}: ${JSON.stringify(info.dss)}`);
  console.log(`    labels: ${JSON.stringify(info.labels.slice(0, 12))}`);
  await page.screenshot({ path: `${OUT}adachi-cesium-${name}2.png` });
}
await browser.close();
console.log("done");
