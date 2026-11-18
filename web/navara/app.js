// KASUGAI Canvas — Navara フロント（写実 3D プレゼンエンジン）
// @navaramap/three (Rust/WASM + Three.js) で .kasc を再生する。
// vendor dist は同一オリジン必須（Worker が import.meta.url 相対で生成される）。
// UI/共通機構は shared/ を他エンジンと共用する。
import ThreeView, { Color, fetchFontFamilyFromCss, vector3ToGeodetic } from "@navaramap/three";
import { DefaultPlugin } from "@navaramap/three-default-plugin";
import { loadKascProject, NON_LAYER_TYPES, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeight, camToZoomView, zoomToCamHeightView, heightToViewZoom, viewZoomToHeight, parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle, appendGroupedTitleOptions, syncBasemapList, sanitizeAttributionFragment, layerAttribution, loadKascInfoContent, buildWmsTileTemplate, buildWmtsTileTemplate, rewriteKascVisibility, rewriteKascLineVisibility, rewriteKascLineOpt, themeShowSet, fillThemeSelect, kascTitleInTheme, normKascTitle, loadKascBookmarks, parseQgisBookmarksXml, qgisBookmarkToCam, downloadQgisBookmarksXml, downloadKascCamLines, applyPanelTitle, resolveDefaultPointStyle, resolveDefaultLineStyle, resolveDefaultPolygonStyle, cssColorAlpha, setAllLayerGroupsExpanded } from "../shared/kasc.js";
import { createKascPortal } from "../shared/portal.js";
import { compileWhereExpression } from "../shared/where-eval.js";
import { createKascFlyPaths } from "../shared/fly-kasc.js";
import { backendUrl } from "../shared/backend.js";
import { loadVectorItem } from "../shared/vector-load.js";
import { createAttrWidget, renderAttrContent, attrEntriesFromProps } from "../shared/attr-widget.js";
import { initAiChat, hasBackendFeature } from "../shared/ai-chat.js";
import { createPlayerApi } from "../shared/player-api.js";
import { configureLive, configureFollow, liveUpdate, liveNotifyCamera, liveNotifySelection, liveWritebackEntries } from "../shared/live.js";
import { mountEngineSwitcher } from "../shared/engine-switch.js";
import { matchSessionState, bindSessionState, applySessionState, sessionBootView, sessionVisChanges } from "../shared/session-state.js";
import { initNavTools } from "../shared/nav-tools.js";
import { initUiConfig } from "../shared/ui-config.js";
import { formatLatLng } from "../shared/coords-format.js";
import { installLocalCrsUI } from "../shared/coords-local.js";
import { diagnoseHubLayerError } from "../shared/hub-diag.js";
import { createMinimap } from "../shared/minimap.js";
import { initGeoTools2d } from "../shared/geo-tools-2d.js";
import { initPrint } from "../shared/print.js";
import { loadCompiledQml, specToStyle, qmlLegendSwatchDataUrl, defaultVectorLegendSpec, setMapScaleGetter, applyInvertedMaskGeojson, installLayerVisibilityResolver } from "../shared/qml-2d.js";
import { rgbaToCss, markerLayersToCanvas } from "../shared/qml-style.js";
import { renderLayerLegendPicker } from "../shared/legend-tab.js";
import { mountSunControls } from "../shared/sun-time.js";

const TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain";
const VECTOR_TYPES = new Set(["geojson", "layer", "geoparquet", "parquet", "flatgeobuf", "fgb", "gpkg", "geopackage", "csv", "tsv", "duckdb", "sql", "ogrsql", "kml", "kmz", "gpx", "czml", "topojson", "esrijson", "arcgis", "geojsonl", "ndjson", "jsonl", "wkt", "wkb", "igc", "polyline", "gml", "wfs", "shp", "shapefile"]);
const RASTER_TYPES = new Set(["xyz", "tile"]);
// ⏷フィルタ編集の対象（where= またはクエリ全文の再読み込みが効く形式）
const QUERY_TYPES = new Set(["gpkg", "geopackage", "duckdb", "sql", "ogrsql"]);
// ogrsql: 行の FROM 名を、読み込み済みレイヤーの GeoJSON(item._geojson)へ
// 照合するフック。タイトル(正規化・最終セグメント)一致で返し、
// 無ければ null → vector-load 側のファイルパス/QGIS 解決へフォールバック
const vectorHooks = {
  resolveLayer: async name => {
    const n = normKascTitle(name || "");
    for (const e of layerEntries) {
      const it = e?.item;
      if (!it) continue;
      const t = normKascTitle(it.title || "");
      if (t !== n && t.split("/").pop() !== n) continue;
      if (it._geojson) return it._geojson;
      // タイトル一致したが読み込み未完了の場合はソース URL を直接再デコード
      // (sql/ogrsql の item.url はクエリ本文なので対象外)
      if (it.url && it.type !== "sql" && it.type !== "ogrsql") {
        return (await loadVectorItem(it, lastBaseUrl, null)).geojson;
      }
    }
    return null;
  },
};

const $ = s => document.querySelector(s);

const panel = {
  project: $("#project-select"), layers: $("#layers"), cams: $("#cams"),
  camsImportFile: $("#cams-import-file"), camsImportCamFile: $("#cams-import-cam-file"),
  basemap: $("#basemap-ctl"), basemapSelect: $("#basemap-select"),
  legends: $("#legends"), infoLink: $("#info-link"), unsupported: $("#unsupported"),
  themeSelect: $("#theme-select"), searchInput: $("#search-input"),
  searchResults: $("#search-results"), attrContent: $("#attr-content"),
  inspector: $("#inspector-input"), progress: $("#load-progress"),
  progressText: $("#load-progress-text"), progressBar: $("#load-progress-bar"),
  attribution: $("#map-attribution"), coords: $("#map-coords"),
};

const css2hex = (css, fallback = 0x2c5ea8) => {
  try { const c = css2hex._c ||= document.createElement("canvas").getContext("2d"); c.fillStyle = "#000"; c.fillStyle = String(css); const v = c.fillStyle; return v.startsWith("#") ? parseInt(v.slice(1), 16) : fallback; } catch (_) { return fallback; }
};

// ---- Navara 起動 ----
const view = new ThreeView({
  container: document.getElementById("map"), picking: true,
  // 既定は描画負荷を抑える（写実品質は設定ペインで戻せる）
  shadow: false, multisampling: 0, halfFloat: false, logarithmicDepthBuffer: false,
});
const defaultPlugin = new DefaultPlugin();
view.addPlugin(defaultPlugin);
window.kascView = view;

const layerEntries = [];   // {item, sid, src, layer}
// QML 式 is_layer_visible('名前') を item.visible へ解決する(Cesium 版と同規則)
installLayerVisibilityResolver(() => layerEntries.map(e => e.item));
const baseEntries = [];    // 選択中ベースマップ {item, src, layer}
const themes = [];
let baseDocs = [], basemapSrc = null, basemapLayer = null;
let terrainSrc = null, terrainLayer = null, terrainDesc = null;
let terrainExaggeration = 1;
let currentProjectId = "", lastBaseUrl = "", lastKascRaw = "", lastKascUrl = "", currentThemes = [];
let currentCams = [], currentLegends = [], currentDefaultStyles = null;
let lastCam = { lng: 139.767, lat: 35.681, height: 3000, heading: 0, pitch: -45, roll: 0 };
let photorealScene = null;

// ---- ポータル(portal:/html:/view:/link: 行で構成する開始画面) ----
// 行のパースは shared/kasc.js parseKasc が doc.views/htmlSections/links/portal
// へ行うため、ここでは doc → ポータル用リストへの展開結果を保持する
// (Cesium 版 applyInspector の inspectorViews 等と同じ役割)
const inspectorViews = [];
const inspectorHtmlSections = [];
// news: 行で宣言されたお知らせフィード {src, limit, title, line}[](#128)
const inspectorNews = [];
const inspectorLinks = [];
const inspectorPortalCards = [];
let inspectorPortalSpec = null;
let inspectorPanelTitle = null;
// 適用中のビュー名と、適用前スナップショット(ビュー解除で復元)
let activeViewName = null;
let viewSnapshot = null;
// 起動時ポータル自動表示の管理(プロジェクト読込ごとに1回)
let portalAutoOpened = false;

// .kasc fly_geojson: 行 → フライパス（player-api のフックへ展開。
// shared/fly-kasc.js がインスペクタ行の追記・書き戻しも面倒を見る）
const kascFlyPaths = createKascFlyPaths({
  resolveUrl: u => resolveKascUrl(u, lastBaseUrl),
  getInspectorText: () => panel.inspector?.value || lastKascRaw,
  setInspectorText: v => { if (panel.inspector) panel.inspector.value = v; },
});
// 起動直後・loadProject が URL ハッシュを読む前に、初期カメラの moveend が
// ハッシュをデフォルト位置で上書きするのを防ぐ（MapLibre と同じガード）
let urlViewConsumed = false;
// エンジン遷移で引き継ぐカレント状態。モジュール評価時に一度だけ読み、
// 初回 loadProject で一度だけ適用する（他エンジンと同じ消費1回ガード。
// 後続のプロジェクト切替には適用しない）
let pendingSession = matchSessionState();

