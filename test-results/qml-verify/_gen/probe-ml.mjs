import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
const base = "http://127.0.0.1:8510";
const outDir = "C:/devin/kasugai_canvas/test-results/qml-verify/shots-gaps";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", m => { if (m.type() === "error") console.log("[err]", m.text().slice(0, 200)); });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 250)));
await page.goto(`${base}/maplibre/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const st = window.kascMap.getStyle();
  return st.layers.filter(l => l.type === "fill-extrusion").map(l => l.id);
});
console.log("extrusion layers:", JSON.stringify(r));
await page.screenshot({ path: `${outDir}/maplibre-nobase.png` });
console.log("shot OK");
await browser.close();
