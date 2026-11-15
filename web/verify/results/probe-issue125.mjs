// issue #125: search: 行 / data-search 属性のポータル埋め込み検索を cesium エンジンで検証
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const { chromium } = await import("file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = "http://127.0.0.1:8899";
const prof = join(os.tmpdir(), "kasc-probe-profile-search125");
const ctx = await chromium.launchPersistentContext(prof, { channel: "chrome", headless: true }).catch(() => chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.on("pageerror", e => console.log("PAGEERR", String(e).slice(0, 200)));
const ok = (n, c, x = "") => console.log(c ? "PASS" : "FAIL", n, x);
const click = sel => page.evaluate(s => document.querySelector(s)?.click(), sel);
async function flow() {
  await page.waitForSelector("#portal-open:not([hidden])", { timeout: 90000 });
  ok("portal-open button", true);
  await click("#portal-open");
  await page.waitForSelector(".portal-search-input", { timeout: 15000 });
  // search: 行 → ポータル先頭の検索セクション x2(all 横断 / レイヤ+属性指定)
  const sections = await page.evaluate(() =>
    [...document.querySelectorAll(".portal-search-section")].map(s => ({
      title: s.querySelector("h3")?.textContent,
      ph: s.querySelector("input")?.placeholder,
      ds: s.querySelector("input")?.dataset.search,
      attr: s.querySelector("input")?.dataset.searchAttr || null,
    })));
  ok("search sections x2", sections.length === 2, JSON.stringify(sections));
  ok("title/ph", sections[0]?.title === "探す" && sections[0]?.ph === "施設名・属性値で検索");
  ok("layer+attr spec", sections[1]?.ds === "事業箇所" && sections[1]?.attr === "箇所名");
  // html: セクション内の data-search 入力がサニタイズを通過して残る
  const custom = await page.evaluate(() =>
    !!document.querySelector('.portal-section-body input[data-search="事業箇所"][data-search-attr="担当"]'));
  ok("data-search input in html:", custom);
  // 全横断検索: "箇所" → 箇所名 箇所1..箇所6 の6候補
  await page.locator(".portal-search-input").first().fill("箇所");
  await page.waitForSelector(".portal-search-section .portal-search-result", { timeout: 20000 });
  const all = await page.evaluate(() =>
    [...document.querySelectorAll(".portal-search-section")[0].querySelectorAll(".portal-search-result")].map(b => ({
      v: b.querySelector(".portal-search-value")?.textContent,
      m: b.querySelector(".portal-search-meta")?.textContent,
    })));
  ok("all-layer results =6", all.length === 6, JSON.stringify(all.slice(0, 2)));
  ok("result meta has layer/attr", !!all[0]?.m?.includes("事業箇所") && !!all[0]?.m?.includes("箇所名"), all[0]?.m);
  // attr=箇所名 限定: "A" は担当=A班のみ一致するため候補0件になること
  await page.locator(".portal-search-input").nth(1).fill("A");
  await page.waitForFunction(() =>
    document.querySelectorAll(".portal-search-section")[1]?.querySelector(".portal-search-empty") != null
    || document.querySelectorAll(".portal-search-section")[1]?.querySelectorAll(".portal-search-result").length > 0, { timeout: 20000 });
  const scoped = await page.evaluate(() => ({
    res: document.querySelectorAll(".portal-search-section")[1].querySelectorAll(".portal-search-result").length,
    empty: document.querySelectorAll(".portal-search-section")[1].querySelector(".portal-search-empty")?.textContent || null,
  }));
  ok("attr-scoped filters out A班", scoped.res === 0 && !!scoped.empty, JSON.stringify(scoped));
  // data-search(カスタムHTML・attr=担当): "A" → A班の1候補
  await page.locator('.portal-section-body input[data-search="事業箇所"]').fill("A");
  await page.waitForFunction(() =>
    !!document.querySelector('.portal-section-body .portal-search-results .portal-search-result'), { timeout: 20000 });
  const ds = await page.evaluate(() =>
    [...document.querySelectorAll('.portal-section-body .portal-search-result')].map(b => b.querySelector(".portal-search-value")?.textContent));
  ok("data-search results =1 (A班)", ds.length === 1 && ds[0] === "A班", ds.join(","));
  await page.screenshot({ path: join(OUT, "probe-issue125-search.png") });
  // 候補クリック → ポータルが閉じて地物へズーム＋選択
  const camBefore = await page.evaluate(() => window.kasugaiApi?.getCamera?.() || null);
  await page.evaluate(() => document.querySelector(".portal-search-section .portal-search-result")?.click());
  await page.waitForFunction(() => document.querySelector("#portal-overlay")?.hidden === true, { timeout: 10000 });
  ok("result click closes portal", true);
  await page.waitForFunction(c0 => {
    const c = window.kasugaiApi?.getCamera?.();
    return !!c && !!c0 && Math.abs(c.latitude - c0.latitude) + Math.abs(c.longitude - c0.longitude) > 1e-6;
  }, camBefore, { timeout: 20000 });
  ok("camera moved to feature", true);
}
try {
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent("/verify/dash-test/search125.kasc")}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await flow(); break; }
    catch (e) {
      if (!/context was destroyed|navigat/i.test(String(e))) throw e;
      console.log("RETRY after navigation", attempt + 1);
    }
  }
} catch (e) {
  console.log("ERROR", String(e).slice(0, 300));
}
try { await page.screenshot({ path: join(OUT, "probe-issue125-map.png") }); } catch {}
await ctx.close();
