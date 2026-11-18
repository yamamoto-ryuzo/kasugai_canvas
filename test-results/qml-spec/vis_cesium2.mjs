import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(20000);
const r = await page.evaluate(() => {
  const out = { hasViewer: !!window._viewer, dsCount: 0, ents: 0, labelEnts: 0, nonempty: [], empty: 0 };
  const v = window._viewer;
  if (!v?.dataSources) return out;
  out.dsCount = v.dataSources.length;
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    for (const e of ds.entities.values) {
      out.ents++;
      if (e.label) {
        out.labelEnts++;
        const t = e.label.text?.getValue?.();
        if (t) out.nonempty.push(String(t).slice(0, 30)); else out.empty++;
      }
    }
  }
  out.nonempty = out.nonempty.slice(0, 15);
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
