// 2D エンジン向けツール群 — 計測・標高断面・見通し・緯度経度グリッド・レイヤーエクスポート
// （cesium/geo-tools.js のエンジン非依存版。静的配信のみで完結し、全てオンデマンド動作 —
// モード非アクティブ時・グリッド OFF 時は描画・イベントコストともゼロ）
//
// initGeoTools2d({
//   panel              : HTMLElement | selector | null  // ツール UI の注入先（省略時 UI 無し・API のみ）
//   sections           : { measure, profile, los, export, general }  // 注入セクション（省略=全部）
//   overlay            : { update(fc) }                 // ツール描画 FC（kind/text プロパティ）
//   graticuleOverlay   : { update(fc) }                 // グリッド描画 FC（省略時 overlay と共用）
//   getBounds          : () => {west,south,east,north}  // グリッド描画範囲
//   setCursor          : (css) => void                  // 計測中カーソル
//   setInteractive     : (on) => void                   // ダブルクリックズーム抑制等（省略可）
//   sampleTerrain      : async ([{lng,lat}], totalM) => number[]|null  // 地形標高（省略可→地理院API）
//   getOrderedLayerItems / isVectorLayerItem / isQueryLayerItem / getLayerGeoJson // エクスポート
// }) → api
//
// オーバーレイ FC の feature.properties.kind:
//   line(黄) / poly(面) / point(頂点) / label(区間ラベル・text 付き) / hover(断面ホバー・青)
//   los-ok(緑) / los-bad(赤) / los-block(遮蔽点・text 付き)
//   grat(グリッド線) / grat-label(度ラベル・text 付き)
// api.handleClick({lng,lat}) / handleDoubleClick() / handleMouseMove({lng,lat}) は
// エンジンのイベントから呼び、処理したら true を返す（属性ピックを抑止するため）
import { initI18n, applyI18n, t } from "./i18n.js";
import { exportFeatureCollection } from "./export-formats.js";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const MIN_POINT_SPACING_M = 2; // ダブルクリック終了時に同一点が二重追加されるのを防ぐ間隔
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;

// ---- 測地線（WGS84 Vincenty 逆問題。非収束時は球面にフォールバック） ----
function geodesicInverse(a, b) {
  const f1 = a.lat * RAD, f2 = b.lat * RAD;
  const L = (b.lng - a.lng) * RAD;
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(f1));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(f2));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lam = L;
  for (let i = 0; i < 100; i++) {
    const sinL = Math.sin(lam), cosL = Math.cos(lam);
    const sinSig = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSig === 0) return { dist: 0, az1: 0, az2: 0 };
    const cosSig = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    const sig = Math.atan2(sinSig, cosSig);
    const sinA = cosU1 * cosU2 * sinL / sinSig;
    const cos2A = 1 - sinA * sinA;
    const cos2Sm = cos2A !== 0 ? cosSig - 2 * sinU1 * sinU2 / cos2A : 0;
    const C = WGS84_F / 16 * cos2A * (4 + WGS84_F * (4 - 3 * cos2A));
    const prev = lam;
    lam = L + (1 - C) * WGS84_F * sinA * (sig + C * sinSig * (cos2Sm + C * cosSig * (-1 + 2 * cos2Sm ** 2)));
    if (Math.abs(lam - prev) < 1e-12) {
      const u2 = cos2A * (WGS84_A ** 2 - (WGS84_A * (1 - WGS84_F)) ** 2) / (WGS84_A * (1 - WGS84_F)) ** 2;
      const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
      const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
      const dSig = B * sinSig * (cos2Sm + B / 4 * (cosSig * (-1 + 2 * cos2Sm ** 2)
        - B / 6 * cos2Sm * (-3 + 4 * sinSig ** 2) * (-3 + 4 * cos2Sm ** 2)));
      const az1 = Math.atan2(cosU2 * Math.sin(lam), cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lam));
      const az2 = Math.atan2(cosU1 * Math.sin(lam), -sinU1 * cosU2 + cosU1 * sinU2 * Math.cos(lam));
      return { dist: WGS84_A * (1 - WGS84_F) * A * (sig - dSig), az1: az1 * DEG, az2: az2 * DEG };
    }
  }
  // 非収束（ほぼ対蹠点）: 球面ハバーシンにフォールバック
  const dLat = f2 - f1, dLng = L;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dLng / 2) ** 2;
  const dist = 2 * WGS84_A * Math.asin(Math.min(1, Math.sqrt(s)));
  const az = (x, y) => Math.atan2(
    Math.sin((y.lng - x.lng) * RAD) * Math.cos(y.lat * RAD),
    Math.cos(x.lat * RAD) * Math.sin(y.lat * RAD) - Math.sin(x.lat * RAD) * Math.cos(y.lat * RAD) * Math.cos((y.lng - x.lng) * RAD)) * DEG;
  return { dist, az1: az(a, b), az2: az(a, b) };
}
const segDistance = (a, b) => geodesicInverse(a, b).dist;

