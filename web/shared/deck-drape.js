// deck.gl TerrainExtension による 3D Tiles ドレープの共通ヘルパー。
// Tile3DLayer を operation:"terrain+draw" で地形ソース化し、このモジュールが返す
// ドレープレイヤーを同じ deck へ追加すると、2D データが 3D Tiles 表面に貼り付く。
// （TerrainExtension の terrainDrawMode:drape はレイヤーを terrain カバー FBO へ
// 描画し、地形ソースレイヤーの表面上にテクスチャとして重ねる）
//
// Cesium 版の「ドレープ対象地形=3D Tiles」設定（drape-terrain-tiles3d /
// drape-xyz-tiles3d / drape-geojson-tiles3d / basemap-drape-3dtiles）に相当する
// 機構を、deck.gl を使う 2D エンジン（MapLibre/OpenLayers/Leaflet）向けに提供する。
//
// 使い方（各エンジンの syncDeckLayers 内）:
//   const drapeOn = settings.enabled && [...deckDefs.values()].some(d => d.item.visible !== false);
//   // Tile3DLayer の opts に operation: drapeOn ? "terrain+draw" : "draw" を付ける
//   if (drapeOn) layers.push(...buildDeckDrapeLayers(deck, collectDrapeItems(), baseUrl));

import { resolveKascUrl, buildWmsTileTemplate, buildWmtsTileTemplate } from "./kasc.js";
import { specToStyle } from "./qml-2d.js";

// ドレープ品質: deck.gl の TerrainCover は 3D Tiles タイルの boundingBox に固定された
// テクスチャを「最初に見えたズーム」で1度だけ生成し、ズームインしても再描画しない。
// そのままでは低ズームの粗いテクスチャが引き伸ばされてドレープがぼやけるため、
// ズーム確定のたびにカバー FBO を破棄して現在ズームで作り直させる。
// （タイル非依存レイヤーはビューポート∩範囲で毎ズーム再描画されるが、
// タイルの boundingBox を持つ地形ソースはそうならない — terrain-cover.ts 仕様）
export function invalidateDeckTerrainCovers(deckInst) {
  try {
    const em = deckInst?.effectManager;
    for (const src of [em?._defaultEffects, em?.effects, em?._resolvedEffects]) {
      const arr = src instanceof Map ? [...src.values()] : Array.isArray(src) ? src : src && [...src];
      const te = arr?.find?.(e => e && e.id === "terrain-effect");
      if (te) { te.terrainCovers?.clear(); return; }
    }
  } catch (_) {}
}

// CSS 色指定（#rgb/#rrggbb/#rrggbbaa/rgb()/rgba()/色名）→ [r,g,b,a(0-255)]
// canvas の fillStyle 正規化に任せて広い記法を吸収する
let colorCtx = null;
export function cssToRgba(css, fallback = [60, 125, 213, 200]) {
  if (!css) return fallback;
  try {
    colorCtx ||= document.createElement("canvas").getContext("2d");
    colorCtx.fillStyle = "#000";
    colorCtx.fillStyle = css;
    const norm = colorCtx.fillStyle;
    const m = /^#([0-9a-f]{3,8})$/i.exec(norm);
    if (m) {
      const h = m[1];
      const v = h.length <= 4 ? h.split("").map(c => c + c).join("") : h;
      const n = parseInt(v.slice(0, 6), 16);
      const a = v.length === 8 ? parseInt(v.slice(6, 8), 16) : 255;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
    }
    const r = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(norm);
    if (r) return [+r[1], +r[2], +r[3], r[4] !== undefined ? Math.round(+r[4] * 255) : 255];
  } catch (_) {}
  return fallback;
}

// xyz/wms/wmts/base 行 → deck TileLayer 用のタイルテンプレート URL。
// deck TileLayer は {x}/{y}/{z}/{-y}/{bbox-epsg-3857} プレースホルダを解釈する
export function deckDrapeTileUrl(item, baseUrl) {
  const url = resolveKascUrl(item.url, baseUrl);
  if (!url) return null;
  const opts = item.opts || {};
  if (item.type === "wms") return buildWmsTileTemplate(url, opts, "{bbox-epsg-3857}");
  if (item.type === "wmts") return buildWmtsTileTemplate(url, opts);
  return url;
}

