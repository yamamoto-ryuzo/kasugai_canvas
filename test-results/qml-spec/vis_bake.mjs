import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto("http://127.0.0.1:8510/maplibre/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
const r = await page.evaluate(() => {
  const out = {};
  const feats = window.kascMap.queryRenderedFeatures();
  const lab = feats.filter(f => f.layer?.type === "symbol" && f.layer.layout?.["text-field"]).slice(0, 10)
    .map(f => ({ layer: f.layer.id, text: f.properties?.__kasc_label }));
  out.renderedLabels = lab;
  const probe = [];
  for (const [sid] of Object.entries(window.kascMap.getStyle().sources)) {
    try {
      const s = window.kascMap.getSource(sid);
      const gj = s._data || s.serialize?.().data;
      const fs = typeof gj === "object" ? gj?.features : null;
      const hit = fs?.find(x => x.properties?.N03_001 !== undefined);
      if (hit) probe.push({ sid, label: hit.properties.__kasc_label, a: hit.properties.N03_001, b: hit.properties.N03_004 });
    } catch {}
  }
  out.baked = probe;
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
