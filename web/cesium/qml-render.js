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

// rgba 配列のアルファへ係数を乗算する(レイヤ透過度 opacity= 用)
function mulAlpha(rgba, f) {
  if (!rgba || f >= 1) return rgba;
  return [rgba[0], rgba[1], rgba[2], (rgba.length > 3 ? rgba[3] : 1) * f];
}

// 縮尺分母 → 概算カメラ距離(m)。evaluate の規則スケール変換と同式
function scaleDenomToDist(s) {
  return s > 0 ? s * 0.00028 * 900 / (2 * Math.tan(Math.PI / 6)) : 0;
}

// minFeatureSize(mm→px) の実寸換算(参照縮尺 1:10000 で 1px≒2.8m)
const LABEL_M_PER_PX = 0.00028 * 10000;

// polyline entity の中点座標と、中点付近セグメントの回転角(度)を返す
function polylineMidpoint(entity, time) {
  try {
    const positions = entity.polyline?.positions?.getValue?.(time);
    if (!positions || positions.length < 2) return null;
    // 全長の半分にある点を拾う
    const carts = positions.map(p => Cesium.Cartographic.fromCartesian(p));
    const lens = [];
    let total = 0;
    for (let i = 0; i + 1 < positions.length; i++) {
      const d = Cesium.Cartesian3.distance(positions[i], positions[i + 1]);
      lens.push(d); total += d;
    }
    let acc = 0, seg = 0;
    const half = total / 2;
    for (; seg < lens.length; seg++) { if (acc + lens[seg] >= half) break; acc += lens[seg]; }
    const i = Math.min(seg, positions.length - 2);
    const mid = Cesium.Cartesian3.lerp(positions[i], positions[i + 1],
      lens[i] ? (half - acc) / lens[i] : 0.5, new Cesium.Cartesian3());
    // セグメント方位: 度→画面回転角(北基準時計回り→東基準反時計へ)
    const a = carts[i], b = carts[i + 1];
    const bearing = Math.atan2(b.longitude - a.longitude, b.latitude - a.latitude);
    return { position: mid, bearing };
  } catch (e) { return null; }
}

// entity ジオメトリの bbox 対角長(概算メートル)
function entityExtentDiagMeters(entity, time) {
  try {
    const hierarchy = entity.polygon?.hierarchy?.getValue?.(time);
    const positions = hierarchy?.positions || entity.polyline?.positions?.getValue?.(time);
    if (!positions?.length) return Infinity;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of positions) {
      const c = Cesium.Cartographic.fromCartesian(p);
      minX = Math.min(minX, c.longitude); maxX = Math.max(maxX, c.longitude);
      minY = Math.min(minY, c.latitude); maxY = Math.max(maxY, c.latitude);
    }
    const midLat = (minY + maxY) / 2;
    const dx = (maxX - minX) * 111320 * Math.cos(midLat);
    const dy = (maxY - minY) * 110540;
    return Math.hypot(dx, dy);
  } catch (e) { return Infinity; }
}

// ポリゴン内部に収まる点を探す(centroidInside/fitInsidePolygon 用)。
// 重心が内部なら重心、外なら最長辺の中点を内部側へ寄せた近似点を返す
function pointInsidePolygon(entity, time) {
  try {
    const hierarchy = entity.polygon?.hierarchy?.getValue?.(time);
    const positions = hierarchy?.positions;
    if (!positions?.length) return null;
    const ring = positions.map(p => Cesium.Cartographic.fromCartesian(p));
    const center = entityCentroid(entity, time);
    if (!center) return null;
    const cc = Cesium.Cartographic.fromCartesian(center);
    // ray casting
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].longitude, yi = ring[i].latitude;
      const xj = ring[j].longitude, yj = ring[j].latitude;
      if (((yi > cc.latitude) !== (yj > cc.latitude))
        && (cc.longitude < (xj - xi) * (cc.latitude - yi) / (yj - yi) + xi)) inside = !inside;
    }
    if (inside) return center;
    // 重心が外: 最長辺の中点へ寄せる
    let best = null, bestLen = -1;
    for (let i = 0; i + 1 < positions.length; i++) {
      const d = Cesium.Cartesian3.distance(positions[i], positions[i + 1]);
      if (d > bestLen) { bestLen = d; best = Cesium.Cartesian3.lerp(positions[i], positions[i + 1], 0.5, new Cesium.Cartesian3()); }
    }
    return best;
  } catch (e) { return null; }
}

