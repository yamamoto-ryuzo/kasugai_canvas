// GeoPackage 経路の Node 単体検証(ブラウザ不要)
//  1) sql.js(ピン版)の SQLite バージョン・有効モジュールを列挙
//  2) 「sql.js に rtree 無し→GPkgBinary エンベロープ代替」の設計前提を再検証
//  3) 合成 .gpkg フィクスチャを開き、gpkg-worker.js と同じ SQL を実行
// 使い方: node web/verify/results/probe-gpkg-node.cjs
const fs = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..", "..", "..");
const TMP = path.join(ROOT, ".testtmp", "gpkg");
const FIXTURE = path.join(ROOT, "web", "verify", "gpkg-test", "gpkg-test.gpkg");
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

// gpkg-worker.js / kasc_loader.js の SQL_JS_VERSION ピンを読み取る
function pinnedVersion() {
  const a = fs.readFileSync(path.join(ROOT, "web", "shared", "gpkg-worker.js"), "utf8");
  const b = fs.readFileSync(path.join(ROOT, "web", "shared", "kasc_loader.js"), "utf8");
  const va = /SQL_JS_VERSION\s*=\s*"([^"]+)"/.exec(a)?.[1];
  const vb = /SQL_JS_VERSION\s*=\s*"([^"]+)"/.exec(b)?.[1];
  return { va, vb };
}

async function ensureSqlJs(version) {
  fs.mkdirSync(TMP, { recursive: true });
  for (const name of ["sql-wasm.js", "sql-wasm.wasm"]) {
    const fp = path.join(TMP, `${version}-${name}`);
    if (!fs.existsSync(fp)) {
      const res = await fetch(`https://cdn.jsdelivr.net/npm/sql.js@${version}/dist/${name}`);
      if (!res.ok) throw new Error(`sql.js DL 失敗 ${name}: HTTP ${res.status}`);
      fs.writeFileSync(fp, Buffer.from(await res.arrayBuffer()));
    }
  }
  const initSqlJs = require(path.join(TMP, `${version}-sql-wasm.js`));
  return initSqlJs({ locateFile: () => path.join(TMP, `${version}-sql-wasm.wasm`) });
}

