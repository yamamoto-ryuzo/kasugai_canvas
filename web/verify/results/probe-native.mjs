// cesium/app.js のネイティブ DataSource 経路(KML/GPX/CZML)検証
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0,200)));
page.on("console", m => { const t = m.text(); if (/ネイティブ|fail|error/i.test(t) && !/favicon/.test(t)) console.log("[con]", t.slice(0,180)); });
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, null, { timeout: 90000 });
await page.waitForTimeout(10000);
const r = await page.evaluate(() => {
  const v = window._viewer;
  const out = [];
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    out.push({ name: ds.name || "?", ctor: ds.constructor.name, entities: ds.entities?.values?.length ?? 0, clock: !!ds.clock });
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
