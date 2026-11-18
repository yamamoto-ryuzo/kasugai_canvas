// 推奨ベクター形式 (geojson: / flatgeobuf: / geoparquet:) の回帰検証プローブ
// 機能追加・形式関連コード変更の度に実行する(skill: vector-formats)
//  実行: node web/verify/results/probe-rec-formats.mjs
//  カバレッジ:
//   A) shared/kasc.js パース + shared/vector-load.js デコード(形式別・範囲読み)
//   B) cesium: レイヤー登録/地物数/fgb Range 読み・再クエリ/where=/非表示lazy
//   C) maplibre/openlayers/leaflet/navara/gsimaps: 同一 .kasc のスモーク描画
//  テスト資産: web/verify/rec-formats/(points.geojson・example.parquet・rec-formats.kasc)
//             + web/verify/fgb-test/countries.fgb
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
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".fgb": "application/octet-stream", ".parquet": "application/octet-stream",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };

const reqLog = [];
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    const mime = MIME[extname(q)] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : data.length - 1;
        reqLog.push({ path: q, range: `${start}-${end}` });
        res.writeHead(206, {
          "content-type": mime, "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${data.length}`,
        });
        res.end(data.subarray(start, end + 1));
        return;
      }
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
const ctx = browser;
const page = await ctx.newPage();
page.on("pageerror", e => console.log("PAGEERR:", String(e).slice(0, 200)));

// ============ Phase A: kasc パース + vector-load デコード(エンジン非依存) ============
await page.goto(`${base}/cesium/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
const a = await page.evaluate(async (b) => {
  const vl = await import("../shared/vector-load.js");
  const kasc = await import("../shared/kasc.js");
  const out = {};
  const text = await (await fetch(`${b}/verify/rec-formats/rec-formats.kasc`)).text();
  const doc = kasc.parseKasc(text);
  out.parse = doc.layers.map(l => `${l.type}${l.opts?.bbox ? "[bbox=" + l.opts.bbox + "]" : ""}${l.visible === false ? "(off)" : ""}${l.opts?.where ? "[where]" : ""}`);
  const JP = { ranges: [{ west: 120, east: 150 }], south: 20, north: 50 };
  const items = [
    ["geojson", { type: "geojson", title: "g", url: `${b}/verify/rec-formats/points.geojson` }, null],
    ["fgb-all", { type: "flatgeobuf", title: "f", url: `${b}/verify/fgb-test/countries.fgb`, opts: { bbox: "off" } }, null],
    ["fgb-rect", { type: "flatgeobuf", title: "f", url: `${b}/verify/fgb-test/countries.fgb`, opts: {} }, JP],
    ["geoparquet", { type: "geoparquet", title: "p", url: `${b}/verify/rec-formats/example.parquet` }, null],
  ];
  out.load = {};
  for (const [key, it, bounds] of items) {
    try {
      const r = await vl.loadVectorItem(it, "", bounds);
      const feats = r.geojson.features;
      out.load[key] = {
        n: feats.length,
        geoms: [...new Set(feats.map(f => f.geometry?.type).filter(Boolean))].join("/"),
        props: Object.keys(feats[0]?.properties || {}).slice(0, 6).join(","),
        viewportQuery: r.viewportQuery,
      };
    } catch (e) { out.load[key] = { error: String(e).slice(0, 160) }; }
  }
  return out;
}, base);
console.log("parse:", JSON.stringify(a.parse));
console.log("load:", JSON.stringify(a.load, null, 1));
rec("A.parse.types", a.parse.length === 7 && a.parse[0] === "geojson" && a.parse[3] === "flatgeobuf" && a.parse[5] === "geoparquet",
  `7行パース ${a.parse.join(" / ")}`);
rec("A.geojson", a.load.geojson?.n === 6, `geojson 6地物(n=${a.load.geojson?.n}) geoms=${a.load.geojson?.geoms}`);
rec("A.fgb.all", a.load["fgb-all"]?.n > 0 && a.load["fgb-all"]?.viewportQuery === false,
  `fgb 全件 ${a.load["fgb-all"]?.n}地物 viewportQuery=${a.load["fgb-all"]?.viewportQuery}`);
rec("A.fgb.rect", a.load["fgb-rect"]?.n > 0 && a.load["fgb-rect"]?.n < a.load["fgb-all"]?.n && a.load["fgb-rect"]?.viewportQuery === true,
  `fgb 範囲読み ${a.load["fgb-rect"]?.n}地物 < 全件 ${a.load["fgb-all"]?.n} viewportQuery=${a.load["fgb-rect"]?.viewportQuery}`);
rec("A.geoparquet", a.load.geoparquet?.n > 0 && /name/.test(a.load.geoparquet?.props || ""),
  `geoparquet ${a.load.geoparquet?.n}地物 props=${a.load.geoparquet?.props} geoms=${a.load.geoparquet?.geoms}`);

// ============ Phase B: cesium エンジン実機検証 ============
const phaseBStart = reqLog.length;
const KASC = encodeURIComponent(`${base}/verify/rec-formats/rec-formats.kasc`);
await page.goto(`${base}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 90000 });

