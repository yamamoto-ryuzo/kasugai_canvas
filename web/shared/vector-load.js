// ベクター系 .kasc 行 → GeoJSON FeatureCollection（エンジン非依存ローダー）
// 対象: geojson:/layer: / geoparquet:/parquet: / flatgeobuf:/fgb: / gpkg:/geopackage: /
//       csv:/tsv: / duckdb: / sql: / kml:/kmz: / gpx: / czml: / topojson: /
//       esrijson:/arcgis: / geojsonl:/ndjson:/jsonl: / geojsonseq:/fgseq: / wkt: / wkb: / wfs: / shp:
// duckdb:/sql: のクエリ実行は window.KascLoader(shared/kasc_loader.js) へ委譲する。
// bounds = {ranges:[{west,east}],south,north} は bbox=auto/:bbox 系の表示範囲として使う
import { wkbToGeoJsonGeometry, sanitizeVectorPropertyValue, transformGeoJsonGeometry } from "./vector-decode.js";
import { resolveKascUrl } from "./kasc.js";
import { fetchProxyUrl } from "./backend.js";

// generic モジュール(deserialize/readMetadata=ヘッダのみ Range 取得用)。
// flatgeobuf ピンは generic.js/geojson-geometry.js(本ファイルと kasc_loader.js)
// /geojson.js(export-formats.js) の3モジュール5箇所。更新時は全同期
// 読み込み済みなら追加コストは import 解決のみ
const FGB_GENERIC_URL = "https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/lib/mjs/generic.js/+esm";
const HYPARQUET_URL = "https://cdn.jsdelivr.net/npm/hyparquet@1.33.1/+esm";
const HYPARQUET_COMPRESSORS_URL = "https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.3/+esm";
const TOGEOJSON_URL = "https://cdn.jsdelivr.net/npm/@tmcw/togeojson@7.1.4/+esm";
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.2/+esm";
const SHP_URL = "https://cdn.jsdelivr.net/npm/shpjs@6.2.0/+esm";
const TOPOJSON_URL = "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm";
const ARCGIS_URL = "https://cdn.jsdelivr.net/npm/@terraformer/arcgis@2.2.2/+esm";

let gpkgWorker = null;
let gpkgReqId = 0;
const gpkgPending = new Map();

function ensureGpkgWorker() {
  if (!gpkgWorker) {
    // import.meta.url 基準で解決する(plain "./gpkg-worker.js" はドキュメント
    // 基準のため /<engine>/gpkg-worker.js を指して 404 になる)
    gpkgWorker = new Worker(new URL("./gpkg-worker.js", import.meta.url), { type: "module" });
    gpkgWorker.onmessage = event => {
      const { reqId, error, ...result } = event.data || {};
      const entry = gpkgPending.get(reqId);
      if (!entry) return;
      gpkgPending.delete(reqId);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    };
    gpkgWorker.onerror = event => {
      for (const entry of gpkgPending.values()) entry.reject(new Error(String(event.message || event)));
      gpkgPending.clear();
      // 起動失敗 Worker を使い回すと以後の呼出が応答無しで固着するため破棄する
      try { gpkgWorker.terminate(); } catch (e) { /* ignore */ }
      gpkgWorker = null;
    };
  }
  return gpkgWorker;
}

function gpkgCommand(msg) {
  const reqId = ++gpkgReqId;
  return new Promise((resolve, reject) => {
    gpkgPending.set(reqId, { resolve, reject });
    ensureGpkgWorker().postMessage({ reqId, ...msg });
  });
}

// OGC 24-050 Portrayal 拡張(gpkgext_styles/symbols/fonts)と 24-049
// semantic-annotations の内容物をオンデマンド取得する。
// load 結果には含めず、maplibre の mbstyle 適用等の利用側が必要時のみ呼ぶ
export function gpkgStyleRegistry(url, directUrl = null) {
  return gpkgCommand({ cmd: "style", url, directUrl });
}

