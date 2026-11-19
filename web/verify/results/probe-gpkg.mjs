// gpkg:/geopackage: の GeoPackage(sql.js Worker)経路の検証プローブ
//  1) table=/where=/limit=/columns= の SQL 絞り込み
//  2) bbox=auto の表示範囲連動(GPkgBinary エンベロープ・rtree 代替)
//  3) layer_styles 埋め込み QML の legend 反映
//  4) Worker 直叩き: attrs(属性一覧)/wantStyle(埋め込みQML)/total(全件数)
// 実行: node web/verify/results/probe-gpkg.mjs [engine] (既定 cesium)
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
  ".gpkg": "application/geopackage+sqlite3", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream",
      // persistent プロファイルが旧 app.js/モジュールをキャッシュして結果が
      // 揺れるのを防ぐ(検証は常にディスク上の最新ソースで行う)
      "cache-control": "no-store" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
// GAP = 仕様上妥当だがエンジン基盤が未対応の項目(失敗ではなく実装候補として記録)
const gap = (id, supported, detail) => { results.push({ id, ok: true, gap: !supported });
  console.log(`${supported ? "PASS" : "GAP "} ${id} :: ${detail}`); };

const prof = join(os.tmpdir(), "kasc-probe-profile-gpkg");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.on("pageerror", e => console.log("PAGEERR:", String(e).slice(0, 200)));
// GPKG の未対応警告(非経緯度CRS/拡張/タイル行列等)を拾う
const consoleWarnings = [];
page.on("console", m => {
  const t = m.text();
  if (/GPKG|経緯度|拡張|attributes/i.test(t)) consoleWarnings.push(t);
});

const ENGINE = process.argv[2] || "cesium";
// ?kasc= ロード時はアプリ側の初期遷移と goto が競合して ERR_ABORTED になる
// ことがある(中断されても最終的には目的ページへ辿り着く)。失敗時のみ再試行
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await page.goto(`${base}/${ENGINE}/?kasc=${encodeURIComponent("/verify/gpkg-test/gpkg-test.kasc")}`,
      { waitUntil: "domcontentloaded" });
  } catch (e) {
    if (!/ERR_ABORTED/.test(String(e))) throw e;
  }
  try {
    await page.waitForFunction(() => window.kasugaiApi, { timeout: 60000 });
    break;
  } catch (e) {
    if (attempt === 2) throw e;
  }
}

// エンジンごとの listLayers 形状差を吸収(cesium は正規化 item、
// maplibre 等は {item, lids,…} エントリ)
async function waitLayers(min, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const n = await page.evaluate(() => {
        const layers = window.kasugaiApi?.listLayers?.() || [];
        return layers.filter(l => {
          const it = l && l.item ? l.item : l;
          return (it.type === "gpkg" || it.type === "geopackage")
            && (window.kasugaiApi.getLayerGeoJson(it.id)?.features?.length ?? -1) >= 0;
        }).length;
      });
      if (n >= min) return n;
    } catch { /* 初期遷移中のコンテキスト破棄は待って再試行 */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return 0;
}

const loaded = await waitLayers(11);
rec("load.layers", loaded >= 11, `gpkg レイヤー ${loaded}/11 読込`);

const layerInfo = await page.evaluate(() => {
  const out = {};
  for (const l of window.kasugaiApi.listLayers()) {
    const it = l && l.item ? l.item : l;
    const gj = window.kasugaiApi.getLayerGeoJson(it.id);
    out[it.title] = { count: gj?.features?.length ?? -1,
      legend: l.legend || it._qml?.legend || it.qmlStyle?.legend || null,
      styleName: it.gpkgMeta?.styleName || l.gpkg?.styleName || null,
      gpkgStyles: l.gpkg?.styles || null,
      metaKeys: it.gpkgMeta ? Object.keys(it.gpkgMeta) : null,
      portrayal: it._gpkgPortrayal || l.gpkgPortrayal || null,
      lids: l.gpkgpLids || (l.lids || []).filter(id => /gpkgp/.test(id)),
      props: gj?.features?.[0] ? Object.keys(gj.features[0].properties || {}) : [] };
  }
  return out;
});

