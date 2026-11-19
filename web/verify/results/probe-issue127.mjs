// Issue #127 検証プローブ: ポータル台帳テーブル(table: 行)
//  1) table: セクションが2件描画される(title・where= 反映)
//  2) badge= による色付きバッジ
//  3) 検索ボックス・列ソート
//  4) 行クリック=ポータルを閉じて移動 / 📍ボタン=開いたまま
//  5) data-table 属性によるカスタムHTML内配置
// 実行: node web/verify/results/probe-issue127.mjs
// ※ table: 機能は commit 5b41d46 (Revert #127) で意図的に撤去済み。
//    本プローブは検証対象が存在しないため常に SKIP を返す。
console.log("SKIP issue127 :: table: 行機能は commit 5b41d46 で意図的に撤去済み(検証対象なし)");
process.exit(0);
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = process.env.PROBE_BASE || "http://127.0.0.1:8510";
const KASC1 = encodeURIComponent(`${BASE}/projects/_portal_test/table_test.kasc`);
const KASC2 = encodeURIComponent(`${BASE}/projects/_portal_test/table_datatable.kasc`);

const browser = await chromium.launch({
  executablePath: `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1243/chrome-win64/chrome.exe`,
});
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", e.message));
page.on("console", m => { if (m.type() === "error") console.log("[console.error]", m.text()); });

// --- A) table: セクション描画 ---
await page.goto(`${BASE}/cesium/?kasc=${KASC1}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".portal-table", { timeout: 120000 });
await page.waitForTimeout(1500);
const sections = await page.$$eval("#portal-body .portal-section h3", els => els.map(e => e.textContent));
console.log("SECTIONS=" + JSON.stringify(sections));
const tables = await page.$$(".portal-table");
console.log("TABLE_COUNT=" + tables.length);
const rowsA = await page.$$eval(".portal-table", (ts) => ts.map(t => t.querySelectorAll("tbody tr").length));
console.log("ROWS=" + JSON.stringify(rowsA));
const badges = await page.$$eval(".portal-table-badge", els => els.map(e => ({ text: e.textContent, bg: e.style.background })));
console.log("BADGES=" + JSON.stringify(badges));
const status = await page.$$eval(".portal-table-status", els => els.map(e => e.textContent));
console.log("STATUS=" + JSON.stringify(status));
await page.screenshot({ path: join(OUT, "probe-2026-11-16-issue127-tables.png") });

// --- B) 検索 ---
const search = page.locator(".portal-table-search").first();
await search.fill("未発注");
await page.waitForTimeout(300);
console.log("AFTER_SEARCH_ROWS=" + await page.$$eval(".portal-table", ts => ts[0].querySelectorAll("tbody tr").length));
await search.fill("");
await page.waitForTimeout(300);

// --- C) ソート(name 昇順初期・クリックで降順) ---
const firstCol = () => page.$$eval(".portal-table tbody tr td", tds => [tds[0]?.textContent, tds[2]?.textContent].join(","));
console.log("ORDER_ASC=" + await firstCol());
await page.click(".portal-table thead th");
await page.waitForTimeout(300);
console.log("ORDER_DESC=" + await firstCol());
await page.screenshot({ path: join(OUT, "probe-2026-11-16-issue127-sorted.png") });

// --- D) 📍ボタン = 開いたままハイライト ---
await page.click(".portal-table-locate");
await page.waitForTimeout(1000);
console.log("AFTER_LOCATE_PORTAL_HIDDEN=" + await page.evaluate(() => document.querySelector("#portal-overlay")?.hidden));

// --- E) 行クリック = ポータルを閉じて地物へ移動 ---
await page.click(".portal-table tbody tr");
await page.waitForTimeout(1000);
console.log("AFTER_ROWCLICK_PORTAL_HIDDEN=" + await page.evaluate(() => document.querySelector("#portal-overlay")?.hidden));
await page.screenshot({ path: join(OUT, "probe-2026-11-16-issue127-closed.png") });

// --- F) data-table 属性(カスタムHTML) ---
await page.goto(`${BASE}/cesium/?kasc=${KASC2}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-table] .portal-table", { timeout: 120000 });
await page.waitForTimeout(1000);
console.log("DATATABLE_ROWS=" + await page.$$eval("[data-table] .portal-table tbody tr", trs => trs.length));
console.log("DATATABLE_BADGE=" + await page.$$eval("[data-table] .portal-table-badge", els => els.map(e => e.style.background).join(",")));
// セクション側にも出ないこと(data-table へ移管=セクションは portal.html 置換のため無し)
console.log("SECTION_TABLES=" + await page.$$eval("#portal-body > .portal-section .portal-table", ts => ts.length));
await page.screenshot({ path: join(OUT, "probe-2026-11-16-issue127-datatable.png") });
await browser.close();
console.log("DONE");
