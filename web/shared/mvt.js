// web/shared/mvt.js — MVT / PMTiles ベクトルタイル → Cesium ImageryLayer (issue #24)
//
// CesiumJS は MVT をネイティブ描画できないため、タイルを自前デコードして
// canvas へラスタライズし、ImageryProvider 経由で globe へ重ねる。
// PMTiles は Range リクエストで部分読み出しする単一ファイルアーカイブで、
// 納品用ローカル化(単一 .pmtiles を DATA/ に置く)との相性が良い。
// 依存は利用時に CDN から遅延ロードする:
//   @mapbox/vector-tile + pbf … MVT デコード (BSD-3-Clause)
//   pmtiles                 … PMTiles アーカイブ読み出し (BSD-3-Clause)

const VT_URL = "https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@1.3.1/+esm";
const PBF_URL = "https://cdn.jsdelivr.net/npm/pbf@3.3.0/+esm";
const PMTILES_URL = "https://cdn.jsdelivr.net/npm/pmtiles@4.4.1/+esm";

let _decoderP = null;
export function loadMvtDecoder() {
  _decoderP ||= Promise.all([import(VT_URL), import(PBF_URL)]).then(([vt, pb]) => {
    const VectorTile = vt.VectorTile || vt.default?.VectorTile || vt.default;
    const Pbf = pb.Pbf || pb.default?.Pbf || pb.default;
    if (!VectorTile || !Pbf) throw new Error("vector-tile/pbf の読み込みに失敗しました");
    return { VectorTile, Pbf };
  });
  return _decoderP;
}

let _pmtilesP = null;
export function loadPmtiles() {
  _pmtilesP ||= import(PMTILES_URL);
  return _pmtilesP;
}

// ---- 既定スタイル(色指定が無い行向け)。layers= でソースレイヤを絞れる ----
const DEFAULT_MVT_STYLE = {
  fill: "rgba(43,140,190,0.30)",   // ポリゴン塗り
  stroke: "#2b8cbe",               // ライン・ポリゴン枠
  lineWidth: 1.2,
  pointFill: "#e6550d",            // ポイント
  pointStroke: "#ffffff",
  pointRadius: 3,
};

function mvtStyle(opts = {}) {
  const s = { ...DEFAULT_MVT_STYLE };
  if (opts.fill) s.fill = opts.fill;
  if (opts.stroke || opts.color) s.stroke = opts.stroke || opts.color;
  if (opts.color && !opts.fill) s.fill = opts.color;
  const w = Number(opts.width ?? opts.linewidth);
  if (Number.isFinite(w) && w > 0) s.lineWidth = w;
  if (opts.pointcolor || opts.circle) s.pointFill = opts.pointcolor || opts.circle;
  const r = Number(opts.radius ?? opts.pointradius);
  if (Number.isFinite(r) && r > 0) s.pointRadius = r;
  const names = String(opts.srclayers ?? opts.sourcelayers ?? opts.layers ?? "")
    .split(",").map(v => v.trim()).filter(Boolean);
  return { style: s, layerNames: names.length ? new Set(names) : null };
}

// 検証・診断用カウンタ(タイル描画が実際に走ったかを外部から確認できる)
function bumpStats(kind) {
  if (typeof window === "undefined") return;
  const st = (window.__mvtStats ||= { tiles: 0, features: 0, byType: {} });
  st.tiles++;
  st.byType[kind] = (st.byType[kind] || 0) + 1;
}