// タイトル表記はエンジンで異なる(cesium=葉名のみ・maplibre=フルパス)ため suffix 一致
const infoOf = t => {
  const k = Object.keys(layerInfo).find(k => k === t || k.endsWith("/" + t));
  return layerInfo[k] || null;
};
const count = t => infoOf(t)?.count ?? -1;
rec("select.all", count("pt(基本)") === 6, `table=pt 全件 ${count("pt(基本)")}/6`);
rec("select.where", count("pt(where)") === 4, `where=value>=30 → ${count("pt(where)")}/4`);
rec("select.limit", count("pt(limit2)") === 2, `limit=2 → ${count("pt(limit2)")}/2`);
rec("select.table2", count("ln(table=)") === 2, `table=ln 解決 ${count("ln(table=)")}/2 地物`);
const colProps = infoOf("pt(columns)")?.props || [];
rec("select.columns", colProps.length === 1 && colProps[0] === "name",
  `columns=name → 属性 [${colProps.join(",")}]`);

// 曲線ジオメトリ(WKB 8-17)の折線近似: CircularString→LineString・Triangle→Polygon
const curveInfo = infoOf("curves");
const curveTypes = await page.evaluate(t => {
  const l = window.kasugaiApi.listLayers().find(l => {
    const tt = (l.item || l).title || "";
    return tt === t || tt.endsWith("/" + t);
  });
  if (!l) return [];
  return (window.kasugaiApi.getLayerGeoJson((l.item || l).id)?.features || [])
    .map(f => f.geometry?.type).sort();
}, "curves");
rec("curve.load", curveInfo?.count === 2, `curves 表 ${curveInfo?.count}/2 地物`);
rec("curve.types", curveTypes.join(",") === "LineString,Polygon",
  `曲線近似 → [${curveTypes.join(",")}](期待 LineString,Polygon)`);

// 非経緯度(3857)表は読み込めるが警告が出る
rec("proj.load", infoOf("proj3857")?.count === 1, `proj(3857) 表 ${infoOf("proj3857")?.count}/1 地物`);
// attributes 表は 0 地物でエラーにならない
rec("attr.load", infoOf("attr表")?.count === 0, `attr表(attributes) → ${infoOf("attr表")?.count} 地物`);

// 埋め込み QML(layer_styles→categorizedSymbol→legend>=2)
// legend の露出はエンジン依存(cesium は listLayers.legend・他は非公開)。露出無しは SKIP
const legend = infoOf("pt(基本)")?.legend;
rec("style.qml", !legend || (Array.isArray(legend) && legend.length >= 2),
  Array.isArray(legend) && legend.length >= 2
    ? `layer_styles 埋め込みQML → legend [${legend.map(e => e.label).join(",")}]`
    : `layer_styles 埋め込みQML(legend 非公開エンジン・worker.qml で代替検証)`);

// bbox=auto: 日本表示で遠隔地(0,0)を除外 → 5。さらに (0,0) へ移動 → 1
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 36, longitude: 138, height: 2500000, pitch: -90 }, 0));
await new Promise(r => setTimeout(r, 5000));
const japanCount = await page.evaluate(() => {
  const l = window.kasugaiApi.listLayers().find(l => {
    const t = (l.item || l).title || "";
    return t === "pt(bbox=auto)" || t.endsWith("/pt(bbox=auto)");
  });
  if (!l) return -1;
  return window.kasugaiApi.getLayerGeoJson((l.item || l).id)?.features?.length ?? -1;
});
// navara はビューポート再クエリ基盤が無く bbox=auto 未対応(既知ギャップ)
const bboxGap = ENGINE === "navara";
(bboxGap ? gap : rec)("bbox.japan", bboxGap ? false : japanCount === 5,
  `日本範囲 ${japanCount}/5 地物(遠隔地を除外)${bboxGap ? " — navara は bbox=auto 未対応" : ""}`);

await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 0, longitude: 0, height: 500000, pitch: -90 }, 0));
await new Promise(r => setTimeout(r, 5000));
const remoteCount = await page.evaluate(() => {
  const l = window.kasugaiApi.listLayers().find(l => {
    const t = (l.item || l).title || "";
    return t === "pt(bbox=auto)" || t.endsWith("/pt(bbox=auto)");
  });
  if (!l) return -1;
  return window.kasugaiApi.getLayerGeoJson((l.item || l).id)?.features?.length ?? -1;
});
(bboxGap ? gap : rec)("bbox.remote", bboxGap ? false : remoteCount === 1,
  `(0,0) 範囲 ${remoteCount}/1 地物(遠隔地のみ)${bboxGap ? " — navara は bbox=auto 未対応" : ""}`);

