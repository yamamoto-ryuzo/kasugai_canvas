import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/sample_qgis/kasugai_canvas.kasc`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));
page.on("console", m => { if (/error/i.test(m.type())) console.log("[cerr]", m.text().slice(0, 160)); });
await page.goto(`${BASE}/maplibre/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, { timeout: 90000 });
await page.waitForTimeout(12000); // GPKG 読込を十分待つ
await page.evaluate(() => window.kasugaiApi.setBasemap("ベースマップなし"));
await page.waitForTimeout(1000);
// レイヤー一覧と描画状態を確認
const diag = await page.evaluate(() => {
  const layers = window.kasugaiApi.listLayers?.() || [];
  return layers.filter(l => /行政|区市|都道府/.test(l.title || "")).map(l => ({ title: l.title, type: l.type, visible: l.visible }));
});
console.log("LAYERS:", JSON.stringify(diag));
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 35.775, longitude: 139.805, zoom: 13.5, instant: true }));
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}adachi-ml-mid2.png` });
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 35.775, longitude: 139.805, zoom: 16.5, instant: true }));
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}adachi-ml-detail2.png` });
await browser.close();
console.log("done");
