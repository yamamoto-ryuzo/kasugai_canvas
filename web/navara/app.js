// KASUGAI Canvas — Navara フロント（写実 3D プレゼンエンジン）
// @navaramap/three (Rust/WASM + Three.js) で .kasc を再生する。
// vendor dist は同一オリジン必須（Worker が import.meta.url 相対で生成される）。
// UI/共通機構は shared/ を他エンジンと共用する。
import ThreeView, { Color } from "@navaramap/three";
import { DefaultPlugin } from "@navaramap/three-default-plugin";
import { loadKascProject, NON_LAYER_TYPES, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeight, camToZoomView, zoomToCamHeightView, heightToViewZoom, viewZoomToHeight, parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle, appendGroupedTitleOptions, syncBasemapList, sanitizeAttributionFragment, layerAttribution, loadKascInfoContent, buildWmsTileTemplate, buildWmtsTileTemplate, rewriteKascVisibility, rewriteKascLineVisibility, rewriteKascLineOpt, themeShowSet, fillThemeSelect, kascTitleInTheme, normKascTitle, loadKascBookmarks, parseQgisBookmarksXml, qgisBookmarkToCam, downloadQgisBookmarksXml, downloadKascCamLines, applyPanelTitle, resolveDefaultPointStyle, resolveDefaultLineStyle, resolveDefaultPolygonStyle, cssColorAlpha } from "../shared/kasc.js";
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
import { formatLatLng } from "../shared/coords-format.js";
import { installLocalCrsUI } from "../shared/coords-local.js";
import { diagnoseHubLayerError } from "../shared/hub-diag.js";
import { createMinimap } from "../shared/minimap.js";
import { initGeoTools2d } from "../shared/geo-tools-2d.js";
import { initPrint } from "../shared/print.js";
import { loadCompiledQml, specToStyle, qmlLegendSwatchDataUrl, defaultVectorLegendSpec } from "../shared/qml-2d.js";
import { mountSunControls } from "../shared/sun-time.js";

const TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain";
const VECTOR_TYPES = new Set(["geojson", "layer", "geoparquet", "parquet", "flatgeobuf", "fgb", "gpkg", "geopackage", "csv", "tsv", "duckdb", "sql", "kml", "kmz", "wfs", "shp", "shapefile"]);
const RASTER_TYPES = new Set(["xyz", "tile"]);
// ⏷フィルタ編集の対象（where= またはクエリ全文の再読み込みが効く形式）
const QUERY_TYPES = new Set(["gpkg", "geopackage", "duckdb", "sql"]);
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
  container: document.getElementById("map"), picking: false,
  // 既定は描画負荷を抑える（写実品質は設定ペインで戻せる）
  shadow: false, multisampling: 0, halfFloat: false, logarithmicDepthBuffer: false,
});
const defaultPlugin = new DefaultPlugin();
view.addPlugin(defaultPlugin);
window.kascView = view;

