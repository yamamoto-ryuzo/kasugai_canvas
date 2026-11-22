// QML レンダラ種別の網羅検証プローブ
// _ren_verify プロジェクトの各 renderer-v2(heatmap/pointCluster/pointDisplacement/
// mergedFeature/invertedPolygon/graduated/embedded/25d/symbolLevels) が、
// Cesium で所期の描画物を生成すること、MapLibre/OpenLayers でネイティブの
// heatmap/cluster に届くことを確認する
//  実行: node web/verify/results/probe-qml-renderers.mjs  (dev サーバ :8520 前提)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";

const BASE = process.env.KASC_BASE || "http://localhost:8520";
const KASC = `${BASE}/projects/_ren_verify/kasugai_canvas.kasc`;
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const browser = await chromium.launch();

// ---------- Cesium ----------
{
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [], warns = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "warning" || /warn/i.test(m.text())) warns.push(m.text().slice(0, 160)); });
  await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent(KASC)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kasugaiApi && window._viewer, { timeout: 30000 });
  // 25d 押出し検証のため DEM entity ドレープを OFF(クランプと押出しは両立しない仕様)
  await page.evaluate(() => {
    const cb = document.querySelector("#drape-geojson-dem");
    if (cb?.checked) { cb.checked = false; cb.dispatchEvent(new Event("change")); }
  });
  // 9層全部の描画対象が確定するまで待機(ds か prim が各層に1つ)
  await page.waitForFunction(() => {
    const layers = window.kasugaiApi.listLayers();
    if (layers.length < 9) return false;
    const v = window._viewer;
    let covered = 0;
    for (const lay of layers) {
      for (let i = 0; i < v.dataSources.length; i++) {
        const ds = v.dataSources.get(i);
        if (ds._kasugaiLayerId === lay.id) { covered++; break; }
      }
    }
    return covered >= 9;
  }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(5000);

  const info = await page.evaluate(() => {
    const v = window._viewer, out = {};
    const layers = window.kasugaiApi.listLayers();
    for (const lay of layers) {
      let ds = null;
      for (let i = 0; i < v.dataSources.length; i++) {
        const d = v.dataSources.get(i);
        if (d._kasugaiLayerId === lay.id) { ds = d; break; }
      }
      if (!ds) { out[lay.title] = null; continue; }
      const kinds = {}, colors = new Set(), zset = new Set();
      let extr = 0, zIdx = 0, dispCenter = 0, nEnt = 0;
      for (const e of ds.entities?.values || []) {
        nEnt++;
        if (e._kascDisplacementCenter) dispCenter++;
        if (e.rectangle) kinds.rectangle = (kinds.rectangle || 0) + 1;
        if (e.polygon) {
          kinds.polygon = (kinds.polygon || 0) + 1;
          const h = e.polygon.extrudedHeight?.getValue?.();
          if (Number.isFinite(h) && h > 0) extr++;
          if (e.polygon.zIndex != null) zIdx++;
          const c = e.polygon.material?.color?.getValue?.();
          if (c) colors.add(`${c.red.toFixed(2)},${c.green.toFixed(2)},${c.blue.toFixed(2)}`);
        }
        if (e.polyline) {
          kinds.polyline = (kinds.polyline || 0) + 1;
          const zi = e.polyline.zIndex?.getValue?.() ?? e.polyline.zIndex;
          if (zi != null) { zIdx++; zset.add(zi); }
        }
        if (e.billboard) {
          kinds.billboard = (kinds.billboard || 0) + 1;
          try {
            const img = e.billboard.image?.getValue?.();
            if (img?.toDataURL) colors.add(img.toDataURL().slice(-60));
          } catch (_) {}
        }
        if (e.point) {
          kinds.point = (kinds.point || 0) + 1;
          const c = e.point.material?.color?.getValue?.();
          if (c) colors.add(`${c.red.toFixed(2)},${c.green.toFixed(2)},${c.blue.toFixed(2)}`);
        }
      }
      out[lay.title] = {
        kinds, nColors: colors.size, extr, zIdx, zset: [...zset], dispCenter, nEnt,
        clustering: !!ds.clustering?.enabled,
        pixelRange: ds.clustering?.pixelRange ?? null,
      };
    }
    return out;
  });
  console.log("cesium:", JSON.stringify(info, null, 1));

  for (const t of ["ren_embedded", "ren_merged", "ren_inverted", "ren_graduated"])
    check(`${t}: 地物 entity 生成`, info[t]?.nEnt > 0, JSON.stringify(info[t]?.kinds));
  check("ren_25d: extrudedHeight>0(非ドレープ)", info.ren_25d?.extr > 0, `extr=${info.ren_25d?.extr}`);
  check("ren_heatmap: ヒートマップ矩形 ds", (info.ren_heatmap?.kinds?.rectangle || 0) > 0, JSON.stringify(info.ren_heatmap?.kinds));
  check("ren_pointcluster: クラスタ有効", info.ren_pointcluster?.clustering === true, `range=${info.ren_pointcluster?.pixelRange}`);
  check("ren_pointdisp: 変位配置エンティティ", (info.ren_pointdisp?.dispCenter || 0) > 0, `dispCenter=${info.ren_pointdisp?.dispCenter}`);
  check("ren_graduated: 2色以上に分類", (info.ren_graduated?.nColors || 0) >= 2, `colors=${info.ren_graduated?.nColors}`);
  check("symlevel: zIndex(zRank) 適用・カテゴリ別区別",
    info.symlevel?.zIdx > 0 && (info.symlevel?.zset?.length || 0) >= 2,
    `zIdx=${info.symlevel?.zIdx} zset=${JSON.stringify(info.symlevel?.zset)}`);
  check("cesium pageerror なし", errors.length === 0, errors.slice(0, 3).join("|"));
  const qmlWarns = warns.filter(w => /レンダラ|QML|pointDisplacement|heatmap|mergedFeature|inverted|25d/i.test(w));
  console.log("  (approx warnings:", qmlWarns.slice(0, 6).join(" | "), ")");
  await page.close();
}