function toFeatureCollection(items) {
  const features = [];
  for (const row of items) {
    if (!row) continue;
    let geom = row.geometry ?? row.geom;
    if (geom && !(geom.type)) {
      // WKB(Uint8Array) を GeoJSON ジオメトリへ
      if (geom instanceof Uint8Array || ArrayBuffer.isView(geom) || geom instanceof ArrayBuffer) {
        geom = wkbToGeoJsonGeometry(geom instanceof ArrayBuffer ? new Uint8Array(geom) : geom);
      } else if (typeof geom === "string" && /^[0-9a-fA-F]+$/.test(geom)) {
        const bytes = new Uint8Array(geom.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(geom.slice(i * 2, i * 2 + 2), 16);
        geom = wkbToGeoJsonGeometry(bytes);
      }
    }
    if (!geom || !geom.type) continue;
    const { geometry: _g, geom: _g2, ...rawProps } = row;
    // BigInt 等の structured-clone 不可な値は MapLibre GeoJSON ソースへ渡せないため変換
    const props = {};
    for (const [k, v] of Object.entries(rawProps)) {
      if (typeof v === "bigint") props[k] = v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : String(v);
      else props[k] = v;
    }
    features.push({ type: "Feature", geometry: geom, properties: props });
  }
  return { type: "FeatureCollection", features };
}

// bounds({ranges:[{west,east}],south,north}) → FlatGeobuf rect({minX,minY,maxX,maxY})。
// 日付変更線またぎは ranges が2区間になるため rect も複数返す
function flatgeobufRects(bounds) {
  if (!bounds || !Array.isArray(bounds.ranges) || !bounds.ranges.length) return null;
  return bounds.ranges.map(r => ({ minX: r.west, minY: bounds.south, maxX: r.east, maxY: bounds.north }));
}

// 属性値の正規化(sanitize)は Cesium 版と共通。BigInt 等 structured-clone 不可な値も潰す。
// bounds 指定時は URL 文字列＋{rect} を deserialize へ渡し、空間インデックスと
// HTTP Range リクエストで範囲内の地物だけを読む(真のクエリ系)。
// 索引なしファイル・Range 非対応サーバーは例外を捕まえて全件読み込みへフォールバック。
// headerMetaFn でヘッダ(name/columns/envelope/featureCount/crs/indexNodeSize)を捕捉し
// item.fgbHeader 経由で UI/API へ露出する。seekable Zstandard 圧縮 FGB は
// FlatGeobuf デコーダ。geojson.deserialize ではなく generic.deserialize +
// 自前 fromFeature を使う。理由: geojson 側の fromFeature は Json 列の値が
// JSON として不正な場合に JSON.parse が例外を投げ、地物イテレーション全体が
// 中断する(1属性の不正でレイヤー全体が読めない)。fromFeature を自前化して
// Json→String 再パースで生文字列として救出し、他列・他地物への影響を防ぐ。
const FGB_GEOM_URL = "https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/lib/mjs/geojson/geometry.js/+esm";
let fgbDecoderPromise = null;
function loadFgbDecoder() {
  if (!fgbDecoderPromise) {
    fgbDecoderPromise = Promise.all([import(FGB_GENERIC_URL), import(FGB_GEOM_URL)])
      .then(([g, geom]) => {
        const { deserialize, parseProperties, ColumnType } = g;
        const fromFeature = (id, feature, header) => {
          let properties = null;
          try {
            properties = parseProperties(feature, header.columns);
          } catch {
            const cols = (header.columns || []).map(c =>
              c.type === ColumnType.Json ? { ...c, type: ColumnType.String } : c);
            try { properties = parseProperties(feature, cols); } catch { /* 属性なしで通す */ }
          }
          return {
            type: "Feature", id,
            geometry: geom.fromGeometry(feature.geometry(), header.geometryType),
            properties,
          };
        };
        return { deserialize, fromFeature };
      });
    fgbDecoderPromise.catch(() => { fgbDecoderPromise = null; });
  }
  return fgbDecoderPromise;
}

// 「Not a FlatGeobuf file」失敗を検知して seekableZstd 読みへ再試行する。
// opts: { proxy: /api/fetch 経由取得(CORS回避・Range転送) / nocache: ライブラリの
//   Range バッファキャッシュを無効化(更新されるリモート FGB 向け) /
//   key: Bearer 認証キー(.kasc の key= オプション・DeserializeOptions.headers へ接続。
//       proxy=on 併用時はプロキシが Range 以外を転送しないためターゲットへ届かない) }
// 戻り値 { geojson, ranged, header }: ranged=false は再クエリしても同じ全件になる印
async function loadFlatGeobuf(url, bounds = null, opts = null) {
  const { deserialize, fromFeature } = await loadFgbDecoder();
  const fc = { type: "FeatureCollection", features: [] };
  const srcUrl = fetchProxyUrl(url, !!opts?.proxy);
  const nocache = !!opts?.nocache;
  const headers = opts?.key ? { authorization: `Bearer ${opts.key}` } : undefined;
  const fetchOpt = headers ? { headers } : undefined;
  let header = null;
  const headerMetaFn = h => { header = h; };
  const collect = async (iter, seen) => {
    for await (const feature of iter) {
      if (!feature || !feature.geometry) continue;
      const properties = feature.properties;
      if (properties) {
        for (const key of Object.keys(properties)) {
          properties[key] = sanitizeVectorPropertyValue(properties[key]);
        }
      }
      // 日付変更線またぎの2rect走査で ±180 跨ぎの地物が重複し得るため id で重複排除
      const id = feature.id;
      if (seen && id != null) { if (seen.has(id)) continue; seen.add(id); }
      fc.features.push(feature);
    }
  };
  const isNotFgb = e => /not a flatgeobuf/i.test(String(e && e.message || e));
  const rects = flatgeobufRects(bounds);
  if (rects) {
    try {
      const seen = rects.length > 1 ? new Set() : null;
      for (const rect of rects) {
        try {
          await collect(deserialize(srcUrl, { rect, nocache, headers, headerMetaFn, fromFeature }), seen);
        } catch (e) {
          // seekable Zstandard 圧縮 FGB (.fgb.zst/.fgbz) は仮想デコード層の上で
          // 同じ Range 読みが効く。平文 FGB との識別はマジックバイト失敗で行う
          if (!isNotFgb(e)) throw e;
          await collect(deserialize(srcUrl, { rect, seekableZstd: true, nocache, headers, headerMetaFn, fromFeature }), seen);
        }
      }
      return { geojson: fc, ranged: true, header };
    } catch (error) {
      console.warn(`flatgeobuf 範囲読み失敗(索引なし・Range 非対応等)。全件へフォールバック: ${url}`, error);
      fc.features.length = 0;
    }
  }
  const res = await fetch(srcUrl, fetchOpt);
  if (!res.ok || !res.body) throw new Error(`flatgeobuf 取得失敗: ${res.status}`);
  try {
    await collect(deserialize(res.body, { nocache, headerMetaFn, fromFeature }), null);
  } catch (e) {
    if (!isNotFgb(e)) throw e;
    // seekable Zstd 圧縮はストリーム非対応のためバッファへ取り直して再試行
    const bytes = new Uint8Array(await (await fetch(srcUrl, fetchOpt)).arrayBuffer());
    await collect(deserialize(bytes, { seekableZstd: true, nocache, headerMetaFn, fromFeature }), null);
  }
  return { geojson: fc, ranged: false, header };
}

// HeaderMeta を UI/API 露出用の小さいサマリへ正規化する。
// geometryType/column.type は enum 数値のため名称へ写像する
const FGB_GEOM_NAMES = ["Unknown", "Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection", "CircularString", "CompoundCurve", "CurvePolygon", "MultiCurve", "MultiSurface", "Curve", "Surface", "PolyhedralSurface", "TIN", "Triangle"];
const FGB_COLUMN_TYPE_NAMES = ["Byte", "UByte", "Bool", "Short", "UShort", "Int", "UInt", "Long", "ULong", "Float", "Double", "String", "Json", "DateTime", "Binary"];
export function summarizeFlatGeobufHeader(header) {
  if (!header) return null;
  // 既に正規化済み(readFlatGeobufMeta の戻り値等)はそのまま返す
  if (header.hasSpatialIndex !== undefined) return header;
  const crs = header.crs
    ? { org: header.crs.org ?? null, code: header.crs.code ?? null, name: header.crs.name ?? null, codeString: header.crs.code_string ?? null }
    : null;
  return {
    title: header.title ?? null,
    description: header.description ?? null,
    metadata: header.metadata ?? null,
    geometryType: FGB_GEOM_NAMES[header.geometryType] ?? `Unknown(${header.geometryType})`,
    featuresCount: Number(header.featuresCount ?? 0),
    indexNodeSize: header.indexNodeSize ?? 0,
    hasSpatialIndex: (header.indexNodeSize ?? 0) > 0,
    envelope: header.envelope ? Array.from(header.envelope) : null,
    crs,
    columns: (header.columns || []).map(c => ({
      name: c.name,
      type: FGB_COLUMN_TYPE_NAMES[c.type] ?? `Unknown(${c.type})`,
      title: c.title ?? null,
      description: c.description ?? null,
      nullable: c.nullable ?? null,
      primaryKey: c.primary_key ?? null,
    })),
  };
}

// ファイルを読み切らずヘッダのみ取得する(Range 前提・generic.readMetadata)。
// 未ロードレイヤーの索引有無の事前確認用。opts は loadFlatGeobuf と同じ
// { proxy, nocache, key }。失敗時は null を返す
export async function readFlatGeobufMeta(url, opts = null) {
  try {
    const mod = await import(FGB_GENERIC_URL);
    const headers = opts?.key ? { authorization: `Bearer ${opts.key}` } : undefined;
    const header = await mod.readMetadata(fetchProxyUrl(url, !!opts?.proxy), !!opts?.nocache, headers);
    return summarizeFlatGeobufHeader(header);
  } catch (e) {
    console.warn(`flatgeobuf メタデータ取得失敗: ${url}`, e);
    return null;
  }
}

// ---- .qml サイドカー(QGIS 規約) ----
// ファイルレイヤの「既定として保存」は <base>.qml をデータと同じ場所に置く
// QGIS de-facto 規約。flatgeobuf:/geoparquet: 行で style= 未指定のとき URL の
// 拡張子を .qml に換えて 1 回だけ探査し、見つかれば item.styleUrl と
// item.opts.style へ接続する。404・CORS 失敗・非 QML 応答は静黙で未検出扱い
// (警告を出さない)。geo_webview 出力は明示の style= を持つため本経路は
// 手書き .kasc 向け
const _fgbQmlSidecarCache = new Map();
export async function probeQmlSidecar(item) {
  if (!item || item._fgbQmlSidecarDone) return null;
  item._fgbQmlSidecarDone = true;
  if (!["flatgeobuf", "fgb", "geoparquet", "parquet"].includes(item.type)) return null;
  if (item.styleUrl || item.opts?.style) return null;
  const url = String(item.url || "");
  let result = _fgbQmlSidecarCache.get(url);
  if (result === undefined) {
    result = null;
    const m = url.replace(/[?#].*$/, "").match(/^(.*)\.(?:fgb|flatgeobuf|parquet|geoparquet)$/i);
    if (m) {
      const qmlUrl = `${m[1]}.qml`;
      try {
        const res = await fetch(qmlUrl);
        if (res.ok) {
          const text = await res.text();
          // SPA fallback 等で index.html が返るケースを除外(QML は <qgis> または
          // <maplayer> を必ず持つ)
          if (/<\s*(qgis|maplayer)[\s>]/i.test(text.slice(0, 4096))) result = qmlUrl;
        }
      } catch { /* 探査失敗は未検出と同じ */ }
    }
    _fgbQmlSidecarCache.set(url, result);
  }
  if (result) {
    item.styleUrl = result;
    if (item.opts && typeof item.opts === "object") item.opts.style = result;
  }
  return result;
}
// 旧名(fgb 専用だった頃の名)の互換エイリアス。実体は geoparquet も対象の probeQmlSidecar
export const probeFgbQmlSidecar = probeQmlSidecar;

let hyparquetLoaderPromise = null;
function loadHyparquet() {
  if (!hyparquetLoaderPromise) {
    hyparquetLoaderPromise = Promise.all([
      import(HYPARQUET_URL),
      import(HYPARQUET_COMPRESSORS_URL),
    ]).then(([hp, hc]) => ({
      parquetReadObjects: hp.parquetReadObjects,
      parquetMetadata: hp.parquetMetadataAsync || hp.parquetMetadata,
      asyncBufferFromUrl: hp.asyncBufferFromUrl,
      compressors: hc.compressors,
    }));
  }
  return hyparquetLoaderPromise;
}

// parquet ファイルメタから geo key/value メタデータ(version/primary_column/
// columns{encoding,crs,geometry_types,edges,orientation,bbox,epoch,covering})を
// 取り出す。取得不能・JSON 不正時は null
function extractGeoParquetMeta(meta) {
  try {
    const kv = meta && (meta.key_value_metadata || meta.metadata || []);
    const entry = Array.isArray(kv)
      ? kv.find(item => item && item.key === "geo")
      : (kv instanceof Map ? { value: kv.get("geo") } : null);
    const rawGeo = entry && entry.value;
    const geoText = rawGeo instanceof Uint8Array ? new TextDecoder().decode(rawGeo) : rawGeo;
    return geoText ? JSON.parse(geoText) : null;
  } catch {
    return null;
  }
}

// crs が OGC:CRS84 と同等か。判定は仕様の簡易手順(geo メタの crs.id のみ見る。
// 欠落=CRS84・明示 null=CRS 未定義)に従う
function geoParquetCrsIsWgs84(crs) {
  if (crs === undefined) return true;
  if (crs === null) return false;
  const id = crs && crs.id;
  if (!id || !id.authority) return false;
  return (id.authority === "OGC" && id.code === "CRS84")
    || (id.authority === "EPSG" && Number(id.code) === 4326);
}

function summarizeGeoParquetCrs(crs) {
  if (crs === undefined) return { authority: "OGC", code: "CRS84", name: "default" };
  if (crs === null) return null;
  const id = crs && crs.id || {};
  return { authority: id.authority ?? null, code: id.code ?? null, name: crs.name ?? null };
}

// geo メタ(JSON)を UI/API 露出用に正規化する(item.geoHeader → listLayers/バッジ)
export function summarizeGeoParquetHeader(geo) {
  if (!geo || typeof geo !== "object") return null;
  const primary = geo.primary_column || null;
  const col = primary && geo.columns ? geo.columns[primary] : null;
  return {
    version: geo.version ?? null,
    primaryColumn: primary,
    geometryColumns: Object.keys(geo.columns || {}),
    encoding: col?.encoding ?? null,
    geometryTypes: col?.geometry_types ?? null,
    crs: summarizeGeoParquetCrs(col ? col.crs : undefined),
    edges: col?.edges ?? null,
    orientation: col?.orientation ?? null,
    bbox: col?.bbox ?? null,
    epoch: col?.epoch ?? null,
    covering: col?.covering ? Object.keys(col.covering) : null,
  };
}

// covering.bbox のルート列名({"xmin":["bbox","xmin"],...}→"bbox")を取り出す。
// spec 上4要素は同一列名が必須
function geoParquetCoveringColumn(colMeta) {
  const xmin = colMeta?.covering?.bbox?.xmin;
  return Array.isArray(xmin) && typeof xmin[0] === "string" ? xmin[0] : null;
}

// covering.bbox の4パス(ネスト構造列なら "geometry_bbox.xmin" のドット結合)を
// hyparquet filter のキー形式で取り出す。xmin/ymin/xmax/ymax が揃わなければ null
function geoParquetCoveringPaths(colMeta) {
  const bbox = colMeta?.covering?.bbox;
  if (!bbox) return null;
  const path = key => Array.isArray(bbox[key]) && bbox[key].length ? bbox[key].join(".") : null;
  const xmin = path("xmin"), ymin = path("ymin"), xmax = path("xmax"), ymax = path("ymax");
  return xmin && ymin && xmax && ymax ? { xmin, ymin, xmax, ymax } : null;
}

// bounds {ranges:[{west,east}],south,north}(getViewRanges。日付変更線またぎは
// ranges が2要素)を covering 列への範囲フィルタへ変換する。行グループの
// min/max 統計とページインデックスによる読み飛ばしが効く
function geoParquetCoveringFilter(refs, bounds) {
  const lonBlocks = bounds.ranges.map(r => ({
    $and: [{ [refs.xmin]: { $lte: r.east } }, { [refs.xmax]: { $gte: r.west } }],
  }));
  return {
    $and: [
      { $or: lonBlocks },
      { [refs.ymin]: { $lte: bounds.north } },
      { [refs.ymax]: { $gte: bounds.south } },
    ],
  };
}

// 行グループの geospatial_statistics.bbox(GeoParquet 2.0 ネイティブ GEOMETRY/
// GEOGRAPHY 列の統計)で表示範囲と重ならないグループを読み飛ばす。
// covering 列の無いファイル向け。統計を持つグループが1つも無ければ null、
// あれば残存グループの行範囲 [start,end) を連結して返す
function geoParquetStatPrunedRanges(meta, geomColumn, bounds) {
  if (!meta?.row_groups?.length || !geomColumn) return null;
  let sawStats = false;
  const kept = [];
  let rowStart = 0;
  for (const rg of meta.row_groups) {
    const n = Number(rg.num_rows) || 0;
    const col = (rg.columns || []).find(c => {
      const p = c?.meta_data?.path_in_schema;
      return Array.isArray(p) && p.join(".") === geomColumn;
    });
    const bb = col?.meta_data?.geospatial_statistics?.bbox;
    let keep = true; // 統計が無いグループは保守的に残す
    if (bb && [bb.xmin, bb.ymin, bb.xmax, bb.ymax].every(Number.isFinite)) {
      sawStats = true;
      keep = bounds.ranges.some(r => bb.xmin <= r.east && bb.xmax >= r.west)
        && bb.ymin <= bounds.north && bb.ymax >= bounds.south;
    }
    if (keep) {
      const last = kept[kept.length - 1];
      if (last && last[1] === rowStart) last[1] = rowStart + n;
      else kept.push([rowStart, rowStart + n]);
    }
    rowStart += n;
  }
  return sawStats ? kept : null;
}

// GeoJSON ジオメトリのエンベロープ [minX,minY,maxX,maxY]。行グループ統計は
// 包絡でしかないため、範囲読みで残った行は個別地物の包絡でも厳密に判定する。
// 座標が無いジオメトリは null(判定不能のため除外しない)
function geoJsonGeometryEnvelope(geom) {
  if (!geom) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = coords => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") {
      const x = coords[0], y = coords[1] || 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      return;
    }
    coords.forEach(walk);
  };
  if (geom.type === "GeometryCollection") (geom.geometries || []).forEach(walk);
  else walk(geom.coordinates);
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

// Cesium 版と同一実装: Range Request 対応の非同期バッファを優先し、
// geo メタデータの primary_column でジオメトリ列を特定する。
// bounds(表示範囲)指定時は covering.bbox 列への範囲フィルタ(行グループ統計+
// ページインデックスで読み飛ばし)→ 行グループ geospatial_statistics による
// グループ選別の順に部分読みを試みる。どちらも無い平 WKB・Range 非対応
// サーバ・非 CRS84 ファイルは全件読みへフォールバックし ranged=false を返す
// (fgb と同じ「再クエリしても意味がない」印)
async function loadGeoParquet(url, bounds = null) {
  const { parquetReadObjects, parquetMetadata, asyncBufferFromUrl, compressors } = await loadHyparquet();
  let file;
  let sawPartial = false;
  try {
    if (bounds?.ranges?.length) {
      // 206 を観測して Range 対応を判定する。非対応サーバは初回 slice で全量を
      // 取得するが、部分結果を返すと再クエリされず地物が欠けるため必ず全件読みに回す
      const track = (u, init) => fetch(u, init).then(res => { if (res.status === 206) sawPartial = true; return res; });
      file = await asyncBufferFromUrl({ url, fetch: track });
    } else {
      file = await asyncBufferFromUrl({ url });
    }
  } catch {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`geoparquet 取得失敗: ${res.status}`);
    file = await res.arrayBuffer();
  }
  let meta = null;
  try { meta = await parquetMetadata(file); } catch {}
  const geo = extractGeoParquetMeta(meta);
  const primaryColumn = geo?.primary_column || null;
  const colMeta = primaryColumn && geo?.columns ? geo.columns[primaryColumn] : null;
  if (colMeta?.encoding && colMeta.encoding !== "WKB") {
    console.warn(`geoparquet: geometry encoding "${colMeta.encoding}" は未対応です(WKB のみ)`);
  }
  const crsOk = !colMeta || geoParquetCrsIsWgs84(colMeta.crs);
  if (!crsOk) {
    console.warn("geoparquet: CRS が OGC:CRS84 と異なるため位置がずれる可能性があります", colMeta.crs ?? "(undefined)");
  }
  // 範囲読み: Range 応答が確認できた場合のみ部分結果を返してよい
  // (sawPartial=false の非対応サーバでは初回 slice が既に全量取得済み)
  let rows = null;
  let ranged = false;
  let postFilter = false;
  if (bounds?.ranges?.length && sawPartial && crsOk) {
    const refs = geoParquetCoveringPaths(colMeta);
    if (refs) {
      try {
        rows = await parquetReadObjects({
          file, compressors, metadata: meta, usePageIndex: true,
          filter: geoParquetCoveringFilter(refs, bounds),
        });
        ranged = true;
      } catch (error) {
        console.warn(`geoparquet 範囲読み(covering)失敗。全件へフォールバック: ${url}`, error);
      }
    } else {
      const runs = geoParquetStatPrunedRanges(meta, primaryColumn, bounds);
      if (runs) {
        try {
          const parts = [];
          for (const [s, e] of runs) {
            parts.push(await parquetReadObjects({ file, compressors, metadata: meta, rowStart: s, rowEnd: e }));
          }
          rows = parts.flat();
          ranged = true;
          postFilter = true; // グループ包絡は粗いので個別地物で厳密判定する
        } catch (error) {
          console.warn(`geoparquet 範囲読み(geospatial statistics)失敗。全件へフォールバック: ${url}`, error);
          rows = null;
          ranged = false;
        }
      }
    }
  }
  if (!rows) rows = await parquetReadObjects({ file, compressors, metadata: meta });
  if (!rows.length) return { geojson: { type: "FeatureCollection", features: [] }, header: geo, ranged };
  let geomColumn = primaryColumn;
  const isGeometryValue = value =>
    value instanceof Uint8Array || (value && typeof value === "object" && typeof value.type === "string" && ("coordinates" in value || "geometries" in value));
  const firstRow = rows[0];
  if (!geomColumn || !(geomColumn in firstRow)) {
    geomColumn = "geometry" in firstRow ? "geometry"
      : Object.keys(firstRow).find(key => isGeometryValue(firstRow[key]));
  }
  if (!geomColumn) throw new Error("ジオメトリ列が見つかりません");
  // 属性から除外する列: geo.columns に列挙された全ジオメトリ列(primary 以外の
  // 副ジオメトリ列は属性ではない)と covering.bbox 参照列(高速化用の内部列)
  const excludedCols = new Set(Object.keys(geo?.columns || {}));
  const coveringCol = geoParquetCoveringColumn(colMeta);
  if (coveringCol) excludedCols.add(coveringCol);
  const features = [];
  for (const row of rows) {
    const value = row[geomColumn];
    const geometry = value instanceof Uint8Array
      ? wkbToGeoJsonGeometry(value)
      : (isGeometryValue(value) ? value : null);
    if (!geometry) continue;
    if (postFilter) {
      // 行グループ統計は包絡でしかないため個別地物でも厳密に範囲判定する。
      // 包絡が取れないジオメトリは保守的に残す
      const env = geoJsonGeometryEnvelope(geometry);
      if (env && !(bounds.ranges.some(r => env[0] <= r.east && env[2] >= r.west)
        && env[1] <= bounds.north && env[3] >= bounds.south)) continue;
    }
    const properties = {};
    for (const key of Object.keys(row)) {
      if (key === geomColumn || excludedCols.has(key)) continue;
      properties[key] = sanitizeVectorPropertyValue(row[key]);
    }
    features.push({ type: "Feature", geometry, properties });
  }
  return { geojson: { type: "FeatureCollection", features }, header: geo, ranged };
}

// UTF-8 BOM 除去（BOM 付きテキストで1列目名・1行目へ \ufeff が混入するのを防ぐ）
const stripBom = t => (typeof t === "string" && t.charCodeAt(0) === 0xFEFF) ? t.slice(1) : t;

// RFC 4180 準拠の区切りテキストパーサ。"quoted" フィールド内の区切り・
// 改行・"" エスケープを正しく処理する（先頭行=ヘッダ）
function parseDelimited(text, delim) {
  const rows = [];
  let field = "", record = [], inQuotes = false;
  const src = stripBom(String(text || ""));
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      record.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field); field = "";
      if (record.some(v => v !== "")) rows.push(record);
      record = [];
    } else field += c;
  }
  record.push(field);
  if (record.some(v => v !== "")) rows.push(record);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).map(cells => {
    const row = {};
    head.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function loadCsvLike(text, delim) {
  const rows = parseDelimited(text, delim);
  const sample = rows[0] || {};
  const keys = Object.keys(sample);
  const lonKey = keys.find(k => /^(lon|lng|longitude|x|経度)$/i.test(k)) || keys.find(k => /lon|lng/i.test(k));
  const latKey = keys.find(k => /^(lat|latitude|y|緯度)$/i.test(k)) || keys.find(k => /^lat/i.test(k));
  if (!lonKey || !latKey) throw new Error("経度/緯度列を特定できません");
  const features = [];
  for (const row of rows) {
    const lon = Number(row[lonKey]);
    const lat = Number(row[latKey]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const { [lonKey]: _x, [latKey]: _y, ...props } = row;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });
  }
  return { type: "FeatureCollection", features };
}

// FeatureCollection の属性値を一括で正規化する
// GeoJSON オブジェクト → FeatureCollection 正規化。RFC 7946 §3 では
// FeatureCollection / Feature / 単体 Geometry のいずれも正当な GeoJSON テキスト。
// 下流(features 参照: 属性一覧・検索・where= 等)で共通して扱えるよう包む。
// トップレベルの外部メンバー(name/crs 等)はそのまま保持される
const GEOJSON_GEOMETRY_TYPES = new Set([
  "Point", "MultiPoint", "LineString", "MultiLineString",
  "Polygon", "MultiPolygon", "GeometryCollection",
]);
// simplestyle-spec §3: 色値は # 省略可("3bb2d0")。# 無しのまま各エンジンへ渡すと
// Cesium GeoJsonDataSource が load 全体を失敗させ、canvas/CSS パースでは黒化する
// ため、GeoJSON 系ロードの単一 chokepoint で # を補って正規化する
const _BARE_HEX_COLOR = /^[0-9a-f]{3}$|^[0-9a-f]{4}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i;
// icon-color は KML の aabbggrr 順のため # 前置すると順序が壊れる。
// 変換は消費側の kmlColorToCss(kasc.js)に一本化するため対象外とする
const _SS_COLOR_KEYS = ["marker-color", "stroke", "fill"];
export function normalizeSimpleStyleColors(fc) {
  for (const f of fc?.features || []) {
    const p = f?.properties;
    if (!p) continue;
    for (const k of _SS_COLOR_KEYS) {
      if (typeof p[k] === "string" && _BARE_HEX_COLOR.test(p[k].trim())) {
        p[k] = `#${p[k].trim()}`;
      }
    }
  }
  return fc;
}

export function normalizeGeoJsonToFeatureCollection(obj) {
  const fc = !obj || typeof obj !== "object" ? { type: "FeatureCollection", features: [] }
    : obj.type === "FeatureCollection" ? obj
    : obj.type === "Feature" ? { type: "FeatureCollection", features: [obj] }
    : GEOJSON_GEOMETRY_TYPES.has(obj.type)
      ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: obj, properties: {} }] }
      : { type: "FeatureCollection", features: [] };
  return normalizeSimpleStyleColors(fc);
}

