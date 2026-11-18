import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("PAGEERR", String(e).slice(0,200)));
await page.goto("http://127.0.0.1:8510/cesium/?project=qml-verify-2&latitude=35.5&longitude=139.62&height=15000&pitch=-90", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(20000);
const out = await page.evaluate(() => {
  const v = window.kasugaiApi?.getViewer?.();
  if (!v) return { err: "no viewer" };
  const rows = [];
  const scan = ents => ents.forEach(e => {
    const l = e.label;
    if (l) rows.push({
      name: e.name || e.id,
      text: l.text?.getValue?.() ?? String(l.text),
      show: l.show?.getValue ? l.show.getValue() : l.show,
      hasBillboardImg: !!(l._img || l.billboard),
      pos: !!e.position,
    });
    if (e._children) scan(e._children);
  });
  scan(v.entities.values);
  // データソース内も
  v.dataSources?._dataSources?.forEach(ds => scan(ds.entities.values));
  return { labels: rows, nEnt: v.entities.values.length, nDs: v.dataSources?.length };
});
console.log(JSON.stringify(out, null, 1).slice(0, 2500));
await page.screenshot({ path: "shots/lbl_cesium2.png" });
await browser.close();
