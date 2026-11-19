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
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m && (m[1] || m[2])) {
        // bytes=-N(接尾辞) も受ける(seekable-zstd が使用)
        const start = m[1] === "" ? Math.max(data.length - Number(m[2]), 0) : Number(m[1]);
        const end = m[1] === "" || !m[2] ? data.length - 1 : Number(m[2]);
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
// 再読み込み失敗・範囲読みフォールバック等の warn を検証の手がかりにする
page.on("console", m => {
  if (!/warn|error/i.test(m.type())) return;
  const t = m.text();
  if (/Failed to load resource|favicon|ERR_INTERNET|WebGL|deprecat/i.test(t)) return;
  console.log(`CONSOLE[${m.type()}]:`, t.slice(0, 300));
});

// ============ Phase A: kasc パース + vector-load デコード(エンジン非依存) ============
// cesium 初期ロード直後にアプリ側の遷移(既定プロジェクト・セッション復元)で
// evaluate の実行コンテキストが壊れることがあるため、ナビゲーション完了を
// 待ってから評価し、壊れたらリトライする
let a = null;
for (let attempt = 0; attempt < 3 && !a; attempt++) {
  // アプリ側のリダイレクト(既定プロジェクト復元)で goto 自体が中断される場合は
  // 遷移完了待ちとして無視する
  await page.goto(`${base}/cesium/`, { waitUntil: "domcontentloaded" })
    .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
  await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
  if (attempt > 0) await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  try {
    a = await page.evaluate(async (b) => {
  const vl = await import("../shared/vector-load.js");
  const kasc = await import("../shared/kasc.js");
  const out = {};
  const text = await (await fetch(`${b}/verify/rec-formats/rec-formats.kasc`)).text();
  const doc = kasc.parseKasc(text);
  out.parse = doc.layers.map(l => `${l.type}${l.opts?.bbox ? "[bbox=" + l.opts.bbox + "]" : ""}${l.visible === false ? "(off)" : ""}${l.opts?.where ? "[where]" : ""}`);
  const JP = { ranges: [{ west: 120, east: 150 }], south: 20, north: 50 };
  const GP = { ranges: [{ west: 120, east: 140 }], south: 30, north: 40 };
  const items = [
    ["geojson", { type: "geojson", title: "g", url: `${b}/verify/rec-formats/points.geojson` }, null],
    ["fgb-all", { type: "flatgeobuf", title: "f", url: `${b}/verify/fgb-test/countries.fgb`, opts: { bbox: "off" } }, null],
    ["fgb-rect", { type: "flatgeobuf", title: "f", url: `${b}/verify/fgb-test/countries.fgb`, opts: {} }, JP],
    ["geoparquet", { type: "geoparquet", title: "p", url: `${b}/verify/rec-formats/example.parquet` }, null],
    // covering.bbox 列付き(GDAL 出力・GeoParquet 1.1.0)。geometry_bbox struct が
    // 属性へ混入しないことと covering メタの露出を検証する
    ["geoparquet-cov", { type: "geoparquet", title: "pc", url: `${b}/verify/rec-formats/covering.parquet` }, null],
    // 範囲読み検証(3000行・15行グループ・世界分布):
    //  grid.parquet      = covering.bbox 付き → covering filter で部分読み
    //  grid-nocov.parquet = covering 無しだが行グループ geospatial_statistics 付き
    //                      → グループ選別 + 個別地物包絡の厳密判定で部分読み
    //  grid-plain.parquet = covering/stats 両方無しの平 WKB → 全件フォールバック
    ["gp-all", { type: "geoparquet", title: "ga", url: `${b}/verify/rec-formats/grid.parquet`, opts: { bbox: "off" } }, null],
    ["gp-rect", { type: "geoparquet", title: "gr", url: `${b}/verify/rec-formats/grid.parquet`, opts: {} }, GP],
    ["gp-stats", { type: "geoparquet", title: "gs", url: `${b}/verify/rec-formats/grid-nocov.parquet`, opts: {} }, GP],
    ["gp-plain", { type: "geoparquet", title: "gp", url: `${b}/verify/rec-formats/grid-plain.parquet`, opts: {} }, GP],
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
      // covering 参照列が属性へ混入しないこと(geometry_bbox struct)
      out.load[key].covLeak = feats.some(f => "geometry_bbox" in (f.properties || {}));
      // geoparquet: geo メタが item.geoHeader へ載るか(summarize 正規化も検証)
      if (key.startsWith("geoparquet") && r.header) {
        const s = vl.summarizeGeoParquetHeader(r.header);
        out.load[key].header = {
          version: s?.version, primaryColumn: s?.primaryColumn,
          encoding: s?.encoding, crs: s?.crs, edges: s?.edges,
          covering: s?.covering, itemHeader: !!it.geoHeader,
        };
      }
    } catch (e) { out.load[key] = { error: String(e).slice(0, 160) }; }
  }
  return out;
    }, base);
  } catch (e) {
    if (attempt === 2) throw e;
    console.log(`Phase A evaluate 失敗(リトライ): ${String(e).slice(0, 120)}`);
  }
}
console.log("parse:", JSON.stringify(a.parse));
console.log("load:", JSON.stringify(a.load, null, 1));
rec("A.parse.types", a.parse.length === 8 && a.parse[0] === "geojson" && a.parse[3] === "flatgeobuf" && a.parse[5] === "geoparquet" && a.parse[7] === "geoparquet",
  `8行パース ${a.parse.join(" / ")}`);
