import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));

// navara: レイヤ登録後の描画状態（source/layer が view にあるか）
try {
  await page.goto(`${BASE}/navara/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascView, { timeout: 90000 });
  await page.waitForTimeout(18000);
  const r = await page.evaluate(() => {
    const v = window.kascView;
    const out = { layers: window.kasugaiApi.listLayers().map(l => l.type + ":" + l.title + (l.failed ? " FAIL" : "")) };
    try { out.viewLayers = v.getLayerList ? v.getLayerList().length : (v._layers ? v._layers.size || v._layers.length : -1); } catch (e) { out.viewLayers = String(e).slice(0, 60); }
    try { out.stats = v.getStats ? JSON.stringify(v.getStats()).slice(0, 200) : null; } catch {}
    return out;
  });
  console.log("navara:", JSON.stringify(r).slice(0, 800));
  await page.screenshot({ path: "fmt-navara.png" });
} catch (e) { console.log("navara FAILED", String(e).slice(0, 200)); }

// gsimaps: iframe 内の mapLayerList
try {
  await page.goto(`${BASE}/gsimaps/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("gsi-frame")?.contentWindow?.GSI?.GLOBALS, { timeout: 120000 });
  await page.waitForTimeout(18000);
  const r = await page.evaluate(() => {
    const w = document.getElementById("gsi-frame").contentWindow;
    const g = w.GSI.GLOBALS;
    const out = {};
    const mll = g.mapLayerList;
    try { out.mllLen = mll ? (mll.length ?? mll.size ?? Object.keys(mll).length) : -1; } catch (e) { out.mllErr = String(e).slice(0, 60); }
    try { out.names = mll && mll.get ? undefined : Array.isArray(mll) ? mll.slice(-10).map(l => l.title || l.name || l.id || "?") : null; } catch {}
    try { out.pending = window._qmlPending ? window._qmlPending.length : 0; } catch {}
    return out;
  });
  console.log("gsimaps:", JSON.stringify(r).slice(0, 600));
  await page.screenshot({ path: "fmt-gsimaps.png" });
} catch (e) { console.log("gsimaps FAILED", String(e).slice(0, 200)); }
await browser.close();