function setCamera(cam) {
  lastCam = { lng: cam.lng ?? cam.longitude, lat: cam.lat ?? cam.latitude, height: cam.height ?? lastCam.height, heading: cam.heading ?? lastCam.heading, pitch: cam.pitch ?? lastCam.pitch, roll: cam.roll || 0 };
  view.setCamera(lastCam);
}
function flyTo(cam, opts) {
  lastCam = { lng: cam.lng ?? cam.longitude, lat: cam.lat ?? cam.latitude, height: cam.height ?? lastCam.height, heading: cam.heading ?? lastCam.heading, pitch: cam.pitch ?? lastCam.pitch };
  view.flyTo({ lng: lastCam.lng, lat: lastCam.lat, height: lastCam.height, heading: lastCam.heading, pitch: lastCam.pitch }, opts);
}
// マウス操作などプログラム外のカメラ変更を lastCam へ反映する
// (他エンジンと同じく URL ハッシュ・getViewInfo・camera-changed の根拠)
function syncCamFromView() {
  try {
    const p = view.camera.positionGeographic, o = view.camera.orientation;
    if (!p || !Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return;
    lastCam = { lng: p.lng, lat: p.lat, height: Number.isFinite(p.height) ? p.height : lastCam.height, heading: o?.heading ?? lastCam.heading, pitch: o?.pitch ?? lastCam.pitch, roll: o?.roll ?? 0 };
  } catch (_) {}
}
// URL の zoom はエンジン間の正典（Cesium と同じく実 FOV・実キャンバス高で
// 高度⇄変換する。固定近似の camToZoom/zoomToCamHeight だと他エンジンと
// 見え方がズレる）
function viewMetrics() {
  const vh = document.querySelector("#map")?.clientHeight || 512;
  let fov = 60;
  try { const f = view.camera.fov; if (Number.isFinite(f) && f > 0 && f < 180) fov = f; } catch (_) {}
  return { vh, fov };
}
function navaraZoom() {
  return heightToViewZoom(lastCam.lat, lastCam.height, 512);
}
function urlViewFromCam() {
  return { latitude: lastCam.lat, longitude: lastCam.lng, height: lastCam.height, pitch: lastCam.pitch, heading: lastCam.heading, zoom: navaraZoom() };
}
// URL/切替入力からカメラ高さを決める。zoom 優先（2D エンジンからの遷移）、
// zoom が無い従来 URL は height をそのまま使う（Cesium resolveInitialCamera と同じ）
function urlViewHeight(uv) {
  if (Number.isFinite(uv.height) && !Number.isFinite(uv.zoom)) return uv.height;
  if (Number.isFinite(uv.zoom)) {
    return viewZoomToHeight(uv.latitude, uv.zoom, 512);
  }
  return undefined;
}
function focusExtent(env) {
  if (!env) return;
  flyTo({ longitude: (env.west + env.east) / 2, latitude: (env.south + env.north) / 2, height: viewZoomToHeight((env.south + env.north) / 2, 15, 512) });
}
// Navara のリソースレイヤ(Layer ハンドル)には visible が無い。
// 表示可否は各マテリアルの show で制御し、update() は全置換のため
// 登録時に保存した desc へ show をマージした複製を渡す
const LAYER_MATERIAL_KEYS = ["point", "polyline", "polygon", "text", "billboard", "raster", "hillshade", "elevationHeatmap", "model", "terrain", "ellipsoid"];
const DEFAULT_MATERIAL_KEY = { raster: "raster", "3d-tiles": "model", terrain: "terrain" };
function navaraSetShow(entry, on) {
  const layer = entry.layer, desc = entry.desc;
  if (!layer || typeof layer.update !== "function" || !desc) return;
  const next = { ...desc };
  let touched = false;
  for (const k of LAYER_MATERIAL_KEYS) {
    if (next[k] && typeof next[k] === "object") { next[k] = { ...next[k], show: on }; touched = true; }
  }
  // マテリアル未指定で追加したレイヤ(暗黙既定)は型既定のキーを補う
  if (!touched) {
    const k = DEFAULT_MATERIAL_KEY[next.type];
    if (k) next[k] = { show: on };
  }
  try { layer.update(next); } catch (e) { console.warn("layer visibility", e); }
  if (entry === baseEntries[0]) { basemapShown = !!on; syncEllipsoidLayer(); }
}
// 地表透明モード: Cesium 版の globeHidden に合わせ、透過中は
// ① 地表メッシュを透明化(globe.transparent+opacity0 + globe シーンのメッシュ非表示)
// ② 宇宙の下地は黒空クアッド/星空が残るため、opaque シーンの大気クアッドの
//    fragmentShader を下敷き色(既定白、background: 行があればその色)の
//    単色出力へ差し替え、星空 Points を非表示にする
//    (renderer の clearColor や clearPass.overrideClearColor は独自
//    オーケストレータの合成で無視されるため実測では効かない)
// いずれも解除時に全て元へ戻す。
let currentClearHex = 0x000000; // 非透過時のクリアカラー(scene3d background= で更新)
let docBackgroundHex = null;    // .kasc background: 行(css2hex 済)。透過下敷き色の既定は白
let transparentActive = false;
let transparentUnderlay = 0xffffff;
let transparentRetryTimers = [];
const transparentOrigState = new WeakMap(); // 元 material/visible の退避
function isSkyQuad(c) {
  return c?.type === "Mesh" && c.frustumCulled === false &&
    c.material?.type === "RawShaderMaterial" && c.material?.uniforms?.inverseProjectionMatrix;
}
function setSkyUnderlay(obj, hex) {
  const m = obj.material;
  if (!transparentOrigState.has(obj)) transparentOrigState.set(obj, m);
  const clone = m.clone();
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  clone.fragmentShader =
    `precision highp float;\nlayout(location = 0) out vec4 navaraBg;\n` +
    `void main() { navaraBg = vec4(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}, 1.0); }\n`;
  clone.needsUpdate = true;
  obj.material = clone;
}
function restoreSkyObject(obj) {
  if (!transparentOrigState.has(obj)) return;
  obj.material = transparentOrigState.get(obj);
  transparentOrigState.delete(obj);
}
// 大気クアッド・星空・globe メッシュは renderDoc 呼出時点では未生成の場合がある
// (vendor/SW 経由で非同期初期化される)ため、パス追加通知(onPassesChanged)と
// 一定間隔のリトライで透過状態を再適用する。全て冪等。
function applyTransparentState(on, underlayHex) {
  try {
    const r = view._renderer;
    if (on) {
      view.globe.setOptions?.({ transparent: true, opacity: 0 });
      r?.setClearColor?.(underlayHex ?? 0xffffff);
      for (const c of view._scenes?.opaque?.children || []) {
        if (isSkyQuad(c)) setSkyUnderlay(c, underlayHex ?? 0xffffff);
        else if (c.type === "Points") c.visible = false; // 星空
      }
      for (const c of view._scenes?.globe?.children || []) c.visible = false;
    } else {
      view.globe.setOptions?.({ transparent: false, opacity: 1 });
      for (const c of view._scenes?.opaque?.children || []) {
        restoreSkyObject(c);
        if (c.type === "Points") c.visible = true;
      }
      for (const c of view._scenes?.globe?.children || []) c.visible = true;
      r?.setClearColor?.(currentClearHex);
    }
    // Navara はオンデマンド描画のため、変更を即時反映させる
    try { view.forceUpdate?.(); } catch (_) {}
  } catch (_) {}
}
function setGlobeTransparent(on, underlayHex) {
  transparentActive = !!on;
  transparentUnderlay = underlayHex ?? 0xffffff;
  for (const t of transparentRetryTimers) clearTimeout(t);
  transparentRetryTimers = [];
  applyTransparentState(on, transparentUnderlay);
  if (on) {
    // パス追加は後から来るため、通知フックで再無効化する(重複登録防止)
    const orc = view.renderPassOrchestrator;
    if (orc && !orc._kascTransparentHook) {
      orc._kascTransparentHook = true;
      const orig = orc.onPassesChanged;
      orc.onPassesChanged = () => {
        try { orig?.(); } catch (_) {}
        if (transparentActive) applyTransparentState(true, transparentUnderlay);
      };
    }
    // vendor 取得〜エンジン初期化完了まで数十秒かかることがあるため、
    // 透過が有効な間は一定間隔で再適用し続ける(上限 60 回)
    let tries = 0;
    transparentRetryTimers.push(setInterval(() => {
      if (!transparentActive || ++tries > 60) {
        for (const t of transparentRetryTimers) { clearInterval(t); clearTimeout(t); }
        transparentRetryTimers = [];
        return;
      }
      applyTransparentState(true, transparentUnderlay);
    }, 1500));
  }
}
// ドレープ面の自動補完: clampToGround 系ベクターはタイル焼き込みのため
// 面を産むレイヤ(raster/terrain)が無いと描画されない。地形もベースマップも
// 無い構成ではソースレスの ellipsoid 地形レイヤを張って地表を確保する
let ellipsoidLayer = null, basemapShown = true;
function syncEllipsoidLayer() {
  const need = !terrainLayer && !(basemapLayer && basemapShown);
  if (need && !ellipsoidLayer) {
    try { ellipsoidLayer = view.addLayer({ type: "terrain", ellipsoid: {} }); }
    catch (e) { console.warn("ellipsoid", e); ellipsoidLayer = null; }
  } else if (!need && ellipsoidLayer) {
    try { ellipsoidLayer.delete(); } catch (_) {}
    ellipsoidLayer = null;
  }
}
// 縮尺表示(minScale=/maxScale=) → カメラ高[m]範囲。
// QML ルールの縮尺分母→距離変換と同じ係数(分母×0.00028×900÷(2·tan30°))
const SCALE_VIS_DIST_K = 0.00028 * 900 / (2 * Math.tan(Math.PI / 6));
// QML 式変数 @map_scale → 上記と同じ換算の逆(カメラ高→縮尺分母)。
// Navara の QML 評価はレイヤ読込時の一回のため現縮尺が供給値になる
setMapScaleGetter(() => lastCam.height / SCALE_VIS_DIST_K);
function scaleVisOk(item) {
  const lo = Number(item?.opts?.minscale), hi = Number(item?.opts?.maxscale);
  if (!(lo > 0) && !(hi > 0)) return true;
  const h = lastCam.height;
  if (hi > 0 && h < hi * SCALE_VIS_DIST_K) return false;
  if (lo > 0 && h > lo * SCALE_VIS_DIST_K) return false;
  return true;
}
// カメラ移動時に縮尺範囲と item.visible の両方を見て show を同期する
function applyScaleVis() {
  for (const e of layerEntries) {
    if (!e.layer) continue;
    navaraSetShow(e, e.item.visible !== false && scaleVisOk(e.item));
  }
}
function setEntryVisible(entry, on) {
  // applyEntryVisibility(entry) は引数1つで呼ばれ item.visible 前提のため、
  // 未指定時は item.visible を正とする
  if (on === undefined) on = entry.item.visible !== false;
  entry.item.visible = on;
  navaraSetShow(entry, on && scaleVisOk(entry.item));
}
function progress(n, total, label) {
  if (!total) { panel.progress.hidden = true; return; }
  panel.progress.hidden = false;
  panel.progressText.textContent = label || `読み込み中 ${n}/${total}`;
  panel.progressBar.style.width = `${(n / total) * 100}%`;
  if (n >= total) setTimeout(() => { panel.progress.hidden = true; }, 1200);
}
function syncAttribution() {
  const seen = new Set(), html = [];
  // 表示中ベースマップの出典も併記する（他エンジンと同じ対象範囲）
  const b = baseDocs[currentBasemapIdx];
  if (b) {
    const a = layerAttribution(b);
    if (a) { seen.add(a); html.push(sanitizeAttributionFragment(a)); }
  }
  for (const { item } of layerEntries) {
    if (!item.visible) continue;
    const a = layerAttribution(item);
    if (a && !seen.has(a)) { seen.add(a); html.push(sanitizeAttributionFragment(a)); }
  }
  // Navara 内蔵の AttributionPlugin（既定有効の帰属 UI）へ流し、
  // 独自 .map-attribution はフォールバックとして残す
  const nat = view.attribution;
  if (nat) {
    try {
      nat.clear?.();
      if (html.length) nat.add(html.map(h => ({ attributionHtml: h })));
    } catch (_) { /* 内蔵 UI 失敗時は自前 DOM へ */ }
    panel.attribution.style.display = "none";
    return;
  }
  panel.attribution.innerHTML = html.join(" / ");
  panel.attribution.style.display = html.length ? "" : "none";
}

// ---- レイヤ一覧（MapLibre/Cesium 版と同じ構造: グループ + 排他(//)ラジオ化 + 凡例） ----
const expandedLayerGroups = new Set();

function syncRowStatus(entry) {
  if (!entry.statusEl) return;
  entry.statusEl.classList.toggle("failed", !!entry.failed);
  entry.statusEl.textContent = entry.failed ? "×" : (entry.loading ? "…" : "");
  if (entry.failed) entry.statusEl.title = entry.error || "";
}

// `| off` で読込を遅延したレイヤは ON のタイミングで初回読み込みする
async function maybeLoadEntry(entry) {
  if (entry.layer || entry.loading || entry.failed || !entry.item.visible) return;
  entry.loading = true; syncRowStatus(entry);
  try {
    const r = await addKascLayer(entry.item, lastBaseUrl);
    if (r) {
      entry.src = r.src; entry.layer = r.layer; entry.desc = r.desc;
      // 読込中に表示状態が変わっている可能性があるため、追加後に現在値を再適用する
      // （OFF→ON→OFF 等の競合で、非表示のはずのレイヤが残るのを防ぐ）
      navaraSetShow(entry, entry.item.visible !== false && scaleVisOk(entry.item));
    }
  } catch (e) {
    entry.failed = true;
    entry.error = String((await diagnoseHubLayerError(entry.item, e))?.message || e?.message || e);
    console.warn("layer failed", entry.item.title, e);
  }
  entry.loading = false; syncRowStatus(entry);
}

// 地物単位の凡例フィルタは Navara 側で未実装（レイヤ単位マテリアルのため）
function applyLegendFilter(_entry) { renderLegendPicker(); }

function defaultLegendSpec(item) {
  if (item._qml || !VECTOR_TYPES.has(item.type)) return null;
  for (const f of item._geojson?.features || []) {
    const spec = defaultVectorLegendSpec(f?.geometry?.type || "");
    if (spec) return spec;
  }
  return null;
}

function buildLayerRow(entry, exclusive, radioName) {
  const item = entry.item;
  const wrap = document.createElement("div");
  wrap.className = "layer-item";
  const row = document.createElement("label");
  row.className = "layer-row";

  const legendEntries = item._qml?.legend || null;
  const legendMulti = legendEntries && legendEntries.length > 1;
  let legendBox = null;
  if (legendMulti) {
    const tg = document.createElement("button");
    tg.type = "button";
    tg.className = "layer-legend-toggle";
    tg.textContent = item._legendCollapsed ? "▸" : "▾";
    tg.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
      item._legendCollapsed = !item._legendCollapsed;
      tg.textContent = item._legendCollapsed ? "▸" : "▾";
      tg.setAttribute("aria-expanded", String(!item._legendCollapsed));
      if (legendBox) legendBox.hidden = item._legendCollapsed;
    });
    tg.setAttribute("aria-expanded", String(!item._legendCollapsed));
    row.append(tg);
  } else {
    // トグル無し行も同幅のスペーサを置き、チェックボックスの左位置を全行で揃える
    const sp = document.createElement("span");
    sp.className = "layer-legend-toggle-spacer";
    sp.setAttribute("aria-hidden", "true");
    row.append(sp);
  }

  const cb = document.createElement("input");
  cb.type = exclusive ? "radio" : "checkbox";
  if (entry.unsupported) { cb.disabled = true; row.style.opacity = ".45"; row.title = "このエンジン未対応の形式(Cesium 版で対応)"; }
  if (exclusive) cb.name = radioName;
  if (exclusive) {
    cb.addEventListener("pointerdown", () => { cb._wasChecked = cb.checked; });
    cb.addEventListener("click", () => { if (cb._wasChecked) { cb.checked = false; cb.dispatchEvent(new Event("change")); } });
  }
  cb.checked = item.visible !== false;
  entry.cb = cb;
  cb.addEventListener("change", () => {
    item.visible = cb.checked;
    if (cb.checked && exclusive) {
      for (const sib of entry._siblings || []) {
        if (sib === entry) continue;
        sib.item.visible = false;
        if (sib.cb) sib.cb.checked = false;
        setEntryVisible(sib, false);
      }
    }
    setEntryVisible(entry, cb.checked);
    if (cb.checked) void maybeLoadEntry(entry);
    syncAttribution();
    entry._groupCtl?.sync();
    liveWritebackEntries(layerEntries);
  });
  row.append(cb);

  const statusEl = document.createElement("span");
  statusEl.className = "layer-status";
  entry.statusEl = statusEl;
  syncRowStatus(entry);

  const legendSpec = legendEntries?.[0]?.spec || defaultLegendSpec(item);
  if (!legendMulti && legendSpec) {
    const sw = document.createElement("img");
    sw.className = "legend-swatch";
    sw.src = qmlLegendSwatchDataUrl(legendSpec);
    row.append(sw);
  }

  const name = document.createElement("span");
  name.textContent = entry._leaf || item.url;
  if (item.title && item.title !== entry._leaf) name.title = item.title;
  if (VECTOR_TYPES.has(item.type)) {
    name.style.cursor = "pointer";
    name.title = "属性一覧を表示";
    name.addEventListener("click", () => attrWidget.open(String(layerEntries.indexOf(entry))));
  }
  row.append(name);
  row.append(statusEl);

  const fb = document.createElement("button");
  fb.type = "button";
  fb.className = "layer-focus";
  fb.textContent = "📍";
  fb.title = "レイヤーへ移動";
  fb.addEventListener("click", ev => {
    ev.preventDefault(); ev.stopPropagation();
    focusExtent(item._geojson && geojsonExtent(item._geojson));
  });
  row.append(fb);

  // クエリ系レイヤーの絞り込み条件変更（Cesium 版の ⏷ ボタン相当）
  if (QUERY_TYPES.has(item.type)) {
    const qb = document.createElement("button");
    qb.type = "button";
    qb.className = "layer-filter";
    qb.textContent = "⏷";
    qb.title = (item.type === "sql" || item.type === "ogrsql") ? "クエリを編集" : "絞り込み条件（WHERE式）を編集";
    qb.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
      void editEntryQueryFilter(entry);
    });
    row.append(qb);
  }
  wrap.append(row);

  if (legendMulti) {
    legendBox = document.createElement("div");
    legendBox.className = "layer-legend-items";
    legendBox.hidden = !!item._legendCollapsed;
    for (const le of legendEntries) {
      const lab = document.createElement("label");
      lab.className = "legend-row";
      const lcb = document.createElement("input");
      lcb.type = "checkbox";
      lcb.checked = !item._legendHidden?.has(le.symbolName);
      lcb.disabled = !le.symbolName;
      lcb.addEventListener("change", () => {
        item._legendHidden ||= new Set();
        if (lcb.checked) item._legendHidden.delete(le.symbolName);
        else item._legendHidden.add(le.symbolName);
        if (!item._legendHidden.size) item._legendHidden = null;
        applyLegendFilter(entry);
      });
      const sw = document.createElement("img");
      sw.className = "legend-swatch";
      if (le.spec) sw.src = qmlLegendSwatchDataUrl(le.spec);
      const lbl = document.createElement("span");
      lbl.className = "legend-label";
      lbl.textContent = le.label || le.symbolName || "";
      lab.append(lcb, sw, lbl);
      legendBox.append(lab);
    }
    wrap.append(legendBox);
  }
  return wrap;
}

function buildLayerList() {
  panel.layers.innerHTML = "";

  // "グループ/レイヤ名"（"//"は排他グループ）でグループセクション化する
  const grouped = new Map();
  for (const entry of layerEntries) {
    const sp = splitKascTitle(entry.item.title);
    entry._leaf = sp.title;
    const key = `${sp.group}|${sp.exclusiveGroup ? "exclusive" : "regular"}`;
    if (!grouped.has(key)) grouped.set(key, { group: sp.group, exclusive: sp.exclusiveGroup, members: [] });
    grouped.get(key).members.push(entry);
  }

  for (const { group, exclusive, members } of grouped.values()) {
    for (const e of members) e._siblings = members;
    if (!group) {
      for (const e of members) panel.layers.append(buildLayerRow(e, false, null));
      continue;
    }
    const key = `${group}|${exclusive ? "exclusive" : "regular"}`;
    const section = document.createElement("section");
    section.className = "layer-group" + (exclusive ? " exclusive" : "");
    section.dataset.groupKey = key;
    const head = document.createElement("div");
    head.className = "layer-group-title";
    const tg = document.createElement("button");
    tg.type = "button";
    tg.className = "layer-group-toggle";
    tg.textContent = expandedLayerGroups.has(key) ? "▾" : "▸";
    tg.setAttribute("aria-expanded", String(expandedLayerGroups.has(key)));
    const gcb = document.createElement("input");
    gcb.type = exclusive ? "radio" : "checkbox";
    if (exclusive) gcb.name = `grp-excl-${key}`;
    gcb.className = "layer-group-checkbox";
    const glabel = document.createElement("span");
    glabel.className = "layer-group-label";
    glabel.textContent = group;
    head.append(tg, gcb, glabel);
    if (exclusive) {
      const badge = document.createElement("small");
      badge.className = "exclusive-badge";
      badge.textContent = "排他";
      head.append(badge);
    }
    const children = document.createElement("div");
    children.className = "layer-group-children";
    children.hidden = !expandedLayerGroups.has(key);
    for (const e of members) children.append(buildLayerRow(e, exclusive, `grp-${key}`));
    section.append(head, children);
    panel.layers.append(section);

    const ctl = {
      sync() {
        const anyOn = members.some(e => e.item.visible !== false);
        gcb.checked = anyOn;
        gcb.indeterminate = !exclusive && anyOn && members.some(e => e.item.visible === false);
      },
    };
    for (const e of members) e._groupCtl = ctl;
    ctl.sync();

    tg.addEventListener("click", () => {
      const collapsed = !children.hidden;
      children.hidden = collapsed;
      tg.textContent = collapsed ? "▸" : "▾";
      tg.setAttribute("aria-expanded", String(!collapsed));
      if (collapsed) expandedLayerGroups.delete(key);
      else expandedLayerGroups.add(key);
    });
    gcb.addEventListener("change", () => {
      if (exclusive) {
        // 排他グループ: ON → 先頭(または現表示)のみ表示、OFF → 全て非表示
        const on = gcb.checked ? (members.find(e => e.item.visible !== false) || members[0]) : null;
        for (const e of members) {
          e.item.visible = e === on;
          if (e.cb) e.cb.checked = e === on;
          setEntryVisible(e, e.item.visible);
          if (e === on) void maybeLoadEntry(e);
        }
      } else {
        for (const e of members) {
          e.item.visible = gcb.checked;
          if (e.cb) e.cb.checked = gcb.checked;
          setEntryVisible(e, gcb.checked);
          void maybeLoadEntry(e);
        }
      }
      syncAttribution();
      ctl.sync();
      liveWritebackEntries(layerEntries);
    });
  }
}

// ---- 凡例タブ: legend: 行の画像とレイヤ凡例を1つのセレクタで切替表示する ----
function buildLegends() {
  panel.legends.replaceChildren();
  if (!renderLegendPicker()) panel.legends.textContent = "（凡例なし）";
}

