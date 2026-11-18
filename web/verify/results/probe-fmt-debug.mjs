import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 300)));
page.on("console", m => { const t = m.text(); if (!/favicon/.test(t) && /err|fail|warn|kasc|load/i.test(t)) console.log("[con]", t.slice(0, 220)); });
await page.goto(`${BASE}/maplibre/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kascMap, { timeout: 60000 }).catch(() => console.log("no kascMap"));
await page.waitForTimeout(10000);
const r = await page.evaluate(async () => {
  const out = { api: !!window.kasugaiApi, sources: window.kascMap ? Object.keys(window.kascMap.getStyle().sources).length : -1 };
  try {
    const kasc = await import("../shared/kasc.js");
    const text = await (await fetch("../projects/format_test/format_test.kasc")).text();
    const doc = kasc.parseKasc(text);
    out.parsed = { layers: doc.layers.length, unsupported: doc.unsupported.length };
    const vl = await import("../shared/vector-load.js");
    out.one = await vl.loadVectorItem(doc.layers[0], new URL("../projects/format_test/format_test.kasc", location.href).href, null).then(r => r.geojson.features.length).catch(e => String(e).slice(0, 150));
  } catch (e) { out.dbg = String(e).slice(0, 300); }
  return out;
});
console.log(JSON.stringify(r));
await browser.close();
