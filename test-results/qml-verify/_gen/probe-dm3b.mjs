import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
const base = "http://127.0.0.1:8510";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto(`${base}/maplibre/?project=_qml_verify`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);
const r = await page.evaluate(() => {
  const map = window.kascMap;
  const st = map.getStyle();
  const out = { hgrp: 0, mgrp: 0, lpat: 0, symbolLine: 0, total: 0, codes: {} };
  for (const l of st.layers) {
    if (l.type === "symbol" && l.layout?.["symbol-placement"] === "line") out.symbolLine++;
    if (l.paint?.["line-pattern"]) out.lpat++;
  }
  // geojson ソースから地物プロパティを覗く
  for (const [sid, src] of Object.entries(st.sources)) {
    const gj = src?._data || src?.data;
    if (gj?.type === "FeatureCollection") {
      for (const f of gj.features) {
        out.total++;
        const c = f.properties?.["分類コーA"];
        if (c != null) out.codes[c] = (out.codes[c] || 0) + 1;
        if (f.properties?.__kasc_hgrp) out.hgrp++;
        if (f.properties?.__kasc_mgrp) out.mgrp++;
      }
    }
  }
  return out;
});
console.log(JSON.stringify(r).slice(0, 3000));
await browser.close();