// 選択中は legendPickerState.selected で保持し、再描画で維持する
const legendPickerState = {};
// legend: 行で指定された凡例画像(URL 重複はまとめる)
function legendTabImages() {
  const seen = new Set();
  return (currentLegends || [])
    .filter(leg => leg.url && !seen.has(leg.url) && seen.add(leg.url))
    .map(leg => ({ title: leg.title || "", url: resolveKascUrl(leg.url, lastBaseUrl) }));
}
function legendPickerLayers() {
  return (layerEntries || []).map(entry => {
    const item = entry.item || {};
    const title = splitKascTitle(item.title || "").title || item.title || entry._leaf || item.url || "";
    const legend = item._qml?.legend;
    const entries = legend?.length
      ? legend.map(le => ({ label: le.label || le.symbolName || "", spec: le.spec || le, hidden: !!le.symbolName && !!item._legendHidden?.has(le.symbolName), symbolName: le.symbolName || "" }))
      : (spec => (spec ? [{ label: "", spec }] : []))(defaultLegendSpec(item));
    return { ref: item, title, entries };
  }).filter(l => l.entries.length);
}
// 凡例タブの行チェック/全表示ボタンからのシンボル表示切替
function setLegendSymbol(item, symbolName, visible) {
  item._legendHidden ||= new Set();
  if (visible) item._legendHidden.delete(symbolName);
  else item._legendHidden.add(symbolName);
  if (!item._legendHidden.size) item._legendHidden = null;
  const entry = (layerEntries || []).find(e => e.item === item);
  if (entry) applyLegendFilter(entry);
}
function setAllLegendSymbols(item, visible) {
  const names = (item?._qml?.legend || []).map(le => le.symbolName).filter(Boolean);
  if (!names.length) return;
  item._legendHidden = visible ? null : new Set(names);
  const entry = (layerEntries || []).find(e => e.item === item);
  if (entry) applyLegendFilter(entry);
}
function renderLegendPicker() {
  const parent = panel.legends;
  if (!parent) return false;
  const layers = legendPickerLayers();
  const images = legendTabImages();
  let box = parent.querySelector(".legend-layer-picker");
  if (!layers.length && !images.length) { box?.remove(); return false; }
  if (!box) {
    box = document.createElement("div");
    box.className = "legend-layer-picker";
    parent.append(box);
  }
  renderLayerLegendPicker(box, { images, layers }, { swatchUrl: qmlLegendSwatchDataUrl, state: legendPickerState, ariaLabel: "凡例を表示するレイヤ", imageGroupLabel: "凡例画像", layerGroupLabel: "レイヤ", onToggleSymbol: setLegendSymbol, onToggleAll: setAllLegendSymbols });
  return true;
}

// ---- 属性一覧 ----
const attrWidget = createAttrWidget({
  // レイヤ id は layerEntries のインデックス（filter 後に採番すると
  // buildLayerRow 側の indexOf(entry) とズレるため先に採番する）
  listLayers: () => layerEntries
    .map((entry, i) => ({ id: String(i), title: splitKascTitle(entry.item.title).title || entry.item.title || entry.item.url, entry }))
    .filter(o => VECTOR_TYPES.has(o.entry.item.type)),
  getFeatures: async entry => {
    // 未読込のレイヤは選択時にデータだけ読む(表示状態は変えない)
    if (!entry.item._geojson && !entry.failed) {
      try { entry.item._geojson = (await loadVectorItem(entry.item, lastBaseUrl, null, vectorHooks)).geojson; }
      catch (e) { entry.failed = true; entry.error = String(e?.message || e); }
    }
    if (entry.failed) throw new Error(entry.error || "load failed");
    return { features: entry.item._geojson?.features || [] };
  },
  focusFeature: f => focusExtent(geojsonExtent({ type: "FeatureCollection", features: [f] })),
  // 「フィルター反映」: 絞り込み行だけを描画へ残す(表示限定)。
  // Navara の geojson ソースは差し替え API が無いためレイヤーを作り直す
  setMapFilter: async (layer, predicate) => {
    const entry = layer.entry;
    const item = entry.item;
    item._attrMapFilter = predicate || null;
    if (!entry.layer) return; // 未構築レイヤーは構築時に whereFilteredGeojson 経由で効く
    try { entry.layer.delete(); } catch (_) {}
    try { entry.src?.delete(); } catch (_) {}
    const r = await addKascLayer(item, lastBaseUrl);
    if (r) { entry.src = r.src; entry.layer = r.layer; entry.desc = r.desc; }
    setEntryVisible(entry); // 作り直しで表示状態(item.visible/縮尺)を戻す
  },
  // SQL ダイアログの「レイヤフィルタ」: ⏷ 編集と同じ where=/クエリ書換え経路
  applyLayerFilter: async (layer, value) => {
    await applyEntryQueryFilter(layer.entry, value);
    return true;
  },
  // SELECT 実行時の FROM 名解決(ogrsql: 行と同じフック)
  resolveLayer: vectorHooks.resolveLayer,
  getBaseUrl: () => lastBaseUrl,
});
$("#attr-widget-open")?.addEventListener("click", () => {
  attrWidget.open(panel.attrContent?.dataset.layerId || null);
});

// ---- 検索タブ（読み込み済み GeoJSON の属性検索） ----
panel.searchInput?.addEventListener("input", () => {
  const q = panel.searchInput.value.trim().toLowerCase();
  panel.searchResults.replaceChildren();
  if (q.length < 2) return;
  let count = 0;
  outer: for (const entry of layerEntries) {
    const feats = entry.item._geojson?.features || [];
    for (const f of feats) {
      const hit = Object.values(f.properties || {}).some(v => String(v).toLowerCase().includes(q));
      if (!hit) continue;
      const b = document.createElement("button");
      b.className = "cam-btn"; b.type = "button";
      b.textContent = `${splitKascTitle(entry.item.title).title}: ${Object.values(f.properties || {}).find(v => String(v).toLowerCase().includes(q)) ?? ""}`;
      b.addEventListener("click", () => {
        window.switchPanelTab("attr");
        renderAttrContent(panel.attrContent, attrEntriesFromProps(f.properties));
        focusExtent(geojsonExtent({ type: "FeatureCollection", features: [f] }));
      });
      panel.searchResults.append(b);
      if (++count >= 50) break outer;
    }
  }
});

// ---- ベースマップ ----
let currentBasemapIdx = -1;
async function applyBasemap(idx) {
  // 同一選択の再適用は張り替えない（session 復元で二度適用されてもタイルを
  // 読み直さない。「ベースマップなし」等で show=false 中なら戻すだけ）
  if (idx === currentBasemapIdx && baseEntries[0] && baseEntries[0].item === baseDocs[idx]) { navaraSetShow(baseEntries[0], true); return; }
  currentBasemapIdx = idx;
  if (basemapLayer) { try { basemapLayer.delete(); } catch (_) {} basemapLayer = null; }
  if (basemapSrc) { try { basemapSrc.delete(); } catch (_) {} basemapSrc = null; }
  const b = baseDocs[idx];
  if (!b) { basemapShown = false; syncEllipsoidLayer(); return; }
  basemapSrc = view.addSource({ type: "raster-tile", url: resolveKascUrl(b.url, lastBaseUrl), maxZoom: Number(b.opts?.maxzoom) || 18, ...(b.opts?.minzoom ? { minZoom: Number(b.opts.minzoom) } : {}) });
  const desc = { type: "raster", source: basemapSrc };
  basemapLayer = view.addLayer(desc);
  baseEntries.length = 0;
  baseEntries.push({ item: b, src: basemapSrc, layer: basemapLayer, desc });
  basemapShown = true;
  syncEllipsoidLayer();
}
// select からの変更: 「ベースマップなし」は下地が白になるよう地表透明モードへ
// 入れ(他エンジンの none と見た目を揃える)、通常タイル選択時は解除する
panel.basemapSelect?.addEventListener("change", () => {
  const idx = Number(panel.basemapSelect.value);
  setGlobeTransparent(idx < 0, docBackgroundHex ?? 0xffffff);
  applyBasemap(idx);
});

