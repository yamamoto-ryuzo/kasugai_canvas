import { readFileSync, readdirSync } from "node:fs";
import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";

const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8510/cesium/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

const cases = [
  ["fixture", readFileSync("C:/devin/kasugai_canvas/test-results/qml-spec/fixture.qml", "utf8")],
  ...readdirSync("C:/devin/kasugai_canvas/test-results/qml-spec/layers")
    .filter(f => f.endsWith(".qml"))
    .map(f => [f, readFileSync("C:/devin/kasugai_canvas/test-results/qml-spec/layers/" + f, "utf8")]),
];

for (const [name, xml] of cases) {
  const out = await page.evaluate(async (xmlText) => {
    const m = await import("/shared/qml-style.js");
    const r = { name: null, ok: true, checks: {}, warnings: [] };
    try {
      const c = m.compileQmlStyle(xmlText, "http://127.0.0.1:8510/");
      const props = { k: "1", name: "テスト" };
      r.eval1 = JSON.stringify(c.evaluate({ k: "1" })?.fillParts ?? c.evaluate({ k: "1" })?.line ?? null);
      r.line2 = JSON.stringify(c.evaluate({ k: "2" })?.lines?.[0]?.decor ?? c.evaluate({ k: "2" })?.line?.decor ?? null);
      r.interp3 = JSON.stringify(c.evaluate({ k: "3" })?.line?.decor ?? null);
      const lab = c.labelFor?.({ name: "A町1-2-3", k: "1" }) ?? null;
      r.label = lab ? {
        text: lab.text, sizePx: lab.sizePx, family: lab.family, align: lab.align,
        halo: lab.halo, priority: lab.priority, numFormat: lab.numFormat,
        dirSymbol: lab.dirSymbol, wrapChar: lab.wrapChar, zIndex: lab.zIndex,
        placement: { quad: lab.placement?.quad, distPx: lab.placement?.distPx,
          rotationDeg: lab.placement?.rotationDeg, offsetXPx: lab.placement?.offsetXPx },
      } : null;
      r.warnings = c.warnings;
      r.legendN = c.legend?.length;
    } catch (e) { r.ok = false; r.error = String(e); }
    return r;
  }, xml);
  out.name = name;
  console.log(JSON.stringify(out));
}
await browser.close();
