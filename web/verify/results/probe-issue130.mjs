// Issue #130 検証プローブ: project: カード（プロジェクト切替）
//  1) _portal_test のポータルに project: カードが描画される
//  2) 未解決ID(missing-proj)は無効カードになる
//  3) "default" カード押下で ?project=default へ in-place 切替・ポータルは開いたまま
// 実行: node web/verify/results/probe-issue130.mjs  (要 http://127.0.0.1:8510 で web/ 静的配信)
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = process.env.PROBE_BASE || "http://127.0.0.1:8510";

const browser = await chromium.launch({
  executablePath: `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1243/chrome-win64/chrome.exe`,
});
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", e.message));
await page.goto(`${BASE}/cesium/?project=_portal_test`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".portal-card-project", { timeout: 120000 });
await page.waitForTimeout(1500);
const cards = await page.$$eval(".portal-card", els =>
  els.map(e => ({ text: e.textContent.trim().replace(/\s+/g, " ").slice(0, 50), disabled: e.disabled, cls: e.className })));
console.log("CARDS=" + JSON.stringify(cards));
await page.screenshot({ path: join(OUT, "probe-2026-11-15-issue130-portal.png") });

// 起動時ポータルは applyUrlDeepLink により一旦閉じられるため 🏠 で開き直す
await page.click("#portal-open");
await page.waitForSelector("#portal-overlay:not([hidden])", { timeout: 15000 });
await page.click(".portal-card-project:not([disabled])");
await page.waitForFunction(() => location.search.includes("project=default"), null, { timeout: 90000 });
await page.waitForTimeout(3000);
console.log("SEARCH_AFTER=" + await page.evaluate(() => location.search));
console.log("PORTAL_HIDDEN=" + await page.evaluate(() => document.querySelector("#portal-overlay")?.hidden));
console.log("TITLE=" + await page.evaluate(() => document.querySelector("#portal-title")?.textContent));
await page.screenshot({ path: join(OUT, "probe-2026-11-15-issue130-after.png") });
await browser.close();
console.log("DONE");
