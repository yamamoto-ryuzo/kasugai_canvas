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
export const QML_LABEL_PROPS = [
  "__kasc_label", "__kasc_label_size", "__kasc_label_color",
  "__kasc_label_halo", "__kasc_label_halo_w",
  "__kasc_label_rot", "__kasc_label_off", "__kasc_label_anchor",
  "__kasc_label_placement", "__kasc_label_upright", "__kasc_label_overlap",
  "__kasc_label_sort", "__kasc_label_spacing", "__kasc_label_justify",
  "__kasc_label_letter", "__kasc_label_lh", "__kasc_label_maxw", "__kasc_label_tf",
];

// quad {h,v} → MapLibre text-anchor
export function quadToAnchor(quad) {
  if (!quad) return "center";
  const v = quad.v > 0 ? "bottom" : quad.v < 0 ? "top" : "";
  const h = quad.h > 0 ? "left" : quad.h < 0 ? "right" : "";
  return [v, h].filter(Boolean).join("-") || "center";
}

// ラベル spec → MapLibre symbol-placement
function specToSymbolPlacement(spec, geomType) {
  const mode = spec?.placement?.mode;
  if (/line/i.test(geomType || "") && (mode === "line" || mode === "curved")) return "line";
  if (/polygon/i.test(geomType || "") && ["line", "curved", "perimeter"].includes(mode)) return "line";
  return "point";
}

export function bakeQmlLabels(geojson, compiled) {
  if (!compiled?.labelFor) return false;
  let any = false;
  let minScale = null, maxScale = null;
  for (const feature of geojson?.features || []) {
    const props = feature.properties || (feature.properties = {});
    const spec = compiled.labelFor(props);
    const text = spec?.text != null ? String(spec.text).trim() : "";
    if (spec && text) {
      const sizePx = Math.max(spec.sizePx || 12, 6);
      const geomType = feature.geometry?.type || "";
      const pl = spec.placement || {};
      const [oxPx, oyPx] = spec.pixelOffsetOf ? spec.pixelOffsetOf() : [pl.offsetXPx || 0, -(pl.offsetYPx || 0)];
      props.__kasc_label = text;
      props.__kasc_label_size = Math.max(Math.round(sizePx), 6);
      props.__kasc_label_color = rgbaToCss(spec.fill || [0, 0, 0, 1]);
      props.__kasc_label_halo = spec.halo ? rgbaToCss(spec.halo.color) : "rgba(0,0,0,0)";
      props.__kasc_label_halo_w = spec.halo ? Math.max(Number(spec.halo.widthPx) || 0, 0) : 0;
      props.__kasc_label_rot = pl.rotationDeg || 0;
      props.__kasc_label_off = [
        Math.round((oxPx / sizePx) * 100) / 100,
        Math.round((oyPx / sizePx) * 100) / 100,
      ];
      props.__kasc_label_anchor = specToSymbolPlacement(spec, geomType) === "point" ? quadToAnchor(pl.quad) : "center";
      props.__kasc_label_placement = specToSymbolPlacement(spec, geomType);
      props.__kasc_label_upright = spec.upsidedown !== "show";
      props.__kasc_label_overlap = !!(spec.displayAll || spec.allowDegraded || spec.allowOverlap);
      props.__kasc_label_sort = (spec.zIndex || 0) * 100 + (spec.priority || 0);
      props.__kasc_label_spacing = Math.max(pl.repeatDistancePx || 250, 1);
      props.__kasc_label_justify = { left: "left", center: "center", right: "right", justify: "auto" }[spec.align] || "auto";
      props.__kasc_label_letter = Math.round(((spec.letterSpacingPx || 0) / sizePx) * 1000) / 1000;
      props.__kasc_label_lh = spec.lineHeightFactor || 1;
      props.__kasc_label_maxw = spec.autoWrapLength || 10;
      props.__kasc_label_tf = Number(spec.capitalization) === 2 ? "lowercase"
        : [1, 4, 5, 6].includes(Number(spec.capitalization)) ? "uppercase" : "none";
      if (spec.labelScale) {
        if (spec.labelScale.minScale) minScale = Math.max(minScale ?? 0, spec.labelScale.minScale);
        if (spec.labelScale.maxScale) maxScale = Math.min(maxScale ?? Infinity, spec.labelScale.maxScale);
      }
      any = true;
    } else {
      for (const k of QML_LABEL_PROPS) delete props[k];
    }
  }
  return any ? { any, minScale, maxScale } : false;
}

