// _genfeat_probe.mjs — GeometryGenerator/CentroidFill 生成地物展開の検証
// ?project=_qml_verify を dev Canvas で読み、生成地物数・QML 警告・
// page error を収集する
// usage: node _genfeat_probe.mjs <engine>
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ENGINE = process.argv[2] || "leaflet";
const TARGETS = ["qmltest_GeomGen_fill", "qmltest_GeomGen_line", "qmltest_GeomGen_marker",
  "qmltest_CentroidFill", "qmltest_ren_inverted", "qmltest_ren_heatmap", "qmltest_ren_25d",
  "qmltest_ArrowLine", "qmltest_MarkerLine", "qmltest_InterpolatedLine",
  "qmltest_LinearReferencing", "qmltest_ren_pointdisp", "qmltest_Lineburst"];
const CANVAS = `http://127.0.0.1:${process.env.CANVAS_PORT || "8520"}`;

const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 790, height: 841 } });
const errors = [];
pg.on("pageerror", e => errors.push(String(e)));
await pg.goto(`${CANVAS}/${ENGINE}/?project=_qml_verify`, { waitUntil: "domcontentloaded", timeout: 30000 });
await pg.waitForFunction(() => window.kasugaiApi?.isReady === true || window._viewer, undefined, { timeout: 120000, polling: 800 }).catch(() => {});
await pg.waitForTimeout(5000);

// 生成地物数(getLayerGeoJson)の集計
const census = await pg.evaluate(TARGETS => {
  const api = window.kasugaiApi;
  const out = {};
  for (const l of api?.listLayers?.() || []) {
    const title = String(l.title || l.id || "");
    if (!TARGETS.includes(title)) continue;
    const gj = api.getLayerGeoJson?.(l.id);
    const feats = gj?.features || [];
    const gen = feats.filter(f => f?.properties?.__kasc_ggen);
    out[title] = {
      total: feats.length, gen: gen.length,
      genKinds: [...new Set(gen.map(f => f.geometry?.type))],
      // 生成地物に有効な style キーが焼かれているか(maplibre 経路)
      genKeys: [...new Set(gen.flatMap(f => Object.keys(f.properties || {}).filter(k => k.startsWith("__kasc_"))))].slice(0, 12),
    };
  }
  return out;
}, TARGETS);
console.log(`== ${ENGINE} generated-feature census ==`);
for (const [t, r] of Object.entries(census))
  console.log(`  ${t}: total=${r.total} gen=${r.gen} kinds=[${r.genKinds}] keys=[${r.genKeys.join(",")}]`);

// エンジン名を渡して loadQmlStyle し、警告を採取(実パスと同じ画像ロード経路)
const warns = await pg.evaluate(async ({ engine, targets }) => {
  const base = "http://127.0.0.1:8520/projects/_qml_verify/";
  const m = await import("/shared/qml-style.js");
  const out = {};
  for (const t of targets) {
    try {
      const c = await m.loadQmlStyle(`${base}canvas_data/${t}.qml`, async u => (await fetch(u)).text(), engine);
      out[t] = c.warnings || [];
    } catch (e) { out[t] = ["LOAD ERR: " + String(e)]; }
  }
  return out;
}, { engine: ENGINE, targets: TARGETS });
console.log(`== ${ENGINE} QML warnings(engine=${ENGINE}) ==`);
for (const [t, ws] of Object.entries(warns))
  for (const w of ws) console.log(`  ${t}: ${w}`);
console.log(`== ${ENGINE} page errors ==`, errors.length ? errors : "none");
await browser.close();
