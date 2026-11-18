import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://127.0.0.1:8510/openlayers/?project=qml-verify-2", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
const out = await page.evaluate(() => {
  const map = window._olMap || window.map || window.__map;
  if (!map) return { err: "no map handle", keys: Object.keys(window).filter(k=>/map|ol/i.test(k)) };
  const res = [];
  map.getLayers().forEach(l => {
    const src = l.getSource && l.getSource();
    const n = src && src.getFeatures ? src.getFeatures().length : "?";
    let hasText = false, sample = null;
    if (src && src.getFeatures) {
      const f = src.getFeatures()[0];
      const st = f && (f.getStyle ? f.getStyle() : null);
      sample = f && f.getProperties && Object.keys(f.getProperties()).slice(0,8);
    }
    const sf = l.getStyle && l.getStyle();
    if (sf) {
      const styles = typeof sf === "function" ? sf(src.getFeatures()[0], 1) : sf;
      const arr = Array.isArray(styles) ? styles : [styles];
      hasText = arr.some(s => s && s.getText && s.getText());
    }
    res.push({ title: l.get("title") || l.get("name") || "?", feats: n, hasText, sample });
  });
  return res;
});
console.log(JSON.stringify(out, null, 1).slice(0, 3000));
await browser.close();
