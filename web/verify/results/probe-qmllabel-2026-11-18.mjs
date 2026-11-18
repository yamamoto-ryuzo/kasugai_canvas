// QML ラベル改善の実機検証:
//  A) エンジン別警告(各 engine 名で compileQmlStyle → warnings を確認)
//  B) Cesium: 行政区域レイヤの ⚠バッジ文言・障害物登録・ラベル表示
//  C) MapLibre: __kasc_label_img icon-image レイヤ + 実地物プロパティ
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = "C:/devin/kasugai_canvas/web/verify/results";
const BASE = "http://127.0.0.1:8510";
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

const prof = join(os.tmpdir(), "kasc-probe-qmllabel");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
page.on("pageerror", e => console.log("PAGEERR", String(e).slice(0, 200)));

const qmlText = await (await fetch("http://127.0.0.1:8510/projects/ProjectFiles/canvas_data/layer.qml")).text();
console.log("layer.qml bytes:", qmlText.length);

// --- A) エンジン別警告(ページ内で共有モジュールを直接 import して評価) ---
await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded", timeout: 120000 });
const warnByEngine = await page.evaluate(async (xml) => {
  const m = await import("/shared/qml-style.js");
  const out = {};
  for (const eng of ["cesium", "maplibre", "openlayers", "leaflet", "navara", null]) {
    const c = m.compileQmlStyle(xml, "test.qml", undefined, eng);
    out[eng ?? "null"] = c.warnings.filter(w => /bufferNoFill|障害物|obstacle/.test(w));
  }
  return out;
}, qmlText);
for (const [eng, ws] of Object.entries(warnByEngine)) {
  console.log(`  warn[${eng}]:`, JSON.stringify(ws));
}
rec("A1: cesium は bufferNoFill 警告なし", !warnByEngine.cesium.some(w => w.includes("bufferNoFill")),
  warnByEngine.cesium.join(" | ") || "(なし)");
rec("A2: cesium の障害物警告は実形状近似の文言",
  warnByEngine.cesium.some(w => w.includes("画面投影")), warnByEngine.cesium.join(" | ") || "(なし)");
rec("A3: leaflet の障害物警告は bbox 近似の文言",
  warnByEngine.leaflet.some(w => w.includes("bbox")), warnByEngine.leaflet.join(" | ") || "(なし)");
rec("A4: maplibre の障害物警告は非適用の文言",
  warnByEngine.maplibre.some(w => w.includes("適用されません")), warnByEngine.maplibre.join(" | ") || "(なし)");
rec("A5: maplibre は bufferNoFill 警告なし(icon-image 実装)",
  !warnByEngine.maplibre.some(w => w.includes("bufferNoFill")), warnByEngine.maplibre.join(" | ") || "(なし)");
rec("A6: navara は両方とも未対応警告", warnByEngine.navara.some(w => w.includes("bufferNoFill"))
  && warnByEngine.navara.some(w => w.includes("適用されません")), warnByEngine.navara.join(" | ") || "(なし)");

// --- B) Cesium 実プロジェクト ---
await page.goto(`${BASE}/cesium/?project=ProjectFiles`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(15000);
const ces = await page.evaluate(() => {
  const badges = [...document.querySelectorAll(".style-warn-badge")].map(b => b.title);
  const layerText = document.body.innerText.slice(0, 4000);
  return { badges, hasAdmin: layerText.includes("行政区域") };
});
console.log("  cesium badges:", JSON.stringify(ces.badges, null, 0).slice(0, 1200));
rec("B1: cesium 実プロジェクトに bufferNoFill 未対応警告が出ない",
  !ces.badges.some(t => t.includes("bufferNoFill")), ces.badges.join(" | ").slice(0, 300) || "(バッジなし)");
rec("B2: cesium 実プロジェクトの障害物警告が実形状文言",
  !ces.badges.some(t => t.includes("bboxで近似")), ces.badges.join(" | ").slice(0, 300) || "(バッジなし)");
const obsInfo = await page.evaluate(() => {
  // _qmlObstacles の収集数を全データソースから集計
  const vw = window.Cesium?.viewer || window.viewer;
  const out = { found: false, obstacles: 0, labelsShown: 0, labelsTotal: 0 };
  try {
    const v = window.viewer || window.kascViewer;
    if (!v) return out;
    out.found = true;
    for (const ds of v.dataSources?._dataSources || []) {
      out.obstacles += ds._qmlObstacles?.length || 0;
      for (const c of ds._qmlLabels || []) {
        out.labelsTotal++;
        const g = c.entity?.label || c.entity?.billboard;
        if (g?.show?.getValue?.() === true) out.labelsShown++;
      }
    }
  } catch (e) { out.err = String(e); }
  return out;
});
console.log("  cesium obs:", JSON.stringify(obsInfo));
rec("B3: 障害物登録が obstacle=1 のレイヤのみに限定", obsInfo.obstacles > 0, JSON.stringify(obsInfo));
await page.screenshot({ path: `${OUT}/qmllabel-cesium.png` });

// --- C) MapLibre 実プロジェクト ---
const page2 = await ctx.newPage();
page2.setDefaultTimeout(120000);
page2.on("pageerror", e => console.log("PAGEERR(ml)", String(e).slice(0, 200)));
await page2.goto(`${BASE}/maplibre/?project=ProjectFiles`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page2.waitForTimeout(20000);
const ml = await page2.evaluate(() => {
  const map = window.kascMap || window.map;
  if (!map?.getStyle) return { noMap: true };
  const layers = map.getStyle().layers || [];
  const iconLbl = layers.filter(l => l.type === "symbol"
    && JSON.stringify(l.layout?.["icon-image"] || "").includes("__kasc_label_img"));
  const styleImgs = Object.keys(map.style?.imageManager?.images || map.listImages?.() || {});
  return {
    iconLabelLayers: iconLbl.map(l => l.id),
    labelImgs: styleImgs.filter(i => String(i).startsWith("ql_")).length,
    totalLayers: layers.length,
  };
});
console.log("  ml:", JSON.stringify(ml));
rec("C1: maplibre に __kasc_label_img の icon-image レイヤがある",
  (ml.iconLabelLayers || []).length > 0, JSON.stringify(ml.iconLabelLayers));
rec("C2: ラベル画像が style に登録されている", (ml.labelImgs || 0) > 0, `ql_* images=${ml.labelImgs}`);
// 実地物に __kasc_label_img が焼かれているか
const feat = await page2.evaluate(() => {
  const map = window.kascMap || window.map;
  try {
    let hit = 0, checked = 0;
    for (const s of Object.values(map.style?.sourceCaches || map.style?._sources || {})) {
      const data = s.getSource?.()?.data || s._source?.data || s._data;
      const feats = data?.features || data?.data?.features;
      if (!feats) continue;
      for (const f of feats) {
        checked++;
        if (f.properties?.__kasc_label_img) hit++;
      }
    }
    return { hit, checked };
  } catch (e) { return { err: String(e) }; }
});
console.log("  ml features:", JSON.stringify(feat));
rec("C3: 地物に __kasc_label_img が焼き込まれている", (feat?.hit || 0) > 0, JSON.stringify(feat));
await page2.screenshot({ path: `${OUT}/qmllabel-maplibre.png` });

await ctx.close();
writeFileSync(`${OUT}/qmllabel-probe.json`, JSON.stringify(results, null, 2));
const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
