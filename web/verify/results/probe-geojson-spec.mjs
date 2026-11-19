// GeoJSON 仕様適合プローブ (RFC 7946 + errata / RFC 8142 / JSON-FG 前段)
// skill: engine-geojson — 仕様項目の実測台帳。形式関連コード変更の度に実行する
//  実行: node web/verify/results/probe-geojson-spec.mjs
//  カバレッジ:
//   A) loadVectorItem デコード層の RFC 適合 (単体Feature/裸Geometry/GC/3D/
//      外部メンバー/null地物/日付線/geojsonl/RSシーケンス)
//   B) cesium 実機描画 (spec kasc の各レイヤー地物数)
//   C) 他エンジンの GeometryCollection 受理スモーク
//  GAP = 仕様上正当だが未実装の項目(失敗ではなく実装候補として記録)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL("./", import.meta.url));
mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".geojsonl": "application/x-ndjson", ".fgseq": "application/geo+json-seq",
  ".kasc": "text/plain", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : data.length - 1;
        res.writeHead(206, { "content-type": MIME[extname(q)] || "application/octet-stream",
          "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${data.length}` });
        res.end(data.subarray(start, end + 1));
        return;
      }
    }
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream",
      "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, gap: false });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const gap = (id, supported, detail) => { results.push({ id, ok: true, gap: !supported });
  console.log(`${supported ? "PASS" : "GAP "} ${id} :: ${detail}`); };

let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
const ctx = browser;
const page = await ctx.newPage();
page.on("pageerror", e => console.log("PAGEERR:", String(e).slice(0, 200)));