async function layerBy(part) {
  return page.evaluate(t =>
    window.kasugaiApi.listLayers().find(l => (l.title || "").includes(t)), part);
}
async function waitFeatures(part, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const n = await page.evaluate(t => {
      const l = window.kasugaiApi?.listLayers?.().find(x => (x.title || "").includes(t));
      if (!l) return -1;
      return window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? 0;
    }, part);
    if (n > 0) return n;
    await new Promise(r => setTimeout(r, 500));
  }
  return 0;
}
// DataSource ごとの地物属性分布(where= は描画のみ絞り込み → entity の
// プロパティ分布で「絞り込み済み ds の存在」を検証する)
async function dsPropStats(prop) {
  return page.evaluate(p => {
    const t = Cesium.JulianDate.now();
    const ds = window._viewer.dataSources, out = [];
    for (let i = 0; i < ds.length; i++) {
      const ents = ds.get(i).entities.values;
      if (!ents.length) continue;
      const vals = ents.map(e => e.properties?.getValue?.(t)?.[p]);
      out.push({ n: ents.length, vals: [...new Set(vals.map(v => String(v)))] });
    }
    return out;
  }, prop);
}

const nGeo = await waitFeatures("geojson基準");
const nFgbAuto = await waitFeatures("fgb(bbox=auto)");
const nFgbOff = await waitFeatures("fgb(bbox=off)");
const nPq = await waitFeatures("geoparquet");
const layers = await page.evaluate(() => window.kasugaiApi.listLayers());
const autoL = layers.find(l => (l.title || "").includes("fgb(bbox=auto)"));
const offL = layers.find(l => (l.title || "").includes("fgb(bbox=off)"));
const hiddenL = layers.find(l => (l.title || "").includes("geojson非表示"));

const needTitles = ["geojson基準", "geojson非表示", "geojson where",
  "fgb(bbox=auto)", "fgb(bbox=off)", "geoparquet where"];
const hasBase = layers.some(l => /(^|\/)geoparquet$/.test(l.title || ""));
const missing = needTitles.filter(p => !layers.some(l => (l.title || "").includes(p)));
rec("B.layers", missing.length === 0 && hasBase,
  `レイヤー登録 ${missing.length ? "欠落: " + missing.join(",") : "7/7"}${hasBase ? "" : "(base geoparquet 無し)"}`);
rec("B.geojson", nGeo === 6, `geojson基準 ${nGeo}地物`);
rec("B.fgb.parse", !!autoL && autoL.bboxAuto === true && !!offL && offL.bboxAuto === false,
  `bboxAuto: auto=${autoL?.bboxAuto} off=${offL?.bboxAuto}`);
rec("B.fgb.range", reqLog.slice(phaseBStart).filter(r => r.path.includes("countries.fgb") && r.range).length > 0,
  `countries.fgb Range リクエスト ${reqLog.slice(phaseBStart).filter(r => r.path.includes("countries.fgb") && r.range).length}件`);
rec("B.fgb.full", reqLog.slice(phaseBStart).some(r => r.path.includes("countries.fgb") && !r.range),
  `countries.fgb 全件取得(bbox=off 分) あり`);
rec("B.fgb.load", nFgbAuto > 0 && nFgbOff > 0, `fgb auto=${nFgbAuto} off=${nFgbOff} 地物`);
rec("B.geoparquet", nPq > 0, `geoparquet ${nPq}地物`);