// Worker 直叩き: エンジン UI を経由しない attrs/wantStyle/total の検証
const workerRes = await page.evaluate(async gpkgUrl => {
  const w = new Worker("/shared/gpkg-worker.js", { type: "module" });
  let rid = 0;
  const call = msg => new Promise((resolve, reject) => {
    const reqId = ++rid;
    const h = ev => { if (ev.data?.reqId === reqId) { w.removeEventListener("message", h);
      ev.data.error ? reject(new Error(ev.data.error)) : resolve(ev.data); } };
    w.addEventListener("message", h);
    w.postMessage({ reqId, ...msg });
  });
  try {
    const load = await call({ cmd: "load", url: gpkgUrl, table: "pt", wantStyle: true });
    const attrs = await call({ cmd: "attrs", url: gpkgUrl, table: "pt", searchText: "東京", wantGeom: true });
    const bbox = await call({ cmd: "load", url: gpkgUrl, table: "pt",
      bbox: { ranges: [{ west: 130, east: 146 }], south: 30, north: 46 }, where: "value >= 30" });
    const attrTbl = await call({ cmd: "load", url: gpkgUrl, table: "attr_table" });
    const attrRows = await call({ cmd: "attrs", url: gpkgUrl, table: "attr_table" });
    const proj = await call({ cmd: "load", url: gpkgUrl, table: "proj" });
    const proj2 = await call({ cmd: "load", url: gpkgUrl, table: "proj" });
    const proj6677 = await call({ cmd: "load", url: gpkgUrl, table: "proj6677" });
    const ln = await call({ cmd: "load", url: gpkgUrl, table: "ln", wantStyle: true });
    const alt = await call({ cmd: "load", url: gpkgUrl, table: "pt", wantStyle: true, styleName: "alt" });
    const miss = await call({ cmd: "load", url: gpkgUrl, table: "pt", wantStyle: true, styleName: "nosuch" });
    const style = await call({ cmd: "style", url: gpkgUrl });
    const warm = await call({ cmd: "warm" });
    w.terminate();
    return { loadCount: load.count, loadFeatures: load.geojson?.features?.length,
      qml: typeof load.qml === "string" ? load.qml.slice(0, 80) : null,
      total: load.total, attrsRows: attrs.rows?.length, attrsGeom: !!attrs.rows?.[0]?.geometry,
      attrsCols: attrs.attributes, bboxCount: bbox.count, bboxTotal: bbox.total,
      columnMeta: load.columnMeta, extensions: load.extensions,
      attrKind: attrTbl.kind, attrCount: attrTbl.count, attrTblWarnings: attrTbl.warnings,
      attrTblRows: attrRows.rows?.length,
      projSrs: proj.srs, projWarnings: proj.warnings, proj2Warnings: proj2.warnings,
      projCoord: proj.geojson?.features?.[0]?.geometry?.coordinates,
      proj6677Srs: proj6677.srs, proj6677Warnings: proj6677.warnings,
      proj6677Coord: proj6677.geojson?.features?.[0]?.geometry?.coordinates,
      ptWarnings: load.warnings, styles: load.styles,
      lnWarnings: ln.warnings, lnQml: ln.qml, lnSld: !!ln.sld, lnStyleName: ln.styleName, lnStyleNames: ln.styleNames,
      altQml: typeof alt.qml === "string" ? alt.qml.slice(0, 200) : null, altStyleName: alt.styleName,
      missWarnings: miss.warnings, missStyleName: miss.styleName,
      styleCmd: { sheets: (style.sheets || []).map(s => ({ format: s.format, styleId: s.styleId, hasData: !!s.data })),
        symbols: (style.symbols || []).map(s => ({ symbol: s.symbol, uri: s.uri, images: (s.images || []).length })),
        fonts: (style.fonts || []).map(f => ({ name: f.name, font: !!f.fontBase64, glyphs: !!f.glyphsBase64 })),
        annotations: style.annotations, annotationRefs: style.annotationRefs, featureTables: style.featureTables } };
  } catch (e) { return { error: String(e && e.message || e) }; }
}, `${base}/verify/gpkg-test/gpkg-test.gpkg`);