// 凡例シンボル単位の非表示(_legendHidden)を反映した地物配列を返す。
// drape 描画は item._geojson のコピーを使う（元データには手を付けない）
function drapeVectorFeatures(item) {
  const feats = item._geojson?.features || [];
  const hidden = item._legendHidden;
  if (!hidden?.size || typeof item._qml?.namesFor !== "function") return feats;
  return feats.filter(f => {
    const names = item._qml.namesFor(f.properties || {});
    return !(names?.length && hidden.has(names[0]));
  });
}

// 地物 → ドレープ用スタイル。QML 適用済みなら __kasc_* 焼き込み値または
// item._qml.evaluate を参照し、未適用はエンジン共通の既定色を使う
function featureDeckStyle(item, feature) {
  const p = feature.properties || {};
  const isPoint = /Point/.test(feature.geometry?.type || "");
  let fill = p.__kasc_fill, stroke = p.__kasc_stroke, width = p.__kasc_width, marker = p.__kasc_color;
  if (item._qml && (fill === undefined || stroke === undefined || marker === undefined)) {
    try {
      const s = specToStyle(item._qml.evaluate(p));
      if (s) {
        fill ??= s.fill;
        stroke ??= s.stroke;
        width ??= s.strokeWidth;
        marker ??= s.markerColor;
      }
    } catch (_) {}
  }
  return {
    fill: cssToRgba(isPoint ? marker : (fill || "#3a7bd5"), isPoint ? [44, 94, 168, 220] : [58, 123, 213, 128]),
    stroke: cssToRgba(stroke || "#2c5ea8", [44, 94, 168, 255]),
    width: Number.isFinite(width) ? Math.max(1, width) : 1.5,
  };
}

// ドレープ対象レイヤー集合 → deck レイヤー配列。
//   rasterItems: xyz/wms/wmts/base の .kasc アイテム（ベースマップを含む場合は先頭に）
//   vectorItems: _geojson を持つベクター .kasc アイテム
// layers の配列順 = 描画順（後ろほど terrain カバー上で前面に出る）
export function buildDeckDrapeLayers(deck, { rasterItems = [], vectorItems = [], baseUrl = "" } = {}) {
  const layers = [];
  rasterItems.forEach((item, i) => {
    const url = deckDrapeTileUrl(item, baseUrl);
    if (!url) return;
    const o = item.opts || {};
    const opts = {
      id: `drape-raster-${i}`,
      data: url,
      tileSize: Number(o.tilesize) || 256,
      minZoom: Number(o.minzoom ?? o.minimumlevel) || 0,
      maxZoom: Number(o.maxzoom ?? o.maximumlevel) || 19,
      // XYZ のドレープ既定 0.8 は Cesium 版 drapeProviders と同じ
      opacity: o.opacity !== undefined ? Number(o.opacity) : 0.8,
      extensions: [new deck._TerrainExtension()],
      renderSubLayers: props => {
        const b = props.tile?.bbox;
        if (!props.data || !b) return null;
        return new deck.BitmapLayer(props, {
          data: null,
          image: props.data,
          bounds: [b.west, b.south, b.east, b.north],
        });
      },
    };
    const bbox = String(o.bbox || "").split(",").map(Number);
    if (bbox.length === 4 && bbox.every(Number.isFinite)) opts.extent = bbox;
    layers.push(new deck.TileLayer(opts));
  });
  vectorItems.forEach((item, i) => {
    const features = drapeVectorFeatures(item);
    if (!features.length) return;
    const o = item.opts || {};
    layers.push(new deck.GeoJsonLayer({
      id: `drape-vector-${i}`,
      data: { type: "FeatureCollection", features },
      filled: true,
      stroked: true,
      pointType: "circle",
      pointRadiusUnits: "pixels",
      pointRadiusMinPixels: 2,
      getPointRadius: 5,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: 1,
      getFillColor: f => featureDeckStyle(item, f).fill,
      getLineColor: f => featureDeckStyle(item, f).stroke,
      getLineWidth: f => featureDeckStyle(item, f).width,
      opacity: o.opacity !== undefined ? Number(o.opacity) : 1,
      extensions: [new deck._TerrainExtension()],
    }));
  });
  return layers;
}