// labelFor の spec → ラベル HTML 要素(Leaflet 等 DOM 描画用)。
// テキストが空なら null。色は fill、縁取りは text-shadow 多方向で近似する
export function qmlLabelElement(compiled, props) {
  const spec = compiled?.labelFor ? compiled.labelFor(props) : null;
  const text = spec?.text != null ? String(spec.text) : "";
  if (!spec || !text.trim()) return null;
  const span = document.createElement("span");
  span.textContent = text;
  span.style.color = rgbaToCss(spec.fill || [0, 0, 0, 1]);
  const families = [spec.family, ...Object.keys(spec.substitutions || {})].filter(Boolean).join(",");
  span.style.font = `${spec.italic ? "italic " : ""}${spec.bold ? "bold " : ""}${Math.max(Math.round(spec.sizePx || 12), 6)}px ${families || "sans-serif"}`;
  if (spec.underline || spec.strikeout) {
    span.style.textDecoration = [spec.underline ? "underline" : "", spec.strikeout ? "line-through" : ""].filter(Boolean).join(" ");
  }
  if (spec.letterSpacingPx) span.style.letterSpacing = `${spec.letterSpacingPx}px`;
  if (spec.wordSpacingPx) span.style.wordSpacing = `${spec.wordSpacingPx}px`;
  if (spec.lineHeightFactor && spec.lineHeightFactor !== 1) span.style.lineHeight = String(spec.lineHeightFactor);
  if (spec.align && spec.align !== "left") span.style.textAlign = spec.align === "justify" ? "justify" : spec.align;
  span.style.whiteSpace = "pre-line";
  if (spec.textOrientation === "vertical") span.style.writingMode = "vertical-rl";
  const shadows = [];
  if (spec.halo) {
    const c = rgbaToCss(spec.halo.color);
    const w = Math.max(Number(spec.halo.widthPx) || 1, 1);
    shadows.push(
      `-${w}px 0 0 ${c}`, `${w}px 0 0 ${c}`, `0 -${w}px 0 ${c}`, `0 ${w}px 0 ${c}`,
      `-${w}px -${w}px 0 ${c}`, `${w}px -${w}px 0 ${c}`, `-${w}px ${w}px 0 ${c}`, `${w}px ${w}px 0 ${c}`);
  }
  if (spec.shadow) {
    shadows.push(`${spec.shadow.offsetPx[0]}px ${spec.shadow.offsetPx[1]}px ${spec.shadow.radiusPx}px ${rgbaToCss(spec.shadow.color)}`);
  }
  if (shadows.length) span.style.textShadow = shadows.join(",");
  const bg = spec.background;
  if (bg) {
    span.style.background = rgbaToCss(bg.fill);
    span.style.padding = `${Math.max(bg.padPx[1], 1)}px ${Math.max(bg.padPx[0], 1)}px`;
    if (bg.type === "ellipse" || bg.type === "circle") span.style.borderRadius = "50%";
    if (bg.stroke) span.style.border = `${Math.max(bg.strokeWidthPx, 1)}px solid ${rgbaToCss(bg.stroke)}`;
    if (bg.rotationDeg) span.style.transform = `rotate(${bg.rotationDeg}deg)`;
  }
  const rot = spec.placement?.rotationDeg;
  if (rot) span.style.transform = `${span.style.transform || ""} rotate(${rot}deg)`;
  // Leaflet tooltip のオフセット・ズーム連動用に spec を保持
  span._kascLabelSpec = spec;
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
  const strokeSrc = spec.outline || spec.line || null;
  return {
    fill: fillColorOf(spec),
    stroke: strokeSrc ? rgbaToCss(strokeSrc.color) : null,
    strokeWidth: strokeSrc?.widthPx ?? 1.5,
    dash: strokeSrc?.dash || null,
    join: strokeSrc?.join || null,
    cap: strokeSrc?.cap || null,
    lineOffsetPx: spec.line?.offsetPx || 0,
    markerColor: markerColorOf(spec) || "#2c5ea8",
    markerCanvas: spec.markers?.length ? markerLayersToCanvas(spec.markers) : null,
  };
}

// ラインジオメトリを stepMap 単位でサンプリング → [x, y, セグメント角度rad]
function sampleLineGeom(geom, stepMap) {
  const lines = geom.getType() === "LineString" ? [geom.getCoordinates()] : (geom.getCoordinates?.() || []);
  const out = [];
  for (const coords of lines) {
    let acc = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
      const [x1, y1] = coords[i], [x2, y2] = coords[i + 1];
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (!len) continue;
      const ang = Math.atan2(dy, dx);
      while (acc < len) {
        const t = acc / len;
        out.push([x1 + dx * t, y1 + dy * t, ang]);
        acc += stepMap;
      }
      acc -= len;
    }
  }
  return out;
}