// ---- 地形・写実 ----
async function applyTerrain(on) {
  if (terrainLayer) { try { terrainLayer.delete(); terrainSrc.delete(); } catch (_) {} terrainLayer = terrainSrc = terrainDesc = null; }
  if (!on) return;
  try {
    terrainSrc = view.addSource({ type: "quantized-mesh", url: TERRAIN_URL, maxZoom: 15, requestVertexNormals: true });
    terrainDesc = { type: "terrain", source: terrainSrc,
      terrain: { castShadow: true, receiveShadow: true,
        ...(terrainExaggeration !== 1 ? { exaggeration: terrainExaggeration } : {}),
        ...(terrainLit ? {} : { lit: false }) } };
    terrainLayer = view.addLayer(terrainDesc);
  } catch (e) {
    console.warn("terrain", e);
    try { terrainSrc?.delete(); } catch (_) {}
    terrainLayer = terrainSrc = terrainDesc = null;
    // 既定 ON のため失敗時はチェック状態も戻して UI と実態を合わせる
    const c = $("#nv-terrain"); if (c) c.checked = false;
  }
  syncEllipsoidLayer();
}
// 垂直誇張は Navara 0.3.x の TerrainMaterial.exaggeration で実現
// (maplibre の terrain exaggeration・Cesium の verticalExaggeration と同等)
function applyTerrainExaggeration(v) {
  terrainExaggeration = v;
  if (!terrainLayer || !terrainDesc) return;
  try {
    terrainDesc = { ...terrainDesc, terrain: { ...terrainDesc.terrain, exaggeration: v } };
    terrainLayer.update(terrainDesc);
  } catch (e) { console.warn("terrain exaggeration", e); }
}
// terrain: shading= の陰影は TerrainMaterial.lit（ライティング方程式の適否）で近似。
// shading=off は単色アルベド表示（QGIS の陰影なし地形と同等）
let terrainLit = true;
function applyTerrainShading(on) {
  terrainLit = on;
  if (!terrainLayer || !terrainDesc) return;
  try {
    terrainDesc = { ...terrainDesc, terrain: { ...terrainDesc.terrain, lit: on } };
    terrainLayer.update(terrainDesc);
  } catch (e) { console.warn("terrain shading", e); }
}
let manualLights = [], manualSun = null, shadowOn = false;
// ---- Navara 固有の光・エフェクト設定（表示タブ「効果」ペイン） ----
// 写実シーン(addDefaultPhotorealScene)と手動ライトの両モードへ適用する。
// sunInt はモード別に値を持つ（写実=物理ベース既定1・手動=補正済み既定1.8）
const FX_DEFAULTS = {
  sunInt: { pr: 1, manual: 1.8 },
  ambientInt: 2, skyProbeInt: 2, exposure: 1, shadowInt: 1,
  moon: true, moonInt: 1,
  stars: true, starsInt: 10,
  flare: true, flareInt: 0.005,
  toneMode: 8,
  clouds: false, cloudCov: 0.25,
  ssao: false,
  rain: false, snow: false,
};
const fx = structuredClone(FX_DEFAULTS);
let cloudsEffect = null, ssaoEffect = null, rainMesh = null, snowMesh = null;
// 天候・雲はアニメーション描画が必要なため、いずれかが有効な間 view.animation を ON
function syncFxAnimation() {
  try { view.animation = !!(fx.clouds || fx.rain || fx.snow); } catch (_) {}
}
const sunHandle = () => photorealScene?.sun || manualSun;
// 影は複数箇所のフラグをまとめて切り替える。
// view.shadow への代入は効かない（コンストラクタオプションのみで実行時セッター無し）
function applyShadow() {
  try { const r = view._renderer; if (r) r.shadowMap.enabled = shadowOn; } catch (_) {}
  try { view.atmosphere.enableShadows.value = shadowOn; } catch (_) {}
  try { photorealScene?.sun?.update?.({ sun: { castShadow: shadowOn } }); } catch (_) {}
  try { photorealScene?.aerialPerspective?.update?.({ aerialPerspective: { shadow: shadowOn } }); } catch (_) {}
  try { manualSun?.update?.({ sun: { castShadow: shadowOn } }); } catch (_) {}
  try { view.forceUpdate?.(); } catch (_) {}
}
// 写実シーンON時は addDefaultPhotorealScene が sun を内包するため
// 手動 sun を足すと CSM uniform(csmCascades等)が二重注入され全シェーダが
// 破壊される（実GPUで Shader Error: redefinition → 画面全滅）。
// そのため手動ライトは photoreal OFF 時のみ追加する
function syncLights() {
  for (const l of manualLights) { try { l.delete?.(); } catch (_) {} }
  manualLights = []; manualSun = null;
  if (photorealScene) { manualLights.push(view.addLight({ ambient: { intensity: fx.ambientInt } })); }
  else {
    manualLights.push(
      view.addLight({ ambient: { intensity: fx.ambientInt } }),
      (manualSun = view.addLight({ sun: { intensity: fx.sunInt.manual, applyColor: true } })));
  }
  applyShadow();
}
// 各 fx 値を現在のシーンハンドルへ反映する（写実 OFF 時は存在しないハンドルは無害にスキップ）
function applyFxSun() { try { sunHandle()?.update?.({ sun: { intensity: fx.sunInt[photorealScene ? "pr" : "manual"] } }); } catch (_) {} }
function applyFxAmbient() { try { manualLights[0]?.update?.({ ambient: { intensity: fx.ambientInt } }); } catch (_) {} }
function applyFxSkyProbe() { try { photorealScene?.skyLightProbe?.update?.({ skyLightProbe: { intensity: fx.skyProbeInt } }); } catch (_) {} }
function applyFxExposure() { try { view.toneMappingExposure = fx.exposure; } catch (_) {} }
function applyFxShadowInt() { try { sunHandle()?.update?.({ sun: { shadowIntensity: fx.shadowInt } }); } catch (_) {} }
function applyFxMoon() { try { photorealScene?.sky?.update?.({ sky: { moon: fx.moon, moonIntensity: fx.moonInt } }); } catch (_) {} }
function applyFxStars() { try { const s = photorealScene?.stars; if (!s) return; s.visible = fx.stars; s.update?.({ stars: { intensity: fx.starsInt } }); } catch (_) {} }
function applyFxFlare() { try { const f = photorealScene?.lensFlare; if (!f) return; f.visible = fx.flare; f.update?.({ lensFlare: { intensity: fx.flareInt } }); } catch (_) {} }
function applyFxToneMode() { try { photorealScene?.toneMapping?.update?.({ toneMapping: { mode: fx.toneMode } }); } catch (_) {} }
// 雲・SSAO は写実シーンの構成外のため、トグルで addEffect/delete する
function applyFxClouds() {
  if (fx.clouds && !cloudsEffect) {
    try { cloudsEffect = view.addEffect({ clouds: { coverage: fx.cloudCov } }); }
    catch (e) { console.warn("clouds", e); }
  } else if (!fx.clouds && cloudsEffect) {
    try { cloudsEffect.delete(); } catch (_) {}
    cloudsEffect = null;
  } else if (cloudsEffect) {
    try { cloudsEffect.update({ clouds: { coverage: fx.cloudCov } }); } catch (_) {}
  }
}
function applyFxSsao() {
  if (fx.ssao && !ssaoEffect) {
    try { ssaoEffect = view.addEffect({ ssao: {} }); }
    catch (e) { console.warn("ssao", e); }
  } else if (!fx.ssao && ssaoEffect) {
    try { ssaoEffect.delete(); } catch (_) {}
    ssaoEffect = null;
  }
}
// rain/snow は Effect ではなく空間パーティクルのメッシュとして addMesh する
function applyFxRain() {
  if (fx.rain && !rainMesh) {
    try { rainMesh = view.addMesh({ rain: {} }); }
    catch (e) { console.warn("rain", e); }
  } else if (!fx.rain && rainMesh) {
    try { rainMesh.delete(); } catch (_) {}
    rainMesh = null;
  }
}
function applyFxSnow() {
  // maxHeight 既定値では高高度カメラから見えない場合があるため大きめに取る
  if (fx.snow && !snowMesh) {
    try { snowMesh = view.addMesh({ snow: { maxHeight: 100000 } }); }
    catch (e) { console.warn("snow", e); }
  } else if (!fx.snow && snowMesh) {
    try { snowMesh.delete(); } catch (_) {}
    snowMesh = null;
  }
}
function applyFxAll() {
  applyFxSun(); applyFxAmbient(); applyFxSkyProbe(); applyFxExposure();
  applyFxShadowInt(); applyFxMoon(); applyFxStars(); applyFxFlare();
  applyFxToneMode(); applyFxClouds(); applyFxSsao(); applyFxRain(); applyFxSnow();
  syncFxAnimation();
}
// 写実 ON/OFF に応じて .nv-pr 行の有効/無効と太陽スライダーの表示値を同期する
function syncFxUi() {
  const pr = !!photorealScene;
  const sunEl = $("#nv-sun-int");
  if (sunEl) {
    sunEl.value = String(fx.sunInt[pr ? "pr" : "manual"]);
    const v = $("#nv-sun-int-val"); if (v) v.textContent = Number(sunEl.value).toFixed(2);
  }
  for (const el of document.querySelectorAll(".nv-pr input, .nv-pr select")) el.disabled = !pr;
}
function initFxControls() {
  const bind = (sel, valSel, fmt, fn) => {
    const el = $(sel); if (!el) return;
    const show = () => { const v = $(valSel); if (v) v.textContent = fmt ? fmt(Number(el.value)) : el.value; };
    el.addEventListener("input", () => { show(); fn(Number(el.value)); });
    show();
  };
  bind("#nv-sun-int", "#nv-sun-int-val", v => v.toFixed(2), v => { fx.sunInt[photorealScene ? "pr" : "manual"] = v; applyFxSun(); });
  bind("#nv-amb-int", "#nv-amb-int-val", v => v.toFixed(2), v => { fx.ambientInt = v; applyFxAmbient(); });
  bind("#nv-sky-int", "#nv-sky-int-val", v => v.toFixed(2), v => { fx.skyProbeInt = v; applyFxSkyProbe(); });
  bind("#nv-exposure", "#nv-exposure-val", v => v.toFixed(2), v => { fx.exposure = v; applyFxExposure(); });
  bind("#nv-shd-int", "#nv-shd-int-val", v => v.toFixed(2), v => { fx.shadowInt = v; applyFxShadowInt(); });
  bind("#nv-moon-int", "#nv-moon-int-val", v => v.toFixed(2), v => { fx.moonInt = v; applyFxMoon(); });
  bind("#nv-stars-int", "#nv-stars-int-val", v => v.toFixed(1), v => { fx.starsInt = v; applyFxStars(); });
  bind("#nv-flare-int", "#nv-flare-int-val", v => v.toFixed(3), v => { fx.flareInt = v; applyFxFlare(); });
  bind("#nv-clouds-cov", "#nv-clouds-cov-val", v => v.toFixed(2), v => { fx.cloudCov = v; applyFxClouds(); });
  $("#nv-moon")?.addEventListener("change", e => { fx.moon = e.target.checked; applyFxMoon(); });
  $("#nv-stars")?.addEventListener("change", e => { fx.stars = e.target.checked; applyFxStars(); });
  $("#nv-flare")?.addEventListener("change", e => { fx.flare = e.target.checked; applyFxFlare(); });
  $("#nv-tonemode")?.addEventListener("change", e => { fx.toneMode = Number(e.target.value); applyFxToneMode(); });
  $("#nv-clouds")?.addEventListener("change", e => { fx.clouds = e.target.checked; applyFxClouds(); syncFxAnimation(); });
  $("#nv-ssao")?.addEventListener("change", e => { fx.ssao = e.target.checked; applyFxSsao(); });
  $("#nv-rain")?.addEventListener("change", e => { fx.rain = e.target.checked; applyFxRain(); syncFxAnimation(); });
  $("#nv-snow")?.addEventListener("change", e => { fx.snow = e.target.checked; applyFxSnow(); syncFxAnimation(); });
  $("#nv-fx-reset")?.addEventListener("click", resetFx);
  syncFxUi();
}
// 効果設定を既定値へ戻す。コントロールへ値を書き戻してイベントを発火させ、
// 個別適用は既存ハンドラへ委譲する（時刻行は対象外）
function resetFx() {
  Object.assign(fx, structuredClone(FX_DEFAULTS));
  const setC = (sel, on) => { const el = $(sel); if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event("change", { bubbles: true })); } };
  const setV = (sel, v) => { const el = $(sel); if (el) { el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); } };
  const setS = (sel, v) => { const el = $(sel); if (el) { el.value = String(v); el.dispatchEvent(new Event("change", { bubbles: true })); } };
  setC("#nv-photoreal", true);   // 先に写実シーンを戻し .nv-pr を有効化する
  setC("#nv-shadow", false);
  setC("#nv-moon", fx.moon); setC("#nv-stars", fx.stars); setC("#nv-flare", fx.flare);
  setC("#nv-clouds", false); setC("#nv-ssao", false);
  setC("#nv-rain", false); setC("#nv-snow", false);
  setV("#nv-amb-int", fx.ambientInt); setV("#nv-sky-int", fx.skyProbeInt);
  setV("#nv-exposure", fx.exposure); setV("#nv-shd-int", fx.shadowInt);
  setV("#nv-moon-int", fx.moonInt); setV("#nv-stars-int", fx.starsInt);
  setV("#nv-flare-int", fx.flareInt); setV("#nv-clouds-cov", fx.cloudCov);
  setS("#nv-tonemode", fx.toneMode);
  applyFxAll();
  syncFxUi();
}
function applyPhotoreal(on) {
  if (photorealScene) {
    for (const v of Object.values(photorealScene)) { try { v?.delete?.(); } catch (_) {} }
    photorealScene = null;
  }
  if (on) {
    try { photorealScene = defaultPlugin.addDefaultPhotorealScene(); }
    catch (e) { console.warn("photoreal", e); photorealScene = null; }
  }
  syncLights();
  applyFxAll();
  syncFxUi();
}
// ---- .kasc の QGIS 3Dシーン系行（light:/scene3d:）→ Navara の太陽・効果設定 ----
// Navara の太陽方向は atmosphere.date から天文学的に決まり config で
// 任意方向を持てないため、az/el は参照点（先頭 cam・なければ現在位置）での
// ENU→ECEF 光源方向を atmosphere.sunDirection へ直接書き込んで近似する。
// sun/sky/影は全てこの値を毎フレーム参照し、date 変更で天測値へ戻る。
// intensity/color は sun ハンドルへ適用する（複数 light: 行は最後を採用）
function applyQgisLights(lights, refCam) {
  const spec = (lights || [])
    .map(l => l?.opts || {})
    .filter(o => Number.isFinite(Number(o.az)) || Number.isFinite(Number(o.el)))
    .pop();
  if (!spec) return;
  const lon = Number(refCam?.longitude ?? refCam?.lng ?? lastCam.lng);
  const lat = Number(refCam?.latitude ?? refCam?.lat ?? lastCam.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  const az = (Number(spec.az) || 0) * Math.PI / 180;
  const el = (Number.isFinite(Number(spec.el)) ? Number(spec.el) : 45) * Math.PI / 180;
  const lam = lon * Math.PI / 180, phi = lat * Math.PI / 180;
  const ce = Math.cos(el);
  const de = Math.sin(az) * ce, dn = Math.cos(az) * ce, du = Math.sin(el);
  const sx = -de * Math.sin(lam) - dn * Math.sin(phi) * Math.cos(lam) + du * Math.cos(phi) * Math.cos(lam);
  const sy = de * Math.cos(lam) - dn * Math.sin(phi) * Math.sin(lam) + du * Math.cos(phi) * Math.sin(lam);
  const sz = dn * Math.cos(phi) + du * Math.sin(phi);
  try { view.atmosphere?.sunDirection?.set?.(sx, sy, sz); } catch (_) {}
  const upd = {};
  const inten = Number(spec.intensity);
  if (Number.isFinite(inten)) { upd.intensity = inten; fx.sunInt[photorealScene ? "pr" : "manual"] = inten; }
  if (/^#[0-9a-f]{6,8}$/i.test(String(spec.color || ""))) { upd.color = new Color().setHex(parseInt(spec.color.slice(1, 7), 16)); upd.applyColor = true; }
  if (Object.keys(upd).length) { try { sunHandle()?.update?.({ sun: upd }); } catch (_) {} }
  syncFxUi();
}
// scene3d: 行（QGIS 3Dシーン設定）→ 背景色・空表現・影・AO の近似反映。
// skybox= は写実シーンの空メッシュ表示切替、background= はクリアカラー
// （skybox 未指定で background 指定時は単色背景を優先＝空を隠す。Cesium 版と同じ優先順位）。
// edl= は Navara に対応エフェクトが無いため無視する
function applyQgisScene3d(scene3d) {
  const opts = scene3d?.opts;
  if (!opts) return;
  const onoff = v => /^(on|true|1)$/i.test(String(v));
  const bg = /^#[0-9a-f]{6,8}$/i.test(String(opts.background || "")) ? String(opts.background) : null;
  if (bg) {
    currentClearHex = parseInt(bg.slice(1, 7), 16);
    try { view._renderer?.setClearColor?.(currentClearHex); } catch (_) {}
  }
  if (opts.skybox !== undefined || bg) {
    try { photorealScene?.sky?.update?.({ sky: { visible: opts.skybox !== undefined ? onoff(opts.skybox) : false } }); } catch (_) {}
  }
  if (opts.shadows !== undefined) {
    shadowOn = onoff(opts.shadows);
    const c = $("#nv-shadow"); if (c) c.checked = shadowOn;
    applyShadow();
  }
  if (opts.ao !== undefined) {
    fx.ssao = onoff(opts.ao);
    const c = $("#nv-ssao"); if (c) c.checked = fx.ssao;
    applyFxSsao();
  }
}
// 太陽日時コントロール（TZ選択＋日時入力＋スライダー）は shared/sun-time.js 共通

// where= のクライアント側適用。クエリ系(gpkg/duckdb/sql)はローダ側で
// 絞込済みのため対象外。残りの全件読み込み系ベクターは GeoJSON 取得後に
// compileWhereExpression で絞り、ソース生成用の FeatureCollection を返す
// (item._geojson 自体は無絞込のまま保持し、属性一覧・検索は全件対象とする)
function whereFilteredGeojson(item) {
  let fc = item?._geojson;
  const where = item?.opts?.where;
  if (where && !QUERY_TYPES.has(item?.type) && fc?.features?.length) {
    try {
      const pred = compileWhereExpression(where);
      const kept = fc.features.filter((f, i) => pred(f, i));
      if (kept.length !== fc.features.length) fc = { ...fc, features: kept };
    } catch (e) {
      console.warn(`where= の式を適用できません (${item?.title}):`, e?.message || e);
    }
  }
  // 属性テーブルの「フィルター反映」(表示限定・where= の後段)を適用する
  if (item?._attrMapFilter && fc?.features?.length) {
    const kept = fc.features.filter(f => item._attrMapFilter(f));
    if (kept.length !== fc.features.length) fc = { ...fc, features: kept };
  }
  return fc;
}

// ---- QML <labeling> → Navara text マテリアル ----
// フォントは Google Fonts CSS 経由で unicode-range 分割フェッチされる。
// 未登録 family の text マテリアルは描画されないため、登録失敗時は付けない
const _qmlFontCache = new Map(); // "fam@weight" → Promise<string|null>
function qmlLabelFont(family, bold) {
  const fam = family || "Noto Sans JP";
  const key = `${fam}@${bold ? 700 : 400}`;
  if (!_qmlFontCache.has(key)) {
    _qmlFontCache.set(key, (async () => {
      const tryFam = async name => {
        const ff = await fetchFontFamilyFromCss(name,
          `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@${bold ? 700 : 400}`);
        view.addFontFamily(ff);
        return name;
      };
      try { return await tryFam(fam); }
      catch (_) {
        try { return await tryFam("Noto Sans JP"); }
        catch (e) { console.warn("QML ラベルフォントを登録できません:", fam, e); return null; }
      }
    })());
  }
  return _qmlFontCache.get(key);
}

// ---- .kasc → Navara ----
async function addKascLayer(item, baseUrl) {
  const url = item.url ? resolveKascUrl(item.url, baseUrl) : null;
  if (item.type === "3dtiles") {
    const src = view.addSource({ type: "3d-tiles", url });
    const desc = { type: "3d-tiles", source: src, model: { color: new Color().setHex(0xffffff), metalness: 0, roughness: 1, castShadow: true, receiveShadow: true } };
    const layer = view.addLayer(desc);
    return { src, layer, desc };
  }
  if (RASTER_TYPES.has(item.type) || item.type === "wms" || item.type === "wmts") {
    // wms:/wmts: はタイル URL テンプレートへ正規化してラスタタイルとして載せる
    const turl = item.type === "wms" ? buildWmsTileTemplate(url, item.opts || {})
      : item.type === "wmts" ? buildWmtsTileTemplate(url, item.opts || {}) : url;
    const src = view.addSource({ type: "raster-tile", url: turl, maxZoom: Number(item.opts?.maxzoom) || 18, ...(item.opts?.minzoom ? { minZoom: Number(item.opts.minzoom) } : {}) });
    const desc = { type: "raster", source: src };
    const layer = view.addLayer(desc);
    return { src, layer, desc };
  }
  if (item.type === "mvt") {
    // MVT ベクトルタイル → Navara ネイティブの vector-tile ソース。
    // sourceLayers= は行の layers=/srclayers= 指定から取る(未指定時は全レイヤ描画)
    const srcLayers = String(item.opts?.srclayers ?? item.opts?.sourcelayers ?? item.opts?.layers ?? "")
      .split(",").map(s => s.trim()).filter(Boolean);
    const src = view.addSource({ type: "vector-tile", url,
      maxZoom: Number(item.opts?.maxzoom ?? item.opts?.maximumlevel) || undefined,
      minZoom: Number(item.opts?.minzoom ?? item.opts?.minimumlevel) || undefined });
    const desc = { type: "vector", source: src,
      ...(srcLayers.length ? { sourceLayers: srcLayers } : {}),
      polygon: { color: 0x4488cc, clampToGround: true, opacity: 0.5, transparent: true },
      polyline: { color: 0x2266aa, width: 2, clampToGround: true, opacity: 1 },
      point: { color: 0x2266aa, clampToGround: true, opacity: 1, sizeInMeters: false } };
    const layer = view.addLayer(desc);
    return { src, layer, desc };
  }
  if (VECTOR_TYPES.has(item.type)) {
    const loaded = item._geojson ? { geojson: item._geojson } : await loadVectorItem(item, baseUrl, null, vectorHooks);
    item._geojson = loaded.geojson;
    // default_style: 行の既定値（地物側指定 > style=QML > default_style: > エンジン既定。
    // Navara はレイヤ単位マテリアルのため地物ごとの解決はできずレイヤ既定へ畳み込む）
    const ds = currentDefaultStyles || {};
    const pd = ds.point ? resolveDefaultPointStyle({}, ds.point, {}) : null;
    const ld = ds.line ? resolveDefaultLineStyle({}, ds.line, {}) : null;
    const gd = ds.polygon ? resolveDefaultPolygonStyle({}, ds.polygon, ds.line, {}) : null;
    // QML スタイル: 代表地物の spec からレイヤ既定色を取る（Navara はレイヤ単位マテリアル）
    let fillCss = item.opts?.fill, strokeCss = item.opts?.stroke || item.opts?.color, markerCss = item.opts?.marker_color;
    let lineDash = null, lineCap = null;
    if (item.opts?.style) {
      try {
        const compiled = await loadCompiledQml(item.opts.style, baseUrl, "navara");
        item._qml = compiled;
        const spec = compiled.evaluate?.(item._geojson?.features?.[0]?.properties || {});
        const s = specToStyle(spec);
        if (s) { fillCss ||= s.fill; strokeCss ||= s.stroke; markerCss ||= s.markerColor; lineDash = s.dash; lineCap = s.cap; }
      } catch (_) {}
    }
    fillCss ||= gd?.fill;
    strokeCss ||= gd?.stroke ?? ld?.color;
    markerCss ||= pd?.color;
    // 不透明度: opts 明示(fill_opacity/stroke_opacity/opacity) > 色のアルファ
    // (QML rgba 含む) > default_style: > 既定。塗りは他エンジンと同じ半透明 0.4 が既定。
    // Navara マテリアルは透過描画に transparent フラグも必要
    const oNum = v => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null; };
    const aOf = css => { const a = cssColorAlpha(css); return a < 1 ? a : null; };
    const polyFillO = oNum(item.opts?.fill_opacity) ?? oNum(item.opts?.opacity) ?? aOf(fillCss) ?? gd?.fillOpacity ?? 0.4;
    const polyLineO = oNum(item.opts?.stroke_opacity) ?? oNum(item.opts?.opacity) ?? aOf(strokeCss) ?? gd?.strokeOpacity ?? ld?.opacity ?? 1;
    const pointO = oNum(item.opts?.opacity) ?? aOf(markerCss) ?? pd?.opacity ?? 1;
    // extrude=<m>(#60)・QML 2.5D レンダラ → PolygonMaterial.extrudedHeight(m)。
    // 地物別の上書きは FeatureEvaluator の extrudedHeight で同値を返す
    const extrudeH = Math.max(Number(item.opts?.extrude) || 0, item._qml?.d25?.height || 0);
    // QML マーカー: 形状・画像を含むため markerLayersToCanvas で canvas 化し、
    // billboard の地物別 image(URL/dataURL、atlas 収容)で差し替える
    let markerImageFor = null;
    let billboardMat = null;
    const hasPointGeoms = (item._geojson?.features || []).some(f => /point/i.test(f?.geometry?.type || ""));
    if (item._qml && hasPointGeoms) {
      const cache = new Map();
      markerImageFor = props => {
        let spec = null;
        try { spec = item._qml.evaluate?.(props || {}); } catch (_) { return null; }
        if (!spec?.markers?.length) return null;
        const key = JSON.stringify(spec.markers.map(m =>
          [m.kind, m.shape, m.sizePx, m.widthPx, m.heightPx, m.fill, m.stroke,
           m.strokeWidthPx, m.rotationDeg, m.offsetPx, m.alpha, m.text, m.fontFamily]));
        let e = cache.get(key);
        if (e === undefined) {
          try {
            const cv = markerLayersToCanvas(spec.markers);
            e = cv ? { url: cv.toDataURL(), h: cv.height } : null;
          } catch (_) { e = null; }
          cache.set(key, e);
        }
        return e;
      };
      const hasMarkers = (item._geojson.features || []).slice(0, 50)
        .some(f => markerImageFor(f.properties || {}));
      // 1x1 透過 PNG を既定 url にし、実画像は FeatureEvaluator.image で供給
      // (マーカー無し地物は透過プレースホルダ＝非表示)
      if (hasMarkers) billboardMat = {
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        sizeInMeters: false, size: 1,
        geometryTypes: ["point"], transparent: true, opacity: pointO,
        clampToGround: true, billboardFacing: "upright", rotateWithCamera: true,
      };
    }
    // invertedPolygonRenderer: 世界矩形 − 地物リング(穴)マスク(他エンジンと
    // 同じ近似)。_geojson を破壊しないよう geometry オブジェクトだけ複写する
    let geoData = whereFilteredGeojson(item);
    if (item._qml?.inverted && geoData?.features?.length) {
      geoData = { ...geoData, features: geoData.features.map(f =>
        f?.geometry ? { ...f, geometry: { ...f.geometry } } : f) };
      applyInvertedMaskGeojson(geoData);
    }
    const src = view.addSource({ type: "geojson", data: geoData, tiled: true });
    // 破線は Navara 0.3.x の PolylineMaterial.dashArray（線幅倍率）で実現。
    // QML の dash は px 長なので線幅で割って倍率へ換算する
    const polyWidth = Number(item.opts?.width) || gd?.strokeWidth || ld?.width || 3;
    // <labeling>: Navara text マテリアルへ写像。文字列・サイズ・優先度は
    // FeatureEvaluator で地物ごとに評価する（レイヤ単位マテリアルの制約内）
    let textMat = null;
    if (item._qml?.labelFor) {
      const sample = (item._geojson?.features || []).map(f => {
        try { return item._qml.labelFor(f.properties || {}); } catch (_) { return null; }
      }).find(s => s?.text);
      if (sample) {
        const fam = await qmlLabelFont(sample.family, sample.bold);
        if (fam) {
          const [ox, oy] = sample.pixelOffsetOf?.() || [0, 0];
          textMat = {
            font: fam,
            size: Math.max(sample.sizePx || 12, 1),
            sizeInMeters: false,
            color: css2hex(rgbaToCss(sample.fill || [0, 0, 0, 1])),
            transparent: true,
            ...(sample.halo ? { outlineColor: css2hex(rgbaToCss(sample.halo.color)), outlineWidth: Math.max(sample.halo.widthPx || 0, 0) } : {}),
            ...(sample.background?.fill ? { backgroundColor: css2hex(rgbaToCss(sample.background.fill)) } : {}),
            geometryTypes: ["point", "line", "polygon"],
            // ベースマップ無しでも見えるようドレープせず直立表示
            clampToGround: false, textFacing: "upright",
            declutter: !sample.displayAll,
            ...(sample.priority ? { declutterPriority: sample.priority } : {}),
            ...(ox || oy ? { translate: { x: ox, y: oy } } : {}),
          };
        }
      }
    }
    const desc = { type: "vector", source: src,
      polygon: { color: css2hex(fillCss || "#3d7dd9"), clampToGround: extrudeH <= 0, opacity: polyFillO, transparent: polyFillO < 1,
        ...(extrudeH > 0 ? { extrudedHeight: extrudeH } : {}) },
      polyline: { color: css2hex(strokeCss || "#2c5ea8"), width: polyWidth, clampToGround: true, opacity: polyLineO, transparent: polyLineO < 1, geometryTypes: ["line", "polygon"],
        ...(lineCap ? { cap: lineCap } : {}),
        ...(lineDash?.length ? { dashArray: Float32Array.from(lineDash.map(d => d / polyWidth)) } : {}) },
      // QML マーカーがある場合は billboard(canvas 画像)で描き、point は
      // 付けない(二重描画防止)。マーカー無しは従来どおりの点マテリアル
      ...(billboardMat ? { billboard: billboardMat }
        : { point: { color: css2hex(markerCss || "#d94f3d"), clampToGround: true, opacity: pointO, transparent: pointO < 1 } }),
      ...(textMat ? { text: textMat } : {}) };
    const layer = view.addLayer(desc);
    // QML の地物別スタイル・ラベルは FeatureEvaluator で焼き込む。
    // メッシュ種別(meshGeomType)ごとに適用キーを切り替える:
    //   polygon → color/opacity/extrudedHeight
    //   polyline → color/width/opacity
    //   point/billboard → image(canvas dataURL)+size / color
    //   text → text/show/size/declutterPriority/rotation
    // spec 未解決(ルール外)の地物は show:false で非表示にする
    const compiled = item._qml;
    if (compiled) {
      const done = new Set();
      const applyStyle = ({ evaluator }) => {
        if (done.has(evaluator.id)) return;
        done.add(evaluator.id);
        try {
          evaluator.evaluate(info => {
            try {
            const props = info?.properties || {};
            const gt = info?.meshGeomType;
            const v = {};
            if (textMat) {
              const s = compiled.labelFor?.(props);
              if (s?.text) {
                v.text = s.text; v.show = true;
                if (gt !== "point" && s.sizePx) v.size = Math.max(s.sizePx, 1);
                if (s.priority) v.declutterPriority = s.priority;
                if (s.rotationDeg) v.rotation = s.rotationDeg;
              }
            }
            const spec = compiled.evaluate?.(props);
            if (!spec) { if (gt !== "text") v.show = false; return v; }
            if (gt === "polygon") {
              const solid = spec.fillParts?.find(pt => pt.solid)?.solid || spec.fillParts?.[0]?.hatch?.color || null;
              if (solid) {
                v.color = new Color().setStyle(rgbaToCss(solid));
                if (solid.length > 3 && solid[3] < 1) v.opacity = solid[3];
              }
              if (extrudeH > 0) v.extrudedHeight = extrudeH;
            } else if (gt === "polyline") {
              const strokeSrc = spec.outline || spec.line;
              if (strokeSrc) {
                v.color = new Color().setStyle(rgbaToCss(strokeSrc.color));
                if (strokeSrc.widthPx) v.width = Math.max(strokeSrc.widthPx, 0.5);
                if (strokeSrc.color?.length > 3 && strokeSrc.color[3] < 1) v.opacity = strokeSrc.color[3];
              }
            } else if (gt !== "text") {
              // 点: マーカー canvas を billboard.image へ(dataURL は atlas へ収容)
              const mi = markerImageFor?.(props);
              if (mi) { v.image = mi.url; v.size = Math.max(mi.h, 1); }
              else {
                const mk = spec.markers?.[0];
                if (mk?.fill) v.color = new Color().setStyle(rgbaToCss(mk.fill));
              }
            }
            return v;
            } catch (_) { return {}; }
          });
        } catch (e) { console.warn("QML 地物スタイル評価に失敗:", e); }
      };
      layer.on("featureCreated", applyStyle);
      layer.on("featureUpdated", applyStyle);
    }
    return { src, layer, desc };
  }
  return null;
}

async function renderLayers(doc, baseUrl) {
  for (const e of layerEntries) { try { e.layer?.delete(); } catch (_) {} try { e.src?.delete(); } catch (_) {} }
  layerEntries.length = 0;
  // default_style:/legend:/fly_geojson: もここで doc から反映する
  // （renderLayers は loadProject とインスペクタ適用の共通経路）
  currentDefaultStyles = doc.defaultStyles || null;
  currentLegends = doc.legends || [];
  kascFlyPaths.setItems(doc.unsupported);
  const items = [...doc.layers, ...doc.unsupported.filter(u => u.type !== "fly_geojson" && !NON_LAYER_TYPES.has(u.type))]
    .sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
  const unsupported = doc.unsupported.filter(u => u.type !== "3dtiles" && u.type !== "mvt" && u.type !== "fly_geojson" && !NON_LAYER_TYPES.has(u.type));
  const visibleCount = items.filter(i => i.visible !== false).length;
  let done = 0;
  progress(0, visibleCount, "");
  for (const item of items) {
    const mountable = item.type === "3dtiles" || item.type === "mvt" || RASTER_TYPES.has(item.type)
      || item.type === "wms" || item.type === "wmts" || VECTOR_TYPES.has(item.type);
    const entry = { item, sid: String(item._idx ?? item.url), unsupported: (doc.unsupported.includes(item) && item.type !== "3dtiles" && item.type !== "mvt") || !mountable };
    layerEntries.push(entry);
    if (entry.unsupported || item.visible === false) { progress(++done, visibleCount); continue; }
    try {
      const r = await addKascLayer(item, baseUrl);
      if (r) { entry.src = r.src; entry.layer = r.layer; entry.desc = r.desc; }
    } catch (e) { entry.failed = true; entry.error = String((await diagnoseHubLayerError(item, e))?.message || e?.message || e); console.warn("layer failed", item.title, e); }
    progress(++done, visibleCount, item.title || item.url);
  }
  const notes = unsupported.map(u => `${u.type}: ${u.title || u.url || ""}`).join(" / ");
  if (notes) panel.unsupported.textContent = "未対応: " + notes;
  buildLayerList(); buildLegends(); syncAttribution();
}

// cam: プリセット + bookmark: 行(QGISブックマークXML) → カメラタブ。
// CAM / QGIS-XML の2系統をグループ見出し+それぞれの保存・読込ボタンで区別する
const CAM_GROUPS = [
  { key: "CAM", match: c => !c.bookmark, fileKey: "camsImportCamFile",
    onSave: items => downloadKascCamLines(items) },
  { key: "QGIS-XML", match: c => !!c.bookmark, fileKey: "camsImportFile",
    onSave: items => downloadQgisBookmarksXml(items) },
];
function fillCamPanel(cams) {
  panel.cams.innerHTML = "";
  for (const g of CAM_GROUPS) {
    const head = document.createElement("div");
    head.className = "cam-group-label";
    head.append(document.createTextNode(g.key));
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "保存";
    save.addEventListener("click", () => g.onSave(currentCams.filter(g.match)));
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "読込";
    load.addEventListener("click", () => panel[g.fileKey]?.click());
    head.append(save, load);
    panel.cams.append(head);
    for (const cam of cams.filter(g.match)) {
      const b = document.createElement("button");
      b.className = "cam-btn" + (cam.bookmark ? " bm-btn" : ""); b.type = "button";
      b.textContent = cam.name || `${cam.latitude.toFixed(4)},${cam.longitude.toFixed(4)}`;
      b.addEventListener("click", () => flyTo({ longitude: cam.longitude, latitude: cam.latitude, height: cam.height, heading: cam.heading, pitch: cam.pitch }));
      panel.cams.append(b);
    }
  }
}
// 各グループ見出しの「読込」ボタンが開く file input のハンドラ
if (panel.camsImportFile) panel.camsImportFile.onchange = async e => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f) return;
  const added = parseQgisBookmarksXml(await f.text()).map(bm => {
    const cam = qgisBookmarkToCam(bm);
    cam.bookmark = true;
    return cam;
  });
  if (!added.length) return;
  currentCams = currentCams.concat(added);
  fillCamPanel(currentCams);
};
if (panel.camsImportCamFile) panel.camsImportCamFile.onchange = async e => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f) return;
  const added = parseKasc(await f.text()).cams;
  if (!added.length) return;
  currentCams = currentCams.concat(added);
  fillCamPanel(currentCams);
};