// 1タイル分の MVT を canvas へ描画する。地物座標はタイル内 extent
// (通常4096)を tileSize へ線形マップ。ポリゴンは evenodd で穴を処理する
export function renderMvtTile(buf, dec, { tileSize = 256, opts = {}, kind = "mvt" } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = tileSize;
  const ctx = canvas.getContext("2d");
  const tile = new dec.VectorTile(new dec.Pbf(buf));
  const { style, layerNames } = mvtStyle(opts);
  let features = 0;
  for (const name of Object.keys(tile.layers)) {
    if (layerNames && !layerNames.has(name)) continue;
    const layer = tile.layers[name];
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const sc = tileSize / f.extent;
      const geoms = f.loadGeometry();
      features++;
      if (f.type === 3) {
        ctx.beginPath();
        for (const ring of geoms) {
          ring.forEach((p, j) => (j ? ctx.lineTo(p.x * sc, p.y * sc) : ctx.moveTo(p.x * sc, p.y * sc)));
          ctx.closePath();
        }
        ctx.fillStyle = style.fill;
        ctx.fill("evenodd");
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.lineWidth;
        ctx.stroke();
      } else if (f.type === 2) {
        ctx.beginPath();
        for (const seg of geoms) {
          seg.forEach((p, j) => (j ? ctx.lineTo(p.x * sc, p.y * sc) : ctx.moveTo(p.x * sc, p.y * sc)));
        }
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.lineWidth;
        ctx.stroke();
      } else {
        for (const seg of geoms) {
          for (const p of seg) {
            ctx.beginPath();
            ctx.arc(p.x * sc, p.y * sc, style.pointRadius, 0, Math.PI * 2);
            ctx.fillStyle = style.pointFill;
            ctx.fill();
            ctx.strokeStyle = style.pointStroke;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
    }
  }
  if (features) {
    bumpStats(kind);
    if (typeof window !== "undefined" && window.__mvtStats) window.__mvtStats.features += features;
  }
  return canvas;
}

async function xyzTileBytes(template, x, y, z) {
  const url = template
    .replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y)
    .replace(/\{-y\}/g, String((1 << z) - 1 - y));
  const res = await fetch(url);
  if (res.status === 404) return null; // 疎なタイル領域は空タイルとして扱う
  if (!res.ok) throw new Error(`MVT タイル取得失敗 ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  return buf.byteLength ? buf : null;
}

// Cesium ImageryProvider を返す。UrlTemplateImageryProvider を器にし、
// requestImage だけを「MVT 取得→デコード→canvas」へ差し替える方式。
// spec: { type:'mvt'|'pmtiles', url, tileSize, minimumLevel, maximumLevel,
//         rectangle(Cesium.Rectangle), credit(Cesium.Credit), opts }
export async function createMvtImageryProvider(Cesium, spec) {
  const tileSize = spec.tileSize || 256;
  const opts = spec.opts || {};
  let fetchBytes;
  if (spec.type === "pmtiles") {
    const m = await loadPmtiles();
    const archive = new m.PMTiles(String(spec.url).replace(/^pmtiles:\/\//i, ""));
    fetchBytes = async (x, y, z) => {
      const e = await archive.getZxy(z, x, y);
      return e ? e.data : null;
    };
  } else {
    let template = spec.url;
    // TileJSON(.json)参照: tiles[0] を展開し、未指定の zoom/attribution を補完する
    if (/\.json($|[?#])/i.test(template)) {
      const tj = await fetch(template).then(r => {
        if (!r.ok) throw new Error(`TileJSON 取得失敗 ${r.status}: ${template}`);
        return r.json();
      });
      if (!tj || !Array.isArray(tj.tiles) || !tj.tiles.length) {
        throw new Error(`TileJSON に tiles がありません: ${template}`);
      }
      template = tj.tiles[0];
      if (spec.minimumLevel == null && Number.isFinite(Number(tj.minzoom))) spec.minimumLevel = Number(tj.minzoom);
      if (spec.maximumLevel == null && Number.isFinite(Number(tj.maxzoom))) spec.maximumLevel = Number(tj.maxzoom);
      if (!spec.credit && tj.attribution) spec.credit = new Cesium.Credit(String(tj.attribution));
    }
    fetchBytes = (x, y, z) => xyzTileBytes(template, x, y, z);
  }
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: spec.type === "pmtiles" ? "https://pmtiles.invalid/{z}/{x}/{y}.mvt" : spec.url,
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: spec.minimumLevel,
    maximumLevel: spec.maximumLevel,
    rectangle: spec.rectangle,
    credit: spec.credit,
  });
  provider.requestImage = async (x, y, level) => {
    const buf = await fetchBytes(x, y, level);
    if (!buf) return undefined;
    const dec = await loadMvtDecoder();
    return renderMvtTile(buf, dec, { tileSize, opts, kind: spec.type });
  };
  return provider;
}
