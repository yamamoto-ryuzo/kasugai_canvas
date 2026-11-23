// .kasc の style=<QML> を 2D エンジンへ適用するアダプタ（エンジン非依存の評価 + 各エンジン変換）
// shared/qml-style.js の compileQmlStyle が返す spec:
//   evaluate(props) → { markers, line:{color,widthPx,dash}, fillParts:[{solid|rgba|hatch}],
//                       outline:{color,widthPx,dash}, centroid, scale, label }
import { loadQmlStyle, rgbaToCss, markerLayersToCanvas, fillPartsToTile, qmlLabelCanvas, setLayerVisibilityResolver, setExprFeatureResolver, setMapScaleGetter, setEvalScale, evalScaleDenom, linRefFormatText, clampMapUnitsPerPixel, MUP_PER_SCALE_DENOM, interpolatedColorAt, sizeToPx, blankCheckForPart } from "./qml-style.js";
import { resolveKascUrl } from "./kasc.js";

// qml-style.js の縮尺注入 API を 2D アダプタ経由で各エンジンへ再公開
export { setMapScaleGetter, setEvalScale };

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

// QML 式の get_feature(layer,attr,value)/get_feature_by_id(layer,id) を、
// 読み込み済みレイヤーの GeoJSON(item._geojson または geojsonSource)へ解決する。
// レイヤー名照合は is_layer_visible と同じ規則。未発見時 null(QGIS でレイヤー無しと同じ)。
// get_feature は attr=value の先頭一致(C++ QgsExpressionUtils::getFeature 同様)、
// by_id は feature.id 一致を優先し、無ければ配列 index(OGR FID 相当)を引く
export function installExprFeatureResolver(getItems) {
  setExprFeatureResolver((layerName, attrName, value) => {
    const key = String(layerName ?? "").trim();
    if (!key) return null;
    const items = getItems?.() || [];
    const item = items.find(it => {
      if (!it) return false;
      if (it.title === key || it.id === key) return true;
      const path = (it.group ? `${it.group}/${it.title}` : String(it.title || ""));
      return path.split("/").map(seg => seg.trim()).includes(key);
    });
    const feats = item?._geojson?.features ?? item?.geojsonSource?.features;
    if (!Array.isArray(feats)) return null;
    if (attrName == null) {
      return feats.find(f => f?.id != null && String(f.id) === String(value))
        ?? feats[Number(value)] ?? null;
    }
    const col = String(attrName);
    return feats.find(f => {
      const v = f?.properties?.[col];
      return v === value || (v != null && value != null && String(v) === String(value));
    }) ?? null;
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
  "__kasc_label_maxa", "__kasc_label_img", "__kasc_label_off_px",
  "__kasc_label_vgrp",
];

// QGIS predefinedPositionOrder の位置コード → MapLibre/Navara アンカー名。
// QGIS4 enum は TL/TSL/T/TSR/TR/L/R/BL/BSL/B/BSR/BR(S=Slightly → 基本方位へ畳む)
export const QML_POS_CODE_TO_ANCHOR = {
  TL: "top-left", TSL: "top", T: "top", TSR: "top", TR: "top-right",
  L: "left", R: "right",
  BL: "bottom-left", BSL: "bottom", B: "bottom", BSR: "bottom", BR: "bottom-right",
};

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

// 中空ハロー(bufferNoFill)ラベルの canvas ラスタライズ結果の一意キー発行用
let _qmlLabelIconUid = 0;
export function bakeQmlLabels(geojson, compiled, labelIcons = null) {
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
      // icon-image 経路用に px 単位のオフセットも焼く(__kasc_label_off は em)
      props.__kasc_label_off_px = [Math.round(oxPx), Math.round(oyPx)];
      // bufferNoFill(中空ハロー): MapLibre の text-halo では中空を描けないため
      // canvas ラスタライズして icon-image で表示する。labelIcons 未指定時は
      // 従来通り text-halo で近似する
      delete props.__kasc_label_img;
      if (spec.halo?.noFill && labelIcons) {
        const r = qmlLabelCanvas({ ...spec, text });
        if (r) {
          const key = `ql_${_qmlLabelIconUid++}`;
          labelIcons.set(key, r.canvas);
          props.__kasc_label_img = key;
        }
      }
      if (props.__kasc_label_img) delete props.__kasc_label;
      else props.__kasc_label = text;
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
      // predefinedPositionOrder → MapLibre text-variable-anchor +
      // text-radial-offset / Navara variableAnchors 共通の候補リスト。
      // 非データ駆動 layout のため JSON 文字列でグルーピングする
      delete props.__kasc_label_vgrp;
      if (pl.predefinedOrder?.length && props.__kasc_label_placement === "point") {
        const anchors = pl.predefinedOrder
          .map(c => QML_POS_CODE_TO_ANCHOR[String(c).trim().toUpperCase()])
          .filter(Boolean);
        if (anchors.length) {
          const rad = Math.max(Math.round(((pl.distPx || 0) / sizePx) * 100) / 100, 0);
          props.__kasc_label_vgrp = JSON.stringify([anchors, rad]);
        }
      }
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
      // curved 配置の隣接文字最大角度(度)。ML text-max-angle 用
      props.__kasc_label_maxa = Number(pl.maxCurvedCharAngleIn) || 0;
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
  // bufferNoFill(中空ハロー)は CSS text-shadow では再現できないため
  // canvas ラスタライザへ切り替える(tooltip 内に canvas を埋め込む)
  if (spec.halo?.noFill) {
    const r = qmlLabelCanvas(spec);
    if (!r) return null;
    const rot = spec.placement?.rotationDeg;
    if (rot) r.canvas.style.transform = `rotate(${rot}deg)`;
    r.canvas._kascLabelSpec = spec;
    return r.canvas;
  }
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
  // pre-line だと CJK は全文字が改行機会となり tooltip の
  // shrink-to-fit が 1 文字幅(min-content)へ潰れるため pre を使う。
  // 改行(\n)は pre でも維持される
  span.style.whiteSpace = "pre";
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
    else if (bg.radiusPx) span.style.borderRadius = `${bg.radiusPx}px`;
    if (bg.stroke) span.style.border = `${Math.max(bg.strokeWidthPx, 1)}px solid ${rgbaToCss(bg.stroke)}`;
    if (bg.rotationDeg) span.style.transform = `rotate(${bg.rotationDeg}deg)`;
  }
  const rot = spec.placement?.rotationDeg;
  if (rot) span.style.transform = `${span.style.transform || ""} rotate(${rot}deg)`;
  // Leaflet tooltip のオフセット・ズーム連動用に spec を保持
  span._kascLabelSpec = spec;
  return span;
}

export async function loadCompiledQml(urlOrPath, baseUrl, engine = null) {
  const url = resolveKascUrl(urlOrPath, baseUrl);
  return loadQmlStyle(url, async u => {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`QML 取得失敗: ${u} (${res.status})`);
    return res.text();
  }, engine);
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
// MapUnit/MetersInMapUnits 由来のメートル値を現在縮尺で px へ換算する。
// mus(QgsMapUnitScale)があれば QGIS 準拠で mup をクランプする。
// 縮尺未取得時は null(呼び出し側は widthPx/sizePx 近似へフォールバック)
function metersToPx(meters, mus) {
  if (!Number.isFinite(meters)) return null;
  const sd = evalScaleDenom();
  if (!sd) return null;
  const mup = clampMapUnitsPerPixel(sd * MUP_PER_SCALE_DENOM, mus);
  if (!(mup > 0)) return null;
  return meters / mup;
}

export function specToStyle(spec) {
  if (!spec) return null;
  const strokeSrc = spec.outline || spec.line || null;
  // 線幅: MapUnit 系はメートル保持されているため現縮尺で px へ換算
  // (QGIS QgsRenderContext::convertToPainterUnits の MapUnits 分岐相当)。
  // 解像度不明時は widthPx 近似のまま
  let strokeWidth = strokeSrc?.widthPx ?? 1.5;
  if (Number.isFinite(strokeSrc?.widthMeters)) {
    const px = metersToPx(strokeSrc.widthMeters, strokeSrc.widthMus);
    if (px != null) strokeWidth = Math.max(px, 0.25);
  }
  let lineOffsetPx = spec.line?.offsetPx || 0;
  if (Number.isFinite(spec.line?.offsetMeters)) {
    const px = metersToPx(spec.line.offsetMeters, spec.line.offsetMus);
    if (px != null) lineOffsetPx = px;
  }
  return {
    fill: fillColorOf(spec),
    stroke: strokeSrc ? rgbaToCss(strokeSrc.color) : null,
    strokeWidth,
    dash: strokeSrc?.dash || null,
    dashOffsetPx: strokeSrc?.dashOffsetPx || 0,
    join: strokeSrc?.join || null,
    cap: strokeSrc?.cap || null,
    lineOffsetPx,
    trimStartPx: strokeSrc?.trimStartPx || 0,
    trimEndPx: strokeSrc?.trimEndPx || 0,
    markerColor: markerColorOf(spec) || "#2c5ea8",
    markerCanvas: spec.markers?.length ? markerLayersToCanvas(spec.markers) : null,
    // MapUnit マーカー: 現縮尺での目標px(canvas拡縮率の算出用)
    markerSizePx: spec.markers?.length && Number.isFinite(spec.markers[0]?.sizeMeters)
      ? metersToPx(spec.markers[0].sizeMeters, spec.markers[0].sizeMetersMus)
      : null,
  };
}

// --- 線端トリム(QML trim_distance_start/end)のジオメトリ近似 ---
// QML の trim は画面 px 指定だが、ジオメトリを削る方式では地物読込時に
// 基準縮尺(1:1万, qml-style.js の METERS_PER_PX 相当)へ換算して適用する。
// OL は描画ごとの resolution で正確に換算するため近似不要

// 平面座標列 [[x,y],...] を先頭 startU・末尾 endU(座標と同じ単位)だけ短くする
export function trimCoordsPlanar(coords, startU = 0, endU = 0) {
  if (!coords || coords.length < 2 || (startU <= 0 && endU <= 0)) return coords;
  const segs = [];
  let total = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const L = Math.hypot(...coords[i + 1].map((v, k) => v - coords[i][k]));
    segs.push(L);
    total += L;
  }
  if (!total || startU + endU >= total) return coords;
  const a = Math.max(0, Math.min(startU, total));
  const b = Math.max(0, Math.min(endU, total - a));
  const from = a, to = total - b;
  const out = [];
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const L = segs[i], s = acc, e = acc + L;
    const c1 = coords[i], c2 = coords[i + 1];
    if (out.length === 0 && from <= e && L > 0) {
      const t = (from - s) / L;
      out.push(c1.map((v, k) => v + (c2[k] - v) * t));
    }
    if (out.length && to >= e) {
      out.push([...c2]);
    } else if (out.length && to > s && L > 0) {
      const t = (to - s) / L;
      out.push(c1.map((v, k) => v + (c2[k] - v) * t));
      break;
    }
    acc = e;
    if (s >= to) break;
  }
  return out.length >= 2 ? out : coords;
}

