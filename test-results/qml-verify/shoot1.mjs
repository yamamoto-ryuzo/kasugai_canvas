import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const eng = process.argv[2] || "maplibre";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://127.0.0.1:8510/${eng}/?project=qml-verify`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
await page.screenshot({ path: `shots/${eng}_2.png` });
console.log(eng, "done");
await browser.close();
