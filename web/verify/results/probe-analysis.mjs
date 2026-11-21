// V10 解析検証プローブ (skill: verify-analysis)
//  実行: node web/verify/results/probe-analysis.mjs
//  カバレッジ:
//   N1 :8510 /api/qgis-live/discover で Live Driver 検出
//   N2 :8510 /api/qgis-live/mcp 経由 tools/list → qgis_pyeval
//   N3 :8089 /live/mcp リレー経由 tools/list
//   N4 qgis_pyeval で processing.run 実解析(QGIS 実機・副作用なし memory 層)
//   N5 spatialSelect(selectFeatures) / N6 aggregateWithin / N7 bufferGeometry
//   N8 計測/空間 API・UI 存在 / N9 DuckDB-WASM 空間述語(KascLoader.loadDuckDb)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json", ".kasc": "text/plain",
  ".css": "text/css", ".parquet": "application/octet-stream", ".qml": "application/xml" };
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    const fp = resolve(join(WEB, p.endsWith("/") ? p + "index.html" : p));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(fp)] || "application/octet-stream", "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const skip = (id, detail) => { results.push({ id, ok: null });
  console.log(`SKIP ${id} :: ${detail}`); };

const jrpc = async (url, method, params = {}, id = 1) => {
  const r = await fetch(url, { method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const t = await r.text();
  const m = t.match(/^data:\s*(\{.*\})\s*$/m);  // SSE 応答と裸 JSON の両対応
  return JSON.parse(m ? m[1] : t);
};

// ---------- N1: discover ----------
let mcp8510 = null;
try {
  const d = await (await fetch("http://127.0.0.1:8510/api/qgis-live/discover")).json();
  mcp8510 = d?.ok ? "http://127.0.0.1:8510/api/qgis-live/mcp" : null;
  rec("N1", !!d?.ok, `discover ok=${d?.ok} url=${d?.url || "-"} plugin=${d?.plugin_id || "-"}`);
} catch (e) { rec("N1", false, `discover 失敗: ${e}`); }

// ---------- N2: :8510 リレー tools/list ----------
let toolNames = [];
if (mcp8510) {
  try {
    const r = await jrpc(mcp8510, "tools/list");
    toolNames = (r.result?.tools || []).map(t => t.name);
    rec("N2", toolNames.includes("qgis_pyeval"), `tools=${toolNames.join(",") || "none"}`);
  } catch (e) { rec("N2", false, `tools/list 失敗: ${e}`); }
} else skip("N2", "discover 未検出のため :8510 リレー未検証(要実機)");

// ---------- N3: :8089 /live/mcp リレー ----------
try {
  const r = await jrpc("http://127.0.0.1:8089/live/mcp", "tools/list");
  const names = (r.result?.tools || []).map(t => t.name);
  rec("N3", names.includes("qgis_pyeval"), `tools=${names.join(",") || "none"}`);
} catch (e) { skip("N3", `:8089/live/mcp 未応答(要実機): ${String(e).slice(0, 120)}`); }

// ---------- N4: processing.run 実解析(実機・pyeval は result 変数を返す) ----------
if (toolNames.includes("qgis_pyeval")) {
  try {
    const code = [
      "from qgis.core import QgsVectorLayer, QgsFeature, QgsGeometry, QgsPointXY",
      "import processing",
      "lyr = QgsVectorLayer('Point?crs=EPSG:4326', 'probe_tmp', 'memory')",
      "f = QgsFeature(); f.setGeometry(QgsGeometry.fromPointXY(QgsPointXY(139.75, 35.68)))",
      "lyr.dataProvider().addFeatures([f]); lyr.updateExtents()",
      "res = processing.run('native:buffer', {'INPUT': lyr, 'DISTANCE': 0.01, 'SEGMENTS': 8, 'OUTPUT': 'memory:'})",
      "out = res['OUTPUT']",
      "result = {'features': out.featureCount() if hasattr(out, 'featureCount') else -1, 'type': str(type(out))[:80]}",
    ].join("\n");
    const r = await jrpc(mcp8510, "tools/call",
      { name: "qgis_pyeval", arguments: { code } }, 2);
    const txt = (r.result?.content || []).map(c => c.text).join("") || JSON.stringify(r.error || {});
    const feat = /"features":\s*(-?\d+)/.exec(txt)?.[1];
    rec("N4", Number(feat) >= 1, `native:buffer → features=${feat ?? "-"} resp=${txt.slice(0, 160)}`);
  } catch (e) { rec("N4", false, `processing.run 失敗: ${String(e).slice(0, 160)}`); }
} else skip("N4", "qgis_pyeval 未検出のため実解析未検証(要実機)");

// ---------- N5-N9: ブラウザ内解析 ----------
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("PAGEERR:", String(e).slice(0, 200)));

await page.goto(`${base}/maplibre/`, { waitUntil: "domcontentloaded" })
  .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
// アプリは起動後に ?project=default へ実遷移する — 最終ドキュメントで
// kasugaiApi + tools-dock が揃うまで待つ(早すぎる evaluate は旧コンテキストに当たる)
const waitStable = () => page.waitForFunction(
  () => window.kasugaiApi && document.querySelector("#tools-dock"), null,
  { timeout: 60000, polling: 500 }).catch(() => {});
await waitStable();

// evaluate はアプリ側遷移でコンテキストが壊れ得るためリトライ
const evalRetry = async (fn, arg, tries = 4) => {
  for (let i = 0; i < tries; i++) {
    try { return await page.evaluate(fn, arg); }
    catch (e) {
      if (!/Execution context was destroyed|Cannot read properties/.test(String(e)) || i === tries - 1)
        return { err: String(e).slice(0, 200) };
      await waitStable();
    }
  }
};

// spatial-ops.js 直接評価(エンジン非依存)
const ops = await evalRetry(async () => {
  const so = await import("../shared/spatial-ops.js");
  const pts = { type: "FeatureCollection", features: [1, 2, 3, 4].map(i => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [139.7 + i * 0.01, 35.68] },
    properties: { grp: i <= 2 ? "A" : "B", val: i * 10 },
  })) };
  const region = so.rectPolygon(139.705, 35.67, 139.73, 35.69); // 点1,2 のみ内側
  const sel = so.selectFeatures(pts, region);                    // Feature の配列
  const agg = so.aggregateWithin(pts, region, { groupField: "grp", valueField: "val" });
  const buf = await so.bufferGeometry(pts.features[0].geometry, 500); // Point → 測地線円
  return { sel: sel.length, rows: agg.rows, bufType: buf?.type,
    bufCoords: buf?.coordinates?.[0]?.length };
});

