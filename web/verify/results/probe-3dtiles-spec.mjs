// 3D Tiles 仕様 → Canvas 反映の検証プローブ (skill: engine-3dtiles)
//  実行: node web/verify/results/probe-3dtiles-spec.mjs
//  カバレッジ:
//   A) shared/kasc.js パース(3dtiles は doc.unsupported 経由 + opts kv 保持)
//   B) cesium: Cesium3DTileset 実ロード(1.1 最小・外部tilesetリンク・| off 遅延)
//      + 行オプション反映(sse=/tilecolor=/tileshow=/tilepointsize=/edl=)
//      + cacheBytes/maximumCacheOverflowBytes(Cesium 1.110 で maximumMemoryUsage 削除)
//   C) maplibre/openlayers/leaflet: deck.gl Tile3DLayer スモーク(tileset.json 取得)
//   D) navara: 3d-tiles ソース スモーク
//   E) gsimaps: 未対応経路(タイル取得しない・警告表示)
//  テスト資産: web/verify/3dtiles-spec/(min11・nested・spec-3dtiles.kasc)
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
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain",
  ".wasm": "application/wasm", ".b3dm": "application/octet-stream" };

const reqLog = [];
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    const q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    reqLog.push(q);
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream",
      "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const countReq = (frag) => reqLog.filter(q => q.includes(frag)).length;

let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("PAGEERR:", String(e).slice(0, 200)));

const KASC_URL = `${base}/verify/3dtiles-spec/spec-3dtiles.kasc`;
const KASC_PARAM = encodeURIComponent(KASC_URL);

