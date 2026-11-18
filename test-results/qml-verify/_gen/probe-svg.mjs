import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
const base = "http://127.0.0.1:8510";
const outDir = "C:/devin/kasugai_canvas/test-results/qml-verify/shots-gaps";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 300)));
for (const eng of ["navara", "maplibre", "cesium"]) {
  await page.goto(`${base}/${eng}/?kasc=/projects/qml-verify/svgonly.kasc`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(eng === "cesium" ? 12000 : eng === "navara" ? 11000 : 8000);
  if (eng === "navara") {
    await page.evaluate(() => window.kascView.setCamera({ lng: 139.60, lat: 35.597, height: 3500, pitch: -60, heading: 0 }));
    await page.waitForTimeout(3000);
  } else if (eng === "maplibre") {
    await page.evaluate(() => window.kascMap.jumpTo({ center: [139.60, 35.60], zoom: 14 }));
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: `${outDir}/${eng}-svg.png` });
  console.log(eng, "OK");
}
await browser.close();