// 球面多角形面積（Chamberlain–Duquette。実務サイズなら十分な精度）
function polygonArea(pts) {
  if (pts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += (q.lng - p.lng) * RAD * (2 + Math.sin(p.lat * RAD) + Math.sin(q.lat * RAD));
  }
  return Math.abs(s * WGS84_A * WGS84_A / 2);
}

// 2点間の球面補間（fraction 0..1）
function slerp(a, b, f) {
  const toVec = p => [Math.cos(p.lat * RAD) * Math.cos(p.lng * RAD), Math.cos(p.lat * RAD) * Math.sin(p.lng * RAD), Math.sin(p.lat * RAD)];
  const A = toVec(a), B = toVec(b);
  const dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const th = Math.acos(dot);
  if (th < 1e-9) return { lat: a.lat, lng: a.lng };
  const sA = Math.sin((1 - f) * th) / Math.sin(th), sB = Math.sin(f * th) / Math.sin(th);
  const v = [A[0] * sA + B[0] * sB, A[1] * sA + B[1] * sB, A[2] * sA + B[2] * sB];
  return { lat: Math.atan2(v[2], Math.hypot(v[0], v[1])) * DEG, lng: Math.atan2(v[1], v[0]) * DEG };
}

const fmtDist = m => !Number.isFinite(m) ? "-" : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
const fmtArea = m2 => !Number.isFinite(m2) ? "-" : m2 < 1e6 ? `${Math.round(m2).toLocaleString()} m²` : `${(m2 / 1e6).toFixed(2)} km²`;
const num = (el, fallback) => {
  const v = Number(el && el.value);
  return Number.isFinite(v) ? v : fallback;
};
const fileSafe = s => String(s || "layer").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "layer";

