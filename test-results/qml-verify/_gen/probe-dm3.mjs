import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
const base = "http://127.0.0.1:8510";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto(`${base}/maplibre/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const r = await page.evaluate(async () => {
  const m = await import("/shared/qml-2d.js");
  const compiled = await m.loadCompiledQml("canvas_data/DM_3.qml", "http://127.0.0.1:8510/projects/_qml_verify/");
  // DM_3 データの属性で評価(分類コーA=1101 → symbol 0)
  const spec = compiled.evaluate({ "分類コーA": 6137 });
  return {
    warnings: compiled.warnings.slice(0, 10),
    specLine: spec?.line ? { color: spec.line.color, decor: spec.line.decor?.kind } : null,
    specLines: spec?.lines?.map(l => ({ decor: l?.decor?.kind || null })),
    legendN: compiled.legend?.length,
  };
});
console.log(JSON.stringify(r, null, 1).slice(0, 3000));
await browser.close();