// ---- OGC JSON-FG (Features and Geometries JSON / 21-045r1) ----
// place=宣言CRSのジオメトリ(GeoJSON型+Polyhedron/MultiPolyhedron/Prism/MultiPrism)、
// geometry=WGS84フォールバック、coordRefSys=place側のCRS宣言(URI|Reference|複合配列)、
// time={date|timestamp|interval}、conformsTo/featureType/links は外部メンバーとして保持。
// geometry がある feature はそれを使い、geometry が null で place が GeoJSON 型なら
// place を geometry へ昇格する。立体型は未対応のため警告する
const JSONFG_SOLID_TYPES = new Set(["Polyhedron", "MultiPolyhedron", "Prism", "MultiPrism"]);
const JSONFG_WGS84_CRS = /\/crs\/(OGC\/0\/CRS84h?|EPSG\/0\/(4326|4269|4612|6668))$/i;
function jsonFgCrsIsWgs84(ref) {
  const hrefs = [];
  const collect = v => {
    if (v == null) return;
    if (typeof v === "string") hrefs.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === "object") collect(v.href ?? v.uri ?? v.$ref);
  };
  collect(ref);
  return !hrefs.length || hrefs.every(h => JSONFG_WGS84_CRS.test(String(h)));
}
// FeatureCollection 正規化済み GeoJSON/JSON-FG 文書へ place/coordRefSys の意味付けを
// 適用する。戻り値 { isJsonFg, coordRefSys, warnings, placeResolved, unsupportedGeoms }
export function applyJsonFgSemantics(fc) {
  const out = { isJsonFg: false, coordRefSys: null, warnings: [], placeResolved: 0,
    prismResolved: 0, reprojected: 0, unsupportedGeoms: [], placeFeatures: new Set() };
  if (!fc || typeof fc !== "object") return out;
  const conform = fc.conformsTo;
  out.isJsonFg = (Array.isArray(conform) && conform.some(c => /json-?fg/i.test(String(c))))
    || fc.coordRefSys != null
    || (fc.features || []).some(f => f && (f.place != null || f.coordRefSys != null || f.conformsTo != null));
  const checkCrs = (ref, where) => {
    if (ref == null) return;
    out.coordRefSys = out.coordRefSys || ref;
    if (jsonFgCrsIsWgs84(ref)) return;
    const label = JSON.stringify(ref).slice(0, 200);
    if (!out.warnings.some(w => w.includes(label))) {
      out.warnings.push(`非WGS84の coordRefSys ${label} — 再投影を解決できない場合${where}の表示位置がずれます`);
    }
  };
  checkCrs(fc.coordRefSys, "place ジオメトリ");
  for (const f of fc.features || []) {
    if (!f) continue;
    checkCrs(f.coordRefSys, "place ジオメトリ");
    // time メンバー → properties.time へ昇格(time= フィルタ・属性表・時系列
    // 連携で扱えるよう。loadGpx の coordinateProperties.times 昇格と同じ規約)
    if (f.time != null) {
      const props = f.properties || (f.properties = {});
      if (props.time == null) props.time = f.time.date ?? f.time.timestamp ?? f.time.interval;
    }
    const place = f.place;
    if (place && typeof place === "object") {
      checkCrs(place.coordRefSys, "place ジオメトリ");
      if (f.geometry == null) {
        if (GEOJSON_GEOMETRY_TYPES.has(place.type)) {
          f.geometry = place; out.placeResolved++; out.placeFeatures.add(f);
        } else if (place.type === "Prism" || place.type === "MultiPrism") {
          // Prism={base,lower,upper} / MultiPrism={prisms:[Prism]} → base ジオメトリを
          // フットプリントとして昇格し、鉛直範囲を __kasc_z(下端)/__kasc_extrude(高さ)
          // へ保持する(Cesium entity 経路で押出し体積、2D ではフットプリント描画)
          const prisms = place.type === "Prism" ? [place] : (place.prisms || []);
          const bases = prisms.map(p => p?.base).filter(b => GEOJSON_GEOMETRY_TYPES.has(b?.type));
          if (bases.length) {
            f.geometry = bases.length === 1
              ? { type: bases[0].type, coordinates: bases[0].coordinates }
              : bases.every(b => b.type === "Polygon")
                ? { type: "MultiPolygon", coordinates: bases.map(b => b.coordinates) }
                : { type: "GeometryCollection", geometries: bases };
            const lows = prisms.map(p => Number(p?.lower ?? 0)).filter(Number.isFinite);
            const highs = prisms.map(p => Number(p?.upper)).filter(Number.isFinite);
            const props = f.properties || (f.properties = {});
            if (lows.length) props.__kasc_z = Math.min(...lows);
            if (highs.length) props.__kasc_extrude = Math.max(...highs) - (lows.length ? Math.min(...lows) : 0);
            out.prismResolved++; out.placeFeatures.add(f);
          } else {
            out.unsupportedGeoms.push(place.type);
          }
        } else {
          out.unsupportedGeoms.push(place.type || "unknown");
        }
      }
    }
  }
  if (out.unsupportedGeoms.length) {
    const uniq = [...new Set(out.unsupportedGeoms)];
    out.warnings.push(`未対応の JSON-FG ジオメトリ型が含まれます: ${uniq.join(", ")}`
      + `(geometry フォールバックの無い地物は描画されません)`);
  }
  return out;
}

