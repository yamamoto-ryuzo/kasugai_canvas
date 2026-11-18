// QML スタイル(.qml)の Cesium への適用（描画側バインディング）
// パース・式評価・シンボルコンパイルは /shared/qml-style.js を参照。
// 本ファイルは Cesium 固有の entity/primitive 適用部のみを持つ。
import { toCesiumColor, dashPattern, markerLayersToCanvas, fillPartsToTile, scaleFillPartsAlpha, rgbaToCss, qmlLabelCanvas, evalGeomExpr, diagramCanvas, linRefFormatText } from "../shared/qml-style.js";
import { trimCoordsPlanar, TRIM_PX_TO_M } from "../shared/qml-2d.js";

const Cesium = window.Cesium;

// ---------------------------------------------------------------------------
// Cesium への適用
// ---------------------------------------------------------------------------

// ---- GeometryGenerator 一般形(#64) ----
// entity の描画ジオメトリを GeoJSON(4326) へ戻す
const _cartoDeg = c => {
  const g = Cesium.Cartographic.fromCartesian(c);
  return [g.longitude * 180 / Math.PI, g.latitude * 180 / Math.PI];
};
const _degToCart = c => Cesium.Cartesian3.fromDegrees(c[0], c[1]);

function entityGeoJsonGeom(entity, t) {
  try {
    if (entity.polygon?.hierarchy) {
      const h = entity.polygon.hierarchy.getValue?.(t);
      const polys = (Array.isArray(h) ? h : (h ? [h] : [])).filter(Boolean)
        .map(p => [(p.positions || p).map(_cartoDeg),
                   ...(p.holes || []).map(r => (r.positions || r).map(_cartoDeg))]);
      if (!polys.length || !polys[0][0]?.length) return null;
      return polys.length === 1
        ? { type: "Polygon", coordinates: polys[0] }
        : { type: "MultiPolygon", coordinates: polys };
    }
    if (entity.polyline?.positions) {
      const pos = entity.polyline.positions.getValue?.(t) || [];
      return pos.length ? { type: "LineString", coordinates: pos.map(_cartoDeg) } : null;
    }
    if (entity.position) {
      const c = entity.position.getValue?.(t);
      return c ? { type: "Point", coordinates: _cartoDeg(c) } : null;
    }
  } catch (_) { /* ジオメトリ逆変換失敗時は GG 適用なし */ }
  return null;
}

// GeoJSON(4326) → 描画片の列挙(polygon hierarchy / line positions / point position)
function* geomToParts(geom) {
  if (!geom) return;
  const t = geom.type;
  if (t === "Polygon" || t === "MultiPolygon") {
    const polys = t === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) {
      if (!poly[0]?.length) continue;
      yield {
        kind: "polygon",
        hierarchy: new Cesium.PolygonHierarchy(
          poly[0].map(_degToCart),
          (poly.slice(1) || []).map(r => new Cesium.PolygonHierarchy(r.map(_degToCart)))),
      };
    }
    return;
  }
  if (t === "LineString" || t === "MultiLineString") {
    const lines = t === "LineString" ? [geom.coordinates] : geom.coordinates;
    for (const line of lines) if (line?.length >= 2) yield { kind: "line", positions: line.map(_degToCart) };
    return;
  }
  if (t === "Point" || t === "MultiPoint") {
    const pts = t === "Point" ? [geom.coordinates] : geom.coordinates;
    for (const p of pts) if (p?.length >= 2) yield { kind: "point", position: _degToCart(p) };
    return;
  }
  for (const sub of geom.geometries || []) yield* geomToParts(sub); // GeometryCollection
}

// spec.gg の各パートを評価し、生成ジオメトリを補助エンティティとして描く。
// fill=生成ポリゴン / line=生成ライン / marker=生成点へのマーカー描画
function applyGeometryGenerators(entity, ggList, t, ctx) {
  const { addAux, clamp, opacity } = ctx;
  (window.__qmlGg ||= { parts: 0, calls: 0 }).calls++;
  const base = entityGeoJsonGeom(entity, t);
  if (!base) return;
  for (const part of ggList) {
    const gen = evalGeomExpr(part.expr, base);
    if (!gen) continue;
    for (const piece of geomToParts(gen)) {
      if (part.kind === "fill" && piece.kind === "polygon") {
        const { solidBase, tile } = fillPartsToTile(scaleFillPartsAlpha(part.fillParts || [], opacity));
        const polyDesc = {
          hierarchy: piece.hierarchy,
          material: tile
            ? new Cesium.ImageMaterialProperty({ image: tile, transparent: true })
            : new Cesium.ColorMaterialProperty(toCesiumColor(solidBase || [0, 0, 0, 0.4])),
        };
        if (part.outline) {
          polyDesc.outline = true;
          polyDesc.outlineColor = toCesiumColor(mulAlpha(part.outline.color, opacity));
          polyDesc.outlineWidth = part.outline.widthPx || 1;
        }
        if (addAux({ polygon: polyDesc })) (window.__qmlGg ||= { parts: 0 }).parts++;
      } else if (part.kind === "line" && (piece.kind === "line" || piece.kind === "polygon")) {
        const positions = piece.kind === "line" ? piece.positions : piece.hierarchy.positions;
        if (addAux({
          polyline: {
            positions,
            width: new Cesium.ConstantProperty(part.line.widthPx || 1),
            material: dashMaterialProperty(mulAlpha(part.line.color, opacity), part.line.dash),
            clampToGround: clamp,
            arcType: Cesium.ArcType.GEODESIC,
          },
        })) (window.__qmlGg ||= { parts: 0 }).parts++;
      } else if (part.kind === "marker" && piece.kind !== "line") {
        const cart = piece.kind === "point" ? piece.position
          : Cesium.BoundingSphere.fromPoints(piece.positions || piece.hierarchy.positions).center;
        if (addAux({
          position: cart,
          billboard: {
            image: new Cesium.ConstantProperty(markerLayersToCanvas(part.markers)),
            scale: 1,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            color: Cesium.Color.WHITE.withAlpha(opacity),
          },
        })) (window.__qmlGg ||= { parts: 0 }).parts++;
      }
    }
  }
}

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

// Cartesian3 位置列を先頭/末尾のメートル指定で切断する
// (弦距離近似: トリム量は小さいため弧長との差は無視できる)
function trimCartesianPositions(positions, startM = 0, endM = 0) {
  if (!positions?.length || positions.length < 2) return positions;
  if (!(startM > 0 || endM > 0)) return positions;
  const pts = positions.map(p => [p.x, p.y, p.z]);
  const out = trimCoordsPlanar(pts, startM, endM);
  if (out === pts) return positions;
  return out.map(c => new Cesium.Cartesian3(c[0], c[1], c[2]));
}

