import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const ctx = await browser.newContext({ bypassCSP: true });
const page = await ctx.newPage();
await page.route("**/*", route => route.continue({ headers: { ...route.request().headers(), "cache-control": "no-cache" } }));
await page.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles&_ts=" + Date.now(), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(20000);
const r = await page.evaluate(() => {
  const v = window._viewer;
  const out = { rows: [] };
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    const ents = ds.entities.values;
    if (!ents.length) continue;
    out.rows.push({ i, n: ents.length, labels: ds._qmlLabels?.length ?? -1, hasLabel: ents.some(e => !!e.label || !!e.billboard), text0: ds._qmlLabels?.[0]?.spec?.text ?? null });
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
