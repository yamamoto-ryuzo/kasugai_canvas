// .kasc の style=<QML> を 2D エンジンへ適用するアダプタ（エンジン非依存の評価 + 各エンジン変換）
// shared/qml-style.js の compileQmlStyle が返す spec:
//   evaluate(props) → { markers, line:{color,widthPx,dash}, fillParts:[{solid|rgba|hatch}],
//                       outline:{color,widthPx,dash}, centroid, scale, label }
import { loadQmlStyle, rgbaToCss, markerLayersToCanvas } from "./qml-style.js";
import { resolveKascUrl } from "./kasc.js";

export async function loadCompiledQml(urlOrPath, baseUrl) {
  const url = resolveKascUrl(urlOrPath, baseUrl);
  return loadQmlStyle(url, async u => {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`QML 取得失敗: ${u} (${res.status})`);
    return res.text();
  });
}

function fillColorOf(spec) {
  for (const part of spec.fillParts || []) {
    if (part.solid) return rgbaToCss(part.solid);
    if (part.hatch) return rgbaToCss(part.hatch.color);
  }
  return null;
}

function markerColorOf(spec) {
  const mk = spec.markers?.[0];
  return mk?.color ? rgbaToCss(mk.color) : null;
}

// spec → シンプルな描画パラメータ（2D エンジン共通の最小表現）
export function specToStyle(spec) {
  if (!spec) return null;
  return {
    fill: fillColorOf(spec),
    stroke: spec.outline ? rgbaToCss(spec.outline.color) : (spec.line ? rgbaToCss(spec.line.color) : null),
    strokeWidth: spec.outline?.widthPx ?? spec.line?.widthPx ?? 1.5,
    dash: spec.outline?.dash || spec.line?.dash || null,
    markerColor: markerColorOf(spec) || "#2c5ea8",
    markerCanvas: spec.markers?.length ? markerLayersToCanvas(spec.markers) : null,
  };
}

// --- OpenLayers: feature → ol.style.Style のスタイル関数を生成
export function olQmlStyleFunction(compiled, OL) {
  const { Style, Fill, Stroke, Circle: CircleStyle, Icon } = OL;
  return feature => {
    const spec = compiled.evaluate(feature.getProperties() || {});
    if (!spec) return null;
    const s = specToStyle(spec);
    const geomType = feature.getGeometry()?.getType() || "";
    const styleOpts = {};
    if (s.fill && /Polygon/.test(geomType)) styleOpts.fill = new Fill({ color: s.fill });
    if (s.stroke) {
      styleOpts.stroke = new Stroke({ color: s.stroke, width: s.strokeWidth, lineDash: s.dash || undefined });
    }
    if (/Point|MultiPoint/.test(geomType)) {
      styleOpts.image = s.markerCanvas
        ? new Icon({ img: s.markerCanvas, anchor: [0.5, 0.5] })
        : new CircleStyle({ radius: 5, fill: new Fill({ color: s.markerColor }), stroke: s.stroke ? new Stroke({ color: s.stroke, width: 1 }) : null });
    }
    return new Style(styleOpts);
  };
}

// spec.scale {near,far}（Cesium のカメラ距離m指定）→ 2D の解像度範囲へ近似変換
// 距離 ≈ 解像度(m/px) × 500（画面高500px相当）のヒューリスティック
export function compiledScaleToResRange(compiled) {
  const scale = compiled.evaluate({})?.scale;
  if (!scale) return null;
  const K = 500;
  return {
    minRes: (scale.near ?? 0) / K,
    maxRes: Number.isFinite(scale.far) ? scale.far / K : Infinity,
  };
}

// 解像度(m/px) → Web メルカトルズーム
export function resToZoom(res, lat = 0) {
  return Math.log2((156543.03392 * Math.cos(lat * Math.PI / 180)) / res);
}

// 凡例エントリの spec → 小さなスウォッチ画像の data URL（2Dエンジン共通）
export function qmlLegendSwatchDataUrl(spec, size = 18) {
  try {
    const s = specToStyle(spec) || {};
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const pad = 2;
    if (s.fill) {
      ctx.fillStyle = s.fill;
      ctx.fillRect(pad, size * 0.3, size - pad * 2, size * 0.6);
    }
    if (s.stroke) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = Math.max(1, Math.min(3, s.strokeWidth || 1));
      if (s.fill) ctx.strokeRect(pad, size * 0.3, size - pad * 2, size * 0.6);
      else { ctx.beginPath(); ctx.moveTo(pad, size / 2); ctx.lineTo(size - pad, size / 2); ctx.stroke(); }
    }
    if (s.markerCanvas) {
      const m = s.markerCanvas;
      const w = Math.min(size - pad * 2, m.width), h = Math.min(size - pad * 2, m.height);
      ctx.drawImage(m, (size - w) / 2, (size - h) / 2, w, h);
    } else if (!s.fill && !s.stroke) {
      ctx.fillStyle = s.markerColor || "#2c5ea8";
      ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 3, 0, Math.PI * 2); ctx.fill();
    }
    return canvas.toDataURL();
  } catch (_) { return ""; }
}

// --- MapLibre: GeoJSON の各 feature に __kasc_* を焼き込み、データ駆動 paint 式で適用
const KASC_PROPS = ["__kasc_fill", "__kasc_stroke", "__kasc_width", "__kasc_color", "__kasc_symbol"];

export function maplibreApplyQml(geojson, compiled) {
  for (const feature of geojson.features || []) {
    const spec = compiled.evaluate(feature.properties || {});
    if (!spec) continue;
    const s = specToStyle(spec);
    feature.properties = feature.properties || {};
    if (s.fill) feature.properties.__kasc_fill = s.fill;
    if (s.stroke) feature.properties.__kasc_stroke = s.stroke;
    feature.properties.__kasc_width = s.strokeWidth;
    feature.properties.__kasc_color = s.markerColor;
    // 凡例シンボル単位の表示切替フィルタ用（規則ベースで複数ヒットし得るため先頭名を採用）
    const names = typeof compiled.namesFor === "function" ? compiled.namesFor(feature.properties) : null;
    if (names?.length) feature.properties.__kasc_symbol = names[0];
  }
  return {
    kinds: [
      ["fill", ["==", ["geometry-type"], "Polygon"], {
        "fill-color": ["coalesce", ["get", "__kasc_fill"], "#3a7bd5"],
        "fill-opacity": 0.5,
      }],
      ["line", ["!=", ["geometry-type"], "Point"], {
        "line-color": ["coalesce", ["get", "__kasc_stroke"], "#2c5ea8"],
        "line-width": ["coalesce", ["get", "__kasc_width"], 1.5],
      }],
      ["circle", ["==", ["geometry-type"], "Point"], {
        "circle-radius": 5,
        "circle-color": ["coalesce", ["get", "__kasc_color"], "#2c5ea8"],
        "circle-stroke-color": ["coalesce", ["get", "__kasc_stroke"], "#ffffff"],
        "circle-stroke-width": 1,
      }],
    ],
    props: KASC_PROPS,
  };
}
