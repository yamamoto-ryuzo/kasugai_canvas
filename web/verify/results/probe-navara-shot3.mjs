import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const [name, kasc] of [["transparent","/verify/navara-qml/transparent.kasc"],["plain-base","/verify/navara-qml/plain-base.kasc"]]) {
  try {
    await page.goto(`${BASE}/navara/?kasc=${encodeURIComponent(kasc)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.kascView, { timeout: 120000 });
    await page.waitForTimeout(25000);
    await page.screenshot({ path: `${OUT}navara-${name}-verify.png` });
    console.log("shot", name);
  } catch (e) { console.log("fail", name, e.message); }
}
await browser.close();
