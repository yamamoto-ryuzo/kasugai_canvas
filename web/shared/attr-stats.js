// 属性統計・集計（GROUP BY 相当）— 全エンジン共通の純粋計算部
// 読み込み済み GeoJSON Feature の properties を集計する。
// DuckDB 等の外部エンジンは使わず JS 集計に留める（ブラウザ完結・追加コストなし）

const INTERNAL_PROP_RE = /^__kasc/;

// 数値として集計可能か（整数・小数・指数表記・空白前後ありを許容）
function numericValue(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// features から属性フィールド一覧を収集する。
// 戻り値: { all: [全フィールド名], numeric: [数値として解釈できる地物が1件以上あるフィールド] }
export function collectFields(features) {
  const all = new Set();
  const numeric = new Set();
  for (const f of features || []) {
    const props = f?.properties;
    if (!props) continue;
    for (const [key, value] of Object.entries(props)) {
      if (INTERNAL_PROP_RE.test(key)) continue;
      all.add(key);
      if (!numeric.has(key) && numericValue(value) !== null) numeric.add(key);
    }
  }
  return { all: [...all].sort((a, b) => a.localeCompare(b)), numeric: [...numeric].sort((a, b) => a.localeCompare(b)) };
}

// groupField でグルーピングし、件数 + valueField の sum/avg/min/max を返す。
// valueField 未指定(null/"")なら件数のみ。戻り値はキー昇順の配列。
// [{ key, count, sum, min, max, avg }]（valueField 無指定時 sum/min/max/avg は null）
export function computeGroupStats(features, groupField, valueField) {
  if (!groupField) return [];
  const groups = new Map();
  for (const f of features || []) {
    const props = f?.properties || {};
    const raw = props[groupField];
    const key = raw == null ? "" : (typeof raw === "object" ? JSON.stringify(raw) : String(raw));
    let g = groups.get(key);
    if (!g) { g = { key, count: 0, sum: 0, min: Infinity, max: -Infinity, numeric: 0 }; groups.set(key, g); }
    g.count++;
    if (valueField) {
      const n = numericValue(props[valueField]);
      if (n !== null) {
        g.sum += n;
        g.numeric++;
        if (n < g.min) g.min = n;
        if (n > g.max) g.max = n;
      }
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: "base" }))
    .map(g => ({
      key: g.key,
      count: g.count,
      sum: g.numeric ? g.sum : null,
      min: g.numeric ? g.min : null,
      max: g.numeric ? g.max : null,
      avg: g.numeric ? g.sum / g.numeric : null,
      numeric: g.numeric,
    }));
}
