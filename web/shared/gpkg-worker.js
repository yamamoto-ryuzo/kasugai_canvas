// GeoPackage 読み込み Worker。sql.js(SQLite WASM)をメインスレッドの外で動かし、
// .gpkg のダウンロード・SQLite 展開・WKB→GeoJSON デコードを別スレッドで行う。
// 開いた DB は url キーで保持するため、bbox=auto の表示範囲再クエリ・
// ⏷フィルター変更・属性一覧クエリは2回目以降ダウンロード無しで実行できる。
// DuckDB spatial の ST_Read は非COI環境でスレッド生成に失敗するため
// GPKG には使わず、SQLite として直接開く
import { wkbToGeoJsonGeometry, gpkgGeometryToWkb, gpkgGeometryEnvelope, geoJsonGeometryEnvelope, sanitizeVectorPropertyValue, quoteSqlIdent, quoteSqlLiteral, transformGeoJsonGeometry, transformEnvelope } from "./vector-decode.js";

const SQL_JS_VERSION = "1.16.0";
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

// 再投影用。geotiff-layer.js と同じピン。非経緯度 CRS の GPKG が出た時だけ遅延ロード
const PROJ4_VERSION = "2.23.0";
let proj4Promise = null;
function loadProj4() {
  if (!proj4Promise) {
    proj4Promise = (async () => {
      const mod = await import(`https://cdn.jsdelivr.net/npm/proj4@${PROJ4_VERSION}/+esm`);
      return mod.default || mod.proj4 || mod;
    })();
    proj4Promise.catch(() => { proj4Promise = null; });
  }
  return proj4Promise;
}