// エンティティ(entity 描画経路)にコンパイル済みスタイルを適用する。
// clamp: 地形ドレープ中か(ドレープ時はポリゴンのアウトラインが描かれないため
// 周線を別途 polyline で引く)。opacity: レイヤ透過度(色アルファへ乗算)
export function applyQmlStyleToDataSource(ds, style, { clamp = false, time = null, hiddenSymbols = null, opacity = 1 } = {}) {
  if (!style) return;
  const t = time || Cesium.JulianDate.now();
  const hasHidden = !!(hiddenSymbols && hiddenSymbols.size);
  // ラベル: 全地物の spec を先に確定し、maxNumLabels 制限(優先度・zIndex 順)と
  // コールアウト生成を後段へ回せるようにする
  const labelCandidates = new Map();
  const pendingCallouts = [];
  const pendingShadows = [];
  if (style.labelFor) {
    const list = [];
    for (const entity of ds.entities.values) {
      const spec = style.labelFor(entityFeatureProps(entity, t));
      if (spec) list.push({ entity, spec });
    }
    const lim = Math.max(0, ...list.map(c => c.spec.limitNumLabels ? (c.spec.maxNumLabels || 0) : 0));
    const kept = lim && list.length > lim
      ? new Set(list.slice().sort((a, b) => (b.spec.priority - a.spec.priority) || (b.spec.zIndex - a.spec.zIndex)).slice(0, lim))
      : null;
    for (const c of list) if (!kept || kept.has(c)) labelCandidates.set(c.entity, c);
  }
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
        // レイヤ透過度: 焼き付け済みキャンバス全体へ乗算する
        entity.billboard.color = new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(opacity));
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
        entity.polyline.material = dashMaterialProperty(mulAlpha(spec.line.color, opacity), spec.line.dash);
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
        const { solidBase, tile, tileMeters } = fillPartsToTile(spec.fillParts.map(pt => pt.solid ? { ...pt, solid: mulAlpha(pt.solid, opacity) } : pt));
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
          entity.polygon.outlineColor = new Cesium.ConstantProperty(toCesiumColor(mulAlpha(spec.outline.color, opacity)));
        } else if (ring?.length) {
          if (!entity.polyline) entity.polyline = new Cesium.PolylineGraphics();
          entity.polyline.show = new Cesium.ConstantProperty(true);
          entity.polyline.positions = new Cesium.ConstantProperty(ring.concat([ring[0]]));
          entity.polyline.width = new Cesium.ConstantProperty(spec.outline.widthPx);
          entity.polyline.material = dashMaterialProperty(mulAlpha(spec.outline.color, opacity), spec.outline.dash);
          entity.polyline.clampToGround = new Cesium.ConstantProperty(clamp);
          entity.polyline.arcType = new Cesium.ConstantProperty(Cesium.ArcType.GEODESIC);
          if (clamp) {
            entity.polyline.classificationType = entity.polygon.classificationType;
          }
          if (ddc) entity.polyline.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
        } else {
          entity.polygon.outline = new Cesium.ConstantProperty(true);
          entity.polygon.outlineColor = new Cesium.ConstantProperty(toCesiumColor(mulAlpha(spec.outline.color, opacity)));
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
      const labelSpec = labelCandidates.get(entity)?.spec || null;
      const text = labelSpec?.text ?? "";
      if (labelSpec && text) {
        const pl = labelSpec.placement || {};
        const q = pl.quad || { h: 0, v: 0 };
        // minFeatureSize: 小さい地物はラベルを付けない(実寸近似)
        let showLabel = true;
        if (labelSpec.minFeatureSizePx && (hasLine || hasFill)) {
          if (entityExtentDiagMeters(entity, t) < labelSpec.minFeatureSizePx * LABEL_M_PER_PX) showLabel = false;
        }
        if (showLabel) {
          const anchorPos = entity.position ? entity.position.getValue(t) : null;
          // 位置決定: DD PositionX/Y > ライン中点 > ポリゴン内部点 > 重心
          let labelPos = null;
          if (labelSpec.position) {
            labelPos = Cesium.Cartesian3.fromDegrees(labelSpec.position.x, labelSpec.position.y);
          } else if (hasLine && ["line", "curved", "horizontal", "perimeter"].includes(pl.mode)) {
            labelPos = polylineMidpoint(entity, t)?.position || entityCentroid(entity, t);
          } else if (hasFill && (pl.centroidInside || pl.fitInsidePolygon)) {
            labelPos = pointInsidePolygon(entity, t) || entityCentroid(entity, t);
          } else if (!entity.position && (hasLine || hasFill)) {
            labelPos = entityCentroid(entity, t);
          }
          if (labelPos) entity.position = new Cesium.ConstantPositionProperty(labelPos);
          // コールアウト: ラベル位置が地物から離れた場合に引き出し線を引く
          const anchor = anchorPos || entityCentroid(entity, t);
          if (labelSpec.callout && labelPos && anchor && !Cesium.Cartesian3.equals(anchor, labelPos)) {
            pendingCallouts.push({ from: anchor, to: labelPos, line: labelSpec.callout.line });
          }
          // ドロップシャドウ: 同色ラベルをオフセット重複で近似
          if (labelSpec.shadow) pendingShadows.push({ entity, labelSpec, oxPx, oyPx, hOrigin, vOrigin });
          const [oxPx, oyPx] = labelSpec.pixelOffsetOf ? labelSpec.pixelOffsetOf() : [0, 0];
          const overMode = pl.mode === "over" || (q.h === 0 && q.v === 0);
          const hOrigin = overMode ? Cesium.HorizontalOrigin.CENTER
            : q.h > 0 ? Cesium.HorizontalOrigin.LEFT : q.h < 0 ? Cesium.HorizontalOrigin.RIGHT : Cesium.HorizontalOrigin.CENTER;
          const vOrigin = overMode ? Cesium.VerticalOrigin.CENTER
            : q.v > 0 ? Cesium.VerticalOrigin.BOTTOM : q.v < 0 ? Cesium.VerticalOrigin.TOP : Cesium.VerticalOrigin.CENTER;
          // ライン配置は中点セグメントの方向へ回転
          let labelRot = pl.rotationDeg || 0;
          if (hasLine && ["line", "curved", "perimeter"].includes(pl.mode)) {
            const mid = polylineMidpoint(entity, t);
            if (mid) labelRot += -(mid.bearing - Math.PI / 2) * 180 / Math.PI;
          }
          // 点地物はマーカー分だけ上下へ逃がす(従来の -12px 相当)
          const bump = hasPoint && q.v ? -Math.sign(q.v) * 12 : 0;
          const bg = labelSpec.background;
          entity.label = new Cesium.LabelGraphics({
            text,
            font: labelSpec.fontCss,
            fillColor: toCesiumColor(mulAlpha(labelSpec.fill, opacity)),
            outlineColor: labelSpec.halo ? toCesiumColor(mulAlpha(labelSpec.halo.color, opacity)) : Cesium.Color.BLACK,
            outlineWidth: labelSpec.halo ? labelSpec.halo.widthPx : 0,
            style: labelSpec.halo ? Cesium.LabelStyle.FILL_AND_OUTLINE : Cesium.LabelStyle.FILL,
            horizontalOrigin: hOrigin,
            verticalOrigin: vOrigin,
            pixelOffset: new Cesium.Cartesian2(oxPx, oyPx + bump),
            rotation: labelRot ? -labelRot * Math.PI / 180 : 0,
            showBackground: !!bg,
            backgroundColor: bg ? toCesiumColor(mulAlpha(bg.fill, opacity)) : undefined,
            backgroundPadding: bg ? new Cesium.Cartesian2(bg.padPx[0] + 3, bg.padPx[1] + 3) : undefined,
          });
          // ラベル縮尺表示 → 規則縮尺との積集合を DDC として適用
          const ls = labelSpec.labelScale;
          if (ls && (ls.minScale || ls.maxScale)) {
            const near = scaleDenomToDist(ls.minScale || 0);
            const far = ls.maxScale ? scaleDenomToDist(ls.maxScale) : Number.MAX_VALUE;
            entity.label.distanceDisplayCondition = new Cesium.ConstantProperty(
              new Cesium.DistanceDisplayCondition(
                Math.max(ddc?.near ?? 0, near),
                Math.min(ddc?.far ?? Number.MAX_VALUE, far)));
          } else if (ddc) {
            entity.label.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
          }
        }
      }
    }
  }
    // ラベルシャドウ(本体ラベルの後ろにオフセット重複で近似)
  for (const s of pendingShadows) {
    try {
      const sh = s.labelSpec.shadow;
      const se = ds.entities.add({ position: s.entity.position });
      se.label = new Cesium.LabelGraphics({
        text: s.labelSpec.text,
        font: s.labelSpec.fontCss,
        fillColor: toCesiumColor(mulAlpha(sh.color, opacity)),
        outlineWidth: sh.radiusPx || 0,
        outlineColor: toCesiumColor(mulAlpha(sh.color, opacity)),
        style: sh.radiusPx ? Cesium.LabelStyle.FILL_AND_OUTLINE : Cesium.LabelStyle.FILL,
        horizontalOrigin: s.hOrigin, verticalOrigin: s.vOrigin,
        pixelOffset: new Cesium.Cartesian2(s.oxPx + sh.offsetPx[0], s.oyPx + sh.offsetPx[1]),
      });
    } catch (e) { /* シャドウ生成失敗は無視 */ }
  }
  // コールアウト(引き出し線)
  for (const c of pendingCallouts) {
    try {
      ds.entities.add({
        polyline: {
          positions: [c.from, c.to],
          width: new Cesium.ConstantProperty(Math.max(c.line.widthPx, 0.5)),
          material: new Cesium.ColorMaterialProperty(toCesiumColor(mulAlpha(c.line.color, opacity))),
          clampToGround: new Cesium.ConstantProperty(clamp),
        },
      });
    } catch (e) { /* 追加失敗時は非表示扱い */ }
  }
  // declutter 用にラベル spec を退避
  ds._qmlLabels = [...labelCandidates.values()];
}

