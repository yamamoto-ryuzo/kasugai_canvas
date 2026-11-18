import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 300)));
page.on("console", m => { const t = m.text(); if (/kasc|layer|load|fail|err/i.test(t) && !/favicon|Failed to load resource/.test(t)) console.log("[con]", t.slice(0, 250)); });
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 120000 });
await page.waitForTimeout(25000);
const r = await page.evaluate(async () => {
  const out = {};
  try { out.layers = window.kasugaiApi.listLayers().map(l => l.type); } catch (e) { out.ll = String(e); }
  try {
    const k = await import("../shared/kasc.js");
    const txt = await (await fetch("../projects/format_test/format_test.kasc")).text();
    const doc = k.parseKasc(txt);
    out.parsed = doc.layers.map(l => l.type);
    // cesium の vectorDecoders 表を確認
    const vd = window.vectorDecoders;
    out.vdGlobal = !!vd;
  } catch (e) { out.p = String(e).slice(0, 200); }
  try { out.layerCount = document.querySelectorAll("#layer-list [data-layer], .layer-item, li").length; } catch {}
  return out;
});
console.log(JSON.stringify(r));
await page.screenshot({ path: "fmt-cesium.png", fullPage: false });
await browser.close();
