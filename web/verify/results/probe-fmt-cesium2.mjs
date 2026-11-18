import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 300)));
page.on("console", m => { const t = m.text(); if (!/favicon|Failed to load resource/.test(t)) console.log("[con]", t.slice(0, 250)); });
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 120000 });
for (let i = 0; i < 30; i++) {
  const n = await page.evaluate(() => (window.kasugaiApi.listLayers() || []).length);
  if (n > 0) { console.log("layers after", i * 2, "s:", n); break; }
  await page.waitForTimeout(2000);
}
const r = await page.evaluate(() => {
  const layers = window.kasugaiApi.listLayers().map(l => l.type + ":" + l.title);
  const ds = window._viewer.dataSources;
  const dss = [];
  for (let i = 0; i < ds.length; i++) { const d = ds.get(i); if (d.entities.values.length) dss.push(d.name + "=" + d.entities.values.length); }
  return { pid: window.kasugaiApi.getProjectId(), layers, dss };
});
console.log(JSON.stringify(r));
await page.screenshot({ path: "fmt-cesium.png" });
await browser.close();
