// .kasc の style=<QML> を 2D エンジンへ適用するアダプタ（エンジン非依存の評価 + 各エンジン変換）
// shared/qml-style.js の compileQmlStyle が返す spec:
//   evaluate(props) → { markers, line:{color,widthPx,dash}, fillParts:[{solid|rgba|hatch}],
//                       outline:{color,widthPx,dash}, centroid, scale, label }
import { loadQmlStyle, rgbaToCss, markerLayersToCanvas, setLayerVisibilityResolver } from "./qml-style.js";
import { resolveKascUrl } from "./kasc.js";

// QML 式の is_layer_visible('名前') を各エンジンのレイヤー表示状態へ解決する。
// getItems は現在のレイヤー item 配列を返す関数({title,id,visible})。
// 照合は Cesium 版と同じ規則: タイトル全体/レイヤ id/パス区切りのいずれかの
// セグメント一致。未発見は非表示(false)扱い(QGIS でレイヤー無しと同じ)
export function installLayerVisibilityResolver(getItems) {
  setLayerVisibilityResolver(name => {
    const key = String(name || "").trim();
    if (!key) return false;
    const items = getItems?.() || [];
    const hit = items.find(item => {
      if (!item) return false;
      if (item.title === key || item.id === key) return true;
      const path = (item.group ? `${item.group}/${item.title}` : String(item.title || ""));
      return path.split("/").map(seg => seg.trim()).includes(key);
    });
    return hit ? !!hit.visible : false;
  });
}

// QML <labeling> の評価結果を地物プロパティへ焼き込む（MapLibre の
// データ駆動スタイル用）。is_layer_visible 等の式を含むため、
// レイヤー表示切替ごとに呼び直して再焼き込みする運用を想定。
// 戻り値: ラベルが1件でも付いたか
export const QML_LABEL_PROPS = ["__kasc_label", "__kasc_label_size", "__kasc_label_color", "__kasc_label_halo", "__kasc_label_halo_w"];
export function bakeQmlLabels(geojson, compiled) {
  if (!compiled?.labelFor) return false;
  let any = false;
  for (const feature of geojson?.features || []) {
    const props = feature.properties || (feature.properties = {});
    const spec = compiled.labelFor(props);
    const text = spec ? String(spec.getText?.(props) ?? "").trim() : "";
    if (spec && text) {
      props.__kasc_label = text;
      props.__kasc_label_size = Math.max(Math.round(spec.sizePx || 12), 6);
      props.__kasc_label_color = rgbaToCss(spec.fill || [0, 0, 0, 1]);
      props.__kasc_label_halo = spec.halo ? rgbaToCss(spec.halo.color) : "rgba(0,0,0,0)";
      props.__kasc_label_halo_w = spec.halo ? Math.max(Number(spec.halo.widthPx) || 0, 0) : 0;
      any = true;
    } else {
      for (const k of QML_LABEL_PROPS) delete props[k];
    }
  }
  return any;
}

// labelFor の spec → ラベル HTML 要素(Leaflet 等 DOM 描画用)。
// テキストが空なら null。色は fill、縁取りは text-shadow 多方向で近似する
export function qmlLabelElement(compiled, props) {
  const spec = compiled?.labelFor ? compiled.labelFor(props) : null;
  const text = spec ? String(spec.getText?.(props) ?? "").trim() : "";
  if (!spec || !text) return null;
  const span = document.createElement("span");
  span.textContent = text;
  span.style.color = rgbaToCss(spec.fill || [0, 0, 0, 1]);
  span.style.font = spec.fontCss || "12px sans-serif";
  if (spec.halo) {
    const c = rgbaToCss(spec.halo.color);
    const w = Math.max(Number(spec.halo.widthPx) || 1, 1);
    span.style.textShadow = [
      `-${w}px 0 0 ${c}`, `${w}px 0 0 ${c}`, `0 -${w}px 0 ${c}`, `0 ${w}px 0 ${c}`,
      `-${w}px -${w}px 0 ${c}`, `${w}px -${w}px 0 ${c}`, `-${w}px ${w}px 0 ${c}`, `${w}px ${w}px 0 ${c}`,
    ].join(",");
  }
  return span;
}

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
  const { Style, Fill, Stroke, Circle: CircleStyle, Icon, Text } = OL;
  return feature => {
    const props = feature.getProperties() || {};
    const spec = compiled.evaluate(props);
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
    // <labeling>: ラベルspec があれば Text を付ける(描画ごとに再評価されるため
    // is_layer_visible 連動も表示切替でそのまま追従する)
    if (Text) {
      const labelSpec = compiled.labelFor ? compiled.labelFor(props) : null;
      const labelText = labelSpec ? String(labelSpec.getText?.(props) ?? "") : "";
      if (labelSpec && labelText) {
        styleOpts.text = new Text({
          text: labelText,
          font: labelSpec.fontCss || "12px sans-serif",
          fill: new Fill({ color: rgbaToCss(labelSpec.fill || [0, 0, 0, 1]) }),
          stroke: labelSpec.halo ? new Stroke({ color: rgbaToCss(labelSpec.halo.color), width: Math.max(Number(labelSpec.halo.widthPx) || 1, 1) }) : undefined,
          overflow: true,
        });
      }
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

// style= 未指定ベクターの自動凡例: 既定色とジオメトリ種別から代表シンボルの
// spec を組み立てる(Cesium 版の entity サンプル凡例相当)。colors には
// 各エンジンが実際の描画に使っている既定スタイルを渡す
export function defaultVectorLegendSpec(geomType, { fill = [58 / 255, 123 / 255, 213 / 255, 0.4], stroke = [44 / 255, 94 / 255, 168 / 255, 1], strokeWidth = 1.5, point = [44 / 255, 94 / 255, 168 / 255, 1] } = {}) {
  if (/Polygon/.test(geomType)) return { fillParts: [{ solid: fill }], outline: { color: stroke, widthPx: strokeWidth } };
  if (/Line/.test(geomType)) return { line: { color: stroke, widthPx: strokeWidth } };
  if (/Point/.test(geomType)) return { markers: [{ color: point }] };
  return null;
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
  const kinds = [
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
  ];
  // <labeling>: 焼き込んだ __kasc_label 系プロパティを参照する symbol レイヤを追加。
  // 4要素目は追加 layout(text-field は feature プロパティ参照可)
  if (bakeQmlLabels(geojson, compiled)) {
    kinds.push(["symbol", ["has", "__kasc_label"], {
      "text-color": ["coalesce", ["get", "__kasc_label_color"], "#222222"],
      "text-halo-color": ["coalesce", ["get", "__kasc_label_halo"], "rgba(0,0,0,0)"],
      "text-halo-width": ["coalesce", ["get", "__kasc_label_halo_w"], 0],
    }, {
      "text-field": ["get", "__kasc_label"],
      "text-size": ["coalesce", ["get", "__kasc_label_size"], 12],
      "text-font": ["literal", ["Noto Sans Regular"]],
      "text-allow-overlap": false,
    }]);
  }
  return {
    kinds,
    props: KASC_PROPS,
  };
}
