// Leaflet ラインが閉合・塗りつぶしポリゴン化していないかの検証 (2026-11-18)
//  - LineString/MultiLineString が fill="none" で描画されるか
//  - simplestyle の fill/fill-opacity プロパティがラインへ漏れないか
//  - QML line シンボル適用時も塗られないか
//  - Polygon 混在レイヤーでラインだけが正しく非塗りか
//  - renderer=canvas 経路(スクリーンショット目視用)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright-core/index.mjs");
const WEB = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL("./", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };

// 開いた折れ線(3頂点・非閉合)。閉合描画されると三角形の塗りが出る形にする
const OPEN_LINE = [[139.70, 35.66], [139.76, 35.70], [139.82, 35.66]];
const GEO_A = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { n: "A1-open" }, geometry: { type: "LineString", coordinates: OPEN_LINE } },
  { type: "Feature", properties: { n: "A2-multi" }, geometry: { type: "MultiLineString",
    coordinates: [[[139.70, 35.63], [139.76, 35.65]], [[139.76, 35.65], [139.82, 35.63]]] } }] });
const GEO_B = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { n: "B1", stroke: "#00aa00", "stroke-width": 3,
    fill: "#ff0000", "fill-opacity": 0.6 },
    geometry: { type: "LineString", coordinates: OPEN_LINE } }] });
const GEO_C = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { n: "C1" }, geometry: { type: "LineString", coordinates: OPEN_LINE } }] });
const GEO_D = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { n: "D-poly" }, geometry: { type: "Polygon",
    coordinates: [[[139.70, 35.60], [139.74, 35.60], [139.74, 35.62], [139.70, 35.62], [139.70, 35.60]]] } },
  { type: "Feature", properties: { n: "D-line" }, geometry: { type: "LineString",
    coordinates: [[139.76, 35.60], [139.80, 35.62], [139.84, 35.60]] } }] });
const LINE_QML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.40" styleCategories="Symbology">
 <renderer-v2 type="singleSymbol" symbollevels="0" referencescale="-1" enableorderby="0" forceraster="0">
  <symbols>
   <symbol alpha="1" name="0" type="line" clip_to_extent="1">
    <layer class="SimpleLine" enabled="1" locked="0" pass="0">
     <Option type="Map">
      <Option name="line_color" type="QString" value="220,40,40,255"/>
      <Option name="line_width" type="QString" value="3"/>
      <Option name="line_style" type="QString" value="solid"/>
     </Option>
    </layer>
   </symbol>
  </symbols>
 </renderer-v2>
</qgis>`;
const KASC = [
  "title: leaflet line-fill probe",
  "base: ベースマップなし | none",
  "cam: 初期 | 35.65 | 139.77 | h=9000 | p=-90",
  "geojson: A-plain-line | canvas_data/a.geojson",
  "geojson: B-simplestyle-fill | canvas_data/b.geojson",
  "geojson: C-qml-line | canvas_data/c.geojson | style=canvas_data/line.qml",
  "geojson: D-mixed | canvas_data/d.geojson",
  "geojson: E-canvas-line | canvas_data/a.geojson | renderer=canvas",
].join("\n");

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const mem = {
    "/probe/test.kasc": KASC,
    "/probe/canvas_data/a.geojson": GEO_A,
    "/probe/canvas_data/b.geojson": GEO_B,
    "/probe/canvas_data/c.geojson": GEO_C,
    "/probe/canvas_data/d.geojson": GEO_D,
    "/probe/canvas_data/line.qml": LINE_QML,
  };
  if (mem[p]) { res.writeHead(200, { "content-type": MIME[extname(p)] || "text/plain" }); res.end(mem[p]); return; }
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
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail }); };

const prof = join(os.tmpdir(), "kasc-probe-profile-leaflet-linefill");
const ctx = await chromium.launchPersistentContext(prof, { headless: true });
const page = await ctx.newPage();
page.on("pageerror", e => rec("pageerror", false, String(e)));
page.on("console", m => { if (m.type() === "error" || m.type() === "warning")
  console.log(`[console.${m.type()}] ${m.text()}`); });
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${base}/leaflet/?kasc=${encodeURIComponent(base + "/probe/test.kasc")}`,
  { waitUntil: "domcontentloaded", timeout: 30000 });
try {
  await page.waitForSelector(".leaflet-overlay-pane path", { timeout: 15000 });
} catch (_) { console.log("no overlay path within 15s"); }
await page.waitForTimeout(2500);
await page.screenshot({ path: join(OUT, "leaflet-line-fill.png"), fullPage: false });

// kasc-lN ペイン = .kasc 行順。各 path 要素の fill/stroke/d を回収
const panes = await page.evaluate(() => {
  const out = {};
  for (const pane of document.querySelectorAll(".leaflet-pane")) {
    const m = /leaflet-(kasc-l\d+)-pane/.exec(pane.className || "");
    if (!m) continue;
    out[m[1]] = [...pane.querySelectorAll("path")].map(p => ({
      d: p.getAttribute("d"),
      fill: p.getAttribute("fill"),
      fillOpacity: p.getAttribute("fill-opacity"),
      stroke: p.getAttribute("stroke"),
      strokeWidth: p.getAttribute("stroke-width"),
    }));
  }
  return out;
});
// pane 割当は renderProject が entries を逆順で newKascPane() するため
// kasc-l0 = .kasc 最終行。レイヤ名は逆順で引く
const LAYER_ORDER = ["E-canvas-line", "D-mixed", "C-qml-line", "B-simplestyle-fill", "A-plain-line"];
console.log(JSON.stringify(panes, null, 1));
for (const [pane, paths] of Object.entries(panes)) {
  const idx = Number(/kasc-l(\d+)/.exec(pane)?.[1]);
  const name = LAYER_ORDER[idx] ?? pane;
  for (const [i, p] of paths.entries()) {
    const closed = /z\s*$/i.test(p.d || "");
    const filled = p.fill && p.fill !== "none";
    // Polyline が fill されると d は開いたまま fill 属性だけ付く。
    // 「開いた d なのに fill=none 以外」= ラインの誤塗りを検出する
    rec(`${name}[${i}]`, !(filled && !closed),
      `fill=${p.fill} closed=${closed} stroke=${p.stroke} d=${(p.d || "").slice(0, 60)}`);
  }
}
if (!Object.keys(panes).length) rec("panes-found", false, "kasc-lN ペインが見つからない");

await ctx.close();
srv.close();
writeFileSync(join(OUT, "leaflet-line-fill-results.json"), JSON.stringify(results, null, 2));
for (const r of results) console.log(`${r.ok ? "OK " : "NG "} ${r.id}: ${r.detail}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
