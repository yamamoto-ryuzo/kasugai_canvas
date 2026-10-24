// ベクター系 .kasc 行 → GeoJSON FeatureCollection（エンジン非依存ローダー）
// 対象: geoparquet:/parquet: / flatgeobuf:/fgb: / gpkg:/geopackage: / csv:/tsv:
// duckdb:/sql: はクエリ系のため別レイヤ（未対応として呼び出し側で報告）
import { wkbToGeoJsonGeometry } from "/shared/vector-decode.js";
import { resolveKascUrl } from "/shared/kasc.js";

const FGB_URL = "https://esm.sh/flatgeobuf@3.36.0/lib/mjs/geojson.js";
const HYPARQUET_URL = "https://esm.sh/hyparquet@1.19.2";

let gpkgWorker = null;
let gpkgReqId = 0;
const gpkgPending = new Map();

function ensureGpkgWorker() {
  if (!gpkgWorker) {
    gpkgWorker = new Worker("/shared/gpkg-worker.js", { type: "module" });
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
    const { geometry: _g, geom: _g2, ...props } = row;
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
  const { parquetReadObjects } = await import(HYPARQUET_URL);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geoparquet 取得失敗: ${res.status}`);
  const rows = await parquetReadObjects({ file: await res.arrayBuffer() });
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

// item(.kasc 行) → GeoJSON FeatureCollection
// 戻り値: { geojson, qml? } （gpkg は埋め込み QML があれば返す）
export async function loadVectorItem(item, baseUrl) {
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
    const result = await gpkgCommand({
      cmd: "load",
      url,
      table: opts.table,
      where: opts.where,
      limit: opts.limit ? Number(opts.limit) : undefined,
      columns: opts.columns ? opts.columns.split(",").map(s => s.trim()) : undefined,
      bbox: opts.bbox === "off" ? undefined : (opts.bbox === "auto" || !opts.bbox ? "auto" : opts.bbox),
      wantStyle: !!opts.style,
    });
    return result;
  }
  if (type === "csv" || type === "tsv") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${item.title}: ${res.status}`);
    return { geojson: loadCsvLike(await res.text(), type === "tsv" ? "\t" : ",") };
  }
  if (type === "duckdb" || type === "sql") {
    const { loadDuckdbItem } = await import("/shared/duckdb-load.js");
    return loadDuckdbItem(item, baseUrl);
  }
  throw new Error(`未対応のベクター形式: ${type}`);
}
