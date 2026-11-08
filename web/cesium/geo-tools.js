// 計測・標高断面・見通し判定・緯度経度グリッド・レイヤーエクスポート
// （Cesium フロント専用ツール群。静的配信のみで完結し、全てオンデマンド動作 —
// モード非アクティブ時・グリッド OFF 時は描画・イベントコストともゼロ）
//
// initGeoTools({ viewer, requestRender, sampleRouteTerrain, getOrderedLayerItems,
//   getLayerGeoJson, isVectorLayerItem, isQueryLayerItem }) → api
// api.handleClick(pos)/handleDoubleClick(pos)/handleMouseMove(pos) は app.js の
// クリックハンドラから呼び、処理したら true を返す（属性ピックを抑止するため）
import { t } from "../shared/i18n.js";
import { liveSendFeatures, liveIsActive } from "../shared/live.js";
import { notifyToolMode } from "../shared/tools-dock-ux.js";
import { exportFeatureCollection } from "../shared/export-formats.js";
import { collectFields } from "../shared/attr-stats.js";
import {
  selectFeatures, aggregateWithin as aggregateInRegion, bufferGeometry,
  circlePolygon, rectPolygon, normalizeRegion, geomBbox,
} from "../shared/spatial-ops.js";

const DEG = 180 / Math.PI;
const MIN_POINT_SPACING_M = 2; // ダブルクリック終了時に同一点が二重追加されるのを防ぐ間隔

