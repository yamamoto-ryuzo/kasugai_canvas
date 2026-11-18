import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const eng of ["openlayers", "leaflet", "maplibre", "cesium"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:8510/${eng}/?project=qml-verify-2&latitude=35.53&longitude=139.55&zoom=12.5`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(18000);
  await page.screenshot({ path: `shots/lbl_${eng}.png` });
  console.log(eng, "done");
  await page.close();
}
await browser.close();
