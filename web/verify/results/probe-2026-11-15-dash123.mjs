// issue #123 再検証: dash: 行で宣言したダッシュボードが cesium エンジンで動くか確認。
// 確認観点(実装時とは別の操作経路):
//  - 📊ボタン出現 → open() → KPI/棒グラフ/クロス集計/一覧/フィルタの描画
//  - 棒グラフ「完了」クリック → 一覧2件＋レイヤー where= 適用(解除ボタン出現) → 解除で復帰
//  - フィルタ select で「B班」→ 2件
//  - タブ2(detail=off)で一覧非表示・CSVボタン非表示(権限別表示)
//  - CSVダウンロード発火
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = "http://127.0.0.1:8765";
const KASC = "/verify/dash-test/k.kasc";
const prof = join(os.tmpdir(), "kasc-probe-profile-dash123");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.on("pageerror", e => console.log("PAGEERR", String(e).slice(0, 200)));
const results = [];
const ok = (name, cond, extra = "") => {
  results.push([name, cond]);
  console.log(cond ? "PASS" : "FAIL", name, extra);
};
try {
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent(KASC)}`,
    { waitUntil: "domcontentloaded", timeout: 120000 });
  const btnOk = await page.waitForSelector("#dash-open:not([hidden])", { timeout: 90000 })
    .then(() => true).catch(() => false);
  ok("button.visible", btnOk);
  // 地物ロード待ち: open() を繰り返して一覧行が出るまで待つ
  const deadline = Date.now() + 90000;
  let rows = 0;
  while (Date.now() < deadline) {
    await page.evaluate(() => window.kasugaiDashboard.open()).catch(() => {});
    rows = await page.evaluate(() =>
      document.querySelectorAll(".dash-list tr[data-i]").length).catch(() => 0);
    if (rows >= 6) break;
    await page.waitForTimeout(2000);
  }
  const s = await page.evaluate(() => ({
    kpis: document.querySelectorAll(".dash-kpi").length,
    kpiText: [...document.querySelectorAll(".dash-kpi")].map(e => e.textContent),
    bars: document.querySelectorAll(".dash-bar").length,
    mcells: document.querySelectorAll(".dash-matrix td[data-f]").length,
    rows: document.querySelectorAll(".dash-list tr[data-i]").length,
    filters: document.querySelectorAll(".dash-filters select").length,
    tabs: document.querySelectorAll(".dash-tab").length,
    err: document.querySelector(".dash-error")?.textContent || null,
  }));
  if (s.err) console.log("DASHERR", s.err);
  ok("kpi.cards", s.kpis >= 3, JSON.stringify(s.kpiText));
  ok("chart.bars", s.bars >= 4, "bars=" + s.bars);
  ok("matrix.cells", s.mcells >= 8, "cells=" + s.mcells);
  ok("list.rows", s.rows === 6, "rows=" + s.rows);
  ok("filters.selects", s.filters >= 2, "filters=" + s.filters);
  ok("tabs.two", s.tabs === 2, "tabs=" + s.tabs);
  // 棒グラフ「完了」クリック → 絞り込み2件＋地図フィルタ適用
  await page.evaluate(() => {
    [...document.querySelectorAll(".dash-bar")]
      .find(b => b.textContent.includes("完了"))?.click();
  });
  await page.waitForTimeout(1000);
  const c1 = await page.evaluate(() => ({
    rows: document.querySelectorAll(".dash-list tr[data-i]").length,
    clearBtn: !!document.querySelector(".dash-clear-map"),
  }));
  ok("barclick.filter2", c1.rows === 2, "rows=" + c1.rows);
  ok("barclick.mapWhere", c1.clearBtn, "clearBtn=" + c1.clearBtn);
  if (c1.clearBtn) {
    await page.click(".dash-clear-map");
    await page.waitForTimeout(700);
    const restored = await page.evaluate(() =>
      document.querySelectorAll(".dash-list tr[data-i]").length);
    ok("clear.restore", restored === 6, "rows=" + restored);
  }
  // フィルタドロップダウン「B班」→ 2件
  await page.evaluate(() => {
    const sel = document.querySelectorAll(".dash-filters select")[0];
    sel.value = "B班"; sel.dispatchEvent(new Event("change"));
  });
  await page.waitForTimeout(700);
  const fRows = await page.evaluate(() =>
    document.querySelectorAll(".dash-list tr[data-i]").length);
  ok("dropdown.filterB", fRows === 2, "rows=" + fRows);
  await page.evaluate(() => {
    const sel = document.querySelectorAll(".dash-filters select")[0];
    sel.value = ""; sel.dispatchEvent(new Event("change"));
  });
  await page.waitForTimeout(500);
  // タブ2(detail=off): 一覧なし・CSV非表示
  await page.evaluate(() => document.querySelectorAll(".dash-tab")[1].click());
  await page.waitForTimeout(700);
  const t2 = await page.evaluate(() => ({
    listSec: !!document.querySelector(".dash-list"),
    csvHidden: document.querySelector(".dash-csv")?.hidden,
  }));
  ok("detailoff.nolist", t2.listSec === false, JSON.stringify(t2));
  ok("detailoff.csvhidden", t2.csvHidden === true, "csvHidden=" + t2.csvHidden);
  // タブ1に戻してCSVダウンロード
  await page.evaluate(() => document.querySelectorAll(".dash-tab")[0].click());
  await page.waitForTimeout(500);
  const dl = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }).catch(() => null),
    page.click(".dash-csv"),
  ]).then(([d]) => d);
  ok("csv.download", !!dl, dl ? dl.suggestedFilename() : "none");
  await page.screenshot({ path: join(OUT, "probe-2026-11-15-dash123.png") });
} finally {
  await ctx.close();
}
const fails = results.filter(r => !r[1]);
console.log("RESULT", fails.length ? `NG:${fails.map(f => f[0]).join(",")}` : "ALL_PASS");
process.exit(fails.length ? 1 : 0);
