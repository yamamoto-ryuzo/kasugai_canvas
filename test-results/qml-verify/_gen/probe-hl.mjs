import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
const base = "http://127.0.0.1:8510";
const outDir = "C:/devin/kasugai_canvas/test-results/qml-verify/shots-gaps";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 250)));

for (const eng of ["maplibre", "cesium"]) {
  await page.goto(`${base}/${eng}/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(eng === "cesium" ? 12000 : 8000);
  const r = await page.evaluate(eng => {
    if (eng === "maplibre") {
      const st = window.kascMap.getStyle();
      return { imgs: window.kascMap.listImages().filter(i => /^qh|^ql|^qd/.test(i)),
        lineSyms: st.layers.filter(l => l.type === "symbol" && l.layout?.["symbol-placement"] === "line").map(l => l.id),
        patLayers: st.layers.filter(l => l.paint?.["line-pattern"]).map(l => l.id) };
    }
    return null;
  }, eng);
  if (r) console.log(eng, JSON.stringify(r).slice(0, 800));
  if (eng === "maplibre") {
    await page.evaluate(() => window.kascMap.jumpTo({ center: [139.62, 35.575], zoom: 14 }));
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: `${outDir}/${eng}-hl.png` });
  console.log(eng, "shot OK");
}
await browser.close();