if (ops.err) { rec("N5", false, ops.err); rec("N6", false, "spatial-ops 評価失敗"); rec("N7", false, "spatial-ops 評価失敗"); }
else {
  rec("N5", ops.sel === 2, `selectFeatures → ${ops.sel} 件(期待2)`);
  const aRow = (ops.rows || []).find(r => r.key === "A");
  rec("N6", aRow?.count === 2 && aRow?.sum === 30, `aggregateWithin A行 → ${JSON.stringify(aRow)}`);
  rec("N7", ops.bufType === "Polygon" && ops.bufCoords >= 16, `bufferGeometry → ${ops.bufType} ${ops.bufCoords}頂点`);
}

// kasugaiApi 経由の spatialSelect / 計測 API
const apiOps = await evalRetry(() => {
  const a = window.kasugaiApi || {};
  return { spatialSelect: typeof a.spatialSelect,
    measureDistance: typeof a.measureDistance, measureArea: typeof a.measureArea,
    keys: Object.keys(a).filter(k => /meas|spat|buffer|aggreg/i.test(k)).join(",") };
});
rec("N8", apiOps.spatialSelect === "function" || apiOps.measureDistance === "function",
  `kasugaiApi 計測/空間 API: ${apiOps.keys || "なし"}`);

const measureUi = await evalRetry(() =>
  !!document.querySelector("#tools-measure-panel, [id*=measure], [data-i18n*=measure]"));
rec("N8b", !!measureUi, `計測 UI 要素: ${measureUi}`);

// N9: DuckDB-WASM 空間述語(KascLoader.loadDuckDb → INSTALL spatial 済みなら ST_ 実行)
const duck = await evalRetry(async () => {
  await import("../shared/kasc_loader.js");            // window.KascLoader を登録
  const kl = window.KascLoader;
  if (!kl?.loadDuckDb) return { err: "KascLoader.loadDuckDb なし" };
  const st = await kl.loadDuckDb();
  const t = await st.conn.query(
    "SELECT ST_Intersects(ST_Point(0.5,0.5), ST_MakeEnvelope(0,0,1,1)) AS hit");
  const hit = t.toArray()[0]?.toJSON()?.hit ?? t.toArray()[0]?.hit;
  return { spatial: st.spatial, hit: String(hit) };
});
if (duck.err) skip("N9", `DuckDB 空間述語の評価不可: ${duck.err}`);
else if (duck.spatial === false) skip("N9", "spatial 拡張未ロード(環境依存)のため未検証");
else rec("N9", String(duck.hit) === "true", `ST_Intersects → hit=${duck.hit} spatial=${duck.spatial}`);

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