export function initGeoTools({ viewer, requestRender, sampleRouteTerrain, getOrderedLayerItems, getLayerGeoJson, isVectorLayerItem, isQueryLayerItem, addDataLayer, fitBounds }) {
  const $ = s => document.querySelector(s);
  const toolDs = new Cesium.CustomDataSource("geo-tools");
  viewer.dataSources.add(toolDs);
  const gratDs = new Cesium.CustomDataSource("graticule");
  viewer.dataSources.add(gratDs);
  const selDs = new Cesium.CustomDataSource("spatial-select");
  viewer.dataSources.add(selDs);
  const annotDs = new Cesium.CustomDataSource("annotations");
  viewer.dataSources.add(annotDs);

  // ---------- 共通ユーティリティ ----------
  const cartoOf = c => Cesium.Cartographic.fromCartesian(c);
  const degOf = c => {
    const q = cartoOf(c);
    return { lat: q.latitude * DEG, lng: q.longitude * DEG, height: q.height };
  };
  const geodesic = (a, b) => new Cesium.EllipsoidGeodesic(cartoOf(a), cartoOf(b));
  const segDistance = (a, b) => geodesic(a, b).surfaceDistance;
  const fmtDist = m => !Number.isFinite(m) ? "-" : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  const fmtArea = m2 => !Number.isFinite(m2) ? "-" : m2 < 1e6 ? `${Math.round(m2).toLocaleString()} m²` : `${(m2 / 1e6).toFixed(2)} km²`;
  const num = (el, fallback) => {
    const v = Number(el && el.value);
    return Number.isFinite(v) ? v : fallback;
  };
  function pickGlobe(screenPos) {
    const ray = viewer.camera.getPickRay(screenPos);
    if (!ray) return null;
    try { return viewer.scene.globe.pick(ray, viewer.scene) || viewer.camera.pickEllipsoid(screenPos, viewer.scene.globe.ellipsoid); }
    catch (e) { return null; }
  }
  function labelEntity(position, text) {
    return toolDs.entities.add({
      position,
      label: {
        text,
        font: "12px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
  }
  function pointEntity(position, color = Cesium.Color.YELLOW, size = 9) {
    return toolDs.entities.add({
      position,
      point: {
        pixelSize: size,
        color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
  }
  function downloadBlob(text, filename, type) {
    const blob = new Blob([text], { type: type || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const fileSafe = s => String(s || "layer").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "layer";

  // ---------- 対話モード ----------
  // mode: null | "distance" | "area" | "bearing" | "profile" | "los"
  //       | "sel-rect" | "sel-poly" | "sel-circle"
  //       | "draw-point" | "draw-line" | "draw-poly" | "draw-label"
  let mode = null;
  let pts = [];        // 確定頂点 (Cartesian3)
  let hoverPt = null;  // カーソル位置のプレビュー点
  const dyn = [];      // 更新のたびに作り直す点・ラベル entity
  let lineEntity = null;
  let areaEntity = null;
  let rectPreviewEntity = null;
  let losRunning = false;
  let profileRunning = false;
  // 空間選択・集計・バッファ・作図の状態
  let regionGeom = null;       // 直近に確定した選択範囲（GeoJSON Polygon|MultiPolygon）
  let regionSourceGeom = null; // バッファ対象の元ジオメトリ
  let selFeatures = [];        // 直近の選択結果 Feature[]
  let selLayerLabel = "";
  const annotations = [];      // 作図確定分 [{name, geometry, entity}]
  const SEL_COLOR = Cesium.Color.fromCssColorString("#ff00ff");
  const REGION_COLOR = Cesium.Color.fromCssColorString("#00bfff");
  const DRAW_COLOR = Cesium.Color.fromCssColorString("#ff9100");

  const resultEl = () => $("#tools-measure-result");
  const losResultEl = () => $("#tools-los-result");
  const selResultEl = () => $("#tools-sel-result");
  const aggResultEl = () => $("#tools-agg-result");
  const currentPositions = () => (hoverPt ? [...pts, hoverPt] : pts.slice());

  function updateModeButtons() {
    const map = {
      distance: "#tool-m-distance", area: "#tool-m-area", bearing: "#tool-m-bearing",
      profile: "#tool-profile-draw", los: "#tool-los",
      "sel-rect": "#tool-sel-rect", "sel-poly": "#tool-sel-poly", "sel-circle": "#tool-sel-circle",
      "draw-point": "#tool-draw-point", "draw-line": "#tool-draw-line", "draw-poly": "#tool-draw-poly", "draw-label": "#tool-draw-label",
    };
    for (const [m, sel] of Object.entries(map)) {
      const btn = $(sel);
      if (btn) btn.classList.toggle("tool-on", mode === m);
    }
    viewer.canvas.style.cursor = mode ? "crosshair" : "";
    // ツールドック: 対話モード中はドロップダウンを畳み1行チップへ縮退する
    notifyToolMode(mode);
  }

  function clearOverlay() {
    for (const e of dyn) toolDs.entities.remove(e);
    dyn.length = 0;
    if (lineEntity) { toolDs.entities.remove(lineEntity); lineEntity = null; }
    if (areaEntity) { toolDs.entities.remove(areaEntity); areaEntity = null; }
    if (rectPreviewEntity) { toolDs.entities.remove(rectPreviewEntity); rectPreviewEntity = null; }
  }

  function clearAll() {
    mode = null;
    pts = [];
    hoverPt = null;
    clearOverlay();
    toolDs.entities.removeAll();
    profileHoverEntity = null;
    if (resultEl()) resultEl().textContent = "";
    if (losResultEl()) losResultEl().textContent = "";
    const box = $("#profile-box");
    if (box) box.hidden = true;
    updateModeButtons();
    requestRender();
  }

  function setMode(next) {
    // 新しい測定を始めるときは前の結果を消す
    clearAll();
    mode = next;
    if (next && resultEl() && !String(next).startsWith("sel-") && !String(next).startsWith("draw-")) {
      resultEl().textContent = t(next === "los" ? "tools.losHint" : "tools.measureHint");
    }
    updateModeButtons();
    updateSelHint();
  }

  // 測地線多角形の面積: 重心を原点とする接平面へ投影してからシューレース。
  // 実務サイズ(市区町村程度まで)なら十分な精度。地球全体級の巨大ポリゴンは誤差が出る
  function polygonArea(cartesians) {
    if (cartesians.length < 3) return 0;
    try {
      const plane = Cesium.EllipsoidTangentPlane.fromPoints(cartesians, Cesium.Ellipsoid.WGS84);
      const planePts = plane.projectPointsOntoPlane(cartesians, []);
      let s = 0;
      for (let i = 0; i < planePts.length; i++) {
        const p = planePts[i];
        const q = planePts[(i + 1) % planePts.length];
        s += p.x * q.y - q.x * p.y;
      }
      return Math.abs(s / 2);
    } catch (e) { return NaN; }
  }

  function midPoint(a, b) {
    const g = geodesic(a, b);
    const mid = g.interpolateUsingFraction(0.5);
    return Cesium.Cartesian3.fromRadians(mid.longitude, mid.latitude, Math.max(cartoOf(a).height, cartoOf(b).height));
  }

  function updateReadout() {
    const el = resultEl();
    if (!el) return;
    const positions = currentPositions();
    if (mode === "distance") {
      let total = 0;
      for (let i = 1; i < positions.length; i++) total += segDistance(positions[i - 1], positions[i]);
      el.textContent = t("tools.distanceTotal", { value: fmtDist(total) }) + `（${t("tools.points", { count: pts.length })}）`;
    } else if (mode === "area") {
      if (positions.length >= 3) {
        let perim = segDistance(positions[positions.length - 1], positions[0]);
        for (let i = 1; i < positions.length; i++) perim += segDistance(positions[i - 1], positions[i]);
        el.textContent = t("tools.areaResult", { area: fmtArea(polygonArea(positions)), perimeter: fmtDist(perim) });
      } else {
        el.textContent = t("tools.measureHint");
      }
    } else if (mode === "bearing") {
      if (pts.length === 1 && hoverPt) {
        const g = geodesic(pts[0], hoverPt);
        el.textContent = t("tools.bearingResult", {
          bearing: (g.startHeading * DEG).toFixed(1),
          back: (g.endHeading * DEG).toFixed(1),
          dist: fmtDist(g.surfaceDistance),
        });
      } else if (!pts.length) {
        el.textContent = t("tools.bearingHint");
      }
    } else if (mode === "profile") {
      el.textContent = profileRunning ? t("tools.profileRunning") : t("tools.profileHint") + `（${t("tools.points", { count: pts.length })}）`;
    } else if (mode === "los") {
      const lel = losResultEl() || el;
      if (losRunning) lel.textContent = t("tools.profileRunning");
      else lel.textContent = t(pts.length ? "tools.losTargetStep" : "tools.losHint");
    }
  }

  // 選択モードのヒント（sel-result 側に出す）
  function updateSelHint() {
    const el = selResultEl();
    if (!el || !mode) return;
    if (mode === "sel-rect") el.textContent = t(pts.length ? "tools.selRectSecond" : "tools.selRectHint");
    else if (mode === "sel-poly") el.textContent = t("tools.selPolyHint");
    else if (mode === "sel-circle") el.textContent = t("tools.selCircleHint");
  }

  function updateOverlay() {
    for (const e of dyn) toolDs.entities.remove(e);
    dyn.length = 0;
    const positions = currentPositions();
    if (!lineEntity) {
      lineEntity = toolDs.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(currentPositions, false),
          show: new Cesium.CallbackProperty(() => currentPositions().length >= 2, false),
          width: 3,
          material: mode === "los" ? Cesium.Color.ORANGE : Cesium.Color.YELLOW,
          clampToGround: true,
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
    }
    if ((mode === "area" || mode === "sel-poly" || mode === "draw-poly") && !areaEntity) {
      const isPick = mode === "sel-poly" || mode === "draw-poly";
      areaEntity = toolDs.entities.add({
        polygon: {
          hierarchy: new Cesium.CallbackProperty(() => new Cesium.PolygonHierarchy(currentPositions()), false),
          show: new Cesium.CallbackProperty(() => currentPositions().length >= 3, false),
          material: (isPick ? DRAW_COLOR : Cesium.Color.YELLOW).withAlpha(0.25),
        },
      });
    }
    if (mode === "sel-rect" && !rectPreviewEntity) {
      rectPreviewEntity = toolDs.entities.add({
        polygon: {
          hierarchy: new Cesium.CallbackProperty(() => {
            const positions = currentPositions();
            if (positions.length < 2) return new Cesium.PolygonHierarchy([]);
            const a = cartoOf(positions[0]), b = cartoOf(positions[positions.length - 1]);
            const w = Math.min(a.longitude, b.longitude), e = Math.max(a.longitude, b.longitude);
            const s = Math.min(a.latitude, b.latitude), n = Math.max(a.latitude, b.latitude);
            return new Cesium.PolygonHierarchy([
              Cesium.Cartesian3.fromRadians(w, s), Cesium.Cartesian3.fromRadians(e, s),
              Cesium.Cartesian3.fromRadians(e, n), Cesium.Cartesian3.fromRadians(w, n),
            ]);
          }, false),
          show: new Cesium.CallbackProperty(() => currentPositions().length >= 2, false),
          material: DRAW_COLOR.withAlpha(0.25),
        },
      });
    }
    for (const p of pts) dyn.push(pointEntity(p));
    // 区間ラベル（距離・面積モードのみ）
    if (mode === "distance" || mode === "area") {
      for (let i = 1; i < positions.length; i++) {
        const d = segDistance(positions[i - 1], positions[i]);
        if (d >= 1) dyn.push(labelEntity(midPoint(positions[i - 1], positions[i]), fmtDist(d)));
      }
      if (mode === "area" && positions.length >= 3) {
        dyn.push(labelEntity(midPoint(positions[positions.length - 1], positions[0]), fmtDist(segDistance(positions[positions.length - 1], positions[0]))));
      }
    }
    updateReadout();
    requestRender();
  }

  function addPoint(screenPos) {
    const c = pickGlobe(screenPos);
    if (!c) return;
    if (pts.length && Cesium.Cartesian3.distance(pts[pts.length - 1], c) < MIN_POINT_SPACING_M) return;
    pts.push(c);
    updateOverlay();
  }

  // 距離・面積は測定結果を残したままモードだけ終了する
  function finishInteractive() {
    mode = null;
    hoverPt = null;
    updateModeButtons();
    requestRender();
  }

  // ---------- ライン上の地形サンプリング（断面・LOS 共用） ----------
  // cartes: Cartesian3 の折れ線 → 距離比例で n 点に細分化して {lat,lng} 列を返す
  function densifyLngLats(cartes, n) {
    const cartos = cartes.map(cartoOf);
    const segs = [];
    let total = 0;
    for (let i = 1; i < cartos.length; i++) {
      const g = new Cesium.EllipsoidGeodesic(cartos[i - 1], cartos[i]);
      segs.push(g);
      total += g.surfaceDistance;
    }
    const out = [{ lat: cartos[0].latitude * DEG, lng: cartos[0].longitude * DEG, dist: 0 }];
    let acc = 0;
    for (const g of segs) {
      const L = g.surfaceDistance;
      const steps = Math.max(1, Math.round((L / Math.max(total, 1e-9)) * (n - 1)));
      for (let s = 1; s <= steps; s++) {
        const c = g.interpolateUsingFraction(s / steps);
        acc += L / steps;
        out.push({ lat: c.latitude * DEG, lng: c.longitude * DEG, dist: acc });
      }
    }
    return { points: out, total };
  }

  // 地形プロバイダから標高列を取得。全て取れない場合は地理院標高API（日本域）へフォールバック
  async function sampleTerrainLine(lnglats, totalMeters = 0) {
    try {
      const hs = await sampleRouteTerrain(lnglats.map(p => ({ longitude: p.lng, latitude: p.lat })), totalMeters);
      if (hs && hs.some(h => Number.isFinite(h))) return hs;
    } catch (e) { /* フォールバックへ */ }
    const out = new Array(lnglats.length).fill(null);
    const CHUNK = 8;
    for (let i = 0; i < lnglats.length; i += CHUNK) {
      await Promise.all(lnglats.slice(i, i + CHUNK).map(async (p, k) => {
        try {
          const r = await fetch(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${p.lng}&lat=${p.lat}&outtype=JSON`, { signal: AbortSignal.timeout(15000) });
          const j = await r.json();
          if (Number.isFinite(j && j.elevation)) out[i + k] = j.elevation;
        } catch (e) { /* 個別点の失敗は null のまま */ }
      }));
    }
    return out;
  }

  // ---------- 標高断面 ----------
  let profileSamples = null; // [{dist,elev,lat,lng}]
  let profileHoverEntity = null;

  async function runProfile(cartes) {
    if (cartes.length < 2) return null;
    profileRunning = true;
    updateReadout();
    const n = Math.min(Math.max(Math.round(num($("#tool-profile-samples"), 100)), 10), 500);
    const { points, total } = densifyLngLats(cartes, n);
    const hs = await sampleTerrainLine(points, total);
    profileRunning = false;
    const samples = points.map((p, i) => ({ dist: p.dist, elev: hs[i], lat: p.lat, lng: p.lng }))
      .filter(s => Number.isFinite(s.elev));
    if (samples.length < 2) {
      if (resultEl()) resultEl().textContent = t("tools.profileFail");
      return null;
    }
    profileSamples = samples;
    drawProfileChart(samples);
    const min = Math.min(...samples.map(s => s.elev));
    const max = Math.max(...samples.map(s => s.elev));
    let asc = 0, desc = 0;
    for (let i = 1; i < samples.length; i++) {
      const d = samples[i].elev - samples[i - 1].elev;
      if (d > 0) asc += d; else desc -= d;
    }
    const statsEl = $("#profile-stats");
    if (statsEl) statsEl.textContent = t("tools.profileStats", {
      dist: fmtDist(total), max: max.toFixed(1), min: min.toFixed(1),
      asc: asc.toFixed(0), desc: desc.toFixed(0),
    });
    const box = $("#profile-box");
    if (box) box.hidden = false;
    if (resultEl()) resultEl().textContent = t("tools.distanceTotal", { value: fmtDist(total) });
    requestRender();
    return { points: samples.map(s => ({ distance: s.dist, elevation: s.elev })), totalMeters: total, min, max, ascent: asc, descent: desc };
  }

  function drawProfileChart(samples) {
    const canvas = $("#profile-chart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const padL = 42, padR = 8, padT = 8, padB = 20;
    const dists = samples.map(s => s.dist);
    const elevs = samples.map(s => s.elev);
    const dMax = Math.max(...dists, 1);
    let eMin = Math.min(...elevs), eMax = Math.max(...elevs);
    if (eMax - eMin < 1) { eMax += 0.5; eMin -= 0.5; }
    const X = d => padL + (W - padL - padR) * (d / dMax);
    const Y = e => padT + (H - padT - padB) * (1 - (e - eMin) / (eMax - eMin));
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#f8fbfb";
    ctx.fillRect(0, 0, W, H);
    // グリッド（標高4分割）
    ctx.strokeStyle = "#d5e2e6";
    ctx.fillStyle = "#52636d";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    for (let i = 0; i <= 4; i++) {
      const e = eMin + (eMax - eMin) * i / 4;
      const y = Y(e);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(e.toFixed(0), 4, y + 3);
    }
    // 塗りつぶし＋線
    ctx.beginPath();
    ctx.moveTo(X(dists[0]), Y(elevs[0]));
    for (let i = 1; i < samples.length; i++) ctx.lineTo(X(dists[i]), Y(elevs[i]));
    ctx.lineTo(X(dMax), Y(eMin)); ctx.lineTo(X(0), Y(eMin)); ctx.closePath();
    ctx.fillStyle = "rgba(49,86,79,.25)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(X(dists[0]), Y(elevs[0]));
    for (let i = 1; i < samples.length; i++) ctx.lineTo(X(dists[i]), Y(elevs[i]));
    ctx.strokeStyle = "#31564f";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 距離軸
    ctx.fillStyle = "#52636d";
    ctx.textAlign = "center";
    ctx.fillText("0", X(0), H - 6);
    ctx.fillText(fmtDist(dMax), X(dMax), H - 6);
    canvas._profile = { samples, X, Y, padL, padR, padT, eMin, eMax, dMax };
  }

  function onChartHover(event) {
    const canvas = $("#profile-chart");
    const meta = canvas && canvas._profile;
    if (!meta) return;
    const rect = canvas.getBoundingClientRect();
    const px = (event.clientX - rect.left) * (canvas.width / rect.width);
    const { samples, X, Y, padL, padR, dMax } = meta;
    const dist = Math.min(Math.max((px - padL) / Math.max(1, canvas.width - padL - padR), 0), 1) * dMax;
    let best = samples[0];
    for (const s of samples) if (Math.abs(s.dist - dist) < Math.abs(best.dist - dist)) best = s;
    if (profileHoverEntity) toolDs.entities.remove(profileHoverEntity);
    profileHoverEntity = toolDs.entities.add({
      position: Cesium.Cartesian3.fromDegrees(best.lng, best.lat, best.elev),
      point: { pixelSize: 11, color: Cesium.Color.DEEPSKYBLUE, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
    const statsEl = $("#profile-stats");
    if (statsEl && best) {
      statsEl.dataset.baseText = statsEl.dataset.baseText ?? statsEl.textContent;
      statsEl.textContent = `${statsEl.dataset.baseText}　→ ${fmtDist(best.dist)}: ${best.elev.toFixed(1)} m`;
    }
    requestRender();
  }
  $("#profile-chart")?.addEventListener("mousemove", onChartHover);
  $("#profile-chart")?.addEventListener("mouseleave", () => {
    if (profileHoverEntity) { toolDs.entities.remove(profileHoverEntity); profileHoverEntity = null; requestRender(); }
    const statsEl = $("#profile-stats");
    if (statsEl && statsEl.dataset.baseText) statsEl.textContent = statsEl.dataset.baseText;
  });

  // ---------- 見通し判定 ----------
  async function runLos(a, b, observerH, targetH) {
    const N = 160;
    const { points, total } = densifyLngLats([a, b], N);
    const terr = await sampleTerrainLine(points, total);
    const groundA = Number.isFinite(terr[0]) ? terr[0] : cartoOf(a).height;
    const groundB = Number.isFinite(terr[terr.length - 1]) ? terr[terr.length - 1] : cartoOf(b).height;
    const A = Cesium.Cartesian3.fromDegrees(points[0].lng, points[0].lat, groundA + observerH);
    const B = Cesium.Cartesian3.fromDegrees(points[N - 1].lng, points[N - 1].lat, groundB + targetH);
    let blocked = -1;
    const scratch = new Cesium.Cartesian3();
    for (let i = 1; i < N - 1; i++) {
      if (!Number.isFinite(terr[i])) continue;
      const f = i / (N - 1);
      Cesium.Cartesian3.lerp(A, B, f, scratch);
      const hs = Cesium.Cartographic.fromCartesian(scratch).height;
      if (terr[i] > hs) { blocked = i; break; }
    }
    return { points, terr, total, blocked, A, B };
  }

  function drawLosResult(res, observerH, targetH) {
    const { points, total, blocked, A, B } = res;
    const groundLine = [A, B];
    dyn.push(pointEntity(A, Cesium.Color.DEEPSKYBLUE, 10));
    dyn.push(pointEntity(B, Cesium.Color.ORANGE, 10));
    if (blocked < 0) {
      dyn.push(toolDs.entities.add({
        polyline: { positions: groundLine, width: 3, material: Cesium.Color.LIMEGREEN, arcType: Cesium.ArcType.NONE },
      }));
    } else {
      const bp = points[blocked];
      const bh = res.terr[blocked];
      const bpos = Cesium.Cartesian3.fromDegrees(bp.lng, bp.lat, bh);
      // 視線は遮蔽点手前まで緑、その先は赤
      const cut = (blocked / (points.length - 1));
      const mid = Cesium.Cartesian3.lerp(A, B, cut, new Cesium.Cartesian3());
      dyn.push(toolDs.entities.add({ polyline: { positions: [A, mid], width: 3, material: Cesium.Color.LIMEGREEN, arcType: Cesium.ArcType.NONE } }));
      dyn.push(toolDs.entities.add({ polyline: { positions: [mid, B], width: 3, material: Cesium.Color.RED, arcType: Cesium.ArcType.NONE } }));
      dyn.push(pointEntity(bpos, Cesium.Color.RED, 11));
      dyn.push(labelEntity(bpos, t("tools.losBlockedShort")));
    }
    return total;
  }

  async function executeLos() {
    losRunning = true;
    updateReadout();
    try {
      const hA = num($("#los-observer-h"), 0);
      const hB = num($("#los-target-h"), 0);
      const res = await runLos(pts[0], pts[1], hA, hB);
      drawLosResult(res, hA, hB);
      const total = res.total;
      if (losResultEl()) {
        losResultEl().textContent = res.blocked < 0
          ? t("tools.losVisible", { dist: fmtDist(total) })
          : t("tools.losBlocked", { dist: fmtDist(res.points[res.blocked].dist) });
      }
      if (resultEl()) resultEl().textContent = "";
    } finally {
      losRunning = false;
      mode = null;
      updateModeButtons();
      requestRender();
    }
  }

  // ---------- 空間選択・集計・バッファ ----------
  const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toCartesianArr = coords => coords.map(c => Cesium.Cartesian3.fromDegrees(c[0], c[1]));

  // GeoJSON geometry → ハイライト/作図用エンティティ（ds へ追加）
  function addGeomTo(ds, geom, { color = Cesium.Color.CYAN, text = null } = {}) {
    const point = (c, label) => ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(c[0], c[1]),
      point: { pixelSize: 9, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
      ...(label ? { label: { text: label, font: "12px sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND } } : {}),
    });
    const line = coords => ds.entities.add({
      polyline: { positions: toCartesianArr(coords), width: 3, material: color, clampToGround: true, arcType: Cesium.ArcType.GEODESIC },
    });
    const poly = coords => ds.entities.add({
      polygon: { hierarchy: new Cesium.PolygonHierarchy(toCartesianArr(coords)), material: color.withAlpha(0.2) },
      polyline: { positions: toCartesianArr([...coords, coords[0]]), width: 2, material: color, clampToGround: true, arcType: Cesium.ArcType.GEODESIC },
    });
    switch (geom?.type) {
      case "Point": return [point(geom.coordinates, text)];
      case "MultiPoint": return geom.coordinates.map(c => point(c));
      case "LineString": return [line(geom.coordinates)];
      case "MultiLineString": return geom.coordinates.map(line);
      case "Polygon": return geom.coordinates.length ? [poly(geom.coordinates[0])] : [];
      case "MultiPolygon": return geom.coordinates.flatMap(c => c.length ? [poly(c[0])] : []);
      case "GeometryCollection": return (geom.geometries || []).flatMap(g => addGeomTo(ds, g, { color, text }));
      default: return [];
    }
  }

  // 範囲・選択ハイライトの再描画（selDs に集約）
  function redrawSelDs() {
    selDs.entities.removeAll();
    if (regionGeom) addGeomTo(selDs, regionGeom, { color: REGION_COLOR });
    for (const f of selFeatures.slice(0, 500)) addGeomTo(selDs, f.geometry, { color: SEL_COLOR });
    requestRender();
  }

  function setRegion(geom, sourceGeom) {
    regionGeom = geom;
    regionSourceGeom = sourceGeom || geom;
    mode = null;
    pts = [];
    hoverPt = null;
    clearOverlay();
    updateModeButtons();
    redrawSelDs();
    if (geom && selResultEl()) selResultEl().textContent = t("tools.selRegionSet");
    refreshAggFieldOptions();
  }

  function clearSelection() {
    regionGeom = null;
    regionSourceGeom = null;
    selFeatures = [];
    selLayerLabel = "";
    selDs.entities.removeAll();
    if (selResultEl()) selResultEl().textContent = "";
    if (aggResultEl()) aggResultEl().textContent = "";
    requestRender();
  }

  function vectorLayers() {
    return (getOrderedLayerItems() || []).filter(item => isVectorLayerItem && isVectorLayerItem(item));
  }

  function refreshSelLayerOptions() {
    const sel = $("#tool-sel-layer");
    if (!sel) return;
    const cur = sel.value;
    sel.replaceChildren();
    const all = document.createElement("option");
    all.value = "__all__";
    all.textContent = t("tools.selLayerAll");
    sel.append(all);
    for (const item of vectorLayers()) {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.title || item.id;
      sel.append(o);
    }
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  }

  function targetLayerItems() {
    const sel = $("#tool-sel-layer");
    const items = vectorLayers();
    if (!sel || sel.value === "__all__" || !sel.value) return items;
    return items.filter(i => i.id === sel.value || i.title === sel.value);
  }

  function mergedTargetFc() {
    const features = [];
    for (const item of targetLayerItems()) {
      const gj = getLayerGeoJson && getLayerGeoJson(item.id);
      if (gj?.features) features.push(...gj.features);
    }
    return { type: "FeatureCollection", features };
  }

  function refreshAggFieldOptions() {
    const group = $("#tool-agg-group"), value = $("#tool-agg-value");
    if (!group || !value) return;
    const { all, numeric } = collectFields(mergedTargetFc().features);
    const fill = (el, fields, phKey) => {
      const cur = el.value;
      el.replaceChildren();
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = t(phKey);
      el.append(ph);
      for (const f of fields) { const o = document.createElement("option"); o.value = f; o.textContent = f; el.append(o); }
      if (cur && fields.includes(cur)) el.value = cur;
    };
    fill(group, all, "tools.aggGroupPh");
    fill(value, numeric, "tools.aggValuePh");
  }

  function doSpatialSelect() {
    if (!regionGeom) { if (selResultEl()) selResultEl().textContent = t("tools.selNoRegion"); return null; }
    const feats = selectFeatures(mergedTargetFc(), regionGeom);
    selFeatures = feats;
    selLayerLabel = targetLayerItems().map(i => i.title || i.id).join(", ");
    redrawSelDs();
    refreshAggFieldOptions();
    const el = selResultEl();
    if (el) {
      if (!feats.length) el.textContent = t("tools.selNoFeatures");
      else {
        const names = feats.slice(0, 12).map(f => f.properties?.name ?? f.properties?.Name ?? f.properties?.名称 ?? f.properties?.id ?? "").filter(v => v !== "");
        el.textContent = t("tools.selResult", { count: feats.length, layer: selLayerLabel })
          + (names.length ? ` — ${names.join(", ")}${feats.length > names.length ? "…" : ""}` : "");
      }
    }
    return feats;
  }

  function doAggregate() {
    if (!regionGeom) { if (aggResultEl()) aggResultEl().textContent = t("tools.selNoRegion"); return null; }
    const groupField = $("#tool-agg-group")?.value || null;
    const valueField = $("#tool-agg-value")?.value || null;
    const { rows } = aggregateInRegion(mergedTargetFc(), regionGeom, { groupField, valueField });
    const el = aggResultEl();
    if (el) {
      if (!rows.length || (rows.length === 1 && !rows[0].count)) {
        el.textContent = t("tools.selNoFeatures");
      } else {
        const fmtN = v => v == null ? "-" : (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100).toLocaleString();
        const head = `<tr><th>${escapeHtml(groupField || t("tools.aggAll"))}</th><th>count</th>${valueField ? "<th>sum</th><th>avg</th><th>min</th><th>max</th>" : ""}</tr>`;
        el.innerHTML = `<table>${head}${rows.slice(0, 50).map(r =>
          `<tr><td>${escapeHtml(r.key ?? "")}</td><td>${r.count}</td>${valueField ? `<td>${fmtN(r.sum)}</td><td>${fmtN(r.avg)}</td><td>${fmtN(r.min)}</td><td>${fmtN(r.max)}</td>` : ""}</tr>`).join("")}</table>`
          + (rows.length > 50 ? `<div class="hint">${t("tools.aggTruncated", { count: rows.length })}</div>` : "");
      }
    }
    return rows;
  }

  async function doBuffer() {
    const radius = num($("#tool-buf-radius"), 0);
    if (!radius) { if (selResultEl()) selResultEl().textContent = t("tools.bufNoRadius"); return null; }
    // バッファ対象: 直近の選択地物（あれば各々・上限200件）→ なければ描画範囲
    const targets = selFeatures.length
      ? selFeatures.map(f => f.geometry).filter(Boolean).slice(0, 200)
      : (regionSourceGeom ? [regionSourceGeom] : []);
    if (!targets.length) { if (selResultEl()) selResultEl().textContent = t("tools.bufNoTarget"); return null; }
    if (selResultEl()) selResultEl().textContent = t("tools.profileRunning");
    try {
      const geoms = [];
      for (const g of targets) {
        const bg = await bufferGeometry(g, radius);
        if (bg) geoms.push(bg);
      }
      if (!geoms.length) throw new Error("empty");
      const title = `buffer ${radius}m`;
      const fc = {
        type: "FeatureCollection",
        features: geoms.map(g => ({ type: "Feature", properties: { name: title }, geometry: g })),
      };
      const added = addDataLayer && await addDataLayer(title, fc);
      // 生成したバッファは新しい選択範囲としても使えるよう保持
      regionGeom = geoms.length === 1 ? geoms[0]
        : { type: "MultiPolygon", coordinates: geoms.flatMap(g => g.type === "Polygon" ? [g.coordinates] : g.coordinates) };
      regionSourceGeom = regionGeom;
      selFeatures = [];
      redrawSelDs();
      if (selResultEl()) selResultEl().textContent = t("tools.bufDone", { count: geoms.length });
      return { ok: !!added, title };
    } catch (e) {
      console.warn("buffer failed", e);
      if (selResultEl()) selResultEl().textContent = t("tools.bufFail");
      return null;
    }
  }

  // ---------- 作図・注記 ----------
  function addAnnotation(geometry) {
    const name = ($("#tool-draw-name")?.value || "").trim() || `${annotations.length + 1}`;
    const entity = { name, geometry };
    entity.entity = addGeomTo(annotDs, geometry, { color: DRAW_COLOR, text: geometry.type === "Point" ? name : null })[0] || null;
    annotations.push(entity);
    renderDrawList();
    requestRender();
  }

  function removeAnnotation(i) {
    const a = annotations[i];
    if (a?.entity) annotDs.entities.remove(a.entity);
    annotations.splice(i, 1);
    renderDrawList();
    requestRender();
  }

  function renderDrawList() {
    const ul = $("#tools-draw-list");
    if (!ul) return;
    ul.replaceChildren();
    annotations.forEach((a, i) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "draw-name";
      span.textContent = `${a.name}（${a.geometry.type.replace(/^Multi/, "M")}）`;
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "×";
      del.addEventListener("click", () => removeAnnotation(i));
      li.append(span, del);
      ul.append(li);
    });
  }

  const annotationsFc = () => ({
    type: "FeatureCollection",
    features: annotations.map(a => ({ type: "Feature", properties: { name: a.name }, geometry: a.geometry })),
  });

  // ---------- 入力ハンドラ（app.js のハンドラへ接続） ----------
  function handleClick(screenPos) {
    if (!mode) return false;
    // 円選択は中心1クリックで確定（半径はパネル入力）
    if (mode === "sel-circle") {
      const c = pickGlobe(screenPos);
      if (c) {
        const d = degOf(c);
        const r = Math.max(1, num($("#tool-sel-radius"), 500));
        setRegion(circlePolygon({ lng: d.lng, lat: d.lat }, r), { type: "Point", coordinates: [d.lng, d.lat] });
      }
      return true;
    }
    addPoint(screenPos);
    updateSelHint();
    // 矩形選択は2点確定
    if (mode === "sel-rect" && pts.length >= 2) {
      const a = degOf(pts[0]), b = degOf(pts[1]);
      setRegion(rectPolygon(Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)));
      return true;
    }
    // ポイント作図・注記はクリックごとに確定（連続配置できるようモード維持）
    if ((mode === "draw-point" || mode === "draw-label") && pts.length) {
      const d = degOf(pts[pts.length - 1]);
      addAnnotation({ type: "Point", coordinates: [d.lng, d.lat] });
      pts = [];
      hoverPt = null;
      updateOverlay();
      return true;
    }
    if (mode === "los" && pts.length >= 2) void executeLos();
    else if (mode === "bearing" && pts.length >= 2) {
      // 方位は2点確定で結果を残す
      const g = geodesic(pts[0], pts[1]);
      const mid = midPoint(pts[0], pts[1]);
      dyn.push(labelEntity(mid, `${(g.startHeading * DEG).toFixed(1)}°`));
      if (resultEl()) {
        resultEl().textContent = t("tools.bearingResult", {
          bearing: (g.startHeading * DEG).toFixed(1),
          back: (g.endHeading * DEG).toFixed(1),
          dist: fmtDist(g.surfaceDistance),
        });
      }
      mode = null;
      updateModeButtons();
    }
    requestRender();
    return true;
  }

  function handleDoubleClick() {
    if (!mode) return false;
    if (mode === "sel-poly") {
      if (pts.length >= 3) {
        const ring = pts.map(c => { const d = degOf(c); return [d.lng, d.lat]; });
        ring.push([...ring[0]]);
        setRegion({ type: "Polygon", coordinates: [ring] });
      }
      return true;
    }
    if (mode === "draw-line") {
      if (pts.length >= 2) {
        addAnnotation({ type: "LineString", coordinates: pts.map(c => { const d = degOf(c); return [d.lng, d.lat]; }) });
        pts = [];
        hoverPt = null;
        updateOverlay();
      }
      return true;
    }
    if (mode === "draw-poly") {
      if (pts.length >= 3) {
        const ring = pts.map(c => { const d = degOf(c); return [d.lng, d.lat]; });
        ring.push([...ring[0]]);
        addAnnotation({ type: "Polygon", coordinates: [ring] });
        pts = [];
        hoverPt = null;
        updateOverlay();
      }
      return true;
    }
    if (mode === "distance" || mode === "bearing") {
      if (pts.length >= 2) finishInteractive();
      return true;
    }
    if (mode === "area") {
      if (pts.length >= 3) finishInteractive();
      return true;
    }
    if (mode === "profile") {
      if (pts.length >= 2) {
        const cartes = pts.slice();
        mode = null;
        updateModeButtons();
        void runProfile(cartes);
      }
      return true;
    }
    if (mode === "los") {
      if (pts.length >= 2) void executeLos();
      return true;
    }
    return true;
  }

  function handleMouseMove(screenPos) {
    if (!mode || !pts.length) return false;
    const c = pickGlobe(screenPos);
    const changed = (c === null) !== (hoverPt === null)
      || (c && hoverPt && Cesium.Cartesian3.distance(c, hoverPt) > 0.5);
    if (!changed) return true;
    hoverPt = c;
    updateOverlay();
    return true;
  }

  // Esc でモード解除
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && mode) finishInteractive();
  });

  // ---------- 緯度経度グリッド ----------
  let graticuleOn = false;
  let gratTimer = null;

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    for (const s of [1, 2, 5]) if (raw <= s * p) return s * p;
    return 10 * p;
  }

  function buildGraticule() {
    gratDs.entities.removeAll();
    if (!graticuleOn) { requestRender(); return; }
    let rect;
    try { rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid); } catch (e) { rect = null; }
    if (!rect) return;
    let west = rect.west * DEG, east = rect.east * DEG;
    const south = Math.max(-85, rect.south * DEG), north = Math.min(85, rect.north * DEG);
    if (east < west) east += 360; // 日付変更線またぎ
    const lonSpan = east - west, latSpan = north - south;
    if (!(lonSpan > 0) || !(latSpan > 0)) return;
    const step = niceStep(Math.max(lonSpan, latSpan) / 8);
    const NSEG = 24;
    const lineMat = Cesium.Color.GRAY.withAlpha(0.55);
    const lonStart = Math.ceil(west / step) * step;
    for (let lon = lonStart; lon <= east; lon += step) {
      const latlon = [];
      for (let i = 0; i <= NSEG; i++) {
        const la = south + latSpan * i / NSEG;
        latlon.push(lon, la);
      }
      gratDs.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(latlon), width: 1, material: lineMat, arcType: Cesium.ArcType.GEODESIC } });
      const lonShow = ((lon % 360) + 540) % 360 - 180;
      gratDs.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, south + latSpan * 0.02),
        label: { text: `${Math.abs(lonShow).toFixed(step < 1 ? 2 : 0)}°${lonShow >= 0 ? "E" : "W"}`, font: "11px sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    }
    const latStart = Math.ceil(south / step) * step;
    for (let lat = latStart; lat <= north; lat += step) {
      const latlon = [];
      for (let i = 0; i <= NSEG; i++) {
        const lo = west + lonSpan * i / NSEG;
        latlon.push(lo, lat);
      }
      gratDs.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(latlon), width: 1, material: lineMat, arcType: Cesium.ArcType.GEODESIC } });
      gratDs.entities.add({
        position: Cesium.Cartesian3.fromDegrees(west + lonSpan * 0.02, lat),
        label: { text: `${Math.abs(lat).toFixed(step < 1 ? 2 : 0)}°${lat >= 0 ? "N" : "S"}`, font: "11px sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    }
    requestRender();
  }

  function setGraticule(on) {
    graticuleOn = !!on;
    const cb = $("#display-graticule");
    if (cb && cb.checked !== graticuleOn) cb.checked = graticuleOn;
    buildGraticule();
  }

  viewer.camera.moveEnd.addEventListener(() => {
    if (!graticuleOn) return;
    clearTimeout(gratTimer);
    gratTimer = setTimeout(buildGraticule, 150);
  });
  $("#display-graticule")?.addEventListener("change", e => setGraticule(e.target.checked));

  // ---------- レイヤーエクスポート ----------
  function refreshExportOptions() {
    const sel = $("#tool-export-layer");
    if (!sel) return;
    const cur = sel.value;
    const items = (getOrderedLayerItems() || []).filter(item => isVectorLayerItem && isVectorLayerItem(item));
    sel.replaceChildren();
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = t("tools.exportLayer");
    sel.append(ph);
    for (const item of items) {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = (item.title || item.id) + (isQueryLayerItem && isQueryLayerItem(item) ? " *" : "");
      sel.append(o);
    }
    if (cur && items.some(i => i.id === cur)) sel.value = cur;
  }

  // レイヤー → ファイル出力の共通処理。UI ボタンと外部 API（exportLayer）で共用。
  // idOrTitle はレイヤー id またはタイトルを受け付ける
  async function doExport(idOrTitle, format) {
    const item = idOrTitle && (getOrderedLayerItems() || []).find(i => i.id === idOrTitle || i.title === idOrTitle);
    const gj = item && getLayerGeoJson && getLayerGeoJson(item.id);
    const res = gj && await exportFeatureCollection(gj, format, fileSafe(item.title || item.id));
    if (!res) return { ok: false };
    const file = `${fileSafe(item.title || item.id)}.${res.ext}`;
    downloadBlob(res.data, file, res.mime);
    return { ok: true, file, count: res.count, skipped: res.skipped || 0 };
  }

  // ---------- QGIS ライブ連携: 地物投入(Canvas → QGIS) ----------
  // ライブ未接続時は status に理由を出して終わる(POST /live/features)
  async function sendGeoJsonToQgis(name, gj, statusEl) {
    const st = statusEl;
    if (!liveIsActive()) {
      if (st) st.textContent = t("tools.qgisInactive");
      return { ok: false, reason: "inactive" };
    }
    if (!gj?.features?.length) {
      if (st) st.textContent = t("tools.exportNoData");
      return { ok: false, reason: "noData" };
    }
    const res = await liveSendFeatures(String(name || "Canvas"), gj);
    if (st) {
      st.textContent = res.ok
        ? t("tools.qgisSent", { count: res.added ?? gj.features.length })
        : t("tools.qgisSendFail", { error: res.reason || "?" });
    }
    return res;
  }

  // 作図アノテーションを QGIS スクラッチレイヤへ送る(API/ボタン共通)
  function sendAnnotationsToQgis(name) {
    return sendGeoJsonToQgis(name || t("tools.drawLayerTitle"), annotationsFc(), $("#tool-draw-status"));
  }

  $("#tool-export-layer")?.addEventListener("focus", refreshExportOptions);
  $("#tool-export-run")?.addEventListener("click", async () => {
    const st = $("#tool-export-status");
    const id = $("#tool-export-layer")?.value;
    const format = $("#tool-export-format")?.value || "geojson";
    try {
      const res = await doExport(id, format);
      if (!res.ok) {
        if (st) st.textContent = t("tools.exportNoData");
        return;
      }
      if (st) {
        st.textContent = t("tools.exportDone", { count: res.count })
          + (res.skipped ? `（${t("tools.exportSkipped", { count: res.skipped })}）` : "");
      }
    } catch (e) {
      console.warn("layer export failed", e);
      if (st) st.textContent = t("tools.exportFail");
    }
  });
  // 選択中レイヤーを QGIS スクラッチレイヤへ送る(GeoJSONエクスポートと同じ収集経路)
  $("#tool-export-toqgis")?.addEventListener("click", async () => {
    const st = $("#tool-export-status");
    const id = $("#tool-export-layer")?.value;
    const item = id && (getOrderedLayerItems() || []).find(i => i.id === id || i.title === id);
    const gj = item && getLayerGeoJson && getLayerGeoJson(item.id);
    await sendGeoJsonToQgis(item ? (item.title || item.id) : "", gj, st);
  });

  // ---------- モードボタン ----------
  $("#tool-m-distance")?.addEventListener("click", () => setMode(mode === "distance" ? null : "distance"));
  $("#tool-m-area")?.addEventListener("click", () => setMode(mode === "area" ? null : "area"));
  $("#tool-m-bearing")?.addEventListener("click", () => setMode(mode === "bearing" ? null : "bearing"));
  $("#tool-profile-draw")?.addEventListener("click", () => setMode(mode === "profile" ? null : "profile"));
  $("#tool-los")?.addEventListener("click", () => setMode(mode === "los" ? null : "los"));
  $("#tool-clear")?.addEventListener("click", clearAll);

  // 空間選択・集計・バッファ
  $("#tool-sel-rect")?.addEventListener("click", () => setMode(mode === "sel-rect" ? null : "sel-rect"));
  $("#tool-sel-poly")?.addEventListener("click", () => setMode(mode === "sel-poly" ? null : "sel-poly"));
  $("#tool-sel-circle")?.addEventListener("click", () => setMode(mode === "sel-circle" ? null : "sel-circle"));
  $("#tool-sel-layer")?.addEventListener("focus", refreshSelLayerOptions);
  $("#tool-sel-layer")?.addEventListener("change", refreshAggFieldOptions);
  $("#tool-sel-run")?.addEventListener("click", () => doSpatialSelect());
  $("#tool-sel-clear")?.addEventListener("click", clearSelection);
  $("#tool-sel-zoom")?.addEventListener("click", () => {
    const box = geomBbox(regionGeom);
    if (box && fitBounds) fitBounds(box);
  });
  $("#tool-sel-tolayer")?.addEventListener("click", async () => {
    if (!selFeatures.length) { if (selResultEl()) selResultEl().textContent = t("tools.selNoFeatures"); return; }
    const fc = { type: "FeatureCollection", features: selFeatures.map(f => ({ type: "Feature", properties: { ...(f.properties || {}) }, geometry: f.geometry })) };
    if (addDataLayer) await addDataLayer(`${t("tools.selLayerName")}（${selFeatures.length}）`, fc);
    if (selResultEl()) selResultEl().textContent = t("tools.selToLayerDone", { count: selFeatures.length });
  });
  $("#tool-agg-run")?.addEventListener("click", () => doAggregate());
  $("#tool-buf-run")?.addEventListener("click", () => void doBuffer());

  // 作図・注記
  $("#tool-draw-point")?.addEventListener("click", () => setMode(mode === "draw-point" ? null : "draw-point"));
  $("#tool-draw-line")?.addEventListener("click", () => setMode(mode === "draw-line" ? null : "draw-line"));
  $("#tool-draw-poly")?.addEventListener("click", () => setMode(mode === "draw-poly" ? null : "draw-poly"));
  $("#tool-draw-label")?.addEventListener("click", () => setMode(mode === "draw-label" ? null : "draw-label"));
  $("#tool-draw-clear")?.addEventListener("click", () => {
    while (annotations.length) removeAnnotation(0);
  });
  $("#tool-draw-export")?.addEventListener("click", () => {
    if (!annotations.length) return;
    downloadBlob(JSON.stringify(annotationsFc()), `${fileSafe(t("tools.drawLayerTitle"))}.geojson`, "application/geo+json");
  });
  $("#tool-draw-tolayer")?.addEventListener("click", async () => {
    if (!annotations.length || !addDataLayer) return;
    await addDataLayer(t("tools.drawLayerTitle"), annotationsFc());
    while (annotations.length) removeAnnotation(0);
  });
  $("#tool-draw-toqgis")?.addEventListener("click", async () => {
    if (!annotations.length) return;
    await sendAnnotationsToQgis();
  });
  refreshExportOptions();
  refreshSelLayerOptions();

  // ---------- 外部 API（kasugaiApi / AI ツール向け） ----------
  const toCartesians = coords => (coords || [])
    .map(c => Array.isArray(c) ? Cesium.Cartesian3.fromDegrees(Number(c[0]), Number(c[1])) : Cesium.Cartesian3.fromDegrees(Number(c.lng ?? c.longitude), Number(c.lat ?? c.latitude)))
    .filter(c => c && Number.isFinite(c.x));

  function drawApiLine(cartes, color = Cesium.Color.YELLOW) {
    clearOverlay();
    pts = cartes;
    updateOverlay();
  }

  return {
    handleClick,
    handleDoubleClick,
    handleMouseMove,
    isActive: () => !!mode,
    setGraticule,
    isGraticule: () => graticuleOn,
    clearAll,
    refreshExportOptions,
    exportLayer: (idOrTitle, format = "geojson") => doExport(idOrTitle, format),
    // QGIS ライブ連携: 作図アノテーション/任意レイヤーを QGIS へ投入
    sendAnnotationsToQgis,
    sendLayerToQgis: (idOrTitle) => {
      const item = idOrTitle && (getOrderedLayerItems() || []).find(i => i.id === idOrTitle || i.title === idOrTitle);
      const gj = item && getLayerGeoJson && getLayerGeoJson(item.id);
      return sendGeoJsonToQgis(item ? (item.title || item.id) : "", gj, $("#tool-export-status"));
    },

    // 空間選択（#23）: region は GeoJSON Polygon/MultiPolygon/Feature、
    // {bbox:[w,s,e,n]}、{center:[lng,lat]|{lng,lat}, radiusMeters} を受け付ける。
    // 省略時は直近に描画/生成した範囲を使う
    spatialSelect(opts = {}) {
      const raw = opts.region ?? opts.geometry ?? opts.polygon ?? opts.bbox ?? (opts.center ? opts : null);
      const region = raw ? normalizeRegion(raw) : regionGeom;
      if (!region) return { ok: false, reason: "invalid region" };
      const items = opts.layer
        ? vectorLayers().filter(i => i.id === opts.layer || i.title === opts.layer)
        : vectorLayers();
      const hits = [];
      for (const item of items) {
        const gj = getLayerGeoJson && getLayerGeoJson(item.id);
        for (const f of selectFeatures(gj, region)) hits.push({ layer: item.title || item.id, feature: f });
      }
      regionGeom = region;
      regionSourceGeom = region;
      selFeatures = hits.map(h => h.feature);
      selLayerLabel = items.map(i => i.title || i.id).join(", ");
      redrawSelDs();
      const el = selResultEl();
      if (el) el.textContent = hits.length ? t("tools.selResult", { count: hits.length, layer: selLayerLabel }) : t("tools.selNoFeatures");
      return {
        ok: true, count: hits.length, layer: selLayerLabel,
        features: hits.slice(0, 200).map(h => ({ layer: h.layer, properties: h.feature.properties || {} })),
      };
    },

    // ポリゴン内集計（#30）
    aggregateWithin(opts = {}) {
      const raw = opts.region ?? opts.geometry ?? opts.polygon ?? opts.bbox ?? (opts.center ? opts : null);
      const region = raw ? normalizeRegion(raw) : regionGeom;
      if (!region) return { ok: false, reason: "invalid region" };
      const items = opts.layer
        ? vectorLayers().filter(i => i.id === opts.layer || i.title === opts.layer)
        : vectorLayers();
      const features = [];
      for (const item of items) {
        const gj = getLayerGeoJson && getLayerGeoJson(item.id);
        if (gj?.features) features.push(...gj.features);
      }
      regionGeom = region;
      regionSourceGeom = region;
      redrawSelDs();
      const { rows } = aggregateInRegion({ type: "FeatureCollection", features }, region,
        { groupField: opts.groupField || null, valueField: opts.valueField || null });
      return { ok: true, count: rows.reduce((s, r) => s + r.count, 0), rows };
    },

    // バッファ生成（#34）: geometry（GeoJSON geometry/Feature または範囲指定形）に
    // radiusMeters のバッファを生成し一時レイヤーとして追加する
    async createBuffer(opts = {}) {
      let geom = null;
      const g = opts.geometry?.type === "Feature" ? opts.geometry.geometry : opts.geometry;
      // GeoJSON geometry でない範囲指定形（{center:[lng,lat]}・{bbox:[w,s,e,n]}）は region として正規化する
      if (g && !g.type) geom = normalizeRegion({ ...g, radiusMeters: g.radiusMeters ?? opts.radiusMeters });
      else if (g) geom = g;
      else {
        const raw = opts.region ?? opts.polygon ?? opts.bbox ?? (opts.center ? opts : null);
        geom = raw ? normalizeRegion(raw) : regionSourceGeom;
      }
      const r = Number(opts.radiusMeters ?? opts.radius ?? 0);
      if (!geom) return { ok: false, reason: "no geometry" };
      if (!Number.isFinite(r) || r === 0) return { ok: false, reason: "radiusMeters required" };
      try {
        const bg = await bufferGeometry(geom, r);
        if (!bg) return { ok: false, reason: "buffer failed" };
        const title = opts.title || `buffer ${r}m`;
        const added = addDataLayer && await addDataLayer(title, {
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: { name: title }, geometry: bg }],
        });
        regionGeom = bg;
        regionSourceGeom = bg;
        redrawSelDs();
        return { ok: !!added, title, id: added?.id };
      } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
      }
    },

    measureDistance(coords) {
      const cartes = toCartesians(coords);
      if (cartes.length < 2) return { ok: false, reason: "need >= 2 points" };
      const segments = [];
      let total = 0;
      for (let i = 1; i < cartes.length; i++) {
        const d = segDistance(cartes[i - 1], cartes[i]);
        segments.push(d);
        total += d;
      }
      mode = "distance";
      drawApiLine(cartes);
      mode = null;
      updateModeButtons();
      if (resultEl()) resultEl().textContent = t("tools.distanceTotal", { value: fmtDist(total) });
      return { ok: true, totalMeters: total, segmentsMeters: segments };
    },

    measureArea(coords) {
      const cartes = toCartesians(coords);
      if (cartes.length < 3) return { ok: false, reason: "need >= 3 points" };
      let perim = segDistance(cartes[cartes.length - 1], cartes[0]);
      for (let i = 1; i < cartes.length; i++) perim += segDistance(cartes[i - 1], cartes[i]);
      const area = polygonArea(cartes);
      mode = "area";
      drawApiLine(cartes);
      mode = null;
      updateModeButtons();
      if (resultEl()) resultEl().textContent = t("tools.areaResult", { area: fmtArea(area), perimeter: fmtDist(perim) });
      return { ok: true, squareMeters: area, perimeterMeters: perim };
    },

    measureBearing(from, to) {
      const cartes = toCartesians([from, to]);
      if (cartes.length < 2) return { ok: false, reason: "need 2 points" };
      const g = geodesic(cartes[0], cartes[1]);
      mode = "bearing";
      drawApiLine(cartes);
      mode = null;
      updateModeButtons();
      dyn.push(labelEntity(midPoint(cartes[0], cartes[1]), `${(g.startHeading * DEG).toFixed(1)}°`));
      const result = {
        ok: true,
        startHeadingDeg: g.startHeading * DEG,
        endHeadingDeg: g.endHeading * DEG,
        distanceMeters: g.surfaceDistance,
      };
      if (resultEl()) {
        resultEl().textContent = t("tools.bearingResult", {
          bearing: result.startHeadingDeg.toFixed(1),
          back: result.endHeadingDeg.toFixed(1),
          dist: fmtDist(result.distanceMeters),
        });
      }
      requestRender();
      return result;
    },

    async elevationProfile(coords, samples) {
      const cartes = toCartesians(coords);
      if (cartes.length < 2) return { ok: false, reason: "need >= 2 points" };
      mode = "profile";
      drawApiLine(cartes);
      if (samples != null) {
        const inp = $("#tool-profile-samples");
        if (inp) inp.value = String(Math.round(Number(samples)));
      }
      const res = await runProfile(cartes);
      mode = null;
      updateModeButtons();
      return res ? { ok: true, ...res } : { ok: false, reason: "elevation unavailable" };
    },

    async lineOfSight(from, to, opts = {}) {
      const cartes = toCartesians([from, to]);
      if (cartes.length < 2) return { ok: false, reason: "need 2 points" };
      const hA = Number.isFinite(Number(opts.observerHeight)) ? Number(opts.observerHeight) : 0;
      const hB = Number.isFinite(Number(opts.targetHeight)) ? Number(opts.targetHeight) : 0;
      clearOverlay();
      const res = await runLos(cartes[0], cartes[1], hA, hB);
      drawLosResult(res, hA, hB);
      if (losResultEl()) {
        losResultEl().textContent = res.blocked < 0
          ? t("tools.losVisible", { dist: fmtDist(res.total) })
          : t("tools.losBlocked", { dist: fmtDist(res.points[res.blocked].dist) });
      }
      requestRender();
      return {
        ok: true,
        visible: res.blocked < 0,
        distanceMeters: res.total,
        blockedAt: res.blocked >= 0 ? { lat: res.points[res.blocked].lat, lng: res.points[res.blocked].lng, distanceMeters: res.points[res.blocked].dist } : null,
      };
    },
  };
}
