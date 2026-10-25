// ベクター系 .kasc 行 → GeoJSON FeatureCollection（エンジン非依存ローダー）
// 対象: geojson:/layer: / geoparquet:/parquet: / flatgeobuf:/fgb: / gpkg:/geopackage: /
//       csv:/tsv: / duckdb: / sql:
// duckdb:/sql: のクエリ実行は window.KascLoader(shared/kasc_loader.js) へ委譲する。
// bounds = {ranges:[{west,east}],south,north} は bbox=auto/:bbox 系の表示範囲として使う
import { wkbToGeoJsonGeometry } from "./vector-decode.js";
import { resolveKascUrl } from "./kasc.js";

const FGB_URL = "https://esm.sh/flatgeobuf@3.36.0/lib/mjs/geojson.js";
const HYPARQUET_URL = "https://cdn.jsdelivr.net/npm/hyparquet@1.30.1/+esm";
const HYPARQUET_COMPRESSORS_URL = "https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/+esm";

let gpkgWorker = null;
let gpkgReqId = 0;
const gpkgPending = new Map();

function ensureGpkgWorker() {
  if (!gpkgWorker) {
    gpkgWorker = new Worker("./gpkg-worker.js", { type: "module" });
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

async function loadFlatGeobuf(url) {
  const mod = await import(FGB_URL);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`flatgeobuf 取得失敗: ${res.status}`);
  const fc = { type: "FeatureCollection", features: [] };
  for await (const feature of mod.deserialize(res.body)) {
    if (feature) fc.features.push(feature);
  }
  return fc;
}

async function loadGeoParquet(url) {
  const [hp, hc] = await Promise.all([import(HYPARQUET_URL), import(HYPARQUET_COMPRESSORS_URL)]);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geoparquet 取得失敗: ${res.status}`);
  const rows = await hp.parquetReadObjects({ file: await res.arrayBuffer(), compressors: hc.compressors });
  return toFeatureCollection(rows);
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

const BBOX_OFF_RE = /^(off|none|false|static|manual)$/i;

// 表示範囲連動クエリ(bbox=auto / :bbox プレースホルダ)が有効な行か。
// gpkg:/duckdb: は bbox=off 系の明示指定が無い限り既定で viewport 絞り込み
export function isViewportQueryItem(item) {
  if (!item) return false;
  if (item.type === "sql") return /:bbox\b/i.test(item.url || "");
  if (item.type === "duckdb" || item.type === "gpkg" || item.type === "geopackage") {
    return !BBOX_OFF_RE.test(String(item.opts?.bbox ?? "auto"));
  }
  return false;
}

// sql: 行のクエリ末尾に付く "| off" / "| attr=..." を除去する(kasc_loader.js と同じ規則)
const SQL_TAIL_RE = /\|\s*(off|false|attr(?:ibution)?\s*=[^|]*)\s*$/i;
function stripSqlTail(query) {
  let q = String(query || "");
  for (;;) {
    const m = SQL_TAIL_RE.exec(q);
    if (!m) return q;
    q = q.slice(0, m.index).trim();
  }
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
      .replace(/'((?:\.\.?\/|DATA\/)[^']+)'/gi, (_, ref) => `'${resolveKascUrl(ref, baseUrl)}'`);
  } else {
    it.url = resolveKascUrl(item.url, baseUrl);
  }
  return it;
}

// item(.kasc 行) → GeoJSON FeatureCollection
// 戻り値: { geojson, qml?, viewportQuery? } （gpkg は埋め込み QML があれば返す。
// viewportQuery=true の行は表示範囲の移動に合わせて再読込が必要）
export async function loadVectorItem(item, baseUrl, bounds = null) {
  const url = resolveKascUrl(item.url, baseUrl);
  const type = item.type;
  if (type === "geojson" || type === "layer") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${item.title}: ${res.status}`);
    return { geojson: await res.json() };
  }
  if (type === "flatgeobuf" || type === "fgb") {
    return { geojson: await loadFlatGeobuf(url) };
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
  throw new Error(`未対応のベクター形式: ${type}`);
}