(async () => {
  const { va, vb } = pinnedVersion();
  rec("pin.sync", va === vb, `SQL_JS_VERSION: worker=${va} / kasc_loader=${vb}`);
  // npm 最新版との照合。供給網対策として「公開から7日未満の新版は採用しない」
  // 運用のため、比較対象は公開7日以上が経過した最新版(採用候補版)とする
  const reg = await (await fetch("https://registry.npmjs.org/sql.js")).json().catch(() => null);
  const latestVer = reg?.["dist-tags"]?.latest;
  let eligible = null;
  if (reg?.time) {
    const cutoff = Date.now() - 7 * 86400e3;
    for (const [v, t] of Object.entries(reg.time)) {
      if (v === "created" || v === "modified") continue;
      if (new Date(t).getTime() <= cutoff && (!eligible || new Date(t) > new Date(reg.time[eligible]))) eligible = v;
    }
  }
  rec("pin.latest", !eligible || va === eligible,
    `npm 最新=${latestVer}(採用候補=${eligible || "?"}:7日ルール) vs ピン=${va}`);

  const SQL = await ensureSqlJs(va);
  const probe = new SQL.Database();
  const sqliteVer = probe.exec("SELECT sqlite_version()")[0].values[0][0];
  const opts = probe.exec("PRAGMA compile_options")[0].values.map(r => r[0]);
  console.log("sqlite_version:", sqliteVer);
  console.log("compile_options:", opts.join(", "));
  rec("lib.rtree", !opts.includes("ENABLE_RTREE"),
    `compile_options に ENABLE_RTREE ${opts.includes("ENABLE_RTREE") ? "あり" : "無し"}(エンベロープ代替設計の前提)`);

  const db = new SQL.Database(fs.readFileSync(FIXTURE));
  // gpkg-worker.js resolveFeatureTable と同じ SQL
  const tables = db.exec("SELECT table_name FROM gpkg_geometry_columns ORDER BY rowid")[0].values.map(r => r[0]);
  rec("fixture.tables", tables.length === 5 && tables[0] === "pt" && !tables.includes("attr_table"),
    `gpkg_geometry_columns → [${tables.join(",")}]`);
  const cnt = db.exec("SELECT COUNT(*) FROM pt")[0].values[0][0];
  rec("fixture.rows", cnt === 6, `pt 行数 ${cnt}/6`);

  // rtree 影響表は実在するが仮想表としては解決できないはず(sql.js にモジュール無し)
  let rtreeErr = null;
  try { db.exec("SELECT id FROM rtree_pt_geom LIMIT 1"); } catch (e) { rtreeErr = String(e.message || e); }
  rec("lib.rtree.query", !!rtreeErr, `rtree_pt_geom クエリ → ${rtreeErr || "成功(要設計見直し)"}`);

  // GPkgBinary デコード: マジック・エンベロープ・WKB オフセット
  const blob = db.exec("SELECT geom FROM pt WHERE name = '東京'")[0].values[0][0];
  const bytes = new Uint8Array(blob);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const okMagic = bytes[0] === 0x47 && bytes[1] === 0x50;
  const envType = (bytes[3] >> 1) & 0x07;
  const srsId = view.getUint32(4, true);
  const env = [8, 16, 24, 32].map(o => view.getFloat64(o, true));
  rec("bin.header", okMagic && envType === 1 && srsId === 4326,
    `GPkgBinary: magic=${okMagic} envType=${envType} srs_id=${srsId} env=[${env.map(v => v.toFixed(2)).join(",")}]`);

  // WKB は 8+32=40 バイト目の 1(エンディアン)+4(型)から始まる
  const wkbActual = view.getUint32(41, true);
  rec("bin.wkb", wkbActual === 1, `WKB オフセット40の型=${wkbActual}(POINT=1)`);

  // 曲線ジオメトリ(WKB 8-17)の折線近似: vector-decode.js を直接検証
  const { wkbToGeoJsonGeometry, gpkgGeometryToWkb } =
    await import("file:///" + path.join(ROOT, "web", "shared", "vector-decode.js").replace(/\\/g, "/"));
  const curveBlob = new Uint8Array(db.exec("SELECT geom FROM curves WHERE name = '円弧'")[0].values[0][0]);
  const curveWkb = gpkgGeometryToWkb(curveBlob);
  const curveGeom = wkbToGeoJsonGeometry(curveWkb);
  rec("curve.circular", curveGeom?.type === "LineString" && curveGeom.coordinates.length > 3,
    `CircularString → ${curveGeom?.type} ${curveGeom?.coordinates?.length} 点(円弧近似)`);
  const triBlob = new Uint8Array(db.exec("SELECT geom FROM curves WHERE name = '三角'")[0].values[0][0]);
  const triGeom = wkbToGeoJsonGeometry(gpkgGeometryToWkb(triBlob));
  rec("curve.triangle", triGeom?.type === "Polygon" && triGeom.coordinates?.[0]?.length === 4,
    `Triangle → ${triGeom?.type} ${triGeom?.coordinates?.[0]?.length} 点リング`);
  // 円弧近似の幾何妥当性: 中間点が 3 制御点を通る円上にあるか
  if (curveGeom?.type === "LineString") {
    const pts = curveGeom.coordinates;
    const [ax, ay] = pts[0], [bx, by] = pts[Math.floor(pts.length / 2)], [cx, cy] = pts[pts.length - 1];
    // (135,34)-(136,36)-(137,34) を通る円の中心は (136, 34.5)・r≈1.803
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    const mid = pts[Math.floor(pts.length / 4)];
    const rOut = Math.hypot(mid[0] - ux, mid[1] - uy);
    const rExp = Math.hypot(ax - ux, ay - uy);
    rec("curve.arcFit", Math.abs(rOut - rExp) < 1e-6,
      `円弧近似点が同一円上 |r-r'|=${Math.abs(rOut - rExp).toExponential(2)}`);
  }
  // 非経緯度(3857)の srs_id が GPkgBinary ヘッダから読める
  const projBlob = new Uint8Array(db.exec("SELECT geom FROM proj LIMIT 1")[0].values[0][0]);
  const projSrs = new DataView(projBlob.buffer).getUint32(4, true);
  rec("srs.proj", projSrs === 3857, `proj 表 srs_id=${projSrs}(3857・非経緯度)`);

  // OGC 24-050 Portrayal 拡張(ドラフト)テーブル群 + layer_styles の SLD 行
  const styleTables = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gpkgext_%' ORDER BY name"
  )[0].values.map(r => r[0]);
  const expectStyle = ["gpkgext_fonts", "gpkgext_sa_reference", "gpkgext_semantic_annotations",
    "gpkgext_styles", "gpkgext_stylesheets", "gpkgext_symbol_content", "gpkgext_symbol_images", "gpkgext_symbols"];
  rec("fixture.portrayal", expectStyle.every(t => styleTables.includes(t)),
    `gpkgext_* 表 [${styleTables.join(",")}]`);
  const sheetFmts = db.exec("SELECT format FROM gpkgext_stylesheets ORDER BY format")[0].values.map(r => r[0]);
  rec("fixture.stylesheets", sheetFmts.includes("sld") && sheetFmts.includes("mbstyle"),
    `gpkgext_stylesheets formats=[${sheetFmts.join(",")}]`);
  const sldOnly = db.exec("SELECT COUNT(*) FROM layer_styles WHERE f_table_name='ln' AND styleQML IS NULL AND styleSLD IS NOT NULL")[0].values[0][0];
  rec("fixture.sldOnly", sldOnly === 1, `ln の SLD のみスタイル ${sldOnly} 行`);

  const fails = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} PASS`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("FATAL:", e); process.exit(1); });
