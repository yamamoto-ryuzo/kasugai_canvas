// retry: cesium 既定プロジェクト / navara ?kasc= — 修正条件で再検証
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");

const OUT = fileURLToPath(new URL("./", import.meta.url));
const STABLE = "https://yamamoto-ryuzo.github.io/kasugai-canvas-web/stable";
const KASC_CDN = `${STABLE}/projects/sample_qgis/kasugai_canvas.kasc`;
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

const prof = join(os.tmpdir(), "kasc-probe-cdn-v700b");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0, 200)));

// cesium 既定プロジェクト(isReady + listLayers, 最大120秒)
try {
  const errs0 = pageErrors.length;
  await page.goto(`${STABLE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.Cesium?.VERSION, null, { timeout: 180000 });
  const r = await page.evaluate(async () => {
    const t0 = Date.now();
    for (let i = 0; i < 120; i++) {
      const ready = !!window.kasugaiApi?.isReady;
      let layers = -1;
      try { layers = window.kasugaiApi?.listLayers?.().length ?? -1; } catch { layers = -1; }
      if (ready && layers > 0)
        return { ready, layers, elapsed: Math.round((Date.now() - t0) / 1000) };
      await new Promise(rs => setTimeout(rs, 1000));
    }
    return { ready: !!window.kasugaiApi?.isReady, layers: -1, elapsed: 120 };
  });
  rec("cesium.boot", r.ready && r.layers > 0, JSON.stringify(r));
  rec("cesium.default_project", r.layers > 0, `layers=${r.layers} in ${r.elapsed}s`);
  rec("cesium.no_pageerror", pageErrors.length === errs0, `errors=${pageErrors.length - errs0}`);
  await page.screenshot({ path: join(OUT, "cdn-cesium.png") });
} catch (e) { rec("cesium.boot", false, String(e).slice(0, 300)); }

// navara ?kasc= (kasugaiApi 出現まで最大180秒 + レイヤ確認)
try {
  const errs0 = pageErrors.length;
  await page.goto(`${STABLE}/navara/?kasc=${encodeURIComponent(KASC_CDN)}`,
    { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.kasugaiApi, null, { timeout: 180000 });
  const r = await page.evaluate(async () => {
    let layers = -1;
    for (let i = 0; i < 60; i++) {
      try { layers = window.kasugaiApi.listLayers().length; } catch { layers = -1; }
      if (layers > 0) break;
      await new Promise(rs => setTimeout(rs, 1000));
    }
    return { api: true, view: !!window.kascView, layers };
  });
  rec("navara.boot", r.api && r.view, JSON.stringify(r));
  rec("navara.kasc_layers", r.layers > 0, `listLayers=${r.layers}`);
  rec("navara.no_pageerror", pageErrors.length === errs0, `errors=${pageErrors.length - errs0}`);
  await page.screenshot({ path: join(OUT, "cdn-navara.png") });
} catch (e) { rec("navara.boot", false, String(e).slice(0, 300)); }

console.log("=== pageErrors ==="); pageErrors.slice(0, 10).forEach(e => console.log("ERR", e));
writeFileSync(join(OUT, "probe-cdn-v700-retry-results.json"), JSON.stringify(results, null, 2));
await ctx.close();
const fails = results.filter(r => !r.ok);
console.log(`=== DONE pass=${results.length - fails.length} fail=${fails.length} ===`);
process.exit(fails.length ? 1 : 0);
