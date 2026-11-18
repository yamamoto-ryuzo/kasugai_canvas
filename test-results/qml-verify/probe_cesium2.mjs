import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on("console", m => errs.push(m.type() + " " + m.text().slice(0,200)));
page.on("pageerror", e => errs.push("PAGEERR " + String(e).slice(0,300)));
await page.goto("http://127.0.0.1:8510/cesium/?project=qml-verify-2", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(15000);
const out = await page.evaluate(() => {
  const items = document.querySelectorAll("#layer-list input[type=checkbox], .layer-item, [data-layer]");
  return {
    api: !!window.kasugaiApi,
    listText: (document.querySelector("#layer-list")||document.body).innerText.slice(0, 800),
  };
});
console.log(JSON.stringify(out).slice(0,1500));
console.log("=== console ===");
errs.slice(0,30).forEach(e => console.log(e));
await browser.close();
