import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage();
const errs = [];
page.on("console", m => { if (m.type() === "warning" || m.type() === "error") errs.push(m.text().slice(0, 200)); });
await page.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(18000);
const r = await page.evaluate(() => {
  const out = { dsInfo: [] };
  const v = window._viewer;
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    out.dsInfo.push({ i, name: ds.name, ents: ds.entities.values.length, qmlLabels: ds._qmlLabels?.length ?? -1, hasLabel: ds.entities.values.some(e => !!e.label) });
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
console.log(errs.filter(e => e.includes("QML") || e.includes("ラベル") || e.includes("error")).slice(0, 12));
await browser.close();
