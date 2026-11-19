// feature-verify CDN 実機検証プローブ (v7.0.0)
//  対象: https://yamamoto-ryuzo.github.io/kasugai-canvas-web/stable/
//  1) HTTP: channels.json / version.json / projects.json / index
//  2) ルート index → stable リダイレクト、stable/ → エンジンリダイレクト
//  3) cesium ブート + CDN 内蔵プロジェクト + 外部データホスト ?kasc= 再生
//  4) maplibre/openlayers/leaflet/navara/gsimaps ブート + .kasc 再生
// 実行: node web/verify/results/probe-cdn-v700.mjs
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");

const OUT = fileURLToPath(new URL("./", import.meta.url));
mkdirSync(OUT, { recursive: true });

const CDN = "https://yamamoto-ryuzo.github.io/kasugai-canvas-web";
const STABLE = `${CDN}/stable`;
const KASC_CDN = `${STABLE}/projects/sample_qgis/kasugai_canvas.kasc`;
const KASC_EXT = "https://yamamoto-ryuzo.github.io/kasugai_canvas_webGIS/default/kasugai_canvas.kasc";

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

// ================= 1. HTTP レベル =================
// 期待バージョン: 正本はローカル server/Cargo.toml の version(CDN はその発行物)
const EXPECT_VER = (() => {
  try {
    const toml = readFileSync(new URL("../../../server/Cargo.toml", import.meta.url), "utf8");
    return toml.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || null;
  } catch { return null; }
})();

async function getJson(url) { const r = await fetch(url, { cache: "no-store" }); return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }; }
try {
  const ch = await getJson(`${CDN}/channels.json`);
  rec("http.channels", ch.ok && ch.body?.default === "stable", JSON.stringify(ch.body));
  const v = await getJson(`${STABLE}/version.json`);
  rec("http.version", v.ok && !!v.body?.version && v.body.version === EXPECT_VER,
    `${JSON.stringify(v.body)} expect=${EXPECT_VER}`);
  const pj = await getJson(`${STABLE}/projects/projects.json`);
  const ids = (pj.body || []).map(p => p.id).sort();
  rec("http.projects", pj.ok && ["default", "reinfolib", "sample_qgis"].every(i => ids.includes(i)),
    `ids=${JSON.stringify(ids)}`);
  const idx = await fetch(`${STABLE}/index.html`, { cache: "no-store" });
  rec("http.index", idx.ok, `status=${idx.status}`);
  const kasc = await fetch(KASC_CDN, { cache: "no-store" });
  rec("http.kasc_sample", kasc.ok && (await kasc.text()).includes(":"), `status=${kasc.status}`);
} catch (e) { rec("http.fetch", false, String(e).slice(0, 200)); }

// ================= 2. ブラウザ実機 =================
const prof = join(os.tmpdir(), "kasc-probe-cdn-v700");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0, 200)));

