import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
await page.goto(`${BASE}/gsimaps/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("gsi-frame")?.contentWindow?.GSI?.GLOBALS, { timeout: 120000 });
await page.waitForTimeout(15000);
const r = await page.evaluate(() => {
  const w = document.getElementById("gsi-frame").contentWindow;
  const g = w.GSI.GLOBALS;
  const mll = g.mapLayerList;
  const out = { type: mll ? mll.constructor?.name : typeof mll };
  try {
    if (mll && mll._array) out.arr = mll._array.length;
    const keys = mll ? Object.keys(mll).slice(0, 15) : [];
    out.keys = keys;
    // レイヤー一覧UIの項目数
    out.domRows = document.querySelectorAll("#layer-list .layer-item, #layer-list li, .layerlist_row, tr").length;
  } catch (e) { out.err = String(e).slice(0, 100); }
  return out;
});
console.log("gsimaps:", JSON.stringify(r));
await page.screenshot({ path: "fmt-gsimaps.png" });
await browser.close();
