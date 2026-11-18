import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8510/maplibre/?project=qml-verify", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const out = await page.evaluate(async () => {
  const m = await import("/shared/qml-2d.js");
  const compiled = await m.loadCompiledQml("DATA/dash_line.qml", "http://127.0.0.1:8510/projects/qml-verify/");
  const spec = compiled.evaluate({});
  const gj = { type:"FeatureCollection", features:[{type:"Feature",properties:{},geometry:{type:"LineString",coordinates:[[139.5,35.5],[139.9,35.5]]}}] };
  const applied = m.maplibreApplyQml(gj, compiled);
  return {
    lineDash: spec.line?.dash, lineW: spec.line?.widthPx,
    kascDash: gj.features[0].properties.__kasc_dash,
    kinds: applied.kinds.filter(k => k[0]==="line").map(k => k[2]),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