// coordRefSys の非WGS84 → WGS84 再投影。place から昇格した geometry のみが対象
// (geometry メンバーは仕様上常に WGS84)。EPSG:3857/3785 系は数式、その他の EPSG は
// proj4(内蔵定義→epsg.io の proj4 定義取得)で解決する(GPKG と同じ優先順位)。
// 解決できた ref の警告を out.warnings から除去し、失敗したものは残す
const JSONFG_PROJ4_VERSION = "2.23.0";
let jsonFgProj4Promise = null;
function loadJsonFgProj4() {
  if (!jsonFgProj4Promise) {
    jsonFgProj4Promise = (async () => {
      const mod = await import(`https://cdn.jsdelivr.net/npm/proj4@${JSONFG_PROJ4_VERSION}/+esm`);
      return mod.default || mod.proj4 || mod;
    })();
    jsonFgProj4Promise.catch(() => { jsonFgProj4Promise = null; });
  }
  return jsonFgProj4Promise;
}
function jsonFgMercatorToLonLat(x, y) {
  const R = 6378137;
  return [x / R * 180 / Math.PI, (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * 180 / Math.PI];
}
// coordRefSys 値(URI文字列|{href}|複合配列)から EPSG コードを取り出す。
// "http://www.opengis.net/def/crs/EPSG/0/3857"・"EPSG/9.8.15/3857"・
// "urn:ogc:def:crs:EPSG::3857"・"EPSG:3857" の各形式を受理
function jsonFgCrsEpsgCode(ref) {
  const hrefs = [];
  const collect = v => {
    if (v == null) return;
    if (typeof v === "string") hrefs.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === "object") collect(v.href ?? v.uri ?? v.$ref);
  };
  collect(ref);
  for (const h of hrefs) {
    const m = String(h).match(/EPSG(?:\/[\d.]+)?\/(\d+)\s*$/i) || String(h).match(/EPSG::?0*\/?(\d+)\s*$/i);
    if (m) return Number(m[1]);
  }
  return null;
}
const jsonFgTransforms = new Map();
function jsonFgTransformFor(ref) {
  const key = JSON.stringify(ref);
  if (!jsonFgTransforms.has(key)) {
    jsonFgTransforms.set(key, (async () => {
      const code = jsonFgCrsEpsgCode(ref);
      if (!code) return null;
      if (code === 3857 || code === 3785 || code === 102100 || code === 900913)
        return { fn: jsonFgMercatorToLonLat, method: "EPSG:3857 数式" };
      try {
        const proj4 = await loadJsonFgProj4();
        const name = `EPSG:${code}`;
        try {
          const t = proj4(name, "EPSG:4326", [1000, 1000]);
          if (Array.isArray(t) && Number.isFinite(t[0]) && Number.isFinite(t[1]))
            return { fn: (x, y) => proj4(name, "EPSG:4326", [x, y]), method: "proj4 内蔵定義" };
        } catch {}
        const res = await fetch(`https://epsg.io/${code}.proj4`);
        const def = res.ok ? await res.text() : "";
        if (def && !/^\s*</.test(def)) {
          proj4.defs(name, def);
          const t = proj4(name, "EPSG:4326", [1000, 1000]);
          if (Array.isArray(t) && Number.isFinite(t[0]) && Number.isFinite(t[1]))
            return { fn: (x, y) => proj4(name, "EPSG:4326", [x, y]), method: "epsg.io 定義" };
        }
      } catch {}
      return null;
    })());
  }
  return jsonFgTransforms.get(key);
}
export async function reprojectJsonFg(fc, fg) {
  if (!fc || !fg?.isJsonFg || !fg.placeFeatures?.size) return;
  const cache = new Map();
  const resolvedKeys = [];
  for (const f of fg.placeFeatures) {
    const ref = f?.place?.coordRefSys ?? f?.coordRefSys ?? fc.coordRefSys;
    if (ref == null || jsonFgCrsIsWgs84(ref)) continue;
    const key = JSON.stringify(ref);
    if (!cache.has(key)) cache.set(key, await jsonFgTransformFor(ref));
    const tr = cache.get(key);
    if (tr?.fn && f.geometry) { transformGeoJsonGeometry(f.geometry, tr.fn); resolvedKeys.push(key); }
  }
  if (resolvedKeys.length) {
    const labels = [...new Set(resolvedKeys)].map(k => k.slice(0, 200));
    fg.warnings = fg.warnings.filter(w => !labels.some(l => w.includes(l)));
    fg.reprojected += resolvedKeys.length;
  }
}

function sanitizeFeatureCollection(fc) {
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    throw new Error("GeoJSON FeatureCollection ではありません");
  }
  for (const feature of fc.features) {
    if (!feature || !feature.geometry) continue;
    const props = feature.properties;
    if (props) for (const key of Object.keys(props)) props[key] = sanitizeVectorPropertyValue(props[key]);
  }
  fc.features = fc.features.filter(f => f && f.geometry);
  return fc;
}

// KML / KMZ → GeoJSON。KMZ(ZIP)は先頭の .kml エントリを展開する。
// @tmcw/togeojson は SimpleData/Style/simplestyle も properties へ写す
async function loadKml(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kml 取得失敗: ${res.status}`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  let xmlText;
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const { default: JSZip } = await import(JSZIP_URL);
    const zip = await JSZip.loadAsync(buf);
    const kmlFile = Object.values(zip.files).find(f => !f.dir && /\.kml$/i.test(f.name));
    if (!kmlFile) throw new Error("KMZ 内に .kml がありません");
    xmlText = stripBom(await kmlFile.async("text"));
  } else {
    xmlText = stripBom(new TextDecoder().decode(buf));
  }
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  if (dom.getElementsByTagName("parsererror").length) throw new Error("KML のパースに失敗しました");
  const { kml } = await import(TOGEOJSON_URL);
  return sanitizeFeatureCollection(kml(dom));
}

// GPX → GeoJSON。KML と同じ @tmcw/togeojson の gpx() を使う。
// waypoint/trackpoint/routepoint が地物になり、trkseg 結合の Track が入る
async function loadGpx(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gpx 取得失敗: ${res.status}`);
  const dom = new DOMParser().parseFromString(stripBom(await res.text()), "application/xml");
  if (dom.getElementsByTagName("parsererror").length) throw new Error("GPX のパースに失敗しました");
  const { gpx } = await import(TOGEOJSON_URL);
  const fc = sanitizeFeatureCollection(gpx(dom));
  // trkpt の時刻列は coordinateProperties.times（頂点単位）として返る。
  // time= オプション(地物単位フィルタ)で扱えるよう先頭時刻を properties.time へ昇格する
  for (const f of fc.features || []) {
    const t = f?.properties?.coordinateProperties?.times?.[0];
    if (t != null && f.properties.time == null) f.properties.time = t;
  }
  return fc;
}

// TopoJSON → GeoJSON。全 objects を1つの FeatureCollection へマージし、
// object 名を properties.__topoObject へ付ける（属性が無い地物の識別用）
async function loadTopojson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`topojson 取得失敗: ${res.status}`);
  const topo = await res.json();
  if (topo?.type !== "Topology" || !topo.objects) throw new Error("TopoJSON Topology ではありません");
  const { feature } = await import(TOPOJSON_URL);
  const features = [];
  for (const [name, obj] of Object.entries(topo.objects)) {
    const out = feature(topo, obj);
    const list = out?.type === "FeatureCollection" ? out.features : out ? [out] : [];
    for (const f of list) {
      if (!f?.geometry) continue;
      f.properties = { __topoObject: name, ...(f.properties || {}) };
      features.push(f);
    }
  }
  return sanitizeFeatureCollection({ type: "FeatureCollection", features });
}

// 行区切り GeoJSON（.geojsonl/.ndjson/.jsonl）。各行が Feature または
// FeatureCollection（ネスト展開）。空行・コメント行(#)は読み飛ばす
async function loadGeojsonl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geojsonl 取得失敗: ${res.status}`);
  const text = stripBom(await res.text());
  const features = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj?.type === "FeatureCollection") features.push(...(obj.features || []));
    else if (obj?.type === "Feature") features.push(obj);
    else if (obj?.type && obj?.coordinates) features.push({ type: "Feature", geometry: obj, properties: {} });
  }
  return sanitizeFeatureCollection({ type: "FeatureCollection", features });
}

// GeoJSON テキストシーケンス(RFC 8142 / application/geo+json-seq)。
// RS(0x1E) 区切りの完全な GeoJSON オブジェクト列。各要素は
// Feature/FeatureCollection/Geometry のいずれでもよい(ネスト展開)
async function loadGeoJsonSeq(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geojsonseq 取得失敗: ${res.status}`);
  const text = stripBom(await res.text());
  const features = [];
  for (const chunk of text.split("")) {
    const s = chunk.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    features.push(...normalizeGeoJsonToFeatureCollection(obj).features);
  }
  return sanitizeFeatureCollection({ type: "FeatureCollection", features });
}

