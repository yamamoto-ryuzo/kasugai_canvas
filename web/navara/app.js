// KASUGAI Canvas — Navara フロント（写実 3D プレゼンエンジン）
// @navaramap/three (Rust/WASM + Three.js) で .kasc を再生する。
// vendor dist は同一オリジン必須（Worker が import.meta.url 相対で生成される）。
// UI/共通機構は shared/ を他エンジンと共用する。
import ThreeView, { Color } from "@navaramap/three";
import { DefaultPlugin } from "@navaramap/three-default-plugin";
import { loadKascProject, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeight, camToZoomView, zoomToCamHeightView, parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle, appendGroupedTitleOptions, syncBasemapList, sanitizeAttributionFragment, layerAttribution, loadKascInfoContent, rewriteKascVisibility, themeShowSet, fillThemeSelect, loadKascBookmarks, downloadQgisBookmarksXml, downloadKascCamLines, applyPanelTitle } from "../shared/kasc.js";
import { loadVectorItem, isViewportQueryItem } from "../shared/vector-load.js";
import { createAttrWidget, renderAttrContent, attrEntriesFromProps } from "../shared/attr-widget.js";
import { initAiChat } from "../shared/ai-chat.js";
import { createPlayerApi } from "../shared/player-api.js";
import { mountEngineSwitcher, consumeEngineSwitchState } from "../shared/engine-switch.js";
import { initPrint } from "../shared/print.js";
import { loadCompiledQml, specToStyle, qmlLegendSwatchDataUrl, defaultVectorLegendSpec } from "../shared/qml-2d.js";

const TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain";
const VECTOR_TYPES = new Set(["geojson", "layer", "geoparquet", "parquet", "flatgeobuf", "fgb", "gpkg", "geopackage", "csv", "tsv", "duckdb", "sql"]);
const RASTER_TYPES = new Set(["xyz", "tile"]);
const $ = s => document.querySelector(s);

const panel = {
  project: $("#project-select"), layers: $("#layers"), cams: $("#cams"),
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
let currentProjectId = "", lastBaseUrl = "", lastKascRaw = "", currentThemes = [];
let lastCam = { lng: 139.767, lat: 35.681, height: 3000, heading: 0, pitch: -45, roll: 0 };
let photorealScene = null;
// 起動直後・loadProject が URL ハッシュを読む前に、初期カメラの moveend が
// ハッシュをデフォルト位置で上書きするのを防ぐ（MapLibre と同じガード）
let urlViewConsumed = false;

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
  return camToZoomView({ latitude: lastCam.lat, height: lastCam.height }, viewMetrics().vh, viewMetrics().fov);
}
function urlViewFromCam() {
  return { latitude: lastCam.lat, longitude: lastCam.lng, height: lastCam.height, pitch: lastCam.pitch, heading: lastCam.heading, zoom: navaraZoom() };
}
// URL/切替入力からカメラ高さを決める。zoom 優先（2D エンジンからの遷移）、
// zoom が無い従来 URL は height をそのまま使う（Cesium resolveInitialCamera と同じ）
function urlViewHeight(uv) {
  if (Number.isFinite(uv.height) && !Number.isFinite(uv.zoom)) return uv.height;
  if (Number.isFinite(uv.zoom)) {
    const { vh, fov } = viewMetrics();
    return zoomToCamHeightView(uv.latitude, uv.zoom, vh, fov);
  }
  return undefined;
}
function focusExtent(env) {
  if (!env) return;
  flyTo({ longitude: (env.west + env.east) / 2, latitude: (env.south + env.north) / 2, height: zoomToCamHeight((env.south + env.north) / 2, 15) });
}
function setEntryVisible(entry, on) {
  entry.item.visible = on;
  try { entry.layer.visible = on; return; } catch (_) {}
  try { entry.layer?.update?.({ visible: on }); } catch (_) {}
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
    if (r) { entry.src = r.src; entry.layer = r.layer; }
  } catch (e) { entry.failed = true; entry.error = String(e?.message || e); console.warn("layer failed", entry.item.title, e); }
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
  if (exclusive) cb.name = radioName;
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
    section.className = "layer-group";
    const head = document.createElement("div");
    head.className = "layer-group-title";
    const tg = document.createElement("button");
    tg.type = "button";
    tg.className = "layer-group-toggle";
    tg.textContent = expandedLayerGroups.has(key) ? "▾" : "▸";
    tg.setAttribute("aria-expanded", String(expandedLayerGroups.has(key)));
    const gcb = document.createElement("input");
    gcb.type = "checkbox";
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
    });
  }
}

