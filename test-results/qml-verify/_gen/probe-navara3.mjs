import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
const base = "http://127.0.0.1:8510";
const outDir = "C:/devin/kasugai_canvas/test-results/qml-verify/shots-gaps";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 250)));

await page.goto(`${base}/navara/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(11000);
await page.evaluate(() => window.kascView.setCamera({ lng: 139.615, lat: 35.585, height: 3000, pitch: -45, heading: 0 }));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outDir}/navara-tilt.png` });
console.log("tilt OK");

await page.goto(`${base}/navara/?project=_qml_verify`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(14000);
await page.evaluate(() => window.kascView.setCamera({ lng: 139.7358, lat: 35.638, height: 3000, pitch: -55, heading: 0 }));
await page.waitForTimeout(3000);
await page.screenshot({ path: `${outDir}/navara-dm1.png` });
console.log("dm1 OK");
await browser.close();
