import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://127.0.0.1:8510/cesium/?project=qml-verify-2&latitude=35.52&longitude=139.55&height=15000&pitch=-90", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(20000);
await page.screenshot({ path: "shots/lbl_cesium.png" });
console.log("done");
await browser.close();