rec("A.geojson", a.load.geojson?.n === 6, `geojson 6地物(n=${a.load.geojson?.n}) geoms=${a.load.geojson?.geoms}`);
rec("A.fgb.all", a.load["fgb-all"]?.n > 0 && a.load["fgb-all"]?.viewportQuery === false,
  `fgb 全件 ${a.load["fgb-all"]?.n}地物 viewportQuery=${a.load["fgb-all"]?.viewportQuery}`);
rec("A.fgb.rect", a.load["fgb-rect"]?.n > 0 && a.load["fgb-rect"]?.n < a.load["fgb-all"]?.n && a.load["fgb-rect"]?.viewportQuery === true,
  `fgb 範囲読み ${a.load["fgb-rect"]?.n}地物 < 全件 ${a.load["fgb-all"]?.n} viewportQuery=${a.load["fgb-rect"]?.viewportQuery}`);
rec("A.geoparquet", a.load.geoparquet?.n > 0 && /name/.test(a.load.geoparquet?.props || ""),
  `geoparquet ${a.load.geoparquet?.n}地物 props=${a.load.geoparquet?.props} geoms=${a.load.geoparquet?.geoms}`);
rec("A.geoparquet.header",
  a.load.geoparquet?.header?.version === "2.0.0" && a.load.geoparquet?.header?.primaryColumn === "geometry"
    && a.load.geoparquet?.header?.encoding === "WKB" && a.load.geoparquet?.header?.itemHeader === true
    && a.load.geoparquet?.header?.crs?.authority === "OGC",
  `geoHeader ${JSON.stringify(a.load.geoparquet?.header)}`);
rec("A.geoparquet.covering",
  a.load["geoparquet-cov"]?.n > 0 && a.load["geoparquet-cov"]?.covLeak === false
    && a.load["geoparquet-cov"]?.header?.covering?.includes("bbox")
    && a.load["geoparquet-cov"]?.header?.version === "1.1.0",
  `covering ${JSON.stringify(a.load["geoparquet-cov"]?.header)} covLeak=${a.load["geoparquet-cov"]?.covLeak} props=${a.load["geoparquet-cov"]?.props}`);
// geoparquet 範囲読み(bbox=auto 既定): covering 付き → 部分読み、
// geo-stats のみ → 部分読み(厳密判定込み)、両方無し → 全件フォールバック
rec("A.geoparquet.bboxoff",
  a.load["gp-all"]?.n === 3000 && a.load["gp-all"]?.viewportQuery === false,
  `grid bbox=off 全件 ${a.load["gp-all"]?.n}地物 viewportQuery=${a.load["gp-all"]?.viewportQuery}`);
rec("A.geoparquet.rect",
  a.load["gp-rect"]?.n > 0 && a.load["gp-rect"]?.n < a.load["gp-all"]?.n
    && a.load["gp-rect"]?.viewportQuery === true,
  `grid covering 範囲読み ${a.load["gp-rect"]?.n}地物 < 全件 ${a.load["gp-all"]?.n} viewportQuery=${a.load["gp-rect"]?.viewportQuery}`);
rec("A.geoparquet.stats",
  a.load["gp-stats"]?.n > 0 && a.load["gp-stats"]?.n < a.load["gp-all"]?.n
    && a.load["gp-stats"]?.viewportQuery === true
    && a.load["gp-stats"]?.n === a.load["gp-rect"]?.n,
  `grid geo-stats 範囲読み ${a.load["gp-stats"]?.n}地物(covering と同数であること) viewportQuery=${a.load["gp-stats"]?.viewportQuery}`);
rec("A.geoparquet.fallback",
  a.load["gp-plain"]?.n === 3000 && a.load["gp-plain"]?.viewportQuery === false,
  `grid 平WKB 全件 ${a.load["gp-plain"]?.n}地物 viewportQuery=${a.load["gp-plain"]?.viewportQuery}`);
