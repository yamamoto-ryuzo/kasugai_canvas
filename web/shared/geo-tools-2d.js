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
import { initToolsDockUX, notifyToolMode } from "./tools-dock-ux.js";
import { exportFeatureCollection } from "./export-formats.js";
import { collectFields } from "./attr-stats.js";
import {
  geodesicInverse, segDistance, polygonArea, slerp, WGS84_A,
  selectFeatures, aggregateWithin as aggregateInRegion, bufferGeometry,
  circlePolygon, rectPolygon, normalizeRegion, geomBbox,
} from "./spatial-ops.js";

const MIN_POINT_SPACING_M = 2; // ダブルクリック終了時に同一点が二重追加されるのを防ぐ間隔

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
/* ツールドック: 画面上部中央の横並びツールバー + ドロップダウン式パネル。
   左パネル(#panel, 幅336px+左14px)を避けて空き領域の中央に置く */
#tools-dock { position: fixed; z-index: 2000; top: 14px; left: calc(50% + 175px); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; max-width: calc(100vw - 380px); user-select: text; }
body:has(#panel.collapsed) #tools-dock { left: 50%; }
#tools-bar { display: flex; flex-wrap: wrap; justify-content: center; gap: 3px; padding: 6px 8px; border: 1px solid #d9e4e9; border-radius: 8px; background: rgba(255,255,255,.6); box-shadow: 0 8px 18px rgba(10,20,40,.16); }
#tools-bar .settings-tab { min-height: 26px; padding: 4px 7px; border: 0; border-radius: 4px; background: transparent; color: #52636d; cursor: pointer; font-size: 18px; }
#tools-bar .settings-tab.active { background: rgba(49,86,79,.16); color: #31564f; font-weight: 700; }
#tools-panel { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: 6px; width: min(400px, 92vw); max-height: min(60vh, 520px); overflow-y: auto; overflow-x: hidden; padding: 10px; border: 1px solid #d9e4e9; border-radius: 8px; background: rgba(255,255,255,.92); box-shadow: 0 12px 30px rgba(10,20,40,.24); box-sizing: border-box; font-size: 16px; }
#tools-panel button { min-height: 30px; padding: 5px 8px; border: 1px solid #31564f; border-radius: 4px; background: #31564f; color: #fff; cursor: pointer; font-size: 16px; }
#tools-panel .danger-button { border-color: #a82020; background: #a82020; }
#tools-panel select, #tools-panel input[type="text"], #tools-panel input[type="number"] { min-height: 30px; padding: 5px 7px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; color: #1d2b35; box-sizing: border-box; }
@media (max-width: 700px) { #tools-dock { left: 50%; max-width: calc(100vw - 28px); } }
/* 対話モード中の1行チップ: テキスト部分はクリックスルー、ボタンのみ操作可 */
#tools-chip { margin-top: 6px; display: flex; align-items: center; gap: 6px; max-width: min(420px, 92vw); padding: 4px 6px 4px 10px; border: 1px solid #d9e4e9; border-radius: 999px; background: rgba(255,255,255,.85); box-shadow: 0 8px 18px rgba(10,20,40,.16); pointer-events: none; box-sizing: border-box; font-size: 13px; }
#tools-chip[hidden] { display: none; }
#tools-chip .chip-dot { flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%; background: #31564f; }
#tools-chip.running .chip-dot { background: #e07b00; animation: tools-chip-pulse 1.2s ease-in-out infinite; }
@keyframes tools-chip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
#tools-chip-label { flex: 0 0 auto; font-weight: 700; font-size: 12px; color: #31564f; white-space: nowrap; }
#tools-chip-result { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #1d2b35; }
#tools-chip button { pointer-events: auto; flex: 0 0 24px; min-width: 24px; min-height: 24px; padding: 0; border: 1px solid rgba(49,86,79,.35); border-radius: 50%; background: rgba(255,255,255,.8); color: #31564f; font-size: 12px; line-height: 1; cursor: pointer; }
#tools-chip button:hover { background: rgba(49,86,79,.14); }
/* collapsed 状態: バーごと非表示（再表示はレイヤパネルの #tools-open） */
#tools-dock.collapsed #tools-bar { display: none; }
#tools-open { padding: 0; font-size: 22px; display: inline-flex; align-items: center; justify-content: center; }
#tools-open.active { background: rgba(49,86,79,.42) !important; }
#tools-panel .tool-btnrow { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-bottom: 3px; }
#tools-panel .tool-btnrow button { flex: 0 0 auto; }
#tools-panel .tool-btnrow button.tool-on { border-color: #31564f; background: #31564f; color: #fff; }
#tools-panel .tool-inline { display: inline-flex; align-items: center; gap: 4px; font-size: 0.85em; color: #52636d; }
#tools-panel .tool-inline input[type="number"] { width: 64px; min-height: 28px; padding: 3px 5px; border: 1px solid #cbd9de; border-radius: 4px; box-sizing: border-box; }
#tools-panel .tool-result { min-height: 18px; margin: 3px 0 6px; font-size: 0.9em; color: #1d2b35; overflow-wrap: anywhere; }
#tools-panel .tool-btnrow select, #tools-panel .tool-btnrow input[type="text"] { flex: 1; min-width: 0; min-height: 30px; padding: 4px 6px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; font-size: 0.9em; box-sizing: border-box; }
#tools-panel #tools-draw-list { margin: 3px 0; padding: 0; list-style: none; max-height: 150px; overflow-y: auto; overflow-x: hidden; font-size: 0.85em; }
#tools-panel #tools-draw-list li { display: flex; align-items: center; gap: 4px; padding: 2px 0; border-bottom: 1px solid #e4ecef; }
#tools-panel #tools-draw-list li .draw-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#tools-panel #tools-draw-list li button { flex: 0 0 auto; }
#tools-panel .tool-result table { border-collapse: collapse; font-size: 0.85em; width: 100%; }
#tools-panel .tool-result th, #tools-panel .tool-result td { border: 1px solid #d5e2e6; padding: 2px 5px; text-align: right; overflow-wrap: anywhere; }
#tools-panel .tool-result th { background: #f0f5f7; text-align: left; }
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

// ツールドックの DOM（cesium/index.html と同じ id 体系・data-i18n キー）。
// 画面上部中央の横並びバー(#tools-bar) + ドロップダウン(#tools-panel) を body に生成する
function injectDock(sections) {
  const parts = [];
  const nav = [];
  if (sections.measure) nav.push(['tools-measure-panel', 'tools.measure', '計測']);
  if (sections.spatial) nav.push(['tools-spatial-panel', 'tools.spatial', '選択・集計']);
  if (sections.draw) nav.push(['tools-draw-panel', 'tools.draw', '作図']);
  if (sections.profile) nav.push(['tools-profile-panel', 'tools.profile', '標高断面']);
  if (sections.los) nav.push(['tools-los-panel', 'tools.los', '見通し判定']);
  if (sections.export) nav.push(['tools-export-panel', 'tools.export', 'エクスポート']);
  if (sections.print) nav.push(['tools-print-panel', 'print.open', '印刷']);
  if (sections.general) nav.push(['tools-general-panel', 'display.ariaLabel', '表示']);
  const bar = nav.map(([id, key, ja]) =>
    `<button class="settings-tab" type="button" data-settings-panel="${id}" data-i18n="${key}">${ja}</button>`).join("");
  const hideAttr = () => " hidden";
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
  if (sections.spatial) parts.push(`
    <section id="tools-spatial-panel" class="settings-subpanel"${hideAttr("tools-spatial-panel")}>
      <p class="hint" data-i18n="tools.selHint">矩形・ポリゴン・円で範囲を描き、範囲内の地物を選択・集計します。</p>
      <div class="tool-btnrow">
        <button id="tool-sel-rect" type="button" data-i18n="tools.selRect">矩形</button>
        <button id="tool-sel-poly" type="button" data-i18n="tools.selPoly">ポリゴン</button>
        <button id="tool-sel-circle" type="button" data-i18n="tools.selCircle">円</button>
        <label class="tool-inline"><span data-i18n="tools.selRadius">半径m</span><input id="tool-sel-radius" type="number" min="1" value="500" /></label>
      </div>
      <div class="tool-btnrow">
        <select id="tool-sel-layer"></select>
        <button id="tool-sel-run" type="button" data-i18n="tools.selRun">選択</button>
      </div>
      <div id="tools-sel-result" class="tool-result" aria-live="polite"></div>
      <div class="tool-btnrow">
        <button id="tool-sel-tolayer" type="button" data-i18n="tools.selToLayer">選択をレイヤー化</button>
        <button id="tool-sel-zoom" type="button" data-i18n="tools.selZoom">範囲へ移動</button>
        <button id="tool-sel-clear" type="button" class="danger-button" data-i18n="tools.selClear">解除</button>
      </div>
      <p class="hint" data-i18n="tools.aggHint">直近の選択範囲内の地物を集計します。</p>
      <div class="tool-btnrow">
        <select id="tool-agg-group"></select>
        <select id="tool-agg-value"></select>
        <button id="tool-agg-run" type="button" data-i18n="tools.aggRun">集計</button>
      </div>
      <div id="tools-agg-result" class="tool-result"></div>
      <p class="hint" data-i18n="tools.bufHint">直近の範囲・地物にバッファを生成し新規レイヤーにします。</p>
      <div class="tool-btnrow">
        <label class="tool-inline"><span data-i18n="tools.bufRadius">距離m</span><input id="tool-buf-radius" type="number" value="100" /></label>
        <button id="tool-buf-run" type="button" data-i18n="tools.bufRun">バッファ生成</button>
      </div>
    </section>`);
  if (sections.draw) parts.push(`
    <section id="tools-draw-panel" class="settings-subpanel"${hideAttr("tools-draw-panel")}>
      <div class="tool-btnrow">
        <button id="tool-draw-point" type="button" data-i18n="tools.drawPoint">ポイント</button>
        <button id="tool-draw-line" type="button" data-i18n="tools.drawLine">ライン</button>
        <button id="tool-draw-poly" type="button" data-i18n="tools.drawPoly">ポリゴン</button>
        <button id="tool-draw-label" type="button" data-i18n="tools.drawLabel">注記</button>
      </div>
      <div class="tool-btnrow">
        <input id="tool-draw-name" type="text" data-i18n-attr="placeholder:tools.drawName" placeholder="名称" />
        <button id="tool-draw-clear" type="button" class="danger-button" data-i18n="tools.drawClear">全削除</button>
      </div>
      <ul id="tools-draw-list"></ul>
      <div class="tool-btnrow">
        <button id="tool-draw-tolayer" type="button" data-i18n="tools.drawToLayer">レイヤーへ追加</button>
        <button id="tool-draw-export" type="button" data-i18n="tools.drawExport">GeoJSON保存</button>
      </div>
      <p class="hint" data-i18n="tools.drawHint">描いた図形に名称を付けて残せます。「レイヤーへ追加」で一覧・表示切替対象の一時レイヤーにします。</p>
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
  if (sections.print) parts.push(`
    <section id="tools-print-panel" class="settings-subpanel"${hideAttr("tools-print-panel")}>
      <p class="hint" data-i18n="print.panelHint">地図画像にタイトル・凡例・縮尺バー等を合成して印刷/PNG出力します。</p>
      <div class="tool-btnrow">
        <button id="print-open" type="button" data-i18n="print.open">印刷</button>
      </div>
    </section>`);
  if (sections.general) parts.push(`
    <section id="tools-general-panel" class="settings-subpanel"${hideAttr("tools-general-panel")}>
      <label class="set-row"><input id="display-minimap" type="checkbox" /><span data-i18n="display.minimap"> ミニマップを表示</span></label>
      <label class="set-row"><input id="display-graticule" type="checkbox" /><span data-i18n="display.graticule"> 緯度経度グリッド</span></label>
    </section>`);
  const dock = document.createElement("div");
  dock.id = "tools-dock";
  dock.className = "collapsed"; // 初期は非表示。レイヤパネルの #tools-open で開く
  dock.innerHTML = `<nav id="tools-bar" class="settings-tabs" aria-label="Tools">${bar}</nav><div id="tools-panel" hidden>${parts.join("")}</div>`;
  document.body.append(dock);
  // バーのボタンで対応サブパネルのドロップダウンを開閉。開いている同じボタンの再クリックで畳む
  const drop = dock.querySelector("#tools-panel");
  const closeDrop = () => {
    if (drop) drop.hidden = true;
    dock.querySelectorAll("[data-settings-panel]").forEach(x => x.classList.remove("active"));
  };
  dock.querySelector("#tools-bar")?.addEventListener("click", e => {
    const b = e.target.closest("[data-settings-panel]");
    if (!b || !drop) return;
    const id = b.dataset.settingsPanel;
    const reopen = !drop.hidden && dock.dataset.openTab === id;
    dock.querySelectorAll("[data-settings-panel]").forEach(x => x.classList.toggle("active", x === b));
    drop.querySelectorAll(".settings-subpanel").forEach(p => { p.hidden = p.id !== id; });
    if (reopen) closeDrop();
    else { drop.hidden = false; dock.dataset.openTab = id; }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && drop && !drop.hidden) closeDrop();
  });
  initToolsDockUX(dock);
  void initI18n().then(() => applyI18n(dock));
  return dock;
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
      style: f => {
        const p = f.properties || {};
        const base = LINE_STYLE[p.kind] || { color: "#ffff00", weight: 2 };
        const c = p.color || base.color;
        return { ...base, color: c, fillColor: c, fillOpacity: base.fillOpacity ?? 0.25 };
      },
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
  const addDataLayer = (title, gj) => hooks.addDataLayer
    ? hooks.addDataLayer(title, gj)
    : (window.kasugaiApi?.addDataLayer ? window.kasugaiApi.addDataLayer(title, gj) : Promise.resolve(null));
  const DEFAULT_SECTIONS = { measure: true, spatial: true, draw: true, profile: true, los: true, export: true, print: true, general: false };
  const sections = { ...DEFAULT_SECTIONS, ...(hooks.sections || {}) };

  // ツールドック（画面上部中央の横並びバー + ドロップダウン）を body に生成
  const panelRoot = injectDock(sections);

  // ---------- 対話モード ----------
  // mode: null | "distance" | "area" | "bearing" | "profile" | "los"
  //       | "sel-rect" | "sel-poly" | "sel-circle"
  //       | "draw-point" | "draw-line" | "draw-poly" | "draw-label"
  let mode = null;
  let pts = [];        // 確定頂点 [{lng,lat}]
  let hoverPt = null;  // カーソル位置のプレビュー点
  let losRunning = false;
  let profileRunning = false;
  let profileHover = null;
  // 空間選択・集計・バッファの状態
  let regionGeom = null;       // 直近に確定した選択範囲（Polygon|MultiPolygon）
  let regionSourceGeom = null; // バッファ対象の元ジオメトリ（円選択なら中心点）
  let selFeatures = [];        // 直近の選択結果 Feature[]
  let selLayerLabel = "";
  const annotations = [];      // 作図確定分 [{name, geometry}]
  const SEL_COLOR = "#ff00ff";   // 選択ハイライト
  const REGION_COLOR = "#00bfff";// 範囲
  const DRAW_COLOR = "#ff9100";  // 作図

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
    setCursor(mode ? "crosshair" : "");
    setInteractive(!!mode);
    // ツールドック: 対話モード中はドロップダウンを畳み1行チップへ縮退する
    notifyToolMode(mode);
  }

  // 現在状態 → オーバーレイ FC
  function buildOverlayFc() {
    const features = [];
    const positions = currentPositions();
    const isPick = mode && (mode.startsWith("sel-") || mode.startsWith("draw-"));
    const lineColor = mode === "los" ? "los-line" : "line";
    const lineProp = { kind: lineColor };
    if (isPick) lineProp.color = DRAW_COLOR;
    if (positions.length >= 2) {
      features.push({ type: "Feature", properties: lineProp, geometry: { type: "LineString", coordinates: positions.map(p => [p.lng, p.lat]) } });
    }
    if ((mode === "area" || mode === "sel-poly" || mode === "draw-poly") && positions.length >= 3) {
      features.push({ type: "Feature", properties: isPick ? { kind: "poly", color: DRAW_COLOR } : { kind: "poly" }, geometry: { type: "Polygon", coordinates: [[...positions, positions[0]].map(p => [p.lng, p.lat])] } });
    }
    if (mode === "sel-rect" && pts.length === 1 && positions.length >= 2) {
      const a = pts[0], b = positions[positions.length - 1];
      features.push({ type: "Feature", properties: { kind: "poly", color: DRAW_COLOR }, geometry: rectPolygon(Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)) });
    }
    for (const p of pts) features.push({ type: "Feature", properties: isPick ? { kind: "point", color: DRAW_COLOR } : { kind: "point" }, geometry: { type: "Point", coordinates: [p.lng, p.lat] } });
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
    // 確定済みの選択範囲・選択ハイライト・作図
    if (regionGeom) features.push({ type: "Feature", properties: { kind: "poly", color: REGION_COLOR }, geometry: regionGeom });
    for (const f of selFeatures.slice(0, 500)) {
      features.push({ type: "Feature", properties: { kind: f?.geometry?.type === "Point" ? "point" : (/Polygon/.test(f?.geometry?.type || "") ? "poly" : "line"), color: SEL_COLOR }, geometry: f.geometry });
    }
    for (const a of annotations) {
      const props = { kind: a.geometry.type === "Point" ? "point" : (/Polygon/.test(a.geometry.type) ? "poly" : "line"), color: DRAW_COLOR };
      if (a.name && a.geometry.type === "Point") props.text = a.name;
      features.push({ type: "Feature", properties: props, geometry: a.geometry });
    }
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
    pushOverlay(); // 確定済みの範囲・選択・作図は残したまま描画だけ再構成
    if (resultEl()) resultEl().textContent = "";
    if (losResultEl()) losResultEl().textContent = "";
    const box = $("#profile-box");
    if (box) box.hidden = true;
    updateModeButtons();
  }

  function setMode(next) {
    clearAll();
    mode = next;
    if (next && resultEl() && !String(next).startsWith("sel-") && !String(next).startsWith("draw-")) {
      resultEl().textContent = t(next === "los" ? "tools.losHint" : "tools.measureHint");
    }
    updateModeButtons();
    updateSelHint();
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

  // 選択・作図モードのヒント（sel-result 側に出す）
  function updateSelHint() {
    const el = selResultEl();
    if (!el || !mode) return;
    if (mode === "sel-rect") el.textContent = t(pts.length ? "tools.selRectSecond" : "tools.selRectHint");
    else if (mode === "sel-poly") el.textContent = t("tools.selPolyHint");
    else if (mode === "sel-circle") el.textContent = t("tools.selCircleHint");
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

  // ---------- 空間選択・集計・バッファ ----------
  const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function setRegion(geom, sourceGeom) {
    regionGeom = geom;
    regionSourceGeom = sourceGeom || geom;
    mode = null;
    pts = [];
    hoverPt = null;
    updateModeButtons();
    pushOverlay();
    if (geom && selResultEl()) selResultEl().textContent = t("tools.selRegionSet");
    refreshAggFieldOptions();
  }

  function clearSelection() {
    regionGeom = null;
    regionSourceGeom = null;
    selFeatures = [];
    selLayerLabel = "";
    if (selResultEl()) selResultEl().textContent = "";
    if (aggResultEl()) aggResultEl().textContent = "";
    pushOverlay();
  }

  function vectorLayers() {
    return (hooks.getOrderedLayerItems?.() || []).filter(item => hooks.isVectorLayerItem && hooks.isVectorLayerItem(item));
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
      const gj = hooks.getLayerGeoJson && hooks.getLayerGeoJson(item.id);
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

  function doSpatialSelect(regionOverride) {
    const region = regionOverride || regionGeom;
    if (!region) { if (selResultEl()) selResultEl().textContent = t("tools.selNoRegion"); return null; }
    const feats = selectFeatures(mergedTargetFc(), region);
    if (!regionOverride) {
      selFeatures = feats;
      selLayerLabel = targetLayerItems().map(i => i.title || i.id).join(", ");
      pushOverlay();
    }
    refreshAggFieldOptions();
    const el = selResultEl();
    if (el && !regionOverride) {
      if (!feats.length) el.textContent = t("tools.selNoFeatures");
      else {
        const names = feats.slice(0, 12).map(f => f.properties?.name ?? f.properties?.Name ?? f.properties?.名称 ?? f.properties?.id ?? "").filter(v => v !== "");
        el.textContent = t("tools.selResult", { count: feats.length, layer: selLayerLabel })
          + (names.length ? ` — ${names.join(", ")}${feats.length > names.length ? "…" : ""}` : "");
      }
    }
    return feats;
  }

  function doAggregate(regionOverride) {
    const region = regionOverride || regionGeom;
    if (!region) { if (aggResultEl()) aggResultEl().textContent = t("tools.selNoRegion"); return null; }
    const groupField = $("#tool-agg-group")?.value || null;
    const valueField = $("#tool-agg-value")?.value || null;
    const { rows } = aggregateInRegion(mergedTargetFc(), region, { groupField, valueField });
    const el = aggResultEl();
    if (el && !regionOverride) {
      if (!rows.length || (rows.length === 1 && !rows[0].count)) {
        el.textContent = t("tools.selNoFeatures");
      } else {
        const fmtN = v => v == null ? "-" : (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Math.round(v * 100) / 100).toLocaleString();
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
      const added = await addDataLayer(title, fc);
      // 生成したバッファは新しい選択範囲としても使えるよう保持
      regionGeom = geoms.length === 1 ? geoms[0]
        : { type: "MultiPolygon", coordinates: geoms.flatMap(g => g.type === "Polygon" ? [g.coordinates] : g.coordinates) };
      regionSourceGeom = regionGeom;
      selFeatures = [];
      pushOverlay();
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
    annotations.push({ name, geometry });
    renderDrawList();
    pushOverlay();
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
      del.addEventListener("click", () => { annotations.splice(i, 1); renderDrawList(); pushOverlay(); });
      li.append(span, del);
      ul.append(li);
    });
  }

  const annotationsFc = () => ({
    type: "FeatureCollection",
    features: annotations.map(a => ({ type: "Feature", properties: { name: a.name }, geometry: a.geometry })),
  });

  // ---------- 入力ハンドラ（エンジンのイベントから呼ばれる） ----------
  function handleClick(lngLat) {
    if (!mode) return false;
    // 円選択は中心1クリックで確定（半径はパネル入力）
    if (mode === "sel-circle") {
      const c = { lng: Number(lngLat.lng ?? lngLat[0]), lat: Number(lngLat.lat ?? lngLat[1]) };
      if (Number.isFinite(c.lng) && Number.isFinite(c.lat)) {
        const r = Math.max(1, num($("#tool-sel-radius"), 500));
        setRegion(circlePolygon(c, r), { type: "Point", coordinates: [c.lng, c.lat] });
      }
      return true;
    }
    addPoint(lngLat);
    updateSelHint();
    // 矩形選択は2点確定
    if (mode === "sel-rect" && pts.length >= 2) {
      const a = pts[0], b = pts[1];
      setRegion(rectPolygon(Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)));
      return true;
    }
    // ポイント作図・注記はクリックごとに確定（連続配置できるようモード維持）
    if ((mode === "draw-point" || mode === "draw-label") && pts.length) {
      const p = pts[pts.length - 1];
      addAnnotation({ type: "Point", coordinates: [p.lng, p.lat] });
      pts = [];
      hoverPt = null;
      pushOverlay();
      return true;
    }
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
    if (mode === "sel-poly") {
      if (pts.length >= 3) {
        const ring = pts.map(p => [p.lng, p.lat]);
        ring.push([...ring[0]]);
        setRegion({ type: "Polygon", coordinates: [ring] });
      }
      return true;
    }
    if (mode === "draw-line") {
      if (pts.length >= 2) {
        addAnnotation({ type: "LineString", coordinates: pts.map(p => [p.lng, p.lat]) });
        pts = [];
        hoverPt = null;
        pushOverlay();
      }
      return true;
    }
    if (mode === "draw-poly") {
      if (pts.length >= 3) {
        const ring = pts.map(p => [p.lng, p.lat]);
        ring.push([...ring[0]]);
        addAnnotation({ type: "Polygon", coordinates: [ring] });
        pts = [];
        hoverPt = null;
        pushOverlay();
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

    // 空間選択・集計・バッファ
    panelRoot.querySelector("#tool-sel-rect")?.addEventListener("click", () => setMode(mode === "sel-rect" ? null : "sel-rect"));
    panelRoot.querySelector("#tool-sel-poly")?.addEventListener("click", () => setMode(mode === "sel-poly" ? null : "sel-poly"));
    panelRoot.querySelector("#tool-sel-circle")?.addEventListener("click", () => setMode(mode === "sel-circle" ? null : "sel-circle"));
    panelRoot.querySelector("#tool-sel-layer")?.addEventListener("focus", refreshSelLayerOptions);
    panelRoot.querySelector("#tool-sel-layer")?.addEventListener("change", refreshAggFieldOptions);
    panelRoot.querySelector("#tool-sel-run")?.addEventListener("click", () => doSpatialSelect());
    panelRoot.querySelector("#tool-sel-clear")?.addEventListener("click", clearSelection);
    panelRoot.querySelector("#tool-sel-zoom")?.addEventListener("click", () => {
      const box = geomBbox(regionGeom);
      if (box) hooks.fitBounds?.(box);
    });
    panelRoot.querySelector("#tool-sel-tolayer")?.addEventListener("click", async () => {
      if (!selFeatures.length) { if (selResultEl()) selResultEl().textContent = t("tools.selNoFeatures"); return; }
      const fc = { type: "FeatureCollection", features: selFeatures.map(f => ({ type: "Feature", properties: { ...(f.properties || {}) }, geometry: f.geometry })) };
      await addDataLayer(`${t("tools.selLayerName")}（${selFeatures.length}）`, fc);
      if (selResultEl()) selResultEl().textContent = t("tools.selToLayerDone", { count: selFeatures.length });
    });
    panelRoot.querySelector("#tool-agg-run")?.addEventListener("click", () => doAggregate());
    panelRoot.querySelector("#tool-buf-run")?.addEventListener("click", () => void doBuffer());

    // 作図・注記
    panelRoot.querySelector("#tool-draw-point")?.addEventListener("click", () => setMode(mode === "draw-point" ? null : "draw-point"));
    panelRoot.querySelector("#tool-draw-line")?.addEventListener("click", () => setMode(mode === "draw-line" ? null : "draw-line"));
    panelRoot.querySelector("#tool-draw-poly")?.addEventListener("click", () => setMode(mode === "draw-poly" ? null : "draw-poly"));
    panelRoot.querySelector("#tool-draw-label")?.addEventListener("click", () => setMode(mode === "draw-label" ? null : "draw-label"));
    panelRoot.querySelector("#tool-draw-clear")?.addEventListener("click", () => { annotations.length = 0; renderDrawList(); pushOverlay(); });
    panelRoot.querySelector("#tool-draw-export")?.addEventListener("click", () => {
      if (!annotations.length) return;
      downloadBlob(JSON.stringify(annotationsFc()), `${fileSafe(t("tools.drawLayerTitle"))}.geojson`, "application/geo+json");
    });
    panelRoot.querySelector("#tool-draw-tolayer")?.addEventListener("click", async () => {
      if (!annotations.length) return;
      await addDataLayer(t("tools.drawLayerTitle"), annotationsFc());
      annotations.length = 0;
      renderDrawList();
      pushOverlay();
    });
  }
  refreshExportOptions();
  refreshSelLayerOptions();

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

    // 空間選択（#23）: region は GeoJSON Polygon/MultiPolygon/Feature、
    // {bbox:[w,s,e,n]}、{center:[lng,lat]|{lng,lat}, radiusMeters} を受け付ける
    spatialSelect(opts = {}) {
      // 範囲指定が無ければ直近に描画/生成した範囲を使う
      const raw = opts.region ?? opts.geometry ?? opts.polygon ?? opts.bbox ?? (opts.center ? opts : null);
      const region = raw ? normalizeRegion(raw) : regionGeom;
      if (!region) return { ok: false, reason: "invalid region" };
      const items = opts.layer
        ? vectorLayers().filter(i => i.id === opts.layer || i.title === opts.layer)
        : vectorLayers();
      const hits = [];
      for (const item of items) {
        const gj = hooks.getLayerGeoJson && hooks.getLayerGeoJson(item.id);
        for (const f of selectFeatures(gj, region)) hits.push({ layer: item.title || item.id, feature: f });
      }
      regionGeom = region;
      regionSourceGeom = region;
      selFeatures = hits.map(h => h.feature);
      selLayerLabel = items.map(i => i.title || i.id).join(", ");
      pushOverlay();
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
        const gj = hooks.getLayerGeoJson && hooks.getLayerGeoJson(item.id);
        if (gj?.features) features.push(...gj.features);
      }
      regionGeom = region;
      regionSourceGeom = region;
      pushOverlay();
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
      else geom = normalizeRegion(opts.region ?? opts.polygon ?? opts.bbox ?? (opts.center ? opts : null));
      const r = Number(opts.radiusMeters ?? opts.radius ?? 0);
      if (!geom) return { ok: false, reason: "no geometry" };
      if (!Number.isFinite(r) || r === 0) return { ok: false, reason: "radiusMeters required" };
      try {
        const bg = await bufferGeometry(geom, r);
        if (!bg) return { ok: false, reason: "buffer failed" };
        const title = opts.title || `buffer ${r}m`;
        const added = await addDataLayer(title, {
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: { name: title }, geometry: bg }],
        });
        regionGeom = bg;
        regionSourceGeom = bg;
        pushOverlay();
        return { ok: !!added, title, id: added?.id };
      } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
      }
    },

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
