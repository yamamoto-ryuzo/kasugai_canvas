// 検証: maplibre-gl 6.19.0 実起動 + leaflet.heat 1.0.1 (global build) ロード
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));

// maplibre 6.19.0 実起動
try {
  await page.goto(`${BASE}/maplibre/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap?.loaded?.(), { timeout: 60000 });
  await page.waitForTimeout(3000);
  const v = await page.evaluate(async () => {
    const ml = await import("https://cdn.jsdelivr.net/npm/maplibre-gl@6.19.0/dist/maplibre-gl.mjs");
    return { version: ml.getVersion?.() ?? ml.version, layers: window.kascMap.getStyle().layers.length, oklab: typeof ml.Map };
  });
  console.log("maplibre:", JSON.stringify(v));
  await page.screenshot({ path: `${OUT}upd-maplibre.png` });
} catch (e) { console.log("maplibre FAILED", String(e).slice(0, 250)); }

// leaflet.heat 1.0.1 グローバルビルドのロード確認
try {
  await page.goto(`${BASE}/leaflet/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.L, { timeout: 60000 });
  const heat = await page.evaluate(async () => {
    const mod = await import("../shared/lazy-lib.js").catch(() => null);
    const load = mod?.loadScriptOnce ?? ((u) => new Promise((res, rej) => { const s = document.createElement("script"); s.src = u; s.onload = res; s.onerror = rej; document.head.append(s); }));
    try {
      await load("https://cdn.jsdelivr.net/npm/leaflet.heat@1.0.1/dist/leaflet-heat-global.js");
      const layer = L.heatLayer([[35.68, 139.77, 1], [35.69, 139.78, 0.5]], { radius: 25 });
      return { hasFactory: typeof L.heatLayer === "function", made: !!layer, added: (layer.addTo(window.kascMap), true) };
    } catch (e) { return { error: String(e).slice(0, 150) }; }
  });
  console.log("leaflet.heat:", JSON.stringify(heat));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}upd-leaflet-heat.png` });
} catch (e) { console.log("leaflet FAILED", String(e).slice(0, 250)); }

await browser.close();
