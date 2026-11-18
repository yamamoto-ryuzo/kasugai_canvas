import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 300)));
page.on("console", m => { const t = m.text(); if (/err|fail|kasc|load/i.test(t) && !/favicon/.test(t)) console.log("[con]", t.slice(0, 200)); });
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 90000 });
await page.waitForTimeout(15000);
const r = await page.evaluate(() => {
  const layers = window.kasugaiApi.listLayers ? window.kasugaiApi.listLayers() : null;
  const ds = window._viewer.dataSources;
  const dss = [];
  for (let i = 0; i < ds.length; i++) { const d = ds.get(i); dss.push({ name: (d.name || "?").slice(0, 30), n: d.entities.values.length }); }
  return { layers: layers ? layers.map(l => l.type + ":" + l.title + (l.error ? " ERR:" + l.error : "")) : null, dss };
});
console.log(JSON.stringify(r, null, 1).slice(0, 3000));
await page.screenshot({ path: "fmt-cesium.png" });
await browser.close();
