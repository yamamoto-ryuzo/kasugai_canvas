// 推奨ベクター形式(geojson:/flatgeobuf:/geoparquet:)への QML 適用検証
//  Phase A: 各形式の地物プロパティを実機で取得し、分類属性・ラベル属性を自動選定
//  Phase B: 選定属性で categorizedSymbol + ラベル付き QML を生成・適用し、
//           (1) 属性値別の色分けが地物へ反映される (2) ラベルが生成される
//           (3) 凡例(legend)が登録される を各形式で確認する
// 実行: node web/verify/results/probe-rec-qml.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL("./", import.meta.url));
mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".png": "image/png", ".fgb": "application/octet-stream",
  ".parquet": "application/octet-stream", ".txt": "text/plain" };

// ---- QML テンプレート(categorizedSymbol + 単純ラベル) ----
// palette: カテゴリ順に割当る RGB パレット(評価側の期待値計算と共有)
const PALETTE = [[230, 25, 75], [60, 180, 75], [0, 130, 200], [245, 130, 48],
  [145, 30, 180], [70, 240, 240], [240, 50, 230], [210, 245, 60]];
const escXml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function buildQml({ attr, labelAttr, categories, symbolType = "fill" }) {
  const symClass = symbolType === "marker" ? "SimpleMarker" : "SimpleFill";
  const catsXml = categories.map((v, i) =>
    `   <category symbol="${i}" value="${escXml(v)}" label="${escXml(v)}" render="true"/>`).join("\n");
  const symsXml = categories.map((v, i) => {
    const [r, g, b] = PALETTE[i % PALETTE.length];
    const inner = symbolType === "marker"
      ? `<Option name="color" type="QString" value="${r},${g},${b},255"/><Option name="size" type="QString" value="3"/><Option name="outline_style" type="QString" value="no"/>`
      : `<Option name="color" type="QString" value="${r},${g},${b},255"/><Option name="style" type="QString" value="solid"/><Option name="outline_style" type="QString" value="no"/>`;
    return `   <symbol type="${symbolType}" name="${i}" alpha="1" clip_to_extent="1">
    <layer class="${symClass}" enabled="1" pass="0"><Option type="Map">${inner}</Option></layer>
   </symbol>`;
  }).join("\n");
  return `<?xml version="1.0"?>
<qgis version="3.34" styleCategories="Symbology|Labeling">
 <renderer-v2 type="categorizedSymbol" attr="${escXml(attr)}" forceraster="0" enableorderby="0" symbollevels="0">
  <categories>
${catsXml}
  </categories>
  <symbols>
${symsXml}
  </symbols>
 </renderer-v2>
 <labeling type="simple">
  <settings calloutType="simple">
   <text-style fieldName="${escXml(labelAttr)}" isExpression="0" fontFamily="Arial" fontSize="12" fontSizeUnit="Point" fontWeight="50" textColor="0,0,0,255" textOpacity="1" previewBkgrdColor="255,255,255,255" legendString="Aa" useSubstitutions="0">
   </text-style>
   <placement placement="0" dist="0" offsetType="0" quadOffset="4" yOffset="0" xOffset="0" centroidWhole="0" centroidInside="0" predefinedPositionOrder="TR,TL,BR,BL,R,L,TSR,BSR" fitInPolygonOnly="0" distUnits="MM" layerType="PolygonGeometry" offsetUnits="MM" preserveRotation="1" priority="5" placementFlags="10"/>
   <rendering scaleVisibility="0" scaleMin="0" scaleMax="0" limitNumLabels="0" maxNumLabels="2000" obstacle="1" obstacleFactor="1" obstacleType="0" zIndex="0" upsidedownLabels="0" labelPerPart="0" mergeLines="0" minFeatureSize="0" displayAll="1" fontLimitPixelSize="0" drawLabels="1" unplacedVisibility="0"/>
  </settings>
 </labeling>
</qgis>`;
}

