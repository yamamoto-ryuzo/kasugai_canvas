import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));
await page.goto(`${BASE}/gsimaps/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("gsi-frame")?.contentWindow?.GSI?.GLOBALS, { timeout: 120000 });
await page.waitForTimeout(15000);
const r = await page.evaluate(() => {
  const w = document.getElementById("gsi-frame").contentWindow;
  const g = w.GSI.GLOBALS;
  const out = {};
  const mll = g.gsimaps?._mainMap?._mapLayerList;
  out.found = !!mll;
  if (mll) {
    out.type = mll.constructor?.name;
    try { out.len = mll.length ?? mll.size ?? mll._array?.length ?? Object.keys(mll).length; } catch {}
    try {
      const arr = mll._array || (Array.isArray(mll) ? mll : null);
      if (arr) out.titles = arr.slice(-12).map(l => l?.title || l?.name || l?.id || "?");
      else out.keys = Object.keys(mll).slice(0, 15);
    } catch {}
  }
  return out;
});
console.log("gsimaps:", JSON.stringify(r).slice(0, 700));
await page.screenshot({ path: "fmt-gsimaps.png" });
await browser.close();