// ---- 凡例タブ（QML legend があればスウォッチ表示） ----
function buildLegends() {
  panel.legends.replaceChildren();
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
  }
}

// ---- 属性一覧 ----
const attrWidget = createAttrWidget({
  listLayers: () => layerEntries.filter(e => VECTOR_TYPES.has(e.item.type))
    .map((entry, i) => ({ id: String(i), title: splitKascTitle(entry.item.title).title || entry.item.title || entry.item.url, entry })),
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
async function applyBasemap(idx) {
  if (basemapLayer) { try { basemapLayer.delete(); } catch (_) {} basemapLayer = null; }
  if (basemapSrc) { try { basemapSrc.delete(); } catch (_) {} basemapSrc = null; }
  const b = baseDocs[idx];
  if (!b) return;
  basemapSrc = view.addSource({ type: "raster-tile", url: resolveKascUrl(b.url, lastBaseUrl), maxZoom: Number(b.opts?.maxzoom) || 18 });
  basemapLayer = view.addLayer({ type: "raster", source: basemapSrc });
  baseEntries.length = 0;
  baseEntries.push({ item: b, src: basemapSrc, layer: basemapLayer });
}
panel.basemapSelect?.addEventListener("change", () => applyBasemap(Number(panel.basemapSelect.value)));

// ---- 地形・写実 ----
async function applyTerrain(on) {
  if (terrainLayer) { try { terrainLayer.delete(); terrainSrc.delete(); } catch (_) {} terrainLayer = terrainSrc = null; }
  if (!on) return;
  terrainSrc = view.addSource({ type: "quantized-mesh", url: TERRAIN_URL, maxZoom: 15, requestVertexNormals: true });
  terrainLayer = view.addLayer({ type: "terrain", source: terrainSrc, terrain: { castShadow: true, receiveShadow: true } });
}
let manualLights = [];
// 写実シーンON時は addDefaultPhotorealScene が sun を内包するため
// 手動 sun を足すと CSM uniform(csmCascades等)が二重注入され全シェーダが
// 破壊される（実GPUで Shader Error: redefinition → 画面全滅）。
// そのため手動ライトは photoreal OFF 時のみ追加する
function syncLights() {
  for (const l of manualLights) { try { l.delete?.(); } catch (_) {} }
  manualLights = [];
  if (photorealScene) { manualLights.push(view.addLight({ ambient: { intensity: 0.8 } })); }
  else {
    manualLights.push(
      view.addLight({ ambient: { intensity: 0.8 } }),
      view.addLight({ sun: { intensity: 1.8, applyColor: true } }));
  }
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
}
function applySunHour(h) {
  try { const d = new Date(); d.setUTCHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0); view.atmosphere.date = d; } catch (_) {}
}

// ---- .kasc → Navara ----
async function addKascLayer(item, baseUrl) {
  const url = item.url ? resolveKascUrl(item.url, baseUrl) : null;
  if (item.type === "3dtiles") {
    const src = view.addSource({ type: "3d-tiles", url });
    const layer = view.addLayer({ type: "3d-tiles", source: src, model: { color: new Color().setHex(0xffffff), metalness: 0, roughness: 1, castShadow: true, receiveShadow: true } });
    return { src, layer };
  }
  if (RASTER_TYPES.has(item.type)) {
    const src = view.addSource({ type: "raster-tile", url, maxZoom: Number(item.opts?.maxzoom) || 18, ...(item.opts?.minzoom ? { minZoom: Number(item.opts.minzoom) } : {}) });
    const layer = view.addLayer({ type: "raster", source: src });
    return { src, layer };
  }
  if (VECTOR_TYPES.has(item.type)) {
    const loaded = await loadVectorItem(item, baseUrl, null);
    item._geojson = loaded.geojson;
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
    const src = view.addSource({ type: "geojson", data: item._geojson, tiled: true });
    const layer = view.addLayer({ type: "vector", source: src,
      polygon: { color: css2hex(fillCss || "#3d7dd9"), clampToGround: true },
      polyline: { color: css2hex(strokeCss || "#2c5ea8"), width: Number(item.opts?.width) || 3, clampToGround: true },
      point: { color: css2hex(markerCss || "#d94f3d"), clampToGround: true } });
    return { src, layer };
  }
  return null;
}

async function renderLayers(doc, baseUrl) {
  for (const e of layerEntries) { try { e.layer?.delete(); } catch (_) {} try { e.src?.delete(); } catch (_) {} }
  layerEntries.length = 0;
  const items = [...doc.layers, ...doc.unsupported.filter(u => u.type === "3dtiles")];
  const unsupported = doc.unsupported.filter(u => u.type !== "3dtiles");
  const visibleCount = items.filter(i => i.visible !== false).length;
  let done = 0;
  progress(0, visibleCount, "");
  for (const item of items) {
    const entry = { item, sid: String(item._idx ?? item.url) };
    layerEntries.push(entry);
    if (item.visible === false) { progress(++done, visibleCount); continue; }
    try {
      const r = await addKascLayer(item, baseUrl);
      if (r) { entry.src = r.src; entry.layer = r.layer; }
    } catch (e) { entry.failed = true; entry.error = String(e?.message || e); console.warn("layer failed", item.title, e); }
    progress(++done, visibleCount, item.title || item.url);
  }
  const notes = unsupported.map(u => `${u.type}: ${u.title || u.url || ""}`).join(" / ");
  if (notes) panel.unsupported.textContent = "未対応: " + notes;
  buildLayerList(); buildLegends(); syncAttribution();
}

async function loadProject(projectId) {
  const { id, manifest, baseUrl, doc, raw } = await loadKascProject(projectId);
  currentProjectId = id; lastBaseUrl = baseUrl; lastKascRaw = raw || "";
  applyPanelTitle(doc.title);
  if (panel.inspector && !panel.inspector.value) panel.inspector.value = lastKascRaw;

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

  // ベースマップ
  panel.basemap.hidden = false;
  baseDocs = doc.bases.filter(b => !b.mode);
  panel.basemapSelect.replaceChildren();
  appendGroupedTitleOptions(panel.basemapSelect, baseDocs, (b, title, i) => {
    const opt = document.createElement("option"); opt.value = String(i); opt.textContent = title; return opt;
  });
  syncBasemapList(panel.basemapSelect);
  await applyBasemap(Number(panel.basemapSelect.value || 0));

  await renderLayers(doc, baseUrl);

  // テーマ
  currentThemes = doc.themes || [];
  fillThemeSelect(panel.themeSelect, currentThemes);
  panel.themeSelect.hidden = !currentThemes.length;

  // cam（ブックマーク XML 展開込み）
  panel.cams.replaceChildren();
  const cams = doc.cams.concat(await loadKascBookmarks(doc.bookmarks, baseUrl).catch(() => []));
  for (const cam of cams) {
    const b = document.createElement("button");
    b.className = "cam-btn bm-btn"; b.type = "button"; b.textContent = cam.name || "cam";
    b.addEventListener("click", () => flyTo({ longitude: cam.longitude, latitude: cam.latitude, height: cam.height, heading: cam.heading, pitch: cam.pitch }));
    panel.cams.append(b);
  }

  // info タブ
  panel.infoLink.replaceChildren();
  void loadKascInfoContent(panel.infoLink, doc.info, baseUrl);

  // 初期カメラ: URL view > 先頭 cam
  const uv = parseUrlView();
  if (hasUrlView(uv)) setCamera({ longitude: uv.longitude, latitude: uv.latitude, height: urlViewHeight(uv), heading: uv.heading, pitch: uv.pitch });
  else if (doc.cams[0]) { const c = doc.cams[0]; flyTo({ longitude: c.longitude, latitude: c.latitude, height: c.height, heading: c.heading, pitch: c.pitch }); }
  urlViewConsumed = true;
}

// インスペクタ: テキスト → doc 再構築してレイヤ反映
async function applyInspectorText(text) {
  const doc = parseKasc(text || "");
  lastKascRaw = text;
  await renderLayers(doc, lastBaseUrl);
  $("#inspector-status") && ($("#inspector-status").textContent = "反映しました");
}

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
  applySunHour(10);

  // URL のビュー状態はレイヤ読込前に適用する。
  // (Navara は一部のレイヤ/ソース追加後にカメラ制御が停止するケースがあり、
  //  loadProject 末尾まで待つと初期位置が適用されないため)
  const bootView = parseUrlView();
  if (hasUrlView(bootView)) setCamera({ longitude: bootView.longitude, latitude: bootView.latitude, height: urlViewHeight(bootView), heading: bootView.heading, pitch: bootView.pitch });

  // カメラ追従: マウス操作時も lastCam・URLハッシュ・camera-changed を同期
  // (Navara の view.camera は move/moveend を emit する。他エンジンとの
  // 座標引継ぎは URL ハッシュ経由のため moveend で書き込む)
  try {
    view.camera.on("move", () => { syncCamFromView(); window.kasugaiApi?.emit("camera-changed", window.kasugaiApi.getCamera()); });
    view.camera.on("moveend", () => { syncCamFromView(); if (urlViewConsumed) writeUrlView(urlViewFromCam(), currentProjectId); });
  } catch (_) {}

  mountEngineSwitcher($("#engines"), "navara");
  const switchState = consumeEngineSwitchState();
  await loadProject();
  if (switchState?.vis) {
    const visMap = new Map(switchState.vis.map(v => [v.t, v.v]));
    for (const e of layerEntries) {
      const key = splitKascTitle(e.item.title).title || e.item.title;
      if (visMap.has(key)) setEntryVisible(e, visMap.get(key));
    }
    buildLayerList(); syncAttribution();
  }

  // 表示タブの Navara 固有コントロール（index.html 側の静的マークアップへバインド）
  $("#nv-terrain")?.addEventListener("change", e => applyTerrain(e.target.checked));
  $("#nv-photoreal")?.addEventListener("change", e => applyPhotoreal(e.target.checked));
  $("#nv-shadow")?.addEventListener("change", e => { try { view.shadow = e.target.checked; } catch (_) {} });
  $("#nv-hour")?.addEventListener("input", e => applySunHour(Number(e.target.value)));

  panel.project.addEventListener("change", () => loadProject(panel.project.value));
  panel.themeSelect?.addEventListener("change", () => {
    const theme = currentThemes.find(t => t.name === panel.themeSelect.value);
    const show = themeShowSet(theme);
    if (!show) return;
    for (const e of layerEntries) setEntryVisible(e, kascTitleInTheme(e.item.title, show));
    buildLayerList(); syncAttribution();
  });
  $("#apply-inspector")?.addEventListener("click", () => applyInspectorText(panel.inspector.value));
  $("#export-inspector")?.addEventListener("click", () => {
    const blob = new Blob([panel.inspector.value || lastKascRaw], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "project.kasc"; a.click(); URL.revokeObjectURL(a.href);
  });
  $("#share-copy")?.addEventListener("click", () => {
    syncCamFromView();
    writeUrlView(urlViewFromCam(), currentProjectId);
    try { navigator.clipboard.writeText(location.href); } catch (_) {}
  });
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
    getBaseEntries: () => baseEntries,
    setBaseEntryVisible: (e, on) => { try { e.layer.visible = on; } catch (_) {} },
    applyEntryVisibility: (e, on) => setEntryVisible(e, on),
    mountEntry: e => setEntryVisible(e, true),
    unmountEntry: e => setEntryVisible(e, false),
    getViewInfo: () => { syncCamFromView(); return { latitude: lastCam.lat, longitude: lastCam.lng, height: lastCam.height, zoom: navaraZoom(), heading: lastCam.heading, pitchDeg: (lastCam.pitch ?? -45) + 90 }; },
    flyToView: v => { if (Number.isFinite(v.latitude) && Number.isFinite(v.longitude)) flyTo({ longitude: v.longitude, latitude: v.latitude, height: v.height ?? (Number.isFinite(v.zoom) ? zoomToCamHeightView(v.latitude, v.zoom, viewMetrics().vh, viewMetrics().fov) : undefined), heading: v.heading, pitch: v.pitch ?? (Number.isFinite(v.pitchDeg) ? v.pitchDeg - 90 : undefined) }); },
    getEntryGeoJson: e => e.item._geojson,
    getCams: () => [...panel.cams.querySelectorAll("button")].map(b => ({ title: b.textContent })),
    getThemes: () => currentThemes.map(t => t.name),
    applyThemeByName: name => { const s = panel.themeSelect; if (s) { s.value = name; s.dispatchEvent(new Event("change")); } },
    applyInspectorText,
    getInspectorText: () => panel.inspector?.value || lastKascRaw,
    setInspectorText: t => { if (panel.inspector) panel.inspector.value = t; },
    maybeLoadEntry: async e => e,
    loadProject: pid => loadProject(pid),
    focusEntry: e => focusExtent(e.item._geojson && geojsonExtent(e.item._geojson)),
    reloadEntryData: async e => { const r = await loadVectorItem(e.item, lastBaseUrl, null); e.item._geojson = r.geojson; },
    rerenderLayers: () => { buildLayerList(); syncAttribution(); },
    getFlyPaths: () => [],
    persistFlyPath: () => {},
    syncFlyPathLine: () => {},
    applyLegendFilter: () => {},
  });
})();