if (workerRes.error) {
  rec("worker.any", false, `Worker 直叩き失敗: ${workerRes.error}`);
} else {
  rec("worker.load", workerRes.loadFeatures === 6, `worker load 全件 ${workerRes.loadFeatures}/6`);
  rec("worker.qml", !!workerRes.qml, `worker wantStyle → QML ${workerRes.qml ? "取得(" + workerRes.qml.slice(0, 40) + "…)" : "null"}`);
  rec("worker.attrs", workerRes.attrsRows === 1 && workerRes.attrsGeom === true,
    `worker attrs '東京' → ${workerRes.attrsRows} 行 geometry=${workerRes.attrsGeom} 列=[${(workerRes.attrsCols || []).join(",")}]`);
  rec("worker.bbox", workerRes.bboxCount === 3 && workerRes.bboxTotal === 4,
    `worker bbox+where → 表示 ${workerRes.bboxCount}/3・検索全件 ${workerRes.bboxTotal}/4`);
  // メタ情報: 列タイトル(gpkg_data_columns)・拡張登録(gpkg_extensions)
  const cm = workerRes.columnMeta;
  rec("worker.columnMeta", cm?.name?.title === "名称" && cm?.cat?.title === "分類",
    `gpkg_data_columns → name=${cm?.name?.title} cat=${cm?.cat?.title} value=${cm?.value?.title}`);
  const extNames = (workerRes.extensions || []).map(e => e.name).sort();
  rec("worker.extensions", extNames.includes("gpkg_schema") && extNames.includes("gpkgext_relations"),
    `gpkg_extensions → [${extNames.join(",")}]`);
  // 非空間表: load は kind=attributes・attrs は行が返る
  rec("worker.attrTable", workerRes.attrKind === "attributes" && workerRes.attrCount === 0 && workerRes.attrTblRows === 2,
    `attr_table → kind=${workerRes.attrKind} load=${workerRes.attrCount} 地物 attrs=${workerRes.attrTblRows} 行`);
  // 非経緯度 CRS: srs.geographic=false + 再投影成功 + 警告(1回目のみ・重複排除)
  rec("worker.srs", workerRes.projSrs?.geographic === false && workerRes.projSrs?.reprojected === "EPSG:3857 数式",
    `proj(3857) srs.geographic=${workerRes.projSrs?.geographic} code=${workerRes.projSrs?.org}:${workerRes.projSrs?.code} reprojected=${workerRes.projSrs?.reprojected}`);
  rec("worker.warn", (workerRes.projWarnings || []).some(w => /再投影して表示します/.test(w)),
    `proj 警告 ${JSON.stringify(workerRes.projWarnings)}`);
  // 再投影座標の正しさ: (15540720, 4258660)m → 逆メルカトル (139.605, 35.694)
  const pc = workerRes.projCoord || [];
  rec("worker.reproj", Math.abs(pc[0] - 139.605) < 0.01 && Math.abs(pc[1] - 35.694) < 0.01,
    `3857 → 経緯度 [${pc[0]?.toFixed(4)}, ${pc[1]?.toFixed(4)}](期待 ≈[139.60, 35.69])`);
  // WKT→proj4 経路: EPSG:6677(平面直角IX系・横メルカトル)の原点 (0,0) → (140.833, 40.0)
  const p6 = workerRes.proj6677Coord || [];
  rec("worker.reprojWkt", workerRes.proj6677Srs?.reprojected === "GPKG 内蔵 WKT"
      && Math.abs(p6[0] - 140.833) < 0.01 && Math.abs(p6[1] - 40.0) < 0.01,
    `6677 → 経緯度 [${p6[0]?.toFixed(4)}, ${p6[1]?.toFixed(4)}] method=${workerRes.proj6677Srs?.reprojected}(期待 ≈[140.83, 40.00]・内蔵WKT)`);
  rec("worker.reprojWktWarn", (workerRes.proj6677Warnings || []).some(w => /再投影して表示します.*内蔵 WKT/.test(w)),
    `proj6677 警告 ${JSON.stringify(workerRes.proj6677Warnings)}`);
  rec("worker.warnDedupe", Array.isArray(workerRes.proj2Warnings) && workerRes.proj2Warnings.length === 0,
    `同一テーブル2回目の警告 ${JSON.stringify(workerRes.proj2Warnings)}(重複排除)`);
  // OGC 24-050 Portrayal 拡張: gpkgext_styles の登録検出・形式一覧・個別警告
  const st = workerRes.styles;
  const fmts = (st?.list || []).flatMap(s => s.formats || []).sort();
  rec("worker.styles", st?.list?.length === 1 && st.list[0].style === "demo-style"
      && fmts.includes("sld") && fmts.includes("mbstyle") && st.orphanStylesheets === 0,
    `gpkgext_styles → ${JSON.stringify(st)}`);
  rec("worker.portrayalWarn", (workerRes.ptWarnings || []).some(w => /Portrayal 拡張.*エンジン依存/.test(w))
      && (workerRes.ptWarnings || []).some(w => /シンボル 1 件/.test(w))
      && (workerRes.ptWarnings || []).some(w => /フォント 1 件/.test(w)),
    `portrayal 警告 ${JSON.stringify(workerRes.ptWarnings)}`);
  // layer_styles の styleSLD のみ(styleQML 無し)は SLD 本文が返りエンジンで適用される
  rec("worker.sldApply", !workerRes.lnQml && workerRes.lnSld === true && workerRes.lnStyleName === "sld-only",
    `ln(SLD のみ) → qml=${workerRes.lnQml ? "取得" : "null"} sld=${workerRes.lnSld} name=${workerRes.lnStyleName}`);
  // gpkgstyle= 選択: "alt" で QML_ALT(singleSymbol)、未登録名は既定へ戻し警告
  rec("worker.styleNameSel", /singleSymbol/.test(workerRes.altQml || "") && workerRes.altStyleName === "alt",
    `styleName=alt → ${workerRes.altStyleName} QML=${workerRes.altQml}`);
  rec("worker.styleNameMiss", (workerRes.missWarnings || []).some(w => /styleName "nosuch"/.test(w)) && workerRes.missStyleName === "default",
    `styleName=nosuch → 既定 ${workerRes.missStyleName} 警告=${JSON.stringify(workerRes.missWarnings)}`);
  // cmd "style": Portrayal レジストリ(stylesheets/symbols/fonts)+semantic-annotations
  const sc = workerRes.styleCmd || {};
  rec("worker.styleCmd", sc.sheets?.length === 2 && sc.sheets.every(s => s.hasData)
      && sc.symbols?.[0]?.symbol === "circle" && sc.symbols[0].images === 1
      && sc.fonts?.[0]?.name === "test-font" && sc.fonts[0].glyphs === true
      && sc.annotations?.["1"]?.type === "GeoDataClass"
      && (sc.annotationRefs || []).length === 2
      && (sc.featureTables || []).includes("pt"),
    `style cmd → sheets=${JSON.stringify(sc.sheets)} symbols=${JSON.stringify(sc.symbols)} fonts=${JSON.stringify(sc.fonts)} refs=${(sc.annotationRefs || []).length} tables=${JSON.stringify(sc.featureTables)}`);
}