// Web メルカトル球体近似([lon,lat]度 ↔ [x,y]m)
const _R = 6378137;
const ll2m = ([lon, lat]) => [_R * lon * Math.PI / 180,
  _R * Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, lat)) * Math.PI / 360))];
const m2ll = ([x, y]) => [x / _R * 180 / Math.PI,
  (2 * Math.atan(Math.exp(y / _R)) - Math.PI / 2) * 180 / Math.PI];

// GeoJSON(4326) の LineString/MultiLineString 座標列を m 単位でトリムする
export function trimGeoJsonLine(geom, startM = 0, endM = 0) {
  if (!geom || (startM <= 0 && endM <= 0)) return;
  const trimPart = coords => {
    const m = trimCoordsPlanar(coords.map(ll2m), startM, endM);
    return m.map(m2ll);
  };
  if (geom.type === "LineString") {
    const c = trimPart(geom.coordinates);
    if (c !== geom.coordinates) geom.coordinates = c;
  } else if (geom.type === "MultiLineString") {
    geom.coordinates = geom.coordinates.map(c => trimPart(c));
  }
}

// 線 spec の trim(px) を基準縮尺 1:1万のメートルへ換算
// (qml-style.js REFERENCE_SCALE と同じ 0.00028 m/mm 換算: 1px ≒ 2.8m)
export const TRIM_PX_TO_M = 2.8;

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

// LinearReferencing(里程標): 平面座標列(ソースCRS単位)を interval 間隔で
// サンプル。戻り値 [{x,y,angle,dist}] — angle は進行方向(y-up 空間の
// atan2 rad)、dist はパート先頭からの累積距離(ソース単位)。
// skip_multiples はその倍数地点を除外
export function linRefSamplesPlanar(coordsList, interval, { skipMultiples = 0, startMeasure = 0, max = 500 } = {}) {
  const out = [];
  const step = Math.max(interval || 0, 1e-9);
  const skip = Math.max(skipMultiples || 0, 0);
  const eps = step * 1e-6;
  for (const coords of coordsList || []) {
    if (!coords || coords.length < 2) continue;
    let acc = 0, next = step;
    for (let i = 0; i + 1 < coords.length && out.length < max; i++) {
      const [x1, y1] = coords[i], [x2, y2] = coords[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
      if (!len) continue;
      const ang = Math.atan2(dy, dx);
      while (next <= acc + len + eps && out.length < max) {
        const t = Math.min(Math.max((next - acc) / len, 0), 1);
        if (!(skip > 0 && Math.abs(next % skip) < Math.max(eps, skip * 1e-6))) {
          out.push({ x: x1 + dx * t, y: y1 + dy * t, angle: ang, dist: next });
        }
        next += step;
      }
      acc += len;
    }
    if (out.length >= max) break;
  }
  if (startMeasure) for (const s of out) s.dist += startMeasure;
  return out;
}

// GeoJSON(4326) LineString/MultiLineString → QGIS 同様にソース座標単位(度)
// で標点サンプルして 4326 座標を返す。labelOffsetPx は基準縮尺
// (TRIM_PX_TO_M=2.8m/px)換算で座標へ直接焼き込む(回転時は線方向系、
// 非回転時は画面系)。dist ラベルもソース単位(度)の累積距離
export function linRefSamplesGeojson(geom, decor) {
  const parts = geom?.type === "LineString" ? [geom.coordinates]
    : geom?.type === "MultiLineString" ? geom.coordinates : [];
  const [lox, loy] = decor?.labelOffsetPx || [0, 0];
  const dxm = (lox || 0) * TRIM_PX_TO_M, dym = (loy || 0) * TRIM_PX_TO_M;
  const rot = !!decor?.rotate;
  const out = [];
  for (const c of parts) {
    for (const s of linRefSamplesPlanar([c], decor?.interval, decor || {})) {
      // オフセット(px→m 換算)はメルカトル m 空間で適用して 4326 へ戻す
      const [mx, my] = ll2m([s.x, s.y]);
      const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
      const x = rot ? mx + dxm * ca + dym * sa : mx + dxm;
      const y = rot ? my + dxm * sa - dym * ca : my - dym;
      const [lon, lat] = m2ll([x, y]);
      out.push({ coord: [lon, lat], angle: s.angle, dist: s.dist });
    }
  }
  return out;
}

// GeoJSON(4326) LineString/MultiLineString を弧長で n 等分したセグメント
// 地物へ分解する(InterpolatedLine の Leaflet/Navara 近似用)。
// 各地物の properties には __kasc_iseg={f:弧長中央比率} と元 properties を継承
export function splitInterpolatedGeojson(geom, baseProps, n = 24) {
  const parts = geom?.type === "LineString" ? [geom.coordinates]
    : geom?.type === "MultiLineString" ? geom.coordinates : [];
  const out = [];
  for (const c of parts) {
    const segs = splitLinePlanar(c.map(ll2m), n);
    for (const s of segs) {
      out.push({
        type: "Feature",
        properties: { ...(baseProps || {}), __kasc_iseg: s.mid },
        geometry: { type: "LineString", coordinates: s.coords.map(m2ll) },
      });
    }
  }
  return out;
}

// InterpolatedLine のセグメント地物(__kasc_iseg)に色・幅を焼き込む。
// evaluate 済み spec の line.decor を参照する
export function interpolatedSegmentStyle(decor, f) {
  return {
    color: rgbaToCss(interpolatedColorAt(decor, f)),
    width: Math.max((decor.w1 || 1) + ((decor.w2 || decor.w1 || 1) - (decor.w1 || 1)) * f, 0.5),
  };
}

// 平面座標列を弧長で n 等分する。[{coords, mid}] mid=区間中央の弧長比率
// (InterpolatedLine の線分細分化用)
function splitLinePlanar(coords, n) {
  if (!coords || coords.length < 2 || !(n > 0)) return [];
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0], dy = coords[i][1] - coords[i - 1][1];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [];
  const at = d => {
    let j = 1;
    while (j < cum.length - 1 && cum[j] < d) j++;
    const f = Math.min(1, (d - cum[j - 1]) / Math.max(cum[j] - cum[j - 1], 1e-12));
    return [coords[j - 1][0] + (coords[j][0] - coords[j - 1][0]) * f,
      coords[j - 1][1] + (coords[j][1] - coords[j - 1][1]) * f];
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const d0 = total * i / n, d1 = total * (i + 1) / n;
    const seg = [at(d0)];
    for (let j = 1; j < coords.length; j++) {
      if (cum[j] > d0 && cum[j] < d1) seg.push(coords[j]);
    }
    seg.push(at(d1));
    if (seg.length >= 2) out.push({ coords: seg, mid: (i + 0.5) / n });
  }
  return out;
}

// InterpolatedLine 装飾 → 区間分割 Stroke 群。色は interpolatedColorAt
// (ramp 優先)、幅は w1→w2 線形補間(OL は data-driven 幅を持てないため
// セグメント別 Style を生成する近似)
function interpolatedToOlStyles(decor, geom, resolution, OL) {
  const { Style, Stroke, LineString, MultiLineString } = OL;
  if (!LineString || !geom || !Number.isFinite(resolution)) return [];
  const lines = geom.getType() === "MultiLineString" && MultiLineString
    ? geom.getCoordinates() : [geom.getCoordinates()];
  const styles = [];
  const N = 24;
  for (const coords of lines) {
    for (const seg of splitLinePlanar(coords, N)) {
      const w = decor.w1 + (decor.w2 - decor.w1) * seg.mid;
      styles.push(new Style({
        geometry: new LineString(seg.coords),
        stroke: new Stroke({
          color: rgbaToCss(interpolatedColorAt(decor, seg.mid)),
          width: Math.max(w || 1, 0.5),
        }),
      }));
    }
  }
  return styles;
}

