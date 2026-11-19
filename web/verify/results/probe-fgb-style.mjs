// FlatGeobuf スタイル経路プローブ (engine-flatgeobuf-style スキル)
//  実行: node web/verify/results/probe-fgb-style.mjs
//  カバレッジ:
//   A) モジュール: simplestyle 属性の FGB 透過・resolveDefault*Style 解決値・
//      markerSymbolSpec・ヘッダ title/description/metadata の再構築と露出・
//      probeQmlSidecar(.qml サイドカー自動検出) の全分岐
//   B) cesium: style= 明示適用・.qml サイドカー自動検出・simplestyle 地物
//   C) leaflet: .kasc-ssym(marker-symbol) DOM・サイドカー QML 適用色
//  テスト資産: FGB は toFlatGeobuf で生成→PUT。QML フィクスチャ・
//      ヘッダ再構築(title/description/metadata)はページ内 flatbuffers で実施
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL("./", import.meta.url));
mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".fgb": "application/octet-stream", ".zst": "application/octet-stream",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };

const reqLog = [];
const srv = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = decodeURIComponent(u.pathname);
  try {
    if (req.method === "PUT" && p.startsWith("/verify/tmp/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const fp = resolve(join(WEB, p));
      mkdirSync(dirname(fp), { recursive: true });
      await writeFile(fp, Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    const mime = MIME[extname(q)] || "application/octet-stream";
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m && (m[1] || m[2])) {
      const s = m[1] === "" ? Math.max(data.length - Number(m[2]), 0) : Number(m[1]);
      const e = m[1] === "" || !m[2] ? data.length - 1 : Number(m[2]);
      reqLog.push({ path: q, range: `${s}-${e}` });
      res.writeHead(206, { "content-type": mime, "accept-ranges": "bytes",
        "content-range": `bytes ${s}-${e}/${data.length}` });
      res.end(data.subarray(s, e + 1));
      return;
    }
    reqLog.push({ path: q, range: null });
    res.writeHead(200, { "content-type": mime, "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("PAGEERR:", String(e).slice(0, 200)));

// ============ Phase A: モジュール単位 ============
await page.goto(`${base}/verify/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
const a = await page.evaluate(async (b) => {
  const vl = await import("../shared/vector-load.js");
  const ef = await import("../shared/export-formats.js");
  const kasc = await import("../shared/kasc.js");
  const out = {};

  // スタイル属性地物コレクション
  const FC = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { name: "pt1", title: "ポイント1",
        description: "説明テキスト", "marker-color": "#e00",
        "marker-size": "large", "marker-symbol": "1" },
      geometry: { type: "Point", coordinates: [139.7, 35.6] } },
    { type: "Feature", properties: { name: "ln1", stroke: "#00e",
        "stroke-width": 3, "stroke-opacity": 0.5 },
      geometry: { type: "LineString", coordinates: [[139, 35], [140, 36]] } },
    { type: "Feature", properties: { name: "pg1", fill: "#0e0",
        "fill-opacity": 0.3, stroke: "#050", "stroke-width": 2 },
      geometry: { type: "Polygon", coordinates: [[[135, 34], [136, 34], [136, 35], [135, 34]]] } },
  ]};
  const POLY = { type: "FeatureCollection", features: [FC.features[2]] };

  const put = async (name, body) =>
    (await fetch(`${b}/verify/tmp/${name}`, { method: "PUT", body })).status;

  // A1: simplestyle 属性の FGB 透過
  out.attrPut = await put("style-attrs.fgb", await ef.toFlatGeobuf(FC));
  const it1 = { type: "flatgeobuf", title: "attr", url: `${b}/verify/tmp/style-attrs.fgb`, opts: { bbox: "off" } };
  const r1 = await vl.loadVectorItem(it1, "");
  const p0 = r1.geojson.features.find(f => f.properties.name === "pt1")?.properties || {};
  out.attrs = { n: r1.geojson.features.length, mc: p0["marker-color"], ms: p0["marker-size"],
    sym: p0["marker-symbol"], title: p0.title, desc: p0.description,
    lw: r1.geojson.features.find(f => f.properties.name === "ln1")?.properties?.["stroke-width"],
    fo: r1.geojson.features.find(f => f.properties.name === "pg1")?.properties?.["fill-opacity"] };

  // A2: resolveDefault*Style + markerSymbolSpec の解決値
  // (索引付き serialize は地物を Hilbert ソートするため name で検索)
  const byName = n => r1.geojson.features.find(f => f.properties.name === n)?.properties || {};
  out.pt = kasc.resolveDefaultPointStyle(p0, { color: "#123456", size: 10 });
  out.ln = kasc.resolveDefaultLineStyle(byName("ln1"), { color: "#123456", width: 1 });
  out.pg = kasc.resolveDefaultPolygonStyle(byName("pg1"), { fill: "#123456" }, { color: "#123456" });
  out.sym = kasc.markerSymbolSpec(p0["marker-symbol"]);

  // A3: ヘッダ再構築(title/description/metadata 注入) → readFlatGeobufMeta
  try {
    const fb = await import("https://cdn.jsdelivr.net/npm/flatbuffers@25.9.23/+esm");
    const { Header } = await import("https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/lib/mjs/flat-geobuf/header.js/+esm");
    const bytes = await ef.toFlatGeobuf(POLY);
    const hdrLen = new DataView(bytes.buffer, 8, 4).getUint32(0, true);
    const bb = new fb.ByteBuffer(bytes.subarray(8, 8 + 4 + hdrLen));
    const h = Header.getSizePrefixedRootAsHeader(bb);
    const builder = new fb.Builder(256);
    const nameOff = h.name() ? builder.createString(h.name()) : 0;
    const colOffs = [];
    const { Column } = await import("https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/lib/mjs/flat-geobuf/column.js/+esm");
    for (let i = 0; i < h.columnsLength(); i++) {
      const c = h.columns(i);
      const nOff = builder.createString(c.name());
      Column.startColumn(builder);
      Column.addName(builder, nOff);
      Column.addType(builder, c.type());
      colOffs.push(Column.endColumn(builder));
    }
    const colsVec = colOffs.length ? Header.createColumnsVector(builder, colOffs) : 0;
    const titleOff = builder.createString("MetaTitle");
    const descOff = builder.createString("MetaDescription-説明");
    const metaOff = builder.createString('{"source":"probe-fgb-style"}');
    Header.startHeader(builder);
    if (nameOff) Header.addName(builder, nameOff);
    Header.addGeometryType(builder, h.geometryType());
    Header.addHasZ(builder, h.hasZ()); Header.addHasM(builder, h.hasM());
    Header.addHasT(builder, h.hasT()); Header.addHasTm(builder, h.hasTm());
    Header.addFeaturesCount(builder, h.featuresCount());
    Header.addIndexNodeSize(builder, h.indexNodeSize());
    if (colsVec) Header.addColumns(builder, colsVec);
    Header.addTitle(builder, titleOff);
    Header.addDescription(builder, descOff);
    Header.addMetadata(builder, metaOff);
    builder.finishSizePrefixed(Header.endHeader(builder));
    const newHdr = builder.asUint8Array();
    const merged = new Uint8Array(8 + newHdr.length + (bytes.length - 8 - 4 - hdrLen));
    merged.set(bytes.subarray(0, 8), 0);
    merged.set(newHdr, 8);
    merged.set(bytes.subarray(8 + 4 + hdrLen), 8 + newHdr.length);
    out.metaPut = await put("style-meta.fgb", merged);
    out.meta = await vl.readFlatGeobufMeta(`${b}/verify/tmp/style-meta.fgb`);
    const itm = { type: "flatgeobuf", title: "meta", url: `${b}/verify/tmp/style-meta.fgb`, opts: { bbox: "off" } };
    const rm = await vl.loadVectorItem(itm, "");
    out.metaLoad = { n: rm.geojson.features.length,
      summary: vl.summarizeFlatGeobufHeader(itm.fgbHeader) };
  } catch (e) { out.meta = { error: String(e).slice(0, 240) }; }

  // A4: probeQmlSidecar 全分岐
  const QML = `<qgis version="3.34" styleCategories="Symbology|Labeling">
 <renderer-v2 type="singleSymbol" symbollevels="0" enableorderby="0" forceraster="0">
  <symbols><symbol alpha="1" name="0" type="fill" clip_to_extent="1">
   <layer class="SimpleFill" enabled="1" locked="0" pass="0"><Option type="Map">
    <Option name="color" type="QString" value="255,0,255,255"/>
    <Option name="outline_color" type="QString" value="0,0,0,255"/>
    <Option name="outline_width" type="QString" value="0.5"/>
   </Option></layer></symbol></symbols>
 </renderer-v2></qgis>`;
  const QML2 = QML.replace("255,0,255,255", "0,255,255,255");
  await put("sidecar.qml", QML);
  await put("explicit.qml", QML2);
  await put("sidecar.fgb", await ef.toFlatGeobuf(POLY));
  await put("explicit.fgb", await ef.toFlatGeobuf(POLY));
  await put("nosidecar.fgb", await ef.toFlatGeobuf(POLY));
  const it2 = { type: "flatgeobuf", title: "sc", url: `${b}/verify/tmp/sidecar.fgb`, opts: {} };
  out.sidecar = { ret: await vl.probeQmlSidecar(it2), styleUrl: it2.styleUrl, optStyle: it2.opts.style };
  const it3 = { type: "flatgeobuf", title: "no", url: `${b}/verify/tmp/nosidecar.fgb`, opts: {} };
  out.nosidecar = { ret: await vl.probeQmlSidecar(it3), styleUrl: it3.styleUrl };
  const it4 = { type: "flatgeobuf", title: "ex", url: `${b}/verify/tmp/sidecar.fgb`,
    opts: { style: `${b}/verify/tmp/explicit.qml` } };
  out.explicitSkip = { ret: await vl.probeQmlSidecar(it4), optStyle: it4.opts.style };
  const it5 = { type: "geojson", title: "g", url: `${b}/verify/tmp/sidecar.fgb`, opts: {} };
  out.otherType = await vl.probeQmlSidecar(it5);
  const it6 = { type: "flatgeobuf", title: "zst", url: `${b}/verify/tmp/sidecar.fgb.zst`, opts: {} };
  out.zstName = await vl.probeQmlSidecar(it6);
  return out;
}, base);
console.log(JSON.stringify(a, null, 1));

rec("A.attrs.preserved", a.attrs?.n === 3 && a.attrs.mc === "#e00" && a.attrs.ms === "large"
    && a.attrs.sym === "1" && a.attrs.title === "ポイント1"
    && a.attrs.lw === 3 && a.attrs.fo === 0.3,
  `FGB 往復後の simplestyle 属性 ${JSON.stringify(a.attrs)}`);
rec("A.resolved", a.pt?.color === "#e00" && a.pt?.size === 64 && a.pt?.symbol === "1"
    && a.ln?.color === "#00e" && a.ln?.width === 3 && a.ln?.opacity === 0.5
    && a.pg?.fill === "#0e0" && a.pg?.fillOpacity === 0.3 && a.pg?.strokeWidth === 2
    && a.sym?.kind === "text" && a.sym?.char === "1",
  `解決値 pt=${JSON.stringify(a.pt)} ln=${JSON.stringify(a.ln)} pg=${JSON.stringify(a.pg)} sym=${JSON.stringify(a.sym)}`);
rec("A.header.meta", a.meta?.title === "MetaTitle"
    && a.meta?.description === "MetaDescription-説明"
    && a.meta?.metadata?.includes("probe-fgb-style")
    && a.metaLoad?.summary?.title === "MetaTitle",
  `ヘッダ title/desc/meta: ${JSON.stringify({ t: a.meta?.title, d: a.meta?.description, m: a.meta?.metadata })} err=${a.meta?.error || "-"}`);
rec("A.sidecar.hit", a.sidecar?.ret === `${base}/verify/tmp/sidecar.qml`
    && a.sidecar?.styleUrl === a.sidecar?.ret && a.sidecar?.optStyle === a.sidecar?.ret,
  `サイドカー検出 → ${a.sidecar?.ret}`);
rec("A.sidecar.miss", a.nosidecar?.ret === null && !a.nosidecar?.styleUrl,
  "サイドカーなし → null・静黙");
rec("A.sidecar.explicit", a.explicitSkip?.ret === null && a.explicitSkip?.optStyle?.endsWith("explicit.qml"),
  "明示 style= は探査スキップ・維持");
rec("A.sidecar.otherType", a.otherType === null && a.zstName === null,
  `非fgb型=${a.otherType} .fgb.zst=${a.zstName}`);

// ============ Phase B: cesium ============
// fgb-style.kasc を PUT で生成
await page.evaluate(async (b) => {
  const kasc = [
    `flatgeobuf: 属性style | ${b}/verify/tmp/style-attrs.fgb | on | bbox=off`,
    `flatgeobuf: サイドカー | ${b}/verify/tmp/sidecar.fgb | on | bbox=off`,
    `flatgeobuf: 明示style | ${b}/verify/tmp/explicit.fgb | on | bbox=off | style=${b}/verify/tmp/explicit.qml`,
    `flatgeobuf: サイドカーなし | ${b}/verify/tmp/nosidecar.fgb | on | bbox=off`,
  ].join("\n");
  await fetch(`${b}/verify/tmp/fgb-style.kasc`, { method: "PUT", body: kasc });
}, base);

await page.goto(`${base}/cesium/?kasc=${encodeURIComponent(`${base}/verify/tmp/fgb-style.kasc`)}`,
  { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 90000 });
// ロード+サイドカー探査+QML 適用の完了待ち(4レイヤー・地物数合計>=6)
let c = null;
for (let i = 0; i < 40; i++) {
  c = await page.evaluate(() => {
    const layers = window.kasugaiApi.listLayers();
    const mats = [];
    for (let i = 0; i < window._viewer.dataSources.length; i++) {
      const ds = window._viewer.dataSources.get(i);
      for (const e of ds.entities.values) {
        const col = e.polygon?.material?.color?.getValue?.(window.Cesium?.JulianDate?.now?.());
        if (col) mats.push([Math.round(col.red * 255), Math.round(col.green * 255), Math.round(col.blue * 255)]);
      }
    }
    return { n: layers.length,
      feats: layers.reduce((s, l) => s + (window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? 0), 0),
      titles: layers.map(l => l.title), mats };
  });
  if (c?.n >= 4 && c?.feats >= 6) break;
  await page.waitForTimeout(1000);
}
console.log(JSON.stringify(c, null, 1));
rec("B.layers", c?.n >= 4 && c?.feats >= 6, `レイヤー ${c?.n} 地物 ${c?.feats}`);
rec("B.sidecar.apply", c?.mats?.some(m => m[0] === 255 && m[1] === 0 && m[2] === 255),
  `サイドカー QML(magenta) 適用 mats=${JSON.stringify(c?.mats)}`);
rec("B.explicit.apply", c?.mats?.some(m => m[0] === 0 && m[1] === 255 && m[2] === 255),
  "明示 style=(cyan) 適用");
await page.screenshot({ path: `${OUT}fgb-style-cesium.png` });

// ============ Phase C: leaflet ============
const ctxC = await browser.newContext();
const pageC = await ctxC.newPage();
await pageC.goto(`${base}/leaflet/?kasc=${encodeURIComponent(`${base}/verify/tmp/fgb-style.kasc`)}`,
  { waitUntil: "domcontentloaded" });
await pageC.waitForFunction(() => window.kascMap || window.leafletMap, { timeout: 120000 });
let d = null;
for (let i = 0; i < 40; i++) {
  d = await pageC.evaluate(() => {
    const layers = window.kasugaiApi.listLayers();
    const paths = [];
    const map = window.kascMap || window.leafletMap;
    map?.eachLayer?.(l => { if (l instanceof L.Path && l.options?.fillColor) paths.push(l.options.fillColor); });
    return { n: layers.length, paths,
      ssym: document.querySelectorAll(".kasc-ssym").length };
  }).catch(() => null);
  if (d?.n >= 4 && d?.paths.length >= 2) break;
  await pageC.waitForTimeout(1000);
}
console.log(JSON.stringify(d, null, 1));
rec("C.leaflet.layers", d?.n >= 4, `レイヤー ${d?.n}`);
rec("C.leaflet.ssym", d?.ssym >= 1, `marker-symbol divIcon ${d?.ssym}個`);
rec("C.leaflet.sidecar", d?.paths?.some(c => c === "#ff00ff" || /rgb\(\s*255\s*,\s*0\s*,\s*255\s*\)/.test(c)),
  `サイドカー QML fill 適用 paths=${JSON.stringify(d?.paths)}`);
await pageC.screenshot({ path: `${OUT}fgb-style-leaflet.png` });
await ctxC.close();

const ok = results.filter(r => r.ok).length;
console.log(`\n${ok}/${results.length} PASS`);
await browser.close();
srv.close();
process.exit(ok === results.length ? 0 : 1);