// ---------------------------------------------------------------------------
// ラベル衝突回避(QGIS PAL の「重なったラベルを隠す」近似)
// Cesium には衝突管理がないため、画面投影したラベル矩形同士の重なりを
// 自前で検出し、優先度/zIndex が低い方を非表示にする。
// displayAll/allowOverlap のラベルは判定対象外(常時表示)。
// 順位付き位置(predefinedPositionOrder)は空きが見つかる位置へ移す。
// ---------------------------------------------------------------------------

// "TR,TL,BL,BR,T,L,B,R" → quad {h,v} リスト
function orderToQuads(order, fallback) {
  const map = {
    TR: { h: 1, v: 1 }, TL: { h: -1, v: 1 }, BR: { h: 1, v: -1 }, BL: { h: -1, v: -1 },
    T: { h: 0, v: 1 }, B: { h: 0, v: -1 }, R: { h: 1, v: 0 }, L: { h: -1, v: 0 },
  };
  const out = (order || []).map(k => map[String(k).trim().toUpperCase()]).filter(Boolean);
  return out.length ? out : [fallback || { h: 0, v: 0 }];
}

function toWindow(scene, pos) {
  const st = Cesium.SceneTransforms;
  if (st?.worldToWindowCoordinates) return st.worldToWindowCoordinates(scene, pos);
  if (st?.wgs84ToWindowCoordinates) return st.wgs84ToWindowCoordinates(scene, pos);
  return null;
}