// 投影座標 → WGS84(経緯度) の変換関数を解決する。
// 優先順位(速い順): EPSG:3857 数式 → GPKG 内蔵 WKT を proj4 が解釈 → epsg.io の
// proj4 定義。解決不能なら null(呼び出し側で従来の「位置ずれ」警告を出す)。
// url|srsId 単位でキャッシュする
const transforms = new Map();
function mercatorToLonLat(x, y) {
  const R = 6378137;
  return [x / R * 180 / Math.PI, (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * 180 / Math.PI];
}
async function buildTransform(entry, srsId) {
  if (!entry || isGeographicSrs(entry, srsId) !== false) return null;
  if (entry.code === 3857 || srsId === 3857) {
    return { fn: mercatorToLonLat, method: "EPSG:3857 数式" };
  }
  // GPKG 内蔵 WKT。proj4js は PROJCS(WKT1)/PROJCRS(WKT2 一部)を解釈できる
  for (const wkt of [entry.definition, entry.definition12]) {
    const s = String(wkt || "").trim();
    if (!s || s.toLowerCase() === "undefined") continue;
    try {
      const proj4 = await loadProj4();
      const name = `GPKG${srsId}`;
      proj4.defs(name, s);
      // 解釈可否の試行変換。パース成功でも変換不能(Mercator_1SP の球体解釈等)で
      // NaN になる WKT があるため非ゼロ点で有限値まで確認する
      const t = proj4(name, "EPSG:4326", [1000, 1000]);
      if (!Number.isFinite(t[0]) || !Number.isFinite(t[1])) throw new Error("非有限の変換結果");
      return { fn: (x, y) => proj4(name, "EPSG:4326", [x, y]), method: "GPKG 内蔵 WKT" };
    } catch (e) { /* 次の定義を試す */ }
  }
  // epsg.io の proj4 定義(organization が EPSG の場合のみ)
  if (/^EPSG$/i.test(String(entry.org || "")) && Number.isFinite(entry.code) && entry.code > 0) {
    try {
      const proj4 = await loadProj4();
      const res = await fetch(`https://epsg.io/${entry.code}.proj4`);
      if (res.ok) {
        proj4.defs(`EPSG:${entry.code}`, await res.text());
        const t = proj4(`EPSG:${entry.code}`, "EPSG:4326", [1000, 1000]);
        if (!Number.isFinite(t[0]) || !Number.isFinite(t[1])) throw new Error("非有限の変換結果");
        return { fn: (x, y) => proj4(`EPSG:${entry.code}`, "EPSG:4326", [x, y]), method: `epsg.io EPSG:${entry.code}` };
      }
    } catch (e) { /* 解決不能 */ }
  }
  return null;
}
function resolveTransform(url, srsId, meta) {
  const key = `${url}|${srsId}`;
  let p = transforms.get(key);
  if (!p) {
    p = buildTransform(meta?.srs?.[srsId] || null, srsId).catch(() => null);
    transforms.set(key, p);
  }
  return p;
}

// 開いた DB のキャッシュ(url → Promise<SQL.Database>)。
// ファイル全体のダウンロードは初回のみで、再クエリは開いた DB に対して走る
const dbs = new Map();
// 取得は url → 失敗時のみ fallbackUrl(プロキシ書き換え前の元URL)の順で試す。
// /api/fetch のタイムアウト・SSRF 拒否・サーバ停止でプロキシ経路が失敗しても、
// CORS 対応ホストならブラウザ直接取得で読める
async function fetchBytes(url, fallbackUrl) {
  try {
    const response = await fetch(url);
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (!fallbackUrl) throw new Error(`HTTP ${response.status}`);
  } catch (e) {
    if (!fallbackUrl) throw e;
  }
  const response = await fetch(fallbackUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
async function openDb(url, fallbackUrl) {
  let promise = dbs.get(url);
  if (!promise) {
    promise = (async () => {
      const SQL = await loadSqlJs();
      return new SQL.Database(await fetchBytes(url, fallbackUrl || null));
    })();
    promise.catch(() => { if (dbs.get(url) === promise) dbs.delete(url); });
    dbs.set(url, promise);
  }
  return promise;
}

// DB 単位のメタ情報(gpkg_extensions / gpkg_contents / gpkg_spatial_ref_sys)。
// 拡張登録・タイル行列・座標系の警告判定に使う。openDb と同じ url キーでキャッシュ
const metas = new Map();
function readDbMeta(db) {
  const meta = { extensions: [], tiles: [], kinds: {}, srs: {} };
  try {
    const res = db.exec("SELECT table_name, column_name, extension_name, scope FROM gpkg_extensions");
    for (const v of res[0]?.values || []) meta.extensions.push({ table: v[0], column: v[1], name: v[2], scope: v[3] });
  } catch (e) { /* gpkg_extensions なし */ }
  try {
    const res = db.exec("SELECT table_name, data_type FROM gpkg_contents");
    for (const v of res[0]?.values || []) {
      meta.kinds[v[0]] = v[1];
      if (v[1] === "tiles") meta.tiles.push(v[0]);
    }
  } catch (e) { /* 必須表 */ }
  try {
    // WKT for CRS 拡張(gpkgext_crs_wkt)があると definition_12_063 列が増える。
    // 再投影には WKT1(definition)の方が proj4 的確率が高いため両方読む
    const cols = tableColumns(db, "gpkg_spatial_ref_sys");
    const has12 = cols.includes("definition_12_063");
    const res = db.exec(`SELECT srs_id, srs_name, organization, organization_coordsys_id, "definition"${has12 ? ', "definition_12_063"' : ""} FROM gpkg_spatial_ref_sys`);
    for (const v of res[0]?.values || []) {
      meta.srs[Number(v[0])] = { name: v[1], org: v[2], code: Number(v[3]), definition: v[4], definition12: has12 ? v[5] : null };
    }
  } catch (e) { /* ignore */ }
  // OGC 24-050 Portrayal 拡張(ドラフト)。スタイルは地物表への直接外部キーを
  // 持たず名前付きで登録されるため、登録内容をメタとして露出し警告で通知する
  try {
    const res = db.exec("SELECT id, style, description, uri FROM gpkgext_styles");
    const styles = new Map();
    for (const v of res[0]?.values || []) styles.set(Number(v[0]), { id: Number(v[0]), style: v[1], description: v[2] || null, uri: v[3] || null, formats: [] });
    const sh = db.exec("SELECT style_id, format FROM gpkgext_stylesheets");
    let orphan = 0;
    for (const v of sh[0]?.values || []) {
      const s = styles.get(Number(v[0]));
      if (s) { if (v[1] && !s.formats.includes(String(v[1]))) s.formats.push(String(v[1])); }
      else orphan++;
    }
    const list = [...styles.values()];
    if (list.length || orphan) meta.styles = { list, orphanStylesheets: orphan };
  } catch (e) { /* gpkgext_styles なし */ }
  try {
    const res = db.exec("SELECT COUNT(*) FROM gpkgext_symbols");
    meta.symbolCount = Number(res[0]?.values?.[0]?.[0] || 0);
  } catch (e) { /* gpkgext_symbols なし */ }
  try {
    const res = db.exec("SELECT COUNT(*) FROM gpkgext_fonts");
    meta.fontCount = Number(res[0]?.values?.[0]?.[0] || 0);
  } catch (e) { /* gpkgext_fonts なし */ }
  // OGC 24-049 semantic-annotations(ドラフト)。地物表/スタイル等と
  // GeoDataClass 注釈を多対多で紐付ける参照表。mbstyle の source.url=
  // GeoDataClass URI の解決に使う(cmdStyle で内容物と併せて利用)
  try {
    const res = db.exec("SELECT id, type, title, description, uri FROM gpkgext_semantic_annotations");
    const annotations = {};
    for (const v of res[0]?.values || []) {
      annotations[Number(v[0])] = { id: Number(v[0]), type: v[1], title: v[2], description: v[3] || null, uri: v[4] || null };
    }
    if (Object.keys(annotations).length) meta.annotations = annotations;
    const refs = db.exec("SELECT table_name, key_column_name, key_value, sa_id FROM gpkgext_sa_reference");
    const arefs = [];
    for (const v of refs[0]?.values || []) {
      arefs.push({ table: v[0], keyColumn: v[1], key: Number(v[2]), saId: Number(v[3]) });
    }
    if (arefs.length) meta.annotationRefs = arefs;
  } catch (e) { /* semantic-annotations なし */ }
  return meta;
}
async function dbMetaFor(url, fallbackUrl) {
  let p = metas.get(url);
  if (!p) {
    p = openDb(url, fallbackUrl).then(readDbMeta);
    p.catch(() => { if (metas.get(url) === p) metas.delete(url); });
    metas.set(url, p);
  }
  return p;
}

// 座標系が経緯度系か。true=経緯度 / false=投影等 / null=判定不能。
// gpkg_spatial_ref_sys.definition の WKT 先頭キーワードで判定する
function isGeographicSrs(entry, srsId) {
  if (srsId === -1) return false; // undefined cartesian
  const def = String(entry?.definition || entry?.definition12 || "");
  if (/^\s*(GEOGCS|GEODCRS|GEOGCRS|GEOGRAPHIC)/i.test(def)) return true;
  if (def.trim() && def.toLowerCase() !== "undefined") return false;
  if (srsId === 0) return null; // undefined geographic
  return null;
}

// 警告は url+table 単位で1回だけ返す(bbox 再クエリのたびに出ると鬱陶しい)
const warned = new Map();
function freshWarnings(key, warnings) {
  let seen = warned.get(key);
  if (!seen) { seen = new Set(); warned.set(key, seen); }
  return warnings.filter(w => !seen.has(w) && (seen.add(w), true));
}

// 地物テーブルとジオメトリ列を解決する。table 指定が無ければ gpkg_geometry_columns の先頭。
// 登録が無い表は attributes(非空間)扱いで hasGeom=false を返す
function resolveFeatureTable(db, table, meta) {
  let tableName = table || null;
  if (!tableName) {
    const res = db.exec("SELECT table_name FROM gpkg_geometry_columns ORDER BY rowid LIMIT 1");
    tableName = res[0]?.values?.[0]?.[0] || null;
  }
  if (!tableName) throw new Error("地物テーブルが見つかりません");
  const gres = db.exec(`SELECT column_name, srs_id FROM gpkg_geometry_columns WHERE table_name = ${quoteSqlLiteral(tableName)} LIMIT 1`);
  const row = gres[0]?.values?.[0] || null;
  const kind = meta?.kinds?.[tableName] || (row ? "features" : "attributes");
  if (!row) {
    // gpkg_geometry_columns 未登録。contents 上 features の表は
    // 従来通り geom 列名既定で読む(非準拠ファイルの救済)
    const isFeatures = kind === "features";
    return { tableName, geomCol: isFeatures ? "geom" : null, hasGeom: isFeatures,
      srsId: null, kind, unregistered: true };
  }
  return { tableName, geomCol: row[0] || "geom", hasGeom: true, srsId: row[1] != null ? Number(row[1]) : null, kind };
}

// テーブル/DB 由来の警告と SRS 情報を組み立てる。
// reprojMethod が渡された場合は非経緯度の警告を「再投影して表示」へ置き換える
function tableWarnings(meta, t, reprojMethod) {
  const warnings = [];
  if (t.unregistered && t.kind !== "features") {
    warnings.push(`テーブル ${t.tableName} は非空間(attributes)表です。地図には描画されません`);
  }
  let srs = null;
  if (t.srsId != null) {
    const entry = meta?.srs?.[t.srsId] || null;
    const geo = isGeographicSrs(entry, t.srsId);
    srs = { id: t.srsId, name: entry?.name ?? null, org: entry?.org ?? null, code: entry?.code ?? null, geographic: geo, reprojected: reprojMethod || null };
    const label = entry ? `${entry.org || "EPSG"}:${entry.code} (${entry.name})` : `srs_id=${t.srsId}`;
    if (geo === false) {
      warnings.push(reprojMethod
        ? `座標系 ${label} を WGS84(経緯度)へ再投影して表示します(${reprojMethod})`
        : `座標系 ${label} は経緯度系ではなく再投影も解決できませんでした。表示位置がずれます`);
    } else if (t.srsId === -1 || t.srsId === 0) {
      warnings.push(`座標系が未定義です(${label})`);
    }
  }
  if (meta?.tiles?.length) {
    warnings.push(`タイル行列セット ${meta.tiles.join(", ")} を含みます(タイル描画は未対応)`);
  }
  // OGC 24-050 Portrayal 拡張(ドラフト)の登録スタイル。名前付きで地物表と
  // 直接紐付かない設計のため自動適用せず、登録内容を警告で通知する
  if (meta?.styles?.list?.length || meta?.styles?.orphanStylesheets) {
    const parts = [];
    if (meta.styles.list.length) {
      const fmts = [...new Set(meta.styles.list.flatMap(s => s.formats))];
      parts.push(`スタイル ${meta.styles.list.map(s => s.style || `#${s.id}`).join(", ")}${fmts.length ? `(形式: ${fmts.join("/")})` : ""}`);
    }
    if (meta.styles.orphanStylesheets) parts.push(`地物表未紐付けのスタイルシート ${meta.styles.orphanStylesheets} 件`);
    warnings.push(`Portrayal 拡張(gpkgext_styles)に${parts.join("、")}が登録されています(GeoDataClass 紐付け時に自動適用: MapLibre は mbstyle ネイティブ、その他エンジンは mbstyle→共有スタイルspec変換のサブセット適用)`);
  }
  if (meta?.symbolCount) warnings.push(`Portrayal 拡張のシンボル ${meta.symbolCount} 件を含みます(mbstyle の icon-image で適用。共有 spec 未対応エンジンを除く)`);
  if (meta?.fontCount) warnings.push(`Portrayal 拡張のフォント ${meta.fontCount} 件を含みます(mbstyle の text 系で適用。共有 spec 未対応エンジンを除く)`);
  // 対応済みの拡張は警告対象外(rtree=エンベロープ代替・schema=列タイトル読取済。
  // gpkgext_* の portrayal/annotation 系は上で個別通知するため汎用警告からも除く)
  const ext = [...new Set((meta?.extensions || []).map(e => e.name))]
    .filter(n => n !== "gpkg_rtree_index" && n !== "gpkg_schema" && !/^gpkgext_(sty|sym|font|semantic)/.test(n));
  if (ext.length) warnings.push(`未対応の拡張が登録されています: ${ext.join(", ")}`);
  return { warnings, srs };
}

// gpkg_data_columns(schema 拡張)の列タイトル/説明 → 属性パネルの列名表示用
function readColumnMeta(db, tableName) {
  try {
    const res = db.exec(`SELECT column_name, title, description FROM gpkg_data_columns WHERE table_name = ${quoteSqlLiteral(tableName)}`);
    const out = {};
    for (const v of res[0]?.values || []) {
      if (v[1] || v[2]) out[v[0]] = { title: v[1] || null, description: v[2] || null };
    }
    return Object.keys(out).length ? out : null;
  } catch (e) { return null; }
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
  // 呼出側が {west,south,east,north} フラット形で送った場合も ranges へ補正する
  const ranges = Array.isArray(bbox.ranges) && bbox.ranges.length
    ? bbox.ranges
    : [{ west: bbox.west, east: bbox.east }];
  return ranges.some(r => env.east >= Number(r.west) && env.west <= Number(r.east));
}

// QGIS が「データベースに保存」したスタイル(layer_styles テーブル)。
// useAsDefault=1 を優先、無ければ先頭行。styleName 指定時はその行を選択し、
// 見つからなければ missing で通知する(呼び出し側が警告化)。
// styleQML 無しで styleSLD がある場合は sld 本文も返す(SLD パーサ適用用)。
// 無い GPKG は null
function readStyleInfo(db, tableName, styleName) {
  try {
    const sres = db.exec(`SELECT styleName, styleQML, styleSLD FROM layer_styles WHERE f_table_name = ${quoteSqlLiteral(tableName)} ORDER BY useAsDefault DESC`);
    const rows = sres[0]?.values || [];
    if (!rows.length) return null;
    const styleNames = rows.map(r => r[0]).filter(v => typeof v === "string" && v.trim());
    let target = null, missing = null;
    if (styleName) {
      target = rows.find(r => r[0] === styleName) || null;
      if (!target) missing = styleName;
    }
    if (!target) target = rows.find(r => typeof r[1] === "string" && r[1].trim()) || rows[0];
    const qml = typeof target[1] === "string" && target[1].trim() ? target[1] : null;
    const sld = typeof target[2] === "string" && target[2].trim() ? target[2] : null;
    return {
      qml, sld: qml ? null : sld,
      sldOnly: !qml && !!sld,
      styleName: typeof target[0] === "string" ? target[0] : null,
      styleNames, missing,
    };
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
// bbox は GPkgBinary エンベロープで JS 判定してからデコードする。
// メタ情報(srs/拡張/列タイトル)と警告・非空間表の kind も返す
async function cmdLoad(msg) {
  const db = await openDb(msg.url, msg.directUrl);
  const meta = await dbMetaFor(msg.url, msg.directUrl);
  const t = resolveFeatureTable(db, msg.table, meta);
  // 非経緯度 CRS は WGS84 への再投影を解決する(解決できたら警告も差し替わる)
  const xform = t.srsId != null && t.srsId > 0 ? await resolveTransform(msg.url, t.srsId, meta) : null;
  const { warnings, srs } = tableWarnings(meta, t, xform?.method || null);
  const columnMeta = readColumnMeta(db, t.tableName);
  const styleInfo = readStyleInfo(db, t.tableName, msg.styleName || null);
  // gpkgstyle= で指定した styleName が layer_styles に無い場合は既定へ戻して警告
  if (styleInfo?.missing) {
    warnings.push(`layer_styles に styleName "${styleInfo.missing}" がありません(登録: ${styleInfo.styleNames.join(", ") || "なし"})。既定スタイルを適用します`);
  }
  if (!t.hasGeom) {
    // attributes(非空間)表。地図描画はしないが kind で診断できるよう返す
    return {
      geojson: { type: "FeatureCollection", features: [] },
      qml: null, total: 0, count: 0, kind: "attributes",
      srs, extensions: meta.extensions, columnMeta, styles: meta.styles || null,
      table: t.tableName,
      warnings: freshWarnings(`${msg.url}|${t.tableName}`, warnings),
    };
  }
  // エンベロープはネイティブ座標。再投影できる場合は経緯度へ変換してから bbox 判定、
  // 非経緯度かつ再投影不能なら判定不能のためフィルター自体を外す(誤除外を防ぐ)
  const canFilter = msg.bbox && (xform || !srs || srs.geographic !== false);
  const sql = buildFeatureSelect({ tableName: t.tableName, geomCol: t.geomCol, columns: msg.columns, where: msg.where, limit: msg.limit });
  const stmt = db.prepare(sql);
  const colNames = stmt.getColumnNames();
  const features = [];
  let dropped = 0;
  while (stmt.step()) {
    const row = stmt.get();
    const rec = {};
    colNames.forEach((c, i) => { rec[c] = row[i]; });
    // bbox=auto: GPkgBinary エンベロープと表示範囲が交差しない地物はデコードしない
    if (canFilter && !envelopeIntersects(transformEnvelope(gpkgGeometryEnvelope(rec[t.geomCol]), xform?.fn), msg.bbox)) continue;
    const wkb = gpkgGeometryToWkb(rec[t.geomCol]);
    const geometry = wkb ? wkbToGeoJsonGeometry(wkb) : null;
    if (!geometry) { dropped++; continue; }
    if (xform) transformGeoJsonGeometry(geometry, xform.fn);
    const properties = {};
    for (const c of colNames) if (c !== t.geomCol) properties[c] = sanitizeVectorPropertyValue(rec[c]);
    features.push({ type: "Feature", geometry, properties });
  }
  stmt.free();
  if (dropped) warnings.push(`${dropped} 件の地物ジオメトリをデコードできませんでした(未対応のジオメトリ型)`);
  // 検索は常に全件対象: bbox で表示が絞られていても where= のヒット数は
  // bbox なしの COUNT(*) で全件として数える(duckdb: と同じ方針)
  let total = null;
  if (msg.bbox && msg.where) {
    try {
      const cres = db.exec(`SELECT COUNT(*) AS n FROM ${quoteSqlIdent(t.tableName)} WHERE (${msg.where})`);
      total = Number(cres[0]?.values?.[0]?.[0] ?? 0);
    } catch (e) { /* 件数取得は補助情報のため失敗は無視 */ }
  }
  return {
    geojson: { type: "FeatureCollection", features },
    qml: msg.wantStyle && styleInfo ? styleInfo.qml : null,
    sld: msg.wantStyle && styleInfo ? styleInfo.sld : null,
    styleName: styleInfo?.styleName || null,
    styleNames: styleInfo?.styleNames || null,
    total,
    count: features.length,
    kind: "features",
    table: t.tableName,
    srs,
    extensions: meta.extensions,
    columnMeta,
    styles: meta.styles || null,
    dropped,
    warnings: freshWarnings(`${msg.url}|${t.tableName}`, warnings),
  };
}

// 属性値一覧ウィジェット用: 読み込み済み GeoJSON ではなく DB に直接クエリして
// 全件対象で行を返す(bbox 非適用・where= 適用)。行位置は GPkgBinary エンベロープの中心。
// 非空間(attributes)表にも対応する(geomCol 無し → 位置なしの行)
async function cmdAttrs(msg) {
  const db = await openDb(msg.url, msg.directUrl);
  const meta = await dbMetaFor(msg.url, msg.directUrl);
  const t = resolveFeatureTable(db, msg.table, meta);
  const xform = t.srsId != null && t.srsId > 0 ? await resolveTransform(msg.url, t.srsId, meta) : null;
  const allCols = tableColumns(db, t.tableName);
  const attrCols = (Array.isArray(msg.columns) && msg.columns.length)
    ? msg.columns.filter(name => allCols.includes(name))
    : allCols.filter(name => name !== t.geomCol);
  const predicates = [];
  if (msg.where) predicates.push(`(${msg.where})`);
  const needle = String(msg.searchText || "").trim();
  if (needle && attrCols.length) {
    const escaped = needle.replace(/[\\%_]/g, m => `\\${m}`);
    const lit = quoteSqlLiteral(`%${escaped}%`);
    predicates.push(`(${attrCols.map(name => `CAST(${quoteSqlIdent(name)} AS TEXT) LIKE ${lit} ESCAPE '\\'`).join(" OR ")})`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const geomExpr = t.hasGeom
    ? (attrCols.length ? `, ${quoteSqlIdent(t.geomCol)}` : quoteSqlIdent(t.geomCol))
    : "";
  const stmt = db.prepare(`SELECT ${attrCols.map(quoteSqlIdent).join(", ") || "*"}${geomExpr} FROM ${quoteSqlIdent(t.tableName)}${where}`);
  const rows = [];
  while (stmt.step()) {
    const row = stmt.get();
    const values = row.slice(0, attrCols.length).map(v => {
      const s = sanitizeVectorPropertyValue(v);
      return s == null ? "" : String(s);
    });
    const geomValue = t.hasGeom ? row[attrCols.length] : null;
    let env = t.hasGeom ? gpkgGeometryEnvelope(geomValue) : null;
    // geometry は行位置のフォールバック or 呼び出し側の wantGeom(属性テーブルの
    // WKT 出力)でのみデコードする。常時デコードは大きい GPKG で重い
    let geometry = null;
    if (t.hasGeom && (!env || msg.wantGeom)) {
      const wkb = gpkgGeometryToWkb(geomValue);
      geometry = wkb ? wkbToGeoJsonGeometry(wkb) : null;
      if (geometry && xform) transformGeoJsonGeometry(geometry, xform.fn);
      if (!env && geometry) env = geoJsonGeometryEnvelope(geometry);
    }
    if (env && xform) env = transformEnvelope(env, xform.fn);
    const center = env ? { lat: (env.south + env.north) / 2, lng: (env.west + env.east) / 2 } : null;
    rows.push({ values, lat: center ? center.lat : null, lng: center ? center.lng : null, geometry });
  }
  stmt.free();
  const { warnings } = tableWarnings(meta, t, xform?.method || null);
  return {
    attributes: attrCols, rows,
    columnMeta: readColumnMeta(db, t.tableName),
    warnings: freshWarnings(`${msg.url}|${t.tableName}`, warnings),
  };
}

// Uint8Array → base64(大きい BLOB でもスタック溢出しないよう分割)
function u8ToBase64(u8) {
  if (!u8) return null;
  const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function blobToTextOrBase64(v) {
  if (typeof v === "string") return { text: v, base64: null };
  const u8 = v ? new Uint8Array(v) : null;
  if (!u8) return { text: null, base64: null };
  try {
    const t = new TextDecoder("utf-8", { fatal: true }).decode(u8);
    return { text: t, base64: null };
  } catch (e) { return { text: null, base64: u8ToBase64(u8) }; }
}

// OGC 24-050 Portrayal 拡張の内容物(stylesheets 本文・シンボル画像・フォント)と
// 24-049 semantic-annotations をまとめて返す。大容量 BLOB を含み得るため
// load 結果には入れず、このコマンドでオンデマンド取得する
async function cmdStyle(msg) {
  const db = await openDb(msg.url, msg.directUrl);
  const meta = await dbMetaFor(msg.url, msg.directUrl);
  const sheets = [];
  try {
    const res = db.exec("SELECT id, style_id, format, stylesheet FROM gpkgext_stylesheets");
    for (const v of res[0]?.values || []) {
      const { text, base64 } = blobToTextOrBase64(v[3]);
      sheets.push({ id: Number(v[0]), styleId: Number(v[1]), format: String(v[2] || ""), data: text, dataBase64: base64 });
    }
  } catch (e) { /* gpkgext_stylesheets なし */ }
  const symbols = [];
  try {
    const sres = db.exec(`SELECT s.id, s.symbol, s.title, s.description, s.uri,
        i.id, i.content_id, i.width, i.height, i.offset_x, i.offset_y, i.pixel_ratio,
        c.format, c.uri, c.content
      FROM gpkgext_symbols s
      LEFT JOIN gpkgext_symbol_images i ON i.symbol_id = s.id
      LEFT JOIN gpkgext_symbol_content c ON c.id = i.content_id`);
    const byId = new Map();
    for (const v of sres[0]?.values || []) {
      const sid = Number(v[0]);
      if (!byId.has(sid)) byId.set(sid, { id: sid, symbol: v[1], title: v[2] || null, description: v[3] || null, uri: v[4] || null, images: [] });
      if (v[5] != null) {
        byId.get(sid).images.push({
          id: Number(v[5]), contentId: Number(v[6]),
          width: v[7] ?? null, height: v[8] ?? null,
          offsetX: v[9] ?? null, offsetY: v[10] ?? null, pixelRatio: v[11] ?? null,
          format: v[12] || null, uri: v[13] || null, dataBase64: u8ToBase64(v[14]),
        });
      }
    }
    symbols.push(...byId.values());
  } catch (e) { /* gpkgext_symbols 系なし */ }
  const fonts = [];
  try {
    const res = db.exec("SELECT id, name, font, glyphs FROM gpkgext_fonts");
    for (const v of res[0]?.values || []) {
      fonts.push({ id: Number(v[0]), name: v[1] || null, fontBase64: u8ToBase64(v[2]), glyphsBase64: u8ToBase64(v[3]) });
    }
  } catch (e) { /* gpkgext_fonts なし */ }
  return {
    styles: meta.styles || null, sheets, symbols, fonts,
    annotations: meta.annotations || {}, annotationRefs: meta.annotationRefs || [],
    featureTables: Object.keys(meta.kinds || {}).filter(t => meta.kinds[t] === "features"),
  };
}

async function handleMessage(msg) {
  const { cmd } = msg;
  if (cmd === "warm") {
    await loadSqlJs();
    return {};
  }
  if (cmd === "load") return cmdLoad(msg);
  if (cmd === "attrs") return cmdAttrs(msg);
  if (cmd === "style") return cmdStyle(msg);
  if (cmd === "reset") {
    // プロジェクト/インスペクター変更時に開いた DB をすべて破棄する
    for (const promise of dbs.values()) {
      try { (await promise).close(); } catch (e) { /* ignore */ }
    }
    dbs.clear();
    metas.clear();
    warned.clear();
    transforms.clear();
    return {};
  }
  throw new Error(`不明なコマンド: ${cmd}`);
}

// コマンドは直列に処理する。await 中に後続コマンドが割り込むと、
// reset が openDb ペンディング中の DB を close して他のコマンドが
// 閉じた DB を受け取る競合("Database closed")が起きるため
let commandQueue = Promise.resolve();
self.onmessage = event => {
  const msg = event.data || {};
  const { reqId } = msg;
  commandQueue = commandQueue.then(() => handleMessage(msg)).then(
    result => self.postMessage({ reqId, ...result }),
    error => self.postMessage({ reqId, error: error instanceof Error ? error.message : String(error) }),
  );
};
