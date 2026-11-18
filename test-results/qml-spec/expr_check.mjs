import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8510/cesium/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const r = await page.evaluate(async () => {
  const m = await import("/shared/qml-style.js");
  const out = {};
  m.setEvalScale(73118);
  out["$scale"] = m.evalQgisExpression("$scale", {});
  out["ramp_spectral_scale"] = m.evalQgisExpression("ramp_color('Spectral',$scale)", {});
  out["ramp_spectral_half"] = m.evalQgisExpression("ramp_color('Spectral',0.5)", {});
  out["@scale"] = m.evalQgisExpression("@scale", {});
  out["vis_expr"] = m.evalQgisExpression("if( is_layer_visible('都道府県名'), \"N03_001\" ,'') || if( is_layer_visible('市区町村名'),\"N03_004\",'')", { N03_001: "東京都", N03_004: "世田谷区" });
  return out;
});
console.log(JSON.stringify(r));
await browser.close();
