// MVT / PMTiles ベクトルタイル → Cesium ImageryProvider（canvas ラスタライズ）
// .kasc の mvt:/pmtiles: 行は XYZ タイル系(type:"tile" + vtile フラグ)として
// 既存の imagery スタック・表示切替・ドレープ機構にそのまま載せる。
// デコーダは maplibre 側と同じ方針で CDN から遅延ロード（ブラウザ完結・静的配信のみ）。
//   @mapbox/vector-tile (BSD-3-Clause) / pbf (BSD-3-Clause) / pmtiles (BSD-3-Clause)
//
// 描画はフラットな既定スタイル（塗り+線+点）。source-layer の絞り込みは
// layers= 指定時のみ。タイル不在・取得失敗は透過 canvas を返し、
// 地図全体の描画を落とさない。

const TILE_PX = 256;
let decoderP = null;
function loadDecoder() {
  decoderP ||= Promise.all([
    import("https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.4/+esm"),
    import("https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm"),
  ]).then(([vt, pbf]) => ({ VectorTile: vt.VectorTile, Pbf: pbf.default || pbf.Pbf }));
  return decoderP;
}
let pmtilesP = null;
function loadPmtiles() {
  pmtilesP ||= import("https://cdn.jsdelivr.net/npm/pmtiles@4.4.1/+esm");
  return pmtilesP;
}

function blankTile() {
  const c = document.createElement("canvas");
  c.width = c.height = TILE_PX;
  return c;
}

function renderTile(buf, VectorTile, Pbf, opts) {
  const canvas = blankTile();
  const ctx = canvas.getContext("2d");
  const tile = new VectorTile(new Pbf(buf));
  const filter = opts.layers?.size ? opts.layers : null;
  for (const [name, lyr] of Object.entries(tile.layers)) {
    if (filter && !filter.has(name)) continue;
    const scale = TILE_PX / lyr.extent;
    for (let i = 0; i < lyr.length; i++) {
      const f = lyr.feature(i);
      const geoms = f.loadGeometry();
      if (f.type === 3) {
        // ポリゴン: 外周・穴をまとめて evenodd で塗る
        const path = new Path2D();
        for (const ring of geoms) {
          ring.forEach((p, j) => j ? path.lineTo(p.x * scale, p.y * scale) : path.moveTo(p.x * scale, p.y * scale));
          path.closePath();
        }
        ctx.fillStyle = opts.fill;
        ctx.fill(path, "evenodd");
        if (opts.stroke) { ctx.strokeStyle = opts.stroke; ctx.lineWidth = opts.width; ctx.stroke(path); }
      } else if (f.type === 2) {
        ctx.strokeStyle = opts.stroke;
        ctx.lineWidth = opts.width;
        ctx.beginPath();
        for (const part of geoms) {
          part.forEach((p, j) => j ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale));
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = opts.stroke;
        for (const part of geoms) for (const p of part) {
          ctx.beginPath();
          ctx.arc(p.x * scale, p.y * scale, opts.radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  return canvas;
}

// item: type:"tile" + vtile:"mvt"|"pmtiles" の .kasc 行。
// UrlTemplateImageryProvider を土台にし requestImage を差し替える
// （tiling scheme・rectangle・zoom 範囲・クレジットの既存処理を再利用）
export async function createMvtImageryProvider(Cesium, item, { creditHtml = "" } = {}) {
  const { VectorTile, Pbf } = await loadDecoder();
  const opts = {
    fill: item.vtileFill || "rgba(49,86,79,0.45)",
    stroke: item.vtileStroke || "#31564f",
    width: item.vtileWidth || 1,
    radius: item.vtileRadius || 3,
    layers: item.vtileLayers instanceof Set ? item.vtileLayers : null,
  };
  let pm = null;
  if (item.vtile === "pmtiles") pm = new (await loadPmtiles()).PMTiles(item.url);
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: "mvt://{z}/{x}/{y}", // 実際のタイル取得は requestImage が担うダミー
    credit: new Cesium.Credit(creditHtml || ""),
    maximumLevel: item.maximumLevel ?? 15,
    ...(Number.isInteger(item.minimumLevel) ? { minimumLevel: item.minimumLevel } : {}),
    ...(Array.isArray(item.bbox) ? { rectangle: Cesium.Rectangle.fromDegrees(...item.bbox) } : {}),
  });
  provider.requestImage = async (x, y, level) => {
    try {
      let buf;
      if (pm) {
        const t = await pm.getZxy(level, x, y);
        buf = t?.data;
      } else {
        const url = String(item.url)
          .replace("{z}", level).replace("{x}", x).replace("{y}", y)
          .replace("{-y}", String((1 << level) - 1 - y));
        const res = await fetch(url);
        buf = res.ok ? await res.arrayBuffer() : null;
      }
      if (!buf?.byteLength) return blankTile();
      return renderTile(buf, VectorTile, Pbf, opts);
    } catch (e) {
      // 1タイルの失敗で imagery 全体を落とさない（再試行は Cesium の再要求に任せる）
      console.warn(`[mvt] tile ${level}/${x}/${y} failed:`, e);
      return blankTile();
    }
  };
  return provider;
}