// .kasc 文書(doc)を描画する。loadProject(ファイル読込)と
// インスペクター(テキスト適用)の共通経路。
// presetBase はエンジン遷移時の session ベースマップ（無い起動は undefined）
async function renderDoc(doc, baseUrl, presetBase) {
  applyPanelTitle(doc.title);

  // ポータル宣言(doc.views/htmlSections/links/portal、parseKasc 済み)を
  // カード・セクションへ展開する(Cesium 版 applyInspector の収集に相当)
  inspectorViews.splice(0, inspectorViews.length);
  inspectorHtmlSections.splice(0, inspectorHtmlSections.length);
  inspectorLinks.splice(0, inspectorLinks.length);
  inspectorPortalCards.splice(0, inspectorPortalCards.length);
  inspectorPortalSpec = doc.portal || null;
  inspectorPanelTitle = doc.title || null;
  activeViewName = null;
  viewSnapshot = null;
  for (const view of doc.views || []) {
    inspectorViews.push(view);
    inspectorPortalCards.push({ kind: "view", entry: view });
  }
  for (const link of doc.links || []) {
    inspectorLinks.push(link);
    inspectorPortalCards.push({ kind: "link", entry: link });
  }
  // view:/link: カードは宣言順を保持する。parseKasc は型別に分離するため、
  // ここで各行(.line)のインスペクタ内出現位置で並べ直す
  {
    const lineOrder = new Map();
    (panel.inspector?.value || lastKascRaw || "").split(/\r?\n/).forEach((l, i) => {
      const k = l.trim();
      if (k && !lineOrder.has(k)) lineOrder.set(k, i);
    });
    inspectorPortalCards.sort((a, b) => (lineOrder.get(a.entry.line) ?? 1e9) - (lineOrder.get(b.entry.line) ?? 1e9));
  }
  // html: 行は parseKasc が spec=値全体(タイトル含む)で返すため、行から
  // 本文を取り直して 1 フィールド形式も吸収する(Cesium 版と同じ規則:
  // `<` 始まりはインラインHTML、それ以外はファイル/URL として解決)
  for (const sec of doc.htmlSections || []) {
    const raw = String(sec.line || "");
    const value = raw.slice(raw.indexOf(":") + 1).trim();
    const parts = value.split("|").map(part => part.trim());
    const body = parts.slice(1).join("|") || parts[0];
    const spec = body.startsWith("<") ? body : resolveProjectUrl(body);
    inspectorHtmlSections.push({ title: parts.length > 1 ? parts[0] : "", spec, line: sec.line });
  }
  inspectorNews.splice(0, inspectorNews.length, ...(doc.news || []));

  // ベースマップ
  panel.basemap.hidden = false;
  // base: 行の特殊モード(transparent=地表透明 / none=ベースマップなし)は
  // 選択肢ではなく初期モードとして解釈する(Cesium 版と同じ)
  const baseModeRow = (doc.bases || []).find(b => b.mode);
  baseDocs = doc.bases.filter(b => !b.mode);
  try {
    docBackgroundHex = doc.background ? css2hex(doc.background, 0xffffff) : null;
    // transparent/none とも透過後の見た目は白で統一(他エンジンと同じ)
    setGlobeTransparent(!!baseModeRow?.mode, docBackgroundHex ?? 0xffffff);
    // 透過時の下敷きは他エンジンと揃えて白(既定)。background: 行で任意色へ変更可
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.style.background = doc.background || "#fff";
  } catch (_) {}
  panel.basemapSelect.replaceChildren();
  // 「ベースマップなし」を明示選択できるよう先頭に置く(他エンジンとのパリティ)
  {
    const noneOpt = document.createElement("option");
    noneOpt.value = "-1"; noneOpt.textContent = "ベースマップなし";
    panel.basemapSelect.append(noneOpt);
  }
  appendGroupedTitleOptions(panel.basemapSelect, baseDocs, (b, title, i) => {
    const opt = document.createElement("option"); opt.value = String(i); opt.textContent = title; return opt;
  });
  // 初期選択は session 値 > .kasc 初期値（|off でない先頭＝他エンジンと同じ規則）。
  // 先頭固定で描画してから差し替えると別タイルが一瞬表示される
  const noneSel = presetBase && /^(none|なし|ベースマップなし)$/i.test(String(presetBase.id ?? presetBase.title ?? ""));
  let initIdx = -1;
  if (presetBase && !noneSel) {
    initIdx = presetBase.title ? baseDocs.findIndex(b => b.title === presetBase.title) : -1;
    if (initIdx < 0 && Number.isFinite(Number(presetBase.id))) {
      const i = Number(presetBase.id);
      if (i >= 0 && i < baseDocs.length) initIdx = i;
    }
  }
  if (!noneSel && initIdx < 0) initIdx = Math.max(0, baseDocs.findIndex(b => b.visible !== false));
  // base: 行の | none / | transparent モードは初期でベースマップを張らない
  // (Cesium 版の parsedBaseMode → selectedBasemap=null と同じ規則)
  if (baseModeRow) initIdx = -1;
  panel.basemapSelect.value = String(noneSel ? -1 : initIdx);
  syncBasemapList(panel.basemapSelect);
  await applyBasemap(noneSel ? -1 : initIdx);

  await renderLayers(doc, baseUrl);

  // terrain: 行(#60)。exaggeration に加え shading/generator も Navara へ反映
  try {
    const topts = doc.terrain?.opts || {};
    const ex = Number(topts.exaggeration);
    if (Number.isFinite(ex) && ex >= 0 && ex !== 1) {
      const inp = $("#nv-terrain-exagg");
      if (inp) inp.value = String(ex);
      applyTerrainExaggeration(ex);
    }
    // generator=flat|none|off は QGIS フラット地形 → 地形レイヤ OFF（トグルも同期）
    if (/^(flat|none|off)$/i.test(String(topts.generator || ""))) {
      const c = $("#nv-terrain"); if (c) c.checked = false;
      await applyTerrain(false);
    }
    // shading= → TerrainMaterial.lit（地形レイヤ無しでも次回 ON 時へ持ち越す）
    if (topts.shading !== undefined) applyTerrainShading(/^(on|true|1)$/i.test(String(topts.shading)));
    // offset= は Navara の直接相当が無いため保持のみ（Cesium 版と同じ扱い）
  } catch (_) {}

  // scene3d:/light: 行（QGIS 3Dシーン・平行光源）を効果設定へ近似反映
  try { applyQgisScene3d(doc.scene3d); } catch (_) {}
  try { applyQgisLights(doc.lights, doc.cams[0]); } catch (_) {}

  // テーマ
  currentThemes = doc.themes || [];
  fillThemeSelect(panel.themeSelect, currentThemes);
  panel.themeSelect.hidden = !currentThemes.length;

  // cam（ブックマーク XML 展開込み）
  currentCams = doc.cams.concat(await loadKascBookmarks(doc.bookmarks, baseUrl).catch(() => []));
  fillCamPanel(currentCams);

  // info タブ
  panel.infoLink.replaceChildren();
  void loadKascInfoContent(panel.infoLink, doc.info, baseUrl);

  // QGIS ライブ双方向連携(#62): live: 行があれば live.json ポーリング開始
  configureLive(doc, {
    baseUrl,
    kascUrl: lastKascUrl || null,
    applyKascText: liveApplyText,
    getView: () => {
      syncCamFromView();
      return {
        latitude: lastCam.lat, longitude: lastCam.lng,
        height: lastCam.height, zoom: navaraZoom(),
        pitch: lastCam.pitch, heading: lastCam.heading,
      };
    },
    applySelection: sel => applyQgisSelection(sel),
  });

  // ポータル画面の内容を最新の宣言へ反映する(🏠ボタン表示もここで更新)
  updatePortalUI();
  // portal: 行があり open=manual でなければプロジェクト読込後の初回のみ
  // ポータルを自動表示する(インスペクタ再適用では再表示しない)
  if (!portalAutoOpened && inspectorPortalSpec?.enabled && inspectorPortalSpec.open !== "manual") {
    portalAutoOpened = true;
    openPortal();
  }
}