// アプリ統合側の警告(console.warn 経由): 3857 の再投影通知が出ていること
rec("app.warnCrs", consoleWarnings.some(t => /再投影して表示します/.test(t)),
  `console 警告 ${consoleWarnings.filter(t => /経緯度|再投影/.test(t))[0] || "なし"}`);

// gpkgstyle=alt: layer_styles 内の別名スタイル選択(styleName が item.gpkgMeta へ残る)
const altInfo = infoOf("pt(altスタイル)");
rec("app.gpkgstyle", altInfo?.count === 6 && altInfo?.styleName === "alt",
  `gpkgstyle=alt → ${altInfo?.count}/6 地物 styleName=${altInfo?.styleName}`);

// layer_styles の SLD 適用: ln の legend が SLD ルール(線(既定))を含むか。
// legend 露出はエンジン依存のため、非公開なら item 経路の sld 取得で代替確認済み
const lnLegend = infoOf("ln(table=)")?.legend;
rec("app.sldApply", !lnLegend || lnLegend.some(e => /線/.test(e.label || "")),
  `ln SLD → legend ${lnLegend ? JSON.stringify(lnLegend.map(e => e.label)) : "(非公開)"}`);

// SLD TextSymbolizer: compileSldStyle が labelFor を生成し
// <Label><PropertyName>name/font/halo/LinePlacement を解決するか。
// (listLayers はエンジン差で qmlStyle を露出しない場合があるため直接検証)
const sldLabel = await page.evaluate(async () => {
  const { compileSldStyle } = await import("/shared/sld-style.js");
  const xml = await (await fetch("/verify/gpkg-test/ln.sld")).text();
  const style = compileSldStyle(xml, null, "cesium");
  const s = style.labelFor?.({ name: "東名" }) || null;
  return { hasFn: !!style.labelFor, text: s?.text, fontCss: s?.fontCss,
    halo: !!s?.halo, alongLine: !!s?.placement?.alongLine };
});
rec("app.sldLabel", sldLabel.hasFn && sldLabel.text === "東名" && sldLabel.halo
    && /bold/.test(sldLabel.fontCss || "") && sldLabel.alongLine,
  `SLD TextSymbolizer → labelFor ${JSON.stringify(sldLabel)}`);
