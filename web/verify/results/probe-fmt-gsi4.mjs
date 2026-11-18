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
  const mll = w.GSI.GLOBALS.gsimaps?._mainMap?._mapLayerList;
  const out = {};
  const list = mll?.list || mll?.tileList;
  if (list) {
    out.type = list.constructor?.name;
    try { out.len = list.length ?? list.size ?? Object.keys(list).length; } catch {}
    try {
      const arr = Array.isArray(list) ? list : (list._array || (list.getArray ? list.getArray() : null));
      if (arr) out.titles = arr.slice(-12).map(l => l?.title || l?.name || l?.id || "?").filter(Boolean);
      else out.keys = Object.keys(list).slice(0, 12);
    } catch (e) { out.e = String(e).slice(0, 60); }
  }
  return out;
});
console.log("gsimaps:", JSON.stringify(r).slice(0, 700));
await browser.close();