// EsriJSON（ArcGIS フィーチャ形式）→ GeoJSON。Geometry 単体・FeatureSet・
// Feature の配列のいずれも受け付ける（attributes/geometry の組で認識）
async function loadEsriJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`esrijson 取得失敗: ${res.status}`);
  const json = await res.json();
  // spatialReference 検出: arcgisToGeoJSON は座標を再投影しないため、
  // 4326 以外の wkid/latestWkid は誤配置になる。警告して誤認を防ぐ
  {
    const srsValues = [];
    const collectSr = o => {
      const sr = o && typeof o === "object" ? o.spatialReference : null;
      if (sr) srsValues.push(sr.wkid ?? sr.latestWkid ?? (sr.wkt ? "wkt" : null));
    };
    collectSr(json);
    for (const it of Array.isArray(json) ? json : [json]) {
      collectSr(it); collectSr(it?.geometry); collectSr(it?.feature);
      for (const feat of it?.features || []) { collectSr(feat); collectSr(feat?.geometry); }
    }
    const bad = [...new Set(srsValues.filter(v => v != null && Number(v) !== 4326))];
    if (bad.length) {
      console.warn(`EsriJSON (${url}): 非 WGS84 の spatialReference (wkid=${bad.join(",")}) — 再投影未対応のため表示位置がずれます`);
    }
  }
  const { arcgisToGeoJSON } = await import(ARCGIS_URL);
  const items = Array.isArray(json) ? json : [json];
  const features = [];
  for (const item of items) {
    if (!item) continue;
    try {
      const out = arcgisToGeoJSON(item);
      if (out?.type === "FeatureCollection") features.push(...out.features);
      else if (out?.type === "Feature") features.push(out);
      else if (out?.type) features.push({ type: "Feature", geometry: out, properties: {} });
    } catch { /* 非地図オブジェクトは読み飛ばす */ }
  }
  if (!features.length) throw new Error("EsriJSON から地物を取得できません");
  return sanitizeFeatureCollection({ type: "FeatureCollection", features });
}

// CZML → GeoJSON。各 packet の position/polyline/polygon/path/corridor を
// 静的地物へ変換する。時刻付きサンプル列（[epoch?, t, v, t, v, …]）は
// 軌跡として LineString に、静的配列はそのまま使う。
// プロパティには packet の id/name/description/availability を残す
function czmlPositions(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value
    : value.cartographicDegrees || value.cartographicRadians
      || value.cartesian || value.reference || null;
  if (!Array.isArray(raw)) return null;
  const isRadians = Array.isArray(value?.cartographicRadians);
  const per = value?.cartesian ? 3 : (value?.cartographicDegrees || value?.cartographicRadians) ? 3 : 3;
  // 時刻サンプル列か判定: 先頭が ISO 日時文字列・数値列の長さが per より大きく 4 で割り切れる
  let vals = raw;
  if (typeof raw[0] === "string" && isNaN(Number(raw[0]))) vals = raw.slice(1);
  const nums = vals.map(Number).filter(v => !isNaN(v));
  if (nums.length !== vals.length || nums.length < per) return null;
  const pts = [];
  const step = nums.length > per ? 4 : per;
  for (let i = 0; i + per <= nums.length; i += step) {
    let [x, y, z] = [nums[i], nums[i + 1], nums[i + 2]];
    if (isRadians) { x = x * 180 / Math.PI; y = y * 180 / Math.PI; }
    // cartesian はメートル ECEF — 変換は省略し近似値として扱わない（捨てる）
    if (value?.cartesian) return null;
    pts.push(z != null ? [x, y, z] : [x, y]);
  }
  return pts.length ? pts : null;
}

async function loadCzml(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`czml 取得失敗: ${res.status}`);
  const packets = await res.json();
  if (!Array.isArray(packets)) throw new Error("CZML パケット列ではありません");
  const features = [];
  for (const p of packets) {
    if (!p || p.document) continue; // document パケット(時計/設定)は地物ではない
    const props = {};
    for (const k of ["id", "name", "description", "availability"]) {
      if (p[k] != null) props[k] = typeof p[k] === "object" ? JSON.stringify(p[k]) : p[k];
    }
    let geometry = null;
    if (p.position) {
      const pts = czmlPositions(p.position);
      if (pts) geometry = pts.length > 1 ? { type: "LineString", coordinates: pts } : { type: "Point", coordinates: pts[0] };
    }
    if (!geometry) for (const key of ["polyline", "path"]) {
      const pts = czmlPositions(p[key]?.positions);
      if (pts?.length) { geometry = { type: "LineString", coordinates: pts }; break; }
    }
    if (!geometry && p.polygon) {
      const pts = czmlPositions(p.polygon.positions);
      if (pts?.length >= 3) {
        const ring = pts.slice();
        const [a, b] = [ring[0], ring[ring.length - 1]];
        if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a);
        geometry = { type: "Polygon", coordinates: [ring] };
      }
    }
    if (!geometry && p.corridor) {
      const pts = czmlPositions(p.corridor.positions);
      if (pts?.length) geometry = { type: "LineString", coordinates: pts };
    }
    if (!geometry) for (const key of ["point", "billboard", "label", "ellipse", "ellipsoid", "box", "cylinder", "model", "rectangle", "wall"]) {
      if (p[key]) { const pts = czmlPositions(p.position ?? p[key]?.position); if (pts) { geometry = { type: "Point", coordinates: pts[0] }; break; } }
    }
    if (geometry) features.push({ type: "Feature", geometry, properties: props });
  }
  if (!features.length) throw new Error("CZML から地物を取得できません");
  return sanitizeFeatureCollection({ type: "FeatureCollection", features });
}

// WKT テキスト → GeoJSON ジオメトリ。POINT/LINESTRING/POLYGON/MULTI*の
// 2〜4次元(Z/M は 3列目以降を捨てる)・GEOMETRYCOLLECTION に対応する小さなパーサ
function parseWkt(text) {
  const s = String(text).trim();
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const word = () => { ws(); const m = /^[A-Za-z]+/.exec(s.slice(i)); if (m) i += m[0].length; return m ? m[0].toUpperCase() : null; };
  const num = () => { ws(); const m = /^[-+0-9.eE]+/.exec(s.slice(i)); if (!m) return null; i += m[0].length; return Number(m[0]); };
  const lparen = () => { ws(); if (s[i] === "(") { i++; return true; } return false; };
  const rparen = () => { ws(); if (s[i] === ")") { i++; return true; } return false; };
  const comma = () => { ws(); if (s[i] === ",") { i++; return true; } return false; };
  const coord = () => {
    const x = num(), y = num(), z = num();
    return x == null || y == null ? null : (z == null ? [x, y] : [x, y, z]);
  };
  const coordList = () => {
    if (!lparen()) return null;
    const list = [];
    for (;;) { const c = coord(); if (!c) return null; list.push(c); if (!comma()) break; }
    return rparen() ? list : null;
  };
  const nested = inner => {
    if (!lparen()) return null;
    const list = [];
    for (;;) { const v = inner(); if (v == null) return null; list.push(v); if (!comma()) break; }
    return rparen() ? list : null;
  };
  function geomAny() {
    const type = word();
    if (!type) return null;
    const marker = word(); // Z / M / ZM 次元マーカー（任意）
    ws();
    if (/^EMPTY$/i.test(marker || "")) return { type: "GeometryCollection", geometries: [] };
    switch (type) {
      case "POINT": {
        if (!lparen()) return null;
        const c = coord();
        return c && rparen() ? { type: "Point", coordinates: c } : null;
      }
      case "LINESTRING": { const v = coordList(); return v ? { type: "LineString", coordinates: v } : null; }
      case "POLYGON": { const v = nested(coordList); return v ? { type: "Polygon", coordinates: v } : null; }
      case "MULTIPOINT": {
        // MULTIPOINT((x y),(x y)) と MULTIPOINT(x y, x y) の両形式
        ws();
        if (s[i] === "(" && s[i + 1] === "(") { const v = nested(coord); return v ? { type: "MultiPoint", coordinates: v } : null; }
        const v = coordList(); return v ? { type: "MultiPoint", coordinates: v } : null;
      }
      case "MULTILINESTRING": { const v = nested(coordList); return v ? { type: "MultiLineString", coordinates: v } : null; }
      case "MULTIPOLYGON": { const v = nested(() => nested(coordList)); return v ? { type: "MultiPolygon", coordinates: v } : null; }
      case "GEOMETRYCOLLECTION": { const v = nested(geomAny); return v ? { type: "GeometryCollection", geometries: v } : null; }
      default: return null;
    }
  }
  return geomAny();
}