// ============ Phase A: loadVectorItem デコード層の仕様適合 ============
await page.goto(`${base}/cesium/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
const a = await page.evaluate(async (b) => {
  const vl = await import("../shared/vector-load.js");
  const D = `${b}/verify/geojson-spec`;
  const warnLog = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnLog.push(args.join(" ")); origWarn(...args); };
  const load = async (type, file, opts = {}) => {
    try {
      const r = await vl.loadVectorItem({ type, title: file, url: `${D}/${file}`, opts }, "", null);
      const gj = r.geojson;
      const feats = Array.isArray(gj?.features) ? gj.features : null;
      return {
        ok: true, isFC: gj?.type === "FeatureCollection",
        n: feats ? feats.length : null,
        rawType: gj?.type,
        geoms: feats ? [...new Set(feats.map(f => f?.geometry?.type || (f?.geometry === null ? "null" : "?")))].join("/") : null,
        z: feats?.some(f => JSON.stringify(f?.geometry?.coordinates ?? "").includes("123.4") || (f?.geometry?.coordinates?.[2] != null)),
        topName: gj?.name, crs: gj?.crs?.properties?.name,
        f0id: feats?.[0]?.id, f0custom: feats?.[0]?.custom_member, f0props: feats?.[0]?.properties,
        f0nullgeom: feats ? feats[0]?.geometry === null : null,
        // JSON-FG: place→geometry 昇格の確認用
        f0geom: feats?.[0]?.geometry?.type || (feats?.[0]?.geometry === null ? "null" : null),
        f0time: feats?.[0]?.time ?? null,
        f1geom: feats?.[1]?.geometry?.type || (feats?.[1]?.geometry === null ? "null" : null),
        f1time: feats?.[1]?.time ?? null,
        f1z: feats?.[1]?.geometry?.coordinates?.[2] ?? null,
        conformsTo: gj?.conformsTo, coordRefSys: gj?.coordRefSys,
        f0xy: feats?.[0]?.geometry?.coordinates, f1props: feats?.[1]?.properties,
        f2time: feats?.[2]?.properties?.time ?? null,
        featureType: gj?.featureType, warns: warnLog.splice(0),
      };
    } catch (e) { return { ok: false, error: String(e).slice(0, 160), warns: warnLog.splice(0) }; }
  };
  return {
    feature: await load("geojson", "feature.geojson"),
    geometry: await load("geojson", "geometry.geojson"),
    gc: await load("geojson", "geomcollection.geojson"),
    threeD: await load("geojson", "three-d.geojson"),
    foreign: await load("geojson", "foreign.geojson"),
    nullGeom: await load("geojson", "null-geom.geojson"),
    dateline: await load("geojson", "dateline.geojson"),
    geojsonl: await load("geojsonl", "seq-geojsonl.geojsonl"),
    seq: await load("geojsonseq", "seq.fgseq"),
    fgseq: await load("fgseq", "seq.fgseq"),
    seqAsGeojson: await load("geojson", "seq.fgseq"),
    seqAsGeojsonl: await load("geojsonl", "seq.fgseq"),
    // OGC JSON-FG (21-045r1): place/coordRefSys/time/立体型
    jsonfg: await load("geojson", "jsonfg.geojson"),
    jsonfgExt: await load("geojson", "jsonfg-copy.jsonfg"),
    jsonfg3857: await load("geojson", "jsonfg-3857.geojson"),
    jsonfgSolid: await load("geojson", "jsonfg-solid.geojson"),
  };
}, base);
console.log("A:", JSON.stringify(a, null, 1));

// RFC §3: 単体 Feature / 裸 Geometry も正当な GeoJSON テキスト → FC 正規化され1地物になるべき
gap("A.feature", a.feature?.ok && a.feature.n === 1,
  `単体Feature → n=${a.feature?.n} rawType=${a.feature?.rawType} ${a.feature?.error || ""}`);
gap("A.geometry", a.geometry?.ok && a.geometry.n === 1,
  `裸Geometry → n=${a.geometry?.n} rawType=${a.geometry?.rawType} ${a.geometry?.error || ""}`);
// FC 系は正しく通るべき
rec("A.gc", a.gc?.n === 1 && /GeometryCollection/.test(a.gc?.geoms || ""),
  `GeometryCollection 地物 n=${a.gc?.n} geoms=${a.gc?.geoms}`);
rec("A.3d", a.threeD?.n === 2 && a.threeD?.z === true,
  `3D座標 n=${a.threeD?.n} z検出=${a.threeD?.z}`);
rec("A.foreign.n", a.foreign?.n === 2, `外部メンバー FC n=${a.foreign?.n}`);
rec("A.foreign.keep", a.foreign?.topName === "foreign-members" && a.foreign?.f0custom === "keepme"
  && a.foreign?.f0id === 42,
  `topName=${a.foreign?.topName} f0id=${a.foreign?.f0id} custom=${a.foreign?.f0custom} props=${JSON.stringify(a.foreign?.f0props)}`);
rec("A.foreign.crs", a.foreign?.crs === "urn:ogc:def:crs:OGC:1.3:CRS84",
  `GJ2008式 crs メンバー透過: ${a.foreign?.crs}`);
// null geometry は仕様上有効 → 保持されるべき(属性参照可能)
gap("A.nullgeom", a.nullGeom?.n === 2 && a.nullGeom?.f0nullgeom === true,
  `geometry:null 地物の保持 n=${a.nullGeom?.n} f0null=${a.nullGeom?.f0nullgeom}`);
rec("A.dateline", a.dateline?.n === 2, `日付変更線跨ぎ n=${a.dateline?.n} geoms=${a.dateline?.geoms}`);
rec("A.geojsonl", a.geojsonl?.n === 2, `geojsonl n=${a.geojsonl?.n}`);
// RFC 8142: RS 区切りシーケンス(geojsonseq:/fgseq: 行タイプ)
gap("A.geojsonseq", a.seq?.ok && a.seq.n === 2 && a.fgseq?.n === 2,
  `application/geo+json-seq → geojsonseq=${a.seq?.error || a.seq?.n} fgseq=${a.fgseq?.error || a.fgseq?.n}`);

// OGC JSON-FG (21-045r1)
rec("A.jsonfg.n", a.jsonfg?.n === 3, `JSON-FG FC n=${a.jsonfg?.n} ${a.jsonfg?.error || ""}`);
rec("A.jsonfg.place", a.jsonfg?.f0geom === "Point" && a.jsonfg?.f1geom === "Point" && a.jsonfg?.f1z === 0,
  `place→geometry 昇格 f0=${a.jsonfg?.f0geom} / geometry フォールバック優先 f1=${a.jsonfg?.f1geom}(z=${a.jsonfg?.f1z})`);
rec("A.jsonfg.time", a.jsonfg?.f0time?.date === "1969-07-16" && Array.isArray(a.jsonfg?.f1time?.interval),
  `time メンバー透過 f0=${JSON.stringify(a.jsonfg?.f0time)} f1=${JSON.stringify(a.jsonfg?.f1time)}`);
rec("A.jsonfg.meta", (a.jsonfg?.conformsTo || []).some(c => /json-fg/.test(c)) && a.jsonfg?.featureType === "building"
  && String(a.jsonfg?.coordRefSys).includes("CRS84"),
  `conformsTo/featureType/coordRefSys 保持 coordRefSys=${a.jsonfg?.coordRefSys}`);
rec("A.jsonfg.crs84nocomplain", !(a.jsonfg?.warns || []).length,
  `CRS84h は警告なし warns=${JSON.stringify(a.jsonfg?.warns)}`);
rec("A.jsonfg.ext", a.jsonfgExt?.ok && a.jsonfgExt.n === 3 && a.jsonfgExt.f0geom === "Point",
  `.jsonfg 拡張子 → geojson として受理 n=${a.jsonfgExt?.n} ${a.jsonfgExt?.error || ""}`);
// EPSG:3857 の place は WGS84 へ再投影される(再投影失敗時のみ警告)
rec("A.jsonfg.3857reproj", a.jsonfg3857?.n === 1 && a.jsonfg3857?.f0geom === "Point"
  && Array.isArray(a.jsonfg3857?.f0xy)
  && a.jsonfg3857.f0xy[0] > 138 && a.jsonfg3857.f0xy[0] < 142
  && a.jsonfg3857.f0xy[1] > 34 && a.jsonfg3857.f0xy[1] < 38
  && !(a.jsonfg3857?.warns || []).some(w => /coordRefSys/.test(w)),
  `EPSG:3857 → WGS84 再投影 xy=${JSON.stringify(a.jsonfg3857?.f0xy)} warns=${JSON.stringify(a.jsonfg3857?.warns)}`);
// Prism は base をフットプリント昇格+__kasc_z/__kasc_extrude 保持。
// Polyhedron は footprint fallback 優先。未対応警告は残らない(両方処理できた)
rec("A.jsonfg.solid", a.jsonfgSolid?.n === 2 && a.jsonfgSolid?.f0geom === "Polygon"
  && a.jsonfgSolid?.f1geom === "Polygon"
  && Number(a.jsonfgSolid?.f1props?.__kasc_extrude) === 15
  && !(a.jsonfgSolid?.warns || []).some(w => /未対応/.test(w)),
  `Prism: base 昇格+押出し f0=${a.jsonfgSolid?.f0geom} f1=${a.jsonfgSolid?.f1geom} extrude=${a.jsonfgSolid?.f1props?.__kasc_extrude} warns=${JSON.stringify(a.jsonfgSolid?.warns)}`);
// JSON-FG time → properties.time 昇格(date/timestamp/interval が属性表・
// time= フィルタで扱えるようになる。f0=date → "1969-07-16")
rec("A.jsonfg.timeprop", a.jsonfg?.f0props?.time === "1969-07-16"
  && a.jsonfg?.f2time === "2026-05-21T09:00:00Z",
  `time → properties.time 昇格 f0=${JSON.stringify(a.jsonfg?.f0props?.time)} f2=${JSON.stringify(a.jsonfg?.f2time)}`);

// ============ Phase B: cesium 実機描画 ============
const KASC = encodeURIComponent(`${base}/verify/geojson-spec/geojson-spec.kasc`);
await page.goto(`${base}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 90000 });
await page.waitForTimeout(8000);
const counts = await page.evaluate(() => {
  const NAMES = ["単体Feature", "裸Geometry", "GeometryCollection", "3D座標", "外部メンバー", "null地物", "日付線", "geojsonl", "geojsonseq", "JSON-FG", "JSON-FG-3857", "JSON-FG-solid"];
  const out = {};
  for (const l of window.kasugaiApi.listLayers()) {
    const short = (l.title || "").split("/").pop();
    if (!NAMES.includes(short)) continue;
    out[short] = window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? -1;
  }
  return out;
});
console.log("B counts:", JSON.stringify(counts));
gap("B.feature", counts["単体Feature"] >= 1, `cesium 単体Feature 地物数=${counts["単体Feature"]}`);
gap("B.geometry", counts["裸Geometry"] >= 1, `cesium 裸Geometry 地物数=${counts["裸Geometry"]}`);
rec("B.gc", counts["GeometryCollection"] === 1, `cesium GC 地物数=${counts["GeometryCollection"]}`);
rec("B.3d", counts["3D座標"] === 2, `cesium 3D 地物数=${counts["3D座標"]}`);
rec("B.foreign", counts["外部メンバー"] === 2, `cesium 外部メンバー 地物数=${counts["外部メンバー"]}`);
rec("B.dateline", counts["日付線"] === 2, `cesium 日付線 地物数=${counts["日付線"]}`);
rec("B.nullgeom", counts["null地物"] === 2, `cesium null地物 地物数=${counts["null地物"]}(null地物保持)`);
rec("B.geojsonl", counts["geojsonl"] === 2, `cesium geojsonl 地物数=${counts["geojsonl"]}`);
rec("B.geojsonseq", counts["geojsonseq"] === 2, `cesium geojsonseq 地物数=${counts["geojsonseq"]}`);
rec("B.jsonfg", counts["JSON-FG"] === 3, `cesium JSON-FG 地物数=${counts["JSON-FG"]}(place昇格含む)`);
rec("B.jsonfg3857", counts["JSON-FG-3857"] === 1, `cesium JSON-FG-3857 地物数=${counts["JSON-FG-3857"]}(警告付き描画)`);
rec("B.jsonfgSolid", counts["JSON-FG-solid"] === 2, `cesium JSON-FG-solid 地物数=${counts["JSON-FG-solid"]}(solid fallback優先)`);
await page.screenshot({ path: `${OUT}geojson-spec-cesium.png` });