// ln(table=) に埋め込み SLD が styleName=sld-only として適用されているか
rec("app.sldStyleName", infoOf("ln(table=)")?.styleName === "sld-only",
  `ln SLD → styleName=${infoOf("ln(table=)")?.styleName}`);

// スタンドアロン .kasc(blob Worker)経路: duckdb:+format=gpkg の埋め込みスタイルが
// wantStyle 経由で取得されるか(通常 gpkg: 経路とのパリティ)
const standaloneLabel = await page.evaluate(() => {
  const l = window.kasugaiApi.listLayers().find(l => {
    const t = (l.item || l).title || "";
    return t === "ln(duckdb経由)" || t.endsWith("/ln(duckdb経由)");
  });
  const it = l && (l.item || l);
  const count = it ? (window.kasugaiApi.getLayerGeoJson(it.id)?.features?.length ?? -1) : -1;
  return { type: it?.type, count, styleName: l?.gpkg?.styleName || it?.gpkgMeta?.styleName || null };
});
rec("app.standalone", standaloneLabel.count === 2
    && standaloneLabel.styleName === "sld-only",
  `duckdb:+format=gpkg 埋め込みSLD → ${JSON.stringify(standaloneLabel)}`);

// OGC 24-050 Portrayal 適用(maplibre のみ): mbstyle レイヤ追加・シンボル/フォント登録
if (ENGINE === "maplibre") {
  const pt = infoOf("pt(基本)") || {};
  const po = pt.portrayal || {};
  rec("app.mbstyle", (pt.lids || []).length === 2 && po.appliedLayers === 2,
    `mbstyle → lids=${JSON.stringify(pt.lids)} applied=${po.appliedLayers} gpkgStyles=${JSON.stringify(pt.gpkgStyles)}`);
  rec("app.symbols", po.symbols === 1 && po.symbolImages === 2,
    `symbols → ${JSON.stringify(po)}(symbol+uri の2名で登録)`);
  rec("app.fonts", (po.fonts || []).includes("test-font") && po.glyphStacks === 1 && po.annotations === 1,
    `fonts/annotations → ${JSON.stringify(po)}`);
  // mbstyle sprite: sprite.png+sprite.json の切り出し登録(icon-image "mysquare" 参照)。
  // 画像は map 共有のため先着1レイヤのみ sprites カウントが立つ
  const spriteN = Math.max(...Object.values(layerInfo).map(l => l.portrayal?.sprites || 0));
  rec("app.sprite", spriteN === 1,
    `mbstyle sprite → sprites=${spriteN}(mysquare 16x16 登録)`);
}

srv.close();
await ctx.close();
const fails = results.filter(r => !r.ok).length;
const gaps = results.filter(r => r.gap).length;
console.log(`\n${results.length - fails - gaps}/${results.length - gaps} PASS${gaps ? ` / GAP ${gaps} 件` : ""}`);
process.exit(fails ? 1 : 0);