// ルート index → stable リダイレクト
try {
  await page.goto(`${CDN}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  rec("root.redirect", page.url().includes("/stable/"), `url=${page.url()}`);
} catch (e) { rec("root.redirect", false, String(e).slice(0, 200)); }

// cesium: stable/ 直アクセス → エンジンリダイレクト → ブート
try {
  const errsBefore = pageErrors.length;
  await page.goto(`${STABLE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.Cesium?.VERSION, null, { timeout: 180000 });
  const info = await page.evaluate(async () => {
    const api = window.kasugaiApi;
    // 既定プロジェクトの読み込みを最大120秒待つ(外部データ参照・CDN初回は遅い)
    let layers = 0;
    for (let i = 0; i < 120; i++) {
      try { layers = api?.listLayers?.().length || 0; } catch { layers = 0; }
      if (layers > 0 && api?.isReady) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    const v = await fetch("../version.json", { cache: "no-store" }).then(r => r.json()).catch(() => ({}));
    return { url: location.href, cesium: window.Cesium.VERSION, ready: !!api?.isReady,
      engine: api?.engine, layers, ver: v.version };
  });
  rec("cesium.boot", info.cesium && info.ready === true, JSON.stringify(info));
  rec("cesium.redirect_default_engine", info.url.includes("/cesium/"), `url=${info.url}`);
  rec("cesium.version_display", info.ver === EXPECT_VER, `version.json=${info.ver} expect=${EXPECT_VER}`);
  rec("cesium.default_project", info.layers > 0, `listLayers=${info.layers}`);
  rec("cesium.no_pageerror", pageErrors.length === errsBefore, `errors=${pageErrors.length - errsBefore}`);
  await page.screenshot({ path: join(OUT, "cdn-cesium.png") });
} catch (e) { rec("cesium.boot", false, String(e).slice(0, 300)); }

// cesium: 外部データホストの .kasc 再生(?kasc= 跨ホスト)
try {
  const errsBefore = pageErrors.length;
  await page.goto(`${STABLE}/cesium/?kasc=${encodeURIComponent(KASC_EXT)}`,
    { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.kasugaiApi?.isReady, null, { timeout: 180000 });
  const r = await page.evaluate(async () => {
    let layers = 0;
    for (let i = 0; i < 45; i++) {
      try { layers = window.kasugaiApi.listLayers().length || 0; } catch { layers = 0; }
      if (layers > 0) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    return { layers, kasc: new URLSearchParams(location.search).get("kasc") };
  });
  rec("cesium.ext_kasc", r.layers > 0, `layers=${r.layers} kasc=${r.kasc}`);
  rec("cesium.ext_kasc_no_pageerror", pageErrors.length === errsBefore, `errors=${pageErrors.length - errsBefore}`);
  await page.screenshot({ path: join(OUT, "cdn-cesium-ext.png") });
} catch (e) { rec("cesium.ext_kasc", false, String(e).slice(0, 300)); }

// 2D エンジン群: CDN 内蔵 sample_qgis を再生
const engines2d = [
  { id: "maplibre", url: `${STABLE}/maplibre/?kasc=${encodeURIComponent(KASC_CDN)}`,
    ready: "window.kascMap && window.kascMap.loaded && window.kascMap.loaded()", timeout: 120000 },
  { id: "openlayers", url: `${STABLE}/openlayers/?kasc=${encodeURIComponent(KASC_CDN)}`,
    ready: "window.kascMap", timeout: 120000 },
  { id: "leaflet", url: `${STABLE}/leaflet/?kasc=${encodeURIComponent(KASC_CDN)}`,
    ready: "window.kascMap", timeout: 120000 },
  { id: "navara", url: `${STABLE}/navara/?kasc=${encodeURIComponent(KASC_CDN)}`,
    ready: "window.kasugaiApi", timeout: 180000 },
];
for (const en of engines2d) {
  try {
    const errsBefore = pageErrors.length;
    await page.goto(en.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(en.ready, null, { timeout: en.timeout });
    await page.waitForTimeout(15000); // .kasc/DATA 読込待ち
    const r = await page.evaluate(() => {
      let layers = -1;
      try { layers = window.kasugaiApi?.listLayers?.().length ?? -1; } catch { layers = -1; }
      return { api: !!window.kasugaiApi, layers };
    });
    rec(`${en.id}.boot`, r.api, JSON.stringify(r));
    rec(`${en.id}.kasc_layers`, r.layers > 0, `listLayers=${r.layers}`);
    rec(`${en.id}.no_pageerror`, pageErrors.length === errsBefore, `errors=${pageErrors.length - errsBefore}`);
    await page.screenshot({ path: join(OUT, `cdn-${en.id}.png`) });
  } catch (e) { rec(`${en.id}.boot`, false, String(e).slice(0, 300)); }
}

// gsimaps(調整中エンジン): ブートのみ
try {
  const errsBefore = pageErrors.length;
  await page.goto(`${STABLE}/gsimaps/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(20000);
  const g = await page.evaluate(() => ({
    canvases: document.querySelectorAll("canvas").length,
    gsi: typeof window.GSI !== "undefined" || !!document.querySelector("#map, .leaflet-container, iframe"),
  }));
  rec("gsimaps.boot", g.canvases > 0 || g.gsi, JSON.stringify(g));
  rec("gsimaps.no_pageerror", pageErrors.length === errsBefore, `errors=${pageErrors.length - errsBefore}`);
} catch (e) { rec("gsimaps.boot", false, String(e).slice(0, 200)); }

console.log("=== pageErrors ==="); pageErrors.slice(0, 10).forEach(e => console.log("ERR", e));
writeFileSync(join(OUT, "probe-cdn-v700-results.json"), JSON.stringify(results, null, 2));
await ctx.close();
const fails = results.filter(r => !r.ok);
console.log(`=== DONE pass=${results.length - fails.length} fail=${fails.length} ===`);
process.exit(fails.length ? 1 : 0);