// QGIS 側選択 → 地物ハイライト(#62 双方向)。
// ツールオーバーレイと同じ addSource/addLayer で黄色ベクターを重ねる
let qgisSelSrc = null, qgisSelLayer = null;
function applyQgisSelection(sel) {
  try { qgisSelLayer?.delete?.(); } catch (_) {}
  try { qgisSelSrc?.delete?.(); } catch (_) {}
  qgisSelLayer = qgisSelSrc = null;
  try {
    const specs = Array.isArray(sel?.layers) ? sel.layers
      : (sel?.layer || Array.isArray(sel?.ids) ? [sel] : []);
    const features = [...(Array.isArray(sel?.features) ? sel.features : [])];
    for (const spec of specs) {
      const title = String(spec.layer || spec.title || "").trim();
      const leaf = title.split("/").pop();
      const ids = new Set((spec.ids || []).map(v => String(v)));
      const entry = layerEntries.find(e => e.item?.title === title)
        || layerEntries.find(e => String(e.item?.title || "").split("/").pop() === leaf);
      for (const f of entry?.item?._geojson?.features || []) {
        const fid = f?.id ?? f?.properties?.id ?? f?.properties?.fid;
        if (fid != null && ids.has(String(fid))) features.push(f);
      }
    }
    if (!features.length || !view) return;
    qgisSelSrc = view.addSource({ type: "geojson", data: { type: "FeatureCollection", features }, tiled: false });
    qgisSelLayer = view.addLayer({ type: "vector", source: qgisSelSrc,
      polygon: { color: 0xffff00, clampToGround: true, opacity: 0.3, transparent: true },
      polyline: { color: 0xffff00, width: 3, clampToGround: true, opacity: 1 },
      point: { color: 0xffff00, clampToGround: true, opacity: 1 } });
  } catch (_) { /* ハイライト失敗は無視 */ }
}

// session-state の可視性を描画前の doc アイテムへ先適用する。
// renderLayers が doc 上の |on でレイヤを追加・表示してから applySessionState で
// 隠す流れだと、session で OFF のレイヤが一瞬表示され無駄な読込も発生する。
// 照合は sessionVisChanges（完全タイトル→葉名一意の2段）を流用し、
// 排他グループ(//)の正規化も applySessionState と同じルールで行う
function applySessionVisToDoc(doc, vis) {
  if (!vis || typeof vis !== "object") return;
  const items = [...doc.layers, ...doc.unsupported.filter(u => u.type !== "fly_geojson" && !NON_LAYER_TYPES.has(u.type))];
  const grpOf = i => { const sp = splitKascTitle(i.title); return `${sp.group}|${sp.exclusiveGroup}`; };
  const isExcl = i => splitKascTitle(i.title).exclusiveGroup;
  for (const { entry: item, on } of sessionVisChanges(items, vis, i => i.title, i => i.visible !== false)) {
    item.visible = on;
    if (on && isExcl(item)) {
      const g = grpOf(item);
      for (const sib of items) {
        if (sib !== item && grpOf(sib) === g && sib.visible !== false) sib.visible = false;
      }
    }
  }
}

async function loadProject(projectId) {
  const { id, manifest, baseUrl, doc, raw, kascUrl } = await loadKascProject(projectId);
  currentProjectId = id; lastBaseUrl = baseUrl; lastKascRaw = raw || ""; lastKascUrl = kascUrl || "";
  // プロジェクト読込ごとの起動時ポータル自動表示を1回に戻す
  portalAutoOpened = false;
  // カレント状態ファイルは初回描画へ一度だけ適用する
  const sess = pendingSession; pendingSession = null;
  // インスペクタは「現在の .kasc」（切替元の編集込み）を優先。
  // 初期表示はファイル内容。プロジェクト切替時も新しい raw で更新する
  const text = sess?.inspector ?? lastKascRaw;
  if (panel.inspector) panel.inspector.value = text;

  panel.project.replaceChildren();
  appendGroupedTitleOptions(panel.project, manifest, (m, title) => {
    const opt = document.createElement("option");
    opt.value = m.id || m; opt.textContent = title || m.title || m.id || m;
    if ((m.id || m) === id) opt.selected = true;
    return opt;
  });
  if (![...panel.project.options].some(o => o.value === id)) {
    const opt = document.createElement("option"); opt.value = id; opt.textContent = doc.title || id; panel.project.append(opt);
  }
  panel.project.value = id;

  const renderDocTarget = text === lastKascRaw ? doc : parseKasc(text);
  applySessionVisToDoc(renderDocTarget, sess?.vis);
  await renderDoc(renderDocTarget, baseUrl, sess?.basemap);

  // カレント状態のレイヤ関連を復元（vis は完全タイトル→葉名一意の2段照合）
  applySessionState(sess, {
    entries: layerEntries, themeSelect: panel.themeSelect,
    setVisible: (e, on) => { setEntryVisible(e, on); if (on && !e.unsupported) void maybeLoadEntry(e); },
    rerender: () => { buildLayerList(); syncAttribution(); },
  });

  // 初期カメラ: 初回のみ URL view/セッション > 先頭 cam。
  // プロジェクト切替（2回目以降）は新プロジェクトの cam へ移る（他エンジンと同じ）
  const uv = urlViewConsumed ? null : sessionBootView(sess);
  if (hasUrlView(uv)) setCamera({ longitude: uv.longitude, latitude: uv.latitude, height: urlViewHeight(uv), heading: uv.heading, pitch: uv.pitch });
  else if (renderDocTarget.cams[0]) { const c = renderDocTarget.cams[0]; flyTo({ longitude: c.longitude, latitude: c.latitude, height: c.height, heading: c.heading, pitch: c.pitch }); }
  urlViewConsumed = true;
}

function setInspectorStatus(msg, isErr) {
  const el = $("#inspector-status");
  if (el) { el.textContent = msg; el.style.color = isErr ? "#c33" : ""; }
}

// QGIS ライブ連携(#62): 更新検出 → 全体再適用(レイヤ単位差分は
// cesium/maplibre が対応。本エンジンは互換ビューとして全適用)
async function liveApplyText(text) {
  if (panel.inspector) panel.inspector.value = text;
  await applyInspectorText(text);
}

// インスペクタ: テキスト → doc 再構築してレイヤ反映
async function applyInspectorText(text) {
  const doc = parseKasc(text || "");
  lastKascRaw = text;
  await renderDoc(doc, lastBaseUrl);
  setInspectorStatus("反映しました");
}

// ---- ポータル(portal:/html:/view:/link: 行で構成する開始画面) ----
// UI 構築は shared/portal.js へ共通化。ここでは状態getterと
// applyView/clearView を束ねた遅延インスタンスを提供する（Cesium 版と同型）

// 本エンジンは i18n 初期化を持たないため、ポータルが使う portal.* キーだけを
// shared/i18n/ja.json と同じ値でローカル提供する最小限の t()
const PORTAL_T = {
  "portal.open": "ポータル",
  "portal.openTitle": "ポータル画面を開く",
  "portal.close": "地図を開く",
  "portal.views": "ビュー",
  "portal.links": "リンク",
  "portal.clearView": "ビュー解除",
  "portal.loadFailed": "読み込みに失敗しました: {error}",
  "portal.news": "お知らせ",
  "portal.newsEmpty": "記事がありません。",
  "portal.newsOpen": "開く",
  "portal.newsFeature": "地図で見る",
  "portal.defaultNews": "まだお知らせはありません。kasc ファイルに `html:タイトル | <HTML>またはファイル/URL` 行を追加するとここに表示されます。",
  "portal.defaultViews": "まだ目的別ボタンはありません。`view:` 行で表示レイヤ・スタイル・フィルタ・カメラをまとめたカード、`link:` 行で外部サイトへのカードを追加できます。",
  "portal.about": "ポータル機能について",
  "portal.aboutHtml": "<p>.kasc に以下の行を書くとポータルを構成できます。</p><ul><li><code>portal:on | title=見出し | open=auto|manual</code> — ポータルの有効化・タイトル・起動時表示</li><li><code>html:タイトル | HTMLまたはファイル/URL</code> — お知らせ等のセクション(記述順)</li><li><code>news:JSONまたはMarkdownファイル/URL | limit=件数 | title=見出し</code> — お知らせフィード(日付降順・記事の view/link/feature で地図遷移)</li><li><code>view:名前 | desc=説明 | img=画像 | cam=カメラ名 | レイヤ[;style=…][;where=式]</code> — 目的別の表示切替カード</li><li><code>link:名前 | url=URL | desc=説明 | img=画像</code> — 外部サイトへのリンクカード</li></ul>",
};
const t = (key, vars) => String(PORTAL_T[key] ?? key)
  .replace(/\{(\w+)\}/g, (m, n) => (vars?.[n] != null ? String(vars[n]) : m));

// canvas_data/ 等の相対参照 → プロジェクト基準 URL へ解決(Cesium 版 resolveProjectUrl
// の Navara 版。cloud: 等の特殊スキームは resolveKascUrl 側が処理する)
const resolveProjectUrl = url => resolveKascUrl(url, lastBaseUrl);

// ---- ビュー(view: 行。表示+スタイル+フィルタ+カメラ+背景を束ねた目的別プリセット) ----

// ビュー適用前の状態を記録する。ビュー解除でこの状態へ戻す
function captureViewSnapshot() {
  const entries = new Map();
  for (const entry of layerEntries) {
    entries.set(entry, {
      visible: entry.item.visible !== false,
      where: entry.item.opts?.where,
      style: entry.item.opts?.style,
      line: entry.item.line,
    });
  }
  return { entries, camera: { ...lastCam }, basemapIdx: currentBasemapIdx };
}

// レイヤーに対応するビュー側指定(styles/wheres マップ。フルパス→葉名の順で照合)
function viewSpecFor(view, mapName, item) {
  const map = view?.[mapName] || {};
  const key = normKascTitle(item.title);
  return map[key] ?? map[key.split("/").pop()];
}

// ビュー適用: 表示・where= 絞込・;style= 差替を反映し、変更のあった読込済み
// レイヤーを再読み込みする。初回適用時はスナップショットを取る
async function applyKascView(view) {
  if (!view) return;
  if (!viewSnapshot) viewSnapshot = captureViewSnapshot();
  activeViewName = view.name || null;
  const show = themeShowSet(view);
  const all = show == null;
  const reloads = [];
  for (const entry of layerEntries) {
    const item = entry.item;
    const member = all || kascTitleInTheme(item.title, show);
    setEntryVisible(entry, member);
    if (member) void maybeLoadEntry(entry);
    // ビューのメンバレイヤーは ;where= ;style= をビュー指定へ揃える。
    // ;where= が無くてもフィルタ解除まで含めてビュー指定を正とする
    // (スナップショットで解除時に復元される)。ビュー外のレイヤーは触らない
    if (member) {
      const where = viewSpecFor(view, "wheres", item);
      const style = viewSpecFor(view, "styles", item);
      if (item.type === "sql" || item.type === "ogrsql") {
        if (where) console.warn(`view:${view.name}: sql: レイヤーへの ;where= は未対応です`, item.title);
      } else {
        item.opts ||= {};
        const nextWhere = where || undefined;
        if ((item.opts.where || undefined) !== nextWhere) { item.opts.where = nextWhere; entry._viewDirty = true; }
      }
      item.opts ||= {};
      const nextStyle = style || undefined;
      if ((item.opts.style || undefined) !== nextStyle) { item.opts.style = nextStyle; entry._viewDirty = true; }
    }
    // 既読込レイヤーは opts 変更を反映するため作り直す（geojson ソースに
    // データ差替 API が無い。未読込レイヤーは maybeLoadEntry が新 opts で読む）
    if (entry._viewDirty && entry.layer) {
      entry._viewDirty = false;
      reloads.push(reloadEntryData(entry));
    }
  }
  // 背景地図(base=)・カメラ(cam=)は view:/portal data-* 共通ヘルパーへ
  if (view.base) await applyViewBase(view.base, `view:${view.name}`);
  if (view.cam) applyViewCam(view.cam, `view:${view.name}`);
  // inspector テキストの on/off と where= を同期(テーマ適用と同じ規則。
  // sql: 行はクエリ文字列が本文のため where= フィールドを書かない)
  if (panel.inspector) {
    const lines = panel.inspector.value.split(/\r?\n/);
    for (const entry of layerEntries) {
      const item = entry.item;
      if (!item.line) continue;
      const idx = lines.findIndex(l => l.trim() === item.line);
      let newLine = rewriteKascLineVisibility(item.line, show);
      if (item.type !== "sql" && item.type !== "ogrsql") newLine = rewriteKascLineOpt(newLine, "where", item.opts?.where ?? null);
      if (idx >= 0) lines[idx] = newLine;
      item.line = newLine;
    }
    panel.inspector.value = lines.join("\n");
  }
  if (reloads.length) { await Promise.allSettled(reloads); applyScaleVis(); }
  buildLayerList(); buildLegends(); syncAttribution();
  // QGIS ライブ連携: ビュー適用を QGIS プロジェクトへ書き戻す
  liveWritebackEntries(layerEntries, { theme: view?.name });
  updatePortalButton();
}

// view base=/portal data-base= 共通: タイトル/葉名で照合。
// none=ベースマップなし、transparent=地表透明(globe.transparent。Cesium 版と同じ)
async function applyViewBase(rawName, logPrefix = "data-base") {
  const name = String(rawName || "").trim();
  const isTransparent = /^(transparent|hide|透明)$/i.test(name);
  const isNone = isTransparent || /^(none|off|なし|ベースマップなし)$/i.test(name);
  let idx = -1;
  if (!isNone) {
    const n = normKascTitle(name);
    const leaf = n.split("/").pop();
    idx = baseDocs.findIndex(b => {
      const bt = normKascTitle(b.title);
      return bt === n || bt.split("/").pop() === leaf;
    });
    if (idx < 0) console.warn(`${logPrefix}: base= のベースマップが見つかりません`, name);
  }
  if (isNone || idx >= 0) {
    setGlobeTransparent(isNone, docBackgroundHex ?? 0xffffff);
    if (panel.basemapSelect) panel.basemapSelect.value = String(idx);
    await applyBasemap(idx);
    syncBasemapList(panel.basemapSelect);
  }
}

