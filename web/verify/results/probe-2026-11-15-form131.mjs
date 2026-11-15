// issue #131: form: 行のフォーム投稿を cesium エンジンで検証
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const { chromium } = await import("file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = "http://127.0.0.1:8765";
const prof = join(os.tmpdir(), "kasc-probe-profile-form131");
const ctx = await chromium.launchPersistentContext(prof, { channel: "chrome", headless: true }).catch(() => chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.on("pageerror", e => console.log("PAGEERR", String(e).slice(0, 200)));
const ok = (n, c, x = "") => console.log(c ? "PASS" : "FAIL", n, x);
const click = sel => page.evaluate(s => document.querySelector(s)?.click(), sel);
try {
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent("/verify/dash-test/form131.kasc")}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const btn = await page.waitForSelector("#portal-open:not([hidden])", { timeout: 90000 }).catch(() => null);
  ok("portal-open button", !!btn);
  await click("#portal-open");
  await page.waitForSelector(".portal-card-form", { timeout: 10000 });
  ok("form card", true);
  await click(".portal-card-form");
  await page.waitForSelector(".portal-form", { timeout: 5000 });
  ok("form open", true);
  await page.evaluate(() => {
    const q = s => document.querySelector(s);
    q('.portal-form input[type="text"]').value = "テスト太郎";
    q('.portal-form textarea').value = "メモ本文";
    q('.portal-form select').value = "要望";
  });
  await click(".portal-form-loc-btn");
  await page.waitForFunction(() => document.querySelector("#portal-overlay")?.hidden === true, { timeout: 5000 });
  ok("portal closes for pick", true);
  await page.evaluate(() => {
    const c = document.querySelector("#cesiumContainer canvas") || document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent("click", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector(".portal-form-loc-value")?.textContent.trim().length > 0, { timeout: 15000 }).catch(() => null);
  const locText = await page.textContent(".portal-form-loc-value").catch(() => "");
  ok("loc picked", /-?\d+\.\d+/.test(locText || ""), locText);
  await click(".portal-form-submit");
  await page.waitForFunction(() => document.querySelector(".portal-form-status")?.textContent.includes("送信"), { timeout: 10000 }).catch(() => null);
  const status = await page.textContent(".portal-form-status").catch(() => "");
  ok("submit", (status || "").includes("送信しました"), status);
  await page.screenshot({ path: join(OUT, "probe-2026-11-15-form131.png") });
} catch (e) {
  console.log("ERROR", String(e).slice(0, 300));
  try { await page.screenshot({ path: join(OUT, "probe-2026-11-15-form131.png") }); } catch {}
}
await ctx.close();
