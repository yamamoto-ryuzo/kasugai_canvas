// issue #128: news: 行のお知らせフィードを cesium エンジンで検証
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const { chromium } = await import("file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = "http://127.0.0.1:8510";
const prof = join(os.tmpdir(), "kasc-probe-profile-news128");
const ctx = await chromium.launchPersistentContext(prof, { channel: "chrome", headless: true }).catch(() => chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.on("pageerror", e => console.log("PAGEERR", String(e).slice(0, 200)));
const ok = (n, c, x = "") => console.log(c ? "PASS" : "FAIL", n, x);
const click = sel => page.evaluate(s => document.querySelector(s)?.click(), sel);
async function flow() {
  await page.waitForSelector("#portal-open:not([hidden])", { timeout: 90000 });
  ok("portal-open button", true);
  await click("#portal-open");
  await page.waitForSelector(".portal-news-item", { timeout: 15000 });
  ok("news items rendered", true);
  const counts = await page.evaluate(() => {
    const sections = [...document.querySelectorAll(".portal-news")];
    return sections.map(s => s.querySelectorAll(".portal-news-item").length);
  });
  ok("JSON feed 3 items", counts[0] === 3, JSON.stringify(counts));
  ok("MD feed 2 items", counts[1] === 2, JSON.stringify(counts));
  const order = await page.evaluate(() =>
    [...document.querySelectorAll(".portal-news")][0]
      ? [...document.querySelectorAll(".portal-news")[0].querySelectorAll(".portal-news-date")].map(d => d.textContent.trim())
      : []);
  ok("date desc sort", order[0] === "2026-11-15" && order[2] === "2026-10-01", order.join(","));
  const badges = await page.evaluate(() => ({
    tags: document.querySelectorAll(".portal-news-tag").length,
    imp: [...document.querySelectorAll(".portal-news-importance")].map(b => b.textContent),
  }));
  ok("tag badges", badges.tags >= 5, String(badges.tags));
  ok("importance badges", badges.imp.includes("high"), badges.imp.join(","));
  const btns = await page.evaluate(() => ({
    view: [...document.querySelectorAll(".portal-news-btn[data-view]")].map(b => b.dataset.view),
    link: document.querySelectorAll(".portal-news-btn[data-link]").length,
    feature: [...document.querySelectorAll(".portal-news-btn[data-feature]")].map(b => b.dataset.feature),
  }));
  ok("view button", btns.view.includes("全体"), btns.view.join(","));
  ok("link buttons", btns.link === 2, String(btns.link));
  ok("feature button", btns.feature.includes("事業箇所/箇所名=箇所1"), btns.feature.join(","));
  const mdBody = await page.evaluate(() =>
    [...document.querySelectorAll(".portal-news")][1]?.querySelector(".portal-news-body")?.innerHTML || "");
  ok("markdown body rendered", mdBody.includes("<strong>") && mdBody.includes("<li>"), mdBody.slice(0, 80));
  const xss = await page.evaluate(() => document.querySelector(".portal-news script"));
  ok("script sanitized", !xss);
  await page.screenshot({ path: join(OUT, "probe-2026-11-16-news128.png") });
  // data-view ボタン押下 → ビュー適用＋ポータルが閉じる
  await click('.portal-news-btn[data-view="全体"]');
  await page.waitForFunction(() => document.querySelector("#portal-overlay")?.hidden === true, { timeout: 5000 });
  ok("data-view closes portal", true);
}
try {
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent("/verify/dash-test/news128.kasc")}`, { waitUntil: "domcontentloaded", timeout: 120000 });
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
try { await page.screenshot({ path: join(OUT, "probe-2026-11-16-news128-map.png") }); } catch {}
await ctx.close();