// MarkerLine/HashLine/ArrowLine の spec.line.decor → OL Style 配列
function decorToOlStyles(decor, geom, resolution, OL) {
  const { Style, Fill, Stroke, Icon, Point, MultiPoint, MultiLineString, Polygon } = OL;
  if (!MultiPoint || !MultiLineString || !Polygon || !geom || !Number.isFinite(resolution)) return [];
  const px = v => v * resolution; // 画面px → マップ単位
  const step = Math.max(px(decor.intervalPx || 30), resolution * 2);
  if (decor.kind === "markerline" && decor.markers?.length) {
    let samples;
    if (decor.placement === "vertex" || decor.placement === "firstvertex" || decor.placement === "lastvertex") {
      const lines = geom.getType() === "LineString" ? [geom.getCoordinates()] : geom.getCoordinates();
      const pts = [];
      for (const c of lines) {
        if (decor.placement === "firstvertex") pts.push(c[0]);
        else if (decor.placement === "lastvertex") pts.push(c[c.length - 1]);
        else pts.push(...c);
      }
      samples = pts;
    } else if (decor.placement === "centralpoint") {
      const all = sampleLineGeom(geom, Number.MAX_VALUE);
      const mid = all[Math.floor(all.length / 2)];
      samples = mid ? [mid] : [];
    } else {
      samples = sampleLineGeom(geom, step).map(s => [s[0], s[1]]);
    }
    if (!samples.length) return [];
    const canvas = markerLayersToCanvas(decor.markers);
    return [new Style({
      geometry: new MultiPoint(samples.map(s => s.slice(0, 2))),
      image: new Icon({ img: canvas, anchor: [0.5, 0.5], scale: 1 }),
    })];
  }
  if (decor.kind === "hashline" && decor.tick) {
    const t = decor.tick;
    const half = px(t.lengthPx) / 2;
    const tickAng = (t.angleDeg ?? 90) * Math.PI / 180;
    const segs = sampleLineGeom(geom, step).map(([x, y, ang]) => {
      const a = ang + tickAng - Math.PI / 2; // hash_angle=90 → 線分直交
      const c = Math.cos(a) * half, s = Math.sin(a) * half;
      return [[x - c, y - s], [x + c, y + s]];
    });
    if (!segs.length) return [];
    return [new Style({
      geometry: new MultiLineString(segs),
      stroke: new Stroke({ color: rgbaToCss(t.color), width: Math.max(t.widthPx, 0.5) }),
    })];
  }
  if (decor.kind === "arrowline") {
    const lines = geom.getType() === "LineString" ? [geom.getCoordinates()] : geom.getCoordinates();
    const polys = [];
    const hlen = px(decor.headLenPx || 9), hwid = px(decor.headWidthPx || 9) / 2;
    for (const c of lines) {
      if (c.length < 2) continue;
      const [x1, y1] = c[c.length - 2], [x2, y2] = c[c.length - 1];
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const bx = x2 - Math.cos(ang) * hlen, by = y2 - Math.sin(ang) * hlen;
      const px_ = -Math.sin(ang) * hwid, py_ = Math.cos(ang) * hwid;
      polys.push([[x2, y2], [bx + px_, by + py_], [bx - px_, by - py_], [x2, y2]]);
    }
    if (!polys.length) return [];
    return [new Style({
      geometry: new Polygon(polys),
      fill: new Fill({ color: rgbaToCss(decor.color || [0, 0, 0, 1]) }),
      stroke: null,
    })];
  }
  return [];
}

