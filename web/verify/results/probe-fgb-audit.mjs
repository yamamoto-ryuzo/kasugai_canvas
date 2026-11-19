// FlatGeobuf API → Canvas 反映監査の検証プローブ (engine-flatgeobuf スキル)
//  実行: node web/verify/results/probe-fgb-audit.mjs
//  カバレッジ:
//   A) モジュール: headerMeta捕捉/readMetadata/summarize拡張・zstd圧縮読込・
//      serialize→deserialize 往復・輸出FGBの自前空間インデックス(packed R-tree)・alldatatypes
//   B) proxy=on(/api/fetch shim経由 Range転送)・key=(Bearerヘッダ)・nocache
//   C) cesium: FGBバッジDOM・非表示行の遅延メタ(listLayers fgb露出)・
//      proxy=on 行の applyInspector 経由ロード
//   D) maplibre/openlayers: listLayers fgb フィールド + 地物読み込み
//  テスト資産: web/verify/fgb-test/(countries.fgb・countries-32k.fgb.zst・alldatatypes.fgb)
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

const reqLog = []; // {path, range, auth}
const srv = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = decodeURIComponent(u.pathname);
  const auth = req.headers.authorization || null;
  try {
    // --- /api/fetch プロキシ shim: url= は無視して countries.fgb を転送する
    // (検証対象は「プロキシURL解決→Range転送→部分読み」の経路そのもの)
    if (p === "/api/fetch") {
      const fp = resolve(join(WEB, "verify/fgb-test/countries.fgb"));
      const data = await readFile(fp);
      reqLog.push({ path: `/api/fetch?url=${u.searchParams.get("url")}`, range: req.headers.range || null, auth });
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      if (m) {
        const s = Number(m[1]), e = m[2] ? Number(m[2]) : data.length - 1;
        res.writeHead(206, { "content-type": "application/octet-stream", "accept-ranges": "bytes",
          "content-range": `bytes ${s}-${e}/${data.length}` });
        res.end(data.subarray(s, e + 1));
      } else {
        res.writeHead(200, { "content-type": "application/octet-stream", "accept-ranges": "bytes" });
        res.end(data);
      }
      return;
    }
    // --- PUT /verify/tmp/<name>: serialize 往復検証の受け皿
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
      // bytes=N- / bytes=N-M / bytes=-N(接尾辞: 末尾Nバイト・seekable-zstd が使用)
      const s = m[1] === "" ? Math.max(data.length - Number(m[2]), 0) : Number(m[1]);
      const e = m[1] === "" || !m[2] ? data.length - 1 : Number(m[2]);
      reqLog.push({ path: q, range: `${s}-${e}`, auth });
      res.writeHead(206, { "content-type": mime, "accept-ranges": "bytes",
        "content-range": `bytes ${s}-${e}/${data.length}` });
      res.end(data.subarray(s, e + 1));
      return;
    }
    reqLog.push({ path: q, range: null, auth });
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

