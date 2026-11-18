// engine-leaflet 監査 Phase E: mvt:/pmtiles: (leaflet.vectorgrid) + Map options 拡張の検証
// 使い方: node web/verify/results/probe-leaflet-mvt.mjs  (サーバー :8510 起動中)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/verify/leaflet-audit/audit.kasc`);
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(`${OUT}leaflet-audit`, { recursive: true });
const result = { checks: {}, errors: [] };
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => result.errors.push(String(e).slice(0, 200)));

await page.goto(`${BASE}/leaflet/?kasc=${KASC}&dragging=off&scrollwheelzoom=off&taptolerance=42`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.L && window.kascMap && window.kasugaiApi, { timeout: 90000 });
await page.waitForTimeout(2500);

// ---- 0. Map options URL パススルー ----
result.checks.mapOpts = await page.evaluate(() => ({
  ok: window.kascMap.options.dragging === false && window.kascMap.options.scrollWheelZoom === false && window.kascMap.options.tapTolerance === 42,
  dragging: window.kascMap.options.dragging,
  scrollWheelZoom: window.kascMap.options.scrollWheelZoom,
  tapTolerance: window.kascMap.options.tapTolerance,
}));

// vectorgrid レイヤ収集ヘルパ（タイル描画完了待ちつき）
const waitVg = async (title, timeout = 20000) => await page.evaluate(async ([title, timeout]) => {
  const t0 = Date.now();
  let vg = null;
  while (Date.now() - t0 < timeout) {
    window.kascMap.eachLayer(l => { if (l instanceof L.VectorGrid) vg = l; });
    if (vg && Object.keys(vg._tiles || {}).some(k => vg._tiles[k].loaded || vg._tiles[k].el?.querySelector?.("path,canvas"))) break;
    await new Promise(r => setTimeout(r, 300));
  }
  if (!vg) return { ok: false, reason: "no VectorGrid on map" };
  const tiles = Object.values(vg._tiles || {});
  const rendered = tiles.filter(t => t.el?.querySelector?.("path") || t.el?.tagName === "CANVAS" || t.el?.querySelector?.("canvas"));
  const paths = tiles.reduce((n, t) => n + (t.el?.querySelectorAll?.("path").length || 0), 0);
  const svgPaths = [];
  for (const t of tiles) {
    for (const p of t.el?.querySelectorAll?.("path") || []) svgPaths.push({ fill: p.getAttribute("fill"), stroke: p.getAttribute("stroke") });
    if (svgPaths.length > 400) break;
  }
  return {
    ok: rendered.length > 0 && paths > 0,
    tiles: tiles.length, renderedTiles: rendered.length, paths,
    layerNames: vg.getDataLayerNames?.() || [],
    interactive: vg.options.interactive,
    sample: svgPaths.slice(0, 8),
  };
}, [title, timeout]);

// ---- 1. mvt-gsi (GSI optimal_bvmap-v1 テンプレート) ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("mvt-gsi", true));
result.checks.mvtGsi = await waitVg("mvt-gsi");
await page.screenshot({ path: `${OUT}leaflet-audit/mvt-gsi.png` });

// ---- 2. mvt-gsi-style (layers=AdmArea 絞込 + 塗り指定) ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("mvt-gsi", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("mvt-gsi-style", true));
result.checks.mvtStyle = await waitVg("mvt-gsi-style");
// AdmArea のみ=ポリゴン: fill=#ffcc00 が支配的か
result.checks.mvtStyle.fillCheck = await page.evaluate(() => {
  let vg = null;
  window.kascMap.eachLayer(l => { if (l instanceof L.VectorGrid) vg = l; });
  if (!vg) return { ok: false };
  const fills = {};
  for (const t of Object.values(vg._tiles || {})) {
    for (const p of t.el?.querySelectorAll?.("path") || []) {
      const f = (p.getAttribute("fill") || "").toLowerCase();
      fills[f] = (fills[f] || 0) + 1;
    }
  }
  const top = Object.entries(fills).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return { ok: !!fills["#ffcc00"], fills: top };
});
await page.screenshot({ path: `${OUT}leaflet-audit/mvt-gsi-style.png` });

// ---- 3. mvt-tilejson (TileJSON 経由) ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("mvt-gsi-style", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("mvt-tilejson", true));
result.checks.mvtTilejson = await waitVg("mvt-tilejson");
await page.screenshot({ path: `${OUT}leaflet-audit/mvt-tilejson.png` });

// ---- 4. pmtiles-firenze (PMTiles アーカイブ。フィレンツェへ移動して描画) ----
await page.evaluate(() => window.kasugaiApi.setLayerVisible("mvt-tilejson", false));
await page.evaluate(() => window.kasugaiApi.setLayerVisible("pmtiles-firenze", true));
await page.evaluate(() => window.kascMap.setView([43.7696, 11.2558], 14));
result.checks.pmtiles = await waitVg("pmtiles-firenze");
await page.screenshot({ path: `${OUT}leaflet-audit/pmtiles-firenze.png` });

// ---- 5. クリック → 属性タブ (interactive:true の vectorgrid 地物) ----
result.checks.clickAttr = await page.evaluate(async () => {
  let vg = null;
  window.kascMap.eachLayer(l => { if (l instanceof L.VectorGrid) vg = l; });
  if (!vg) return { ok: false, reason: "no VectorGrid" };
  // 描画済み path の1つに click イベントを発火(実 DOM イベント)
  let path = null;
  for (const t of Object.values(vg._tiles || {})) {
    path = t.el?.querySelector?.("path.leaflet-interactive") || t.el?.querySelector?.("path");
    if (path) break;
  }
  if (!path) return { ok: false, reason: "no interactive path" };
  const r = path.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  path.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: cx, clientY: cy, view: window }));
  await new Promise(r2 => setTimeout(r2, 500));
  const attr = document.querySelector("#attr-content");
  const text = attr?.textContent || "";
  return { ok: /pmtiles-firenze|vt_code|roads|water|earth|buildings|landuse|natural|physical|places|pois|boundaries/i.test(text), snippet: text.slice(0, 160) };
});

// ---- 6. 非対応リストに mvt/pmtiles が残っていないこと ----
result.checks.unsupported = await page.evaluate(() => {
  const el = document.querySelector("#unsupported");
  const t = el?.textContent || "";
  return { ok: !/mvt|pmtiles|vectortile/.test(t), text: t.slice(0, 120) };
});

writeFileSync(`${OUT}leaflet-audit/mvt-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
