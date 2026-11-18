import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));
await page.goto(`${BASE}/maplibre/?kasc=${encodeURIComponent(BASE + "/projects/scale_test/kasugai_canvas.kasc")}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, { timeout: 40000 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 35.678, longitude: 139.793, zoom: 15, instant: true }));
await page.waitForTimeout(1800);
const out = await page.evaluate(async () => {
  const m = await import("/shared/qml-style.js");
  const qml = await (await fetch("/projects/scale_test/DATA/pts_scaled.qml")).text();
  const c = m.compileQmlStyle(qml);
  const scale = m.evalQgisExpression("@map_scale");
  const ifexpr = m.evalQgisExpression("if(@map_scale>=5000, 1.2, 5.0)");
  // DD がパースした式文字列そのものを DOMParser で再現して評価
  const doc = new DOMParser().parseFromString(qml, "application/xml");
  const opt = [...doc.querySelectorAll("Option")].find(o => o.getAttribute("name") === "expression");
  const exprText = opt?.getAttribute("value");
  const viaText = exprText ? m.evalQgisExpression(exprText) : "no-expr";
  const spec = c.evaluate({ name: "両国" });
  return { scale, ifexpr, exprText, viaText, sizePx: spec?.markers?.[0]?.sizePx };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
