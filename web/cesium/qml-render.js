// QML スタイル(.qml)の Cesium への適用（描画側バインディング）
// パース・式評価・シンボルコンパイルは /shared/qml-style.js を参照。
// 本ファイルは Cesium 固有の entity/primitive 適用部のみを持つ。
import { toCesiumColor, dashPattern, markerLayersToCanvas, fillPartsToTile, rgbaToCss } from "../shared/qml-style.js";

const Cesium = window.Cesium;

// ---------------------------------------------------------------------------
// Cesium への適用
// ---------------------------------------------------------------------------

function entityFeatureProps(entity, time) {
  try {
    const p = entity.properties;
    return p?.getValue ? (p.getValue(time) || {}) : (p || {});
  } catch (e) {
    return {};
  }
}

function entityCentroid(entity, time) {
  try {
    const hierarchy = entity.polygon?.hierarchy?.getValue?.(time);
    const positions = hierarchy?.positions || entity.polyline?.positions?.getValue?.(time);
    if (!positions?.length) return null;
    const sum = positions.reduce((acc, p) => Cesium.Cartesian3.add(acc, p, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    return Cesium.Cartesian3.divideByScalar(sum, positions.length, new Cesium.Cartesian3());
  } catch (e) {
    return null;
  }
}

// polyline 用の破線マテリアル。[on,off]px → 16bit パターン
function dashMaterialProperty(color, dash) {
  if (!dash?.length) return new Cesium.ColorMaterialProperty(toCesiumColor(color));
  const total = dash.reduce((a, b) => a + b, 0);
  let pattern = 0;
  for (let i = 0; i < 16; i++) {
    const t = ((i + 0.5) / 16) * total;
    let acc = 0, on = true;
    for (let j = 0; j < dash.length; j++) {
      if (t < acc + dash[j]) { on = j % 2 === 0; break; }
      acc += dash[j];
    }
    if (on) pattern |= (1 << (15 - i));
  }
  if (!pattern) pattern = 0xffff;
  return new Cesium.PolylineDashMaterialProperty({ color: toCesiumColor(color), dashPattern: pattern, dashLength: total });
}

// エンティティ(entity 描画経路)にコンパイル済みスタイルを適用する。
// clamp: 地形ドレープ中か(ドレープ時はポリゴンのアウトラインが描かれないため
// 周線を別途 polyline で引く)
export function applyQmlStyleToDataSource(ds, style, { clamp = false, time = null, hiddenSymbols = null } = {}) {
  if (!style) return;
  const t = time || Cesium.JulianDate.now();
  const hasHidden = !!(hiddenSymbols && hiddenSymbols.size);
  for (const entity of ds.entities.values) {
    const props = entityFeatureProps(entity, t);
    // 凡例の条件別チェックで非表示化されたシンボルにだけ該当する地物は隠す
    const hiddenByLegend = hasHidden && style.namesFor
      && (() => { const names = style.namesFor(props); return names.length > 0 && names.every(name => hiddenSymbols.has(name)); })();
    const spec = hiddenByLegend ? null : style.evaluate(props);
    const hasPoint = !!entity.billboard;
    const hasLine = !!entity.polyline;
    const hasFill = !!entity.polygon;

    if (!spec) {
      if (entity.billboard) entity.billboard.show = new Cesium.ConstantProperty(false);
      if (entity.polyline) entity.polyline.show = new Cesium.ConstantProperty(false);
      if (entity.polygon) entity.polygon.show = new Cesium.ConstantProperty(false);
      if (entity.label) entity.label.show = new Cesium.ConstantProperty(false);
      continue;
    }

    const ddc = spec.scale ? new Cesium.DistanceDisplayCondition(spec.scale.near, spec.scale.far) : null;

    // ポイント → billboard(canvas 合成アイコン)
    if (hasPoint) {
      if (spec.markers?.length) {
        const canvas = markerLayersToCanvas(spec.markers);
        entity.billboard.show = new Cesium.ConstantProperty(true);
        entity.billboard.image = new Cesium.ConstantProperty(canvas);
        entity.billboard.scale = new Cesium.ConstantProperty(1);
        entity.billboard.verticalOrigin = new Cesium.ConstantProperty(Cesium.VerticalOrigin.CENTER);
        entity.billboard.horizontalOrigin = new Cesium.ConstantProperty(Cesium.HorizontalOrigin.CENTER);
        const rot = spec.markers[0]?.rotationDeg || 0;
        if (rot) entity.billboard.rotation = new Cesium.ConstantProperty(-rot * Math.PI / 180);
        if (ddc) entity.billboard.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
      } else {
        entity.billboard.show = new Cesium.ConstantProperty(false);
      }
    }

    // ライン
    if (hasLine) {
      if (spec.line) {
        entity.polyline.show = new Cesium.ConstantProperty(true);
        entity.polyline.material = dashMaterialProperty(spec.line.color, spec.line.dash);
        entity.polyline.width = new Cesium.ConstantProperty(spec.line.widthPx);
        if (ddc) entity.polyline.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
      } else {
        entity.polyline.show = new Cesium.ConstantProperty(false);
      }
    }

    // ポリゴン
    if (hasFill) {
      if (spec.fillParts?.length) {
        entity.polygon.show = new Cesium.ConstantProperty(true);
        const { solidBase, tile, tileMeters } = fillPartsToTile(spec.fillParts);
        if (tile) {
          const repeat = computeFillRepeat(entity, t, tileMeters);
          entity.polygon.material = new Cesium.ImageMaterialProperty({ image: tile, repeat, transparent: true });
        } else if (solidBase) {
          entity.polygon.material = new Cesium.ColorMaterialProperty(toCesiumColor(solidBase));
        } else {
          entity.polygon.material = new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT);
        }
        if (ddc) entity.polygon.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
      } else {
        entity.polygon.show = new Cesium.ConstantProperty(false);
      }
      // アウトライン: ドレープ時は polygon.outline が効かないため polyline で引く。
      // ただし entity が元から polyline を持つ(GeometryCollection)場合は上書きしない
      if (spec.outline) {
        const ring = outlinePositions(entity, t);
        if (hasLine) {
          entity.polygon.outline = new Cesium.ConstantProperty(true);
          entity.polygon.outlineColor = new Cesium.ConstantProperty(toCesiumColor(spec.outline.color));
        } else if (ring?.length) {
          if (!entity.polyline) entity.polyline = new Cesium.PolylineGraphics();
          entity.polyline.show = new Cesium.ConstantProperty(true);
          entity.polyline.positions = new Cesium.ConstantProperty(ring.concat([ring[0]]));
          entity.polyline.width = new Cesium.ConstantProperty(spec.outline.widthPx);
          entity.polyline.material = dashMaterialProperty(spec.outline.color, spec.outline.dash);
          entity.polyline.clampToGround = new Cesium.ConstantProperty(clamp);
          entity.polyline.arcType = new Cesium.ConstantProperty(Cesium.ArcType.GEODESIC);
          if (clamp) {
            entity.polyline.classificationType = entity.polygon.classificationType;
          }
          if (ddc) entity.polyline.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
        } else {
          entity.polygon.outline = new Cesium.ConstantProperty(true);
          entity.polygon.outlineColor = new Cesium.ConstantProperty(toCesiumColor(spec.outline.color));
        }
      } else if (spec.fillParts?.length) {
        entity.polygon.outline = new Cesium.ConstantProperty(false);
      }
      // 重心マーカー(CentroidFill)
      if (spec.centroid?.length) {
        const center = entityCentroid(entity, t);
        if (center) {
          entity.position = new Cesium.ConstantPositionProperty(center);
          if (!entity.billboard) entity.billboard = new Cesium.BillboardGraphics();
          const canvas = markerLayersToCanvas(spec.centroid);
          entity.billboard.image = new Cesium.ConstantProperty(canvas);
          entity.billboard.verticalOrigin = new Cesium.ConstantProperty(Cesium.VerticalOrigin.CENTER);
          entity.billboard.horizontalOrigin = new Cesium.ConstantProperty(Cesium.HorizontalOrigin.CENTER);
        }
      }
    }

    // ラベル
    if (style.labelFor) {
      const labelSpec = style.labelFor(props);
      const text = labelSpec ? String(labelSpec.getText?.(props) ?? "") : "";
      if (labelSpec && text) {
        if (!entity.position && (hasLine || hasFill)) {
          const center = entityCentroid(entity, t);
          if (center) entity.position = new Cesium.ConstantPositionProperty(center);
        }
        entity.label = new Cesium.LabelGraphics({
          text,
          font: labelSpec.fontCss,
          fillColor: toCesiumColor(labelSpec.fill),
          outlineColor: labelSpec.halo ? toCesiumColor(labelSpec.halo.color) : Cesium.Color.BLACK,
          outlineWidth: labelSpec.halo ? labelSpec.halo.widthPx : 0,
          style: labelSpec.halo ? Cesium.LabelStyle.FILL_AND_OUTLINE : Cesium.LabelStyle.FILL,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: hasPoint ? new Cesium.Cartesian2(0, -12) : new Cesium.Cartesian2(0, 0),
        });
        if (ddc) entity.label.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
      }
    }
  }
}

function outlinePositions(entity, time) {
  try {
    const h = entity.polygon?.hierarchy?.getValue?.(time);
    return h?.positions || null;
  } catch (e) {
    return null;
  }
}

// パターンタイルの実寸(概算)からポリゴンの bbox に対する repeat を計算する
function computeFillRepeat(entity, time, tileMeters) {
  const def = new Cesium.Cartesian2(1, 1);
  if (!tileMeters || tileMeters <= 0) return def;
  try {
    const h = entity.polygon?.hierarchy?.getValue?.(time);
    const positions = h?.positions;
    if (!positions?.length) return def;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const p of positions) {
      const c = Cesium.Cartographic.fromCartesian(p);
      const lon = c.longitude, lat = c.latitude;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const midLat = (minLat + maxLat) / 2;
    const mPerDegX = 111320 * Math.cos(midLat);
    const mPerDegY = 110540;
    const wM = Math.max((maxLon - minLon) * mPerDegX, tileMeters);
    const hM = Math.max((maxLat - minLat) * mPerDegY, tileMeters);
    return new Cesium.Cartesian2(Math.max(wM / tileMeters, 1), Math.max(hM / tileMeters, 1));
  } catch (e) {
    return def;
  }
}

// GeoJsonPrimitive(バッチ描画経路)にスタイルを適用する。
// Buffer 系は featureId 単位で setMaterial できる。シェイプ・破線・パターンは
// 表現できないため色・サイズ・線幅の対応のみ(フォールバック)
export function applyQmlStyleToPrimitive(primitive, style, hiddenSymbols = null) {
  if (!style || !primitive) return;
  const hasHidden = !!(hiddenSymbols && hiddenSymbols.size);
  const materialCache = new Map();
  const matFor = (kind, spec) => {
    const key = kind + JSON.stringify(spec);
    let m = materialCache.get(key);
    if (!m) {
      if (kind === "point") {
        const mk = spec.markers?.[0];
        m = new Cesium.BufferPointMaterial({
          color: toCesiumColor(mk?.fill || [0.2, 0.4, 0.9, 1]),
          size: Math.max(mk?.sizePx || 6, 2),
          outlineColor: toCesiumColor(mk?.stroke || [0, 0, 0, 1]),
          outlineWidth: mk?.stroke ? Math.max(mk.strokeWidthPx || 1, 1) : 0,
        });
      } else if (kind === "line") {
        m = new Cesium.BufferPolylineMaterial({
          color: toCesiumColor(spec.line?.color || [0, 0, 0, 1]),
          width: Math.max(spec.line?.widthPx || 1, 1),
        });
      } else {
        const solids = (spec.fillParts || []).filter(pt => pt.solid);
        const base = solids.length ? solids[solids.length - 1].solid : [0.5, 0.5, 0.5, 0.7];
        m = new Cesium.BufferPolygonMaterial({
          color: toCesiumColor(base),
          outlineColor: toCesiumColor(spec.outline?.color || base),
          outlineWidth: spec.outline ? Math.max(spec.outline.widthPx || 1, 1) : 0,
        });
      }
      materialCache.set(key, m);
    }
    return m;
  };

  const applyTo = (collection, ctor, kind, pick) => {
    if (!collection) return;
    const scratch = new ctor();
    for (let i = 0; i < collection.primitiveCount; i++) {
      collection.get(i, scratch);
      const props = primitive.getProperties(scratch.featureId) || {};
      const hiddenByLegend = hasHidden && style.namesFor
        && (() => { const names = style.namesFor(props); return names.length > 0 && names.every(name => hiddenSymbols.has(name)); })();
      const spec = hiddenByLegend ? null : style.evaluate(props);
      if (!spec || !pick(spec)) {
        scratch.setMaterial(transparentMaterial(kind));
        continue;
      }
      scratch.setMaterial(matFor(kind, spec));
    }
  };

  applyTo(primitive.points, Cesium.BufferPoint, "point", s => s.markers?.length);
  applyTo(primitive.polylines, Cesium.BufferPolyline, "line", s => !!s.line);
  applyTo(primitive.polygons, Cesium.BufferPolygon, "fill", s => !!s.fillParts?.length);
}

function transparentMaterial(kind) {
  const t = new Cesium.Color(0, 0, 0, 0);
  if (kind === "point") return new Cesium.BufferPointMaterial({ color: t, size: 1 });
  if (kind === "line") return new Cesium.BufferPolylineMaterial({ color: t, width: 1 });
  return new Cesium.BufferPolygonMaterial({ color: t });
}