// ============ Phase A: shared/kasc.js パース ============
await page.goto(`${base}/cesium/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
const a = await page.evaluate(async (u) => {
  const kasc = await import("../shared/kasc.js");
  const doc = kasc.parseKasc(await (await fetch(u)).text());
  return { layers: doc.layers.map(l => l.type),
    un: doc.unsupported.map(l => ({ type: l.type, title: l.title, visible: l.visible, opts: l.opts })) };
}, KASC_URL);
const un3d = (a.un || []).filter(i => i.type === "3dtiles");
const o0 = un3d[0]?.opts || {};
const o3 = un3d[3]?.opts || {};
rec("A.parse.unsupported", a.layers.length === 0 && un3d.length === 5,
  `3dtiles は doc.unsupported 経由(5行) layers=${a.layers.length}`);
rec("A.parse.opts", o0.sse === "4" && o0.edl === "off" && /orange/.test(o0.tilecolor || "")
  && /height/.test(o0.tileshow || "") && o0.tilepointsize === "8",
  `opts kv 保持 sse=${o0.sse} edl=${o0.edl} tilecolor=${o0.tilecolor} tileshow=${o0.tileshow} pointsize=${o0.tilepointsize}`);
rec("A.parse.opts.extras", o3.clippoly === "clip.geojson" && o3.customshader === "shader.json"
  && o3.colorblend === "highlight" && o3.blendamount === "0.5" && o3.splitdir === "none"
  && /wireframe/.test(o3.debug || "") && o3.foveated === "on"
  && /attenuation/.test(o3.pcshade || "") && o3.tiletime === "2020-06-01T00:00:00Z",
  `拡張opts kv 保持 clippoly=${o3.clippoly} colorblend=${o3.colorblend} debug=${o3.debug} foveated=${o3.foveated} tiletime=${o3.tiletime}`);
rec("A.parse.off", un3d[2]?.visible === false && un3d[0]?.visible !== false,
  `| off 検出 row3.visible=${un3d[2]?.visible}`);

// ============ Phase B: cesium 実機 ============
await page.goto(`${base}/cesium/?kasc=${KASC_PARAM}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window._viewer && window.kasugaiApi?.isReady, { timeout: 90000 });
// タイルセットのロード待ち(最大30s・可視3行)
await page.waitForFunction(() => {
  const P = window._viewer.scene.primitives;
  let n = 0;
  for (let i = 0; i < P.length; i++) if (P.get(i) instanceof Cesium.Cesium3DTileset && P.get(i).root) n++;
  return n >= 3;
}, { timeout: 30000 }).catch(() => {});
const b = await page.evaluate(() => {
  const P = window._viewer.scene.primitives;
  const ts = [];
  for (let i = 0; i < P.length; i++) {
    const p = P.get(i);
    if (p instanceof Cesium.Cesium3DTileset) ts.push(p);
  }
  return ts.map(t => ({
    url: t.tilesetUrl || t._url || "",
    sse: t.maximumScreenSpaceError,
    cacheBytes: t.cacheBytes, cacheOverflow: t.maximumCacheOverflowBytes,
    hasRoot: !!t.root, version: t.asset?.version,
    styleColor: t.style?.color?.expression || null,
    styleShow: t.style?.show?.expression || null,
    stylePoint: String(t.style?.pointSize?.expression ?? t.style?.pointSize ?? ""),
    edl: t.pointCloudShading ? t.pointCloudShading.eyeDomeLighting : null,
    show: t.show,
    // --- 拡張オプション(engine-3dtiles) ---
    clipPolyCount: t.clippingPolygons?.length ?? 0,
    clipInverse: t.clippingPolygons?.inverse ?? null,
    clipIsCollection: t.clippingPolygons instanceof Cesium.ClippingPolygonCollection,
    customShader: t.customShader instanceof Cesium.CustomShader,
    colorBlend: t.colorBlendMode === Cesium.Cesium3DTileColorBlendMode.HIGHLIGHT
      ? "HIGHLIGHT" : String(t.colorBlendMode),
    blendAmount: t.colorBlendAmount,
    split: t.splitDirection === Cesium.SplitDirection.NONE ? "NONE"
      : String(t.splitDirection),
    dbgColorize: t.debugColorizeTiles, dbgGeoerr: t.debugShowGeometricError,
    dbgWireframe: t.debugWireframe,
    fovSse: t.foveatedScreenSpaceError, fovCone: t.foveatedConeSize,
    fovMin: t.foveatedMinimumScreenSpaceErrorRelaxation, fovDelay: t.foveatedTimeDelay,
    pcs: t.pointCloudShading ? {
      att: t.pointCloudShading.attenuation,
      baseRes: t.pointCloudShading.baseResolution,
      geoErr: t.pointCloudShading.geometricErrorScale,
      maxAtt: t.pointCloudShading.maximumAttenuation,
      edlStr: t.pointCloudShading.eyeDomeLightingStrength,
      edlRad: t.pointCloudShading.eyeDomeLightingRadius,
    } : null,
    time: t.time ? Cesium.JulianDate.toIso8601(t.time) : null,
  }));
});
console.log("tilesets:", JSON.stringify(b, null, 1));
const tsMin = b.find(t => t.url.includes("min11") && t.sse === 4);
const tsNested = b.find(t => t.url.includes("nested"));
const tsExt = b.find(t => t.customShader || t.clipPolyCount > 0 || t.dbgColorize);
rec("B.tileset.count", b.length === 3, `可視3行のみロード(n=${b.length})`);
rec("B.tileset.min11", !!tsMin?.hasRoot, `1.1 最小タイルセット root 取得`);
rec("B.option.sse", tsMin?.sse === 4, `sse=4 → maximumScreenSpaceError=${tsMin?.sse}`);
rec("B.option.style", /orange|color/.test(tsMin?.styleColor || "") && /height/.test(tsMin?.styleShow || "")
  && /8/.test(tsMin?.stylePoint || ""),
  `Cesium3DTileStyle color=${tsMin?.styleColor} show=${tsMin?.styleShow} pointSize=${tsMin?.stylePoint}`);
rec("B.option.edl", tsMin?.edl === false, `edl=off → pointCloudShading.eyeDomeLighting=${tsMin?.edl}`);
rec("B.cacheBytes", Number.isFinite(tsMin?.cacheBytes) && tsMin?.cacheBytes === 2048 * 1024 * 1024
  && tsMin?.cacheOverflow === Number.MAX_VALUE,
  `cacheBytes=${tsMin?.cacheBytes} overflow=${tsMin?.cacheOverflow}(UI 2048MB 変換)`);
