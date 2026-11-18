import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 300)));
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 120000 });
for (let i = 0; i < 25; i++) {
  const n = await page.evaluate(() => (window.kasugaiApi.listLayers() || []).length);
  if (n >= 7) { console.log("LAYERS:", n); break; }
  await page.waitForTimeout(3000);
}
const r = await page.evaluate(() => {
  const ds = window._viewer.dataSources;
  const dss = [];
  let total = 0;
  for (let i = 0; i < ds.length; i++) { const d = ds.get(i); const n = d.entities.values.length; total += n; if (n) dss.push((d.name || "?").slice(0, 40) + "=" + n); }
  return { layers: window.kasugaiApi.listLayers().map(l => l.type + ":" + l.title), dss, total };
});
console.log(JSON.stringify(r, null, 1).slice(0, 3000));
await page.screenshot({ path: "fmt-cesium.png" });
await browser.close();
