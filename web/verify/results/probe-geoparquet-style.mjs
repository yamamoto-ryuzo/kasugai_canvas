// GeoParquet スタイル経路プローブ (engine-geoparquet-style スキル)
//  実行: node web/verify/results/probe-geoparquet-style.mjs
//  カバレッジ:
//   A) モジュール: simplestyle 属性の Parquet 透過・resolveDefault*Style 解決値・
//      probeQmlSidecar(.qml サイドカー自動検出) の geoparquet 分岐・geoHeader 露出
//   B) cesium: style= 明示適用・.qml サイドカー自動検出・simplestyle 地物
//   C) leaflet: .kasc-ssym(marker-symbol) DOM・サイドカー QML 適用色
//  テスト資産: web/verify/rec-formats/style-attrs.parquet(simplestyle 属性付・
//      GDAL 3.12 生成)・style-poly.parquet(ポリゴン単体)。サイドカー系は
//      プローブ内で PUT コピーして生成(.qml は実行時テキスト)
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
  ".parquet": "application/octet-stream", ".png": "image/png",
  ".svg": "image/svg+xml", ".txt": "text/plain" };

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
page.on("console", m => {
  if (!/warn|error/i.test(m.type())) return;
  const t = m.text();
  if (/Failed to load resource|favicon|ERR_INTERNET|WebGL|deprecat/i.test(t)) return;
  console.log(`CONSOLE[${m.type()}]:`, t.slice(0, 300));
});

// ============ Phase A: モジュール単位 ============
await page.goto(`${base}/verify/rec-formats/blank.html`, { waitUntil: "domcontentloaded" });
const a = await page.evaluate(async (b) => {
  const vl = await import("/shared/vector-load.js");
  const kasc = await import("/shared/kasc.js");
  const out = {};
  const put = async (name, body) =>
    (await fetch(`${b}/verify/tmp/${name}`, { method: "PUT", body })).status;

  // A1: simplestyle 属性の Parquet 透過(GDAL 生成済みフィクスチャ)
  const it1 = { type: "geoparquet", title: "attr", url: `${b}/verify/rec-formats/style-attrs.parquet`, opts: { bbox: "off" } };
  const r1 = await vl.loadVectorItem(it1, "");
  const byName = n => r1.geojson.features.find(f => f.properties.name === n)?.properties || {};
  const p0 = byName("pt1");
  out.attrs = { n: r1.geojson.features.length, mc: p0["marker-color"], ms: p0["marker-size"],
    sym: p0["marker-symbol"], title: p0.title, desc: p0.description,
    lw: byName("ln1")["stroke-width"], fo: byName("pg1")["fill-opacity"],
    header: !!it1.geoHeader && it1.geoHeader.primary_column === "geometry" };

  // A2: resolveDefault*Style + markerSymbolSpec の解決値
  out.pt = kasc.resolveDefaultPointStyle(p0, { color: "#123456", size: 10 });
  out.ln = kasc.resolveDefaultLineStyle(byName("ln1"), { color: "#123456", width: 1 });
  out.pg = kasc.resolveDefaultPolygonStyle(byName("pg1"), { fill: "#123456" }, { color: "#123456" });
  out.sym = kasc.markerSymbolSpec(p0["marker-symbol"]);

  // A3: probeQmlSidecar の geoparquet 分岐
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
  const polyBytes = await (await fetch(`${b}/verify/rec-formats/style-poly.parquet`)).arrayBuffer();
  await put("gp-sidecar.qml", QML);
  await put("gp-explicit.qml", QML2);
  await put("gp-sidecar.parquet", polyBytes);
  await put("gp-sidecar.geoparquet", polyBytes);
  await put("gp-explicit.parquet", polyBytes);
  await put("gp-nosidecar.parquet", polyBytes);
  const it2 = { type: "geoparquet", title: "sc", url: `${b}/verify/tmp/gp-sidecar.parquet`, opts: {} };
  out.sidecar = { ret: await vl.probeQmlSidecar(it2), styleUrl: it2.styleUrl, optStyle: it2.opts.style };
  const it3 = { type: "geoparquet", title: "no", url: `${b}/verify/tmp/gp-nosidecar.parquet`, opts: {} };
  out.nosidecar = { ret: await vl.probeQmlSidecar(it3), styleUrl: it3.styleUrl };
  const it4 = { type: "geoparquet", title: "ex", url: `${b}/verify/tmp/gp-sidecar.parquet`,
    opts: { style: `${b}/verify/tmp/gp-explicit.qml` } };
  out.explicitSkip = { ret: await vl.probeQmlSidecar(it4), optStyle: it4.opts.style };
  const it5 = { type: "geojson", title: "g", url: `${b}/verify/tmp/gp-sidecar.parquet`, opts: {} };
  out.otherType = await vl.probeQmlSidecar(it5);
  const it6 = { type: "parquet", title: "pq", url: `${b}/verify/tmp/gp-sidecar.parquet`, opts: {} };
  out.pqAlias = { ret: await vl.probeQmlSidecar(it6), styleUrl: it6.styleUrl };
  const it7 = { type: "geoparquet", title: "gp", url: `${b}/verify/tmp/gp-sidecar.geoparquet`, opts: {} };
  out.gpExt = await vl.probeQmlSidecar(it7);
  return out;
}, base);
console.log(JSON.stringify(a, null, 1));