// MarkerLine 配置サンプリング。Qgis C++ QgsTemplatedLineSymbolLayerBase の
// renderPolylineInterval/renderPolylineCentral/renderPolylineVertex/
// renderOffsetVertexAlongLine/markerAngle に準拠。
// 戻り値 [{x,y,angle}] — angle は y-up 空間の進行方位(rad)。
// - interval: 距離 offset_along_line から interval 毎(lengthLeft=interval-offset)
// - vertex: 全頂点。閉リングは終端(=始端の重複)を除く。curvepoint は近似として同扱い
// - innervertices: 端点を除く頂点
// - firstvertex/lastvertex: 端点。offset_along_line>0 時は線に沿って
//   +offset/-offset の地点(到達不能なら描かない=C++ と同じ)。place_on_every_part=0
//   なら先頭パートのみ
// - segmentcenter: 各セグメント中点(セグメント角)
// - centralpoint: 全長の半分の地点(所在セグメント角)
// 角度は rotate=1 の場合に適用される: 内点は両隣セグメントの単位ベクトル和
// (C++ _averageAngle)、端点は最近傍非縮退セグメント。average_angle_length>0 は
// interval/centralpoint で地点±avg の2点を結ぶ線の角
export function markerlineDecorSamples(geom, decor, px) {
  const lines = geom.getType() === "LineString" ? [geom.getCoordinates()]
    : (geom.getCoordinates?.() || []);
  const MAX = 500;
  const out = [];
  const eq = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  const segAng = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const totalLen = c => {
    let l = 0;
    for (let i = 0; i + 1 < c.length; i++)
      l += Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]);
    return l;
  };
  // 累積距離 d の点と所在セグメント角(d>total は終点に張り付き)
  const pointAt = (c, d) => {
    let acc = 0;
    for (let i = 0; i + 1 < c.length; i++) {
      const dx = c[i + 1][0] - c[i][0], dy = c[i + 1][1] - c[i][1];
      const len = Math.hypot(dx, dy);
      if (len > 0 && d <= acc + len) {
        const t = (d - acc) / len;
        return { x: c[i][0] + dx * t, y: c[i][1] + dy * t, angle: Math.atan2(dy, dx) };
      }
      acc += len;
    }
    const a = c[c.length - 2], b = c[c.length - 1];
    return { x: b[0], y: b[1], angle: a ? segAng(a, b) : 0 };
  };
  // C++ markerAngle: 内点は前後の非重複頂点を結ぶ2ベクトルの和(_averageAngle)、
  // リング端点は count-2→1、非リング端点は最近傍非縮退セグメント
  const vertexAngle = (c, isRing, i) => {
    const pt = c[i];
    if (isRing || (i > 0 && i < c.length - 1)) {
      let pi = i - 1, ni = i + 1;
      if (isRing && (i === 0 || i === c.length - 1)) { pi = c.length - 2; ni = 1; }
      let prev, next;
      while (pi >= 0) { prev = c[pi]; if (!eq(prev, pt)) break; pi--; }
      while (ni < c.length) { next = c[ni]; if (!eq(next, pt)) break; ni++; }
      if (pi >= 0 && ni < c.length) {
        const a1 = segAng(prev, pt), a2 = segAng(pt, next);
        return Math.atan2(Math.sin(a1) + Math.sin(a2), Math.cos(a1) + Math.cos(a2));
      }
      return 0;
    }
    if (i === 0) {
      for (let j = i; j < c.length - 1; j++)
        if (!eq(c[j], c[j + 1])) return segAng(c[j], c[j + 1]);
    } else {
      for (let j = i; j >= 1; j--)
        if (!eq(c[j - 1], c[j])) return segAng(c[j - 1], c[j]);
    }
    return 0;
  };
  const flags = new Set(String(decor.placement || "interval").toLowerCase().split(/[|,\s]+/).filter(Boolean));
  if (!flags.size) flags.add("interval");
  const off = px(decor.offsetAlongPx || 0) || 0;
  const avg = px(decor.avgAnglePx || 0) || 0;
  const everyPart = decor.everyPart !== false;
  // blank_segments_unit → マップ単位距離 変換(MapUnit は生値、絵単位は px 経由)
  const blankConv = v => {
    const u = String(decor.blankSegmentsUnit || "MM");
    if (u === "MapUnit" || u === "MetersInMapUnits" || u === "RenderMetersInMapUnits") return v;
    return px(sizeToPx(v, u) || 0);
  };
  let partIdx = -1;
  let firstPart = true;
  for (const c of lines) {
    if (!c || c.length < 2) continue;
    partIdx++;
    const isFirst = firstPart; firstPart = false;
    if (out.length >= MAX) break;
    const n = c.length;
    const isRing = n > 2 && eq(c[0], c[n - 1]);
    const total = totalLen(c);
    // blank_segments: [start,end] 内の距離の標点は描画しない(C++ BlankSegmentsWalker)
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]));
    const blank = blankCheckForPart(decor, partIdx, blankConv);
    const windowAngle = d => avg > 0
      ? segAng(pointAt(c, Math.max(0, d - avg)), pointAt(c, Math.min(total, d + avg)))
      : undefined;
    if (flags.has("interval")) {
      const stepMap = Math.max(px(decor.intervalPx || 30), 1e-6);
      let d = off;
      // C++: 閉リングでは offset を全長で fmod する
      if (isRing && total > 0 && off !== 0) d = ((off % total) + total) % total;
      for (; d <= total && out.length < MAX; d += stepMap) {
        if (blank && blank(d)) continue;
        const s = pointAt(c, Math.min(d, total));
        const wa = windowAngle(d);
        out.push({ x: s.x, y: s.y, angle: wa !== undefined ? wa : s.angle });
      }
    }
    if (flags.has("vertex") || flags.has("curvepoint")) {
      const m = isRing ? n - 1 : n;
      for (let i = 0; i < m && out.length < MAX; i++) {
        if (blank && blank(cum[i])) continue;
        out.push({ x: c[i][0], y: c[i][1], angle: vertexAngle(c, isRing, i) });
      }
    }
    if (flags.has("innervertices")) {
      const m = isRing ? n - 1 : n;
      for (let i = 1; i < m - 1 && out.length < MAX; i++) {
        if (blank && blank(cum[i])) continue;
        out.push({ x: c[i][0], y: c[i][1], angle: vertexAngle(c, isRing, i) });
      }
    }
    if (flags.has("segmentcenter")) {
      for (let i = 0; i + 1 < n && out.length < MAX; i++) {
        if (eq(c[i], c[i + 1])) continue;
        if (blank && blank((cum[i] + cum[i + 1]) / 2)) continue;
        out.push({ x: (c[i][0] + c[i + 1][0]) / 2, y: (c[i][1] + c[i + 1][1]) / 2,
          angle: segAng(c[i], c[i + 1]) });
      }
    }
    // offset_along_line は C++ 同様 First/LastVertex にのみ適用される
    if (flags.has("firstvertex") && (everyPart || isFirst)) {
      if (off > 0 && off <= total) { if (!blank || !blank(off)) out.push(pointAt(c, off)); }
      else if (off <= 0 && (!blank || !blank(0)))
        out.push({ x: c[0][0], y: c[0][1], angle: vertexAngle(c, isRing, 0) });
    }
    if (flags.has("lastvertex") && (everyPart || isFirst)) {
      if (off > 0 && off <= total) { if (!blank || !blank(total - off)) out.push(pointAt(c, total - off)); }
      else if (off <= 0 && (!blank || !blank(total)))
        out.push({ x: c[n - 1][0], y: c[n - 1][1], angle: vertexAngle(c, isRing, n - 1) });
    }
    if (flags.has("centralpoint")) {
      const d = total / 2;
      if (!blank || !blank(d)) {
        const s = pointAt(c, d);
        const wa = windowAngle(d);
        out.push({ x: s.x, y: s.y, angle: wa !== undefined ? wa : s.angle });
      }
    }
  }
  return out;
}

// --- ArrowLine: QGIS C++ QgsArrowSymbolLayer の straightArrow/curvedArrow/
// renderPolyline を y-up 平面座標へ移植。
// lines: [[x,y]...] (地図単位), px: px→地図単位変換, 戻り値: 外周リング配列
// [[ [x,y],... ]...] (未閉合)。C++ は矢印全体(始点→終点)を1ポリゴンとして
// Fill サブシンボルで塗る。head_length=線方向の矢頭長、head_thickness=
// ±垂直方向への張出し(全幅は2倍)、arrow_width=胴体幅、arrow_start_width=尾幅。
// head_type: 0=末尾(HeadSingle) 1=反転(HeadReversed) 2=両端(HeadDouble)
// arrow_type: 0=両側(ArrowPlain) 1=左半(ArrowLeftHalf) 2=右半(ArrowRightHalf)
// is_curved=1: 3点外接円弧に沿った矢印(2点なら直線フォールバック)
// is_repeated=1: curved は2頂点おきの3連、直線は全セグメントごとに描く
// spiralArcTo は半径線形補間のアルキメデス螺旋で近似(C++ 自体も円弧近似)
export function arrowLinePolygonRings(lines, decor, px) {
  const HL = px(decor.headLenPx || 0) || px(9);   // 矢頭の線方向長(head_length)
  const HT = px(decor.headWidthPx || 0) || px(9); // 矢頭の半幅(head_thickness)
  const W = px(decor.tailWidthPx || 0);           // 胴体幅(arrow_width)
  const SW = px(decor.startWidthPx ?? W) || 0;    // 尾幅(arrow_start_width)
  const OFF = px(decor.offsetPx || 0);
  const headType = decor.headType | 0;
  const arrowType = decor.arrowType | 0;
  const drawR = arrowType === 0 || arrowType === 2; // ArrowRightHalf=右側のみ
  const drawL = arrowType === 0 || arrowType === 1; // ArrowLeftHalf=左側のみ
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  // ---- C++ straightArrow そのまま
  const straight = (po0, pd0) => {
    let po = [...po0], pd = [...pd0];
    let len = dist(po, pd);
    if (len < 1e-12) return null;
    // 矢頭が入らない短さなら C++ と同じく端点をずらして矢頭だけ描く
    if (headType === 0 && len < HL) {
      po = [pd[0] - (pd[0] - po[0]) / len * HL, pd[1] - (pd[1] - po[1]) / len * HL];
      len = HL;
    } else if (headType === 1 && len < HL) {
      pd = [po[0] + (pd[0] - po[0]) / len * HL, po[1] + (pd[1] - po[1]) / len * HL];
      len = HL;
    } else if (headType === 2 && len < 2 * HL) {
      const vx = (pd[0] - po[0]) / len * HL, vy = (pd[1] - po[1]) / len * HL;
      const mx = (po[0] + pd[0]) / 2, my = (po[1] + pd[1]) / 2;
      po = [mx - vx, my - vy]; pd = [mx + vx, my + vy]; len = 2 * HL;
    }
    const body = len - HL;
    const ux = (pd[0] - po[0]) / len, uy = (pd[1] - po[1]) / len;
    const vx = -uy, vy = ux;
    po = [po[0] + vx * OFF, po[1] + vy * OFF];
    pd = [pd[0] + vx * OFF, pd[1] + vy * OFF];
    const at = (t, s) => [po[0] + ux * t + vx * s, po[1] + uy * t + vy * s];
    const ring = [];
    if (headType === 2) {
      ring.push(po);
      if (drawR) ring.push(at(HL, HT), at(HL, W / 2), at(body, W / 2), at(body, HT));
      ring.push(pd);
      if (drawL) ring.push(at(body, -HT), at(body, -W / 2), at(HL, -W / 2), at(HL, -HT));
    } else if (headType === 0) {
      if (drawR) ring.push(at(0, SW / 2), at(body, W / 2), at(body, HT));
      else ring.push(po);
      ring.push(pd);
      if (drawL) ring.push(at(body, -HT), at(body, -W / 2), at(0, -SW / 2));
      else ring.push(po);
    } else { // HeadReversed: 矢頭は po 側
      ring.push(po);
      if (drawR) ring.push(at(HL, HT), at(HL, W / 2), [pd[0] + vx * SW / 2, pd[1] + vy * SW / 2]);
      else ring.push(pd);
      if (drawL) ring.push([pd[0] - vx * SW / 2, pd[1] - vy * SW / 2], at(HL, -W / 2), at(HL, -HT));
      else ring.push(pd);
    }
    return ring;
  };

  // ---- C++ pointsToCircle/clampAngle/circlePoint の移植
  const circleOf = (a, b, c) => {
    const abx = b[0] - a[0], aby = b[1] - a[1], bcx = c[0] - b[0], bcy = c[1] - b[1];
    if (Math.abs(abx * bcy - aby * bcx) < 0.001) return null;
    const ab2x = (a[0] + b[0]) / 2, ab2y = (a[1] + b[1]) / 2;
    const bc2x = (b[0] + c[0]) / 2, bc2y = (b[1] + c[1]) / 2;
    let cx, cy;
    if (aby === 0) { cx = ab2x; cy = bc2y - (cx - bc2x) * bcx / bcy; }
    else if (bcy === 0) { cx = bc2x; cy = ab2y - (cx - ab2x) * abx / aby; }
    else {
      cx = (ab2y - bc2y + bcx * bc2x / bcy - abx * ab2x / aby) / (bcx / bcy - abx / aby);
      cy = ab2y - (cx - ab2x) * abx / aby;
    }
    return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) };
  };
  const clampA = a => a > 2 * Math.PI ? a - 2 * Math.PI : (a < 0 ? a + 2 * Math.PI : a);

  // ---- C++ curvedArrow。pathArcTo/spiralArcTo は角度・半径とも線形補間で
  // サンプリング(spiralArcTo 自体も中間点を経由する円弧2本の近似)
  const curved = (po0, pm0, pd0) => {
    const c = circleOf(po0, pm0, pd0);
    if (!c) return straight(po0, pd0);
    let { cx, cy, r: R } = c;
    const angleOf = p => clampA(Math.atan2(cy - p[1], p[0] - cx));
    const ao = angleOf(po0), am = angleOf(pm0), ad = angleOf(pd0);
    const dir = clampA(am - ao) < clampA(am - ad) ? 1 : -1;
    const aType = arrowType === 2 ? dir : (arrowType === 1 ? -dir : 0);
    let delta = ad - ao;
    if (dir * delta < 0) delta += dir * 2 * Math.PI;
    const len = dist(po0, pd0);
    if (Math.abs(delta) < Math.PI &&
      ((headType === 0 && len < HL) || (headType === 1 && len < HL) ||
       (headType === 2 && len < 2 * HL))) {
      return straight(po0, pd0);
    }
    R += OFF;
    const cPt = (r, a) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    const po = cPt(R, ao), pd = cPt(R, ad);
    const headAngle = dir * Math.atan(HL / R);
    const arc = (ring, r, a0, a1, d, n = 16) => {
      let dd = a1 - a0;
      if (d * dd < 0) dd += d * 2 * Math.PI;
      for (let i = 1; i <= n; i++) ring.push(cPt(r, a0 + dd * i / n));
    };
    const spiral = (ring, a0, r0, a1, r1, d, n = 16) => {
      let dd = a1 - a0;
      if (d * dd < 0) dd += d * 2 * Math.PI;
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        ring.push(cPt(r0 + (r1 - r0) * f, a0 + dd * f));
      }
    };
    const ring = [];
    if (headType === 2) {
      ring.push(po);
      if (aType <= 0) {
        ring.push(cPt(R + dir * HT, ao + headAngle));
        arc(ring, R + dir * W / 2, ao + headAngle, ad - headAngle, dir);
        ring.push(cPt(R + dir * HT, ad - headAngle), pd);
      } else arc(ring, R, ao, ad, dir);
      if (aType >= 0) {
        ring.push(cPt(R - dir * HT, ad - headAngle));
        arc(ring, R - dir * W / 2, ad - headAngle, ao + headAngle, -dir);
        ring.push(cPt(R - dir * HT, ao + headAngle), po);
      } else arc(ring, R, ad, ao, -dir);
    } else if (headType === 0) {
      if (aType <= 0) {
        ring.push(cPt(R + dir * SW / 2, ao));
        spiral(ring, ao, R + dir * SW / 2, ad - headAngle, R + dir * W / 2, dir);
        ring.push(cPt(R + dir * HT, ad - headAngle), pd);
      } else { ring.push(po); arc(ring, R, ao, ad, dir); }
      if (aType >= 0) {
        ring.push(cPt(R - dir * HT, ad - headAngle));
        spiral(ring, ad - headAngle, R - dir * W / 2, ao, R - dir * SW / 2, -dir);
        ring.push(cPt(R + dir * SW / 2, ao));
      } else { arc(ring, R, ad, ao, -dir); ring.push(cPt(R + dir * SW / 2, ao)); }
    } else { // HeadReversed
      ring.push(po);
      if (aType <= 0) {
        ring.push(cPt(R + dir * HT, ao + headAngle), cPt(R + dir * W / 2, ao + headAngle));
        spiral(ring, ao + headAngle, R + dir * W / 2, ad, R + dir * SW / 2, dir);
      } else arc(ring, R, ao, ad, dir);
      if (aType >= 0) {
        ring.push(cPt(R - dir * SW / 2, ad));
        spiral(ring, ad, R - dir * SW / 2, ao + headAngle, R - dir * W / 2, -dir);
        ring.push(cPt(R - dir * HT, ao + headAngle), po);
      } else { ring.push(pd); arc(ring, R, ad, ao, -dir); }
    }
    return ring;
  };

  // ---- C++ renderPolyline: curved 非反復は先端/中央頂点/終端の3点、
  // 反復は2頂点おき。直線反復は全セグメント
  const rings = [];
  const push = r => { if (r && r.length >= 3) rings.push(r); };
  for (const c of lines) {
    if (!c || c.length < 2) continue;
    if (decor.curved) {
      if (!decor.repeated) {
        if (c.length >= 3) push(curved(c[0], c[Math.floor(c.length / 2)], c[c.length - 1]));
        else push(straight(c[0], c[1]));
      } else {
        for (let i = 0; i < c.length - 1; i += 2) {
          if (c.length - i >= 3) push(curved(c[i], c[i + 1], c[i + 2]));
          else push(straight(c[i], c[i + 1]));
        }
      }
    } else if (!decor.repeated) {
      push(straight(c[0], c[c.length - 1]));
    } else {
      for (let i = 0; i + 1 < c.length; i++) push(straight(c[i], c[i + 1]));
    }
  }
  return rings;
}