// ============ Phase C: 他エンジン GeometryCollection 受理 ============
async function gcSmoke(engine, ready) {
  try {
    await page.goto(`${base}/${engine}/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(ready, { timeout: 120000 });
    await page.waitForTimeout(8000);
    const r = await page.evaluate(() => {
      const l = window.kasugaiApi?.listLayers?.().find(x => (x.title || "").includes("GeometryCollection"));
      if (!l) return { layer: false };
      return { layer: true, n: window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? -1, failed: !!l.failed };
    });
    rec(`C.${engine}.gc`, r.layer && r.n === 1 && !r.failed, `${engine} GC層: ${JSON.stringify(r)}`);
    return r;
  } catch (e) {
    rec(`C.${engine}.gc`, false, `${engine} FAILED ${String(e).slice(0, 150)}`);
    return null;
  }
}
await gcSmoke("maplibre", () => window.kascMap?.loaded?.() && window.kasugaiApi);
await gcSmoke("openlayers", () => window.kascMap || window.kascOl);
await gcSmoke("leaflet", () => window.kascMap || window.leafletMap);
await gcSmoke("navara", () => window.kascView && window.kasugaiApi?.listLayers);

srv.close();
await ctx.close();
const fails = results.filter(r => !r.ok).length;
const gaps = results.filter(r => r.gap).length;
console.log(`\n${results.length - fails - gaps}/${results.length - gaps} PASS (適合項目) / GAP ${gaps} 件 (未実装仕様)`);
process.exit(fails ? 1 : 0);