// 範囲読みの転送量削減: covering 範囲読みの .parquet Range 合計バイトが
// 平 WKB 全件読みより小さいこと(行グループ pruning が効いている証拠)。
// アプリ側のバックグラウンド読み込み(セッション復元等)と混ざらないよう、
// アプリを持たない空ページで1ロードずつ reqLog 窓を区切って計測する
// 小ファイルではフッタ用の初回プローブがファイル全体を取るため、最大単発
// Range(=全体プローブ)を除いた残り転送量で行グループ単位の読み飛ばしを比較する
const rangeBytesOf = logs => {
  const sizes = logs.filter(r => r.range)
    .map(r => { const [s, e] = r.range.split("-").map(Number); return e - s + 1; });
  return sizes.reduce((a, n) => a + n, 0) - Math.max(0, ...sizes);
};
const blankPage = await ctx.newPage();
await blankPage.goto(`${base}/verify/rec-formats/blank.html`);
const gpLoad = (url, bounds) => blankPage.evaluate(async ({ url, bounds }) => {
  const vl = await import("/shared/vector-load.js");
  const r = await vl.loadVectorItem({ type: "geoparquet", title: "g", url, opts: {} }, "", bounds);
  return r.geojson.features.length;
}, { url, bounds });
const GPB = { ranges: [{ west: 120, east: 140 }], south: 30, north: 40 };
let mark = reqLog.length;
const nRect = await gpLoad(`${base}/verify/rec-formats/grid.parquet`, GPB);
const rectBytes = rangeBytesOf(reqLog.slice(mark).filter(r => r.path.includes("grid.parquet")));
mark = reqLog.length;
const nPlain = await gpLoad(`${base}/verify/rec-formats/grid-plain.parquet`, GPB);
const plainBytes = rangeBytesOf(reqLog.slice(mark).filter(r => r.path.includes("grid-plain.parquet")));
await blankPage.close();
rec("A.geoparquet.bytes",
  nRect > 0 && nRect < nPlain && rectBytes > 0 && rectBytes < plainBytes * 0.8,
  `範囲読み転送量 grid=${rectBytes}B < 全件 ${plainBytes}B の80%未満(n=${nRect}/${nPlain})`);