// --- 拡張オプション(拡張opts 行 → tsExt) ---
rec("B.extra.clippoly", !!tsExt?.clipIsCollection && tsExt?.clipPolyCount >= 1
  && tsExt?.clipInverse === false,
  `clippoly=GeoJSON → ClippingPolygonCollection(${tsExt?.clipPolyCount}ポリゴン inverse=${tsExt?.clipInverse})`);
rec("B.extra.shader", tsExt?.customShader === true,
  `customshader=JSON → CustomShader 構築`);
rec("B.extra.colorblend", tsExt?.colorBlend === "HIGHLIGHT" && tsExt?.blendAmount === 0.5,
  `colorblend=highlight + blendamount=0.5 → ${tsExt?.colorBlend}/${tsExt?.blendAmount}`);
rec("B.extra.splitdir", tsExt?.split === "NONE",
  `splitdir=none → SplitDirection=${tsExt?.split}`);
rec("B.extra.debug", tsExt?.dbgColorize === true && tsExt?.dbgGeoerr === true
  && tsExt?.dbgWireframe === true,
  `debug=colorize,geoerror,wireframe → flags=${tsExt?.dbgColorize}/${tsExt?.dbgGeoerr}/${tsExt?.dbgWireframe}`);
rec("B.extra.foveated", tsExt?.fovSse === true && tsExt?.fovCone === 0.6
  && tsExt?.fovMin === 8 && tsExt?.fovDelay === 0.5,
  `foveated 系 → sse=${tsExt?.fovSse} cone=${tsExt?.fovCone} min=${tsExt?.fovMin} delay=${tsExt?.fovDelay}`);
rec("B.extra.pcshade", tsExt?.pcs?.att === true && tsExt?.pcs?.baseRes === 5
  && tsExt?.pcs?.geoErr === 0.8 && tsExt?.pcs?.maxAtt === 16
  && tsExt?.pcs?.edlStr === 1.2 && tsExt?.pcs?.edlRad === 1.5,
  `pcshade JSON → ${JSON.stringify(tsExt?.pcs)}`);
rec("B.extra.time", !!tsExt?.time && tsExt.time.startsWith("2020-06-01"),
  `tiletime=2020-06-01 → tileset.time=${tsExt?.time}`);
rec("B.lazy.hidden", countReq("hidden/tileset.json") === 0,
  `| off 行は取得しない(hidden 取得 ${countReq("hidden/tileset.json")}回)`);
// 外部 tileset.json リンク: nested の root content = child/tileset.json
// カメラをタイルセットへ寄せてコンテンツ要求を発生させる
await page.evaluate(() => {
  const P = window._viewer.scene.primitives;
  for (let i = 0; i < P.length; i++) {
    const p = P.get(i);
    if (p instanceof Cesium.Cesium3DTileset && (p.tilesetUrl || p._url || "").includes("nested")) {
      window._viewer.zoomTo(p); break;
    }
  }
});
await page.waitForFunction(() => true, { timeout: 3000 });
for (let i = 0; i < 20 && countReq("nested/child/tileset.json") === 0; i++) {
  await new Promise(r => setTimeout(r, 500));
}
rec("B.external.link", countReq("nested/child/tileset.json") >= 1,
  `外部 tileset リンク追随(child 取得 ${countReq("nested/child/tileset.json")}回)`);
const layers = await page.evaluate(() => window.kasugaiApi.listLayers());
rec("B.listLayers", layers.filter(l => l.type === "3dtiles" || /3dtiles/.test(l.sourceLine || "")).length >= 3
  || layers.length >= 3, `listLayers ${layers.length}件`);

