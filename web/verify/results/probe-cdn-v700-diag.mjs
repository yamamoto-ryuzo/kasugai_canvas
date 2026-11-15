// diag: cesium 既定プロジェクト / navara ブート — 長待機 + console/network 捕捉
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");

const STABLE = "https://yamamoto-ryuzo.github.io/kasugai-canvas-web/stable";
const prof = join(os.tmpdir(), "kasc-probe-cdn-diag");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
const errors = [], failures = [], conmsgs = [];
page.on("pageerror", e => errors.push(String(e).slice(0, 300)));
page.on("requestfailed", r => failures.push(`${r.failure()?.errorText} ${r.url().slice(0, 160)}`));
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") conmsgs.push(`${m.type()}: ${m.text().slice(0, 200)}`); });

// --- cesium 既定プロジェクト: 最大180秒で isReady/layers をポーリング ---
await page.goto(`${STABLE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.Cesium?.VERSION, null, { timeout: 180000 });
const ces = await page.evaluate(async () => {
  const t0 = Date.now();
  const hist = [];
  for (let i = 0; i < 180; i++) {
    const ready = !!window.kasugaiApi?.isReady;
    let layers = -1;
    try { layers = window.kasugaiApi?.listLayers?.().length ?? -1; } catch { layers = -1; }
    if (i % 10 === 0 || (ready && layers > 0)) hist.push(`${Math.round((Date.now() - t0) / 1000)}s ready=${ready} layers=${layers}`);
    if (ready && layers > 0) return { ready, layers, elapsed: Math.round((Date.now() - t0) / 1000), hist };
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ready: false, layers: -1, elapsed: 180, hist };
});
console.log("CESIUM", JSON.stringify(ces));

// --- navara: 120秒待機で kascView / kasugaiApi ---
const errors0 = errors.length;
await page.goto(`${STABLE}/navara/`, { waitUntil: "domcontentloaded", timeout: 60000 });
const nav = await page.evaluate(async () => {
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    if (window.kascView || window.kasugaiApi) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  return { elapsed: Math.round((Date.now() - t0) / 1000),
    view: !!window.kascView, api: !!window.kasugaiApi,
    scripts: [...document.scripts].map(s => s.src || "inline").slice(-5) };
});
console.log("NAVARA", JSON.stringify(nav));

console.log("=== errors ===", JSON.stringify(errors.slice(0, 8), null, 1));
console.log("=== reqFailed ===", JSON.stringify(failures.slice(0, 15), null, 1));
console.log("=== console err/warn(last15) ===", JSON.stringify(conmsgs.slice(-15), null, 1));
await ctx.close();
