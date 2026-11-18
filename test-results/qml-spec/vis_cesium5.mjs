import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(18000);
const r = await page.evaluate(() => {
  const v = window._viewer;
  const out = { sample: [] };
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    const ents = ds.entities.values;
    if (!ents.length) continue;
    const e0 = ents[0];
    const props = e0.properties?.getValue?.(Cesium.JulianDate.now()) || {};
    out.sample.push({ i, n: ents.length, keys: Object.keys(props).slice(0, 15), qmlLabel0: ds._qmlLabels?.[0]?.spec?.text ?? "n/a" });
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