// where= は描画のみ絞り込み(ソースは全件保持)→ 絞り込み済み ds の存在で検証
const geoStats = await dsPropStats("category");
rec("B.where.geojson",
  geoStats.some(s => s.n === 2 && s.vals.length === 1 && s.vals[0] === "landmark")
    && geoStats.some(s => s.n === 6 && s.vals.length > 1),
  `geojson where → landmarkのみ2entity の ds あり + 全6の基準 ds あり: ${JSON.stringify(geoStats)}`);
const pqStats = await dsPropStats("continent");
rec("B.where.parquet",
  pqStats.some(s => s.vals.length === 1 && s.vals[0] === "Africa")
    && pqStats.some(s => s.vals.length > 1 && s.vals.includes("Africa")),
  `geoparquet where → Africaのみの subset ds + 大陸混在の全件 ds: ${JSON.stringify(pqStats)}`);

// 非表示レイヤーの遅延ロード → 表示ON で取得
const hidBefore = await page.evaluate(t => {
  const l = window.kasugaiApi.listLayers().find(x => (x.title || "").includes(t));
  return window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? 0;
}, "geojson非表示");
await page.evaluate(id => window.kasugaiApi.setLayerVisible(id, true), hiddenL?.id);
await new Promise(r => setTimeout(r, 3000));
const hidGeo = await page.evaluate(t => {
  const l = window.kasugaiApi.listLayers().find(x => (x.title || "").includes(t));
  return window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? 0;
}, "geojson非表示");
rec("B.lazy", hidGeo === 6, `非表示→表示ON で遅延ロード(取得前 ${hidBefore} → ${hidGeo}地物)`);

// fgb bbox=auto: 狭い範囲へ flyTo → Range 再クエリで地物が絞られる
const before = reqLog.length;
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 36, longitude: 138, height: 800000, pitch: -90 }, 0));
await new Promise(r => setTimeout(r, 4000));
const zoomN = await page.evaluate(() => {
  const l = window.kasugaiApi.listLayers().find(x => (x.title || "").includes("fgb(bbox=auto)"));
  return window.kasugaiApi.getLayerGeoJson(l.id)?.features?.length ?? 0;
});
const reReqs = reqLog.slice(before).filter(r => r.path.includes("countries.fgb") && r.range);
rec("B.fgb.requery", reReqs.length > 0, `カメラ移動で Range 再クエリ ${reReqs.length}件`);
rec("B.fgb.subset", zoomN > 0 && zoomN < nFgbAuto, `狭範囲 ${zoomN}地物(広域 ${nFgbAuto})`);
await page.screenshot({ path: `${OUT}rec-formats-cesium.png` });

// ============ Phase C: 他エンジン スモーク ============
async function smoke(engine, ready, count) {
  try {
    await page.goto(`${base}/${engine}/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(ready, { timeout: 120000 });
    await page.waitForTimeout(10000);
    const r = await page.evaluate(count);
    rec(`C.${engine}`, r > 0, `${engine}: ${r}`);
    await page.screenshot({ path: `${OUT}rec-formats-${engine}.png` });
    return r;
  } catch (e) {
    rec(`C.${engine}`, false, `${engine} FAILED ${String(e).slice(0, 150)}`);
    return -1;
  }
}
await smoke("maplibre",
  () => window.kascMap?.loaded?.() && window.kasugaiApi,
  () => window.kascMap.getStyle().layers.filter(l => !/^(background|raster)$/.test(l.type)).length);
await smoke("openlayers",
  () => window.kascMap || window.kascOl,
  () => (window.kascMap || window.kascOl).getLayers().getArray()
    .filter(l => l.getSource && l.getSource().getFeatures && l.getSource().getFeatures().length > 0).length);
await smoke("leaflet",
  () => window.kascMap || window.leafletMap,
  () => { let n = 0; (window.kascMap || window.leafletMap).eachLayer(l => { if (l.feature || l.getGeoJSON) n++; }); return n; });
await smoke("navara",
  () => window.kascView && window.kasugaiApi?.listLayers,
  () => window.kasugaiApi.listLayers().filter(l => !l.failed).length);
await smoke("gsimaps",
  () => document.getElementById("gsi-frame")?.contentWindow?.GSI?.GLOBALS,
  () => window.kasugaiApi.listLayers().length);

srv.close();
await ctx.close();
const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