// .wkt ファイル → GeoJSON。1ファイル=1WKT、または1行=1WKT（#はコメント）。
// WKT 列のない属性は取らない（シンプル化）
async function loadWkt(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wkt 取得失敗: ${res.status}`);
  const text = stripBom(await res.text());
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const candidates = lines.length > 1 ? lines : [text.trim()];
  const features = [];
  for (const line of candidates) {
    const g = parseWkt(line);
    if (g) features.push({ type: "Feature", geometry: g, properties: {} });
  }
  if (!features.length) throw new Error("WKT から地物を取得できません");
  return sanitizeFeatureCollection({ type: "FeatureCollection", features });
}

// .wkb ファイル（バイナリまたは hex テキスト）→ GeoJSON。
// デコードは shared/vector-decode.js の wkbToGeoJsonGeometry
async function loadWkb(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wkb 取得失敗: ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const head = stripBom(new TextDecoder().decode(bytes.slice(0, Math.min(64, bytes.length)))).trim();
  const meta = {};
  let geoms = [];
  if (/^[0-9a-fA-F\s]+$/.test(head) && head.length > 8) {
    // hex テキスト（複数行可）。連結して1ジオメトリとして解釈
    const hex = new TextDecoder().decode(bytes).replace(/[^0-9a-fA-F]/g, "");
    const raw = new Uint8Array(hex.length / 2);
    for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    geoms = [wkbToGeoJsonGeometry(raw, meta)].filter(Boolean);
  } else {
    // バイナリ: 先頭ジオメトリ1件（複数連結 WKB は未対応）
    const g = wkbToGeoJsonGeometry(bytes, meta);
    if (g) geoms = [g];
  }
  if (meta.srid != null && meta.srid !== 4326 && meta.srid !== 0) {
    console.warn(`WKB: EWKB SRID=${meta.srid} — 非 WGS84 のため表示位置がずれます(再投影未対応)`);
  }
  if (!geoms.length) throw new Error("WKB から地物を取得できません");
  return sanitizeFeatureCollection({ type: "FeatureCollection", features: geoms.map(g => ({ type: "Feature", geometry: g, properties: {} })) });
}

// Shapefile(.zip 一式 / .shp+sidecar / ベース名URL) → GeoJSON。
// shpjs は URL 文字列を受けると .zip 判定・拡張子補完(sidecar 自動取得)・
// .prj に基づく WGS84 への再投影まで内部で行う
async function loadShp(url) {
  const mod = await import(SHP_URL);
  const shp = mod.default || mod.getShapefile;
  const clean = String(url).split(/[?#]/)[0];
  const merge = out => {
    // zip に複数レイヤーがある場合は FeatureCollection の配列が返るため統合する
    const fc = Array.isArray(out)
      ? { type: "FeatureCollection", features: out.flatMap(x => (x && x.features) || []) }
      : out;
    return sanitizeFeatureCollection(fc);
  };
  // .prj(座標系定義)欠落の検出 — 無い場合は WGS84 前提となり誤配置の恐れがある
  if (/\.zip$/i.test(clean)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`shp 取得失敗: ${res.status}`);
    const buf = await res.arrayBuffer();
    try {
      const { default: JSZip } = await import(JSZIP_URL);
      const zip = await JSZip.loadAsync(buf);
      if (!Object.keys(zip.files).some(n => /\.prj$/i.test(n))) {
        console.warn(`SHP (${url}): .prj(座標系定義)がありません — WGS84 前提で描画します`);
      }
    } catch { /* zip 検査失敗は無視(後段の shpjs が処理) */ }
    return merge(await shp(buf));
  }
  try {
    const base = clean.replace(/\.(shp|dbf)$/i, "");
    const prjRes = await fetch(`${base}.prj`);
    if (!prjRes.ok) console.warn(`SHP (${url}): .prj(座標系定義)がありません — WGS84 前提で描画します`);
  } catch { /* 確認不能は警告しない */ }
  return merge(await shp(url));
}

// OGC WFS → GeoJSON。wfs:タイトル|エンドポイント|typename=名|version=|maxfeatures=|
// cql_filter=|srsname=|outputformat= 。GET の GetFeature(outputFormat=json 系)のみ
async function loadWfs(item, url) {
  const opts = item.opts || {};
  const typeNames = opts.typename || opts.typenames || opts.layer || opts.name;
  if (!typeNames) throw new Error("wfs: typename= の指定が必要です");
  const version = /^\d/.test(opts.version || "") ? opts.version : "2.0.0";
  const limit = opts.count || opts.maxfeatures;
  const autoPaging = /^(auto|on|true|1)$/i.test(String(opts.paging || ""));
  const pageSize = Number(limit) || 0;
  const firstIndex = Math.max(0, Number(opts.startindex) || 0) | 0;
  const build = (outputFormat, startIndex) => {
    const params = new URLSearchParams();
    params.set("service", "WFS");
    params.set("request", "GetFeature");
    params.set("version", version);
    params.set(version.startsWith("2") ? "typeNames" : "typeName", typeNames);
    params.set("outputFormat", outputFormat);
    params.set("srsName", opts.srsname || "EPSG:4326");
    if (limit) params.set(version.startsWith("2") ? "count" : "maxFeatures", limit);
    const cql = opts.cql_filter || opts.cqlfilter;
    if (cql) params.set("cql_filter", cql);
    const prop = opts.propertyname || opts.propertynames || opts.props;
    if (prop) params.set("propertyName", prop);
    if (opts.bbox) params.set("bbox", opts.bbox);
    if (startIndex > 0) params.set("startIndex", String(startIndex));
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${params.toString()}`;
  };
  const formats = opts.outputformat
    ? [opts.outputformat]
    : ["application/json", "application/json; subtype=geojson", "geojson", "json"];
  let lastError = null;
  for (const fmt of formats) {
    // paging=auto + count= で startIndex を進めて全頁回収(最大100頁)
    const merged = [];
    let startIndex = firstIndex;
    for (let page = 0; page < 100; page++) {
      const res = await fetch(build(fmt, startIndex));
      if (!res.ok) { lastError = new Error(`WFS GetFeature 失敗: ${res.status}`); break; }
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json && (json.type === "FeatureCollection" || json.type === "Feature")) {
          const fc = json.type === "Feature" ? { type: "FeatureCollection", features: [json] } : json;
          merged.push(...(fc.features || []));
          if (!autoPaging || !pageSize || (fc.features || []).length < pageSize) {
            return sanitizeFeatureCollection({ type: "FeatureCollection", features: merged });
          }
          startIndex += pageSize;
          continue;
        }
        lastError = new Error("WFS 応答が GeoJSON ではありません");
      } catch {
        // JSON 以外（GML/XML）の応答は ol/format/WFS でパースする（JSON 非対応の
        // WFS サーバーでも読める。出力は GeoJSON 正規化で統一）
        if (/^\s*</.test(text)) {
          try {
            const gj = await loadGmlText(text, opts);
            if (gj.features?.length) return sanitizeFeatureCollection(gj);
          } catch (e) { lastError = e; }
        }
        lastError = lastError || new Error("WFS 応答が GeoJSON ではありません");
      }
      break;
    }
  }
  throw lastError || new Error("WFS GetFeature 失敗");
}

// ---- ol/format 遅延ロード（CDN ESM・openlayers エンジンと同一バージョン）----
// IGC/Polyline/GML/WFS(XML) を ol/format でパースし GeoJSON 化する。
// ol 本体は大きいため、これらの形式が実際に出てきたときだけロードする
const OL_FORMAT_BASE = "https://cdn.jsdelivr.net/npm/ol@10.11.0/format";
let _olFmt = null;
async function loadOlFormats() {
  if (_olFmt) return _olFmt;
  const [IGC, Polyline, GML, WFS, GeoJSON, Feature] = await Promise.all([
    import(`${OL_FORMAT_BASE}/IGC.js`),
    import(`${OL_FORMAT_BASE}/Polyline.js`),
    import(`${OL_FORMAT_BASE}/GML.js`),
    import(`${OL_FORMAT_BASE}/WFS.js`),
    import(`${OL_FORMAT_BASE}/GeoJSON.js`),
    import("https://cdn.jsdelivr.net/npm/ol@10.11.0/Feature.js"),
  ]);
  _olFmt = { IGC: IGC.default, Polyline: Polyline.default, GML: GML.default, WFS: WFS.default, GeoJSON: GeoJSON.default, Feature: Feature.default };
  return _olFmt;
}

// 座標清掃: 位置配列は [x,y,(z)] までの有限数値のみ残す。
// 非有限要素(null/NaN)を含む位置は丸ごと除去 — エンジン側(Cesium
// DeveloperError/Leaflet Invalid LatLng)を出さないための安全弁
function cleanOlPosition(pos) {
  if (!Array.isArray(pos) || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return null;
  const out = [pos[0], pos[1]];
  if (Number.isFinite(pos[2])) out.push(pos[2]);
  return out;
}
function cleanOlCoordList(coords, depth) {
  if (depth === 0) return cleanOlPosition(coords);
  const out = [];
  for (const c of coords || []) {
    const v = cleanOlCoordList(c, depth - 1);
    if (v != null && (!Array.isArray(v) || v.length)) out.push(v);
  }
  return out;
}
const OL_GEOM_DEPTH = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
function cleanOlGeometry(g) {
  if (!g) return;
  if (g.type === "GeometryCollection") { (g.geometries || []).forEach(cleanOlGeometry); return; }
  const d = OL_GEOM_DEPTH[g.type];
  if (d != null && Array.isArray(g.coordinates)) g.coordinates = cleanOlCoordList(g.coordinates, d);
}
// 全座標の x↔y を入れ替える（GML の axisorder=lonlat 救済用）
function swapOlGeometryXY(g) {
  if (!g) return;
  if (g.type === "GeometryCollection") { (g.geometries || []).forEach(swapOlGeometryXY); return; }
  const walk = c => { if (typeof c[0] === "number") { const t = c[0]; c[0] = c[1]; c[1] = t; } else c.forEach(walk); };
  if (Array.isArray(g.coordinates)) walk(g.coordinates);
}

// ol Feature[] → GeoJSON FeatureCollection（readFeatures 時に
// featureProjection=EPSG:4326 を指定しているため既に WGS84）。
// 出力は必ず座標清掃を通す
function olFeaturesToGeoJSON(ol, feats) {
  const fc = new ol.GeoJSON().writeFeaturesObject(feats || []);
  for (const f of fc.features || []) cleanOlGeometry(f.geometry);
  return fc;
}

// IGC（グライダー飛行ログ）: B レコードの時刻+緯度経度+高度 → LineString(XYZM)。
// flight metadata（PLT/GTY/DTE 等のヘッダ）は properties に載る
async function loadIgc(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`IGC ${res.status}`);
  const ol = await loadOlFormats();
  const text = stripBom(await res.text());
  // B レコードから高度を自前抽出(ol/format/IGC は高度を保持しない)。
  // 位置: B(1)+時刻(6)+緯度(8)+経度(9)+A/V(1)+気圧高度(5)+GNSS高度(5)
  const bAlts = [];
  for (const line of text.split(/\r?\n/)) {
    if (line[0] !== "B") continue;
    const palt = Number(line.slice(25, 30));
    const galt = Number(line.slice(30, 35));
    bAlts.push({ palt: Number.isFinite(palt) ? palt : null, galt: Number.isFinite(galt) ? galt : null });
  }
  let altIdx = 0;
  const feats = new ol.IGC().readFeatures(text, {
    featureProjection: "EPSG:4326", dataProjection: "EPSG:4326",
  });
  // IGC ジオメトリは XYM レイアウト（M=時刻 epoch 秒、高度は ol 非保持）。
  // writeFeaturesObject は M を第3座標へ書いてしまうため、フラット座標から
  // [x,y]+GNSS高度(Z) を再構成する（時刻=properties.time・高度=properties.alt
  // としても保持）
  const gj = { type: "FeatureCollection", features: [] };
  for (const f of feats || []) {
    const g = f.getGeometry?.();
    const props = { ...f.getProperties() };
    delete props.geometry;
    if (!g || g.getType?.() !== "LineString") {
      const fc = olFeaturesToGeoJSON(ol, [f]);
      gj.features.push(...fc.features);
      continue;
    }
    const flat = g.getFlatCoordinates();
    const stride = g.getStride?.() || 2; // XYM=3
    const coords = [];
    const times = [];
    const alts = [];
    for (let i = 0; i + 1 < flat.length; i += stride) {
      const rec = bAlts[altIdx + coords.length];
      const z = rec ? (rec.galt ?? rec.palt) : null;
      const c = [flat[i], flat[i + 1]];
      if (z != null) c.push(z);
      coords.push(c);
      alts.push(z);
      if (stride >= 3 && Number.isFinite(flat[i + 2])) times.push(flat[i + 2]);
    }
    altIdx += coords.length;
    if (times.length) props.time = times;
    if (alts.some(a => a != null)) props.alt = alts;
    gj.features.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
  }
  return gj;
}

// エンコードドポリライン（Google Polyline Algorithm）。ファイルは1行1本の
// エンコード文字列を想定（複数行は各地物化）。factor=/geometryLayout= で
// 精度・座標次元を指定可能（既定 1e5/XY）
async function loadPolyline(url, opts = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`polyline ${res.status}`);
  const ol = await loadOlFormats();
  const fmt = new ol.Polyline({
    factor: opts.factor ? Number(opts.factor) : undefined,
    geometryLayout: opts.geometryLayout || opts.layout || undefined,
  });
  const lines = stripBom(await res.text()).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const feats = [];
  for (const line of lines) {
    try {
      feats.push(...fmt.readFeatures(line, { dataProjection: "EPSG:4326", featureProjection: "EPSG:4326" }));
    } catch {}
  }
  return olFeaturesToGeoJSON(ol, feats);
}