const overlapBox = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

// 1データソース分の declutter を実行する。複数 ds 間の衝突も見るため
// 共有の placed 配列を受け取る
export function declutterDataSourceLabels(scene, ds, placed = []) {
  const list = (ds._qmlLabels || []).filter(c => c.spec?.text);
  if (!list.length) return;
  const t = Cesium.JulianDate.now();
  const sorted = [...list].sort((a, b) =>
    (b.spec.zIndex - a.spec.zIndex) || (b.spec.priority - a.spec.priority));
  for (const c of sorted) {
    const e = c.entity;
    if (!e?.label) continue;
    if (c.spec.allowOverlap || c.spec.displayAll) { e.label.show = new Cesium.ConstantProperty(true); continue; }
    const pos = e.position?.getValue?.(t);
    const win = pos ? toWindow(scene, pos) : null;
    if (!win || !Number.isFinite(win.x)) { e.label.show = new Cesium.ConstantProperty(false); continue; }
    const size = c.spec.sizePx || 12;
    const lines = String(c.spec.text).split("\n");
    const w = Math.max(...lines.map(l => l.length)) * size * 0.62 + (c.spec.halo ? c.spec.halo.widthPx * 2 : 0) + 4;
    const h = lines.length * size * (c.spec.lineHeightFactor || 1) + 2;
    const pl = c.spec.placement || {};
    const quads = pl.predefinedOrder?.length ? orderToQuads(pl.predefinedOrder, pl.quad) : [pl.quad || { h: 0, v: 0 }];
    let done = false;
    for (const q of quads) {
      const dx = (pl.offsetXPx || 0) + (q.h || 0) * (pl.distPx || 0);
      const dy = -((pl.offsetYPx || 0) + (q.v || 0) * (pl.distPx || 0));
      const x1 = win.x + dx - (q.h < 0 ? w : q.h === 0 ? w / 2 : 0);
      const y1 = win.y + dy - (q.v > 0 ? h : q.v === 0 ? h / 2 : 0);
      const box = { x1, y1, x2: x1 + w, y2: y1 + h };
      if (!placed.some(b => overlapBox(b, box))) {
        placed.push(box);
        e.label.pixelOffset = new Cesium.ConstantProperty(new Cesium.Cartesian2(dx, dy));
        e.label.show = new Cesium.ConstantProperty(true);
        done = true;
        break;
      }
    }
    if (!done) e.label.show = new Cesium.ConstantProperty(false);
  }
}