const layerEntries = [];   // {item, sid, src, layer}
const baseEntries = [];    // 選択中ベースマップ {item, src, layer}
const themes = [];
let baseDocs = [], basemapSrc = null, basemapLayer = null;
let terrainSrc = null, terrainLayer = null;
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
}
// 縮尺表示(minScale=/maxScale=) → カメラ高[m]範囲。
// QML ルールの縮尺分母→距離変換と同じ係数(分母×0.00028×900÷(2·tan30°))
const SCALE_VIS_DIST_K = 0.00028 * 900 / (2 * Math.tan(Math.PI / 6));
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
  for (const { item } of layerEntries) {
    if (!item.visible) continue;
    const a = layerAttribution(item);
    if (a && !seen.has(a)) { seen.add(a); html.push(sanitizeAttributionFragment(a)); }
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
function applyLegendFilter(_entry) {}

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
    qb.title = item.type === "sql" ? "クエリを編集" : "絞り込み条件（WHERE式）を編集";
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

// ---- 凡例タブ（legend: 行の画像 + QML legend があればスウォッチ表示） ----
function buildLegends() {
  panel.legends.replaceChildren();
  let any = false;
  for (const leg of currentLegends) {
    const img = document.createElement("img");
    img.src = resolveKascUrl(leg.url, lastBaseUrl);
    img.alt = leg.title || "legend";
    img.style.maxWidth = "100%";
    if (leg.title) {
      const t = document.createElement("div");
      t.textContent = leg.title;
      panel.legends.append(t);
    }
    panel.legends.append(img);
    any = true;
  }
  for (const entry of layerEntries) {
    const specs = entry.item._qml?.legend;
    if (!specs?.length) continue;
    const wrap = document.createElement("div");
    const head = document.createElement("div");
    head.textContent = splitKascTitle(entry.item.title).title || entry.item.title;
    head.style.fontWeight = "600";
    wrap.append(head);
    for (const le of specs) {
      const row = document.createElement("div");
      row.className = "legend-row";
      const img = document.createElement("img");
      img.className = "legend-swatch"; img.src = qmlLegendSwatchDataUrl(le.spec || le);
      const lbl = document.createElement("span");
      lbl.className = "legend-label"; lbl.textContent = le.label || "";
      row.append(img, lbl); wrap.append(row);
    }
    panel.legends.append(wrap);
    any = true;
  }
  if (!any) panel.legends.textContent = "（凡例なし）";
}

// ---- 属性一覧 ----
const attrWidget = createAttrWidget({
  // レイヤ id は layerEntries のインデックス（filter 後に採番すると
  // buildLayerRow 側の indexOf(entry) とズレるため先に採番する）
  listLayers: () => layerEntries
    .map((entry, i) => ({ id: String(i), title: splitKascTitle(entry.item.title).title || entry.item.title || entry.item.url, entry }))
    .filter(o => VECTOR_TYPES.has(o.entry.item.type)),
  getFeatures: async entry => ({ features: entry.item._geojson?.features || [] }),
  focusFeature: f => focusExtent(geojsonExtent({ type: "FeatureCollection", features: [f] })),
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
  if (!b) return;
  basemapSrc = view.addSource({ type: "raster-tile", url: resolveKascUrl(b.url, lastBaseUrl), maxZoom: Number(b.opts?.maxzoom) || 18, ...(b.opts?.minzoom ? { minZoom: Number(b.opts.minzoom) } : {}) });
  const desc = { type: "raster", source: basemapSrc };
  basemapLayer = view.addLayer(desc);
  baseEntries.length = 0;
  baseEntries.push({ item: b, src: basemapSrc, layer: basemapLayer, desc });
}
panel.basemapSelect?.addEventListener("change", () => applyBasemap(Number(panel.basemapSelect.value)));

// ---- 地形・写実 ----
async function applyTerrain(on) {
  if (terrainLayer) { try { terrainLayer.delete(); terrainSrc.delete(); } catch (_) {} terrainLayer = terrainSrc = null; }
  if (!on) return;
  try {
    terrainSrc = view.addSource({ type: "quantized-mesh", url: TERRAIN_URL, maxZoom: 15, requestVertexNormals: true });
    terrainLayer = view.addLayer({ type: "terrain", source: terrainSrc, terrain: { castShadow: true, receiveShadow: true } });
  } catch (e) {
    console.warn("terrain", e);
    try { terrainSrc?.delete(); } catch (_) {}
    terrainLayer = terrainSrc = null;
    // 既定 ON のため失敗時はチェック状態も戻して UI と実態を合わせる
    const c = $("#nv-terrain"); if (c) c.checked = false;
  }
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
};
const fx = structuredClone(FX_DEFAULTS);
let cloudsEffect = null, ssaoEffect = null;
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
function applyFxAll() {
  applyFxSun(); applyFxAmbient(); applyFxSkyProbe(); applyFxExposure();
  applyFxShadowInt(); applyFxMoon(); applyFxStars(); applyFxFlare();
  applyFxToneMode(); applyFxClouds(); applyFxSsao();
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
  $("#nv-clouds")?.addEventListener("change", e => { fx.clouds = e.target.checked; applyFxClouds(); });
  $("#nv-ssao")?.addEventListener("change", e => { fx.ssao = e.target.checked; applyFxSsao(); });
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
// 太陽日時コントロール（TZ選択＋日時入力＋スライダー）は shared/sun-time.js 共通

// where= のクライアント側適用。クエリ系(gpkg/duckdb/sql)はローダ側で
// 絞込済みのため対象外。残りの全件読み込み系ベクターは GeoJSON 取得後に
// compileWhereExpression で絞り、ソース生成用の FeatureCollection を返す
// (item._geojson 自体は無絞込のまま保持し、属性一覧・検索は全件対象とする)
function whereFilteredGeojson(item) {
  const geojson = item?._geojson;
  const where = item?.opts?.where;
  if (!where || QUERY_TYPES.has(item?.type) || !geojson?.features?.length) return geojson;
  try {
    const pred = compileWhereExpression(where);
    const kept = geojson.features.filter((f, i) => pred(f, i));
    return kept.length === geojson.features.length ? geojson : { ...geojson, features: kept };
  } catch (e) {
    console.warn(`where= の式を適用できません (${item?.title}):`, e?.message || e);
    return geojson;
  }
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
  if (VECTOR_TYPES.has(item.type)) {
    const loaded = item._geojson ? { geojson: item._geojson } : await loadVectorItem(item, baseUrl, null);
    item._geojson = loaded.geojson;
    // default_style: 行の既定値（地物側指定 > style=QML > default_style: > エンジン既定。
    // Navara はレイヤ単位マテリアルのため地物ごとの解決はできずレイヤ既定へ畳み込む）
    const ds = currentDefaultStyles || {};
    const pd = ds.point ? resolveDefaultPointStyle({}, ds.point, {}) : null;
    const ld = ds.line ? resolveDefaultLineStyle({}, ds.line, {}) : null;
    const gd = ds.polygon ? resolveDefaultPolygonStyle({}, ds.polygon, ds.line, {}) : null;
    // QML スタイル: 代表地物の spec からレイヤ既定色を取る（Navara はレイヤ単位マテリアル）
    let fillCss = item.opts?.fill, strokeCss = item.opts?.stroke || item.opts?.color, markerCss = item.opts?.marker_color;
    if (item.opts?.style) {
      try {
        const compiled = await loadCompiledQml(item.opts.style, baseUrl);
        item._qml = compiled;
        const spec = compiled.evaluate?.(item._geojson?.features?.[0]?.properties || {});
        const s = specToStyle(spec);
        if (s) { fillCss ||= s.fill; strokeCss ||= s.stroke; markerCss ||= s.markerColor; }
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
    const src = view.addSource({ type: "geojson", data: whereFilteredGeojson(item), tiled: true });
    const desc = { type: "vector", source: src,
      polygon: { color: css2hex(fillCss || "#3d7dd9"), clampToGround: true, opacity: polyFillO, transparent: polyFillO < 1 },
      polyline: { color: css2hex(strokeCss || "#2c5ea8"), width: Number(item.opts?.width) || gd?.strokeWidth || ld?.width || 3, clampToGround: true, opacity: polyLineO, transparent: polyLineO < 1 },
      point: { color: css2hex(markerCss || "#d94f3d"), clampToGround: true, opacity: pointO, transparent: pointO < 1 } };
    const layer = view.addLayer(desc);
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
  const unsupported = doc.unsupported.filter(u => u.type !== "3dtiles" && u.type !== "fly_geojson" && !NON_LAYER_TYPES.has(u.type));
  const visibleCount = items.filter(i => i.visible !== false).length;
  let done = 0;
  progress(0, visibleCount, "");
  for (const item of items) {
    const mountable = item.type === "3dtiles" || RASTER_TYPES.has(item.type)
      || item.type === "wms" || item.type === "wmts" || VECTOR_TYPES.has(item.type);
    const entry = { item, sid: String(item._idx ?? item.url), unsupported: (doc.unsupported.includes(item) && item.type !== "3dtiles") || !mountable };
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

  // ベースマップ
  panel.basemap.hidden = false;
  baseDocs = doc.bases.filter(b => !b.mode);
  panel.basemapSelect.replaceChildren();
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
  if (initIdx >= 0) panel.basemapSelect.value = String(initIdx);
  syncBasemapList(panel.basemapSelect);
  await applyBasemap(noneSel ? -1 : initIdx);

  await renderLayers(doc, baseUrl);

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
  "portal.defaultNews": "まだお知らせはありません。kasc ファイルに `html:タイトル | <HTML>またはファイル/URL` 行を追加するとここに表示されます。",
  "portal.defaultViews": "まだ目的別ボタンはありません。`view:` 行で表示レイヤ・スタイル・フィルタ・カメラをまとめたカード、`link:` 行で外部サイトへのカードを追加できます。",
  "portal.about": "ポータル機能について",
  "portal.aboutHtml": "<p>.kasc に以下の行を書くとポータルを構成できます。</p><ul><li><code>portal:on | title=見出し | open=auto|manual</code> — ポータルの有効化・タイトル・起動時表示</li><li><code>html:タイトル | HTMLまたはファイル/URL</code> — お知らせ等のセクション(記述順)</li><li><code>view:名前 | desc=説明 | img=画像 | cam=カメラ名 | レイヤ[;style=…][;where=式]</code> — 目的別の表示切替カード</li><li><code>link:名前 | url=URL | desc=説明 | img=画像</code> — 外部サイトへのリンクカード</li></ul>",
};
const t = (key, vars) => String(PORTAL_T[key] ?? key)
  .replace(/\{(\w+)\}/g, (m, n) => (vars?.[n] != null ? String(vars[n]) : m));

// DATA/ 等の相対参照 → プロジェクト基準 URL へ解決(Cesium 版 resolveProjectUrl
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
      if (item.type === "sql") {
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
      if (item.type !== "sql") newLine = rewriteKascLineOpt(newLine, "where", item.opts?.where ?? null);
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
// none・transparent 系はベースマップなし
// (Navara には地表透明モードが無いため transparent も非表示として扱う)
async function applyViewBase(rawName, logPrefix = "data-base") {
  const name = String(rawName || "").trim();
  const isNone = /^(none|off|なし|ベースマップなし|transparent|hide|透明)$/i.test(name);
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
      if (item.type !== "sql") newLine = rewriteKascLineOpt(newLine, "where", item.opts?.where ?? null);
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
  const { geojson } = await loadVectorItem(entry.item, lastBaseUrl, null);
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
  const isSql = item.type === "sql";
  const current = isSql ? (item.url || "") : (item.opts?.where || "");
  const input = window.prompt(isSql ? "SQLクエリを入力" : "WHERE式を入力（空欄で解除）", current);
  if (input === null) return;
  const value = input.trim();
  const oldLine = item.line;
  if (isSql) {
    if (!value) return;
    item.url = value;
    item.line = `sql:${item.title} | ${value}${item.visible === false ? " | off" : ""}`;
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

// ---- DATA/ へのファイル保存（ローカルサーバー / File System Access API） ----
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
    return;
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
}

// ファイルを DATA/ へ保存し、拡張子に応じた .kasc 行を設定へ追記して即時適用する
{
  const addFileInput = $("#inspector-add-file");
  $("#inspector-add-file-button")?.addEventListener("click", () => addFileInput?.click());
  addFileInput?.addEventListener("change", async () => {
    const files = [...(addFileInput.files || [])];
    addFileInput.value = "";
    let appended = 0;
    for (const file of files) {
      try {
        await saveToDataDir(file.name, file);
        const ext = file.name.toLowerCase().split(".").pop() || "";
        const type = { geojson: "geojson", json: "geojson", gpkg: "gpkg", geopackage: "gpkg", fgb: "flatgeobuf", parquet: "geoparquet" }[ext];
        if (type) {
          const title = file.name.replace(/\.[^.]+$/, "");
          panel.inspector.value = panel.inspector.value.replace(/\s*$/, "") + `\n${type}:${title} | DATA/${file.name}\n`;
          appended++;
          setInspectorStatus(`${file.name} を DATA/ へ保存し設定に追記しました`);
        } else {
          setInspectorStatus(`${file.name} を DATA/ へ保存しました（未対応形式のため行は未追記）`);
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
  } catch (_) {}

  await loadProject();

  // 表示タブの Navara 固有コントロール（index.html 側の静的マークアップへバインド）
  $("#nv-terrain")?.addEventListener("change", e => applyTerrain(e.target.checked));
  $("#nv-photoreal")?.addEventListener("change", e => applyPhotoreal(e.target.checked));
  $("#nv-shadow")?.addEventListener("change", e => { shadowOn = e.target.checked; applyShadow(); });
  // 光・エフェクト系の Navara 固有コントロールをバインド＋初期同期
  initFxControls();
  applyFxAll();
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
  $("#navigation-toggle")?.addEventListener("click", () => document.querySelector(".navigation-toolbar")?.classList.toggle("collapsed"));
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
// ---- ツール（計測・標高断面・見通しは API 専用、エクスポートはパネル操作）----
// Navara はピッキング未対応のため対話描画は無し。API(measure*/elevationProfile/
// lineOfSight)の結果は色別の geojson ベクターレイヤーとして重ねる
const navaraToolLayers = new Map(); // color → {src, layer}
function navaraToolUpdate(fc) {
  const groups = {};
  for (const f of fc?.features || []) {
    const k = f.properties?.kind;
    if (k === "grat" || k === "grat-label") continue;
    const color = f.properties?.color
      || (k === "los-ok" ? "#32cd32" : (k === "los-bad" || k === "los-block") ? "#ff0000" : "#ffff00");
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
}
const geoTools = initGeoTools2d({
  sections: { measure: false, spatial: false, draw: false, profile: false, los: false, export: true, general: false },
  overlay: { update: navaraToolUpdate },
  graticuleOverlay: { update: () => {} },
  getOrderedLayerItems: () => layerEntries.map((e, i) => (e.item.id ||= String(i), e.item)),
  isVectorLayerItem: item => !!item && VECTOR_TYPES.has(item.type),
  isQueryLayerItem: () => false,
  getLayerGeoJson: id => layerEntries.find(e => e.item.id === id)?.item._geojson || null,
});

const minimap = createMinimap({
  container: "#minimap",
  checkbox: "#display-minimap",
  tileUrl: () => baseDocs[currentBasemapIdx]?.url || "",
  getCenter: () => ({ lat: lastCam.lat, lng: lastCam.lng }),
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