// ---------- MapLibre ----------
{
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`${BASE}/maplibre/?kasc=${encodeURIComponent(KASC)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kasugaiApi && window.kascMap, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(15000);
  const info = await page.evaluate(() => {
    const map = window.kascMap, st = map.getStyle();
    const heat = st.layers.filter(l => l.type === "heatmap").map(l => l.id);
    const clustered = Object.entries(st.sources).filter(([, s]) => s.cluster === true).map(([k]) => k);
    return { heat, clustered, nLayers: st.layers.length };
  });
  console.log("maplibre:", JSON.stringify(info));
  check("maplibre: heatmap レイヤ生成", info.heat.length > 0, JSON.stringify(info.heat));
  check("maplibre: cluster ソース生成", info.clustered.length > 0, JSON.stringify(info.clustered));
  check("maplibre pageerror なし", errors.length === 0, errors.slice(0, 3).join("|"));
  await page.close();
}

// ---------- OpenLayers ----------
{
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`${BASE}/openlayers/?kasc=${encodeURIComponent(KASC)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kasugaiApi && window.kascMap, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(15000);
  const info = await page.evaluate(() => {
    const map = window.kascMap;
    if (!map?.getLayers) return { found: false };
    const types = [];
    map.getLayers().forEach(l => {
      const src = l.getSource?.();
      types.push({
        layer: l.constructor?.name || "?", visible: l.getVisible?.(),
        src: src?.constructor?.name || null,
      });
    });
    return { found: true, types };
  });
  console.log("openlayers:", JSON.stringify(info, null, 1));
  check("openlayers: heatmap/クラスタ層が存在",
    !!info.types?.some(t => /Heatmap/i.test(t.layer) || /Cluster/i.test(t.src || "")),
    JSON.stringify(info.types?.map(t => `${t.layer}/${t.src}`)));
  check("openlayers pageerror なし", errors.length === 0, errors.slice(0, 3).join("|"));
  await page.close();
}

await browser.close();
console.log(`\n== ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
