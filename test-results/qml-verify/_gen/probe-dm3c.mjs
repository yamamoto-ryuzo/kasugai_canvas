import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
const base = "http://127.0.0.1:8510";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage();
await page.goto(`${base}/maplibre/?project=_qml_verify`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);
const r = await page.evaluate(() => {
  const st = window.kascMap.getStyle();
  const out = [];
  for (const [sid, src] of Object.entries(st.sources)) {
    const gj = src?._data || src?.data;
    if (gj?.type === "FeatureCollection" && gj.features.length) {
      out.push({ sid, n: gj.features.length, props: Object.keys(gj.features[0].properties || {}) });
    }
  }
  return out;
});
console.log(JSON.stringify(r, null, 1).slice(0, 3000));
await browser.close();