// --- OpenLayers: feature → ol.style.Style のスタイル関数を生成
export function olQmlStyleFunction(compiled, OL) {
  const { Style, Fill, Stroke, Circle: CircleStyle, Icon, Text } = OL;
  return (feature, resolution) => {
    const props = feature.getProperties() || {};
    const spec = compiled.evaluate(props);
    if (!spec) return null;
    const s = specToStyle(spec);
    const geomType = feature.getGeometry()?.getType() || "";
    const styleOpts = {};
    if (s.fill && /Polygon/.test(geomType)) styleOpts.fill = new Fill({ color: s.fill });
    if (s.stroke) {
      styleOpts.stroke = new Stroke({
        color: s.stroke, width: s.strokeWidth, lineDash: s.dash || undefined,
        lineJoin: s.join || undefined, lineCap: s.cap || undefined,
      });
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
      const labelText = labelSpec?.text != null ? String(labelSpec.text) : "";
      if (labelSpec && labelText.trim()) {
        // 縮尺表示(labelScale)と最小地物サイズ(minFeatureSize)のゲート
        let show = true;
        const ls = labelSpec.labelScale;
        if (ls && Number.isFinite(resolution)) {
          const denom = resolution / 0.00028;
          if ((ls.minScale && denom < ls.minScale) || (ls.maxScale && denom > ls.maxScale)) show = false;
        }
        if (show && labelSpec.minFeatureSizePx && Number.isFinite(resolution)) {
          const ext = feature.getGeometry()?.getExtent?.();
          if (ext) {
            const wPx = Math.abs(ext[2] - ext[0]) / resolution;
            const hPx = Math.abs(ext[3] - ext[1]) / resolution;
            if (Math.hypot(wPx, hPx) < labelSpec.minFeatureSizePx) show = false;
          }
        }
        if (show) {
          const pl = labelSpec.placement || {};
          const isLine = /LineString/.test(geomType)
            || (/Polygon/.test(geomType) && ["line", "curved", "perimeter"].includes(pl.mode));
          const [ox, oy] = labelSpec.pixelOffsetOf ? labelSpec.pixelOffsetOf() : [0, 0];
          const bg = labelSpec.background;
          styleOpts.text = new Text({
            text: labelText,
            font: labelSpec.fontCss || "12px sans-serif",
            fill: new Fill({ color: rgbaToCss(labelSpec.fill || [0, 0, 0, 1]) }),
            stroke: labelSpec.halo
              ? new Stroke({ color: rgbaToCss(labelSpec.halo.color), width: Math.max(Number(labelSpec.halo.widthPx) || 1, 1) })
              : undefined,
            overflow: true,
            placement: isLine ? "line" : "point",
            repeat: isLine && pl.repeatDistancePx ? pl.repeatDistancePx : undefined,
            rotation: pl.rotationDeg ? -pl.rotationDeg * Math.PI / 180 : 0,
            rotateWithView: !isLine && !!pl.rotationDeg ? true : undefined,
            keepUpright: isLine ? labelSpec.upsidedown !== "show" : undefined,
            offsetX: isLine ? 0 : ox,
            offsetY: isLine ? 0 : oy,
            textAlign: { left: "left", center: "center", right: "right", justify: "center" }[labelSpec.align] || "center",
            justify: labelSpec.align && labelSpec.align !== "left" ? labelSpec.align : undefined,
            padding: bg ? [bg.padPx[0], bg.padPx[0], bg.padPx[1], bg.padPx[1]] : undefined,
            backgroundFill: bg ? new Fill({ color: rgbaToCss(bg.fill) }) : undefined,
            backgroundStroke: bg && bg.stroke
              ? new Stroke({ color: rgbaToCss(bg.stroke), width: Math.max(bg.strokeWidthPx, 1) })
              : undefined,
            maxAngle: isLine && pl.mode === "curved"
              ? Math.abs((pl.maxCurvedCharAngleIn || 25) * Math.PI / 180)
              : undefined,
          });
        }
      }
    }
    // MarkerLine/HashLine/ArrowLine の装飾を geometry 関数で追加描画する
    const decor = spec.line?.decor;
    if (decor && /LineString/.test(geomType)) {
      const extra = decorToOlStyles(decor, feature.getGeometry(), resolution, OL);
      if (extra.length) return [new Style(styleOpts), ...extra];
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
    if (s.join) feature.properties.__kasc_join = s.join;
    if (s.cap) feature.properties.__kasc_cap = s.cap;
    if (s.lineOffsetPx) feature.properties.__kasc_loff = s.lineOffsetPx;
    // 凡例シンボル単位の表示切替フィルタ用（規則ベースで複数ヒットし得るため先頭名を採用）
    const names = typeof compiled.namesFor === "function" ? compiled.namesFor(feature.properties) : null;
    if (names?.length) feature.properties.__kasc_symbol = names[0];
    // heatmapRenderer: 地物ごとの重みを焼き込む
    if (compiled.heatmap) {
      const w = Number(compiled.heatmap.weightFn ? compiled.heatmap.weightFn(feature.properties) : 1);
      const mv = compiled.heatmap.maxValue || 1;
      feature.properties.__kasc_heat = Math.min(Math.max((Number.isFinite(w) ? w : 1) / mv, 0), 1);
    }
  }
  const kinds = [
      ["fill", ["==", ["geometry-type"], "Polygon"], {
        "fill-color": ["coalesce", ["get", "__kasc_fill"], "#3a7bd5"],
        "fill-opacity": 0.5,
      }],
      ["line", ["!=", ["geometry-type"], "Point"], {
        "line-color": ["coalesce", ["get", "__kasc_stroke"], "#2c5ea8"],
        "line-width": ["coalesce", ["get", "__kasc_width"], 1.5],
        "line-offset": ["coalesce", ["get", "__kasc_loff"], 0],
      }, {
        "line-join": ["coalesce", ["get", "__kasc_join"], "bevel"],
        "line-cap": ["coalesce", ["get", "__kasc_cap"], "butt"],
      }],
      ["circle", ["==", ["geometry-type"], "Point"], {
        "circle-radius": 5,
        "circle-color": ["coalesce", ["get", "__kasc_color"], "#2c5ea8"],
        "circle-stroke-color": ["coalesce", ["get", "__kasc_stroke"], "#ffffff"],
        "circle-stroke-width": 1,
      }],
  ];
  // <labeling>: 焼き込んだ __kasc_label 系プロパティを参照する symbol レイヤを追加。
  // symbol-placement 等の非データ駆動 layout は配置モード別にレイヤを分ける
  const baked = bakeQmlLabels(geojson, compiled);
  let labelScaleRange = null;
  if (baked) {
    labelScaleRange = { minScale: baked.minScale, maxScale: baked.maxScale };
    const labeled = geojson.features.filter(f => f.properties?.__kasc_label);
    const placements = [...new Set(labeled.map(f => f.properties.__kasc_label_placement || "point"))];
    for (const pm of placements.length ? placements : ["point"]) {
      const group = labeled.filter(f => (f.properties.__kasc_label_placement || "point") === pm);
      const allowOverlap = group.every(f => f.properties.__kasc_label_overlap === true);
      const keepUpright = group.every(f => f.properties.__kasc_label_upright !== false);
      const spacing = Math.min(...group.map(f => f.properties.__kasc_label_spacing || 250));
      const maxw = Math.min(...group.map(f => f.properties.__kasc_label_maxw || 10));
      const lh = group[0]?.properties.__kasc_label_lh ?? 1;
      const letter = group[0]?.properties.__kasc_label_letter ?? 0;
      const tf = group.every(f => f.properties.__kasc_label_tf === "uppercase") ? "uppercase"
        : group.every(f => f.properties.__kasc_label_tf === "lowercase") ? "lowercase" : "none";
      kinds.push(["symbol", ["all", ["has", "__kasc_label"], ["==", ["get", "__kasc_label_placement"], pm]], {
        "text-color": ["coalesce", ["get", "__kasc_label_color"], "#222222"],
        "text-halo-color": ["coalesce", ["get", "__kasc_label_halo"], "rgba(0,0,0,0)"],
        "text-halo-width": ["coalesce", ["get", "__kasc_label_halo_w"], 0],
      }, {
        "symbol-placement": pm === "line" ? "line" : "point",
        "text-field": ["get", "__kasc_label"],
        "text-size": ["coalesce", ["get", "__kasc_label_size"], 12],
        "text-font": ["literal", ["Noto Sans Regular"]],
        "text-rotate": ["coalesce", ["get", "__kasc_label_rot"], 0],
        "text-offset": ["get", "__kasc_label_off"],
        "text-anchor": ["coalesce", ["get", "__kasc_label_anchor"], "center"],
        "text-justify": ["coalesce", ["get", "__kasc_label_justify"], "auto"],
        "symbol-sort-key": ["coalesce", ["get", "__kasc_label_sort"], 0],
        "symbol-spacing": Math.max(spacing, 1),
        "symbol-avoid-edges": false,
        "text-allow-overlap": allowOverlap,
        "text-keep-upright": keepUpright,
        "text-optional": true,
        "text-padding": 2,
        "text-max-width": Math.max(maxw, 1),
        ...(letter ? { "text-letter-spacing": letter } : {}),
        ...(lh && lh !== 1 ? { "text-line-height": lh } : {}),
        ...(tf !== "none" ? { "text-transform": tf } : {}),
      }]);
    }
  }
  return {
    kinds,
    props: KASC_PROPS,
    labelScaleRange,
    heatmap: compiled.heatmap || null,
  };
}