// データソース群に対して declutter を実行する(全 ds 横断で衝突判定)
export function declutterAllLabels(scene, sources) {
  const placed = [];
  for (const ds of sources || []) {
    try { declutterDataSourceLabels(scene, ds, placed); } catch (e) { /* 1件失敗でも継続 */ }
  }
}

let _declutterInstalled = false;
let _declutterTimer = null;
// viewer.scene へカメラ停止時の自動 declutter を一度だけ仕掛ける
export function installLabelDeclutter(scene, getSources) {
  if (_declutterInstalled || !scene) return;
  _declutterInstalled = true;
  const run = () => {
    if (_declutterTimer) return;
    _declutterTimer = setTimeout(() => {
      _declutterTimer = null;
      declutterAllLabels(scene, getSources?.() || []);
    }, 150);
  };
  try { scene.camera.moveEnd.addEventListener(run); } catch (e) {}
  try { scene.camera.changed.addEventListener(() => {
    if (scene.camera.changed.percentageChanged > 0.5) run();
  }); } catch (e) {}
  // 初回は描画が安定してから
  setTimeout(run, 800);
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
export function applyQmlStyleToPrimitive(primitive, style, hiddenSymbols = null, opacity = 1) {
  if (!style || !primitive) return;
  const hasHidden = !!(hiddenSymbols && hiddenSymbols.size);
  const materialCache = new Map();
  const matFor = (kind, spec) => {
    const key = kind + JSON.stringify(spec) + "@" + opacity;
    let m = materialCache.get(key);
    if (!m) {
      if (kind === "point") {
        const mk = spec.markers?.[0];
        m = new Cesium.BufferPointMaterial({
          color: toCesiumColor(mulAlpha(mk?.fill || [0.2, 0.4, 0.9, 1], opacity)),
          size: Math.max(mk?.sizePx || 6, 2),
          outlineColor: toCesiumColor(mulAlpha(mk?.stroke || [0, 0, 0, 1], opacity)),
          outlineWidth: mk?.stroke ? Math.max(mk.strokeWidthPx || 1, 1) : 0,
        });
      } else if (kind === "line") {
        m = new Cesium.BufferPolylineMaterial({
          color: toCesiumColor(mulAlpha(spec.line?.color || [0, 0, 0, 1], opacity)),
          width: Math.max(spec.line?.widthPx || 1, 1),
        });
      } else {
        const solids = (spec.fillParts || []).filter(pt => pt.solid);
        const base = solids.length ? solids[solids.length - 1].solid : [0.5, 0.5, 0.5, 0.7];
        m = new Cesium.BufferPolygonMaterial({
          color: toCesiumColor(mulAlpha(base, opacity)),
          outlineColor: toCesiumColor(mulAlpha(spec.outline?.color || base, opacity)),
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