// ============ Phase B: cesium エンジン実機検証 ============
const phaseBStart = reqLog.length;
const KASC = encodeURIComponent(`${base}/verify/rec-formats/rec-formats.kasc`);
// ?kasc= ロード時もアプリ側の初期遷移と goto が競合して ERR_ABORTED になる
// ことがある(中断されても最終的には目的ページへ辿り着く)。失敗時のみ再試行
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await page.goto(`${base}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  } catch (e) {
    if (!/ERR_ABORTED/.test(String(e))) throw e;
  }
  try {
    await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 60000 });
    break;
  } catch (e) {
    if (attempt === 2) throw e;
  }
}

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
const nGpRange = await waitFeatures("geoparquet範囲");
const layers = await page.evaluate(() => window.kasugaiApi.listLayers());
const autoL = layers.find(l => (l.title || "").includes("fgb(bbox=auto)"));
const offL = layers.find(l => (l.title || "").includes("fgb(bbox=off)"));
const gpL = layers.find(l => (l.title || "").includes("geoparquet範囲"));
const hiddenL = layers.find(l => (l.title || "").includes("geojson非表示"));

const needTitles = ["geojson基準", "geojson非表示", "geojson where",
  "fgb(bbox=auto)", "fgb(bbox=off)", "geoparquet where", "geoparquet範囲"];
const hasBase = layers.some(l => /(^|\/)geoparquet$/.test(l.title || ""));
const missing = needTitles.filter(p => !layers.some(l => (l.title || "").includes(p)));
rec("B.layers", missing.length === 0 && hasBase,
  `レイヤー登録 ${missing.length ? "欠落: " + missing.join(",") : "8/8"}${hasBase ? "" : "(base geoparquet 無し)"}`);
rec("B.geojson", nGeo === 6, `geojson基準 ${nGeo}地物`);
rec("B.fgb.parse", !!autoL && autoL.bboxAuto === true && !!offL && offL.bboxAuto === false,
  `bboxAuto: auto=${autoL?.bboxAuto} off=${offL?.bboxAuto}`);
rec("B.fgb.range", reqLog.slice(phaseBStart).filter(r => r.path.includes("countries.fgb") && r.range).length > 0,
  `countries.fgb Range リクエスト ${reqLog.slice(phaseBStart).filter(r => r.path.includes("countries.fgb") && r.range).length}件`);
rec("B.fgb.full", reqLog.slice(phaseBStart).some(r => r.path.includes("countries.fgb") && !r.range),
  `countries.fgb 全件取得(bbox=off 分) あり`);
rec("B.fgb.load", nFgbAuto > 0 && nFgbOff > 0, `fgb auto=${nFgbAuto} off=${nFgbOff} 地物`);
rec("B.geoparquet", nPq > 0, `geoparquet ${nPq}地物`);
// geo メタが listLayers().geo へ露出するか(レイヤー行の PQ バッジの元データ)
const pqL = layers.find(l => /(^|\/)geoparquet$/.test(l.title || ""));
rec("B.geoparquet.geo", pqL?.geo?.version === "2.0.0" && pqL?.geo?.encoding === "WKB"
  && pqL?.geo?.geometryColumns?.includes("geometry"),
  `listLayers geo=${JSON.stringify(pqL?.geo)}`);
// geoparquet bbox=auto(既定): covering.bbox による Range 部分読み。
// 初回は世界表示なので全件、カメラ移動で再クエリして範囲分に絞られる
rec("B.geoparquet.parse", !!gpL && gpL.bboxAuto === true,
  `geoparquet範囲 bboxAuto=${gpL?.bboxAuto}`);
// 初回カメラ(世界表示)でも covering filter は枠外を落とすので 3000 ちょうどには
// ならない。部分読みが走った証拠は Range リクエストと、後の狭域再クエリで判定
rec("B.geoparquet.ranged", nGpRange > 0 && nGpRange <= 3000 && reqLog.slice(phaseBStart).some(r => r.path.includes("grid.parquet") && r.range),
  `geoparquet範囲 初回 ${nGpRange}地物 + Range リクエストあり`);

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
// refreshLayers 全再構築を経由する遅延ロードは秒単位でかかることがあるため
// 固定待機ではなく取得完了までポーリングする
const hidGeo = await (async () => {
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(t => {
      const l = window.kasugaiApi.listLayers().find(x => (x.title || "").includes(t));
      return window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? 0;
    }, "geojson非表示");
    if (n === 6) return n;
    await new Promise(r => setTimeout(r, 500));
  }
  return 0;
})();
rec("B.lazy", hidGeo === 6, `非表示→表示ON で遅延ロード(取得前 ${hidBefore} → ${hidGeo}地物)`);

// fgb/geoparquet bbox=auto: 狭い範囲へ flyTo → Range 再クエリで地物が絞られる。
// 初回カメラはセッション復元等で不定のため、先に世界表示へ flyTo して
// 「広域の確定値」を取ってから狭域へ移り、件数の減少を比較する
const geojsonCount = t => page.evaluate(tt => {
  const l = window.kasugaiApi.listLayers().find(x => (x.title || "").includes(tt));
  return window.kasugaiApi.getLayerGeoJson(l.id)?.features?.length ?? 0;
}, t);
// 件数が増えなくなるまでポーリング(広域再クエリの確定待ち)
const pollWide = async t => {
  let last = -1, stable = 0;
  for (let i = 0; i < 40 && stable < 2; i++) {
    const n = await geojsonCount(t);
    if (n === last) stable++; else { last = n; stable = 0; }
    await new Promise(r => setTimeout(r, 500));
  }
  return last;
};
const pollSubset = async (t, wide) => {
  for (let i = 0; i < 40; i++) {
    const n = await geojsonCount(t);
    if (n > 0 && n < wide) return n;
    await new Promise(r => setTimeout(r, 500));
  }
  return await geojsonCount(t);
};
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 20, longitude: 10, height: 40000000, pitch: -90 }, 0));
const fgbWide = await pollWide("fgb(bbox=auto)");
const gpWide = await pollWide("geoparquet範囲");
const before = reqLog.length;
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 36, longitude: 138, height: 800000, pitch: -90 }, 0));
const zoomN = await pollSubset("fgb(bbox=auto)", fgbWide);
const reReqs = reqLog.slice(before).filter(r => r.path.includes("countries.fgb") && r.range);
rec("B.fgb.requery", reReqs.length > 0, `カメラ移動で Range 再クエリ ${reReqs.length}件`);
rec("B.fgb.subset", zoomN > 0 && zoomN < fgbWide, `狭範囲 ${zoomN}地物(広域 ${fgbWide})`);
// geoparquet も同じカメラ移動で再クエリされ、covering による範囲分に絞られる
const zoomGp = await pollSubset("geoparquet範囲", gpWide);
const rePq = reqLog.slice(before).filter(r => r.path.includes("grid.parquet") && r.range);
rec("B.gp.requery", rePq.length > 0, `カメラ移動で grid.parquet 再クエリ ${rePq.length}件`);
rec("B.gp.subset", zoomGp > 0 && zoomGp < gpWide, `狭範囲 ${zoomGp}地物(広域 ${gpWide})`);
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
