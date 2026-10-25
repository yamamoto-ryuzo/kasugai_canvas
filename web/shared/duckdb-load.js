// duckdb:/sql: 行 → GeoJSON FeatureCollection（DuckDB-Wasm 経由・エンジン非依存）
// ファイル参照は fetch で取得して registerFileBuffer に登録（httpfs/CORS 非依存）
import { wkbToGeoJsonGeometry } from "./vector-decode.js";
import { resolveKascUrl } from "./kasc.js";

const DUCKDB_URL = "https://esm.sh/@duckdb/duckdb-wasm@1.30.0";
let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const duckdb = await import(DUCKDB_URL);
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const worker = new Worker(URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
      ));
      const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      return db;
    })();
  }
  return dbPromise;
}

// SQL 内のファイル参照 'path' を解決・登録し、仮想ファイル名へ書き換える
async function registerSqlFiles(db, sql, baseUrl) {
  const files = new Map();
  const re = /'((?:\.\.\/|\.\/|DATA\/|https?:\/\/)[^']+\.(?:parquet|csv|json|geojson|gpkg|fgb))'/gi;
  const rewritten = sql.replace(re, (_, ref) => {
    const name = `file_${files.size}`;
    files.set(name, ref);
    return `'${name}'`;
  });
  for (const [name, ref] of files) {
    const res = await fetch(resolveKascUrl(ref, baseUrl));
    if (!res.ok) throw new Error(`${ref}: ${res.status}`);
    await db.registerFileBuffer(name, new Uint8Array(await res.arrayBuffer()));
  }
  return rewritten;
}

function rowsToFeatures(rows, item) {
  const opts = item.opts || {};
  const features = [];
  const geomKey = opts.geom || "geometry";
  const lonKey = opts.lon || "lon";
  const latKey = opts.lat || "lat";
  for (const row of rows) {
    let geom = null;
    const raw = row[geomKey] ?? row.geom ?? row.geometry;
    if (raw instanceof Uint8Array || ArrayBuffer.isView(raw)) {
      geom = wkbToGeoJsonGeometry(raw);
    } else if (typeof raw === "string") {
      try { geom = JSON.parse(raw); } catch (_) { /* WKT 等は未対応 */ }
    } else if (raw && raw.type) {
      geom = raw;
    }
    if (!geom) {
      const lon = Number(row[lonKey]), lat = Number(row[latKey]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) geom = { type: "Point", coordinates: [lon, lat] };
    }
    if (!geom || !geom.type) continue;
    features.push({ type: "Feature", geometry: geom, properties: row });
  }
  return { type: "FeatureCollection", features };
}

function buildDuckdbSql(item, baseUrl) {
  const opts = item.opts || {};
  if (item.type === "sql") return item.url; // url フィールドに SQL 全文が入っている
  // duckdb: → SELECT 文を組み立て（FROM はファイル参照として登録対象）
  const source = `'${item.url}'`;
  const cols = opts.columns ? opts.columns.split(",").map(s => s.trim()).join(", ") : "*";
  const parts = [`SELECT ${cols} FROM ${source}`];
  if (opts.where) parts.push(`WHERE ${opts.where}`);
  if (opts.limit) parts.push(`LIMIT ${Number(opts.limit)}`);
  return parts.join(" ");
}

export async function loadDuckdbItem(item, baseUrl) {
  const db = await getDb();
  const sql = await registerSqlFiles(db, buildDuckdbSql(item, baseUrl), baseUrl);
  const conn = await db.connect();
  try {
    const result = await conn.query(sql);
    return { geojson: rowsToFeatures(result.toArray(), item) };
  } finally {
    await conn.close();
  }
}
