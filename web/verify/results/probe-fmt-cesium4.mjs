import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/extrude_test/extrude_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("console", m => { const t = m.text(); console.log("[con]", t.slice(0, 200)); });
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 300)));
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 120000 });
for (let i = 0; i < 20; i++) {
  const n = await page.evaluate(() => (window.kasugaiApi.listLayers() || []).length);
  if (n > 0) { console.log("LAYERS:", n); break; }
  await page.waitForTimeout(3000);
}
console.log(JSON.stringify(await page.evaluate(() => window.kasugaiApi.listLayers().map(l => l.type + ":" + l.title))));
await browser.close();
