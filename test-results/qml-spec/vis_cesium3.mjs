import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(18000);
const r = await page.evaluate(async () => {
  const m = await import("/shared/qml-style.js");
  const res = await fetch("/projects/ProjectFiles/canvas_data/layer.qml");
  const xml = await res.text();
  const c = m.compileQmlStyle(xml, "/projects/ProjectFiles/");
  const props = { N03_001: "東京都", N03_004: "世田谷区" };
  const spec = c.labelFor?.(props);
  // 実 items の参照解決を直接試す
  const vis = m.evalQgisExpression("is_layer_visible('都道府県名')", {});
  // qmlStyle を持つ item が実在するか
  const items = window.kasugaiApi?.listLayers?.() || [];
  return { flag: c.usesLayerVisibility, hasLabelFor: !!c.labelFor, spec: spec ? { text: spec.text } : null, vis, nLayers: items.length };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