// GML（OGC 地物 XML・WFS GetFeature の GML 応答も同様）。srsName は文書宣言を
// 参照し ol が 4326 へ再投影する。GML 仕様上 EPSG:4326 の座標順は lat,lon だが
// lon,lat で書く実例も多い — axisorder=lonlat で全座標 x↔y を入れ替えられる
async function loadGmlText(text, opts = {}) {
  text = stripBom(text);
  const ol = await loadOlFormats();
  // 先に WFS FeatureCollection として試し、駄目なら素の GML として読む
  const tryRead = fmt => {
    try { return fmt.readFeatures(text, { featureProjection: "EPSG:4326" }); } catch { return null; }
  };
  const feats = tryRead(new ol.WFS()) || tryRead(new ol.GML()) || [];
  const fc = olFeaturesToGeoJSON(ol, feats);
  if (/^(lonlat|xy)$/i.test(opts.axisorder || "")) {
    for (const f of fc.features || []) swapOlGeometryXY(f.geometry);
  }
  return fc;
}

async function loadGml(url, opts = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GML ${res.status}`);
  return loadGmlText(await res.text(), opts);
}

const BBOX_OFF_RE = /^(off|none|false|static|manual)$/i;

// 表示範囲連動クエリ(bbox=auto / :bbox プレースホルダ)が有効な行か。
// gpkg:/duckdb: は bbox=off 系の明示指定が無い限り既定で viewport 絞り込み
export function isViewportQueryItem(item) {
  if (!item) return false;
  if (item.type === "sql") return /:bbox\b/i.test(item.url || "");
  if (item.type === "duckdb" || item.type === "gpkg" || item.type === "geopackage") {
    return !BBOX_OFF_RE.test(String(item.opts?.bbox ?? "auto"));
  }
  // flatgeobuf:/fgb: も空間インデックス+Range で部分読みできるため既定 ON。
  // 索引なし・Range 非対応は読み込み時に全件へフォールバックする
  if (item.type === "flatgeobuf" || item.type === "fgb") {
    return !BBOX_OFF_RE.test(String(item.opts?.bbox ?? "auto"));
  }
  // geoparquet:/parquet: も covering.bbox 列または行グループ geospatial
  // statistics があれば部分読みできるため既定 ON。どちらも無い平 WKB・
  // Range 非対応サーバは読み込み時に全件へフォールバックする
  if (item.type === "geoparquet" || item.type === "parquet") {
    return !BBOX_OFF_RE.test(String(item.opts?.bbox ?? "auto"));
  }
  return false;
}

// sql: 行のクエリ末尾に付く "| off" / "| attr=..." を除去する(kasc_loader.js と同じ規則)
const SQL_TAIL_RE = /\|\s*(off|false|attr(?:ibution)?\s*=[^|]*|cluster\s*=\s*[a-z0-9]+|heat(?:map)?\s*=\s*[a-z0-9]+|render\s*=\s*[a-z]+|style\s*=\s*[^|]*|time(?:_end|_span)?\s*=\s*[^|]*)\s*$/i;
function stripSqlTail(query) {
  let q = String(query || "");
  for (;;) {
    const m = SQL_TAIL_RE.exec(q);
    if (!m) return q;
    q = q.slice(0, m.index).trim();
  }
}

// ---- ogrsql: OGR SQL SELECT 文のクライアント実行(shared/ogr-sql.js) ----

// ファイルパス → loadVectorItem の行タイプ(拡張子判定)
function ogrFileType(path) {
  const clean = String(path || "").split(/[?#]/)[0];
  if (/\.(fgb|flatgeobuf|fgbz|zst)$/i.test(clean)) return "flatgeobuf";
  if (/\.(parquet|geoparquet)$/i.test(clean)) return "geoparquet";
  if (/\.gpkg$/i.test(clean)) return "gpkg";
  if (/\.(kml)$/i.test(clean)) return "kml";
  if (/\.(kmz)$/i.test(clean)) return "kmz";
  if (/\.(gpx)$/i.test(clean)) return "gpx";
  if (/\.(czml)$/i.test(clean)) return "czml";
  if (/\.(topojson)$/i.test(clean)) return "topojson";
  if (/\.(esrijson|arcgis)$/i.test(clean)) return "esrijson";
  if (/\.igc$/i.test(clean)) return "igc";
  if (/\.(polyline|encodedpolyline)$/i.test(clean)) return "polyline";
  if (/\.gml$/i.test(clean)) return "gml";
  if (/\.(geojsonl|ndjson|jsonl)$/i.test(clean)) return "geojsonl";
  if (/\.(fgseq|geojsonseq|jsonseq|geojson-seq)$/i.test(clean)) return "geojsonseq";
  if (/\.jsonfg$/i.test(clean)) return "geojson";
  if (/\.(wkt)$/i.test(clean)) return "wkt";
  if (/\.(wkb)$/i.test(clean)) return "wkb";
  if (/\.(zip|shp|dbf)$/i.test(clean)) return "shp";
  if (/\.tsv$/i.test(clean)) return "tsv";
  if (/\.csv$/i.test(clean)) return "csv";
  return "geojson";
}

// FROM 名 → 候補パス。パスらしい名前(/・拡張子・scheme あり)はそのまま。
// 裸のレイヤー名は canvas_data/<名>.<形式> を順に試す
function ogrSourceCandidates(name) {
  const n = String(name || "").trim();
  if (!n) return [];
  const looksPath = /[/\\]/.test(n) || /^[a-z][a-z0-9+.-]*:/i.test(n)
    || /\.(geojson|json|fgb|flatgeobuf|fgbz|zst|parquet|geoparquet|gpkg|kml|kmz|gpx|czml|topojson|esrijson|arcgis|geojsonl|ndjson|jsonl|fgseq|geojsonseq|jsonseq|wkt|wkb|igc|polyline|gml|zip|shp|dbf|csv|tsv)$/i.test(n);
  if (looksPath) return [n];
  return [
    `canvas_data/${n}.geojson`, `canvas_data/${n}.fgb`, `canvas_data/${n}.parquet`,
    `canvas_data/${n}.gpkg`, `canvas_data/${n}.kml`, `canvas_data/${n}.gpx`, `canvas_data/${n}.csv`,
    `DATA/${n}.geojson`, `DATA/${n}.fgb`, `DATA/${n}.parquet`,
    `DATA/${n}.gpkg`, `DATA/${n}.kml`, `DATA/${n}.gpx`, `DATA/${n}.csv`, n,
  ];
}

// ogrsql: の FROM 解決リゾルバを作る。戻り値は resolveSource(ref) 関数。
// ref = {name, alias?, source?('ds'.layer 形式のデータソース)}。
// 解決順: resolveLayer フック(読み込み済みレイヤータイトル照合・QGIS 等)
// → 'ds'.layer はファイル+レイヤー名(gpkg table= 等)としてデコード
// → パス/拡張子推測でファイルをデコード
export function createOgrSourceResolver({ baseUrl, bounds = null, resolveLayer = null } = {}) {
  const decodePath = async (path, table) => {
    const it = {
      type: ogrFileType(path),
      title: table || path,
      url: path,
      opts: table ? { table } : {},
    };
    return (await loadVectorItem(it, baseUrl, bounds)).geojson;
  };
  return async ref => {
    if (ref.source) {
      // 'ds'.layer 形式: ファイル + レイヤー名(gpkg の table= 等)
      return decodePath(ref.source, ref.name);
    }
    if (resolveLayer) {
      const fc = await resolveLayer(ref.name);
      if (fc) return fc;
    }
    let lastError = null;
    for (const path of ogrSourceCandidates(ref.name)) {
      try { return await decodePath(path); }
      catch (e) { lastError = e; }
    }
    throw lastError || new Error(`ogrsql: テーブル "${ref.name}" を解決できません`);
  };
}

// parseKasc の item → KascLoader.load 用アイテム（相対参照は絶対URLへ解決済み）
function toKascLoaderItem(item, baseUrl, bounds) {
  const opts = item.opts || {};
  const it = {
    id: `kasc-${Math.random().toString(36).slice(2)}`,
    type: item.type,
    title: item.title,
    visible: item.visible !== false,
    sourceLine: item.line,
    where: opts.where || undefined,
    geom: opts.geom || opts.geometry || undefined,
    lon: opts.lon || opts.lng || undefined,
    lat: opts.lat || undefined,
    format: opts.format || undefined,
    gpkgTable: opts.table || undefined,
    columns: opts.columns ? opts.columns.split(",").map(s => s.trim()).filter(Boolean) : undefined,
    covering: opts.covering ? opts.covering.split(",").map(s => s.trim()).filter(Boolean) : undefined,
    // GPKG 埋め込みスタイル選択(style= 外部指定優先/gpkgstyle= 名前指定)
    style: opts.style || undefined,
    gpkgstyle: opts.gpkgstyle || undefined,
    limit: Number.isInteger(Number(opts.limit)) ? Math.floor(Number(opts.limit)) : undefined,
    bboxAuto: isViewportQueryItem(item),
    bboxBounds: null,
  };
  if (it.bboxAuto) it.bboxBounds = bounds || null;
  if (item.type === "sql") {
    // クエリ内の相対ファイル参照をプロジェクト基準の絶対URLへ解決(httpfs経由で読める形に)
    it.query = stripSqlTail(item.url)
      .replace(/'((?:\.\.?\/|(?:canvas_data|DATA)\/)[^']+)'/gi, (_, ref) => `'${resolveKascUrl(ref, baseUrl)}'`);
  } else {
    it.url = resolveKascUrl(item.url, baseUrl);
  }
  return it;
}

// item(.kasc 行) → GeoJSON FeatureCollection
// GPKG 埋め込みスタイル(layer_styles.styleQML または .styleSLD)を
// compileQmlStyle 互換 spec へコンパイルする。QML は loadQmlStyle の画像
// ロード経路に乗せ、SLD は sld-style.js のサブセットパーサで処理する。
// style= 明示指定が無い場合にだけ呼ばれる前提(外部優先)
export async function compileEmbeddedStyle(loaded, baseUrl, engine = null) {
  if (loaded?.qml) {
    const { loadQmlStyle } = await import("./qml-style.js");
    // baseUrl は埋め込み QML 内の相対リソース解決基準として使う
    return loadQmlStyle(baseUrl, async () => loaded.qml, engine);
  }
  if (loaded?.sld) {
    const { compileSldStyle } = await import("./sld-style.js");
    return compileSldStyle(loaded.sld, baseUrl, engine, loaded.symbolImages || null);
  }
  return null;
}

// 戻り値: { geojson, qml?, sld?, viewportQuery? } （gpkg は埋め込み QML/SLD があれば返す。
// viewportQuery=true の行は表示範囲の移動に合わせて再読込が必要）
// hooks.resolveLayer(name) = ogrsql: の FROM 名を読み込み済みレイヤーの
// FeatureCollection へ解決する任意フック(エンジン側のレイヤー照合)
// Re:Earth CMS .geojson モデル API の全頁回収。
// - URL に page=/start_cursor=/limit= が明示済みなら1頁のみ(従来通り)
// - hasNext/totalCount/links.next/nextCursor 等の継続指標があれば追従
// - 指標が無くても page=N を繰り上げて試行し、空頁・部分頁・前頁と同一の
//   応答(=サーバが page を無視)で打ち止め。上限100頁
async function collectCmsGeoJson(item, url, firstObj, headers) {
  const merged = normalizeGeoJsonToFeatureCollection(firstObj);
  if (/[?&](page|start_cursor|offset|limit|per_?page)=/i.test(url)) return merged;
  const fcOf = obj => normalizeGeoJsonToFeatureCollection(obj);
  const hasNext = obj => {
    if (!obj || typeof obj !== "object") return null;
    if (obj.hasNext === true || obj.has_next === true) return true;
    if (obj.hasNext === false || obj.has_next === false) return false;
    const total = Number(obj.totalCount ?? obj.total);
    if (Number.isFinite(total)) return merged.features.length < total;
    const links = Array.isArray(obj.links) ? obj.links : [];
    const nx = links.find(l => l && (l.rel === "next" || l.relation === "next") && l.href);
    return nx ? nx.href : null;
  };
  const pageUrl = n => {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}page=${n}`;
  };
  let obj = firstObj;
  let pageLen = merged.features.length; // 前頁の地物数(部分頁検出用)
  for (let page = 2; page <= 100; page++) {
    const nx = hasNext(obj);
    if (nx === false) break;
    // links.next の href があればそれを使い、無ければ page=N を試行
    const next = typeof nx === "string" ? nx : pageUrl(page);
    const res = await fetch(next, headers ? { headers } : undefined);
    if (!res.ok) break;
    const obj2 = await res.json();
    const fc2 = fcOf(obj2);
    if (!fc2.features.length) break;
    // page= を無視するサーバは毎回同じ1頁目を返す → 重複検出して打ち止め
    if (page === 2 && fc2.features.length === merged.features.length
        && JSON.stringify(fc2.features[0] ?? null) === JSON.stringify(merged.features[0] ?? null)) break;
    merged.features.push(...fc2.features);
    obj = obj2;
    // 継続指標が無い場合は満頁(=前頁と同件数)のみ継続し、部分頁で打ち止め
    if (nx == null && fc2.features.length < pageLen) break;
    pageLen = fc2.features.length;
  }
  return merged;
}

