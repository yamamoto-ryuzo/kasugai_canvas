// ベクター系 .kasc 行 → GeoJSON FeatureCollection（エンジン非依存ローダー）
// 対象: geojson:/layer: / geoparquet:/parquet: / flatgeobuf:/fgb: / gpkg:/geopackage: /
//       csv:/tsv: / duckdb: / sql: / kml:/kmz: / gpx: / czml: / topojson: /
//       esrijson:/arcgis: / geojsonl:/ndjson:/jsonl: / wkt: / wkb: / wfs: / shp:
// duckdb:/sql: のクエリ実行は window.KascLoader(shared/kasc_loader.js) へ委譲する。
// bounds = {ranges:[{west,east}],south,north} は bbox=auto/:bbox 系の表示範囲として使う
import { wkbToGeoJsonGeometry, sanitizeVectorPropertyValue } from "./vector-decode.js";
import { resolveKascUrl } from "./kasc.js";

const FGB_URL = "https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/lib/mjs/geojson.js/+esm";
const HYPARQUET_URL = "https://cdn.jsdelivr.net/npm/hyparquet@1.31.5/+esm";
const HYPARQUET_COMPRESSORS_URL = "https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.2/+esm";
const TOGEOJSON_URL = "https://cdn.jsdelivr.net/npm/@tmcw/togeojson@7.1.3/+esm";
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
const SHP_URL = "https://cdn.jsdelivr.net/npm/shpjs@6.1.0/+esm";
const TOPOJSON_URL = "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm";
const ARCGIS_URL = "https://cdn.jsdelivr.net/npm/@terraformer/arcgis@2.1.2/+esm";

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
// 戻り値 { geojson, ranged }: ranged=false は再クエリしても同じ全件になる印
async function loadFlatGeobuf(url, bounds = null) {
  const { deserialize } = await import(FGB_URL);
  const fc = { type: "FeatureCollection", features: [] };
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
  const rects = flatgeobufRects(bounds);
  if (rects) {
    try {
      const seen = rects.length > 1 ? new Set() : null;
      for (const rect of rects) await collect(deserialize(url, { rect }), seen);
      return { geojson: fc, ranged: true };
    } catch (error) {
      console.warn(`flatgeobuf 範囲読み失敗(索引なし・Range 非対応等)。全件へフォールバック: ${url}`, error);
      fc.features.length = 0;
    }
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`flatgeobuf 取得失敗: ${res.status}`);
  await collect(deserialize(res.body), null);
  return { geojson: fc, ranged: false };
}

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

// Cesium 版と同一実装: Range Request 対応の非同期バッファを優先し、
// geo メタデータの primary_column でジオメトリ列を特定する
async function loadGeoParquet(url) {
  const { parquetReadObjects, parquetMetadata, asyncBufferFromUrl, compressors } = await loadHyparquet();
  let file;
  try {
    file = await asyncBufferFromUrl({ url });
  } catch {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`geoparquet 取得失敗: ${res.status}`);
    file = await res.arrayBuffer();
  }
  const rows = await parquetReadObjects({ file, compressors });
  if (!rows.length) return { type: "FeatureCollection", features: [] };
  let geomColumn = null;
  try {
    const meta = await parquetMetadata(file);
    const kv = meta && (meta.key_value_metadata || meta.metadata || []);
    const entry = Array.isArray(kv)
      ? kv.find(item => item.key === "geo")
      : (kv instanceof Map ? { value: kv.get("geo") } : null);
    const rawGeo = entry && entry.value;
    const geoText = rawGeo instanceof Uint8Array ? new TextDecoder().decode(rawGeo) : rawGeo;
    const geo = geoText ? JSON.parse(geoText) : null;
    if (geo && geo.primary_column) geomColumn = geo.primary_column;
  } catch {}
  const isGeometryValue = value =>
    value instanceof Uint8Array || (value && typeof value === "object" && typeof value.type === "string" && ("coordinates" in value || "geometries" in value));
  const firstRow = rows[0];
  if (!geomColumn || !(geomColumn in firstRow)) {
    geomColumn = "geometry" in firstRow ? "geometry"
      : Object.keys(firstRow).find(key => isGeometryValue(firstRow[key]));
  }
  if (!geomColumn) throw new Error("ジオメトリ列が見つかりません");
  const features = [];
  for (const row of rows) {
    const value = row[geomColumn];
    const geometry = value instanceof Uint8Array
      ? wkbToGeoJsonGeometry(value)
      : (isGeometryValue(value) ? value : null);
    if (!geometry) continue;
    const properties = {};
    for (const key of Object.keys(row)) {
      if (key === geomColumn) continue;
      properties[key] = sanitizeVectorPropertyValue(row[key]);
    }
    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

function parseDelimited(text, delim) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(delim).map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const cells = line.split(delim).map(c => c.trim().replace(/^"|"$/g, ""));
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
    xmlText = await kmlFile.async("text");
  } else {
    xmlText = new TextDecoder().decode(buf);
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
  const dom = new DOMParser().parseFromString(await res.text(), "application/xml");
  if (dom.getElementsByTagName("parsererror").length) throw new Error("GPX のパースに失敗しました");
  const { gpx } = await import(TOGEOJSON_URL);
  return sanitizeFeatureCollection(gpx(dom));
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
  const text = await res.text();
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

// EsriJSON（ArcGIS フィーチャ形式）→ GeoJSON。Geometry 単体・FeatureSet・
// Feature の配列のいずれも受け付ける（attributes/geometry の組で認識）
async function loadEsriJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`esrijson 取得失敗: ${res.status}`);
  const json = await res.json();
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
  const text = await res.text();
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
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(64, bytes.length))).trim();
  let geoms = [];
  if (/^[0-9a-fA-F\s]+$/.test(head) && head.length > 8) {
    // hex テキスト（複数行可）。連結して1ジオメトリとして解釈
    const hex = new TextDecoder().decode(bytes).replace(/[^0-9a-fA-F]/g, "");
    const raw = new Uint8Array(hex.length / 2);
    for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    geoms = [wkbToGeoJsonGeometry(raw)].filter(Boolean);
  } else {
    // バイナリ: 先頭ジオメトリ1件（複数連結 WKB は未対応）
    const g = wkbToGeoJsonGeometry(bytes);
    if (g) geoms = [g];
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
  const out = await shp(url);
  // zip に複数レイヤーがある場合は FeatureCollection の配列が返るため統合する
  const fc = Array.isArray(out)
    ? { type: "FeatureCollection", features: out.flatMap(x => (x && x.features) || []) }
    : out;
  return sanitizeFeatureCollection(fc);
}