function downloadBlob(text, filename, type) {
  const blob = text instanceof Blob ? text : new Blob([text], { type: type || "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const CSS = `
#tools-panel .settings-tabs { display: flex; flex-wrap: wrap; gap: 3px; margin: 3px 0; padding-bottom: 4px; }
#tools-panel .settings-tab { min-height: 26px; padding: 4px 7px; border: 0; border-radius: 4px 4px 0 0;
  background: transparent; color: #52636d; cursor: pointer; font-size: 18px; }
#tools-panel .settings-tab.active { background: rgba(49,86,79,.16); color: #31564f; font-weight: 700; }
#tools-panel .tool-btnrow { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-bottom: 3px; }
#tools-panel .tool-btnrow button { flex: 0 0 auto; }
#tools-panel .tool-btnrow button.tool-on { border-color: #31564f; background: #31564f; color: #fff; }
#tools-panel .tool-inline { display: inline-flex; align-items: center; gap: 4px; font-size: 0.85em; color: #52636d; }
#tools-panel .tool-inline input[type="number"] { width: 64px; min-height: 28px; padding: 3px 5px; border: 1px solid #cbd9de; border-radius: 4px; box-sizing: border-box; }
#tools-panel .tool-result { min-height: 18px; margin: 3px 0 6px; font-size: 0.9em; color: #1d2b35; overflow-wrap: anywhere; }
#tools-panel #tool-export-layer { flex: 1; min-width: 0; min-height: 30px; padding: 4px 6px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; font-size: 0.9em; }
#tools-panel #profile-chart { display: block; width: 100%; max-width: 100%; height: 150px; margin-top: 3px; border: 1px solid #e4ecef; border-radius: 4px; box-sizing: border-box; }
#tools-panel .hint { margin: 2px 0 4px; color: #71818d; font-size: 0.8em; }
#tools-panel .set-row { display: block; margin: 3px 0; }
/* Leaflet 系エンジンのツールラベル（leaflet / gsimaps iframe 内の tooltip） */
.leaflet-tooltip.kasc-tool-label, .leaflet-tooltip.kasc-grat-label { background: rgba(20,30,40,.8); color: #fff; border: 0; box-shadow: none; font-size: 11px; padding: 1px 5px; border-radius: 3px; }
.leaflet-tooltip.kasc-tool-label:before, .leaflet-tooltip.kasc-grat-label:before { display: none; }
`;

let styleInjected = false;
function ensureStyle() {
  if (styleInjected || document.querySelector("#kasc-geo-tools-style")) return;
  styleInjected = true;
  const el = document.createElement("style");
  el.id = "kasc-geo-tools-style";
  el.textContent = CSS;
  document.head.append(el);
}

// ツールパネルの DOM（cesium/index.html と同じ id 体系・data-i18n キー）
function injectPanel(panel, sections) {
  const parts = [];
  const nav = [];
  if (sections.measure) nav.push(['tools-measure-panel', 'tools.measure', '計測']);
  if (sections.profile) nav.push(['tools-profile-panel', 'tools.profile', '標高断面']);
  if (sections.los) nav.push(['tools-los-panel', 'tools.los', '見通し判定']);
  if (sections.export) nav.push(['tools-export-panel', 'tools.export', 'エクスポート']);
  if (sections.general) nav.push(['tools-general-panel', 'display.ariaLabel', '表示']);
  const firstId = nav.length ? nav[0][0] : null;
  if (nav.length > 1) {
    parts.push(`<nav class="settings-tabs" aria-label="Tools">` + nav.map(([id, key, ja], i) =>
      `<button class="settings-tab${i === 0 ? " active" : ""}" type="button" data-settings-panel="${id}" data-i18n="${key}">${ja}</button>`).join("") + `</nav>`);
  }
  const hideAttr = id => id === firstId ? "" : " hidden";
  if (sections.measure) parts.push(`
    <section id="tools-measure-panel" class="settings-subpanel"${hideAttr("tools-measure-panel")}>
      <div class="tool-btnrow">
        <button id="tool-m-distance" type="button" data-i18n="tools.distance">距離</button>
        <button id="tool-m-area" type="button" data-i18n="tools.area">面積</button>
        <button id="tool-m-bearing" type="button" data-i18n="tools.bearing">方位</button>
        <button id="tool-clear" type="button" class="danger-button" data-i18n="tools.clear">クリア</button>
      </div>
      <p class="hint" data-i18n="tools.measureHint">左クリックで頂点を追加、ダブルクリックで確定します。</p>
      <div id="tools-measure-result" class="tool-result" aria-live="polite"></div>
    </section>`);
  if (sections.profile) parts.push(`
    <section id="tools-profile-panel" class="settings-subpanel"${hideAttr("tools-profile-panel")}>
      <div class="tool-btnrow">
        <button id="tool-profile-draw" type="button" data-i18n="tools.profileDraw">ラインを描く</button>
        <label class="tool-inline"><span data-i18n="tools.profileSamples">サンプル数</span><input id="tool-profile-samples" type="number" min="10" max="500" value="100" /></label>
      </div>
      <p class="hint" data-i18n="tools.profileHint">断面を取るラインを描き、ダブルクリックで実行します。</p>
      <div id="profile-box" hidden>
        <canvas id="profile-chart" width="280" height="150"></canvas>
        <div id="profile-stats" class="tool-result"></div>
      </div>
    </section>`);
  if (sections.los) parts.push(`
    <section id="tools-los-panel" class="settings-subpanel"${hideAttr("tools-los-panel")}>
      <p class="hint" data-i18n="tools.losHint">観測点→対象点の順にクリックします。</p>
      <div class="tool-btnrow">
        <button id="tool-los" type="button" data-i18n="tools.losPick">2点を指定</button>
        <label class="tool-inline"><span data-i18n="tools.losObserverHeight">観測点高(m)</span><input id="los-observer-h" type="number" step="0.5" value="1.5" /></label>
        <label class="tool-inline"><span data-i18n="tools.losTargetHeight">対象点高(m)</span><input id="los-target-h" type="number" step="0.5" value="0" /></label>
      </div>
      <div id="tools-los-result" class="tool-result" aria-live="polite"></div>
    </section>`);
  if (sections.export) parts.push(`
    <section id="tools-export-panel" class="settings-subpanel"${hideAttr("tools-export-panel")}>
      <div class="tool-btnrow">
        <select id="tool-export-layer"></select>
        <select id="tool-export-format">
          <option value="geojson">GeoJSON</option>
          <option value="csv">CSV (WKT)</option>
          <option value="tsv">TSV (WKT)</option>
          <option value="kml">KML</option>
          <option value="fgb">FlatGeobuf</option>
          <option value="shp">Shapefile (.zip)</option>
        </select>
        <button id="tool-export-run" type="button" data-i18n="tools.export">出力</button>
      </div>
      <div id="tool-export-status" class="tool-result" aria-live="polite"></div>
      <p class="hint" data-i18n="tools.exportHint">* 付きのレイヤーは読み込み済み（表示範囲）のデータのみ出力されます。</p>
      <p class="hint" data-i18n="tools.exportHintFormats">CSV/TSV は WKT 列付き、Shapefile はジオメトリ種別ごとに分割して ZIP にまとめます。</p>
    </section>`);
  if (sections.general) parts.push(`
    <section id="tools-general-panel" class="settings-subpanel"${hideAttr("tools-general-panel")}>
      <label class="set-row"><input id="display-minimap" type="checkbox" /><span data-i18n="display.minimap"> ミニマップを表示</span></label>
      <label class="set-row"><input id="display-graticule" type="checkbox" /><span data-i18n="display.graticule"> 緯度経度グリッド</span></label>
    </section>`);
  const root = document.createElement("div");
  root.id = "tools-panel";
  root.innerHTML = parts.join("");
  panel.append(root);
  // サブタブ切替
  root.querySelector(".settings-tabs")?.addEventListener("click", e => {
    const b = e.target.closest("[data-settings-panel]");
    if (!b) return;
    root.querySelectorAll("[data-settings-panel]").forEach(x => x.classList.toggle("active", x === b));
    root.querySelectorAll(".settings-subpanel").forEach(p => { p.hidden = p.id !== b.dataset.settingsPanel; });
  });
  void initI18n().then(() => applyI18n(root));
  return root;
}

// Leaflet オーバーレイアダプタ（leaflet エンジン / gsimaps の iframe 地図で共用）。
// L はそのページの Leaflet 名前空間、map は対象の Leaflet マップインスタンス。
export function makeLeafletOverlay(L, map) {
  const toolGroup = L.layerGroup().addTo(map);
  const gratGroup = L.layerGroup().addTo(map);
  const LINE_STYLE = {
    line: { color: "#ffff00", weight: 3 },
    "los-line": { color: "#ffa500", weight: 3 },
    "los-ok": { color: "#32cd32", weight: 3 },
    "los-bad": { color: "#ff0000", weight: 3 },
    grat: { color: "#888888", weight: 1, opacity: 0.55 },
  };
  function render(fc, group) {
    group.clearLayers();
    L.geoJSON(fc, {
      style: f => LINE_STYLE[f.properties?.kind] || { color: "#ffff00", weight: 2, fillColor: "#ffff00", fillOpacity: 0.25 },
      pointToLayer: (f, latlng) => {
        const p = f.properties || {};
        const colors = { point: p.color || "#ffff00", "los-block": "#ff0000", hover: "#00bfff" };
        const invisible = p.kind === "label" || p.kind === "grat-label";
        const m = L.circleMarker(latlng, invisible
          ? { radius: 0, opacity: 0, fillOpacity: 0, interactive: false }
          : { radius: 5, color: "#000000", weight: 1.5, fillColor: colors[p.kind] || "#ffff00", fillOpacity: 1, interactive: false });
        if (p.text) {
          m.bindTooltip(p.text, { permanent: true, direction: "top", offset: [0, -6], className: p.kind === "grat-label" ? "kasc-grat-label" : "kasc-tool-label", interactive: false });
        }
        return m;
      },
    }).addTo(group);
  }
  return {
    update: fc => render(fc, toolGroup),
    updateGraticule: fc => render(fc, gratGroup),
    clear() { toolGroup.clearLayers(); gratGroup.clearLayers(); },
  };
}

export function initGeoTools2d(hooks = {}) {
  ensureStyle();
  const $ = s => document.querySelector(s);
  const overlay = hooks.overlay || { update() {} };
  const gratOverlay = hooks.graticuleOverlay || overlay;
  const setCursor = hooks.setCursor || (() => {});
  const setInteractive = hooks.setInteractive || (() => {});
  const DEFAULT_SECTIONS = { measure: true, profile: true, los: true, export: true, general: false };
  const sections = { ...DEFAULT_SECTIONS, ...(hooks.sections || {}) };

  let panelRoot = null;
  if (hooks.panel) {
    const panel = typeof hooks.panel === "string" ? document.querySelector(hooks.panel) : hooks.panel;
    if (panel) panelRoot = injectPanel(panel, sections);
  }

  // ---------- 計測モード ----------
  // mode: null | "distance" | "area" | "bearing" | "profile" | "los"
  let mode = null;
  let pts = [];        // 確定頂点 [{lng,lat}]
  let hoverPt = null;  // カーソル位置のプレビュー点
  let losRunning = false;
  let profileRunning = false;
  let profileHover = null;

  const resultEl = () => $("#tools-measure-result");
  const losResultEl = () => $("#tools-los-result");
  const currentPositions = () => (hoverPt ? [...pts, hoverPt] : pts.slice());

  function updateModeButtons() {
    const map = { distance: "#tool-m-distance", area: "#tool-m-area", bearing: "#tool-m-bearing", profile: "#tool-profile-draw", los: "#tool-los" };
    for (const [m, sel] of Object.entries(map)) {
      const btn = $(sel);
      if (btn) btn.classList.toggle("tool-on", mode === m);
    }
    setCursor(mode ? "crosshair" : "");
    setInteractive(!!mode);
  }

  // 現在状態 → オーバーレイ FC
  function buildOverlayFc() {
    const features = [];
    const positions = currentPositions();
    const lineColor = mode === "los" ? "los-line" : "line";
    if (positions.length >= 2) {
      features.push({ type: "Feature", properties: { kind: lineColor }, geometry: { type: "LineString", coordinates: positions.map(p => [p.lng, p.lat]) } });
    }
    if (mode === "area" && positions.length >= 3) {
      features.push({ type: "Feature", properties: { kind: "poly" }, geometry: { type: "Polygon", coordinates: [[...positions, positions[0]].map(p => [p.lng, p.lat])] } });
    }
    for (const p of pts) features.push({ type: "Feature", properties: { kind: "point" }, geometry: { type: "Point", coordinates: [p.lng, p.lat] } });
    // 区間ラベル（距離・面積モードのみ）
    if (mode === "distance" || mode === "area") {
      for (let i = 1; i < positions.length; i++) {
        const d = segDistance(positions[i - 1], positions[i]);
        if (d >= 1) features.push({ type: "Feature", properties: { kind: "label", text: fmtDist(d) }, geometry: { type: "Point", coordinates: [(positions[i - 1].lng + positions[i].lng) / 2, (positions[i - 1].lat + positions[i].lat) / 2] } });
      }
      if (mode === "area" && positions.length >= 3) {
        const d = segDistance(positions[positions.length - 1], positions[0]);
        features.push({ type: "Feature", properties: { kind: "label", text: fmtDist(d) }, geometry: { type: "Point", coordinates: [(positions[positions.length - 1].lng + positions[0].lng) / 2, (positions[positions.length - 1].lat + positions[0].lat) / 2] } });
      }
    }
    if (profileHover) features.push({ type: "Feature", properties: { kind: "hover" }, geometry: { type: "Point", coordinates: [profileHover.lng, profileHover.lat] } });
    return { type: "FeatureCollection", features };
  }

  function pushOverlay(extra = []) {
    const fc = buildOverlayFc();
    fc.features.push(...extra);
    overlay.update(fc);
  }

  function clearAll() {
    mode = null;
    pts = [];
    hoverPt = null;
    profileHover = null;
    overlay.update({ type: "FeatureCollection", features: [] });
    if (resultEl()) resultEl().textContent = "";
    if (losResultEl()) losResultEl().textContent = "";
    const box = $("#profile-box");
    if (box) box.hidden = true;
    updateModeButtons();
  }

  function setMode(next) {
    clearAll();
    mode = next;
    if (resultEl()) resultEl().textContent = t(next === "los" ? "tools.losHint" : "tools.measureHint");
    updateModeButtons();
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
        const g = geodesicInverse(pts[0], hoverPt);
        el.textContent = t("tools.bearingResult", {
          bearing: g.az1.toFixed(1),
          back: g.az2.toFixed(1),
          dist: fmtDist(g.dist),
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

  function addPoint(lngLat) {
    const c = { lng: Number(lngLat.lng ?? lngLat[0]), lat: Number(lngLat.lat ?? lngLat[1]) };
    if (!Number.isFinite(c.lng) || !Number.isFinite(c.lat)) return;
    if (pts.length && segDistance(pts[pts.length - 1], c) < MIN_POINT_SPACING_M) return;
    pts.push(c);
    pushOverlay();
    updateReadout();
  }

  // 距離・面積は測定結果を残したままモードだけ終了する
  function finishInteractive() {
    mode = null;
    hoverPt = null;
    updateModeButtons();
    pushOverlay();
  }

  // ---------- ライン上の地形サンプリング（断面・LOS 共用） ----------
  function densifyLngLats(line, n) {
    const segs = [];
    let total = 0;
    for (let i = 1; i < line.length; i++) {
      const d = segDistance(line[i - 1], line[i]);
      segs.push(d);
      total += d;
    }
    const out = [{ lat: line[0].lat, lng: line[0].lng, dist: 0 }];
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const L = segs[i];
      const steps = Math.max(1, Math.round((L / Math.max(total, 1e-9)) * (n - 1)));
      for (let s = 1; s <= steps; s++) {
        const c = slerp(line[i], line[i + 1], s / steps);
        acc += L / steps;
        out.push({ lat: c.lat, lng: c.lng, dist: acc });
      }
    }
    return { points: out, total };
  }

  // 地形プロバイダから標高列を取得。全て取れない場合は地理院標高API（日本域）へフォールバック
  async function sampleTerrainLine(lnglats, totalMeters = 0) {
    if (hooks.sampleTerrain) {
      try {
        const hs = await hooks.sampleTerrain(lnglats, totalMeters);
        if (hs && hs.some(h => Number.isFinite(h))) return hs;
      } catch (e) { /* フォールバックへ */ }
    }
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
  let profileSamples = null;

  async function runProfile(line) {
    if (line.length < 2) return null;
    profileRunning = true;
    updateReadout();
    const n = Math.min(Math.max(Math.round(num($("#tool-profile-samples"), 100)), 10), 500);
    const { points, total } = densifyLngLats(line, n);
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
    ctx.fillStyle = "#52636d";
    ctx.textAlign = "center";
    ctx.fillText("0", X(0), H - 6);
    ctx.fillText(fmtDist(dMax), X(dMax), H - 6);
    canvas._profile = { samples, X, padL, padR, eMin, eMax, dMax };
  }

  function onChartHover(event) {
    const canvas = $("#profile-chart");
    const meta = canvas && canvas._profile;
    if (!meta) return;
    const rect = canvas.getBoundingClientRect();
    const px = (event.clientX - rect.left) * (canvas.width / rect.width);
    const { samples, padL, padR, dMax } = meta;
    const dist = Math.min(Math.max((px - padL) / Math.max(1, canvas.width - padL - padR), 0), 1) * dMax;
    let best = samples[0];
    for (const s of samples) if (Math.abs(s.dist - dist) < Math.abs(best.dist - dist)) best = s;
    profileHover = best;
    const statsEl = $("#profile-stats");
    if (statsEl && best) {
      statsEl.dataset.baseText = statsEl.dataset.baseText ?? statsEl.textContent;
      statsEl.textContent = `${statsEl.dataset.baseText}　→ ${fmtDist(best.dist)}: ${best.elev.toFixed(1)} m`;
    }
    pushOverlay();
  }
  if (panelRoot) {
    panelRoot.querySelector("#profile-chart")?.addEventListener("mousemove", onChartHover);
    panelRoot.querySelector("#profile-chart")?.addEventListener("mouseleave", () => {
      profileHover = null;
      const statsEl = $("#profile-stats");
      if (statsEl && statsEl.dataset.baseText) statsEl.textContent = statsEl.dataset.baseText;
      pushOverlay();
    });
  }

  // ---------- 見通し判定 ----------
  async function runLos(a, b, observerH, targetH) {
    const N = 160;
    const { points, total } = densifyLngLats([a, b], N);
    const terr = await sampleTerrainLine(points, total);
    const groundA = Number.isFinite(terr[0]) ? terr[0] : 0;
    const groundB = Number.isFinite(terr[terr.length - 1]) ? terr[terr.length - 1] : 0;
    const hA = groundA + observerH, hB = groundB + targetH;
    let blocked = -1;
    for (let i = 1; i < N - 1; i++) {
      if (!Number.isFinite(terr[i])) continue;
      const f = i / (N - 1);
      // 視線(直線)の測地高 = 端点高の線形補間 − 地球曲率による弦の沈下 f(1-f)·L²/(2R)
      const hs = hA + (hB - hA) * f - f * (1 - f) * total * total / (2 * WGS84_A);
      if (terr[i] > hs) { blocked = i; break; }
    }
    return { points, terr, total, blocked, hA, hB };
  }

  function drawLosResult(res) {
    const { points, blocked } = res;
    const features = [];
    const first = points[0], last = points[points.length - 1];
    features.push({ type: "Feature", properties: { kind: "point", color: "#00bfff" }, geometry: { type: "Point", coordinates: [first.lng, first.lat] } });
    features.push({ type: "Feature", properties: { kind: "point", color: "#ffa500" }, geometry: { type: "Point", coordinates: [last.lng, last.lat] } });
    if (blocked < 0) {
      features.push({ type: "Feature", properties: { kind: "los-ok" }, geometry: { type: "LineString", coordinates: [[first.lng, first.lat], [last.lng, last.lat]] } });
    } else {
      const bp = points[blocked];
      const cut = blocked / (points.length - 1);
      const mid = slerp(first, last, cut);
      features.push({ type: "Feature", properties: { kind: "los-ok" }, geometry: { type: "LineString", coordinates: [[first.lng, first.lat], [mid.lng, mid.lat]] } });
      features.push({ type: "Feature", properties: { kind: "los-bad" }, geometry: { type: "LineString", coordinates: [[mid.lng, mid.lat], [last.lng, last.lat]] } });
      features.push({ type: "Feature", properties: { kind: "los-block", text: t("tools.losBlockedShort") }, geometry: { type: "Point", coordinates: [bp.lng, bp.lat] } });
    }
    pushOverlay(features);
    return res.total;
  }

  async function executeLos() {
    losRunning = true;
    updateReadout();
    try {
      const hA = num($("#los-observer-h"), 0);
      const hB = num($("#los-target-h"), 0);
      const res = await runLos(pts[0], pts[1], hA, hB);
      drawLosResult(res);
      if (losResultEl()) {
        losResultEl().textContent = res.blocked < 0
          ? t("tools.losVisible", { dist: fmtDist(res.total) })
          : t("tools.losBlocked", { dist: fmtDist(res.points[res.blocked].dist) });
      }
      if (resultEl()) resultEl().textContent = "";
    } finally {
      losRunning = false;
      mode = null;
      updateModeButtons();
    }
  }

  // ---------- 入力ハンドラ（エンジンのイベントから呼ばれる） ----------
  function handleClick(lngLat) {
    if (!mode) return false;
    addPoint(lngLat);
    if (mode === "los" && pts.length >= 2) void executeLos();
    else if (mode === "bearing" && pts.length >= 2) {
      const g = geodesicInverse(pts[0], pts[1]);
      pushOverlay([{ type: "Feature", properties: { kind: "label", text: `${g.az1.toFixed(1)}°` }, geometry: { type: "Point", coordinates: [(pts[0].lng + pts[1].lng) / 2, (pts[0].lat + pts[1].lat) / 2] } }]);
      if (resultEl()) {
        resultEl().textContent = t("tools.bearingResult", {
          bearing: g.az1.toFixed(1),
          back: g.az2.toFixed(1),
          dist: fmtDist(g.dist),
        });
      }
      mode = null;
      updateModeButtons();
    }
    return true;
  }

  function handleDoubleClick() {
    if (!mode) return false;
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
        const line = pts.slice();
        mode = null;
        updateModeButtons();
        void runProfile(line);
      }
      return true;
    }
    if (mode === "los") {
      if (pts.length >= 2) void executeLos();
      return true;
    }
    return true;
  }

  function handleMouseMove(lngLat) {
    if (!mode || !pts.length) return false;
    const c = { lng: Number(lngLat.lng ?? lngLat[0]), lat: Number(lngLat.lat ?? lngLat[1]) };
    if (!Number.isFinite(c.lng) || !Number.isFinite(c.lat)) return true;
    const changed = hoverPt === null || segDistance(hoverPt, c) > 0.5;
    if (!changed) return true;
    hoverPt = c;
    pushOverlay();
    updateReadout();
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

  function buildGraticuleFc() {
    const features = [];
    if (!graticuleOn || !hooks.getBounds) return { type: "FeatureCollection", features };
    const rect = hooks.getBounds();
    if (!rect) return { type: "FeatureCollection", features };
    let west = rect.west, east = rect.east;
    const south = Math.max(-85, rect.south), north = Math.min(85, rect.north);
    if (east < west) east += 360; // 日付変更線またぎ
    const lonSpan = east - west, latSpan = north - south;
    if (!(lonSpan > 0) || !(latSpan > 0)) return { type: "FeatureCollection", features };
    const step = niceStep(Math.max(lonSpan, latSpan) / 8);
    const NSEG = 24;
    const lonStart = Math.ceil(west / step) * step;
    for (let lon = lonStart; lon <= east; lon += step) {
      const coords = [];
      for (let i = 0; i <= NSEG; i++) coords.push([lon, south + latSpan * i / NSEG]);
      features.push({ type: "Feature", properties: { kind: "grat" }, geometry: { type: "LineString", coordinates: coords } });
      const lonShow = ((lon % 360) + 540) % 360 - 180;
      features.push({ type: "Feature", properties: { kind: "grat-label", text: `${Math.abs(lonShow).toFixed(step < 1 ? 2 : 0)}°${lonShow >= 0 ? "E" : "W"}` }, geometry: { type: "Point", coordinates: [lon, south + latSpan * 0.02] } });
    }
    const latStart = Math.ceil(south / step) * step;
    for (let lat = latStart; lat <= north; lat += step) {
      const coords = [];
      for (let i = 0; i <= NSEG; i++) coords.push([west + lonSpan * i / NSEG, lat]);
      features.push({ type: "Feature", properties: { kind: "grat" }, geometry: { type: "LineString", coordinates: coords } });
      features.push({ type: "Feature", properties: { kind: "grat-label", text: `${Math.abs(lat).toFixed(step < 1 ? 2 : 0)}°${lat >= 0 ? "N" : "S"}` }, geometry: { type: "Point", coordinates: [west + lonSpan * 0.02, lat] } });
    }
    return { type: "FeatureCollection", features };
  }

  function refreshGraticule() {
    gratOverlay.update(buildGraticuleFc());
  }

  function setGraticule(on) {
    graticuleOn = !!on;
    const cb = $("#display-graticule");
    if (cb && cb.checked !== graticuleOn) cb.checked = graticuleOn;
    refreshGraticule();
  }

  function scheduleGraticule() {
    if (!graticuleOn) return;
    clearTimeout(gratTimer);
    gratTimer = setTimeout(refreshGraticule, 150);
  }

  // 表示>一般のチェックボックス（または tools-general-panel 内注入分）と連動
  document.querySelector("#display-graticule")?.addEventListener("change", e => setGraticule(e.target.checked));

  // ---------- レイヤーエクスポート ----------
  function refreshExportOptions() {
    const sel = $("#tool-export-layer");
    if (!sel) return;
    const cur = sel.value;
    const items = (hooks.getOrderedLayerItems?.() || []).filter(item => hooks.isVectorLayerItem && hooks.isVectorLayerItem(item));
    sel.replaceChildren();
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = t("tools.exportLayer");
    sel.append(ph);
    for (const item of items) {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = (item.title || item.id) + (hooks.isQueryLayerItem && hooks.isQueryLayerItem(item) ? " *" : "");
      sel.append(o);
    }
    if (cur && items.some(i => i.id === cur)) sel.value = cur;
  }

  // レイヤー → ファイル出力の共通処理。UI ボタンと外部 API（exportLayer）で共用。
  // idOrTitle はレイヤー id またはタイトルを受け付ける
  async function doExport(idOrTitle, format = "geojson") {
    const item = idOrTitle && (hooks.getOrderedLayerItems?.() || []).find(i => i.id === idOrTitle || i.title === idOrTitle);
    const gj = item && hooks.getLayerGeoJson && hooks.getLayerGeoJson(item.id);
    const res = gj && await exportFeatureCollection(gj, format, fileSafe(item.title || item.id));
    if (!res) return { ok: false };
    const file = `${fileSafe(item.title || item.id)}.${res.ext}`;
    downloadBlob(res.data, file, res.mime);
    return { ok: true, file, count: res.count, skipped: res.skipped || 0 };
  }

  if (panelRoot) {
    panelRoot.querySelector("#tool-export-layer")?.addEventListener("focus", refreshExportOptions);
    panelRoot.querySelector("#tool-export-run")?.addEventListener("click", async () => {
      const sel = $("#tool-export-layer");
      const fmtSel = $("#tool-export-format");
      const st = $("#tool-export-status");
      try {
        const res = await doExport(sel && sel.value, (fmtSel && fmtSel.value) || "geojson");
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

    // ---------- モードボタン ----------
    panelRoot.querySelector("#tool-m-distance")?.addEventListener("click", () => setMode(mode === "distance" ? null : "distance"));
    panelRoot.querySelector("#tool-m-area")?.addEventListener("click", () => setMode(mode === "area" ? null : "area"));
    panelRoot.querySelector("#tool-m-bearing")?.addEventListener("click", () => setMode(mode === "bearing" ? null : "bearing"));
    panelRoot.querySelector("#tool-profile-draw")?.addEventListener("click", () => setMode(mode === "profile" ? null : "profile"));
    panelRoot.querySelector("#tool-los")?.addEventListener("click", () => setMode(mode === "los" ? null : "los"));
    panelRoot.querySelector("#tool-clear")?.addEventListener("click", clearAll);
  }
  refreshExportOptions();

  // ---------- 外部 API（kasugaiApi / AI ツール向け） ----------
  const toLngLats = coords => (coords || [])
    .map(c => Array.isArray(c) ? { lng: Number(c[0]), lat: Number(c[1]) } : { lng: Number(c.lng ?? c.longitude), lat: Number(c.lat ?? c.latitude) })
    .filter(c => Number.isFinite(c.lng) && Number.isFinite(c.lat));

  function drawApiLine(line) {
    mode = null;
    pts = line;
    hoverPt = null;
    updateModeButtons();
  }

  return {
    handleClick,
    handleDoubleClick,
    handleMouseMove,
    isActive: () => !!mode,
    setGraticule,
    isGraticule: () => graticuleOn,
    scheduleGraticule,
    clearAll,
    refreshExportOptions,
    exportLayer: (idOrTitle, format = "geojson") => doExport(idOrTitle, format),

    measureDistance(coords) {
      const line = toLngLats(coords);
      if (line.length < 2) return { ok: false, reason: "need >= 2 points" };
      const segments = [];
      let total = 0;
      for (let i = 1; i < line.length; i++) {
        const d = segDistance(line[i - 1], line[i]);
        segments.push(d);
        total += d;
      }
      drawApiLine(line);
      pushOverlay();
      if (resultEl()) resultEl().textContent = t("tools.distanceTotal", { value: fmtDist(total) });
      return { ok: true, totalMeters: total, segmentsMeters: segments };
    },

    measureArea(coords) {
      const line = toLngLats(coords);
      if (line.length < 3) return { ok: false, reason: "need >= 3 points" };
      let perim = segDistance(line[line.length - 1], line[0]);
      for (let i = 1; i < line.length; i++) perim += segDistance(line[i - 1], line[i]);
      const area = polygonArea(line);
      drawApiLine(line);
      // poly は mode==="area" 時のみ描画されるため、FC を直接組み立てる
      const fc = buildOverlayFc();
      fc.features.unshift({ type: "Feature", properties: { kind: "poly" }, geometry: { type: "Polygon", coordinates: [[...line, line[0]].map(p => [p.lng, p.lat])] } });
      overlay.update(fc);
      if (resultEl()) resultEl().textContent = t("tools.areaResult", { area: fmtArea(area), perimeter: fmtDist(perim) });
      return { ok: true, squareMeters: area, perimeterMeters: perim };
    },

    measureBearing(from, to) {
      const line = toLngLats([from, to]);
      if (line.length < 2) return { ok: false, reason: "need 2 points" };
      const g = geodesicInverse(line[0], line[1]);
      drawApiLine(line);
      pushOverlay([{ type: "Feature", properties: { kind: "label", text: `${g.az1.toFixed(1)}°` }, geometry: { type: "Point", coordinates: [(line[0].lng + line[1].lng) / 2, (line[0].lat + line[1].lat) / 2] } }]);
      const result = {
        ok: true,
        startHeadingDeg: g.az1,
        endHeadingDeg: g.az2,
        distanceMeters: g.dist,
      };
      if (resultEl()) {
        resultEl().textContent = t("tools.bearingResult", {
          bearing: result.startHeadingDeg.toFixed(1),
          back: result.endHeadingDeg.toFixed(1),
          dist: fmtDist(result.distanceMeters),
        });
      }
      return result;
    },

    async elevationProfile(coords, samples) {
      const line = toLngLats(coords);
      if (line.length < 2) return { ok: false, reason: "need >= 2 points" };
      drawApiLine(line);
      pushOverlay();
      if (samples != null) {
        const inp = $("#tool-profile-samples");
        if (inp) inp.value = String(Math.round(Number(samples)));
      }
      const res = await runProfile(line);
      return res ? { ok: true, ...res } : { ok: false, reason: "elevation unavailable" };
    },

    async lineOfSight(from, to, opts = {}) {
      const line = toLngLats([from, to]);
      if (line.length < 2) return { ok: false, reason: "need 2 points" };
      const hA = Number.isFinite(Number(opts.observerHeight)) ? Number(opts.observerHeight) : 0;
      const hB = Number.isFinite(Number(opts.targetHeight)) ? Number(opts.targetHeight) : 0;
      const res = await runLos(line[0], line[1], hA, hB);
      drawLosResult(res);
      if (losResultEl()) {
        losResultEl().textContent = res.blocked < 0
          ? t("tools.losVisible", { dist: fmtDist(res.total) })
          : t("tools.losBlocked", { dist: fmtDist(res.points[res.blocked].dist) });
      }
      return {
        ok: true,
        visible: res.blocked < 0,
        distanceMeters: res.total,
        blockedAt: res.blocked >= 0 ? { lat: res.points[res.blocked].lat, lng: res.points[res.blocked].lng, distanceMeters: res.points[res.blocked].dist } : null,
      };
    },
  };
}