export async function loadVectorItem(item, baseUrl, bounds = null, hooks = null) {
  const url = resolveKascUrl(item.url, baseUrl);
  const type = item.type;
  if (type === "geojson" || type === "layer") {
    const cmsHeaders = item.opts?.key ? { authorization: `Bearer ${item.opts.key}` }
      : item.headers || undefined;
    const res = await fetch(url, cmsHeaders ? { headers: cmsHeaders } : undefined);
    if (!res.ok) throw new Error(`${item.title}: ${res.status}`);
    const first = await res.json();
    // cms: 行は .geojson モデル API のため複数頁を自動回収する
    const fc = item.cms ? await collectCmsGeoJson(item, url, first, cmsHeaders)
      : normalizeGeoJsonToFeatureCollection(first);
    const fg = applyJsonFgSemantics(fc);
    await reprojectJsonFg(fc, fg);
    if (fg.warnings.length) console.warn(`JSON-FG (${item.title}): ${fg.warnings.join(" / ")}`);
    if (fg.isJsonFg) item.jsonfg = fg;
    return { geojson: fc };
  }
  if (type === "flatgeobuf" || type === "fgb") {
    const viewportQuery = isViewportQueryItem(item);
    // proxy=on: ローカルサーバーの /api/fetch 経由で取得(CORS回避・Range転送。
    // duckdb:/geotiff: と同じ opt-in 規約)。nocache=on: Range バッファ無効化。
    // key=<APIキー>: Bearer 認証ヘッダ(cms: 行と同じ規約・DeserializeOptions.headers へ接続)
    const fgbOpts = {
      proxy: /^(on|true|yes|1)$/i.test(String(item.opts?.proxy ?? "")),
      nocache: /^(on|true|yes|1)$/i.test(String(item.opts?.nocache ?? "")),
      key: item.opts?.key || undefined,
    };
    const result = await loadFlatGeobuf(url, viewportQuery ? bounds : null, fgbOpts);
    // ヘッダメタ(件数/索引有無/列定義/CRS/envelope)を item 上に保持し、
    // 各エンジンのレイヤー一覧(listLayers)や情報表示から参照できるようにする
    if (result.header) item.fgbHeader = result.header;
    // 範囲読みへフォールバックできなかった(索引なし・Range 非対応)場合は
    // 結果が常に全件なので再クエリしても無駄。viewportQuery=false で通知する
    return { geojson: result.geojson, viewportQuery: viewportQuery && result.ranged, header: result.header };
  }
  if (type === "geoparquet" || type === "parquet") {
    const viewportQuery = isViewportQueryItem(item);
    const result = await loadGeoParquet(url, viewportQuery ? bounds : null);
    // geo メタ(version/crs/encoding/covering 等)を item 上に保持し、
    // レイヤー一覧(listLayers)や情報表示から参照できるようにする
    if (result.header) item.geoHeader = result.header;
    // covering/geospatial statistics・Range のどれかが無く全件に落ちたときは
    // 再クエリしても無駄なので viewportQuery=false で通知する(fgb と同じ印)
    return { geojson: result.geojson, viewportQuery: viewportQuery && result.ranged, header: result.header };
  }
  if (type === "gpkg" || type === "geopackage") {
    const opts = item.opts || {};
    const viewportQuery = isViewportQueryItem(item);
    const result = await gpkgCommand({
      cmd: "load",
      url,
      table: opts.table,
      where: opts.where,
      limit: opts.limit ? Number(opts.limit) : undefined,
      columns: opts.columns ? opts.columns.split(",").map(s => s.trim()) : undefined,
      bbox: viewportQuery ? bounds || undefined : undefined,
      // 埋め込みスタイル(layer_styles)は style= 外部指定が無い場合に取得。
      // gpkgstyle=styleName で layer_styles 内の任意スタイルを選択可
      wantStyle: !opts.style || !!opts.gpkgstyle,
      styleName: opts.gpkgstyle || undefined,
    });
    // Worker 側で重複排除済みの未対応警告(非経緯度CRS/拡張/タイル行列等)を console へ
    if (result.warnings?.length) console.warn(`GPKG (${item.title}): ${result.warnings.join(" / ")}`);
    item.gpkgMeta = {
      kind: result.kind || "features",
      srs: result.srs || null,
      extensions: result.extensions || [],
      columnMeta: result.columnMeta || null,
      styles: result.styles || null,
      styleName: result.styleName || null,
      styleNames: result.styleNames || null,
    };
    // gpkg_data_columns の列タイトルを属性パネルの列名エイリアスへ補完(QML alias 優先)
    if (result.columnMeta) {
      const fm = item.fieldMeta || (item.fieldMeta = {});
      const alias = fm.alias || (fm.alias = {});
      for (const [col, m] of Object.entries(result.columnMeta)) {
        if (m?.title && !alias[col]) alias[col] = m.title;
      }
    }
    return { ...result, viewportQuery };
  }
  if (type === "kml" || type === "kmz") {
    return { geojson: await loadKml(url) };
  }
  if (type === "gpx") {
    return { geojson: await loadGpx(url) };
  }
  if (type === "czml") {
    return { geojson: await loadCzml(url) };
  }
  if (type === "topojson") {
    return { geojson: await loadTopojson(url) };
  }
  if (type === "esrijson" || type === "arcgis") {
    return { geojson: await loadEsriJson(url) };
  }
  if (type === "geojsonl" || type === "ndjson" || type === "jsonl") {
    const fc = await loadGeojsonl(url);
    const fg = applyJsonFgSemantics(fc);
    await reprojectJsonFg(fc, fg);
    if (fg.warnings.length) console.warn(`JSON-FG (${item.title}): ${fg.warnings.join(" / ")}`);
    if (fg.isJsonFg) item.jsonfg = fg;
    return { geojson: fc };
  }
  if (type === "geojsonseq" || type === "fgseq" || type === "geojson-seq") {
    const fc = await loadGeoJsonSeq(url);
    const fg = applyJsonFgSemantics(fc);
    await reprojectJsonFg(fc, fg);
    if (fg.warnings.length) console.warn(`JSON-FG (${item.title}): ${fg.warnings.join(" / ")}`);
    if (fg.isJsonFg) item.jsonfg = fg;
    return { geojson: fc };
  }
  if (type === "wkt") {
    return { geojson: await loadWkt(url) };
  }
  if (type === "wkb") {
    return { geojson: await loadWkb(url) };
  }
  if (type === "igc") {
    return { geojson: await loadIgc(url) };
  }
  if (type === "polyline" || type === "encodedpolyline") {
    return { geojson: await loadPolyline(url, item.opts) };
  }
  if (type === "gml") {
    return { geojson: await loadGml(url, item.opts) };
  }
  if (type === "wfs") {
    return { geojson: await loadWfs(item, url) };
  }
  if (type === "shp" || type === "shapefile") {
    return { geojson: await loadShp(url) };
  }
  if (type === "csv" || type === "tsv") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${item.title}: ${res.status}`);
    return { geojson: loadCsvLike(await res.text(), type === "tsv" ? "\t" : ",") };
  }
  if (type === "duckdb" || type === "sql") {
    if (!window.KascLoader) await import("./kasc_loader.js");
    const it = toKascLoaderItem(item, baseUrl, bounds);
    const geojson = await window.KascLoader.load(it);
    const out = { geojson, viewportQuery: it.bboxAuto };
    // gpkg 由来(duckdb:+format=gpkg 等)は Worker が返した埋め込みスタイル
    // (layer_styles QML/SLD)を通常 gpkg: 経路と同じ形で返す
    const g = it._gpkgLoadRes;
    if (g) {
      out.qml = g.qml; out.sld = g.sld;
      out.styleName = g.styleName; out.styleNames = g.styleNames;
      out.styles = g.styles; out.columnMeta = g.columnMeta; out.extensions = g.extensions;
      item.gpkgMeta = {
        kind: g.kind || "features", srs: g.srs || null,
        extensions: g.extensions || [], columnMeta: g.columnMeta || null,
        styles: g.styles || null, styleName: g.styleName || null,
        styleNames: g.styleNames || null,
      };
    }
    return out;
  }
  if (type === "ogrsql") {
    // OGR SQL SELECT 文。主経路はブラウザ内 JS 実装(shared/ogr-sql.js)で、
    // CDN 単体利用でも QGIS 有無で挙動が変わらないよう常に先に実行する。
    // JS で解決できない FROM(QGIS プロジェクトレイヤー・ローカル SHP 等)
    // や JS パーサ未対応の構文だけ、ローカル QGIS Live の GDAL 本体
    // ExecuteSQL(dialect="OGRSQL") へフォールバックする。
    // FROM はレイヤータイトル照合(resolveLayer フック)→ 'ds'.layer 形式
    // → ファイルパス推測の順に解決する
    const query = stripSqlTail(item.url);
    const { executeOgrSelect } = await import("./ogr-sql.js");
    const resolve = createOgrSourceResolver({
      baseUrl, bounds, resolveLayer: hooks?.resolveLayer || null,
    });
    try {
      return { geojson: await executeOgrSelect(query, resolve) };
    } catch (jsErr) {
      const { runOgrSqlViaQgis } = await import("./qgis-ogr.js");
      const viaQgis = await runOgrSqlViaQgis(query, async ref =>
        (!ref.source && hooks?.resolveLayer ? hooks.resolveLayer(ref.name) : null),
        path => resolveKascUrl(path, baseUrl));
      if (viaQgis) return { geojson: viaQgis };
      throw jsErr;
    }
  }
  throw new Error(`未対応のベクター形式: ${type}`);
}