// ============ Phase A: モジュール単位(静的ページで実行・エンジン起動を回避) ============
await page.goto(`${base}/verify/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
const a = await page.evaluate(async (b) => {
  const vl = await import("../shared/vector-load.js");
  const ef = await import("../shared/export-formats.js");
  const bk = await import("../shared/backend.js");
  const JP = { ranges: [{ west: 120, east: 150 }], south: 20, north: 50 };
  const out = {};
  const item = (url, opts) => ({ type: "flatgeobuf", title: "f", url, opts: opts || {} });

  // A1: headerMeta 捕捉 + summarize 拡張
  const it1 = item(`${b}/verify/fgb-test/countries.fgb`, { bbox: "off" });
  const r1 = await vl.loadVectorItem(it1, "");
  out.all = { n: r1.geojson.features.length, header: vl.summarizeFlatGeobufHeader(it1.fgbHeader) };

  // A2: readFlatGeobufMeta(ヘッダのみ)
  out.meta = await vl.readFlatGeobufMeta(`${b}/verify/fgb-test/countries.fgb`);

  // A3: summarize 冪等(meta を再 summarize)
  out.metaResum = JSON.stringify(vl.summarizeFlatGeobufHeader(out.meta)) === JSON.stringify(out.meta);

  // A4: zstd 圧縮 (全件 + rect)
  try {
    const itz = item(`${b}/verify/fgb-test/countries-32k.fgb.zst`, { bbox: "off" });
    const rz = await vl.loadVectorItem(itz, "");
    const itz2 = item(`${b}/verify/fgb-test/countries-32k.fgb.zst`, {});
    const rz2 = await vl.loadVectorItem(itz2, "", JP);
    out.zstd = { all: rz.geojson.features.length, rect: rz2.geojson.features.length,
      ranged: rz2.viewportQuery, header: vl.summarizeFlatGeobufHeader(itz2.fgbHeader) };
  } catch (e) { out.zstd = { error: String(e).slice(0, 200) }; }

  // A5: alldatatypes
  try {
    const itd = item(`${b}/verify/fgb-test/alldatatypes.fgb`, { bbox: "off" });
    const rd = await vl.loadVectorItem(itd, "");
    out.alltypes = { n: rd.geojson.features.length,
      props: Object.keys(rd.geojson.features[0]?.properties || {}).length,
      cols: (vl.summarizeFlatGeobufHeader(itd.fgbHeader)?.columns || []).map(c => c.type) };
  } catch (e) { out.alltypes = { error: String(e).slice(0, 160) }; }

  // A6: serialize → PUT → deserialize 往復 + 輸出物の自前空間インデックス
  try {
    const bytes = await ef.toFlatGeobuf(r1.geojson);
    out.serialized = bytes.length;
    const put = await fetch(`${b}/verify/tmp/roundtrip.fgb`, { method: "PUT", body: bytes });
    out.putStatus = put.status;
    const itr = item(`${b}/verify/tmp/roundtrip.fgb`, { bbox: "off" });
    const rr = await vl.loadVectorItem(itr, "");
    const itr2 = item(`${b}/verify/tmp/roundtrip.fgb`, {});
    const rr2 = await vl.loadVectorItem(itr2, "", JP); // bbox=auto→索引あり→範囲読み
    out.roundtrip = {
      n: rr.geojson.features.length,
      name0: rr.geojson.features[0]?.properties?.name,
      autoVq: rr2.viewportQuery, autoN: rr2.geojson.features.length,
      header: vl.summarizeFlatGeobufHeader(itr.fgbHeader),
    };
  } catch (e) { out.roundtrip = { error: String(e).slice(0, 200) }; }

  // B1: fetchProxyUrl 単位(疑似バックエンド差し替え)
  bk.setBackendCapabilities({ tier: "local", features: ["fetchRange", "fetchProxy"] }, true, b);
  out.px = {
    remote: bk.fetchProxyUrl("https://fgb.example.test/x.fgb", true),
    loopback: bk.fetchProxyUrl("http://127.0.0.1:1/x.fgb", true),
    off: bk.fetchProxyUrl("https://fgb.example.test/x.fgb", false),
  };

  // B2: proxy=on 経由ロード( shim が bytes を返す)
  try {
    const itp = item("https://fgb.example.test/countries.fgb", { proxy: "on" });
    const rp = await vl.loadVectorItem(itp, "", JP);
    out.proxy = { n: rp.geojson.features.length, ranged: rp.viewportQuery };
  } catch (e) { out.proxy = { error: String(e).slice(0, 200) }; }

  // B3: key= → Authorization ヘッダ(直接 URL でも付与されるか。rect 読み)
  try {
    const itk = item(`${b}/verify/fgb-test/countries.fgb`, { key: "secret-token-1" });
    const rk = await vl.loadVectorItem(itk, "", JP);
    out.key = { n: rk.geojson.features.length };
  } catch (e) { out.key = { error: String(e).slice(0, 160) }; }

  // nocache=on スモーク(壊れないこと)
  try {
    const itn = item(`${b}/verify/fgb-test/countries.fgb`, { nocache: "on" });
    const rn = await vl.loadVectorItem(itn, "", JP);
    out.nocache = { n: rn.geojson.features.length, ranged: rn.viewportQuery };
  } catch (e) { out.nocache = { error: String(e).slice(0, 160) }; }
  return out;
}, base);
console.log(JSON.stringify(a, null, 1));

const expCount = a.all?.n;
rec("A.headerMeta", a.all?.header?.featuresCount > 0 && a.all.header.hasSpatialIndex === true
    && a.all.header.geometryType === "MultiPolygon" && (a.all.header.columns || []).length > 0,
  `header: count=${a.all?.header?.featuresCount} index=${a.all?.header?.hasSpatialIndex} geom=${a.all?.header?.geometryType} cols=${a.all?.header?.columns?.length}`);
rec("A.meta.readMetadata", a.meta?.featuresCount > 0 && a.meta.hasSpatialIndex === true
    && !!a.meta.envelope && (a.meta.columns || []).length > 0,
  `readMetadata: count=${a.meta?.featuresCount} env=${JSON.stringify(a.meta?.envelope)}`);
rec("A.meta.idempotent", a.metaResum === true, "summarizeFlatGeobufHeader は正規化済みをそのまま返す");
rec("A.meta.extended", a.meta?.columns?.some(c => c.nullable !== undefined) && "description" in (a.meta || {}),
  `列詳細(nullable等)+description フィールド: ${JSON.stringify(a.meta?.columns?.[0])}`);
rec("A.zstd", a.zstd?.all > 0 && a.zstd?.rect > 0 && a.zstd.ranged === true,
  `zstd 全件=${a.zstd?.all} rect=${a.zstd?.rect} ranged=${a.zstd?.ranged} err=${a.zstd?.error || "-"}`);
rec("A.zstd.range", reqLog.some(r => r.path.includes("countries-32k.fgb.zst") && r.range),
  `.zst への Range リクエスト ${reqLog.filter(r => r.path.includes(".zst")).length}件`);
rec("A.alltypes", a.alltypes?.n > 0 && a.alltypes?.props > 0 && (a.alltypes?.cols || []).length >= 5,
  `alldatatypes ${a.alltypes?.n}地物 ${a.alltypes?.props}属性 列型=${(a.alltypes?.cols || []).join("/")}`);
rec("A.serialize", a.serialized > 0, `serialize ${a.serialized}B`);
rec("A.roundtrip", a.roundtrip?.n === expCount && !!a.roundtrip?.name0,
  `往復 ${a.roundtrip?.n}/${expCount}地物 name0=${a.roundtrip?.name0}`);
rec("A.index.export", a.roundtrip?.header?.hasSpatialIndex === true
    && a.roundtrip?.header?.indexNodeSize === 16
    && a.roundtrip?.autoVq === true
    && a.roundtrip?.autoN > 0 && a.roundtrip?.autoN < expCount,
  `輸出FGBは索引あり(indexNodeSize=${a.roundtrip?.header?.indexNodeSize})→bbox=auto 範囲読み ${a.roundtrip?.autoN}/${expCount} err=${a.roundtrip?.error || "-"}`);
rec("A.index.range", reqLog.some(r => r.path.includes("roundtrip.fgb") && r.range),
  `輸出FGBへの Range リクエスト ${reqLog.filter(r => r.path.includes("roundtrip.fgb") && r.range).length}件`);

// ============ Phase B: proxy/key ============
rec("B.proxy.rewrite", a.px?.remote === `${base}/api/fetch?url=${encodeURIComponent("https://fgb.example.test/x.fgb")}`
    && a.px?.loopback === "http://127.0.0.1:1/x.fgb" && a.px?.off === "https://fgb.example.test/x.fgb",
  `remote=${a.px?.remote}`);
const pxReqs = reqLog.filter(r => r.path.startsWith("/api/fetch"));
rec("B.proxy.load", a.proxy?.n > 0 && a.proxy.ranged === true,
  `proxy=on 経由 ${a.proxy?.n}地物 ranged=${a.proxy?.ranged} err=${a.proxy?.error || "-"}`);
rec("B.proxy.range", pxReqs.some(r => r.range),
  `/api/fetch へ Range 転送 ${pxReqs.filter(r => r.range).length}件`);
rec("B.key.header", reqLog.some(r => r.auth === "Bearer secret-token-1"),
  `Authorization ヘッダ到達: ${reqLog.filter(r => r.auth).length}件 auth=${reqLog.find(r => r.auth)?.auth}`);
rec("B.nocache", a.nocache?.n > 0 && a.nocache.ranged === true,
  `nocache=on ${a.nocache?.n}地物 ranged=${a.nocache?.ranged}`);

// ============ Phase C: cesium エンジン ============
const phaseC = reqLog.length;
await page.goto(`${base}/cesium/?kasc=${encodeURIComponent(`${base}/verify/fgb-test/fgb-range.kasc`)}`,
  { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 90000 });
await page.waitForTimeout(8000);

const c = await page.evaluate(() => {
  const layers = window.kasugaiApi.listLayers();
  const get = part => layers.find(l => (l.title || "").includes(part));
  return {
    auto: get("countries(bbox=auto)"),
    off: get("countries(bbox=off)"),
    zstd: get("countries(zstd)"),
    lazy: get("遅延メタ"),
    badges: document.querySelectorAll(".fgb-meta-badge").length,
    badgeTitle: document.querySelector(".fgb-meta-badge")?.getAttribute("title") || "",
  };
});
console.log(JSON.stringify(c, null, 1));
rec("C.layers", !!c.auto && !!c.off && !!c.zstd && !!c.lazy, "5行パース");
rec("C.badge.loaded", c.badges >= 3 && /索引あり/.test(c.badgeTitle),
  `FGBバッジ ${c.badges}個 title="${c.badgeTitle.slice(0, 80)}"`);
rec("C.fgb.listLayers", c.auto?.fgb?.featuresCount > 0 && c.auto.fgb.hasSpatialIndex === true,
  `listLayers fgb: count=${c.auto?.fgb?.featuresCount}`);
rec("C.zstd.engine", c.zstd?.fgb != null, `zstd レイヤーの fgb メタ: ${JSON.stringify(c.zstd?.fgb?.columns?.length)}列`);

// 遅延メタ: 非表示行にも readMetadata で fgb が付くか(非同期なのでポーリング)
let lazyFgb = null;
for (let i = 0; i < 20; i++) {
  lazyFgb = await page.evaluate(() =>
    window.kasugaiApi.listLayers().find(l => (l.title || "").includes("遅延メタ"))?.fgb);
  if (lazyFgb) break;
  await page.waitForTimeout(500);
}
rec("C.lazy.meta", lazyFgb?.featuresCount > 0 && lazyFgb.hasSpatialIndex === true,
  `非表示行の遅延メタ count=${lazyFgb?.featuresCount}`);

// proxy=on 行を applyInspector で投入(疑似バックエンドを shim へ向けてから)
await page.evaluate(async (b) => {
  const bk = await import("../shared/backend.js");
  bk.setBackendCapabilities({ tier: "local", features: ["fetchRange", "fetchProxy"] }, true, b);
  window.kasugaiApi.applyInspector(
    "flatgeobuf: テスト/proxy経由 | https://fgb.example.test/countries.fgb | on | proxy=on");
}, base);
let pxLayer = null;
for (let i = 0; i < 30; i++) {
  pxLayer = await page.evaluate(() => {
    const l = window.kasugaiApi.listLayers().find(x => (x.title || "").includes("proxy経由"));
    if (!l) return null;
    return { ...l, n: window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? 0 };
  });
  if (pxLayer?.n > 0) break;
  await page.waitForTimeout(500);
}
const pxHits = reqLog.slice(phaseC).filter(r => r.path.startsWith("/api/fetch"));
rec("C.proxy.row", pxLayer?.n > 0 && pxHits.length > 0,
  `proxy=on 行 → ${pxLayer?.n}地物 / /api/fetch ${pxHits.length}件(Range ${pxHits.filter(r => r.range).length})`);
await page.screenshot({ path: `${OUT}fgb-audit-cesium.png` });

// ============ Phase D: 2D エンジン(読み込み完了までポーリング) ============
// 新規コンテキストで localStorage を分離する。前フェーズの applyInspector が
// session-state へ保存され、別エンジン起動時に ?kasc= より優先復元されるため
const ctxD = await browser.newContext();
const pageD = await ctxD.newPage();
for (const [engine, ready] of [
  ["maplibre", () => window.kascMap?.loaded?.() && window.kasugaiApi],
  ["openlayers", () => window.kascMap || window.kascOl],
  ["leaflet", () => window.kascMap || window.leafletMap],
]) {
  try {
    await pageD.goto(`${base}/${engine}/?kasc=${encodeURIComponent(`${base}/verify/fgb-test/fgb-range.kasc`)}`,
      { waitUntil: "domcontentloaded" });
    await pageD.waitForFunction(ready, { timeout: 120000 });
    let r = null;
    for (let i = 0; i < 20; i++) {
      r = await pageD.evaluate(() => {
        const l = window.kasugaiApi.listLayers();
        return { layers: l.length, fgb: l.filter(x => x.fgb).length,
          titles: l.map(x => x.title) };
      });
      if (r.layers >= 5 && r.fgb >= 1) break;
      await pageD.waitForTimeout(1500);
    }
    // ロード済み行(3行)のみ fgb 付与。off 行の遅延メタは Cesium 専用
    rec(`D.${engine}`, r.layers >= 5 && r.fgb >= 1,
      `${engine}: layers=${r.layers} fgb露出=${r.fgb}`);
    await pageD.screenshot({ path: `${OUT}fgb-audit-${engine}.png` });
  } catch (e) { rec(`D.${engine}`, false, `FAILED ${String(e).slice(0, 120)}`); }
}
await ctxD.close();

// 往復検証で生成した一時ファイルを掃除
import { rmSync } from "node:fs";
rmSync(resolve(join(WEB, "verify/tmp")), { recursive: true, force: true });

srv.close();
await browser.close();
const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