// view cam=/portal data-cam= 共通: カメラプリセット名で移動
function applyViewCam(name, logPrefix = "data-cam") {
  const preset = currentCams.find(c => c.name === name || c.title === name);
  if (preset) flyTo({ longitude: preset.longitude, latitude: preset.latitude, height: preset.height, heading: preset.heading, pitch: preset.pitch });
  else console.warn(`${logPrefix}: cam= のカメラプリセットが見つかりません`, name);
}

// ビュー解除: 適用前スナップショットへ復元する
async function clearKascView() {
  const snap = viewSnapshot;
  activeViewName = null;
  viewSnapshot = null;
  if (!snap) { updatePortalButton(); return; }
  const reloads = [];
  const showSet = new Set();
  for (const entry of layerEntries) {
    const s = snap.entries.get(entry);
    if (!s) continue;
    const item = entry.item;
    setEntryVisible(entry, s.visible);
    if (s.visible) void maybeLoadEntry(entry);
    item.opts ||= {};
    if ((item.opts.where || undefined) !== s.where) { item.opts.where = s.where; entry._viewDirty = true; }
    if ((item.opts.style || undefined) !== s.style) { item.opts.style = s.style; entry._viewDirty = true; }
    if (entry._viewDirty && entry.layer) {
      entry._viewDirty = false;
      reloads.push(reloadEntryData(entry));
    }
    if (item.visible !== false) {
      const n = normKascTitle(item.title);
      showSet.add(n); showSet.add(n.split("/").pop());
    }
  }
  // 表示状態を行へ戻す。復元後の可視レイヤータイトルをセットにして
  // rewriteKascLineVisibility で on/off を書き戻す
  if (panel.inspector) {
    const lines = panel.inspector.value.split(/\r?\n/);
    for (const entry of layerEntries) {
      const item = entry.item;
      if (!item.line) continue;
      const idx = lines.findIndex(l => l.trim() === item.line);
      let newLine = rewriteKascLineVisibility(item.line, showSet);
      if (item.type !== "sql" && item.type !== "ogrsql") newLine = rewriteKascLineOpt(newLine, "where", item.opts?.where ?? null);
      if (idx >= 0) lines[idx] = newLine;
      item.line = newLine;
    }
    panel.inspector.value = lines.join("\n");
  }
  // ベースマップ・カメラを適用前へ戻す
  if ((snap.basemapIdx ?? -1) !== currentBasemapIdx) {
    if (panel.basemapSelect) panel.basemapSelect.value = String(snap.basemapIdx ?? -1);
    await applyBasemap(snap.basemapIdx ?? -1);
    syncBasemapList(panel.basemapSelect);
  }
  if (snap.camera && Number.isFinite(snap.camera.lat)) {
    setCamera({ longitude: snap.camera.lng, latitude: snap.camera.lat, height: snap.camera.height, heading: snap.camera.heading, pitch: snap.camera.pitch });
  }
  if (reloads.length) { await Promise.allSettled(reloads); applyScaleVis(); }
  buildLayerList(); buildLegends(); syncAttribution();
  liveWritebackEntries(layerEntries);
  updatePortalButton();
}

let _kascPortal = null;
function kascPortal() {
  if (!_kascPortal) {
    _kascPortal = createKascPortal({
      t,
      resolveProjectUrl,
      loadInfoContent: loadKascInfoContent,
      applyView: view => applyKascView(view),
      clearView: () => clearKascView(),
      applyCam: name => applyViewCam(name),
      applyBase: name => { void applyViewBase(name).catch(err => console.warn("data-base:", err)); },
      getActiveViewName: () => activeViewName,
      getPortalSpec: () => inspectorPortalSpec,
      getPanelTitle: () => inspectorPanelTitle,
      getHtmlSections: () => inspectorHtmlSections,
      getNews: () => inspectorNews,
      getCards: () => inspectorPortalCards,
    });
  }
  return _kascPortal;
}
const portalAvailable = () => kascPortal().available();
const updatePortalButton = () => kascPortal().updateButton();
const updatePortalUI = () => kascPortal().update();
const openPortal = () => kascPortal().open();
const closePortal = () => kascPortal().close();

// エントリのデータを現在の条件で再読み込みする。
// player-api の reloadEntryData フックと ⏷ フィルタ編集の共通経路。
// Navara の geojson ソースは差し替え API が無いためレイヤーを作り直す
async function reloadEntryData(entry) {
  const { geojson } = await loadVectorItem(entry.item, lastBaseUrl, null, vectorHooks);
  entry.item._geojson = geojson;
  if (!entry.layer) return;
  try { entry.layer.delete(); } catch (_) {}
  try { entry.src?.delete(); } catch (_) {}
  const r = await addKascLayer(entry.item, lastBaseUrl);
  if (r) { entry.src = r.src; entry.layer = r.layer; entry.desc = r.desc; }
}

// クエリ系レイヤーの絞り込み条件を対話的に変更し、item とインスペクタ行を
// 同期して再読み込みする（Cesium 版 editLayerQueryFilter 相当）
async function editEntryQueryFilter(entry) {
  const item = entry.item;
  const isSql = item.type === "sql" || item.type === "ogrsql";
  const current = isSql ? (item.url || "") : (item.opts?.where || "");
  const input = window.prompt(isSql ? "SQLクエリを入力" : "WHERE式を入力（空欄で解除）", current);
  if (input === null) return;
  await applyEntryQueryFilter(entry, input.trim());
}

// 絞り込み条件の値適用部。⏷ プロンプトと属性テーブルの SQL ダイアログ
// 「レイヤフィルタ」の共通経路(value は WHERE 式または SELECT 文)
async function applyEntryQueryFilter(entry, value) {
  const item = entry.item;
  const isSql = item.type === "sql" || item.type === "ogrsql";
  const oldLine = item.line;
  if (isSql) {
    if (!value) return;
    item.url = value;
    item.line = `${item.type}:${item.title} | ${value}${item.visible === false ? " | off" : ""}`;
  } else {
    item.opts ||= {};
    item.opts.where = value || undefined;
    if (oldLine) item.line = rewriteKascLineOpt(oldLine, "where", value);
  }
  if (oldLine && item.line && item.line !== oldLine && panel.inspector) {
    panel.inspector.value = panel.inspector.value
      .split(/\r?\n/).map(l => (l.trim() === oldLine ? item.line : l)).join("\n");
  }
  // QGIS ライブ連携: フィルタ変更をプロジェクトへ書き戻す
  liveWritebackEntries(layerEntries);
  try {
    await reloadEntryData(entry);
    attrWidget.refresh();
  } catch (e) {
    console.warn("フィルタ再読み込み失敗:", item.title, e);
  }
}

// ---- canvas_data/ へのファイル保存（ローカルサーバー / File System Access API） ----
let dataDirHandle = null;
const dataDirName = $("#inspector-data-dir-name");
function updateDataDirLabel() {
  if (!dataDirName) return;
  if (!window.showDirectoryPicker) { dataDirName.textContent = "このブラウザは非対応"; return; }
  dataDirName.textContent = dataDirHandle ? dataDirHandle.name : "未選択";
}
$("#inspector-data-dir")?.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) { setInspectorStatus("このブラウザはフォルダ選択に対応していません", true); return; }
  try {
    dataDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    updateDataDirLabel();
  } catch (e) {
    if (e?.name !== "AbortError") setInspectorStatus(`フォルダ選択失敗: ${e?.message || e}`, true);
  }
});
updateDataDirLabel();