// OGC WFS → GeoJSON。wfs:タイトル|エンドポイント|typename=名|version=|maxfeatures=|
// cql_filter=|srsname=|outputformat= 。GET の GetFeature(outputFormat=json 系)のみ
async function loadWfs(item, url) {
  const opts = item.opts || {};
  const typeNames = opts.typename || opts.typenames || opts.layer || opts.name;
  if (!typeNames) throw new Error("wfs: typename= の指定が必要です");
  const version = /^\d/.test(opts.version || "") ? opts.version : "2.0.0";
  const build = outputFormat => {
    const params = new URLSearchParams();
    params.set("service", "WFS");
    params.set("request", "GetFeature");
    params.set("version", version);
    params.set(version.startsWith("2") ? "typeNames" : "typeName", typeNames);
    params.set("outputFormat", outputFormat);
    params.set("srsName", opts.srsname || "EPSG:4326");
    const limit = opts.count || opts.maxfeatures;
    if (limit) params.set(version.startsWith("2") ? "count" : "maxFeatures", limit);
    const cql = opts.cql_filter || opts.cqlfilter;
    if (cql) params.set("cql_filter", cql);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${params.toString()}`;
  };
  const formats = opts.outputformat
    ? [opts.outputformat]
    : ["application/json", "application/json; subtype=geojson", "geojson", "json"];
  let lastError = null;
  for (const fmt of formats) {
    const res = await fetch(build(fmt));
    if (!res.ok) { lastError = new Error(`WFS GetFeature 失敗: ${res.status}`); continue; }
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (json && (json.type === "FeatureCollection" || json.type === "Feature")) {
        return sanitizeFeatureCollection(
          json.type === "Feature" ? { type: "FeatureCollection", features: [json] } : json);
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
  const feats = new ol.IGC().readFeatures(await res.text(), {
    featureProjection: "EPSG:4326", dataProjection: "EPSG:4326",
  });
  // IGC ジオメトリは XYM レイアウト（M=時刻 epoch 秒、高度は ol 非保持）。
  // writeFeaturesObject は M を第3座標へ書いてしまうため、フラット座標から
  // [x,y] のみ再構成する（時刻は properties.time として付けておく）
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
    for (let i = 0; i + 1 < flat.length; i += stride) {
      coords.push([flat[i], flat[i + 1]]);
      if (stride >= 3 && Number.isFinite(flat[i + 2])) times.push(flat[i + 2]);
    }
    if (times.length) props.time = times;
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
  const lines = (await res.text()).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
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
  if (/\.(fgb|flatgeobuf)$/i.test(clean)) return "flatgeobuf";
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
    || /\.(geojson|json|fgb|flatgeobuf|parquet|geoparquet|gpkg|kml|kmz|gpx|czml|topojson|esrijson|arcgis|geojsonl|ndjson|jsonl|wkt|wkb|igc|polyline|gml|zip|shp|dbf|csv|tsv)$/i.test(n);
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
// 戻り値: { geojson, qml?, viewportQuery? } （gpkg は埋め込み QML があれば返す。
// viewportQuery=true の行は表示範囲の移動に合わせて再読込が必要）
// hooks.resolveLayer(name) = ogrsql: の FROM 名を読み込み済みレイヤーの
// FeatureCollection へ解決する任意フック(エンジン側のレイヤー照合)
export async function loadVectorItem(item, baseUrl, bounds = null, hooks = null) {
  const url = resolveKascUrl(item.url, baseUrl);
  const type = item.type;
  if (type === "geojson" || type === "layer") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${item.title}: ${res.status}`);
    return { geojson: await res.json() };
  }
  if (type === "flatgeobuf" || type === "fgb") {
    const viewportQuery = isViewportQueryItem(item);
    const result = await loadFlatGeobuf(url, viewportQuery ? bounds : null);
    // 範囲読みへフォールバックできなかった(索引なし・Range 非対応)場合は
    // 結果が常に全件なので再クエリしても無駄。viewportQuery=false で通知する
    return { geojson: result.geojson, viewportQuery: viewportQuery && result.ranged };
  }
  if (type === "geoparquet" || type === "parquet") {
    return { geojson: await loadGeoParquet(url) };
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
      wantStyle: !!opts.style,
    });
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
    return { geojson: await loadGeojsonl(url) };
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
    return { geojson, viewportQuery: it.bboxAuto };
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