// <effect> glow 系の色(<Option name="color"> 等)を QGIS 色配列で返す
function parseCesiumFxColor(fx) {
  const v = fx?.color ?? fx?.fill_color ?? fx?.glow_color;
  if (typeof v === "string") {
    const parts = v.split(",").map(Number);
    if (parts.length >= 3 && parts.every(Number.isFinite)) {
      return [parts[0] / 255, parts[1] / 255, parts[2] / 255,
        (parts.length > 3 ? parts[3] : 255) / 255];
    }
  }
  return null;
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
export function applyQmlStyleToDataSource(ds, style, { clamp = false, clampRef = null, time = null, hiddenSymbols = null, opacity = 1, relayoutLabels = true } = {}) {
  if (!style) return;
  // 補助エンティティの生成/削除とラベル更新を1回の変更通知に束ねる。
  // 逐次変更だと実行中のプリミティブ構築と競合し(属性リスト不整合など)
  // レンダリングクラッシュを起こすことがある
  if (ds._qmlApplying) return;
  ds._qmlApplying = true;
  try { ds.entities.suspendEvents?.(); } catch (_) {}
  try {
  _applyQmlStyleToDataSourceInner(ds, style, { clamp, clampRef, time, hiddenSymbols, opacity });
  } finally {
    ds._qmlApplying = false;
    try { ds.entities.resumeEvents?.(); } catch (_) {}
  }
  // 再適用で初期非表示へ戻ったラベルを復帰させるため declutter を再評価する
  // (透過度変更等ジオメトリ不変のケースは前回表示状態が引き継がれるが、
  // 凡例切替やルール変化で新たに出るラベルは再評価が必要)。
  // relayoutLabels=false(透過度のみの再適用)では再評価しない:
  // 表示状態は carry で完全に引き継がれ、declutter の再配置は
  // 投影行列のタイミング差で表示判定が揺れてラベルが一時的に減る原因になる
  if (relayoutLabels && ds._qmlLabels?.length) requestLabelDeclutter();
}

function _applyQmlStyleToDataSourceInner(ds, style, { clamp = false, clampRef = null, time = null, hiddenSymbols = null, opacity = 1 } = {}) {
  const t = time || Cesium.JulianDate.now();
  // ドレープ時の点・ラベル高さ基準。billboard/label/point は
  // classificationType を持たないため heightReference で地形/3D Tiles へ
  // クランプする。clampRef 未指定の呼び出しは従来通り CLAMP_TO_GROUND とみなす
  const hRef = clamp ? (clampRef ?? Cesium.HeightReference.CLAMP_TO_GROUND) : null;
  const hasHidden = !!(hiddenSymbols && hiddenSymbols.size);
  // 前回適用時に生成した補助エンティティ(装飾線・積層線)を掃除する
  for (const e of ds._qmlAux || []) { try { ds.entities.remove(e); } catch (_) {} }
  ds._qmlAux = [];
  // ラベル障害物(obstacleType): 地物 bbox を衝突判定の placed へ登録するため収集
  ds._qmlObstacles = [];
  const addAux = ent => {
    try {
      // 位置を持つ補助エンティティは座標の NaN を除外する(描画クラッシュ防止)
      const okPos = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
      if (ent.polyline?.positions) {
        ent.polyline.positions = ent.polyline.positions.filter(okPos);
        if (ent.polyline.positions.length < 2) return null;
      }
      if (ent.position && !okPos(ent.position)) return null;
      if (ent.polygon?.hierarchy?.positions) {
        ent.polygon.hierarchy = new Cesium.PolygonHierarchy(ent.polygon.hierarchy.positions.filter(okPos));
        if (ent.polygon.hierarchy.positions.length < 3) return null;
      }
      // ドレープ中は補助エンティティの点・ラベルも地表へクランプする
      if (hRef != null) {
        if (ent.billboard) ent.billboard.heightReference = hRef;
        if (ent.label) ent.label.heightReference = hRef;
        if (ent.point) ent.point.heightReference = hRef;
      }
      const e = ds.entities.add(ent);
      e._kascAux = true;
      ds._qmlAux.push(e);
      return e;
    } catch (_) { return null; }
  };
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
  const allEnts = [...ds.entities.values];
  const dbg = window.__kascQmlDbg
    ? { ents: 0, noSpec: 0, cand: labelCandidates.size, prevT: 0, prevF: 0, prevU: 0, carryF: 0, elseHide: 0, newGfx: 0 }
    : null;
  for (const entity of allEnts) {
    if (entity._kascAux) continue;
    if (dbg) dbg.ents++;
    const props = entityFeatureProps(entity, t);
    // 凡例の条件別チェックで非表示化されたシンボルにだけ該当する地物は隠す
    const hiddenByLegend = hasHidden && style.namesFor
      && (() => { const names = style.namesFor(props); return names.length > 0 && names.every(name => hiddenSymbols.has(name)); })();
    const spec = hiddenByLegend ? null : style.evaluate(props);
    const hasPoint = !!entity.billboard;
    const hasLine = !!entity.polyline;
    const hasFill = !!entity.polygon;
    // 再適用(レイヤ透過度・凡例・縮尺ルール変更等)でラベル gfx を
    // 作り直す際、declutter 再評価までの間に表示が消えないよう
    // 前回ラベル gfx の表示判定を引き継ぐ。
    // bufferNoFill ラベルは entity.billboard を共有するため、
    // マーカー処理が show を上書きする「前」に読んでおく必要がある
    const prevLabelGfx = entity._kascLabelGfx || null;
    const prevLabelShow = prevLabelGfx?.show?.getValue?.(t);
    if (dbg) { if (prevLabelShow === true) dbg.prevT++; else if (prevLabelShow === false) dbg.prevF++; else dbg.prevU++; }

    if (!spec) {
      if (dbg) dbg.noSpec++;
      if (entity.billboard) entity.billboard.show = new Cesium.ConstantProperty(false);
      if (entity.polyline) entity.polyline.show = new Cesium.ConstantProperty(false);
      if (entity.polygon) entity.polygon.show = new Cesium.ConstantProperty(false);
      if (entity.label) entity.label.show = new Cesium.ConstantProperty(false);
      continue;
    }

    // GeometryGenerator 一般形(#64): $geometry+常用関数を地物ジオメトリへ
    // 評価し、生成ジオメトリを補助エンティティとして描く
    if (spec.gg?.length) {
      try { applyGeometryGenerators(entity, spec.gg, t, { addAux, clamp, opacity }); }
      catch (e) { console.warn("GeometryGenerator 描画に失敗しました:", e); }
    }

    const ddc = spec.scale ? new Cesium.DistanceDisplayCondition(spec.scale.near, spec.scale.far) : null;

    // ポイント → billboard(canvas 合成アイコン)
    if (hasPoint) {
      if (spec.markers?.length) {
        const canvas = markerLayersToCanvas(spec.markers);
        // bufferNoFill ラベルとの共存用にマーカー canvas を記録する
        // (billboard は1枠しかないためラベル側で合成して描く)
        entity._kascMarkerCanvas = canvas;
        entity.billboard.show = new Cesium.ConstantProperty(true);
        entity.billboard.image = new Cesium.ConstantProperty(canvas);
        entity.billboard.scale = new Cesium.ConstantProperty(1);
        // MapUnit/MetersInMapUnits: メートル実寸のためカメラ距離で拡縮する
        // (installMapUnitScaler が _qmlMapUnits を参照して更新)
        const mu = spec.markers.find(m => m?.sizeMeters);
        if (mu) (entity._qmlMapUnits ||= {}).billboard = { meters: mu.sizeMeters, refPx: Math.max(canvas.height || 1, 1) };
        else if (entity._qmlMapUnits) delete entity._qmlMapUnits.billboard;
        entity.billboard.verticalOrigin = new Cesium.ConstantProperty(Cesium.VerticalOrigin.CENTER);
        entity.billboard.horizontalOrigin = new Cesium.ConstantProperty(Cesium.HorizontalOrigin.CENTER);
        // レイヤ透過度: 焼き付け済みキャンバス全体へ乗算する
        entity.billboard.color = new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(opacity));
        if (hRef != null) entity.billboard.heightReference = new Cesium.ConstantProperty(hRef);
        const rot = spec.markers[0]?.rotationDeg || 0;
        if (rot) entity.billboard.rotation = new Cesium.ConstantProperty(-rot * Math.PI / 180);
        if (ddc) entity.billboard.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
      } else {
        entity._kascMarkerCanvas = null;
        entity.billboard.show = new Cesium.ConstantProperty(false);
      }
    }

    // ダイアグラム(#108): 地物属性から円グラフ/棒グラフ canvas を生成して billboard 追加
    if (style.diagram) {
      try {
        const cv = diagramCanvas(style.diagram, props);
        if (cv) {
          const dpos = entity.position?.getValue?.(t)
            || (hasLine ? polylineMidpoint(entity, t) : null)
            || entityCentroid(entity, t);
          if (dpos) addAux({ position: dpos, billboard: { image: cv, verticalOrigin: Cesium.VerticalOrigin.CENTER, horizontalOrigin: Cesium.HorizontalOrigin.CENTER } });
        }
      } catch (_) { /* ダイアグラム描画失敗は本体描画を止めない */ }
    }

    // ライン
    if (hasLine) {
      if (spec.line) {
        entity.polyline.show = new Cesium.ConstantProperty(true);
        // <effect> glow/outerglow は PolylineGlowMaterial で近似(破線と両立
        // しないため破線優先)。glowPower は blur/spread の px から幅比で推定
        const glowFx = (spec.line.effects || []).find(fx =>
          /^(outer)?glow$/i.test(String(fx?.type || "")));
        const glowBlurPx = glowFx
          ? Math.max(Number(glowFx.blur_level ?? glowFx.blur_radius ?? 0)
              * ({ Point: 96 / 72, Pixel: 1, MapUnit: 0.3 * 96 / 25.4 }[glowFx.blur_unit] ?? 96 / 25.4), 0)
          : 0;
        if (glowFx && !spec.line.dash?.length && Cesium.PolylineGlowMaterialProperty) {
          const w = Math.max(spec.line.widthPx || 1, 0.5);
          entity.polyline.material = new Cesium.PolylineGlowMaterialProperty({
            color: toCesiumColor(mulAlpha(
              parseCesiumFxColor(glowFx) || spec.line.color, opacity)),
            glowPower: Math.min(Math.max((glowBlurPx || 4) / (w * 4), 0.03), 0.25),
          });
        } else {
          entity.polyline.material = dashMaterialProperty(mulAlpha(spec.line.color, opacity), spec.line.dash);
        }
        entity.polyline.width = new Cesium.ConstantProperty(spec.line.widthPx);
        // symbollevels 近似: 地物最小 pass を ground プリミティブの zIndex へ
        // (非クランプの 3D 空間では深度ソートが優先されるため無効)
        if (Number.isFinite(spec.zRank)) {
          entity.polyline.zIndex = new Cesium.ConstantProperty(spec.zRank);
          if (entity.polygon) entity.polygon.zIndex = new Cesium.ConstantProperty(spec.zRank);
        }
        // 線端トリム(QML trim_distance): 基準縮尺換算のメートル値で
        // Cartesian3 位置列を弦距離切断する近似
        const tsU = (spec.line.trimStartPx || 0) * TRIM_PX_TO_M;
        const teU = (spec.line.trimEndPx || 0) * TRIM_PX_TO_M;
        if (tsU > 0 || teU > 0) {
          const pos0 = entity.polyline.positions?.getValue?.(t);
          if (pos0?.length >= 2) {
            entity.polyline.positions = new Cesium.ConstantProperty(
              trimCartesianPositions(pos0, tsU, teU));
          }
        }
        if (ddc) entity.polyline.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
        // 複数ラインシンボル(ケーシング)と装飾線は補助エンティティで近似描画。
        // 補助描画の失敗で本体レンダリングを止めないよう try/catch で囲む
        try {
          if (spec.lines?.length > 1) {
            const pos = entity.polyline.positions?.getValue?.(t);
            if (pos?.length > 1) {
              for (let i = spec.lines.length - 2; i >= 0; i--) {
                const l = spec.lines[i];
                const ltsU = (l.trimStartPx || 0) * TRIM_PX_TO_M;
                const lteU = (l.trimEndPx || 0) * TRIM_PX_TO_M;
                addAux({
                  polyline: {
                    positions: (ltsU > 0 || lteU > 0)
                      ? trimCartesianPositions(pos, ltsU, lteU) : pos,
                    width: new Cesium.ConstantProperty(l.widthPx),
                    material: dashMaterialProperty(mulAlpha(l.color, opacity), l.dash),
                    clampToGround: entity.polyline.clampToGround?.getValue?.(t) ?? clamp,
                    arcType: entity.polyline.arcType?.getValue?.(t) ?? Cesium.ArcType.GEODESIC,
                  },
                });
              }
            }
          }
          if (spec.line.decor) {
            renderLineDecor(entity, spec.line.decor, t, { addAux, clamp, opacity });
          }
        } catch (_) { /* 補助描画のみ失敗 */ }
      } else {
        entity.polyline.show = new Cesium.ConstantProperty(false);
      }
    }

    // ポリゴン
    if (hasFill) {
      // invertedPolygonRenderer: 地物 bbox を大きく広げた外枠 − 地物リング(穴)の
      // マスクへ差し替える(±180跨ぎの世界矩形はプリミティブ分割で壊れるため
      // データ周辺の矩形に留める)
      if (style.inverted && spec.fillParts?.length) {
        try {
          const h = entity.polygon?.hierarchy?.getValue?.(t);
          const parts = Array.isArray(h) ? h : (h ? [h] : []);
          let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
          for (const p of parts) {
            for (const pos of p.positions || []) {
              const c = Cesium.Cartographic.fromCartesian(pos);
              w = Math.min(w, c.longitude); e = Math.max(e, c.longitude);
              s = Math.min(s, c.latitude); n = Math.max(n, c.latitude);
            }
          }
          if (Number.isFinite(w)) {
            const dw = Math.max((e - w) * 4, 0.5), dh = Math.max((n - s) * 4, 0.5);
            const wc = w - dw, ec = e + dw, sc = s - dh, nc = n + dh;
            const holes = parts.map(p =>
              new Cesium.PolygonHierarchy((p.positions || p).slice().reverse()));
            entity.polygon.hierarchy = new Cesium.ConstantProperty(
              new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromRadiansArray(
                  [wc, sc, ec, sc, ec, nc, wc, nc]), holes));
            // GroundPrimitive は穴付きポリゴン非対応のため、
            // height=0 指定で通常 Primitive(穴対応)へ切り替える
            entity.polygon.height = new Cesium.ConstantProperty(0);
            entity.polygon.perPositionHeight = new Cesium.ConstantProperty(false);
          }
        } catch (_) { /* マスク生成失敗時は元地物のまま */ }
      }
      if (spec.fillParts?.length) {
        entity.polygon.show = new Cesium.ConstantProperty(true);
        const { solidBase, tile, tileMeters } = fillPartsToTile(scaleFillPartsAlpha(spec.fillParts, opacity));
        if (tile) {
          const repeat = computeFillRepeat(entity, t, tileMeters);
          entity.polygon.material = new Cesium.ImageMaterialProperty({ image: tile, repeat, transparent: true });
        } else if (solidBase) {
          entity.polygon.material = new Cesium.ColorMaterialProperty(toCesiumColor(solidBase));
          // 2.5D レンダラ近似: 非ドレープ時のみ立体押出し(クランプと両立しない)(#64)
          if (style?.d25 && !clamp) entity.polygon.extrudedHeight = new Cesium.ConstantProperty(style.d25.height ?? 10);
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
          entity._kascMarkerCanvas = canvas; // マーカー同様ラベルとの合成対象
          entity.billboard.image = new Cesium.ConstantProperty(canvas);
          entity.billboard.verticalOrigin = new Cesium.ConstantProperty(Cesium.VerticalOrigin.CENTER);
          entity.billboard.horizontalOrigin = new Cesium.ConstantProperty(Cesium.HorizontalOrigin.CENTER);
          if (hRef != null) entity.billboard.heightReference = new Cesium.ConstantProperty(hRef);
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
        // minFeatureSize/fitInsidePolygon は画面投影ベースの declutter で
        // ズーム連動して判定する(ここで固定係数で隠すとズームイン時に復活しない)
        let showLabel = true;
        // fitInsidePolygon の収まり判定は画面投影ベースの declutter で
        // ズーム連動して行う(ここで固定係数で隠すとズームイン時に復活しない)
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
          } else if (hasFill && labelSpec.largestPartOnly) {
            // マルチパート最大パートのみ: 最大面積パートの重心を選ぶ
            labelPos = largestPartCentroid(entity, t) || entityCentroid(entity, t);
          } else if (!entity.position && (hasLine || hasFill)) {
            labelPos = entityCentroid(entity, t);
          }
          if (labelPos) entity.position = new Cesium.ConstantPositionProperty(labelPos);
          // コールアウト: ラベル位置が地物から離れた場合に引き出し線を引く
          const anchor = anchorPos || entityCentroid(entity, t);
          if (labelSpec.callout && labelPos && anchor && !Cesium.Cartesian3.equals(anchor, labelPos)) {
            pendingCallouts.push({ from: anchor, to: labelPos, line: labelSpec.callout.line });
          }
          // (ドロップシャドウは oxPx/hOrigin 確定後に登録する)
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
          // bufferNoFill(中空ハロー): LabelGraphics では中空を表せないため
          // canvas ラスタライズしたラベルを billboard で描く。
          // マーカー/centroid 画像と billboard 枠が競合する場合は
          // 1枚の canvas に合成して共存させる(マーカーが消えないように)
          let labelCanvasH = 0;
          const labelGfx = labelSpec.halo?.noFill && (() => {
            const r = qmlLabelCanvas(labelSpec);
            if (!r) return null;
            labelCanvasH = r.canvas?.height || 0;
            let img = r.canvas, baseOff = null;
            const mkCv = entity._kascMarkerCanvas;
            if (mkCv) {
              // 地物位置を原点としてマーカーは中心、ラベルは (oxPx,oyPx+bump) に配置
              const lx = oxPx, ly = oyPx + bump;
              const mw = mkCv.width || 1, mh = mkCv.height || 1;
              const lw = img.width || 1, lh = img.height || 1;
              const minX = Math.min(-mw / 2, lx - lw / 2), maxX = Math.max(mw / 2, lx + lw / 2);
              const minY = Math.min(-mh / 2, ly - lh / 2), maxY = Math.max(mh / 2, ly + lh / 2);
              const W = Math.max(1, Math.ceil(maxX - minX)), H = Math.max(1, Math.ceil(maxY - minY));
              const ax = -minX, ay = -minY; // canvas 内の地物位置(アンカー)
              const cv = document.createElement("canvas");
              cv.width = W; cv.height = H;
              const g2 = cv.getContext("2d");
              g2.drawImage(mkCv, ax - mw / 2, ay - mh / 2);
              g2.drawImage(img, ax + lx - lw / 2, ay + ly - lh / 2);
              img = cv;
              // ラベル中心が画面位置+(dx,dy)へ来る基準オフセット。
              // declutter は pixelOffset を (dx,dy) で上書きするため合成分を加える
              baseOff = { x: W / 2 - ax - lx, y: H / 2 - ay - ly };
            }
            entity.billboard = new Cesium.BillboardGraphics({
              image: img,
              color: Cesium.Color.WHITE.withAlpha(opacity),
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              pixelOffset: new Cesium.Cartesian2(oxPx + (baseOff?.x || 0), oyPx + bump + (baseOff?.y || 0)),
              rotation: labelRot ? -labelRot * Math.PI / 180 : 0,
              heightReference: hRef ?? undefined,
            });
            if (baseOff) entity.billboard._kascBaseOffset = baseOff;
            return entity.billboard;
          })();
          if (!labelGfx) {
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
              heightReference: hRef ?? undefined,
            });
          }
          // fontSizeUnit=MapUnit/MetersInMapUnits: 距離連動でラベルを拡縮
          if (labelSpec.sizeMeters) {
            const refPx = labelGfx ? (labelCanvasH || labelSpec.sizePx) : labelSpec.sizePx;
            (entity._qmlMapUnits ||= {})[labelGfx ? "billboard" : "label"] = { meters: labelSpec.sizeMeters, refPx: Math.max(refPx || 1, 1) };
          }
          // ラベル縮尺表示 → 規則縮尺との積集合を DDC として適用。
          // 今回生成した gfx を確実に選ぶ(bufferNoFill 時に entity.label が
          // 前回の通常ラベルの残骸を持っていることがあるため)
          const gfx = labelGfx ? entity.billboard : entity.label;
          const ls = labelSpec.labelScale;
          if (ls && (ls.minScale || ls.maxScale)) {
            const near = scaleDenomToDist(ls.minScale || 0);
            const far = ls.maxScale ? scaleDenomToDist(ls.maxScale) : Number.MAX_VALUE;
            gfx.distanceDisplayCondition = new Cesium.ConstantProperty(
              new Cesium.DistanceDisplayCondition(
                Math.max(ddc?.near ?? 0, near),
                Math.min(ddc?.far ?? Number.MAX_VALUE, far)));
          } else if (ddc) {
            gfx.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
          }
          // declutter 対象(重なり禁止系)は初期非表示にし、declutter が
          // 画面投影ベースで空き/収まりを判定したうえで復帰する
          // (初期に全表示してから消すちらつきを防ぐ)。
          // 再適用時は前回の表示判定を引き継ぎ、再評価(requestLabelDeclutter)
          // が走るまでラベルが消えないようにする
          if (!(labelSpec.displayAll || labelSpec.allowOverlap)) {
            gfx.show = new Cesium.ConstantProperty(prevLabelShow === true);
            if (dbg && prevLabelShow !== true) dbg.carryF++;
          }
          if (dbg) dbg.newGfx++;
          entity._kascLabelGfx = gfx;
          // ラベル gfx が付け替わった(bufferNoFill↔通常)場合、取り残された
          // 旧 gfx を隠す。ただし marker として再利用中の billboard は除く
          if (prevLabelGfx && prevLabelGfx !== gfx
            && !(prevLabelGfx === entity.billboard && spec.markers?.length)) {
            try { prevLabelGfx.show = new Cesium.ConstantProperty(false); } catch (_) {}
          }
          // ドロップシャドウ: 同色ラベルをオフセット重複で近似
          if (!labelGfx && labelSpec.shadow) pendingShadows.push({ entity, labelSpec, oxPx, oyPx: oyPx + bump, hOrigin, vOrigin });
          // ラベル障害物(obstacle): obstacle="1" かつ obstacleFactor>0 の地物が
          // 他ラベルの配置を妨げる。declutter で画面投影ジオメトリを placed へ
          // 事前登録するため収集する(obstacleType はポリゴンの判定モード)
          if (labelSpec.obstacle && labelSpec.obstacleFactor > 0) {
            const mk = spec.markers?.length ? markerLayersToCanvas(spec.markers) : null;
            ds._qmlObstacles.push({
              entity,
              kind: labelSpec.obstacleType,
              sizePx: mk ? Math.max(mk.width, mk.height) : (spec.line?.widthPx || 8) * 1.5,
              lineHalfPx: Math.max((spec.line?.widthPx || 1) / 2, 0.5),
            });
          }
        }
      } else if (entity._kascLabelGfx && !(entity._kascLabelGfx === entity.billboard && spec?.markers?.length)) {
        // 今回のスタイル評価でラベルが消えた地物の取り残しを隠す
        if (dbg) dbg.elseHide++;
        try { entity._kascLabelGfx.show = new Cesium.ConstantProperty(false); } catch (_) {}
        entity._kascLabelGfx = null;
      }
    }
  }
    // ラベルシャドウ(本体ラベルの後ろにオフセット重複で近似)。
    // addAux 経由で _qmlAux に登録し、スタイル再適用時に重複蓄積しないようにする
  for (const s of pendingShadows) {
    try {
      const sh = s.labelSpec.shadow;
      addAux({
        position: s.entity.position?.getValue?.(t) || s.entity.position,
        label: new Cesium.LabelGraphics({
          text: s.labelSpec.text,
          font: s.labelSpec.fontCss,
          fillColor: toCesiumColor(mulAlpha(sh.color, opacity)),
          outlineWidth: sh.radiusPx || 0,
          outlineColor: toCesiumColor(mulAlpha(sh.color, opacity)),
          style: sh.radiusPx ? Cesium.LabelStyle.FILL_AND_OUTLINE : Cesium.LabelStyle.FILL,
          horizontalOrigin: s.hOrigin, verticalOrigin: s.vOrigin,
          pixelOffset: new Cesium.Cartesian2(s.oxPx + sh.offsetPx[0], s.oyPx + sh.offsetPx[1]),
          heightReference: hRef ?? undefined,
        }),
      });
    } catch (e) { /* シャドウ生成失敗は無視 */ }
  }
  // コールアウト(引き出し線)
  for (const c of pendingCallouts) {
    try {
      addAux({
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
  if (dbg) (window.__kascQmlDbg.applies ||= []).push(dbg);
}


// マルチポリゴン entity の最大面積パートの重心を返す(labelPerPart=0 近似)
function largestPartCentroid(entity, t) {
  try {
    const h = entity.polygon?.hierarchy?.getValue?.(t);
    const parts = Array.isArray(h) ? h : (h ? [h] : []);
    if (parts.length < 2) return null;
    let best = null, bestArea = -1;
    for (const p of parts) {
      const pos = p.positions || p;
      if (!pos?.length) continue;
      // 面積近似: 経度×緯度のシューレース
      let area = 0, cx = 0, cy = 0, n = 0;
      for (let i = 0; i < pos.length; i++) {
        const c1 = Cesium.Cartographic.fromCartesian(pos[i]);
        const c2 = Cesium.Cartographic.fromCartesian(pos[(i + 1) % pos.length]);
        area += c1.longitude * c2.latitude - c2.longitude * c1.latitude;
        cx += c1.longitude; cy += c1.latitude; n++;
      }
      if (Math.abs(area) > bestArea && n) { bestArea = Math.abs(area); best = Cesium.Cartesian3.fromRadians(cx / n, cy / n); }
    }
    return best;
  } catch (e) { return null; }
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

// ワールド座標 → 画面座標。worldToWindowCoordinates は最終描画フレームの
// 行列を使うため、カメラ移動直後・requestRenderMode の描画停止中は
// 古い投影になり得る → 投影不能(null)時は declutter 側で「非表示」ではなく
// 現状維持とし、古い行列による一斉消去を防ぐ
function toWindow(scene, pos) {
  const st = Cesium.SceneTransforms;
  if (st?.worldToWindowCoordinates) return st.worldToWindowCoordinates(scene, pos);
  if (st?.wgs84ToWindowCoordinates) return st.wgs84ToWindowCoordinates(scene, pos);
  return null;
}

const overlapBox = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

// --- ラベル障害物の実形状判定用 2D 幾何ヘルパー(画面座標系) ---
// 頂点列の bbox
function ptsBox(pts) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x; if (p.x > x2) x2 = p.x;
    if (p.y < y1) y1 = p.y; if (p.y > y2) y2 = p.y;
  }
  return { x1, y1, x2, y2 };
}
const _ori = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const _onSeg = (a, b, p) =>
  p.x >= Math.min(a.x, b.x) - 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9 &&
  p.y >= Math.min(a.y, b.y) - 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9;
// 線分同士の交差(端点接触を含む)
function segSeg(a, b, c, d) {
  const o1 = _ori(a, b, c), o2 = _ori(a, b, d), o3 = _ori(c, d, a), o4 = _ori(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (Math.abs(o1) < 1e-9 && _onSeg(a, b, c)) return true;
  if (Math.abs(o2) < 1e-9 && _onSeg(a, b, d)) return true;
  if (Math.abs(o3) < 1e-9 && _onSeg(c, d, a)) return true;
  if (Math.abs(o4) < 1e-9 && _onSeg(c, d, b)) return true;
  return false;
}
// 線分と矩形の交差(端点が箱内 or 箱のいずれかの辺と交差)
function segBoxHit(p, q, box) {
  const inBox = pt => pt.x >= box.x1 && pt.x <= box.x2 && pt.y >= box.y1 && pt.y <= box.y2;
  if (inBox(p) || inBox(q)) return true;
  const c1 = { x: box.x1, y: box.y1 }, c2 = { x: box.x2, y: box.y1 };
  const c3 = { x: box.x2, y: box.y2 }, c4 = { x: box.x1, y: box.y2 };
  return segSeg(p, q, c1, c2) || segSeg(p, q, c2, c3)
    || segSeg(p, q, c3, c4) || segSeg(p, q, c4, c1);
}
// 点のポリゴン内判定(射線法)
function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
      p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
// 投影ポリゴン vs ラベル矩形。obstacleType: 0=内部 1=境界のみ 2=全体。
// 境界のみはリング線分との交差(線幅ぶん pad)、内部/全体は面との重なりを見る
function polyBoxHit(obs, box) {
  const ring = obs.poly;
  if (obs.kind === 1) {
    const h = obs.half || 0;
    const pb = { x1: box.x1 - h, y1: box.y1 - h, x2: box.x2 + h, y2: box.y2 + h };
    for (let i = 0; i < ring.length; i++) {
      if (segBoxHit(ring[i], ring[(i + 1) % ring.length], pb)) return true;
    }
    return false;
  }
  const corners = [
    { x: box.x1, y: box.y1 }, { x: box.x2, y: box.y1 },
    { x: box.x2, y: box.y2 }, { x: box.x1, y: box.y2 },
  ];
  if (corners.some(c => pointInRing(c, ring))) return true;
  for (const p of ring) {
    if (p.x >= box.x1 && p.x <= box.x2 && p.y >= box.y1 && p.y <= box.y2) return true;
  }
  for (let i = 0; i < ring.length; i++) {
    if (segBoxHit(ring[i], ring[(i + 1) % ring.length], box)) return true;
  }
  return false;
}
// placed エントリとラベル矩形の衝突判定。bbox プリチェック後、
// 障害物は実形状(poly=ポリゴン/seg=折れ線)で詳細判定する
function obstacleHit(b, box) {
  if (!overlapBox(b, box)) return false;
  if (b.poly) return polyBoxHit(b, box);
  if (b.seg) {
    const pb = { x1: box.x1 - b.half, y1: box.y1 - b.half, x2: box.x2 + b.half, y2: box.y2 + b.half };
    for (let i = 0; i + 1 < b.seg.length; i++) if (segBoxHit(b.seg[i], b.seg[i + 1], pb)) return true;
    return false;
  }
  return true;
}

// ポリゴン entity の画面投影バウンディングボックス(fitInsidePolygon 判定用)。
// 頂点を間引いて投影コストを抑える
function polyScreenBox(scene, entity, t) {
  try {
    const h = entity.polygon?.hierarchy?.getValue?.(t);
    const parts = Array.isArray(h) ? h : (h ? [h] : []);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of parts) {
      const pos = p.positions || p;
      if (!pos?.length) continue;
      const step = Math.max(1, Math.floor(pos.length / 120));
      for (let i = 0; i < pos.length; i += step) {
        const win = toWindow(scene, pos[i]);
        if (!win || !Number.isFinite(win.x)) continue;
        if (win.x < x1) x1 = win.x; if (win.x > x2) x2 = win.x;
        if (win.y < y1) y1 = win.y; if (win.y > y2) y2 = win.y;
      }
    }
    return Number.isFinite(x1) ? { x1, y1, x2, y2 } : null;
  } catch (e) { return null; }
}

// --- 装飾ライン(MarkerLine/HashLine/ArrowLine)の補助エンティティ生成 ---
// px → m の近似換算は qml-render のラベル用と同じ 1px≒2.8m(参照縮尺 1:10000)
function samplePolylinePositions(entity, t, stepM, { skipMultiples = 0 } = {}) {
  const pos = entity.polyline?.positions?.getValue?.(t);
  if (!pos || pos.length < 2) return [];
  const out = [];
  let acc = 0, dist = 0;
  const skip = Math.max(skipMultiples || 0, 0);
  const eps = stepM * 1e-6;
  for (let i = 0; i + 1 < pos.length; i++) {
    const a = pos[i], b = pos[i + 1];
    const len = Cesium.Cartesian3.distance(a, b);
    if (!len) continue;
    const ca = Cesium.Cartographic.fromCartesian(a), cb = Cesium.Cartographic.fromCartesian(b);
    const ang = Math.atan2(cb.longitude - ca.longitude, cb.latitude - ca.latitude);
    while (acc < len) {
      const d = dist + acc;
      // skip_multiples: その倍数地点の標点を除外(里程標用)
      if (!(skip > 0 && d > 0 && Math.abs(d % skip) < Math.max(eps, skip * 1e-6))) {
        const p = Cesium.Cartesian3.lerp(a, b, acc / len, new Cesium.Cartesian3());
        out.push({ position: p, angle: ang, dist: d });
      }
      acc += stepM;
    }
    acc -= len;
    dist += len;
  }
  return out;
}

// 画面上方向(線分方位 rad)から hash_angle 度の刻みを地図上に作る
function offsetPos(pos, azimuthRad, distM) {
  const c = Cesium.Cartographic.fromCartesian(pos);
  const dLon = (distM * Math.sin(azimuthRad)) / (111320 * Math.cos(c.latitude));
  const dLat = (distM * Math.cos(azimuthRad)) / 110540;
  return Cesium.Cartesian3.fromRadians(c.longitude + dLon, c.latitude + dLat, c.height);
}

// InterpolatedLine(#108): 始端→終端で色・幅を補間する線。頂点単位補間は
// entity polyline では表せないため、弧長 N 分割のセグメント群で近似する
function renderInterpolatedLine(entity, decor, t, { addAux, clamp, opacity }) {
  const pos = entity.polyline?.positions?.getValue?.(t);
  if (!pos || pos.length < 2) return;
  const cum = [0];
  for (let i = 1; i < pos.length; i++) cum.push(cum[i - 1] + Cesium.Cartesian3.distance(pos[i - 1], pos[i]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return;
  // 本体の単色ラインは補間セグメントで置き換える
  entity.polyline.show = new Cesium.ConstantProperty(false);
  const N = Math.min(32, Math.max(8, Math.round(total / 500)));
  const lerpC = f => decor.c1.map((v, i) => v + (decor.c2[i] - v) * f);
  const clampToGround = entity.polyline.clampToGround?.getValue?.(t) ?? clamp;
  const arcType = entity.polyline.arcType?.getValue?.(t) ?? Cesium.ArcType.GEODESIC;
  let prev = pos[0];
  for (let i = 1; i <= N; i++) {
    const d = total * i / N;
    let j = 1;
    while (j < cum.length - 1 && cum[j] < d) j++;
    const f = Math.min(1, (d - cum[j - 1]) / Math.max(cum[j] - cum[j - 1], 1e-9));
    const pt = Cesium.Cartesian3.lerp(pos[j - 1], pos[j], f, new Cesium.Cartesian3());
    const f0 = (i - 0.5) / N;
    addAux({
      polyline: {
        positions: [prev, pt],
        width: new Cesium.ConstantProperty(decor.w1 + (decor.w2 - decor.w1) * f0),
        material: new Cesium.ColorMaterialProperty(toCesiumColor(mulAlpha(lerpC(f0), opacity))),
        clampToGround,
        arcType,
      },
    });
    prev = pt;
  }
}

function renderLineDecor(entity, decor, t, { addAux, clamp, opacity }) {
  if (decor.kind === "interpolated") {
    renderInterpolatedLine(entity, decor, t, { addAux, clamp, opacity });
    return;
  }
  if (decor.kind === "filledline") {
    // FilledLine: 本体の細線を隠し、CorridorGraphics(線幅 m の帯)を
    // fill サブシンボルで塗る。パターン塗りはタイル、単色は ColorMaterial
    entity.polyline.show = new Cesium.ConstantProperty(false);
    const pos = entity.polyline?.positions?.getValue?.(t);
    if (!pos || pos.length < 2) return;
    const { solidBase, tile } = fillPartsToTile(scaleFillPartsAlpha(
      decor.fillParts?.length ? decor.fillParts : [{ solid: [0.5, 0.5, 0.5, 1] }], opacity));
    const widthM = Math.max((decor.widthPx || 2) * LABEL_M_PER_PX, 0.5);
    const material = tile
      ? new Cesium.ImageMaterialProperty({ image: tile, transparent: true })
      : new Cesium.ColorMaterialProperty(toCesiumColor(solidBase || [0.5, 0.5, 0.5, 1]));
    addAux({
      corridor: {
        positions: pos,
        width: new Cesium.ConstantProperty(widthM),
        cornerType: { bevel: Cesium.CornerType.BEVEL, miter: Cesium.CornerType.MITERED, round: Cesium.CornerType.ROUNDED }[decor.join] ?? Cesium.CornerType.ROUNDED,
        material,
        // ドレープ時は height=0 で地表クランプへ
        ...(clamp ? { height: new Cesium.ConstantProperty(0) } : {}),
      },
    });
    // 塗りサブシンボルの outline_style は帯の両側縁ラインで近似
    if (decor.outline) {
      const half = widthM / 2;
      for (const side of [1, -1]) {
        const edge = pos.map((p, i) => {
          const b = pos[Math.min(i + 1, pos.length - 1)];
          const ca = Cesium.Cartographic.fromCartesian(p), cb = Cesium.Cartographic.fromCartesian(b);
          const az = Math.atan2(cb.longitude - ca.longitude, cb.latitude - ca.latitude);
          return offsetPos(p, az + Math.PI / 2, half * side);
        });
        addAux({
          polyline: {
            positions: edge,
            width: new Cesium.ConstantProperty(decor.outline.widthPx || 1),
            material: dashMaterialProperty(mulAlpha(decor.outline.color, opacity), decor.outline.dash),
            clampToGround: new Cesium.ConstantProperty(clamp),
            arcType: new Cesium.ConstantProperty(Cesium.ArcType.GEODESIC),
          },
        });
      }
    }
    return;
  }
  if (decor.kind === "linref") {
    // LinearReferencing(里程標): QGIS は基線を描かないため本体を隠し、
    // interval 間隔の標点へ距離ラベル(+任意マーカー)を置く
    entity.polyline.show = new Cesium.ConstantProperty(false);
    const pos = entity.polyline?.positions?.getValue?.(t);
    if (!pos || pos.length < 2) return;
    const tf = decor.text || {};
    const offM = (decor.labelOffsetPx || [0, 0]).map(v => (v || 0) * LABEL_M_PER_PX);
    const mkCv = decor.showMarker && decor.markers?.length ? markerLayersToCanvas(decor.markers) : null;
    for (const s of samplePolylinePositions(entity, t, Math.max(decor.intervalM || 1, 1), decor)) {
      if (s.dist <= 1e-9) continue; // 先頭(0m)は QGIS 同様ラベル無し
      let p = s.position;
      if (offM[0] || offM[1]) {
        // label_offset: rotate 時は線方向系(北=0 時計回りの方位)、
        // 非回転時は画面系(x=東, y=南)
        p = decor.rotate
          ? offsetPos(offsetPos(p, s.angle, offM[0]), s.angle + Math.PI / 2, offM[1])
          : offsetPos(offsetPos(p, Math.PI / 2, offM[0]), Math.PI, offM[1]);
      }
      if (mkCv) addAux({
        position: p,
        billboard: { image: mkCv,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          rotation: decor.rotate ? -(s.angle - Math.PI / 2) : 0 },
      });
      const text = linRefFormatText(s.dist + (decor.startMeasure || 0), decor.num);
      if (decor.rotate) {
        // LabelGraphics には rotation が無いため canvas ラスタ化して billboard へ
        const r = qmlLabelCanvas({ text, fontCss: tf.fontCss || "12px sans-serif",
          sizePx: tf.sizePx || 12, fill: tf.fill || [0, 0, 0, 1], halo: tf.halo || null });
        if (r) addAux({
          position: p,
          billboard: { image: r.canvas,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            rotation: -(s.angle - Math.PI / 2) },
        });
      } else {
        addAux({
          position: p,
          label: { text,
            font: tf.fontCss || "12px sans-serif",
            fillColor: toCesiumColor(mulAlpha(tf.fill || [0, 0, 0, 1], opacity)),
            outlineColor: tf.halo ? toCesiumColor(mulAlpha(tf.halo.color, opacity)) : Cesium.Color.TRANSPARENT,
            outlineWidth: tf.halo ? Math.max(tf.halo.widthPx || 1, 1) : 0,
            style: tf.halo ? Cesium.LabelStyle.FILL_AND_OUTLINE : Cesium.LabelStyle.FILL,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY },
        });
      }
    }
    return;
  }
  const pos = entity.polyline?.positions?.getValue?.(t);
  if (!pos || pos.length < 2) return;
  if (decor.kind === "markerline" && decor.markers?.length) {
    const cv = markerLayersToCanvas(decor.markers);
    let pts = [];
    if (decor.placement === "vertex") pts = pos.map(p => ({ position: p }));
    else if (decor.placement === "firstvertex") pts = [{ position: pos[0] }];
    else if (decor.placement === "lastvertex") pts = [{ position: pos[pos.length - 1] }];
    else if (decor.placement === "centralpoint") {
      const samples = samplePolylinePositions(entity, t, Number.MAX_VALUE);
      pts = samples.length ? [samples[Math.floor(samples.length / 2)]] : [];
    } else {
      pts = samplePolylinePositions(entity, t, Math.max(decor.intervalPx || 30, 5) * LABEL_M_PER_PX);
    }
    for (const s of pts) {
      const bb = { position: s.position, billboard: { image: cv, verticalOrigin: Cesium.VerticalOrigin.CENTER, horizontalOrigin: Cesium.HorizontalOrigin.CENTER } };
      if (decor.rotateMarker !== false && s.angle !== undefined) bb.billboard.rotation = -(s.angle - Math.PI / 2);
      addAux(bb);
    }
  } else if (decor.kind === "hashline" && decor.tick) {
    const tick = decor.tick;
    const half = (tick.lengthPx || 4) * LABEL_M_PER_PX / 2;
    const tickAng = (tick.angleDeg ?? 90) * Math.PI / 180;
    for (const s of samplePolylinePositions(entity, t, Math.max(decor.intervalPx || 10, 3) * LABEL_M_PER_PX)) {
      const a = s.angle + tickAng - Math.PI / 2;
      // 刻みごとに独立した polyline を作る(繋げるとジグザグになる)。
      // GroundPolyline は arcType GEODESIC のみ対応するため指定しない
      addAux({
        polyline: {
          positions: [offsetPos(s.position, a, -half), offsetPos(s.position, a, half)],
          width: new Cesium.ConstantProperty(Math.max(tick.widthPx || 1, 0.5)),
          material: new Cesium.ColorMaterialProperty(toCesiumColor(mulAlpha(tick.color, opacity))),
          clampToGround: new Cesium.ConstantProperty(clamp),
        },
      });
    }
  } else if (decor.kind === "arrowline") {
    const [a, b] = [pos[pos.length - 2], pos[pos.length - 1]];
    const ca = Cesium.Cartographic.fromCartesian(a), cb = Cesium.Cartographic.fromCartesian(b);
    const az = Math.atan2(cb.longitude - ca.longitude, cb.latitude - ca.latitude);
    const headLen = (decor.headLenPx || 9) * LABEL_M_PER_PX;
    const headWid = (decor.headWidthPx || 9) * LABEL_M_PER_PX / 2;
    const base = offsetPos(b, az, -headLen);
    const l = offsetPos(base, az + Math.PI / 2, headWid);
    const r = offsetPos(base, az - Math.PI / 2, headWid);
    // 矢羽はポリゴンではなく2本の折れ線で近似(補助ポリゴンの
    // プリミティブ混在による属性不整合を避ける)
    for (const tip of [l, r]) {
      addAux({
        polyline: {
          positions: [tip, b],
          width: new Cesium.ConstantProperty(Math.max(decor.widthPx || 2, 1)),
          material: new Cesium.ColorMaterialProperty(toCesiumColor(mulAlpha(decor.color, opacity))),
          clampToGround: new Cesium.ConstantProperty(clamp),
        },
      });
    }
  }
}

// ポリライン entity の画面投影長(px)。minFeatureSize 判定用
function lineScreenLen(scene, entity, t) {
  try {
    const pos = entity.polyline?.positions?.getValue?.(t);
    if (!pos?.length) return 0;
    const step = Math.max(1, Math.floor(pos.length / 60));
    let len = 0, px0 = null;
    for (let i = 0; i < pos.length; i += step) {
      const win = toWindow(scene, pos[i]);
      if (!win || !Number.isFinite(win.x)) { px0 = null; continue; }
      if (px0) len += Math.hypot(win.x - px0.x, win.y - px0.y);
      px0 = win;
    }
    return len;
  } catch (e) { return 0; }
}

// ポリゴン entity の外周リングを画面座標へ投影する(障害物の実形状判定用)。
// 頂点は投影コスト抑制のため間引き、穴リングは近似で無視する
function polyScreenRing(scene, entity, t) {
  try {
    const h = entity.polygon?.hierarchy?.getValue?.(t);
    const parts = Array.isArray(h) ? h : (h ? [h] : []);
    const pos = parts[0]?.positions || parts[0];
    if (!pos?.length) return null;
    const step = Math.max(1, Math.floor(pos.length / 400));
    const ring = [];
    for (let i = 0; i < pos.length; i += step) {
      const w = toWindow(scene, pos[i]);
      if (w && Number.isFinite(w.x)) ring.push({ x: w.x, y: w.y });
    }
    return ring.length >= 3 ? ring : null;
  } catch (e) { return null; }
}

// 1データソース分の declutter を実行する。複数 ds 間の衝突も見るため
// 共有の placed 配列を受け取る
// obstacle 地物の画面投影ジオメトリを placed(障害物)へ事前登録する。
// ポリゴンは投影リング(obstacleType で内部/境界のみ/全体を切替)、
// 線は投影折れ線+線幅、点はマーカーサイズの箱で登録する。
// いずれも bbox を併記してプリチェックに使う
export function registerLabelObstacles(scene, ds, placed = []) {
  const list = ds._qmlObstacles || [];
  if (!list.length) return;
  const t = Cesium.JulianDate.now();
  for (const ob of list) {
    const e = ob.entity;
    try {
      if (e.polygon) {
        const ring = polyScreenRing(scene, e, t);
        if (ring) {
          placed.push({ ...ptsBox(ring), entity: e, poly: ring, kind: ob.kind, half: ob.lineHalfPx });
        }
      } else if (e.polyline) {
        const pos = e.polyline.positions?.getValue?.(t);
        const pts = [];
        if (pos?.length) {
          for (const p of pos) {
            const w = toWindow(scene, p);
            if (w && Number.isFinite(w.x)) pts.push({ x: w.x, y: w.y });
          }
        }
        if (pts.length >= 2) {
          const half = Math.max(ob.sizePx || 6, 4) / 2;
          const bb = ptsBox(pts);
          placed.push({ x1: bb.x1 - half, y1: bb.y1 - half, x2: bb.x2 + half, y2: bb.y2 + half, entity: e, seg: pts, half });
        }
      } else {
        const pos = e.position?.getValue?.(t) || entityCentroid(e, t);
        const w = pos ? toWindow(scene, pos) : null;
        if (w && Number.isFinite(w.x)) {
          const half = Math.max(ob.sizePx || 10, 4) / 2;
          placed.push({ x1: w.x - half, y1: w.y - half, x2: w.x + half, y2: w.y + half, entity: e });
        }
      }
    } catch (_) {}
  }
}

export function declutterDataSourceLabels(scene, ds, placed = []) {
  const list = (ds._qmlLabels || []).filter(c => c.spec?.text);
  if (!list.length) return false;
  const t = Cesium.JulianDate.now();
  // requestRenderMode 下で描画を要求すべき「表示状態の変化」があったかを返す
  let changed = false;
  const dbg = window.__kascQmlDbg ? { shown: 0, hidden: 0, winNull: 0, reasons: [], placed0: placed.length, detail: [] } : null;
  if (dbg) (window.__kascQmlDbg.declutters ||= []).push(dbg);
  const setShow = (gfx, v) => {
    if (dbg) { if (v) dbg.shown++; else dbg.hidden++; }
    if (gfx.show?.getValue?.() === v) return;
    gfx.show = new Cesium.ConstantProperty(v);
    changed = true;
  };
  const sorted = [...list].sort((a, b) =>
    (b.spec.zIndex - a.spec.zIndex) || (b.spec.priority - a.spec.priority));
  for (const c of sorted) {
    const e = c.entity;
    // bufferNoFill 等は billboard ラベル(LabelGraphics では中空を表せない)。
    // _kascLabelGfx は再適用時に最新ラベル gfx を指す正本(古い残骸を拾わない)
    const gfx = e?._kascLabelGfx || e?.label || e?.billboard;
    if (!gfx) continue;
    const pos = e.position?.getValue?.(t);
    const win = pos ? toWindow(scene, pos) : null;
    // 投影不能(カメラ背後 or 古い描画行列)は「隠す」判定にしない。
    // requestRenderMode で描画が走る前の declutter が古い行列で全ラベルを
    // 一斉に非表示→次の描画で復活、というちらつきを防ぐ
    if (!win || !Number.isFinite(win.x)) { if (dbg) { dbg.winNull++; dbg.reasons.push(String(e.id).slice(0,8)+":winNull"); } continue; }
    const size = c.spec.sizePx || 12;
    const lines = String(c.spec.text).split("\n");
    // 全角は 1em・半角は 0.55em で幅を見積もる(日本語ラベル対応)
    const textW = (s) => [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 0xff ? 1.0 : 0.55), 0);
    const w = Math.max(...lines.map(l => textW(l))) * size + (c.spec.halo ? c.spec.halo.widthPx * 2 : 0) + 4;
    const h = lines.length * size * (c.spec.lineHeightFactor || 1) + 2;
    const pl = c.spec.placement || {};
    // fitInsidePolygon(地物内に全て収まるラベルのみ): 現在の画面縮尺で
    // ポリゴン投影BBoxにラベル矩形が収まらなければ隠す。overlap 許容とは独立の判定
    if (pl.fitInsidePolygon && e.polygon) {
      const pb = polyScreenBox(scene, e, t);
      const fits = pb && w <= (pb.x2 - pb.x1) && h <= (pb.y2 - pb.y1);
      if (!fits) {
        if (dbg) dbg.reasons.push(String(e.id).slice(0,8)+":noFit");
        setShow(gfx, false);
        continue;
      }
    }
    // minFeatureSize: 画面投影した地物サイズが閾値未満なら隠す(ズーム連動)
    if (c.spec.minFeatureSizePx && (e.polygon || e.polyline)) {
      const need = c.spec.minFeatureSizePx;
      let tooSmall = false;
      if (e.polygon) {
        const pb = polyScreenBox(scene, e, t);
        tooSmall = pb && Math.max(pb.x2 - pb.x1, pb.y2 - pb.y1) < need;
      } else {
        tooSmall = lineScreenLen(scene, e, t) < need;
      }
      if (tooSmall) { if (dbg) dbg.reasons.push(String(e.id).slice(0,8)+":tooSmall"); setShow(gfx, false); continue; }
    }
    if (c.spec.allowOverlap || c.spec.displayAll) { setShow(gfx, true); continue; }
    const quads = pl.predefinedOrder?.length ? orderToQuads(pl.predefinedOrder, pl.quad) : [pl.quad || { h: 0, v: 0 }];
    let done = false;
    for (const q of quads) {
      const dx = (pl.offsetXPx || 0) + (q.h || 0) * (pl.distPx || 0);
      const dy = -((pl.offsetYPx || 0) + (q.v || 0) * (pl.distPx || 0));
      const x1 = win.x + dx - (q.h < 0 ? w : q.h === 0 ? w / 2 : 0);
      const y1 = win.y + dy - (q.v > 0 ? h : q.v === 0 ? h / 2 : 0);
      const box = { x1, y1, x2: x1 + w, y2: y1 + h };
      // ラベル自身の地物が登録した障害物(b.entity === e)は衝突対象から除く。
      // 除かないと fitInPolygonOnly/centroidInside 系ラベルは常に自ポリゴンと
      // 衝突して全滅する(QGIS PAL と同じく自己障害物は適用しない)
      const hitBy = placed.find(b => b.entity !== e && obstacleHit(b, box));
      if (dbg) dbg.detail.push({ id: String(e.id).slice(0, 8), q: [q.h, q.v], box: [x1 | 0, y1 | 0, x2 | 0, y2 | 0], hit: hitBy ? (hitBy.entity ? String(hitBy.entity.id).slice(0, 8) : hitBy.poly ? "poly" : "box") : null });
      if (!hitBy) {
        placed.push(box);
        // 合成ラベル(マーカー+中空ラベル)は基準オフセット分を加える
        const bOff = gfx._kascBaseOffset;
        gfx.pixelOffset = new Cesium.ConstantProperty(
          new Cesium.Cartesian2(dx + (bOff?.x || 0), dy + (bOff?.y || 0)));
        changed = true;
        setShow(gfx, true);
        done = true;
        break;
      }
    }
    if (!done) { if (dbg) dbg.reasons.push(String(e.id).slice(0,8)+":collision"); setShow(gfx, false); }
  }
  return changed;
}

// データソース群に対して declutter を実行する(全 ds 横断で衝突判定)
export function declutterAllLabels(scene, sources) {
  const placed = [];
  // 先に全データソースの obstacleType 地物 bbox を障害物として登録する
  // (後続のラベル配置がこれを避ける。ラベル矩形の障害物は配置時に逐次登録)
  for (const ds of sources || []) {
    try { registerLabelObstacles(scene, ds, placed); } catch (e) { /* ignore */ }
  }
  let changed = false;
  for (const ds of sources || []) {
    try { changed = declutterDataSourceLabels(scene, ds, placed) || changed; } catch (e) { /* 1件失敗でも継続 */ }
  }
  // requestRenderMode: show/pixelOffset を変えても描画要求しないと表示へ反映されない
  if (changed) scene.requestRender?.();
}

let _declutterInstalled = false;
let _declutterTimer = null;
let _declutterLastRun = 0;
let _declutterScene = null;
let _declutterGetSources = null;
const _scheduleDeclutter = () => {
  if (_declutterTimer) return;
  _declutterTimer = setTimeout(() => {
    _declutterTimer = null;
    _declutterLastRun = Date.now();
    declutterAllLabels(_declutterScene, _declutterGetSources?.() || []);
  }, 150);
};
// スタイル再適用(レイヤ透過度・凡例切替・縮尺ルール変化等)の直後に
// declutter の再評価を要求する。未インストール時は何もしない
// (初回適用は呼び出し側の遅延実行でカバーされる)
export function requestLabelDeclutter() {
  if (!_declutterInstalled) return;
  _scheduleDeclutter();
}
// viewer.scene へカメラ停止時・描画後の自動 declutter を一度だけ仕掛ける
export function installLabelDeclutter(scene, getSources) {
  if (_declutterInstalled || !scene) return;
  _declutterInstalled = true;
  _declutterScene = scene;
  _declutterGetSources = getSources;
  try { scene.camera.moveEnd.addEventListener(_scheduleDeclutter); } catch (e) {}
  try { scene.camera.changed.addEventListener(() => {
    if (scene.camera.changed.percentageChanged > 0.5) _scheduleDeclutter();
  }); } catch (e) {}
  // moveEnd が来ない経路や初回描画の取りこぼしに備え、postRender で
  // 一定間隔(800ms)ごとの再判定も行う
  try { scene.postRender.addEventListener(() => {
    if (Date.now() - _declutterLastRun > 800) _scheduleDeclutter();
  }); } catch (e) {}
  // 初回は描画が安定してから
  setTimeout(_scheduleDeclutter, 800);
}

// ---------------------------------------------------------------------------
// MapUnit/MetersInMapUnits の距離連動スケーリング
// entity._qmlMapUnits = { billboard?: {meters,refPx}, label?: {meters,refPx} }
// を持つ地物の scale を、地物までのカメラ距離から得た 1px あたりメートルで
// 逐次更新する(scaleByDistance は線形補間で 1/d 近似が合わないため自前で計算)
// ---------------------------------------------------------------------------
let _muInstalled = false;
let _muTimer = null;
let _muLast = 0;
export function installMapUnitScaler(scene, getSources) {
  if (_muInstalled || !scene) return;
  _muInstalled = true;
  const update = () => {
    try {
      const canvas = scene.canvas;
      const frustum = scene.camera?.frustum;
      const camPos = scene.camera?.positionWC || scene.camera?.position;
      if (!(canvas && camPos && frustum && frustum.fovy !== undefined)) return;
      const h = canvas.clientHeight || canvas.height || 1;
      const tan = Math.tan(frustum.fovy / 2);
      if (!(tan > 0)) return;
      const t = Cesium.JulianDate.now();
      for (const ds of getSources?.() || []) {
        for (const e of ds.entities?.values || []) {
          const mu = e._qmlMapUnits;
          if (!mu) continue;
          const pos = e.position?.getValue?.(t);
          if (!pos) continue;
          const d = Math.max(Cesium.Cartesian3.distance(camPos, pos), 1);
          const mpp = (2 * d * tan) / h; // 地物地点の 1px あたりメートル
          if (!(mpp > 0)) continue;
          const setScale = (gfx, m) => {
            if (!gfx || !m) return;
            const scale = Math.min(Math.max((m.meters / mpp) / (m.refPx || 1), 0.01), 100);
            const cur = gfx.scale?.getValue?.() ?? 1;
            if (Math.abs(cur - scale) > 0.02) {
              gfx.scale = new Cesium.ConstantProperty(scale);
              scene.requestRender?.();
            }
          };
          setScale(e.billboard, mu.billboard);
          setScale(e.label, mu.label);
        }
      }
    } catch (_) { /* 距離更新失敗は次回へ */ }
  };
  const run = () => {
    if (_muTimer) return;
    _muTimer = setTimeout(() => { _muTimer = null; _muLast = Date.now(); update(); }, 150);
  };
  try { scene.camera.moveEnd.addEventListener(run); } catch (_) {}
  try { scene.camera.changed.addEventListener(run); } catch (_) {}
  try { scene.postRender.addEventListener(() => {
    if (Date.now() - _muLast > 800) run();
  }); } catch (_) {}
  setTimeout(update, 800);
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
