// issue #124 実装確認: URL ディープリンク(view=/feature=/where=)と
// ポータル内 data-feature 委譲が cesium エンジンで動くか確認。
// 確認観点:
//  - &view=工事中 → ビュー適用(where=フィルタ・active)＋ポータルが閉じる
//  - &feature=テスト地物/name=B → 地物Bへズーム＋ハイライトDataSource
//  - &where=テスト地物/"状況"='未発注' → レイヤ指定フィルタ
//  - &where="状況"='完了' → 裸の式は全ベクターへ
//  - ポータル内 <button data-feature> クリック → 地物Cへ移動＋ポータル閉じる
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = "http://127.0.0.1:8765";
const KASC = "/projects/_portal_test/kasugai_canvas.kasc";
const prof = join(os.tmpdir(), "kasc-probe-profile-issue124");
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
const waitReady = async () => {
  await page.waitForFunction(() => window.kasugaiApi?.isReady, { timeout: 90000 });
  await page.waitForFunction(() => (window.kasugaiApi?.listLayers() || []).length > 0, { timeout: 60000 });
};
try {
  // --- view= ---
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent(KASC)}&view=${encodeURIComponent("工事中")}`,
    { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitReady();
  const v = await page.evaluate(() => ({
    filter: window.kasugaiApi.listLayers()[0]?.filter,
    portalHidden: document.querySelector("#portal-overlay")?.hidden,
    active: window.kasugaiApi.listViews().find(x => x.active)?.name || null,
  }));
  ok("view= で where 適用", v.filter === `"状況"='工事中'`, v.filter);
  ok("view= でビューが active", v.active === "工事中", v.active);
  ok("view= でポータルが閉じる", v.portalHidden === true);
  await page.screenshot({ path: join(OUT, "probe-2026-11-15-deeplink-view.png") });

  // --- feature= ---
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent(KASC)}&feature=${encodeURIComponent("テスト地物/name=B")}`,
    { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitReady();
  await page.waitForTimeout(5000); // fly アニメーション待ち
  const f = await page.evaluate(() => {
    const cam = window.kasugaiApi.getCamera();
    const list = window._viewer.dataSources._dataSources;
    const last = list[list.length - 1];
    let hl = null;
    if (last && last.entities.values.length === 1) {
      const c = window.Cesium.Cartographic.fromCartesian(last.entities.values[0].position.getValue());
      hl = { lat: c.latitude * 180 / Math.PI, lng: c.longitude * 180 / Math.PI };
    }
    return { cam, hl };
  });
  // flyToFeature は pitch<0 で地物を中央に据えるためカメラは南へ後退する。
  // 経度は地物に一致・緯度は地物より手前(南)にあることを確認する
  ok("feature= で地物B(139.1,36.0)へ移動",
    Math.abs(f.cam.longitude - 139.1) < 0.1 && f.cam.latitude > 34.0 && f.cam.latitude <= 36.05, JSON.stringify(f.cam));
  ok("feature= で選択ハイライト描画",
    !!f.hl && Math.abs(f.hl.lng - 139.1) < 1e-4 && Math.abs(f.hl.lat - 36.0) < 1e-4, JSON.stringify(f.hl));
  ok("feature= でもポータルが閉じる",
    await page.evaluate(() => document.querySelector("#portal-overlay")?.hidden === true));
  await page.screenshot({ path: join(OUT, "probe-2026-11-15-deeplink-feature.png") });

  // --- where= (レイヤ/式) ---
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent(KASC)}&where=${encodeURIComponent("テスト地物/\"状況\"='未発注'")}`,
    { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitReady();
  const w = await page.evaluate(() => window.kasugaiApi.listLayers()[0]?.filter);
  ok("where=レイヤ/式 適用", w === `"状況"='未発注'`, w);

  // --- where= 裸の式(全ベクター) ---
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent(KASC)}&where=${encodeURIComponent("\"状況\"='完了'")}`,
    { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitReady();
  const w2 = await page.evaluate(() => window.kasugaiApi.listLayers()[0]?.filter);
  ok("where=裸の式 適用", w2 === `"状況"='完了'`, w2);

  // --- data-feature 委譲(ポータル内HTML) ---
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent(KASC)}`,
    { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitReady();
  const df = await page.evaluate(async () => {
    const body = document.querySelector("#portal-body");
    const btn = document.createElement("button");
    btn.setAttribute("data-feature", "テスト地物/name=C");
    body.appendChild(btn);
    btn.click();
    await new Promise(r => setTimeout(r, 5000));
    return { cam: window.kasugaiApi.getCamera(), portalHidden: document.querySelector("#portal-overlay")?.hidden };
  });
  ok("data-feature で地物C(139.2,36.0)へ移動",
    Math.abs(df.cam.longitude - 139.2) < 0.1 && df.cam.latitude > 34.0 && df.cam.latitude <= 36.05, JSON.stringify(df.cam));
  ok("data-feature でポータルが閉じる", df.portalHidden === true);
  await page.screenshot({ path: join(OUT, "probe-2026-11-15-deeplink-datafeature.png") });
} catch (e) { console.log("ERROR", e); }
const failed = results.filter(r => !r[1]);
console.log(failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL PASS ${results.length}`);
await ctx.close();
process.exit(failed.length ? 1 : 0);