// ============ Phase C: deck.gl エンジン(maplibre/openlayers/leaflet) ============
for (const eng of ["maplibre", "openlayers", "leaflet"]) {
  const mark = reqLog.length;
  try {
    await page.goto(`${base}/${eng}/?kasc=${KASC_PARAM}`, { waitUntil: "domcontentloaded" });
    // deck.gl CDN 遅延ロード後に tileset.json を取得するまで待つ
    let ok = false;
    for (let i = 0; i < 180 && !ok; i++) {
      await new Promise(r => setTimeout(r, 500));
      ok = reqLog.slice(mark).some(q => q.includes("min11/tileset.json"));
    }
    const cMin = reqLog.slice(mark).filter(q => q.includes("min11/tileset.json")).length;
    const cNested = reqLog.slice(mark).filter(q => q.includes("nested/root.json")).length;
    const cHidden = reqLog.slice(mark).filter(q => q.includes("hidden/tileset.json")).length;
    rec(`C.${eng}.load`, ok && cNested >= 1,
      `${eng}: min11 ${cMin}回・nested ${cNested}回( deck Tile3DLayer )`);
    rec(`C.${eng}.lazy`, cHidden === 0, `${eng}: | off 行は未要求(hidden=${cHidden}回)`);
    // deckopts 行の Tile3DLayer props 反映を実検証（operation=terrain・
    // pointcolor→getPointColor・deckopts JSON→loadOptions.tileset）
    const deckInfo = await page.evaluate(() => {
      const inst = window.kascDeckInst || window.kascDeckOverlay?._deck || window.kascDeckOverlay?.deck;
      const ls = inst?.props?.layers || [];
      return ls.map(l => ({
        id: l?.id,
        op: l?.props?.operation,
        pc: l?.props?.getPointColor,
        thr: l?.props?.loadOptions?.tileset?.throttleRequests,
      }));
    });
    const ext = deckInfo.find(l => l.op === "terrain");
    rec(`C.${eng}.deckopts`, !!ext && Array.isArray(ext.pc) && ext.pc[0] === 255 && ext.thr === false,
      `${eng}: operation/pointcolor/deckopts 反映 ${JSON.stringify(ext ?? `layers=${deckInfo.length}`)}`);
  } catch (e) {
    rec(`C.${eng}.load`, false, `${eng}: ${String(e).slice(0, 120)}`);
    rec(`C.${eng}.lazy`, false, `${eng}: 未到達`);
  }
}

// ============ Phase D: navara ============
{
  const mark = reqLog.length;
  try {
    await page.goto(`${base}/navara/?kasc=${KASC_PARAM}`, { waitUntil: "domcontentloaded" });
    let ok = false;
    for (let i = 0; i < 180 && !ok; i++) {
      await new Promise(r => setTimeout(r, 500));
      ok = reqLog.slice(mark).some(q => q.includes("min11/tileset.json"));
    }
    rec("D.navara.load", ok, `navara: min11 取得 ${reqLog.slice(mark).filter(q => q.includes("min11/tileset.json")).length}回(3d-tiles ソース)`);
  } catch (e) {
    rec("D.navara.load", false, `navara: ${String(e).slice(0, 120)}`);
  }
}

// ============ Phase E: gsimaps(未対応経路) ============
{
  const mark = reqLog.length;
  try {
    await page.goto(`${base}/gsimaps/?kasc=${KASC_PARAM}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const el = document.getElementById("unsupported");
      return el && el.textContent.includes("3dtiles");
    }, { timeout: 60000 });
    const un = await page.evaluate(() => document.getElementById("unsupported")?.textContent || "");
    const fetched = reqLog.slice(mark).filter(q => q.includes("tileset.json")).length;
    rec("E.gsimaps.unsupported", /3dtiles/.test(un), `未対応警告: ${un.trim()}`);
    rec("E.gsimaps.nofetch", fetched === 0, `tileset.json 未要求(${fetched}回)`);
  } catch (e) {
    rec("E.gsimaps.unsupported", false, `gsimaps: ${String(e).slice(0, 120)}`);
    rec("E.gsimaps.nofetch", false, "未到達");
  }
}

const pass = results.filter(r => r.ok).length;
console.log(`\n${pass}/${results.length} PASS`);
await browser.close();
srv.close();
process.exit(pass === results.length ? 0 : 1);
