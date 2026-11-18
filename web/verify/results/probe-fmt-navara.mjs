import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/format_test/format_test.kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));
await page.goto(`${BASE}/navara/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kascView && window.kasugaiApi?.listLayers, { timeout: 120000 });
await page.waitForTimeout(15000);
const nv = await page.evaluate(() => window.kasugaiApi.listLayers().map(l => l.type + ":" + l.title + (l.failed ? " FAIL" : "")));
console.log("navara:", JSON.stringify(nv));
await page.screenshot({ path: "fmt-navara.png" });
await browser.close();