rec("A.attrs.preserved", a.attrs?.n === 3 && a.attrs.mc === "#e00" && a.attrs.ms === "large"
    && a.attrs.sym === "1" && a.attrs.title === "ポイント1"
    && a.attrs.lw === 3 && a.attrs.fo === 0.3,
  `Parquet 往復後の simplestyle 属性 ${JSON.stringify(a.attrs)}`);
rec("A.attrs.header", a.attrs?.header === true,
  `geoHeader 露出 primary_column=${a.attrs?.header}`);
rec("A.resolved", a.pt?.color === "#e00" && a.pt?.size === 64 && a.pt?.symbol === "1"
    && a.ln?.color === "#00e" && a.ln?.width === 3 && a.ln?.opacity === 0.5
    && a.pg?.fill === "#0e0" && a.pg?.fillOpacity === 0.3 && a.pg?.strokeWidth === 2
    && a.sym?.kind === "text" && a.sym?.char === "1",
  `解決値 pt=${JSON.stringify(a.pt)} ln=${JSON.stringify(a.ln)} pg=${JSON.stringify(a.pg)} sym=${JSON.stringify(a.sym)}`);
rec("A.sidecar.hit", a.sidecar?.ret === `${base}/verify/tmp/gp-sidecar.qml`
    && a.sidecar?.styleUrl === a.sidecar?.ret && a.sidecar?.optStyle === a.sidecar?.ret,
  `サイドカー検出 → ${a.sidecar?.ret}`);
rec("A.sidecar.miss", a.nosidecar?.ret === null && !a.nosidecar?.styleUrl,
  "サイドカーなし → null・静黙");
rec("A.sidecar.explicit", a.explicitSkip?.ret === null && a.explicitSkip?.optStyle?.endsWith("gp-explicit.qml"),
  "明示 style= は探査スキップ・維持");
rec("A.sidecar.others", a.otherType === null && a.gpExt === `${base}/verify/tmp/gp-sidecar.qml`
    && a.pqAlias?.ret === `${base}/verify/tmp/gp-sidecar.qml`,
  `非対象型=${a.otherType} .geoparquet拡張子=${a.gpExt} parquet:型=${a.pqAlias?.ret}`);

// ============ Phase B: cesium ============
await page.evaluate(async (b) => {
  const poly = await (await fetch(`${b}/verify/rec-formats/style-poly.parquet`)).arrayBuffer();
  const put = (n, body) => fetch(`${b}/verify/tmp/${n}`, { method: "PUT", body });
  const kasc = [
    `geoparquet: 属性style | ${b}/verify/rec-formats/style-attrs.parquet | on | bbox=off`,
    `geoparquet: サイドカー | ${b}/verify/tmp/gp-sidecar.parquet | on | bbox=off`,
    `geoparquet: 明示style | ${b}/verify/tmp/gp-explicit.parquet | on | bbox=off | style=${b}/verify/tmp/gp-explicit.qml`,
    `geoparquet: サイドカーなし | ${b}/verify/tmp/gp-nosidecar.parquet | on | bbox=off`,
  ].join("\n");
  await put("gp-style.kasc", kasc);
}, base);

for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await page.goto(`${base}/cesium/?kasc=${encodeURIComponent(`${base}/verify/tmp/gp-style.kasc`)}`,
      { waitUntil: "domcontentloaded" });
  } catch (e) { if (!/ERR_ABORTED/.test(String(e))) throw e; }
  try {
    await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 60000 });
    break;
  } catch (e) { if (attempt === 2) throw e; }
}
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
await page.screenshot({ path: `${OUT}geoparquet-style-cesium.png` });

// ============ Phase C: leaflet ============
const ctxC = await browser.newContext();
const pageC = await ctxC.newPage();
await pageC.goto(`${base}/leaflet/?kasc=${encodeURIComponent(`${base}/verify/tmp/gp-style.kasc`)}`,
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
await pageC.screenshot({ path: `${OUT}geoparquet-style-leaflet.png` });
await ctxC.close();

const ok = results.filter(r => r.ok).length;
console.log(`\n${ok}/${results.length} PASS`);
await browser.close();
srv.close();
process.exit(ok === results.length ? 0 : 1);