// MarkerLine/HashLine/ArrowLine の spec.line.decor → OL Style 配列
function decorToOlStyles(decor, geom, resolution, OL) {
  const { Style, Fill, Stroke, Icon, Point, MultiPoint, MultiLineString, Polygon, MultiPolygon, Text } = OL;
  if (!MultiPoint || !MultiLineString || !Polygon || !geom || !Number.isFinite(resolution)) return [];
  const px = v => v * resolution; // 画面px → マップ単位
  // InterpolatedLine/Lineburst: 区間分割 Stroke 群(本体 stroke は抑制される)
  if (decor.kind === "interpolated") {
    return interpolatedToOlStyles(decor, geom, resolution, OL);
  }
  const step = Math.max(px(decor.intervalPx || 30), resolution * 2);
  if (decor.kind === "markerline" && decor.markers?.length) {
    const samples = markerlineDecorSamples(geom, decor, px);
    if (!samples.length) return [];
    const canvas = markerLayersToCanvas(decor.markers);
    // rotate=1(QGIS 既定)は各マーカーを線の局所角で回転させる。
    // OL の Icon.rotation は Style 単位なので点ごとの Style を生成する
    if (decor.rotateMarker === false) {
      return [new Style({
        geometry: new MultiPoint(samples.map(s => [s.x, s.y])),
        image: new Icon({ img: canvas, anchor: [0.5, 0.5], scale: 1 }),
      })];
    }
    return samples.map(s => new Style({
      geometry: new Point([s.x, s.y]),
      image: new Icon({ img: canvas, anchor: [0.5, 0.5], scale: 1, rotation: -s.angle }),
    }));
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
    // C++ straightArrow/curvedArrow 移植の全ポリゴン(本体+矢頭)を塗る
    const lines = geom.getType() === "LineString" ? [geom.getCoordinates()] : geom.getCoordinates();
    const rings = arrowLinePolygonRings(lines, decor, px).map(r => [...r, r[0]]);
    if (!rings.length) return [];
    return [new Style({
      geometry: MultiPolygon ? new MultiPolygon(rings.map(r => [r]))
        : new Polygon(rings[0] ? [rings[0]] : []),
      fill: new Fill({ color: rgbaToCss(decor.color || [0, 0, 0, 1]) }),
      stroke: null,
    })];
  }
  if (decor.kind === "linref" && Point && Text) {
    // 里程標: 等間隔の標点へ距離ラベル(+任意マーカー)を置く。
    // resolution でオフセット px→地図単位を正確換算する
    const lines = geom.getType() === "LineString" ? [geom.getCoordinates()] : geom.getCoordinates();
    // QGIS は interval をソース座標系(4326=度)で計測するため、3857 ビュー
    // 座標を 4326 へ逆変換してサンプルし、標点をビュー座標へ戻す。
    // dist ラベルもソース単位(度)の累積距離
    const linesDeg = lines.map(l => l.map(m2ll));
    const samples = linRefSamplesPlanar(linesDeg, decor.interval, decor);
    if (!samples.length) return [];
    const tf = decor.text || {};
    const [lox, loy] = decor.labelOffsetPx || [0, 0];
    const dxm = (lox || 0) * resolution, dym = (loy || 0) * resolution;
    const mkCv = decor.showMarker && decor.markers?.length
      ? markerLayersToCanvas(decor.markers) : null;
    const styles = [];
    for (const s of samples) {
      const [vx, vy] = ll2m([s.x, s.y]);
      const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
      // オフセットを線方向系へ回転(rotate 時)または画面系のまま適用(y-up→y-down 反転)
      const px_ = decor.rotate ? vx + dxm * ca + dym * sa : vx + dxm;
      const py_ = decor.rotate ? vy + dxm * sa - dym * ca : vy - dym;
      if (mkCv) styles.push(new Style({
        geometry: new Point([px_, py_]),
        image: new Icon({ img: mkCv, anchor: [0.5, 0.5],
          rotation: decor.rotate ? -s.angle : 0 }),
      }));
      styles.push(new Style({
        geometry: new Point([px_, py_]),
        text: new Text({
          text: linRefFormatText(s.dist + (decor.startMeasure || 0), decor.num),
          font: tf.fontCss || "12px sans-serif",
          fill: new Fill({ color: rgbaToCss(tf.fill || [0, 0, 0, 1]) }),
          stroke: tf.halo
            ? new Stroke({ color: rgbaToCss(tf.halo.color), width: Math.max(tf.halo.widthPx || 1, 1) })
            : undefined,
          rotation: decor.rotate ? -s.angle : 0,
          placement: "point",
          overflow: true,
          textAlign: "center",
        }),
      }));
    }
    return styles;
  }
  return [];
}

// CanvasPattern 生成用の共有 2D コンテキスト
let _patternCtx = null;
function makePattern(canvas) {
  if (!canvas) return null;
  if (!_patternCtx) {
    _patternCtx = document.createElement("canvas").getContext("2d");
    _patternCtx.canvas.width = _patternCtx.canvas.height = 1;
  }
  return _patternCtx.createPattern(canvas, "repeat");
}

// invertedPolygonRenderer 用: 地物ジオメトリを「世界矩形 − 地物リング(穴)」へ
// 変換する GeoJSON 変換(MapLibre/Leaflet は焼き込み時に適用)
const _KASC_WORLD_RING = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
export function applyInvertedMaskGeojson(geojson) {
  for (const f of geojson?.features || []) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      g.coordinates = [_KASC_WORLD_RING, ...g.coordinates];
    } else if (g.type === "MultiPolygon") {
      g.coordinates = [[_KASC_WORLD_RING, ...g.coordinates.flat()]];
    }
  }
}