// ---- 属性選定: 2-8 種の文字列値を持つプロパティを分類属性、先頭文字列をラベル属性に ----
function pickAttrs(features) {
  const keys = new Set();
  for (const f of features.slice(0, 50)) for (const k of Object.keys(f.properties || {})) keys.add(k);
  let catAttr = null, catVals = null, labelAttr = null;
  for (const k of keys) {
    const vals = new Set();
    for (const f of features.slice(0, 80)) {
      const v = f.properties?.[k];
      if (typeof v === "string" && v) vals.add(v);
    }
    if (!labelAttr && vals.size >= 1) labelAttr = k;
    if (!catAttr && vals.size >= 2 && vals.size <= 8) { catAttr = k; catVals = [...vals].slice(0, 8); }
  }
  if (!catAttr) { // 全単一値でも ELSE カテゴリで描けるが、分類検証には2値以上必要
    for (const k of keys) {
      const vals = new Set();
      for (const f of features.slice(0, 80)) {
        const v = f.properties?.[k];
        if (v != null && v !== "") vals.add(String(v));
      }
      if (vals.size >= 2) { catAttr = k; catVals = [...vals].slice(0, 8); break; }
    }
  }
  return { catAttr, catVals, labelAttr: labelAttr || catAttr };
}

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

const mem = new Map(); // path -> body (動的生成 QML / kasc)
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (mem.has(p)) { res.writeHead(200, { "content-type": MIME[extname(p)] || "text/plain" }); res.end(mem.get(p)); return; }
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const prof = join(os.tmpdir(), "kasc-probe-profile-rec-qml");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0, 200)));

