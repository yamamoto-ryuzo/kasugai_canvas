import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));
await page.goto(`${BASE}/gsimaps/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("gsi-frame")?.contentWindow?.GSI?.GLOBALS, { timeout: 120000 });
await page.waitForTimeout(18000);
const r = await page.evaluate(() => {
  const w = document.getElementById("gsi-frame").contentWindow;
  const gm = w.GSI.GLOBALS.gsimaps;
  const out = {};
  const sk = gm?._sakuzuList;
  out.hasSakuzu = !!sk;
  if (sk) {
    out.len = sk._list?.length ?? -1;
    out.items = (sk._list || []).map(s => (s.title || s._title || s.fileName || s._fileName || "?") + (s._layer ? " [layer]" : ""));
  }
  return out;
});
console.log("gsimaps:", JSON.stringify(r, null, 1).slice(0, 900));
await page.screenshot({ path: "fmt-gsimaps.png" });
await browser.close();