async function saveToDataDir(name, content) {
  if (hasBackendFeature("fileWrite")) {
    const project = currentProjectId || "default";
    const rel = String(name).split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const res = await fetch(backendUrl(`/api/files/${encodeURIComponent(project)}/${rel}`), { method: "PUT", body: content });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return data?.dataDir || "canvas_data";
  }
  if (!window.showDirectoryPicker) throw new Error("ファイル保存にはローカルサーバー版または対応ブラウザが必要です");
  if (!dataDirHandle) {
    dataDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    updateDataDirLabel();
  }
  const fh = await dataDirHandle.getFileHandle(String(name).split("/").filter(Boolean).pop(), { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
  return dataDirHandle?.name || "canvas_data";
}

// ファイルを canvas_data/ へ保存し、拡張子に応じた .kasc 行を設定へ追記して即時適用する
{
  const addFileInput = $("#inspector-add-file");
  $("#inspector-add-file-button")?.addEventListener("click", () => addFileInput?.click());
  addFileInput?.addEventListener("change", async () => {
    const files = [...(addFileInput.files || [])];
    addFileInput.value = "";
    let appended = 0;
    for (const file of files) {
      try {
        const dir = (await saveToDataDir(file.name, file)) || "canvas_data";
        const ext = file.name.toLowerCase().split(".").pop() || "";
        const type = { geojson: "geojson", json: "geojson", gpkg: "gpkg", geopackage: "gpkg", fgb: "flatgeobuf", parquet: "geoparquet", kml: "kml", kmz: "kmz", gpx: "gpx", czml: "czml", topojson: "topojson", esrijson: "esrijson", arcgis: "arcgis", igc: "igc", polyline: "polyline", gml: "gml", geojsonl: "geojsonl", ndjson: "geojsonl", jsonl: "geojsonl", wkt: "wkt", wkb: "wkb", shp: "shp", zip: "shp", csv: "csv", tsv: "tsv" }[ext];
        if (type) {
          const title = file.name.replace(/\.[^.]+$/, "");
          panel.inspector.value = panel.inspector.value.replace(/\s*$/, "") + `\n${type}:${title} | ${dir}/${file.name}\n`;
          appended++;
          setInspectorStatus(`${file.name} を ${dir}/ へ保存し設定に追記しました`);
        } else {
          setInspectorStatus(`${file.name} を ${dir}/ へ保存しました（未対応形式のため行は未追記）`);
        }
      } catch (e) {
        if (e?.name === "AbortError") continue;
        setInspectorStatus(`保存失敗: ${e?.message || e}`, true);
      }
    }
    if (appended) {
      try { await applyInspectorText(panel.inspector.value); }
      catch (e) { setInspectorStatus(`適用失敗: ${e?.message || e}`, true); }
    }
  });
}

// ?follow[=<base>] → geo_webview の /live/state をポーリングして QGIS キャンバスに追従
// (shared/live.js の live セッションへ統合。pitch は現在値を保持するリンクビュー)
configureFollow({
  apply: (s, { topdown }) => {
    const height = typeof s.zoom === "number"
      ? viewZoomToHeight(s.lat, s.zoom, viewMetrics().vh)
      : lastCam.height;
    setCamera({
      longitude: s.lon, latitude: s.lat, height,
      heading: -(s.rotation || 0),
      pitch: topdown ? -90 : lastCam.pitch,
    });
  },
});

// ---- boot ----
(async () => {
  try { await view.init(); }
  catch (e) {
    document.body.insertAdjacentHTML("beforeend", `<div style="position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;background:rgba(10,10,20,.9);color:#f88;font:13px monospace;padding:24px;white-space:pre-wrap">Navara 初期化失敗\nvendor 未配置の可能性: python tools/fetch_vendor.py\n\n${e?.message || e}</div>`);
    throw e;
  }
  // 写実シーン（内部に sun を内包。手動 sun は二重 CSM 注入になるため
  // 足さない。失敗時は通常ライトへフォールバック）
  applyPhotoreal(true);
  // 太陽日時コントロール（TZ選択＋日時入力＋スライダー）をマウント
  mountSunControls({ tz: $("#nv-tz"), datetime: $("#nv-datetime"), hour: $("#nv-hour") },
    ms => { try { view.atmosphere.date = new Date(ms); } catch (_) {} });
  // 地形(Re:Earth Terrain)は既定 ON
  await applyTerrain(true);

  // URL のビュー状態はレイヤ読込前に適用する。
  // (Navara は一部のレイヤ/ソース追加後にカメラ制御が停止するケースがあり、
  //  loadProject 末尾まで待つと初期位置が適用されないため)
  const bootView = sessionBootView(pendingSession);
  if (hasUrlView(bootView)) setCamera({ longitude: bootView.longitude, latitude: bootView.latitude, height: urlViewHeight(bootView), heading: bootView.heading, pitch: bootView.pitch });

  // カメラ追従: マウス操作時も lastCam・URLハッシュ・camera-changed を同期
  // (Navara の view.camera は move/moveend を emit する。他エンジンとの
  // 座標引継ぎは URL ハッシュ経由のため moveend で書き込む)
  try {
    view.camera.on("move", () => { syncCamFromView(); applyScaleVis(); window.kasugaiApi?.emit("camera-changed", window.kasugaiApi.getCamera()); });
    view.camera.on("moveend", () => { syncCamFromView(); if (urlViewConsumed) writeUrlView(urlViewFromCam(), lastKascUrl ? undefined : currentProjectId); liveNotifyCamera(); });
    // @map_scale/ルール別縮尺を含む QML レイヤは縮尺でマテリアルが変わるため、
    // moveend 後に現在縮尺で再評価する(Navara はレイヤ単位マテリアルのため再マウント)
    let qmlScaleTimer = null;
    let lastQmlScaleDenom = null;
    view.camera.on("moveend", () => {
      if (!layerEntries.some(e => e.item?._qml?.scaleDependent)) return;
      clearTimeout(qmlScaleTimer);
      qmlScaleTimer = setTimeout(() => {
        const denom = lastCam.height / SCALE_VIS_DIST_K;
        if (!(denom > 0)) return;
        if (lastQmlScaleDenom && Math.abs(denom / lastQmlScaleDenom - 1) < 0.01) return;
        const first = lastQmlScaleDenom == null;
        lastQmlScaleDenom = denom;
        if (first) return; // 初回はレイヤ読込時に現縮尺で評価済み
        for (const e of layerEntries) {
          if (!e.item?._qml?.scaleDependent || !e.layer) continue;
          try { e.layer.delete(); } catch (_) {}
          try { e.src?.delete(); } catch (_) {}
          e.layer = e.src = e.desc = null;
          void addKascLayer(e.item, lastBaseUrl).then(r => { if (r) { e.src = r.src; e.layer = r.layer; e.desc = r.desc; } });
        }
      }, 400);
    });
  } catch (_) {}

  await loadProject();

  // 表示タブの Navara 固有コントロール（index.html 側の静的マークアップへバインド）
  $("#nv-terrain")?.addEventListener("change", e => applyTerrain(e.target.checked));
  const exInp = $("#nv-terrain-exagg");
  exInp?.addEventListener("change", () => {
    const v = Number(exInp.value);
    if (Number.isFinite(v) && v >= 0) applyTerrainExaggeration(v);
  });
  $("#nv-terrain-exagg-reset")?.addEventListener("click", () => {
    if (exInp) exInp.value = "1";
    applyTerrainExaggeration(1);
  });
  $("#nv-photoreal")?.addEventListener("change", e => applyPhotoreal(e.target.checked));
  $("#nv-shadow")?.addEventListener("change", e => { shadowOn = e.target.checked; applyShadow(); });
  // 光・エフェクト系の Navara 固有コントロールをバインド＋初期同期
  initFxControls();
  applyFxAll();
  // ui.config.json の UI カスタマイズ(チェックボックス類のバインド後に適用)
  try { await initUiConfig(); } catch (e) { console.warn("[ui-config]", e); }
  // 太陽日時コントロールのリスナは mountSunControls 内でバインド済み

  panel.project.addEventListener("change", () => loadProject(panel.project.value));
  panel.themeSelect?.addEventListener("change", () => {
    const theme = currentThemes.find(t => t.name === panel.themeSelect.value);
    if (!theme) return;
    const show = themeShowSet(theme);
    for (const e of layerEntries) { setEntryVisible(e, show == null || kascTitleInTheme(e.item.title, show)); void maybeLoadEntry(e); }
    buildLayerList(); syncAttribution();
    // 可視性をインスペクタの .kasc テキストへも書き戻して整合を保つ（他エンジンと同じ）
    if (panel.inspector) panel.inspector.value = rewriteKascVisibility(panel.inspector.value, show);
    // QGIS ライブ連携: テーマ適用を QGIS プロジェクトへ書き戻す
    liveWritebackEntries(layerEntries, { theme: theme?.name });
  });

  // レイヤ一覧: 全グループの一括展開/折りたたみ
  $("#layer-expand-all")?.addEventListener("click", () => {
    setAllLayerGroupsExpanded(panel.layers, expandedLayerGroups, true);
  });
  $("#layer-collapse-all")?.addEventListener("click", () => {
    setAllLayerGroupsExpanded(panel.layers, expandedLayerGroups, false);
  });
  $("#apply-inspector")?.addEventListener("click", () => {
    applyInspectorText(panel.inspector.value);
    // QGIS ライブ連携: インスペクタ適用をプロジェクトへ書き戻す
    liveWritebackEntries(layerEntries);
  });
  $("#export-inspector")?.addEventListener("click", () => {
    const blob = new Blob([panel.inspector.value || lastKascRaw], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "project.kasc"; a.click(); URL.revokeObjectURL(a.href);
  });
  // #share-copy は index.html 側の共通ハンドラ（kasugaiApi.getShareUrl 経由）に統一
  $("#nav-compass")?.addEventListener("click", () => flyTo({ heading: 0 }));
  $("#nav-home")?.addEventListener("click", () => {
    let env = null;
    for (const { item } of layerEntries) { const e = item._geojson && geojsonExtent(item._geojson); if (!e) continue; env = env ? { west: Math.min(env.west, e.west), south: Math.min(env.south, e.south), east: Math.max(env.east, e.east), north: Math.max(env.north, e.north) } : e; }
    focusExtent(env);
  });
  $("#navigation-toggle")?.addEventListener("click", e => {
    const bar = document.querySelector(".navigation-toolbar");
    if (!bar) return;
    if (bar.classList.contains("collapsed")) {
      bar.classList.remove("collapsed");
    } else if (bar.classList.contains("compass-only")) {
      bar.classList.replace("compass-only", "collapsed");
    } else {
      bar.classList.add("compass-only");
    }
    const collapsed = bar.classList.contains("collapsed");
    e.currentTarget.textContent = collapsed ? "+" : "−";
    e.currentTarget.setAttribute("aria-label", collapsed ? "展開" : "最小化");
    e.currentTarget.title = collapsed ? "展開" : "最小化";
  });
  $("#basemap-toggle")?.addEventListener("click", () => panel.basemap?.classList.toggle("collapsed"));
  $("#basemap-globe")?.addEventListener("click", () => open(`https://earth.google.com/web/@${lastCam.lat},${lastCam.lng},${lastCam.height}d`, "_blank"));

  initPrint({
    button: $("#print-open"),
    getTitle: () => document.title,
    captureMap: async () => { try { view._render?.(); } catch (_) {} await new Promise(r => requestAnimationFrame(r)); return $("#map canvas"); },
    getNorthAngleDeg: () => -lastCam.heading,
    getScaleDenominator: () => null,
  });
  void initAiChat({ engine: "navara", manageBackend: true });

  window.kasugaiApi = createPlayerApi({
    engine: "navara",
    getProjectId: () => currentProjectId,
    getEntries: () => layerEntries,
    // 全ベース候補を返す（listBasemaps/setBasemap が選択肢全体を扱うため）。
    // 実レイヤを持つのは選択中の1件だけなので、それは baseEntries の実体を返す
    getBaseEntries: () => baseDocs.map(b => baseEntries[0]?.item === b ? baseEntries[0] : { item: b }),
    setBaseEntryVisible: (e, on) => navaraSetShow(e, on),
    applyEntryVisibility: (e, on) => setEntryVisible(e, on),
    mountEntry: async (e, preloaded) => {
      if (!e.layer) {
        if (preloaded?.geojson) e.item._geojson = preloaded.geojson;
        const r = await addKascLayer(e.item, lastBaseUrl);
        if (r) { e.src = r.src; e.layer = r.layer; e.desc = r.desc; }
      }
      setEntryVisible(e, true);
      syncAttribution();
    },
    unmountEntry: e => {
      try { e.layer?.delete(); } catch (_) {}
      try { e.src?.delete(); } catch (_) {}
      e.layer = e.src = e.desc = null;
      e.item.visible = false;
      syncAttribution();
    },
    getViewInfo: () => { syncCamFromView(); return { latitude: lastCam.lat, longitude: lastCam.lng, height: lastCam.height, zoom: navaraZoom(), heading: lastCam.heading, pitchDeg: (lastCam.pitch ?? -45) + 90 }; },
    viewToUrl: () => { syncCamFromView(); return urlViewFromCam(); },
    flyToView: v => { if (Number.isFinite(v.latitude) && Number.isFinite(v.longitude)) flyTo({ longitude: v.longitude, latitude: v.latitude, height: v.height ?? (Number.isFinite(v.zoom) ? viewZoomToHeight(v.latitude, v.zoom, 512) : undefined), heading: v.heading, pitch: v.pitch ?? (Number.isFinite(v.pitchDeg) ? v.pitchDeg - 90 : undefined) }); },
    getEntryGeoJson: e => e.item._geojson,
    geoTools: () => geoTools,
    getCams: () => currentCams,
    getThemes: () => currentThemes,
    applyThemeByName: name => {
      if (!currentThemes.some(t => t.name === name)) return false;
      const s = panel.themeSelect;
      if (s) { s.value = name; s.dispatchEvent(new Event("change")); }
      return true;
    },
    applyInspectorText,
    getInspectorText: () => panel.inspector?.value || lastKascRaw,
    setInspectorText: t => { if (panel.inspector) panel.inspector.value = t; },
    maybeLoadEntry: async e => { await maybeLoadEntry(e); return e; },
    loadProject: pid => loadProject(pid),
    focusEntry: e => focusExtent(e.item._geojson && geojsonExtent(e.item._geojson)),
    reloadEntryData,
    // QGIS ライブ連携: /api/command の liveSync プッシュで即時反映(#62)
    liveSync: async args => liveUpdate(args),
    rerenderLayers: () => { buildLayerList(); syncAttribution(); },
    getFlyPaths: kascFlyPaths.getFlyPaths,
    persistFlyPath: kascFlyPaths.persistFlyPath,
    syncFlyPathLine: kascFlyPaths.syncFlyPathLine,
    applyLegendFilter: () => {},
  });

  // view: 行の目的別プリセット一覧/適用/解除とポータル画面の開閉。
  // 表示＋スタイル＋フィルタ(＋カメラ/背景)をまとめて適用するテーマの発展形
  // (createPlayerApi にはフックが無いため返却 api へ直接追加する)
  Object.assign(window.kasugaiApi, {
    listViews() {
      return inspectorViews.map(view => ({
        name: view.name, desc: view.desc, img: view.img, cam: view.cam, base: view.base,
        layers: [...view.layers], active: view.name === activeViewName,
      }));
    },
    async applyView(name) {
      const view = inspectorViews.find(entry => entry.name === name);
      if (!view) return false;
      await applyKascView(view);
      return true;
    },
    async clearView() {
      await clearKascView();
      return true;
    },
    openPortal() { openPortal(); return portalAvailable(); },
    closePortal() { closePortal(); return true; },
    // Navara 診断情報（メモリ/キャッシュ統計）を AI・検証スクリプトから取得可能にする
    getMemoryStats() {
      try { return view.memoryStats?.() ?? null; } catch (_) { return null; }
    },
  });

  // 🏠ボタン・「地図を開く」・Esc・「ビュー解除」の配線(DOM は静的マークアップ)
  kascPortal().bindEvents();

  // エンジン切替UIとカレント状態ファイルの定期同期は kasugaiApi 生成後に開始
  // (切替時のスナップショットが listLayers 等を使うため)
  mountEngineSwitcher($("#engines"), "navara");
  bindSessionState("navara");
})();

// ブラウザ戻る/進む・ハッシュ編集からの視点復元（MapLibre 版 applyUrlView と同じ）
const applyUrlView = () => {
  const v = parseUrlView();
  if (hasUrlView(v)) flyTo({ longitude: v.longitude, latitude: v.latitude, height: urlViewHeight(v), heading: v.heading, pitch: v.pitch });
};
window.addEventListener("popstate", applyUrlView);
window.addEventListener("hashchange", applyUrlView);

// ---- ナビゲーション共通ツール（shared/nav-tools.js）----
installLocalCrsUI({ anchor: document.querySelector("#coords-datum") });

// ミニマップ（表示>一般トグル。Navara は表示範囲矩形が取れないため中心マーカー表示）
// ---- ツール（計測・選択/集計・作図・標高断面・見通し + エクスポート）----
// 結果は色別の geojson ベクターレイヤーとして重ねる。text 付き地物
// (区間ラベル・遮蔽点)は text マテリアルで文字表示する
const navaraToolLayers = new Map(); // color → {src, layer}
let navaraToolLabelLayer = null;    // {src, layer} ラベル専用レイヤ
const navaraToolKindColor = k => k === "los-ok" ? "#32cd32"
  : (k === "los-bad" || k === "los-block") ? "#ff0000"
  : k === "hover" ? "#2288ff" : "#ffff00";
async function navaraToolUpdate(fc) {
  const groups = {};
  const labelFeats = [];
  for (const f of fc?.features || []) {
    const k = f.properties?.kind;
    if (k === "grat" || k === "grat-label") continue;
    if (f.properties?.text != null && f.properties?.text !== "") { labelFeats.push(f); continue; }
    const color = f.properties?.color || navaraToolKindColor(k);
    (groups[color] ||= []).push(f);
  }
  for (const [, cur] of navaraToolLayers) {
    try { cur?.layer?.delete(); } catch (_) {}
    try { cur?.src?.delete(); } catch (_) {}
  }
  navaraToolLayers.clear();
  for (const [color, feats] of Object.entries(groups)) {
    if (!feats.length) continue;
    const src = view.addSource({ type: "geojson", data: { type: "FeatureCollection", features: feats }, tiled: false });
    const layer = view.addLayer({ type: "vector", source: src,
      polygon: { color: css2hex(color), clampToGround: true, opacity: 0.25, transparent: true },
      polyline: { color: css2hex(color), width: 3, clampToGround: true, opacity: 1 },
      point: { color: css2hex(color), clampToGround: true, opacity: 1 } });
    navaraToolLayers.set(color, { src, layer });
  }
  // 計測ラベル・遮蔽点など text 付き地物は text マテリアルで表示
  try { navaraToolLabelLayer?.layer?.delete(); } catch (_) {}
  try { navaraToolLabelLayer?.src?.delete(); } catch (_) {}
  navaraToolLabelLayer = null;
  if (labelFeats.length) {
    const fam = await qmlLabelFont("Noto Sans JP", false);
    if (fam) {
      const src = view.addSource({ type: "geojson", data: { type: "FeatureCollection", features: labelFeats }, tiled: false });
      const layer = view.addLayer({ type: "vector", source: src,
        text: { font: fam, size: 14, sizeInMeters: false, color: 0x222222,
          outlineColor: 0xffffff, outlineWidth: 42, transparent: true,
          clampToGround: false, textFacing: "upright", declutter: false } });
      const applyText = ({ evaluator }) => {
        try {
          evaluator.evaluate(info => {
            const p = info?.properties || {};
            return p.text != null ? { text: String(p.text), show: true } : { show: false };
          });
        } catch (_) {}
      };
      layer.on("featureCreated", applyText);
      layer.on("featureUpdated", applyText);
      navaraToolLabelLayer = { src, layer };
    }
  }
}
const geoTools = initGeoTools2d({
  sections: { measure: true, spatial: true, draw: true, profile: true, los: true, export: true, general: false },
  overlay: { update: fc => { void navaraToolUpdate(fc); } },
  graticuleOverlay: { update: () => {} },
  setCursor: c => { try { view.canvas.style.cursor = c; } catch (_) {} },
  // 地形ソースがある場合は Navara の最詳細タイル標高を使う。
  // 無い/失敗時は geo-tools 側が地理院標高 API へフォールバックする
  sampleTerrain: async lnglats => {
    if (!terrainSrc) return null;
    try {
      const r = await view.sampleTerrainMostDetailed(terrainSrc,
        lnglats.map(p => ({ lng: p.lng, lat: p.lat })));
      return (r || []).map(s => Number.isFinite(s?.height) ? s.height : null);
    } catch (_) { return null; }
  },
  getOrderedLayerItems: () => layerEntries.map((e, i) => (e.item.id ||= String(i), e.item)),
  isVectorLayerItem: item => !!item && VECTOR_TYPES.has(item.type),
  isQueryLayerItem: () => false,
  getLayerGeoJson: id => layerEntries.find(e => e.item.id === id)?.item._geojson || null,
});

// ポインタ座標(ECEF) → 地理座標。view の MapPointerEvent.map を変換する
const pointerToLL = ev => {
  try {
    const m = ev?.map;
    if (!m) return null;
    const g = vector3ToGeodetic({ x: m.x, y: m.y, z: m.z });
    return Number.isFinite(g?.lng) && Number.isFinite(g?.lat) ? { lng: g.lng, lat: g.lat } : null;
  } catch (_) { return null; }
};

// ツールモードがクリックを消費した場合、同じジェスチャの featureClick を
// 属性ピックに使わないようフラグで抑止する(click→featureClick の順で発火)
let _toolClickHandled = false;
try {
  view.on("click", ev => {
    const ll = pointerToLL(ev);
    if (ll && geoTools.handleClick(ll)) _toolClickHandled = true;
  });
  view.on("pointermove", ev => {
    const ll = pointerToLL(ev);
    if (ll) geoTools.handleMouseMove(ll);
  });
  view.canvas?.addEventListener("dblclick", () => { geoTools.handleDoubleClick(); });
  // 地物クリック → 属性タブを自動で開いて属性を表示(他エンジンと同じ)
  view.on("featureClick", info => {
    if (_toolClickHandled || geoTools.isActive()) { _toolClickHandled = false; return; }
    if (!info) return;
    const entry = layerEntries.find(e =>
      e.layer && (e.layer.id === info.layerId || String(e.layer.id) === String(info.layerId)));
    const records = [{
      title: entry ? (entry.item.title || entry.item.url) : null,
      entries: attrEntriesFromProps(info.properties || {}),
      layerId: entry ? String(layerEntries.indexOf(entry)) : null,
      feature: null, flyable: false,
    }];
    // QGIS ライブ連携: クリック地物を QGIS 側の選択へ逆通知
    if (records[0]?.title) {
      try {
        const fid = info.properties?.id ?? info.properties?.fid;
        liveNotifySelection({
          layer: records[0].title,
          longitude: lastCam.lng, latitude: lastCam.lat,
          ...(Number.isFinite(Number(fid)) ? { ids: [Number(fid)] } : {}),
        });
      } catch (_) { /* 逆通知失敗は無視 */ }
    }
    window.switchPanelTab?.("attr");
    renderAttrContent(panel.attrContent, records);
  });
} catch (_) { /* イベント非対応環境ではピック無効 */ }

const minimap = createMinimap({
  container: "#minimap",
  checkbox: "#display-minimap",
  button: "#basemap-minimap",
  tileUrl: () => baseDocs[currentBasemapIdx]?.url || "",
  // 直下視近似: 高さ→表示ズーム換算で主画面の footprint を求め、
  // 共有ミニマップの広域コンテキスト経路に他エンジンと同じく乗せる
  getBounds: () => {
    const { lat, lng, height } = lastCam;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(height > 0)) return null;
    const mapEl = document.querySelector("#map");
    const vw = Math.max(1, mapEl?.clientWidth || 512), vh = Math.max(1, mapEl?.clientHeight || 512);
    const cosLat = Math.max(0.087, Math.cos(lat * Math.PI / 180));
    const mpp = 156543.03392 * cosLat / Math.pow(2, heightToViewZoom(lat, height, vw));
    return [[lat - (vh * mpp / 2) / 111320, lng - (vw * mpp / 2) / (111320 * cosLat)],
            [lat + (vh * mpp / 2) / 111320, lng + (vw * mpp / 2) / (111320 * cosLat)]];
  },
  getCenter: () => ({ lat: lastCam.lat, lng: lastCam.lng }),
  getZoom: () => navaraZoom(),
  // クリックした地点へ現在の高さ・姿勢のまま移動
  flyTo: ({ lng, lat }) => flyTo({ longitude: lng, latitude: lat }),
});
try {
  view.camera.on("move", minimap.scheduleUpdate);
  view.camera.on("moveend", minimap.scheduleUpdate);
} catch (_) {}

initNavTools({
  el: document.getElementById("map"),
  getView: () => ({ lat: lastCam.lat, lng: lastCam.lng, height: lastCam.height, heading: lastCam.heading, pitch: lastCam.pitch }),
  setView: v => setCamera({ longitude: v.lng, latitude: v.lat, height: v.height, heading: v.heading, pitch: v.pitch }),
  viewsEqual: (x, y) => x && y && Math.abs(x.lat - y.lat) < 1e-7 && Math.abs(x.lng - y.lng) < 1e-7 && Math.abs((x.height ?? 0) - (y.height ?? 0)) < 0.5 && Math.abs((x.heading ?? 0) - (y.heading ?? 0)) < 0.01 && Math.abs((x.pitch ?? 0) - (y.pitch ?? 0)) < 0.01,
  flyTo: (lat, lng) => flyTo({ longitude: lng, latitude: lat }),
  onMoveEnd: cb => view.camera.on("moveend", cb),
  capturePng: () => new Promise(res => { try { view._render?.(); } catch (_) {} const c = document.querySelector("#map canvas"); c ? c.toBlob(res, "image/png") : res(null); }),
});