// --- OpenLayers: feature → ol.style.Style のスタイル関数を生成
export function olQmlStyleFunction(compiled, OL) {
  const { Style, Fill, Stroke, Circle: CircleStyle, Icon, Text, Point, MultiLineString, LineString, Polygon } = OL;
  const strokeOf = (line) => new Stroke({
    color: rgbaToCss(line.color), width: line.widthPx ?? 1.5,
    lineDash: line.dash || undefined,
    lineDashOffset: line.dashOffsetPx || undefined,
    lineJoin: line.join || undefined, lineCap: line.cap || undefined,
    miterLimit: 10,
  });
  return (feature, resolution) => {
    const props = feature.getProperties() || {};
    // @map_scale 評価用に現在縮尺を供給(解像度 m/px ÷ 0.28mm = 縮尺分母)。
    // レンダリングごとに再評価されるため縮尺連動ルール/データ定義が動的に切り替わる
    if (Number.isFinite(resolution)) setEvalScale(resolution / 0.00028);
    const spec = compiled.evaluate(props);
    if (!spec) return null;
    const s = specToStyle(spec);
    const geom = feature.getGeometry();
    const geomType = geom?.getType() || "";
    const styleOpts = {};
    const extra = [];
    // invertedPolygonRenderer: 地物を穴とした世界矩形ポリゴンを描く(マスク効果)
    if (compiled.inverted && /Polygon/.test(geomType) && feature.getGeometry) {
      styleOpts.geometry = f => {
        const g = f.getGeometry();
        if (!g) return null;
        const rings = g.getType() === "Polygon" ? g.getCoordinates()
          : g.getCoordinates().flat(1);
        const W = [[-2e7, -1e7], [2e7, -1e7], [2e7, 1e7], [-2e7, 1e7], [-2e7, -1e7]];
        return new Polygon([W, ...rings.map(r => [...r].reverse())]);
      };
    }
    // 塗りつぶし: パターン系(hatch/linePattern/pointPattern/imagePattern/gradient)は
    // タイル canvas の CanvasPattern で再現。単色のみなら従来通り色
    if (/Polygon/.test(geomType) && spec.fillParts?.length) {
      const { solidBase, tile } = fillPartsToTile(spec.fillParts);
      const pat = tile ? makePattern(tile) : null;
      if (pat) {
        styleOpts.fill = new Fill({ color: pat });
      } else if (solidBase) {
        styleOpts.fill = new Fill({ color: rgbaToCss(solidBase) });
      } else if (s.fill) {
        styleOpts.fill = new Fill({ color: s.fill });
      }
    } else if (s.fill && /Polygon/.test(geomType)) {
      styleOpts.fill = new Fill({ color: s.fill });
    }
    // LinearReferencing(里程標)は基線を描かず標点ラベル/マーカーのみ。
    // 実線ストロークを抑える(QGIS 準拠)
    const linrefOnly = spec.line?.decor?.kind === "linref" && !spec.outline;
    // InterpolatedLine はセグメント分割 Stroke に置き換えるため本体 stroke を抑える
    const interpOnly = spec.line?.decor?.kind === "interpolated";
    // MarkerLine/HashLine/RasterLine/ArrowLine は QGIS では装飾のみを描き
    // 実線は引かない(C++ 各 SymbolLayer は templated 描画で線を引かない)。
    // 最上位レイヤがこれらなら本体 stroke を抑制。下位の実線レイヤは
    // spec.lines の extra で描かれるため単独時のみ消える=QGIS と同じ。
    // filledline は OL 側が corridor 描画未対応のため fallback 線を残す
    const decorOnly = /^(markerline|hashline|rasterline|arrowline)$/.test(spec.line?.decor?.kind || "");
    if (s.stroke && !linrefOnly && !interpOnly && !decorOnly) {
      styleOpts.stroke = new Stroke({
        color: s.stroke, width: s.strokeWidth, lineDash: s.dash || undefined,
        lineDashOffset: s.dashOffsetPx || undefined,
        lineJoin: s.join || undefined, lineCap: s.cap || undefined,
      });
    }
    // symbollevels=1 の近似: 地物の最小 pass をスタイル z-index として使う
    if (Number.isFinite(spec.zRank)) styleOpts.zIndex = spec.zRank;
    // ポリゴン内部点: MultiPolygon は getInteriorPoint を持たないため
    // getInteriorPoints(MultiPoint)の先頭点を使う
    const interiorPtOf = gg => gg?.getInteriorPoint ? gg.getInteriorPoint()
      : gg?.getInteriorPoints ? new Point(gg.getInteriorPoints().getCoordinates()[0])
      : null;
    // 線端トリム: 描画ごとの resolution で画面px→地図単位へ正確換算し
    // geometry を切断して返す(基準縮尺近似ではなく実縮尺で再現できる)
    const trimGeomOf = (line) => {
      const sU = (line?.trimStartPx || 0) * resolution;
      const eU = (line?.trimEndPx || 0) * resolution;
      if (!(sU > 0 || eU > 0) || !/LineString/.test(geomType)
          || !LineString || !Number.isFinite(resolution)) return null;
      return f => {
        const g = f.getGeometry();
        if (!g) return null;
        const t = g.getType();
        if (t === "LineString") {
          return new LineString(trimCoordsPlanar(g.getCoordinates(), sU, eU));
        }
        if (t === "MultiLineString" && MultiLineString) {
          return new MultiLineString(
            g.getCoordinates().map(c => trimCoordsPlanar(c, sU, eU)));
        }
        return g;
      };
    };
    const topTrim = trimGeomOf(spec.line ?? spec.outline);
    if (topTrim) styleOpts.geometry = topTrim;
    if (/Point|MultiPoint/.test(geomType)) {
      // MapUnit マーカーは現 resolution で拡縮(markerSizePx = m/px 換算の
      // 目標直径。canvas は compile 時 px で焼かれているため比率で scale)
      const mScale = s.markerCanvas && Number.isFinite(s.markerSizePx)
        ? Math.min(Math.max(s.markerSizePx / Math.max(s.markerCanvas.height || 1, 1), 0.02), 100)
        : null;
      styleOpts.image = s.markerCanvas
        ? new Icon({ img: s.markerCanvas, anchor: [0.5, 0.5], ...(mScale ? { scale: mScale } : {}) })
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
          // bufferNoFill(中空ハロー): ol/style/Text では中空を表せないため
          // canvas ラスタライズ済みラベルを Icon で描画する(点/ポリゴン内部点/線中点)
          if (labelSpec.halo?.noFill) {
            const r = qmlLabelCanvas(labelSpec);
            const g = feature.getGeometry?.();
            const pt = r && g ? (
              /Point/.test(geomType) ? g
                : /Polygon/.test(geomType) ? interiorPtOf(g)
                : (/LineString/.test(geomType) && g.getCoordinateAt) ? new Point(g.getCoordinateAt(0.5))
                : null) : null;
            if (pt) extra.push(new Style({
              geometry: pt,
              image: new Icon({
                img: r.canvas, anchor: [0.5, 0.5],
                displacement: [ox, oy],
                rotation: pl.rotationDeg ? -pl.rotationDeg * Math.PI / 180 : 0,
              }),
            }));
          } else {
          styleOpts.text = new Text({
            text: labelText,
            font: labelSpec.fontCss || "12px sans-serif",
            fill: new Fill({ color: rgbaToCss(labelSpec.fill || [0, 0, 0, 1]) }),
            stroke: labelSpec.halo
              ? new Stroke({ color: rgbaToCss(labelSpec.halo.color), width: Math.max(Number(labelSpec.halo.widthPx) || 1, 1) })
              : undefined,
            overflow: !pl.fitInsidePolygon,
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
    }
    // 複数ラインシンボルレイヤ(ケーシング等): spec.lines は描画順(先=下)。
    // styleOpts.stroke が最上位レイヤを担うため、下層を先に描く Style を前に並べる
    if (spec.lines?.length > 1 && /LineString/.test(geomType)) {
      for (let i = spec.lines.length - 2; i >= 0; i--) {
        extra.unshift(new Style({
          stroke: strokeOf(spec.lines[i]),
          geometry: trimGeomOf(spec.lines[i]) || undefined,
        }));
      }
    }
    // CentroidFill: ポリゴン内部点へマーカーを描く
    if (spec.centroid?.length && /Polygon/.test(geomType) && interiorPtOf(geom)) {
      extra.push(new Style({
        geometry: interiorPtOf(geom),
        image: new Icon({ img: markerLayersToCanvas(spec.centroid), anchor: [0.5, 0.5] }),
      }));
    }
    // MarkerLine/HashLine/ArrowLine の装飾を geometry 関数で追加描画する
    const decor = spec.line?.decor;
    if (decor && /LineString/.test(geomType)) {
      extra.push(...decorToOlStyles(decor, geom, resolution, OL));
    }
    if (extra.length) return [...extra, new Style(styleOpts)];
    return new Style(styleOpts);
  };
}

// spec.scale {near,far}（Cesium のカメラ距離m指定）→ 2D の解像度範囲へ近似変換
// 距離 ≈ 解像度(m/px) × 500（画面高500px相当）のヒューリスティック
// ルールベースでは全ルールの範囲のユニオンを取る(ルール別縮尺で
// 表示切替するため、先頭ルールの範囲でレイヤーごと消えないようにする)
export function compiledScaleToResRange(compiled) {
  const K = 500;
  const toDist = s => (s > 0 ? s * 0.00028 * 900 / (2 * Math.tan(Math.PI / 6)) : 0);
  let minRes = 0, maxRes = Infinity, has = false;
  if (compiled.ruleScales?.length) {
    const near = Math.min(...compiled.ruleScales.map(s => toDist(s.min || 0)));
    const far = Math.max(...compiled.ruleScales.map(s => (s.max > 0 ? toDist(s.max) : Infinity)));
    minRes = near / K; maxRes = far / K; has = true;
  } else {
    const scale = compiled.evaluate({})?.scale;
    if (scale) {
      minRes = (scale.near ?? 0) / K;
      maxRes = Number.isFinite(scale.far) ? scale.far / K : Infinity;
      has = true;
    }
  }
  // レイヤー自体の縮尺依存表示(<qgis> ルートの layerScale)を積集合で反映。
  // 非ルール系は evaluate().scale へ既に合流済みだが冪等のため二重適用は無害
  const ls = compiled.layerScale;
  if (ls) {
    if (ls.maxScale > 0) { minRes = Math.max(minRes, toDist(ls.maxScale) / K); has = true; }
    if (ls.minScale > 0) { maxRes = Math.min(maxRes, toDist(ls.minScale) / K); has = true; }
  }
  return has ? { minRes, maxRes } : null;
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
const KASC_PROPS = ["__kasc_fill", "__kasc_stroke", "__kasc_width", "__kasc_color", "__kasc_symbol",
  "__kasc_icon", "__kasc_fillpat", "__kasc_dash", "__kasc_fopa", "__kasc_lopa", "__kasc_copa",
  "__kasc_cr", "__kasc_csw", "__kasc_csc", "__kasc_cicon",
  "__kasc_cmf", "__kasc_cmlo", "__kasc_cmhi",
  "__kasc_lgrp", "__kasc_lblend", "__kasc_fblend", "__kasc_lggrp", "__kasc_fillx",
  "__kasc_lblur", "__kasc_mgrp", "__kasc_hgrp", "__kasc_lpat", "__kasc_lpatw",
  "__kasc_wf", "__kasc_wlo", "__kasc_whi",
  "__kasc_loff", "__kasc_join", "__kasc_cap", "__kasc_heat", "__kasc_zkey",
  "__kasc_lronly", "__kasc_lrt", "__kasc_lrr", "__kasc_lrg"];

// MapUnit 線幅対応の line-width 式。MapLibre は zoom を top-level の
// interpolate/step でしか使えない制約があるため、両端ストップ側で case 分岐:
// __kasc_wf(zoom0 時 px)=widthMeters/(156543.03392*cos(lat)) が焼かれた地物は
// zoom 連動(px = wf*2^z)し、__kasc_wlo/whi(mus 由来の px 上下限)でクランプ。
// 無ければ従来の固定 px(両端同値 = 定数のまま)
const KASC_LINE_WIDTH_EXPR = [
  "interpolate", ["exponential", 2], ["zoom"],
  0, ["case", ["has", "__kasc_wf"],
    ["min", ["coalesce", ["get", "__kasc_whi"], 1e6],
      ["max", ["coalesce", ["get", "__kasc_wlo"], 0], ["get", "__kasc_wf"]]],
    ["coalesce", ["get", "__kasc_width"], 1.5]],
  1, ["case", ["has", "__kasc_wf"],
    ["min", ["coalesce", ["get", "__kasc_whi"], 1e6],
      ["max", ["coalesce", ["get", "__kasc_wlo"], 0], ["*", 2, ["get", "__kasc_wf"]]]],
    ["coalesce", ["get", "__kasc_width"], 1.5]],
];

// HashLine の刻みを icon-image 用 canvas へ。刻み方向は
// QGIS と同じく「線方向 + hash_angle − 90°」(hash_angle=0 が線直交)
function hashTickCanvas(tick) {
  const len = Math.max(tick?.lengthPx || 4, 2);
  const w = Math.max(tick?.widthPx || 1, 0.5);
  const s = Math.ceil(len + w + 2);
  const cv = document.createElement("canvas");
  cv.width = cv.height = Math.max(s, 4);
  const ctx = cv.getContext("2d");
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate((((tick?.angleDeg ?? 90) - 90) * Math.PI) / 180);
  ctx.strokeStyle = rgbaToCss(tick?.color || [0, 0, 0, 1]);
  ctx.lineWidth = w;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(-len / 2, 0);
  ctx.lineTo(len / 2, 0);
  ctx.stroke();
  return cv;
}

// RasterLine の画像を line-pattern 用タイルへ。
// シームレス繰り返しは画像幅が 2 の冪である必要があるため、幅を最近傍の
// 冪へ変換し(高さはアスペクト比維持)、繰り返し周期を QGIS 実寸へ近づける
function linePatternCanvas(image) {
  const w = image?.naturalWidth || image?.width, h = image?.naturalHeight || image?.height;
  if (!(w > 0 && h > 0)) return null;
  const pot = Math.max(8, Math.min(512, Math.pow(2, Math.round(Math.log2(w)))));
  const cv = document.createElement("canvas");
  cv.width = pot;
  cv.height = Math.max(1, Math.round(h * pot / w));
  cv.getContext("2d").drawImage(image, 0, 0, cv.width, cv.height);
  return cv;
}

let _qmlUid = 0;
const alphaOf = rgba => (rgba && rgba.length > 3) ? Math.max(0, Math.min(1, rgba[3])) : 1;
// canvas 合成名(qgisBlendToComposite 経由) → MapLibre *-layer-blend 値。
// MapLibre の enum は normal/multiply/color/luminosity/plus-lighter/screen/
// overlay のみ。canvas の lighter(加算)は plus-lighter で近似する
const MLB_MAP = { multiply: "multiply", screen: "screen", overlay: "overlay", lighter: "plus-lighter" };

export function maplibreApplyQml(geojson, compiled) {
  if (compiled.inverted) applyInvertedMaskGeojson(geojson);
  // このQMLで使う画像レジストリ(map.addImage する canvas/dataURL → id)
  const icons = new Map();  // id → canvas (点シンボル・centroid)
  const fills = new Map();  // id → canvas (fill-pattern タイル)
  let hasGrad = false;      // InterpolatedLine 地物を含むか(lineMetrics 要)
  const uid = ++_qmlUid;
  const iconId = spec => {
    const cv = spec.markers?.length ? markerLayersToCanvas(spec.markers) : null;
    if (!cv) return null;
    const key = `qi${uid}_${icons.size}`;
    icons.set(key, cv);
    return key;
  };
  const centroidIconId = spec => {
    const cv = spec.centroid?.length ? markerLayersToCanvas(spec.centroid) : null;
    if (!cv) return null;
    const key = `qc${uid}_${icons.size}`;
    icons.set(key, cv);
    return key;
  };
  const fillPatId = spec => {
    const { tile } = fillPartsToTile(spec.fillParts || []);
    if (!tile) return null;
    const key = `qf${uid}_${fills.size}`;
    fills.set(key, tile);
    return key;
  };
  // line-dasharray は線幅の倍数単位。px 値をそのまま渡すと巨大な破線に
  // なるため widthPx で除算する("none" 文字列は破線なしとして除外)
  const dashKey = (dash, widthPx) => (Array.isArray(dash) && dash.length)
    ? JSON.stringify(dash.map(v => v / Math.max(widthPx || 1, 0.5))) : null;
  // <effect type="blur"> を line-blur(px) へ換算(qml-style.js sizeToPx と同規則)
  const fxPx = (v, unit) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    switch (String(unit || "MM")) {
      case "Pixel": return n;
      case "Point": return n * 96 / 72;
      case "MapUnit":
      case "MetersInMapUnits":
      case "RenderMetersInMapUnits": return n * 0.3 * 96 / 25.4;
      default: return n * 96 / 25.4;
    }
  };
  const lineBlurPx = line => {
    for (const fx of line?.effects || []) {
      if (String(fx?.type || "").toLowerCase() === "blur") {
        return Math.max(fxPx(fx.blur_level ?? fx.blur_radius ?? 0, fx.blur_unit), 0);
      }
    }
    return 0;
  };

  // LinearReferencing: 地物ループ内で生成する標点点地物の退避先
  const lrPts = [];

  for (const feature of geojson.features || []) {
    const spec = compiled.evaluate(feature.properties || {});
    if (!spec) continue;
    const s = specToStyle(spec);
    // 線端トリム: line-trim-offset 相当が MapLibre に無いためジオメトリを
    // 基準縮尺換算で切断する近似(4326 → メルカトル換算で m 単位切断)
    {
      const tr = spec.line ?? spec.outline;
      if (tr && (tr.trimStartPx || tr.trimEndPx) &&
          /LineString/.test(feature.geometry?.type || "")) {
        trimGeoJsonLine(feature.geometry,
          (tr.trimStartPx || 0) * TRIM_PX_TO_M,
          (tr.trimEndPx || 0) * TRIM_PX_TO_M);
      }
    }
    feature.properties = feature.properties || {};
    // symbollevels=1: 地物最小 pass を z 順位キーへ焼く(*-sort-key 式用)
    if (compiled.symbolLevels && Number.isFinite(spec.zRank)) {
      feature.properties.__kasc_zkey = spec.zRank;
    }
    if (s.fill) feature.properties.__kasc_fill = s.fill;
    // fill-extrusion-opacity はデータ駆動不可のため、塗り色をアルファ込みで
    // 別プロパティにも焼く（fill-extrusion-color がこの値を拾う）
    if (spec.fillParts?.length) {
      const sld = spec.fillParts.find(pt => pt.solid)?.solid;
      if (sld) feature.properties.__kasc_fillx = rgbaToCss(sld);
    }
    if (s.stroke) feature.properties.__kasc_stroke = s.stroke;
    feature.properties.__kasc_width = s.strokeWidth;
    // MapUnit 線幅: 地物緯度で m→px 係数を焼き、line-width を zoom 補間式に
    // する(QGIS の MapUnit 描画相当)。mus があれば px 上下限も保持
    {
      const strokeSrc = spec.outline || spec.line;
      if (strokeSrc && Number.isFinite(strokeSrc.widthMeters)) {
        const c0 = feature.geometry?.coordinates;
        const flat = Array.isArray(c0) ? c0.flat(Infinity) : [];
        const lat = Number(flat[1]) || 0;
        feature.properties.__kasc_wf = strokeSrc.widthMeters
          / (156543.03392 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
        const mus = strokeSrc.widthMus;
        // mus のクランプは mup(=scaleDenom×0.00028)への上限/下限なので、
        // px 幅に換算すると: minScale→拡大側上限 px、maxScale→縮小側下限 px
        feature.properties.__kasc_wlo = mus?.maxScale
          ? Math.max(strokeSrc.widthMeters / (mus.maxScale * 0.00028), 0) : 0;
        feature.properties.__kasc_whi = mus?.minScale
          ? Math.max(strokeSrc.widthMeters / (mus.minScale * 0.00028), 0) : 1e6;
      }
    }
    feature.properties.__kasc_color = s.markerColor;
    if (s.join) feature.properties.__kasc_join = s.join;
    if (s.cap) feature.properties.__kasc_cap = s.cap;
    if (s.lineOffsetPx) feature.properties.__kasc_loff = s.lineOffsetPx;
    // 不透明度(色アルファから分離。データ駆動 *-opacity 用)
    const fSrc = spec.fillParts?.find(pt => pt.solid)?.solid;
    feature.properties.__kasc_fopa = fSrc ? alphaOf(fSrc) : 0.5;
    feature.properties.__kasc_lopa = (spec.outline || spec.line) ? alphaOf((spec.outline || spec.line).color) : 1;
    const mk = spec.markers?.[0];
    if (mk) {
      feature.properties.__kasc_cr = Math.max((mk.sizePx || 8) / 2, 1);
      // MapUnit マーカー: 線幅と同じく m→px 係数と mus 境界を焼く
      if (Number.isFinite(mk.sizeMeters)) {
        const c0 = feature.geometry?.coordinates;
        const flat = Array.isArray(c0) ? c0.flat(Infinity) : [];
        const lat = Number(flat[1]) || 0;
        feature.properties.__kasc_cmf = (mk.sizeMeters / 2)
          / (156543.03392 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
        const mus = mk.sizeMetersMus;
        feature.properties.__kasc_cmlo = mus?.maxScale
          ? Math.max((mk.sizeMeters / 2) / (mus.maxScale * 0.00028), 0) : 0;
        feature.properties.__kasc_cmhi = mus?.minScale
          ? Math.max((mk.sizeMeters / 2) / (mus.minScale * 0.00028), 0) : 1e6;
      }
      feature.properties.__kasc_copa = alphaOf(mk.fill);
      if (mk.stroke) feature.properties.__kasc_csc = rgbaToCss(mk.stroke);
      if (mk.strokeWidthPx) feature.properties.__kasc_csw = mk.strokeWidthPx;
      const id = iconId(spec);
      if (id) feature.properties.__kasc_icon = id;
    }
    // CentroidFill: ポリゴン中心へのアイコン
    const cid = spec.centroid?.length ? centroidIconId(spec) : null;
    if (cid) feature.properties.__kasc_cicon = cid;
    // 塗りパターン(ハッチ・ラインパターン・点パターン・画像・グラデーション)
    const fid = spec.fillParts?.length ? fillPatId(spec) : null;
    if (fid) feature.properties.__kasc_fillpat = fid;
    // 破線: line-dasharray はデータ駆動不可のためパターンIDでグルーピング
    const _ls = spec.line ?? spec.outline;
    const dk = dashKey(_ls?.dash, _ls?.widthPx);
    if (dk) feature.properties.__kasc_dash = dk;
    // ブレンド: *-layer-blend(MapLibre 6.18+)もデータ駆動不可のため値別に
    // グルーピング。MapLibre 側で表現できるのは multiply/screen/overlay/
    // plus-lighter のみ（QGIS→canvas 合成名から更に絞る）
    const lb = MLB_MAP[spec.line?.blend ?? spec.outline?.blend];
    const fb = MLB_MAP[spec.fillParts?.find(pt => pt.solid)?.blend ?? spec.fillParts?.[0]?.blend];
    if (fb) feature.properties.__kasc_fblend = fb;
    if (lb) feature.properties.__kasc_lblend = lb;
    // <effect> blur → line-blur はデータ駆動不可のため lgrp で値グルーピング
    const blur = lineBlurPx(spec.line ?? spec.outline);
    if (blur) feature.properties.__kasc_lblur = blur;
    const lgrp = (lb || "") + "|" + (dk || "") + "|" + (blur || "");
    if (lb || dk || blur) feature.properties.__kasc_lgrp = lgrp;
    // 凡例シンボル単位の表示切替フィルタ用（規則ベースで複数ヒットし得るため先頭名を採用）
    const names = typeof compiled.namesFor === "function" ? compiled.namesFor(feature.properties) : null;
    if (names?.length) feature.properties.__kasc_symbol = names[0];
    // InterpolatedLine: line-gradient はストップ色のデータ駆動が不可のため、
    // 色ペア("__kasc_lggrp"="c1|c2")でグルーピングして定数 gradient を
    // レイヤ別に出す(幅補間は line-progress 非対応のため __kasc_width で近似)
    const dec = spec.line?.decor ?? spec.outline?.decor;
    if (dec?.kind === "interpolated") {
      // color_ramp_shader(items/stops)があれば中間色もストップ化して
      // line-gradient に反映する(QGIS のランプ補間近似)。無い場合は両端のみ
      if (dec.ramp && (dec.ramp.items?.length || dec.ramp.stops?.length)) {
        const cols = [];
        for (let i = 0; i <= 8; i++) cols.push(rgbaToCss(interpolatedColorAt(dec, i / 8)));
        feature.properties.__kasc_lggrp = cols.join("|");
      } else {
        feature.properties.__kasc_lggrp = `${rgbaToCss(dec.c1)}|${rgbaToCss(dec.c2)}`;
      }
      hasGrad = true;
    }
    // MarkerLine/HashLine/RasterLine: icon-image(symbol-placement:line)・
    // line-pattern へ写像するため装飾グループを地物プロパティへ焼き込む。
    // spacing/icon はレイヤ定数のため "icon|spacing|place|rot" をグループキーにする
    const lineStack = spec.lines || (spec.line ? [spec.line] : []);
    for (const l of lineStack) {
      const d = l?.decor;
      if (!d) continue;
      if (d.kind === "markerline" && d.markers?.length) {
        const cv = markerLayersToCanvas(d.markers);
        if (cv) {
          const id = `qd${uid}_${icons.size}`;
          icons.set(id, cv);
          feature.properties.__kasc_mgrp = [
            id, Math.max(d.intervalPx || 30, 1),
            d.placement === "centralpoint" ? "line-center" : "line",
            d.rotateMarker === false ? 0 : 1,
          ].join("|");
        }
      } else if (d.kind === "hashline" && d.tick) {
        const id = `qh${uid}_${icons.size}`;
        icons.set(id, hashTickCanvas(d.tick));
        feature.properties.__kasc_hgrp = [id, Math.max(d.intervalPx || 10, 1)].join("|");
      } else if (d.kind === "rasterline" && d.image) {
        const pat = linePatternCanvas(d.image);
        if (pat) {
          const id = `ql${uid}_${fills.size}`;
          fills.set(id, pat);
          feature.properties.__kasc_lpat = id;
          feature.properties.__kasc_lpatw = Math.max(l.widthPx || 2, 0.5);
          if (d.offsetPx) feature.properties.__kasc_loff = d.offsetPx;
        }
      } else if (d.kind === "linref" && /LineString/.test(feature.geometry?.type || "")) {
        // 里程標: 等間隔標点を別地物として生成。text/icon はレイヤ定数の
        // ため書式グループ __kasc_lrg でまとめる(サイズ/色/回転/アイコン)
        const tf = d.text || {};
        let mic = "";
        if (d.showMarker && d.markers?.length) {
          const cv = markerLayersToCanvas(d.markers);
          if (cv) { mic = `qm${uid}_${icons.size}`; icons.set(mic, cv); }
        }
        const gkey = [
          Math.max(Math.round(tf.sizePx || 12), 6),
          rgbaToCss(tf.fill || [0, 0, 0, 1]),
          tf.halo ? rgbaToCss(tf.halo.color) : "",
          tf.halo?.widthPx || 0,
          d.rotate ? 1 : 0, mic,
        ].join("|");
        for (const smp of linRefSamplesGeojson(feature.geometry, d)) {
          lrPts.push({ type: "Feature", properties: {
            __kasc_lronly: 1,
            __kasc_lrt: linRefFormatText(smp.dist, d.num),
            __kasc_lrr: d.rotate ? -(smp.angle * 180 / Math.PI) : 0,
            __kasc_lrg: gkey,
          }, geometry: { type: "Point", coordinates: smp.coord } });
        }
      }
    }
    // 装飾系レイヤ(MarkerLine/HashLine/RasterLine/LinearReferencing)は
    // QGIS では刻み・マーカー・画像・標点のみを描き実線は引かない。
    // 最上位レイヤが装飾なら実線ストロークを抑え、下位に実線レイヤが
    // あればそちらを使う
    if (spec.line?.decor && /^(markerline|hashline|rasterline|linref)$/.test(spec.line.decor.kind)) {
      const lowerSolid = lineStack.slice(0, -1).filter(l => l && !l.decor).pop();
      if (lowerSolid) {
        feature.properties.__kasc_stroke = rgbaToCss(lowerSolid.color);
        feature.properties.__kasc_width = lowerSolid.widthPx;
      } else {
        feature.properties.__kasc_stroke = "rgba(0,0,0,0)";
        feature.properties.__kasc_width = 0;
        feature.properties.__kasc_lopa = 0;
      }
    }
    // heatmapRenderer: 地物ごとの重みを焼き込む
    if (compiled.heatmap) {
      const w = Number(compiled.heatmap.weightFn ? compiled.heatmap.weightFn(feature.properties) : 1);
      const mv = compiled.heatmap.maxValue || 1;
      feature.properties.__kasc_heat = Math.min(Math.max((Number.isFinite(w) ? w : 1) / mv, 0), 1);
    }
  }
  // LinearReferencing 生成点をソースへ追加(__kasc_lronly で通常点描画から除外)
  for (const p of lrPts) geojson.features.push(p);
  // symbollevels=1 の近似: 地物別 zRank を *-sort-key で層内描画順へ
  const zlay = compiled.symbolLevels
    ? k => ({ [k]: ["coalesce", ["get", "__kasc_zkey"], 0] }) : () => ({});
  // 破線・ブレンドごとの line レイヤ(line-dasharray/*-layer-blend は
  // データ駆動不可のため __kasc_lgrp = "blend|dashJSON" でグルーピング)
  const lgrpSet = new Set();
  const fblendSet = new Set();
  for (const f of geojson.features || []) {
    const g = f.properties?.__kasc_lgrp;
    if (g && !lgrpSet.has(g)) lgrpSet.add(g);
    const b = f.properties?.__kasc_fblend;
    if (b && !fblendSet.has(b)) fblendSet.add(b);
  }
  const nonPoint = ["!=", ["geometry-type"], "Point"];
  // パターン塗り(fill-pattern は画像IDのデータ駆動)。先に敷いてから単色ベース/枠線
  const fillKindsFor = (extra, blend) => {
    const bl = blend ? { "fill-layer-blend": blend } : {};
    return [
      ["fill", ["all", nonPoint, ...extra, ["has", "__kasc_fillpat"]], {
        "fill-pattern": ["get", "__kasc_fillpat"],
        "fill-opacity": ["coalesce", ["get", "__kasc_fopa"], 0.5],
        ...bl,
      }, zlay("fill-sort-key")],
      ["fill", ["all", nonPoint, ...extra, ["!", ["has", "__kasc_fillpat"]], ["has", "__kasc_fill"]], {
        "fill-color": ["coalesce", ["get", "__kasc_fill"], "#3a7bd5"],
        "fill-opacity": ["coalesce", ["get", "__kasc_fopa"], 0.5],
        ...bl,
      }, zlay("fill-sort-key")],
    ];
  };
  const kinds = [];
  if (fblendSet.size) {
    kinds.push(...fillKindsFor([["!", ["has", "__kasc_fblend"]]], null));
    for (const b of fblendSet) kinds.push(...fillKindsFor([["==", ["get", "__kasc_fblend"], b]], b));
  } else {
    kinds.push(...fillKindsFor([], null));
  }
  const linePaint = blend => ({
    "line-color": ["coalesce", ["get", "__kasc_stroke"], "#2c5ea8"],
    "line-width": KASC_LINE_WIDTH_EXPR,
    "line-offset": ["coalesce", ["get", "__kasc_loff"], 0],
    "line-opacity": ["coalesce", ["get", "__kasc_lopa"], 1],
    ...(blend ? { "line-layer-blend": blend } : {}),
  });
  const lineLayout = {
    "line-join": ["coalesce", ["get", "__kasc_join"], "bevel"],
    "line-cap": ["coalesce", ["get", "__kasc_cap"], "butt"],
    ...zlay("line-sort-key"),
  };
  const noGrad = ["!", ["has", "__kasc_lggrp"]];
  if (lgrpSet.size) {
    // 実線レイヤ(非破線・通常合成の地物のみ)+ グループ別レイヤ
    kinds.push(["line", ["all", nonPoint, noGrad, ["!", ["has", "__kasc_lgrp"]]], linePaint(), lineLayout]);
    for (const g of lgrpSet) {
      const [blend, dash, blur] = g.split("|");
      kinds.push(["line", ["all", nonPoint, noGrad, ["==", ["get", "__kasc_lgrp"], g]],
        { ...linePaint(blend || null),
          ...(dash ? { "line-dasharray": JSON.parse(dash) } : {}),
          ...(blur ? { "line-blur": Number(blur) } : {}) }, lineLayout]);
    }
  } else {
    kinds.push(["line", ["all", nonPoint, noGrad], linePaint(), lineLayout]);
  }
  // InterpolatedLine: lineMetrics ソース + line-gradient で始点→終点色を
  // ネイティブ補間。グラデ地物は実線レイヤから noGrad で除外済み
  if (hasGrad) {
    const pairs = new Set();
    for (const f of geojson.features || []) {
      const g = f.properties?.__kasc_lggrp;
      if (g) pairs.add(g);
    }
    for (const g of pairs) {
      // g = "c1|c2|c3|..." — ramp 利用時は中間ストップも列に含める
      const cols = g.split("|").filter(Boolean);
      const stops = ["interpolate", ["linear"], ["line-progress"]];
      cols.forEach((c, i) => { stops.push(cols.length > 1 ? i / (cols.length - 1) : 0, c); });
      kinds.push(["line", ["all", nonPoint, ["==", ["get", "__kasc_lggrp"], g]], {
        "line-width": KASC_LINE_WIDTH_EXPR,
        "line-offset": ["coalesce", ["get", "__kasc_loff"], 0],
        "line-opacity": ["coalesce", ["get", "__kasc_lopa"], 1],
        "line-gradient": stops,
      }, lineLayout]);
    }
  }
  // MarkerLine/HashLine: symbol-placement:line + icon-image で線上装飾を再現。
  // spacing/placement はレイヤ定数のため地物グループ(__kasc_mgrp/hgrp)別レイヤ
  for (const prop of ["__kasc_mgrp", "__kasc_hgrp"]) {
    const groups = new Set();
    for (const f of geojson.features || []) {
      const g = f.properties?.[prop];
      if (g) groups.add(g);
    }
    for (const g of groups) {
      const [icon, spacing, place, rot] = g.split("|");
      kinds.push(["symbol", ["all", nonPoint, ["==", ["get", prop], g]], {}, {
        "icon-image": icon,
        "icon-size": 1,
        "symbol-placement": place === "line-center" ? "line-center" : "line",
        ...(place === "line-center" ? {} : { "symbol-spacing": Math.max(Number(spacing) || 250, 1) }),
        // rotate_marker=0(線に沿わない)は viewport 基準で立てる近似
        "icon-rotation-alignment": rot === "0" ? "viewport" : "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      }]);
    }
  }
  // RasterLine: line-pattern で画像を線に沿って繰り返す(幅は地物ごとの値)
  {
    const pats = new Set();
    for (const f of geojson.features || []) {
      const p = f.properties?.__kasc_lpat;
      if (p) pats.add(p);
    }
    for (const p of pats) {
      kinds.push(["line", ["all", nonPoint, ["==", ["get", "__kasc_lpat"], p]], {
        "line-pattern": p,
        "line-width": ["coalesce", ["get", "__kasc_lpatw"], 2],
        "line-opacity": ["coalesce", ["get", "__kasc_lopa"], 1],
      }, lineLayout]);
    }
  }
  // CentroidFill アイコン(ポリゴン中心点へ)
  kinds.push(["symbol", ["all", nonPoint, ["has", "__kasc_cicon"]], {}, {
    "icon-image": ["get", "__kasc_cicon"],
    "icon-size": 1, "icon-allow-overlap": true, "icon-ignore-placement": true,
  }]);
  // LinearReferencing の標点レイヤ(生成点地物 __kasc_lronly 対象)。
  // 書式グループ __kasc_lrg ごとにレイヤ定数を固めて出す
  {
    const lrGroups = new Set();
    for (const f of geojson.features || []) {
      const g = f.properties?.__kasc_lrg;
      if (g) lrGroups.add(g);
    }
    for (const g of lrGroups) {
      const [size, color, haloC, haloW, rot, mic] = g.split("|");
      kinds.push(["symbol", ["all", ["has", "__kasc_lrt"], ["==", ["get", "__kasc_lrg"], g]], {
        "text-color": color || "#000000",
        "text-halo-color": haloC || "rgba(0,0,0,0)",
        "text-halo-width": Number(haloW) || 0,
      }, {
        "text-field": ["get", "__kasc_lrt"],
        "text-size": Math.max(Number(size) || 12, 6),
        "text-font": ["literal", ["Noto Sans Regular"]],
        "text-rotate": rot === "1" ? ["get", "__kasc_lrr"] : 0,
        "text-rotation-alignment": "map",
        "text-anchor": "center",
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "symbol-placement": "point",
        ...zlay("symbol-sort-key"),
      }]);
      if (mic) {
        kinds.push(["symbol", ["all", ["has", "__kasc_lrt"], ["==", ["get", "__kasc_lrg"], g]], {}, {
          "icon-image": mic, "icon-size": 1,
          "icon-rotate": rot === "1" ? ["get", "__kasc_lrr"] : 0,
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true, "icon-ignore-placement": true,
          ...zlay("symbol-sort-key"),
        }]);
      }
    }
  }
  // 点シンボル: markerCanvas アイコンがあれば icon-image、無ければ circle フォールバック
  // (linref 生成点は __kasc_lronly で除外)
  const pointOnly = ["all", ["==", ["geometry-type"], "Point"], ["!", ["has", "__kasc_lronly"]]];
  kinds.push(["symbol", ["all", pointOnly, ["has", "__kasc_icon"]], {}, {
    "icon-image": ["get", "__kasc_icon"],
    "icon-size": 1, "icon-allow-overlap": true, "icon-ignore-placement": true,
    ...zlay("symbol-sort-key"),
  }]);
  kinds.push(["circle", ["all", pointOnly, ["!", ["has", "__kasc_icon"]]], {
    // MapUnit マーカーは __kasc_cmf(zoom0 半径 px)で zoom 連動、mus 境界でクランプ
    // (zoom は top-level interpolate/step のみ許可のため両端ストップ側で case)
    "circle-radius": [
      "interpolate", ["exponential", 2], ["zoom"],
      0, ["case", ["has", "__kasc_cmf"],
        ["min", ["coalesce", ["get", "__kasc_cmhi"], 1e6],
          ["max", ["coalesce", ["get", "__kasc_cmlo"], 0], ["get", "__kasc_cmf"]]],
        ["coalesce", ["get", "__kasc_cr"], 5]],
      1, ["case", ["has", "__kasc_cmf"],
        ["min", ["coalesce", ["get", "__kasc_cmhi"], 1e6],
          ["max", ["coalesce", ["get", "__kasc_cmlo"], 0], ["*", 2, ["get", "__kasc_cmf"]]]],
        ["coalesce", ["get", "__kasc_cr"], 5]],
    ],
    "circle-color": ["coalesce", ["get", "__kasc_color"], "#2c5ea8"],
    "circle-opacity": ["coalesce", ["get", "__kasc_copa"], 1],
    "circle-stroke-color": ["coalesce", ["get", "__kasc_csc"], ["get", "__kasc_stroke"], "#ffffff"],
    "circle-stroke-width": ["coalesce", ["get", "__kasc_csw"], 1],
  }, zlay("circle-sort-key")]);
  // <labeling>: 焼き込んだ __kasc_label 系プロパティを参照する symbol レイヤを追加。
  // symbol-placement 等の非データ駆動 layout は配置モード別にレイヤを分ける
  const baked = bakeQmlLabels(geojson, compiled, icons);
  let labelScaleRange = null;
  if (baked) {
    labelScaleRange = { minScale: baked.minScale, maxScale: baked.maxScale };
    const labeled = geojson.features.filter(f => f.properties?.__kasc_label);
    const placements = [...new Set(labeled.map(f => f.properties.__kasc_label_placement || "point"))];
    for (const pm of placements.length ? placements : ["point"]) {
      const group = labeled.filter(f => (f.properties.__kasc_label_placement || "point") === pm);
      // text-variable-anchor は非データ駆動のため __kasc_label_vgrp
      // (predefinedPositionOrder の候補+radial em の JSON)でサブグループ化。
      // 無しは "" の通常レイヤ
      const vgrps = [...new Set(group.map(f => f.properties.__kasc_label_vgrp || ""))];
      for (const vg of vgrps) {
      const sub = group.filter(f => (f.properties.__kasc_label_vgrp || "") === vg);
      const allowOverlap = sub.every(f => f.properties.__kasc_label_overlap === true);
      const keepUpright = sub.every(f => f.properties.__kasc_label_upright !== false);
      const spacing = Math.min(...sub.map(f => f.properties.__kasc_label_spacing || 250));
      const maxw = Math.min(...sub.map(f => f.properties.__kasc_label_maxw || 10));
      const lh = sub[0]?.properties.__kasc_label_lh ?? 1;
      const letter = sub[0]?.properties.__kasc_label_letter ?? 0;
      const tf = sub.every(f => f.properties.__kasc_label_tf === "uppercase") ? "uppercase"
        : sub.every(f => f.properties.__kasc_label_tf === "lowercase") ? "lowercase" : "none";
      const maxa = Math.max(...sub.map(f => Number(f.properties.__kasc_label_maxa) || 0), 0);
      let vanchors = null, vrad = 0;
      if (vg) {
        try { const a = JSON.parse(vg); vanchors = a[0]; vrad = a[1]; } catch (_) { /* JSON 破損は通常配置へ */ }
      }
      kinds.push(["symbol", ["all", ["has", "__kasc_label"], ["==", ["get", "__kasc_label_placement"], pm],
        vg ? ["==", ["get", "__kasc_label_vgrp"], vg] : ["!", ["has", "__kasc_label_vgrp"]]], {
        "text-color": ["coalesce", ["get", "__kasc_label_color"], "#222222"],
        "text-halo-color": ["coalesce", ["get", "__kasc_label_halo"], "rgba(0,0,0,0)"],
        "text-halo-width": ["coalesce", ["get", "__kasc_label_halo_w"], 0],
      }, {
        "symbol-placement": pm === "line" ? "line" : "point",
        "text-field": ["get", "__kasc_label"],
        "text-size": ["coalesce", ["get", "__kasc_label_size"], 12],
        "text-font": ["literal", ["Noto Sans Regular"]],
        "text-rotate": ["coalesce", ["get", "__kasc_label_rot"], 0],
        ...(vanchors?.length ? {
          // predefinedPositionOrder: 候補位置へ順次試行するネイティブ配置。
          // text-anchor/text-offset は variable-anchor 系と併用不可のため出さない
          "text-variable-anchor": vanchors,
          "text-radial-offset": vrad,
          "text-justify": "auto",
        } : {
          "text-offset": ["get", "__kasc_label_off"],
          "text-anchor": ["coalesce", ["get", "__kasc_label_anchor"], "center"],
          "text-justify": ["coalesce", ["get", "__kasc_label_justify"], "auto"],
        }),
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
        ...(pm === "line" && maxa ? { "text-max-angle": maxa } : {}),
      }]);
      }
    }
    // bufferNoFill(中空ハロー)ラベル: bakeQmlLabels が canvas ラスタライズして
    // __kasc_label_img へ画像キーを焼いた地物を icon-image で表示する。
    // icon-optional で衝突時の自動非表示(=ラベルの declutter 相当)を有効化
    const iconLabels = geojson.features.filter(f => f.properties?.__kasc_label_img);
    if (iconLabels.length) {
      const iconOverlap = iconLabels.every(f => f.properties.__kasc_label_overlap === true);
      kinds.push(["symbol", ["has", "__kasc_label_img"], {}, {
        "icon-image": ["get", "__kasc_label_img"],
        "icon-size": 1,
        "icon-rotate": ["coalesce", ["get", "__kasc_label_rot"], 0],
        "icon-rotation-alignment": "viewport",
        "icon-offset": ["coalesce", ["get", "__kasc_label_off_px"], ["literal", [0, 0]]],
        "icon-anchor": ["coalesce", ["get", "__kasc_label_anchor"], "center"],
        "symbol-placement": "point",
        "symbol-sort-key": ["coalesce", ["get", "__kasc_label_sort"], 0],
        "symbol-avoid-edges": false,
        "icon-allow-overlap": iconOverlap,
        "icon-optional": true,
        "icon-padding": 2,
      }]);
    }
  }
  return {
    kinds,
    props: KASC_PROPS,
    labelScaleRange,
    heatmap: compiled.heatmap || null,
    lineMetrics: hasGrad, // ソースへ lineMetrics:true を渡す印(line-gradient 要件)
    icons,
    fills,
  };
}
