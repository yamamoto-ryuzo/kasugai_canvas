// GeoPackage 読み込み Worker。sql.js(SQLite WASM)をメインスレッドの外で動かし、
// .gpkg のダウンロード・SQLite 展開・WKB→GeoJSON デコードを別スレッドで行う。
// 開いた DB は url キーで保持するため、bbox=auto の表示範囲再クエリ・
// ⏷フィルター変更・属性一覧クエリは2回目以降ダウンロード無しで実行できる。
// DuckDB spatial の ST_Read は非COI環境でスレッド生成に失敗するため
// GPKG には使わず、SQLite として直接開く
import { wkbToGeoJsonGeometry, gpkgGeometryToWkb, gpkgGeometryEnvelope, sanitizeVectorPropertyValue, quoteSqlIdent, quoteSqlLiteral } from "./vector-decode.js";

const SQL_JS_VERSION = "1.13.0";
let sqlJsPromise = null;
function loadSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const mod = await import(`https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/+esm`);
      const initSqlJs = mod.default || mod.initSqlJs || mod;
      return initSqlJs({ locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/dist/${file}` });
    })();
    sqlJsPromise.catch(() => { sqlJsPromise = null; });
  }
  return sqlJsPromise;
}

// 開いた DB のキャッシュ(url → Promise<SQL.Database>)。
// ファイル全体のダウンロードは初回のみで、再クエリは開いた DB に対して走る
const dbs = new Map();
async function openDb(url) {
  let promise = dbs.get(url);
  if (!promise) {
    promise = (async () => {
      const SQL = await loadSqlJs();
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new SQL.Database(new Uint8Array(await response.arrayBuffer()));
    })();
    promise.catch(() => { if (dbs.get(url) === promise) dbs.delete(url); });
    dbs.set(url, promise);
  }
  return promise;
}

// 地物テーブルとジオメトリ列を解決する。table 指定が無ければ gpkg_geometry_columns の先頭
function resolveFeatureTable(db, table) {
  let tableName = table || null;
  if (!tableName) {
    const res = db.exec("SELECT table_name FROM gpkg_geometry_columns ORDER BY rowid LIMIT 1");
    tableName = res[0]?.values?.[0]?.[0] || null;
  }
  if (!tableName) throw new Error("地物テーブルが見つかりません");
  const gres = db.exec(`SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ${quoteSqlLiteral(tableName)} LIMIT 1`);
  return { tableName, geomCol: gres[0]?.values?.[0]?.[0] || "geom" };
}

// テーブルの列名一覧(PRAGMA table_info は識別子をバインドできないため quoteSqlIdent で包む)
function tableColumns(db, tableName) {
  const res = db.exec(`PRAGMA table_info(${quoteSqlIdent(tableName)})`);
  return (res[0]?.values || []).map(row => row[1]);
}

// 表示範囲フィルター。sql.js のビルドには rtree モジュールが含まれないため
// GPKG の rtree インデックスは使えず、代わりに GPkgBinary ヘッダのエンベロープ
// (先頭 8B 以降の minx,maxx,miny,maxy double)を各行について読んで JS で判定する。
// エンベロープの読み取りは WKB 全デコードより桁違いに軽い
function envelopeIntersects(env, bbox) {
  if (!env || !bbox) return true; // エンベロープ無しの地物は判定不能のため含める
  const south = Number(bbox.south), north = Number(bbox.north);
  if (!(env.north >= south && env.south <= north)) return false;
  return bbox.ranges.some(r => env.east >= Number(r.west) && env.west <= Number(r.east));
}

// QGIS が「データベースに保存」したスタイル(layer_styles テーブルの QML)。
// useAsDefault=1 を優先、無ければ先頭行。無い GPKG は null
function readEmbeddedQml(db, tableName) {
  try {
    const sres = db.exec(`SELECT styleQML FROM layer_styles WHERE f_table_name = ${quoteSqlLiteral(tableName)} ORDER BY useAsDefault DESC`);
    const qml = sres[0]?.values?.[0]?.[0];
    return typeof qml === "string" && qml.trim() ? qml : null;
  } catch (e) { return null; }
}

// SELECT 文の組み立て。columns は属性列のプルーニング(ジオメトリ列は常に含める)
function buildFeatureSelect({ tableName, geomCol, columns, where, limit }) {
  const cols = Array.isArray(columns) && columns.length ? columns : null;
  const selectCols = cols ? [...cols.map(quoteSqlIdent), quoteSqlIdent(geomCol)].join(", ") : "*";
  const predicates = [];
  if (where) predicates.push(`(${where})`);
  const clauses = [];
  if (predicates.length) clauses.push(`WHERE ${predicates.join(" AND ")}`);
  if (Number.isInteger(limit) && limit > 0) clauses.push(`LIMIT ${Math.floor(limit)}`);
  return `SELECT ${selectCols} FROM ${quoteSqlIdent(tableName)} ${clauses.join(" ")}`;
}

// 地物テーブル → GeoJSON。where=/limit=/columns= は SQL で絞り込み、
// bbox は GPkgBinary エンベロープで JS 判定してからデコードする
async function cmdLoad(msg) {
  const db = await openDb(msg.url);
  const { tableName, geomCol } = resolveFeatureTable(db, msg.table);
  const sql = buildFeatureSelect({ tableName, geomCol, columns: msg.columns, where: msg.where, limit: msg.limit });
  const stmt = db.prepare(sql);
  const colNames = stmt.getColumnNames();
  const features = [];
  while (stmt.step()) {
    const row = stmt.get();
    const rec = {};
    colNames.forEach((c, i) => { rec[c] = row[i]; });
    // bbox=auto: GPkgBinary エンベロープと表示範囲が交差しない地物はデコードしない
    if (msg.bbox && !envelopeIntersects(gpkgGeometryEnvelope(rec[geomCol]), msg.bbox)) continue;
    const wkb = gpkgGeometryToWkb(rec[geomCol]);
    const geometry = wkb ? wkbToGeoJsonGeometry(wkb) : null;
    if (!geometry) continue;
    const properties = {};
    for (const c of colNames) if (c !== geomCol) properties[c] = sanitizeVectorPropertyValue(rec[c]);
    features.push({ type: "Feature", geometry, properties });
  }
  stmt.free();
  // 検索は常に全件対象: bbox で表示が絞られていても where= のヒット数は
  // bbox なしの COUNT(*) で全件として数える(duckdb: と同じ方針)
  let total = null;
  if (msg.bbox && msg.where) {
    try {
      const cres = db.exec(`SELECT COUNT(*) AS n FROM ${quoteSqlIdent(tableName)} WHERE (${msg.where})`);
      total = Number(cres[0]?.values?.[0]?.[0] ?? 0);
    } catch (e) { /* 件数取得は補助情報のため失敗は無視 */ }
  }
  return {
    geojson: { type: "FeatureCollection", features },
    qml: msg.wantStyle ? readEmbeddedQml(db, tableName) : null,
    total,
    count: features.length,
  };
}

// 属性値一覧ウィジェット用: 読み込み済み GeoJSON ではなく DB に直接クエリして
// 全件対象で行を返す(bbox 非適用・where= 適用)。行位置は GPkgBinary エンベロープの中心
async function cmdAttrs(msg) {
  const db = await openDb(msg.url);
  const { tableName, geomCol } = resolveFeatureTable(db, msg.table);
  const allCols = tableColumns(db, tableName);
  const attrCols = (Array.isArray(msg.columns) && msg.columns.length)
    ? msg.columns.filter(name => allCols.includes(name))
    : allCols.filter(name => name !== geomCol);
  const predicates = [];
  if (msg.where) predicates.push(`(${msg.where})`);
  const needle = String(msg.searchText || "").trim();
  if (needle && attrCols.length) {
    const escaped = needle.replace(/[\\%_]/g, m => `\\${m}`);
    const lit = quoteSqlLiteral(`%${escaped}%`);
    predicates.push(`(${attrCols.map(name => `CAST(${quoteSqlIdent(name)} AS TEXT) LIKE ${lit} ESCAPE '\\'`).join(" OR ")})`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const geomExpr = attrCols.length ? `, ${quoteSqlIdent(geomCol)}` : quoteSqlIdent(geomCol);
  const stmt = db.prepare(`SELECT ${attrCols.map(quoteSqlIdent).join(", ")}${geomExpr} FROM ${quoteSqlIdent(tableName)}${where}`);
  const rows = [];
  while (stmt.step()) {
    const row = stmt.get();
    const values = row.slice(0, attrCols.length).map(v => {
      const s = sanitizeVectorPropertyValue(v);
      return s == null ? "" : String(s);
    });
    const env = gpkgGeometryEnvelope(row[attrCols.length]);
    const center = env ? { lat: (env.south + env.north) / 2, lng: (env.west + env.east) / 2 } : null;
    rows.push({ values, lat: center ? center.lat : null, lng: center ? center.lng : null });
  }
  stmt.free();
  return { attributes: attrCols, rows };
}

self.onmessage = async event => {
  const msg = event.data || {};
  const { cmd, reqId } = msg;
  try {
    let result;
    if (cmd === "warm") {
      await loadSqlJs();
      result = {};
    } else if (cmd === "load") {
      result = await cmdLoad(msg);
    } else if (cmd === "attrs") {
      result = await cmdAttrs(msg);
    } else if (cmd === "reset") {
      // プロジェクト/インスペクター変更時に開いた DB をすべて破棄する
      for (const promise of dbs.values()) {
        try { (await promise).close(); } catch (e) { /* ignore */ }
      }
      dbs.clear();
      result = {};
    } else {
      throw new Error(`不明なコマンド: ${cmd}`);
    }
    self.postMessage({ reqId, ...result });
  } catch (error) {
    self.postMessage({ reqId, error: error instanceof Error ? error.message : String(error) });
  }
};