// ---- Phase A: 既存 rec-formats で各形式のプロパティ実体を取得 ----
const inspect = {};
try {
  const KASC = encodeURIComponent(`${base}/verify/rec-formats/rec-formats.kasc`);
  await page.goto(`${base}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window._viewer && window.kasugaiApi, null, { timeout: 90000 });
  await page.waitForFunction(() =>
    (window.kasugaiApi?.listLayers?.() || []).length >= 7, null, { timeout: 90000 });
  await page.waitForTimeout(8000);
  const raw = await page.evaluate(() => {
    const out = {};
    for (const l of window.kasugaiApi.listLayers()) {
      const gj = (window.kasugaiApi.getLayerGeoJson?.(l.id) ?? window.getLayerGeoJson?.(l.id));
      if (!gj?.features?.length) continue;
      out[l.id] = { type: l.type, title: l.title, n: gj.features.length,
        props: gj.features.slice(0, 80).map(f => f.properties || {}) };
    }
    return out;
  });
  for (const [id, v] of Object.entries(raw)) inspect[id] = v;
} catch (e) { rec("inspect.run", false, String(e).slice(0, 300)); }

const specs = []; // {id, type, qmlPath, catAttr, catVals, labelAttr, symbolType}
for (const [id, v] of Object.entries(inspect)) {
  const features = v.props.map(p => ({ properties: p }));
  const { catAttr, catVals, labelAttr } = pickAttrs(features);
  rec(`inspect.${v.type}`, !!catAttr && !!labelAttr,
    `${v.title}: cat=${catAttr}(${catVals?.length}種) label=${labelAttr} n=${v.n}`);
  if (!catAttr) continue;
  const qmlPath = `/probe/${v.type}.qml`;
  // geojson(points 混在)は marker シンボル、ポリゴン系は fill
  const symbolType = v.type === "geojson" ? "marker" : "fill";
  mem.set(qmlPath, buildQml({ attr: catAttr, labelAttr, categories: catVals, symbolType }));
  specs.push({ id, type: v.type, title: v.title, qmlPath, catAttr, catVals, labelAttr, symbolType });
}
rec("inspect.specs", specs.length >= 3,
  `QML 適用対象 ${specs.length}/3 (geojson/flatgeobuf/geoparquet)`);

// ---- Phase B: QML 適用 kasc を生成して再読み込み ----
try {
  const urlFor = s => s.type === "geojson" ? "/verify/rec-formats/points.geojson"
    : s.type === "flatgeobuf" ? "/verify/fgb-test/countries.fgb"
    : "/verify/rec-formats/example.parquet";
  const kasc = ["title: rec-qml", "base: 背景なし | none",
    "cam:世界|20|10|h=40000000|p=-90",
    ...specs.map((s, i) => `${s.type}: QML-${i} | ${urlFor(s)} | on${s.type === "flatgeobuf" ? " | bbox=off" : ""} | style=${s.qmlPath}`),
  ].join("\n");
  specs.forEach((s, i) => { s.qmlTitle = `QML-${i}`; });
  mem.set("/probe/qml.kasc", kasc);
  await page.goto(`${base}/cesium/?kasc=${encodeURIComponent(base + "/probe/qml.kasc")}`,
    { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window._viewer && window.kasugaiApi, null, { timeout: 90000 });
  await page.waitForTimeout(10000);

  for (const s of specs) {
    const r = await page.evaluate(({ spec }) => {
      const v = window._viewer;
      const now = window.Cesium.JulianDate.now();
      const PAL = [[230, 25, 75], [60, 180, 75], [0, 130, 200], [245, 130, 48],
        [145, 30, 180], [70, 240, 240], [240, 50, 230], [210, 245, 60]];
      const norm = c => c && [Math.round(c.red * 255), Math.round(c.green * 255), Math.round(c.blue * 255)];
      const expected = v2 => PAL[spec.catVals.indexOf(String(v2)) % PAL.length];
      const layers = window.kasugaiApi.listLayers();
      const lyr = layers.find(l => l.title === spec.qmlTitle);
      const layerId = lyr?.id;
      let ds = null;
      for (let i = 0; i < v.dataSources.length; i++) {
        const d = v.dataSources.get(i);
        if (d._kasugaiLayerId === layerId) { ds = d; break; }
      }
      if (!ds) return { err: `ds not found (title=${spec.qmlTitle})` };
      let colorOk = 0, colorNg = 0, labels = 0, shown = 0, total = 0;
      for (const e of ds.entities.values) {
        if (e._kascAux) continue;
        total++;
        const props = e.properties?.getValue?.(now) || {};
        const cat = spec.catVals.includes(String(props[spec.catAttr])) ? spec.catVals.indexOf(String(props[spec.catAttr])) : -1;
        const gfxC = e.polygon?.material?.color?.getValue?.(now)
          || e.polyline?.material?.color?.getValue?.(now);
        const isShown = (e.polygon?.show?.getValue?.(now) ?? e.polyline?.show?.getValue?.(now) ?? e.billboard?.show?.getValue?.(now) ?? true) !== false;
        if (isShown) shown++;
        if (spec.symbolType === "marker") {
          // marker QML: 点地物のみ対象。canvas 焼き付け色は読めないため
          // 「分類が成立=地物が show=true」で判定する(未分類は spec null で非表示)
          if (e.billboard && e.billboard.show?.getValue?.(now) === true && cat >= 0) colorOk++;
          else if (e.billboard && cat < 0) colorNg++;
        } else if ((e.polygon || e.polyline) && gfxC && cat >= 0) {
          const n = norm(gfxC), ex = expected(props[spec.catAttr]);
          if (n && ex && n[0] === ex[0] && n[1] === ex[1] && n[2] === ex[2]) colorOk++; else colorNg++;
        }
        const lt = e.label?.text?.getValue?.(now);
        if (lt) labels++;
      }
      return { total, shown, colorOk, colorNg, labels, legend: lyr?.legend?.length ?? -1, type: lyr?.type };
    }, { spec: s });
    if (r.err) { rec(`qml.${s.type}`, false, r.err); continue; }
    // 色分け: 照合できた地物の全数が期待色かつ不一致 0
    rec(`qml.${s.type}.colors`, r.colorOk > 0 && r.colorNg === 0,
      `color ok=${r.colorOk} ng=${r.colorNg} (cat=${s.catAttr})`);
    // ラベル: 属性値を持つ地物に label が生成されている
    rec(`qml.${s.type}.labels`, r.labels > 0, `labels=${r.labels}/${r.total} (field=${s.labelAttr})`);
    // 凡例: カテゴリ数ぶんの legend 登録
    rec(`qml.${s.type}.legend`, r.legend >= s.catVals.length,
      `legend=${r.legend} categories=${s.catVals.length}`);
    console.log(`  detail ${s.type}: total=${r.total} shown=${r.shown} colors=${r.colorOk}/${r.colorNg} labels=${r.labels} legend=${r.legend}`);
  }
  rec("no_pageerror", pageErrors.length === 0,
    `errors=${pageErrors.join(" | ") || "none"}`);
  await page.screenshot({ path: join(OUT, "rec-qml.png") });
} catch (e) { rec("probe.run", false, String(e).slice(0, 400)); }

console.log(JSON.stringify({ pass: results.filter(r => r.ok).length, total: results.length }));
await ctx.close();
srv.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
