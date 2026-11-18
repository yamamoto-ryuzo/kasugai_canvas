import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));

try {
  await page.goto(`${BASE}/navara/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascView, { timeout: 90000 });
  await page.waitForTimeout(15000);
  const r = await page.evaluate(() => {
    const ll = window.kasugaiApi?.listLayers ? window.kasugaiApi.listLayers() : [];
    return { layers: ll.map(l => (l.type || "?") + ":" + (l.title || "") + (l.failed ? " FAILED:" + (l.error || "").slice(0, 60) : "")), view: !!window.kascView };
  });
  console.log("navara:", JSON.stringify(r).slice(0, 800));
  await page.screenshot({ path: "fmt-navara.png" });
} catch (e) { console.log("navara FAILED", String(e).slice(0, 200)); }

try {
  await page.goto(`${BASE}/gsimaps/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const f = document.getElementById("gsi-frame");
    return f && f.contentWindow && f.contentWindow.GSI && f.contentWindow.GSI.GLOBALS;
  }, { timeout: 120000 });
  await page.waitForTimeout(15000);
  const r = await page.evaluate(() => {
    const w = document.getElementById("gsi-frame").contentWindow;
    const g = w.GSI.GLOBALS;
    const out = {};
    try { out.mapLayerList = g.mapLayerList ? g.mapLayerList.length : -1; } catch {}
    try { out.apiLayers = window.kasugaiApi?.listLayers ? window.kasugaiApi.listLayers().map(l => l.type + ":" + l.title) : []; } catch {}
    return out;
  });
  console.log("gsimaps:", JSON.stringify(r).slice(0, 800));
  await page.screenshot({ path: "fmt-gsimaps.png" });
} catch (e) { console.log("gsimaps FAILED", String(e).slice(0, 200)); }
await browser.close();
