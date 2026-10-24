// .kasc の style=<QML> を 2D エンジンへ適用するアダプタ（エンジン非依存の評価 + 各エンジン変換）
// shared/qml-style.js の compileQmlStyle が返す spec:
//   evaluate(props) → { markers, line:{color,widthPx,dash}, fillParts:[{solid|rgba|hatch}],
//                       outline:{color,widthPx,dash}, centroid, scale, label }
import { loadQmlStyle, rgbaToCss, markerLayersToCanvas } from "/shared/qml-style.js";
import { resolveKascUrl } from "/shared/kasc.js";

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

// --- MapLibre: GeoJSON の各 feature に __kasc_* を焼き込み、データ駆動 paint 式で適用
const KASC_PROPS = ["__kasc_fill", "__kasc_stroke", "__kasc_width", "__kasc_color"];

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
