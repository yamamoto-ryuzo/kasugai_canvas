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
  // 前回適用時に生成した補助エンティティ(装飾線・積層線)を掃除する
  for (const e of ds._qmlAux || []) { try { ds.entities.remove(e); } catch (_) {} }
  ds._qmlAux = [];
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
  for (const entity of allEnts) {
    if (entity._kascAux) continue;
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
        // 複数ラインシンボル(ケーシング)と装飾線は補助エンティティで近似描画。
        // 補助描画の失敗で本体レンダリングを止めないよう try/catch で囲む
        try {
          if (spec.lines?.length > 1) {
            const pos = entity.polyline.positions?.getValue?.(t);
            if (pos?.length > 1) {
              for (let i = spec.lines.length - 2; i >= 0; i--) {
                const l = spec.lines[i];
                addAux({
                  polyline: {
                    positions: pos,
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
          // declutter 対象(重なり禁止系)は初期非表示にし、declutter が
          // 画面投影ベースで空き/収まりを判定したうえで復帰する
          // (初期に全表示してから消すちらつきを防ぐ)
          if (!(labelSpec.displayAll || labelSpec.allowOverlap)) {
            entity.label.show = new Cesium.ConstantProperty(false);
          }
          // ドロップシャドウ: 同色ラベルをオフセット重複で近似
          if (labelSpec.shadow) pendingShadows.push({ entity, labelSpec, oxPx, oyPx: oyPx + bump, hOrigin, vOrigin });
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

function toWindow(scene, pos) {
  const st = Cesium.SceneTransforms;
  if (st?.worldToWindowCoordinates) return st.worldToWindowCoordinates(scene, pos);
  if (st?.wgs84ToWindowCoordinates) return st.wgs84ToWindowCoordinates(scene, pos);
  return null;
}

const overlapBox = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

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
function samplePolylinePositions(entity, t, stepM) {
  const pos = entity.polyline?.positions?.getValue?.(t);
  if (!pos || pos.length < 2) return [];
  const out = [];
  let acc = 0;
  for (let i = 0; i + 1 < pos.length; i++) {
    const a = pos[i], b = pos[i + 1];
    const len = Cesium.Cartesian3.distance(a, b);
    if (!len) continue;
    const ca = Cesium.Cartographic.fromCartesian(a), cb = Cesium.Cartographic.fromCartesian(b);
    const ang = Math.atan2(cb.longitude - ca.longitude, cb.latitude - ca.latitude);
    while (acc < len) {
      const p = Cesium.Cartesian3.lerp(a, b, acc / len, new Cesium.Cartesian3());
      out.push({ position: p, angle: ang });
      acc += stepM;
    }
    acc -= len;
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

function renderLineDecor(entity, decor, t, { addAux, clamp, opacity }) {
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
    const pos = e.position?.getValue?.(t);
    const win = pos ? toWindow(scene, pos) : null;
    if (!win || !Number.isFinite(win.x)) { e.label.show = new Cesium.ConstantProperty(false); continue; }
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
        e.label.show = new Cesium.ConstantProperty(false);
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
      if (tooSmall) { e.label.show = new Cesium.ConstantProperty(false); continue; }
    }
    if (c.spec.allowOverlap || c.spec.displayAll) { e.label.show = new Cesium.ConstantProperty(true); continue; }
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
let _declutterLastRun = 0;
// viewer.scene へカメラ停止時・描画後の自動 declutter を一度だけ仕掛ける
export function installLabelDeclutter(scene, getSources) {
  if (_declutterInstalled || !scene) return;
  _declutterInstalled = true;
  const run = () => {
    if (_declutterTimer) return;
    _declutterTimer = setTimeout(() => {
      _declutterTimer = null;
      _declutterLastRun = Date.now();
      declutterAllLabels(scene, getSources?.() || []);
    }, 150);
  };
  try { scene.camera.moveEnd.addEventListener(run); } catch (e) {}
  try { scene.camera.changed.addEventListener(() => {
    if (scene.camera.changed.percentageChanged > 0.5) run();
  }); } catch (e) {}
  // moveEnd が来ない経路や初回描画の取りこぼしに備え、postRender で
  // 一定間隔(800ms)ごとの再判定も行う
  try { scene.postRender.addEventListener(() => {
    if (Date.now() - _declutterLastRun > 800) run();
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
