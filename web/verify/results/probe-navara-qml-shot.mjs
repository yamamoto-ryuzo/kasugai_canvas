// navara qml-verify スクリーンショット再取得(長時間待機・コンソール監視)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", m => console.log("[con]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 200)));
await page.goto(`${BASE}/navara/?kasc=${encodeURIComponent("/verify/navara-qml/qml-verify.kasc")}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kascView, { timeout: 120000 });
await page.waitForTimeout(40000);
await page.screenshot({ path: OUT + "navara-qml-verify2.png" });
await browser.close();
console.log("done");
