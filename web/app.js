import * as THREE from "three";

const Cesium = window.Cesium;

const urlParams = new URLSearchParams(window.location.search);
// カメラ情報はハッシュ(#latitude=...)に置く。ハッシュはアドレスバーで書き換えても
// ページが再読み込みされないため、前のビューからそのままFLYTOできる(Google Earth と同じ挙動)
const initialCameraSource = window.location.search + window.location.hash;
const DEFAULT_VIEW = { latitude: 35.6852, longitude: 139.7528, height: 2000, pitch: -30, heading: 0 };

const viewer = new Cesium.Viewer("cesium-container", {
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  vrButton: false,
  infoBox: false,
  selectionIndicator: false,
});

viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.globe.enableLighting = false;
viewer.imageryLayers.removeAll();
viewer.camera.percentageChanged = 0.05;

// リロード直後にデフォルトの地球全体ビューが見えるのを防ぐため、
// 前回のカメラ位置（なければURLの座標）へ描画開始前に同期的に即セットする
let lastCameraSearch = null;
try { lastCameraSearch = sessionStorage.getItem("lastCameraSearch"); } catch (e) {}
const lastCamera = lastCameraSearch ? parseUrlCamera(lastCameraSearch) : null;
const hasLastCamera = !!(lastCamera && Number.isFinite(lastCamera.latitude) && Number.isFinite(lastCamera.longitude));
{
  const startupCamera = hasLastCamera ? lastCamera : parseUrlCamera(initialCameraSource);
  if (Number.isFinite(startupCamera.latitude) && Number.isFinite(startupCamera.longitude)) flyTo(startupCamera, 0);
}

const basemaps = [];
let selectedBasemap = null;
const cameraPresets = [];
const layers = [];
const tileLayers = [];
const layerState = new Map();
let layerOrder = [];
const expandedLayerGroups = new Set();
let currentProjectId = urlParams.get("project") || "default";
let yahooAppId = "";
let terrainEnabled = true;
let undergroundTransparency = 0;
let undergroundDiveEnabled = true;
let undergroundBackgroundColor = Cesium.Color.BLACK;
let basemapDrape3DTiles = false;
let infoRequestId = 0;
let walkModeActive = false;
let flyHeight = 20;
let flySpeed = 30;
const flyPaths = [];
let flyPath = null;
let flyPathProperties = {};
let flyPathCoords = null;
let flyPathCumulativeDistances = [];
let flyPathDistance = 0;
let flyPathTargetDistance = null;
let flyPathLinePositions = [];
let flyPathEntity = null;
let flyPathRafId = null;
let flyPathActive = false;
let flyPathProgress = 0;
let flyRafId = null;
let flyLastTime = performance.now();
let drawModeActive = false;
let drawnPoints = [];
let drawLineEntity = null;
let isDrawing = false;
let lastRightDownTime = 0;
const activeClippingPlanes = { planes: [] };
const uiHooks = {};
const activeDataSources = [];
const vectorDataSources = [];
let vectorSearchData = null;
const activePrimitives = [];
const drapeTerrainSources = { dem: true, tiles3d: false };
const drapeLayers = { xyz: true, geojson: true };
let geojsonPrimitiveDrape = false;
const demSources = {
  reearth: {
    title: "Re:Earth Terrain (標高 / elevation, level 14)",
    url: "https://terrain.reearth.land/cesium-mesh/elevation",
  },
  "reearth-ellipsoid": {
    title: "Re:Earth Terrain (楕円体高 / WGS84, level 14)",
    url: "https://terrain.reearth.land/cesium-mesh/ellipsoid",
  },
  gsi5m: {
    title: "地理院 5m+10mメッシュ (DEM5系+10B / 標高TP基準)",
    gsiLayers: ["dem5a_png", "dem5b_png", "dem5c_png", "dem_png"],
  },
  gsi1m: {
    title: "地理院 1mメッシュ (DEM1A / 航空レーザー / 標高TP基準)",
    gsiLayers: ["dem1a_png"],
  },
};
let selectedDemSource = "reearth-ellipsoid";
const DEFAULT_MAXIMUM_LEVEL = 25;

let threeRenderer;
let threeScene;
let threeCamera;
let threeModel;
let backendEnabled = false;

function parseLayerTitle(title) {
  const parts = title.split(/[\\/]/).map(part => part.trim()).filter(Boolean);
  return {
    title: parts.at(-1) || title,
    group: parts.slice(0, -1).join(" / "),
    exclusiveGroup: /[\\/]{2}/.test(title),
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}

function appendAttributionText(container, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("<")) {
    const wrapper = document.createElement("span");
    wrapper.innerHTML = trimmed;
    container.append(wrapper);
  } else {
    const span = document.createElement("span");
    span.textContent = ` ${trimmed}`;
    container.append(span);
  }
}

function updateMapAttribution() {
  const attribution = document.querySelector("#map-attribution");
  attribution.replaceChildren();
  if (selectedBasemap?.attribution) appendAttributionText(attribution, selectedBasemap.attribution);
  [...tileLayers, ...layers].forEach(item => {
    if (item.visible && item.attribution) appendAttributionText(attribution, item.attribution);
  });
}

async function detectBackend() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const response = await fetch("./health", { signal: controller.signal, cache: "no-store" });
    clearTimeout(timeout);
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      backendEnabled = data?.name === "kasugai_canvas";
    }
  } catch {
    backendEnabled = false;
  }
}


function getProjectBaseUrl() {
  return `projects/${encodeURIComponent(currentProjectId || "default")}/`;
}

function resolveProjectUrl(url) {
  if (typeof url !== "string") return url;
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("//")) return trimmed;
  if (trimmed.startsWith("/")) return trimmed;
  let path = trimmed;
  if (path.startsWith("./")) path = path.slice(2);
  const segments = path.split("/").filter(Boolean);
  const safeSegments = [];
  for (const segment of segments) {
    if (segment === "..") {
      if (safeSegments.length > 0) safeSegments.pop();
    } else if (segment !== ".") {
      safeSegments.push(segment);
    }
  }
  return getProjectBaseUrl() + safeSegments.join("/");
}

async function loadProjects() {
  let definitions = [];
  try {
    const response = await fetch("./projects/projects.json", { cache: "no-store" });
    if (response.ok) definitions = await response.json();
  } catch {}
  if (!definitions.length) definitions = [{ id: "default", title: "デフォルトプロジェクト" }];
  const select = document.querySelector("#project-select");
  select.replaceChildren();
  definitions.forEach(project => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.title || project.id;
    if (project.id === currentProjectId) option.selected = true;
    select.append(option);
  });
}

async function loadInspectorConfig() {
  try {
    const projectId = currentProjectId || "default";
    const staticUrl = `./projects/${encodeURIComponent(projectId)}/kasugai_canvas.kasc`;
    let text = "";
    try {
      const response = await fetch(staticUrl, { cache: "no-store" });
      if (response.ok) text = await response.text();
    } catch {}
    if (!text) text = defaultConfig;
    document.querySelector("#inspector-input").value = text;
    applyInspector(text);
    setInspectorStatus("設定を読み込みました。");
  } catch (error) {
    console.error("設定の読み込みに失敗しました。", error);
    setInspectorStatus(`設定を読み込めません: ${error instanceof Error ? error.message : error}`, true);
  }
}

async function saveInspectorConfig() {
  // 静的サイト構成のためサーバーへの保存は行わない
}

function updateInspectorFromLayerOrder() {
  const input = document.querySelector("#inspector-input");
  if (!input) return;
  const lines = input.value.split(/\r?\n/);
  const layerLineIndices = [];
  lines.forEach((line, index) => {
    const separator = line.indexOf(":");
    if (separator < 0) return;
    const layerType = line.slice(0, separator).toLowerCase().trim();
    if (["xyz", "3dtiles", "geojson", "layer"].includes(layerType)) layerLineIndices.push(index);
  });
  const orderedSourceLines = layerOrder.map(id => layerState.get(id)?.sourceLine).filter(Boolean);
  if (layerLineIndices.length !== orderedSourceLines.length) return;
  layerLineIndices.forEach((index, i) => { lines[index] = orderedSourceLines[i]; });
  input.value = lines.join("\n");
}

async function persistLayerOrder() {
  updateInspectorFromLayerOrder();
  await saveInspectorConfig();
}

function setInspectorStatus(message, isError = false) {
  const status = document.querySelector("#inspector-status");
  status.textContent = message;
  status.style.color = isError ? "#a82020" : "";
}

let toastTimer = null;
function showToast(message, isError = false) {
  let toast = document.querySelector("#app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9999;max-width:360px;padding:8px 12px;border-radius:6px;background:rgba(30,41,51,0.92);color:#fff;font-size:0.85em;box-shadow:0 2px 8px rgba(0,0,0,0.3);white-space:pre-wrap;";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.background = isError ? "rgba(168,32,32,0.95)" : "rgba(30,41,51,0.92)";
  toast.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = "none"; }, 6000);
}

function notifyStatus(message, isError = false) {
  setInspectorStatus(message, isError);
  showToast(message, isError);
}

function flyTo(options = {}, duration = null) {
  const latitude = Number(options.latitude);
  const longitude = Number(options.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  let height = Number(options.height);
  if (!Number.isFinite(height)) height = DEFAULT_VIEW.height;
  const ssec = viewer.scene.screenSpaceCameraController;
  const pitchInput = Number(options.pitch) || 0;
  let pitchDeg = ssec.enableTilt ? Math.min(90, pitchInput) : -90;
  if (ssec.enableTilt && pitchDeg < -85) {
    pitchDeg = -84.99;
  }
  const pitch = pitchDeg * Math.PI / 180;
  const heading = (Number(options.heading) || 0) * Math.PI / 180;
  const destination = Cesium.Cartesian3.fromDegrees(longitude, latitude, height);
  const orientation = { heading, pitch, roll: 0 };
  if (duration === 0) {
    viewer.camera.setView({ destination, orientation });
    return;
  }
  const flight = { destination, orientation };
  if (Number.isFinite(duration)) {
    flight.duration = duration;
  } else {
    // Google Earth 風: 距離に応じて時間を伸ばし、一度ズームアウトしてから降下する弧を描く
    const distance = Cesium.Cartesian3.distance(viewer.camera.position, destination);
    flight.duration = Math.min(7, 1.0 + Math.log2(1 + distance / 1000) * 0.35);
    if (distance > 20000) {
      const currentHeight = Cesium.Cartographic.fromCartesian(viewer.camera.position).height;
      const peak = Math.min(distance * 0.6, 4000000);
      if (peak > Math.max(currentHeight, height)) flight.maximumHeight = peak;
    }
  }
  viewer.camera.flyTo(flight);
}

// 検索座標の地形標高を事前に読み込んで返す（未読み込みタイルもダウンロードする）
async function sampleGroundHeight(lat, lng) {
  const carto = Cesium.Cartographic.fromDegrees(lng, lat);
  // 1. sampleTerrainMostDetailed で対象タイルを事前ダウンロードして正確な標高を得る
  try {
    if (viewer.terrainProvider && !(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)) {
      const [result] = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto]);
      if (result && Number.isFinite(result.height)) return result.height;
    }
  } catch (e) { /* 取得失敗時は読み込み済みタイルにフォールバック */ }
  // 2. フォールバック: 読み込み済みタイルから取得
  try {
    const sampled = viewer.scene.globe.getHeight(carto);
    if (Number.isFinite(sampled)) return sampled;
  } catch (e) { /* ignore */ }
  return 0;
}

// 目的の座標（ピッチ-90で真下に見える地点）が画面中央に来るように、
// ピッチ・高さ・方位からカメラ位置を後退補正して flyTo する。
// height / pitch / heading を省略した場合は現在のカメラの値を使う
async function flyToFeature(lat, lng, options = {}) {
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  const currentHeight = cartographic ? cartographic.height : DEFAULT_VIEW.height;
  const currentPitchDeg = viewer.camera.pitch * 180 / Math.PI;
  const currentHeadingDeg = viewer.camera.heading * 180 / Math.PI;
  const height = Number.isFinite(options.height) ? options.height : currentHeight;
  let pitchDeg = Number.isFinite(options.pitch) ? options.pitch : currentPitchDeg;
  const headingDeg = Number.isFinite(options.heading) ? options.heading : currentHeadingDeg;

  // flyTo 側のピッチ補正と同じ値を先に適用して距離計算のズレを防ぐ
  const ssec = viewer.scene.screenSpaceCameraController;
  if (!ssec.enableTilt) pitchDeg = -90;
  else if (pitchDeg < -85) pitchDeg = -84.99;

  let cameraLat = lat;
  let cameraLng = lng;
  const pitchRad = Math.abs(pitchDeg) * Math.PI / 180;
  // 真下(-90°)に近い場合は補正不要
  if (Math.abs(pitchDeg) < 89 && pitchRad > 0.01) {
    // 検索座標の地形標高を事前読み込みし、地面からの相対高さで後退距離を計算する
    const groundHeight = await sampleGroundHeight(lat, lng);
    const relativeHeight = Math.max(0, height - groundHeight);
    const distance = relativeHeight / Math.tan(pitchRad);
    const headingRad = headingDeg * Math.PI / 180;
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);
    cameraLat = lat - (distance * Math.cos(headingRad)) / metersPerDegLat;
    cameraLng = lng - (distance * Math.sin(headingRad)) / (metersPerDegLng || 1);
  }
  flyTo({ latitude: cameraLat, longitude: cameraLng, height, pitch: pitchDeg, heading: headingDeg });
}

function extractLineStringCoordinates(geojson) {
  if (!geojson || typeof geojson !== "object") return [];
  const coords = [];
  const collect = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (obj.type === "LineString") {
      if (Array.isArray(obj.coordinates)) coords.push(...obj.coordinates);
    } else if (obj.type === "MultiLineString") {
      (obj.coordinates || []).forEach(line => { if (Array.isArray(line)) coords.push(...line); });
    } else if (obj.type === "Feature") {
      collect(obj.geometry);
    } else if (obj.type === "FeatureCollection" || Array.isArray(obj.features)) {
      (obj.features || []).forEach(collect);
    } else if (obj.type === "GeometryCollection" || Array.isArray(obj.geometries)) {
      (obj.geometries || []).forEach(collect);
    }
  };
  collect(geojson);
  return coords.filter(c => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
}

function buildFlyPath(rawCoords) {
  if (!rawCoords.length) return { points: [], distances: [] };
  const points = rawCoords.map(([lng, lat, alt = 0]) => ({ longitude: lng, latitude: lat, altitude: alt, terrain: 0 }));
  const distances = [0];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = (b.longitude - a.longitude) * 111320 * Math.cos((a.latitude + b.latitude) * Math.PI / 360);
    const dy = (b.latitude - a.latitude) * 111320;
    const dz = (b.altitude - a.altitude);
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0;
    distances.push(distances[distances.length - 1] + segLen);
  }
  return { points, distances };
}

async function loadFlyGeoJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const geojson = await response.json();
  const rawCoords = extractLineStringCoordinates(geojson);
  if (!rawCoords.length) throw new Error("LineString または MultiLineString が見つかりません");
  return { ...buildFlyPath(rawCoords), properties: geojson.properties || {} };
}

function buildFlyPathLinePositions(coords) {
  return coords.map(c => Cesium.Cartesian3.fromDegrees(c.longitude, c.latitude, c.altitude + (c.terrain || 0) + flyHeight));
}

function getFlyPathLinePositions() {
  if (!flyPathLinePositions.length) return [];
  const idx = Math.floor(flyPathProgress);
  if (idx < 0 || idx >= flyPathLinePositions.length) return flyPathLinePositions;
  const nextIdx = Math.min(idx + 1, flyPathLinePositions.length - 1);
  const t = flyPathProgress - idx;
  const a = flyPathLinePositions[idx];
  const b = flyPathLinePositions[nextIdx];
  if (t === 0 || !b) return flyPathLinePositions.slice(0, idx + 1);
  const current = new Cesium.Cartesian3(
    a.x + (b.x - a.x) * t,
    a.y + (b.y - a.y) * t,
    a.z + (b.z - a.z) * t
  );
  return [...flyPathLinePositions.slice(0, idx + 1), current];
}

function updateUrlFromCamera() {
  const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  const lon = Number(c.longitude * 180 / Math.PI).toFixed(6);
  const lat = Number(c.latitude * 180 / Math.PI).toFixed(6);
  const pitch = Number(viewer.camera.pitch * 180 / Math.PI).toFixed(2);
  const heading = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
  const height = Number(c.height).toFixed(1);
  const params = new URLSearchParams(window.location.search);
  ["latitude", "longitude", "height", "pitch", "heading"].forEach(key => params.delete(key));
  if (currentProjectId) params.set("project", currentProjectId);
  const hashParams = new URLSearchParams();
  hashParams.set("latitude", lat);
  hashParams.set("longitude", lon);
  hashParams.set("height", height);
  hashParams.set("pitch", pitch);
  hashParams.set("heading", heading);
  const search = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}#${hashParams.toString()}`);
}

function updateCameraInputs() {
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  document.querySelector("#camera-latitude").value = Number(cartographic.latitude * 180 / Math.PI).toFixed(6);
  document.querySelector("#camera-longitude").value = Number(cartographic.longitude * 180 / Math.PI).toFixed(6);
  document.querySelector("#camera-height").value = Number(cartographic.height).toFixed(1);
  document.querySelector("#camera-pitch").value = Number(viewer.camera.pitch * 180 / Math.PI).toFixed(2);
  document.querySelector("#camera-heading").value = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
  const compass = document.querySelector("#compass-button");
  if (compass) compass.style.transform = `rotateZ(${-viewer.camera.heading * 180 / Math.PI}deg)`;
  updateUrlFromCamera();
}

function renderBasemapSelector() {
  const select = document.querySelector("#basemap-select");
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "ベースマップなし";
  select.append(none);
  basemaps.forEach(basemap => {
    const option = document.createElement("option");
    option.value = basemap.id;
    option.textContent = basemap.title;
    if (basemap.id === selectedBasemap?.id) option.selected = true;
    select.append(option);
  });
}

function renderPresets() {
  const container = document.querySelector("#camera-presets");
  container.replaceChildren();
  cameraPresets.forEach((preset, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.title;
    button.dataset.preset = String(index);
    button.addEventListener("click", () => flyTo(preset));
    container.append(button);
  });
}

function getOrderedLayerItems() {
  return layerOrder.map(id => layerState.get(id)).filter(Boolean);
}

function getGroupLayerIds(groupKey) {
  const [groupName, exclusive] = groupKey.split("|");
  return getOrderedLayerItems()
    .filter(layer => (layer.group || "") === groupName && (layer.exclusiveGroup ? "exclusive" : "regular") === exclusive)
    .map(layer => layer.id);
}

function renderLayerList() {
  const list = document.querySelector("#layer-list");
  const groupedLayers = new Map();
  getOrderedLayerItems().forEach(layer => {
    const group = layer.group || "";
    const key = `${group}|${layer.exclusiveGroup ? "exclusive" : "regular"}`;
    if (!groupedLayers.has(key)) groupedLayers.set(key, { group, exclusive: !!layer.exclusiveGroup, layers: [] });
    groupedLayers.get(key).layers.push(layer);
  });
  list.innerHTML = [...groupedLayers.values()].map(({ group, exclusive, layers }) => {
    const groupKey = `${group}|${exclusive ? "exclusive" : "regular"}`;
    const groupId = `layer-group-${[...groupKey].map(character => character.charCodeAt(0).toString(16)).join("")}`;
    const groupInputId = `${groupId}-checkbox`;
    const groupChecked = layers.some(layer => layer.visible);
    return `
    <section class="layer-group${group ? " grouped" : ""}${exclusive ? " exclusive" : ""}" data-group-key="${escapeHtml(groupKey)}">
      ${group ? `<div class="layer-group-title" draggable="true"><button class="layer-group-toggle" type="button" aria-label="グループを展開・折りたたみ" aria-expanded="${expandedLayerGroups.has(groupKey)}">${expandedLayerGroups.has(groupKey) ? "▾" : "▸"}</button><input id="${groupInputId}" class="layer-group-checkbox" type="${exclusive ? "radio" : "checkbox"}" ${exclusive ? `name="${escapeHtml(groupInputId)}"` : ""} data-group-key="${escapeHtml(groupKey)}" ${groupChecked ? "checked" : ""}><label class="layer-group-label" for="${groupInputId}">${escapeHtml(group)}</label>${exclusive ? '<small class="exclusive-badge">Exclusive</small>' : ""}</div>` : ""}
      <div class="layer-group-children" id="${groupId}"${group && !expandedLayerGroups.has(groupKey) ? " hidden" : ""}>
        ${layers.map((layer, index) => {
          const inputId = `${groupId}-layer-${index}`;
          return `
        <label class="layer-row" for="${inputId}" draggable="true" data-layer-id="${escapeHtml(layer.id)}">
          <input id="${inputId}" type="${exclusive ? "radio" : "checkbox"}" ${exclusive ? `name="${escapeHtml(groupId)}"` : ""} data-layer-id="${escapeHtml(layer.id)}" data-group="${escapeHtml(layer.group || "")}" data-exclusive="${exclusive ? "true" : "false"}" ${layer.visible ? "checked" : ""}>
          <span>${escapeHtml(layer.title)}</span>
          <small>${escapeHtml(layer.status || (layer.type === "tile" ? "Tile" : layer.type))}</small>
        </label>`;
        }).join("")}
      </div>
    </section>`;
  }).join("");

  list.querySelectorAll(".layer-group-toggle").forEach(toggle => {
    toggle.addEventListener("click", () => {
      const group = toggle.closest(".layer-group");
      const children = group.querySelector(".layer-group-children");
      const groupKey = group.dataset.groupKey;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      toggle.textContent = expanded ? "▸" : "▾";
      children.hidden = expanded;
      if (expanded) expandedLayerGroups.delete(groupKey);
      else expandedLayerGroups.add(groupKey);
    });
  });

  list.querySelectorAll(".layer-group-checkbox").forEach(input => {
    input.addEventListener("change", () => {
      const group = [...groupedLayers.values()].find(item => `${item.group}|${item.exclusive ? "exclusive" : "regular"}` === input.dataset.groupKey);
      if (!group) return;
      if (group.exclusive) {
        group.layers.forEach(layer => { layer.visible = false; });
        if (input.checked) (group.layers.find(layer => layer.visible) || group.layers[0]).visible = true;
      } else {
        group.layers.forEach(layer => { layer.visible = input.checked; });
      }
      renderLayerList();
      refreshLayers();
    });
  });

  list.querySelectorAll(".layer-group-checkbox").forEach(input => {
    input.addEventListener("click", event => {
      if (input.type === "radio" && input.checked) {
        event.preventDefault();
        input.checked = false;
        input.dispatchEvent(new Event("change"));
      }
    });
  });

  list.querySelectorAll(".layer-row input").forEach(input => {
    input.addEventListener("change", () => {
      const layer = layerState.get(input.dataset.layerId);
      if (!layer) return;
      layer.visible = input.checked;
      if (input.checked && input.dataset.exclusive === "true") {
        getOrderedLayerItems().forEach(other => {
          if (other !== layer && other.group === layer.group && other.exclusiveGroup) other.visible = false;
        });
      }
      renderLayerList();
      refreshLayers();
    });
  });

  let draggedId;
  let draggedGroupKey;

  list.querySelectorAll(".layer-group").forEach(groupSection => {
    groupSection.addEventListener("dragover", event => {
      if (!draggedGroupKey || draggedGroupKey === groupSection.dataset.groupKey) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    groupSection.addEventListener("drop", event => {
      if (!draggedGroupKey) return;
      event.preventDefault();
      const sourceKey = draggedGroupKey;
      const targetKey = groupSection.dataset.groupKey;
      if (sourceKey === targetKey) return;
      const sourceIds = getGroupLayerIds(sourceKey);
      const targetIds = getGroupLayerIds(targetKey);
      const sourceFirstIndex = layerOrder.indexOf(sourceIds[0]);
      const targetFirstIndex = layerOrder.indexOf(targetIds[0]);
      const nextOrder = layerOrder.filter(id => !sourceIds.includes(id));
      let insertIndex;
      if (sourceFirstIndex < targetFirstIndex) {
        insertIndex = nextOrder.indexOf(targetIds[targetIds.length - 1]) + 1;
      } else {
        insertIndex = nextOrder.indexOf(targetIds[0]);
      }
      nextOrder.splice(insertIndex, 0, ...sourceIds);
      layerOrder = nextOrder;
      draggedGroupKey = undefined;
      renderLayerList();
      refreshLayers();
      void persistLayerOrder().catch(error => { console.warn("レイヤー順の保存エラー:", error); });
    });
  });

  list.querySelectorAll(".layer-group-title").forEach(title => {
    title.addEventListener("dragstart", event => {
      const groupSection = title.closest(".layer-group");
      if (!groupSection) return;
      draggedGroupKey = groupSection.dataset.groupKey;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedGroupKey);
      groupSection.classList.add("dragging");
    });
    title.addEventListener("dragend", () => {
      const groupSection = title.closest(".layer-group");
      if (groupSection) groupSection.classList.remove("dragging");
      draggedGroupKey = undefined;
    });
  });

  list.querySelectorAll(".layer-row").forEach(row => {
    row.addEventListener("dragstart", event => {
      draggedId = row.dataset.layerId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedId);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => { draggedId = undefined; row.classList.remove("dragging"); });
    row.addEventListener("dragover", event => {
      if (!draggedId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", event => {
      if (!draggedId) return;
      event.preventDefault();
      const sourceId = draggedId || event.dataTransfer.getData("text/plain");
      const targetId = row.dataset.layerId;
      if (!sourceId || sourceId === targetId) return;
      const orderedLayers = getOrderedLayerItems();
      const sourceLayer = orderedLayers.find(item => item.id === sourceId);
      const targetLayer = orderedLayers.find(item => item.id === targetId);
      if (!sourceLayer || !targetLayer || sourceLayer.group !== targetLayer.group || (sourceLayer.exclusiveGroup ? "exclusive" : "regular") !== (targetLayer.exclusiveGroup ? "exclusive" : "regular")) return;
      const nextOrder = orderedLayers.map(item => item.id);
      const sourceIndex = nextOrder.indexOf(sourceId);
      const targetIndex = nextOrder.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) return;
      nextOrder.splice(sourceIndex, 1);
      nextOrder.splice(nextOrder.indexOf(targetId), 0, sourceId);
      layerOrder = nextOrder;
      renderLayerList();
      refreshLayers();
      void persistLayerOrder().catch(error => { console.warn("レイヤー順の保存エラー:", error); });
    });
  });

  list.querySelectorAll(".layer-group-checkbox").forEach(input => {
    const group = [...groupedLayers.values()].find(item => `${item.group}|${item.exclusive ? "exclusive" : "regular"}` === input.dataset.groupKey);
    if (group && !group.exclusive) input.indeterminate = group.layers.some(layer => layer.visible) && group.layers.some(layer => !layer.visible);
  });
}

function renderFlyPathSelect() {
  const select = document.querySelector("#fly-path-select");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="__manual__">手動</option>' +
    flyPaths.map((path, index) => `<option value="${index}">${escapeHtml(path.title)}</option>`).join("");
  const exists = [...select.options].some(option => option.value === current);
  select.value = exists ? current : "__manual__";
}

async function ensureDrawnRouteFlyPath() {
  // 静的サイト構成のため描画ルートのバックエンド取得は行わない
}

const GSI_DEM_LAYERS = [
  { id: "dem1a_png", maxZ: 17, clampZoom: true },
  { id: "dem5a_png", maxZ: 15, minZ: 15, clampZoom: true },
  { id: "dem5b_png", maxZ: 15, minZ: 15, clampZoom: true },
  { id: "dem5c_png", maxZ: 15, minZ: 15, clampZoom: true },
  { id: "dem_png", maxZ: 14 },
  { id: "demgm_png", maxZ: 8 },
];
const GSI_LAYER_BY_ID = Object.fromEntries(GSI_DEM_LAYERS.map(layer => [layer.id, layer]));

const GSI_MERCATOR_MAX_LAT = 85.05112878;
const GSI_INVALID_PIXEL = 8388608; // 2^23: (R,G,B) = (128,0,0)

function gsiMercatorX(lonDeg, z) {
  return ((lonDeg + 180) / 360) * 256 * (1 << z);
}

function gsiMercatorY(latDeg, z) {
  const clamped = Math.min(Math.max(latDeg, -GSI_MERCATOR_MAX_LAT), GSI_MERCATOR_MAX_LAT);
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 256 * (1 << z);
}

function gsiDecodeHeight(data, offset) {
  const value = data[offset] * 65536 + data[offset + 1] * 256 + data[offset + 2];
  if (value === GSI_INVALID_PIXEL) return 0;
  return (value > GSI_INVALID_PIXEL ? value - 16777216 : value) * 0.01;
}

class GsiDemTerrainProvider {
  constructor(options = {}) {
    this.tilingScheme = new Cesium.GeographicTilingScheme();
    this.outputSize = options.outputSize || 128;
    this.layers = (options.layers || ["dem5a_png"]).map(id => GSI_LAYER_BY_ID[id]).filter(Boolean);
    this.hasVertexNormals = false;
    this.hasWaterMask = false;
    this.maximumLevel = 16;
    this.maxMercatorZ = 17;
    this.availability = {
      isTileAvailable: (level, x, y) => level <= this.maximumLevel && x >= 0 && y >= 0,
    };
    this._tileCache = new Map();
    this.errorEvent = new Cesium.Event();
    this.credit = new Cesium.Credit("出典：国土地理院(標高タイル)");
    this.ready = true;
  }

  getLevelMaximumGeometricError(level) {
    return 156543.03392 / (1 << level);
  }

  getTileDataAvailable(x, y, level) {
    return this.availability.isTileAvailable(level, x, y);
  }

  loadTileDataAvailability() {
    return undefined;
  }

  _fetchSourceTile(layerId, zz, tx, ty) {
    const key = `${layerId}/${zz}/${tx}/${ty}`;
    let promise = this._tileCache.get(key);
    if (promise) return promise;
    promise = (async () => {
      try {
        const url = `https://cyberjapandata.gsi.go.jp/xyz/${layerId}/${zz}/${tx}/${ty}.png`;
        const response = await fetch(url, { mode: "cors" });
        if (!response.ok) return null;
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) { bitmap.close(); return null; }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return ctx.getImageData(0, 0, 256, 256).data;
      } catch (error) {
        return null;
      }
    })();
    if (this._tileCache.size > 2000) this._tileCache.clear();
    this._tileCache.set(key, promise);
    return promise;
  }

  async _loadMercatorTile(x, y, z) {
    // フォールバックなし: 各レイヤーは自身の最大ズームにクランプして並列取得
    const layers = this.layers.filter(layer => z >= (layer.minZ || 0) && (layer.clampZoom || z <= layer.maxZ));
    const results = await Promise.all(layers.map(async layer => {
      const zz = Math.min(z, layer.maxZ);
      const shift = z - zz;
      const tx = x >> shift;
      const ty = y >> shift;
      const pixels = await this._fetchSourceTile(layer.id, zz, tx, ty);
      return pixels ? { pixels, z: zz, x: tx, y: ty } : null;
    }));
    for (const tile of results) {
      if (tile) return tile;
    }
    return null;
  }

  _sampleHeight(tiles, lonDeg, latDeg) {
    for (const tile of tiles) {
      const gx = gsiMercatorX(lonDeg, tile.z) - tile.x * 256;
      const gy = gsiMercatorY(latDeg, tile.z) - tile.y * 256;
      if (gx < 0 || gy < 0 || gx >= 256 || gy >= 256) continue;
      const px = Math.min(255, Math.floor(gx));
      const py = Math.min(255, Math.floor(gy));
      return gsiDecodeHeight(tile.pixels, (py * 256 + px) * 4);
    }
    return 0;
  }

  async requestTileGeometry(x, y, level) {
    const size = this.outputSize;
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level);
    const west = Cesium.Math.toDegrees(rect.west);
    const east = Cesium.Math.toDegrees(rect.east);
    const south = Cesium.Math.toDegrees(rect.south);
    const north = Cesium.Math.toDegrees(rect.north);

    // 地理院タイル(WebメルカトルXYZ)の該当ズームを決定し、範囲内のタイルを列挙
    let z = Math.min(level + 1, this.maxMercatorZ);
    let xMin, xMax, yMin, yMax;
    for (; z >= 0; z -= 1) {
      xMin = Math.max(0, Math.floor(gsiMercatorX(west, z) / 256));
      xMax = Math.min((1 << z) - 1, Math.floor(gsiMercatorX(east - 1e-9, z) / 256));
      yMin = Math.max(0, Math.floor(gsiMercatorY(north, z) / 256));
      yMax = Math.min((1 << z) - 1, Math.floor(gsiMercatorY(south, z) / 256));
      if ((xMax - xMin + 1) * (yMax - yMin + 1) <= 9) break;
    }

    const fetched = await Promise.all(
      Array.from({ length: yMax - yMin + 1 }, (_, iy) => iy + yMin).flatMap(ty =>
        Array.from({ length: xMax - xMin + 1 }, (_, ix) => ix + xMin).map(tx => this._loadMercatorTile(tx, ty, z))
      )
    );
    const tiles = fetched.filter(Boolean);

    const heights = new Float32Array(size * size);
    for (let j = 0; j < size; j += 1) {
      const lat = north - ((j + 0.5) / size) * (north - south);
      for (let i = 0; i < size; i += 1) {
        const lon = west + ((i + 0.5) / size) * (east - west);
        heights[j * size + i] = this._sampleHeight(tiles, lon, lat);
      }
    }

    return new Cesium.HeightmapTerrainData({
      buffer: heights,
      width: size,
      height: size,
      childTileMask: level >= this.maximumLevel ? 0 : 15,
      structure: {
        heightScale: 1.0,
        heightOffset: 0.0,
        elementsPerHeight: 1,
        stride: 1,
        elementMultiplier: 1.0,
        isBigEndian: false,
      },
    });
  }
}


function proxyTileUrl(url, useProxy = true) {
  return url;
}

function proxyTemplateUrl(url, useProxy = true) {
  return url;
}

function createUrlTemplateProvider(options) {
  return new Cesium.UrlTemplateImageryProvider({
    url: proxyTemplateUrl(options.url, options.proxy !== false),
    credit: new Cesium.Credit(options.attribution || ""),
    maximumLevel: options.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
    tileWidth: options.tileSize || 256,
    tileHeight: options.tileSize || 256,
  });
}

function createClippingPlaneFromEnu(normalEnu) {
  const center = viewer.camera.position.clone();
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
  const normalEcef = Cesium.Matrix4.multiplyByPointAsVector(transform, normalEnu, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(normalEcef, normalEcef);
  const distance = -Cesium.Cartesian3.dot(normalEcef, center);
  return new Cesium.ClippingPlane(normalEcef, distance);
}

function applyClippingPlanes(target) {
  try {
    if (!activeClippingPlanes.planes.length) {
      target.clippingPlanes = undefined;
      return;
    }
    target.clippingPlanes = new Cesium.ClippingPlaneCollection({
      planes: activeClippingPlanes.planes.map(p => new Cesium.ClippingPlane(p.normal, p.distance)),
      edgeWidth: 2,
      edgeColor: Cesium.Color.RED,
      enabled: true,
    });
  } catch (error) {
    console.warn("クリッピング平面の適用に失敗しました:", error);
  }
}

function updateUndergroundView() {
  const alpha = 1 - undergroundTransparency;
  viewer.scene.globe.translucency.frontFaceAlpha = alpha;
  viewer.scene.globe.translucency.backFaceAlpha = alpha;
  viewer.scene.globe.undergroundColor = undergroundBackgroundColor;
  viewer.scene.globe.undergroundColorAlphaByDistance = undefined;
  viewer.scene.backgroundColor = undergroundBackgroundColor;
  if (viewer.scene.skyBox) {
    viewer.scene.skyBox.show = undergroundTransparency === 0 && !undergroundDiveEnabled;
  }
  if (undergroundDiveEnabled) {
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
  } else {
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 1;
  }
}

function updateEffectSettings() {
  const hasTerrain = !(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider);
  const terrainLightingInput = document.querySelector("#effect-terrain-lighting");
  const translucencyInput = document.querySelector("#effect-translucency");
  const fogInput = document.querySelector("#effect-fog");
  const skyAtmosphereInput = document.querySelector("#effect-sky-atmosphere");
  const shadowsInput = document.querySelector("#effect-shadows");
  const depthTestInput = document.querySelector("#effect-depth-test");

  viewer.scene.globe.enableLighting = terrainLightingInput?.checked ?? false;
  viewer.scene.shadows = shadowsInput?.checked ?? false;
  viewer.scene.globe.depthTestAgainstTerrain = (depthTestInput?.checked ?? true) && hasTerrain && undergroundTransparency === 0;
  viewer.scene.globe.translucency.enabled = translucencyInput?.checked ?? false;
  if (viewer.scene.fog) viewer.scene.fog.enabled = fogInput?.checked ?? true;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = skyAtmosphereInput?.checked ?? true;
}

function getCesiumTilesetOptions() {
  const sseInput = document.querySelector("#cesium-sse");
  const memoryInput = document.querySelector("#cesium-max-memory");
  const sse = sseInput ? Number(sseInput.value) : 16;
  const maximumMemoryUsage = memoryInput ? Number(memoryInput.value) : 2048;
  return {
    maximumScreenSpaceError: Number.isFinite(sse) && sse >= 0 ? sse : 16,
    maximumMemoryUsage: Number.isFinite(maximumMemoryUsage) && maximumMemoryUsage >= 0 ? maximumMemoryUsage : 2048,
    dynamicScreenSpaceError: document.querySelector("#cesium-dynamic-sse")?.checked ?? false,
    cullWithChildrenBounds: document.querySelector("#cesium-cull-children")?.checked ?? true,
    preferLeaves: document.querySelector("#cesium-prefer-leaves")?.checked ?? false,
    skipLevelOfDetail: document.querySelector("#cesium-skip-lod")?.checked ?? true,
  };
}

function cartesianToDegrees(cartesian) {
  try {
    const c = Cesium.Cartographic.fromCartesian(cartesian);
    return { lat: c.latitude * 180 / Math.PI, lng: c.longitude * 180 / Math.PI };
  } catch (e) { return null; }
}

function getEntityPosition(entity) {
  try {
    const time = viewer.clock && viewer.clock.currentTime;
    if (entity.position) {
      const pos = entity.position.getValue(time);
      if (pos) return pos;
    }
    if (entity.polygon) {
      const hierarchy = entity.polygon.hierarchy.getValue(time);
      const positions = hierarchy && hierarchy.positions;
      if (positions && positions.length) {
        let sum = new Cesium.Cartesian3(0, 0, 0);
        for (const p of positions) sum = Cesium.Cartesian3.add(sum, p, sum);
        return Cesium.Cartesian3.divideByScalar(sum, positions.length, new Cesium.Cartesian3());
      }
    }
    if (entity.polyline) {
      const positions = entity.polyline.positions.getValue(time);
      if (positions && positions.length) {
        let sum = new Cesium.Cartesian3(0, 0, 0);
        for (const p of positions) sum = Cesium.Cartesian3.add(sum, p, sum);
        return Cesium.Cartesian3.divideByScalar(sum, positions.length, new Cesium.Cartesian3());
      }
    }
  } catch (e) {}
  return null;
}

function buildVectorSearchIndex() {
  vectorSearchData = { all: { attributes: [], valuesByAttr: {}, featureByAttr: {} }, layers: {}, layerOptions: [] };
  const time = viewer.clock && viewer.clock.currentTime;
  const allAttrSet = new Set();
  const allValuesMap = {};
  const allFeatureMap = {};
  for (const { ds, id, title } of vectorDataSources) {
    const layerInfo = { title, attributes: [], valuesByAttr: {}, featureByAttr: {} };
    const attrSet = new Set();
    const valuesMap = {};
    const featureMap = {};
    try {
      for (const entity of ds.entities.values) {
        const props = (entity.properties && entity.properties.getValue) ? entity.properties.getValue(time) : (entity.properties || {});
        if (!props) continue;
        for (const key of Object.keys(props)) {
          const raw = props[key];
          if (raw == null || raw === "") continue;
          const val = (typeof raw === "object") ? JSON.stringify(raw) : String(raw);
          attrSet.add(key);
          if (!valuesMap[key]) valuesMap[key] = new Set();
          if (!valuesMap[key].has(val)) {
            valuesMap[key].add(val);
            if (!featureMap[key]) featureMap[key] = {};
            if (!featureMap[key][val]) {
              const cartesian = getEntityPosition(entity);
              const deg = cartesian ? cartesianToDegrees(cartesian) : null;
              if (deg && Number.isFinite(deg.lat) && Number.isFinite(deg.lng)) {
                featureMap[key][val] = deg;
                if (!allFeatureMap[key]) allFeatureMap[key] = {};
                if (!allFeatureMap[key][val]) allFeatureMap[key][val] = deg;
              }
            }
          }
        }
      }
    } catch (e) {}
    layerInfo.attributes = [...attrSet].sort((a, b) => a.localeCompare(b));
    for (const attr of layerInfo.attributes) {
      layerInfo.valuesByAttr[attr] = [...valuesMap[attr]].sort((a, b) => a.localeCompare(b));
      layerInfo.featureByAttr[attr] = featureMap[attr] || {};
    }
    vectorSearchData.layers[id] = layerInfo;
    if (layerInfo.attributes.length) {
      vectorSearchData.layerOptions.push({ id, title });
    }
    for (const attr of layerInfo.attributes) {
      allAttrSet.add(attr);
      if (!allValuesMap[attr]) allValuesMap[attr] = new Set();
      for (const val of layerInfo.valuesByAttr[attr]) allValuesMap[attr].add(val);
    }
  }
  vectorSearchData.all.attributes = [...allAttrSet].sort((a, b) => a.localeCompare(b));
  for (const attr of vectorSearchData.all.attributes) {
    vectorSearchData.all.valuesByAttr[attr] = [...allValuesMap[attr]].sort((a, b) => a.localeCompare(b));
    vectorSearchData.all.featureByAttr[attr] = allFeatureMap[attr] || {};
  }
}

function getCurrentVectorSource() {
  try {
    if (!vectorSearchData) return null;
    const layerSelect = document.querySelector("#vector-layer");
    const layerId = layerSelect ? layerSelect.value : "__all__";
    if (layerId === "__all__") return vectorSearchData.all || null;
    return (vectorSearchData.layers && vectorSearchData.layers[layerId]) || null;
  } catch (e) { return null; }
}

function updateVectorSearchUI() {
  const layerSelect = document.querySelector("#vector-layer");
  const attrSelect = document.querySelector("#vector-attr");
  const valueSelect = document.querySelector("#vector-value");
  const flyBtn = document.querySelector("#vector-fly-btn");
  const status = document.querySelector("#vector-search-status");
  const data = vectorSearchData;
  if (!layerSelect) return;
  const opts = (data && data.layerOptions) || [];
  let html = '<option value="__all__">全選択</option>';
  for (const o of opts) {
    html += '<option value="' + escapeHtml(String(o.id)) + '">' + escapeHtml(o.title || o.id) + '</option>';
  }
  layerSelect.innerHTML = html;
  layerSelect.disabled = (opts.length === 0);
  if (attrSelect) {
    attrSelect.innerHTML = '<option value="__all__">全選択</option>';
    attrSelect.disabled = true;
  }
  if (valueSelect) {
    valueSelect.innerHTML = '<option value="">値を選択</option>';
    valueSelect.disabled = true;
  }
  if (flyBtn) flyBtn.disabled = true;
  if (status) status.textContent = (data && data.all && data.all.attributes.length) ? (data.all.attributes.length + " 属性を読み込みました") : "属性付きベクトルがありません";
  if (layerSelect && !layerSelect.disabled) {
    try { layerSelect.dispatchEvent(new Event("change")); } catch (e) {}
  }
}

async function refreshLayers() {
  viewer.imageryLayers.removeAll(false);
  vectorDataSources.forEach(({ ds }) => { try { viewer.dataSources.remove(ds, false); } catch (error) { /* ignore */ } });
  vectorDataSources.length = 0;
  activeDataSources.length = 0;
  activePrimitives.forEach(primitive => { try { viewer.scene.primitives.remove(primitive); } catch (error) { /* ignore */ } });
  activePrimitives.length = 0;

  const demSource = terrainEnabled ? demSources[selectedDemSource] : null;
  if (demSource?.url) {
    const terrainUrl = proxyTileUrl(demSource.url);
    try {
      const metadataResponse = await fetch(terrainUrl.replace(/\/$/, "") + "/layer.json", { cache: "no-store" });
      if (!metadataResponse.ok) throw new Error(`layer.json の取得に失敗しました (HTTP ${metadataResponse.status})`);
      const terrainProvider = Cesium.CesiumTerrainProvider.fromUrl
        ? await Cesium.CesiumTerrainProvider.fromUrl(terrainUrl)
        : await new Promise((resolve, reject) => {
            const provider = new Cesium.CesiumTerrainProvider({ url: terrainUrl });
            if (!provider.readyPromise) {
              reject(new Error("CesiumTerrainProvider.readyPromise is unavailable"));
            } else {
              provider.readyPromise.then(() => resolve(provider)).catch(reject);
            }
          });
      viewer.terrainProvider = terrainProvider;
    } catch (error) {
      console.warn("DEM の読み込みに失敗しました:", error);
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
  } else if (demSource?.gsiLayers) {
    try {
      viewer.terrainProvider = new GsiDemTerrainProvider({ layers: demSource.gsiLayers });
    } catch (error) {
      console.warn("地理院 DEM の初期化に失敗しました:", error);
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
  } else {
    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  }

  const visible3DTiles = layers.some(l => l.visible && l.type === "3dtiles");
  const drape3DTiles = drapeTerrainSources.tiles3d && visible3DTiles;
  const orderedItems = getOrderedLayerItems();
  const orderedTileLayers = orderedItems.filter(layer => layer.type === "tile").slice().reverse();
  const orderedOtherLayers = orderedItems.filter(layer => layer.type === "3dtiles" || layer.type === "geojson" || layer.type === "layer").slice().reverse();

  // 3D Tiles ドレープ用プロバイダー定義
  const drapeProviders = [];
  if (drape3DTiles) {
    if (basemapDrape3DTiles && selectedBasemap?.url) {
      drapeProviders.push({
        url: selectedBasemap.url,
        attribution: selectedBasemap.attribution,
        maximumLevel: selectedBasemap.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
        tileSize: selectedBasemap.tileSize || 256,
        opacity: selectedBasemap.opacity ?? 1.0,
        proxy: selectedBasemap.proxy,
      });
    }
    if (drapeLayers.xyz) {
      orderedTileLayers.filter(t => t.visible).forEach(item => {
        drapeProviders.push({
          url: item.url,
          attribution: item.attribution,
          maximumLevel: item.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
          tileSize: item.tileSize || 256,
          opacity: item.opacity ?? 0.8,
          proxy: item.proxy,
        });
      });
    }
  }

  // Globe 表面のベースマップ
  if (selectedBasemap?.url) {
    try {
      const provider = createUrlTemplateProvider({
        url: selectedBasemap.url,
        attribution: selectedBasemap.attribution,
        maximumLevel: selectedBasemap.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
        tileSize: selectedBasemap.tileSize || 256,
      });
      viewer.imageryLayers.add(new Cesium.ImageryLayer(provider, { alpha: selectedBasemap.opacity ?? 1.0 }));
    } catch (error) {
      console.warn("ベースマップの作成に失敗しました:", error);
    }
  }

  // Globe 表面の XYZ
  for (const item of orderedTileLayers) {
    if (!item.visible) continue;
    if ((drapeTerrainSources.dem || drape3DTiles) && (!drapeLayers.xyz || !drapeTerrainSources.dem)) continue;
    try {
      const provider = createUrlTemplateProvider({
        url: item.url,
        attribution: item.attribution,
        maximumLevel: item.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
        tileSize: item.tileSize || 256,
      });
      viewer.imageryLayers.add(new Cesium.ImageryLayer(provider, { alpha: item.opacity ?? 0.8 }));
    } catch (error) {
      console.warn("XYZ タイルの作成に失敗しました:", item.url, error);
    }
  }

  // 3D Tiles / GeoJSON
  for (const item of orderedOtherLayers) {
    if (!item.visible && item.type === "3dtiles") continue;
    if (item.type === "3dtiles") {
      try {
        const tileset = await Cesium.Cesium3DTileset.fromUrl(proxyTileUrl(item.url, item.proxy), getCesiumTilesetOptions());
        if (drape3DTiles && Array.isArray(drapeProviders) && drapeProviders.length > 0) {
          drapeProviders.forEach(options => {
            try {
              const provider = createUrlTemplateProvider(options);
              const imageryLayer = new Cesium.ImageryLayer(provider, { alpha: options.opacity ?? 0.8 });
              tileset.imageryLayers.add(imageryLayer);
            } catch (drapeError) {
              console.warn("3D Tiles ドレープレイヤー追加失敗:", options.url, drapeError);
            }
          });
        }
        applyClippingPlanes(tileset);
        viewer.scene.primitives.add(tileset);
        activePrimitives.push(tileset);
      } catch (error) {
        console.warn("3D Tiles の読み込みに失敗しました:", item.url, error);
      }
    } else if (item.type === "geojson" || item.type === "layer") {
      try {
        const clamp = drapeLayers.geojson && (drapeTerrainSources.dem || drape3DTiles);
        if (!clamp && !item.visible) continue;
        if (clamp && geojsonPrimitiveDrape && Cesium.GeoJsonPrimitive) {
          let heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
          if (drapeTerrainSources.dem && drape3DTiles) heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
          else if (drape3DTiles) heightReference = Cesium.HeightReference.CLAMP_TO_3D_TILE;
          else if (drapeTerrainSources.dem) heightReference = Cesium.HeightReference.CLAMP_TO_TERRAIN;
          const primitive = await Cesium.GeoJsonPrimitive.fromUrl(item.url, { heightReference, scene: viewer.scene });
          primitive.show = item.visible;
          viewer.scene.primitives.add(primitive);
          activePrimitives.push(primitive);
          continue;
        }
        let classification;
        if (clamp) {
          if (drapeTerrainSources.dem && drape3DTiles) classification = Cesium.ClassificationType.BOTH;
          else if (drape3DTiles) classification = Cesium.ClassificationType.CESIUM_3D_TILE;
          else if (drapeTerrainSources.dem) classification = Cesium.ClassificationType.TERRAIN;
        }
        const ds = await Cesium.GeoJsonDataSource.load(item.url, { clampToGround: clamp });
        for (const entity of ds.entities.values) {
          if (entity.polygon) {
            entity.polygon.outline = new Cesium.ConstantProperty(false);
            if (clamp) entity.polygon.classificationType = new Cesium.ConstantProperty(classification);
          }
          if (entity.polyline) {
            if (clamp) {
              entity.polyline.clampToGround = new Cesium.ConstantProperty(true);
              entity.polyline.classificationType = new Cesium.ConstantProperty(classification);
            }
          }
        }
        try { ds.show = item.visible; } catch (e) {}
        await viewer.dataSources.add(ds);
        vectorDataSources.push({ ds, id: item.id, title: item.title });
      } catch (error) {
        console.warn("GeoJSON の読み込みに失敗しました:", item.url, error);
      }
    }
  }

  applyClippingPlanes(viewer.scene.globe);
  updateUndergroundView();
  updateEffectSettings();
  buildVectorSearchIndex();
  updateVectorSearchUI();
  updateMapAttribution();
}

function setupInfoTabs(content) {
  const buttons = [...content.querySelectorAll(".tab-button")];
  const panels = [...content.querySelectorAll(".tab-content")];
  if (!buttons.length || !panels.length) return;
  const activate = index => {
    buttons.forEach((button, i) => button.classList.toggle("active", i === index));
    panels.forEach((panel, i) => {
      panel.classList.toggle("active", i === index);
      panel.hidden = i !== index;
    });
  };
  buttons.forEach((button, index) => button.addEventListener("click", () => activate(index)));
  activate(Math.max(0, buttons.findIndex(button => button.classList.contains("active"))));
}

async function loadInfoContent(url) {
  const content = document.querySelector("#info-content");
  if (!content) return;
  const requestId = ++infoRequestId;
  content.replaceChildren();
  if (!url) return;
  try {
    const infoUrl = url;
    const response = await fetch(infoUrl, { mode: "cors" });
    if (!response.ok) throw new Error(await response.text());
    const html = await response.text();
    if (requestId !== infoRequestId) return;
    const documentFragment = new DOMParser().parseFromString(html, "text/html");
    documentFragment.querySelectorAll("script, iframe, object, embed, form, link, style").forEach(node => node.remove());
    documentFragment.querySelectorAll("*").forEach(node => {
      [...node.attributes].forEach(attribute => {
        if (/^on/i.test(attribute.name) || /javascript:/i.test(attribute.value)) node.removeAttribute(attribute.name);
      });
    });
    content.replaceChildren(...[...documentFragment.body.childNodes].map(node => document.importNode(node, true)));
    setupInfoTabs(content);
  } catch (error) {
    if (requestId === infoRequestId) content.textContent = `INFOを読み込めません: ${error instanceof Error ? error.message : error}`;
  }
}

function updateSearchProvider() {
  const searchProvider = document.querySelector("#search-provider");
  const searchYahooWarning = document.querySelector("#search-yahoo-warning");
  if (!searchProvider) return;
  const yahooOpt = searchProvider.querySelector('option[value="yahoo"]');
  const hasYahoo = yahooAppId && !yahooAppId.includes("あなたのYahoo");
  if (yahooOpt) yahooOpt.disabled = !hasYahoo;
  if (!hasYahoo && searchProvider.value === "yahoo") searchProvider.value = "gsi";
  if (searchYahooWarning) searchYahooWarning.style.display = (searchProvider.value === "yahoo") ? "" : "none";
}

function applyInspector(text) {
  const nextLines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsedCameras = [];
  const parsedBasemaps = [];
  layerState.clear();
  tileLayers.splice(0, tileLayers.length);
  layers.splice(0, layers.length);
  basemaps.splice(0, basemaps.length);
  layerOrder = [];
  flyPaths.splice(0, flyPaths.length);
  flyPath = null;
  flyPathCoords = null;
  flyPathLinePositions = [];
  if (flyPathEntity) { viewer.entities.remove(flyPathEntity); flyPathEntity = null; }
  flyPathActive = false;
  flyPathProgress = 0;

  document.body.style.background = "";
  undergroundBackgroundColor = Cesium.Color.BLACK;
  ++infoRequestId;
  document.querySelector("#info-content").replaceChildren();
  document.querySelector("#legend-panel img").removeAttribute("src");

  let inspectorLayerIndex = 0;
  nextLines.forEach(line => {
    const separator = line.indexOf(":");
    if (separator < 0) return;
    const type = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (type === "background") {
      document.body.style.background = value;
      const baseColor = Cesium.Color.fromCssColorString(value);
      if (baseColor) {
        viewer.scene.globe.baseColor = baseColor;
        undergroundBackgroundColor = baseColor;
      }
    }
    if (type === "yahooappid") {
      yahooAppId = value;
      updateSearchProvider();
    }
    if (type === "info") {
      void loadInfoContent(resolveProjectUrl(value));
    }
    if (type === "legend") {
      const parts = value.split("|").map(part => part.trim());
      document.querySelector("#legend-panel img").src = resolveProjectUrl(parts[parts.length - 1]);
    }

    if (type === "base") {
      const parts = value.split("|").map(part => part.trim());
      if (parts[0] && parts[1]) {
        const options = {};
        parts.slice(3).forEach(part => {
          const eq = part.indexOf("=");
          if (eq < 0) return;
          const key = part.slice(0, eq).trim();
          const raw = part.slice(eq + 1).trim();
          const number = Number(raw);
          if (key === "tileSize" && [256, 512].includes(number)) options.tileSize = number;
          if ((key === "maximumLevel" || key === "maxZoom") && Number.isInteger(number) && number >= 0) options.maximumLevel = number;
          if (key === "opacity" && Number.isFinite(number)) options.opacity = Math.max(0, Math.min(1, number));
          if (key === "proxy" && /^(off|false|direct)$/i.test(raw)) options.proxy = false;
        });
        parsedBasemaps.push({
          id: `inspector-base-${parsedBasemaps.length}`,
          title: parts[0],
          url: resolveProjectUrl(parts[1]),
          attribution: parts[2] && !/^(on|off|true|false)$/i.test(parts[2]) ? parts[2] : "",
          tileSize: options.tileSize || 256,
          opacity: options.opacity ?? 1.0,
          proxy: options.proxy !== false,
          ...(options.maximumLevel === undefined ? {} : { maximumLevel: options.maximumLevel }),
        });
      }
    }

    if (type === "cam") {
      const parts = value.split("|").map(part => part.trim());
      if (parts.length < 3) return;
      const camera = { title: parts[0], latitude: Number(parts[1]), longitude: Number(parts[2]), pitch: -30, heading: 0 };
      parts.slice(3).forEach(part => {
        const [key, raw] = part.split("=");
        const number = Number(raw);
        if ((key === "p" || key === "pitch") && Number.isFinite(number)) camera.pitch = number;
        if ((key === "d" || key === "heading") && Number.isFinite(number)) camera.heading = number;
        if ((key === "h" || key === "height") && Number.isFinite(number)) camera.height = number;
      });
      if (Number.isFinite(camera.latitude) && Number.isFinite(camera.longitude)) parsedCameras.push(camera);
    }

    if (type === "fly_geojson") {
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const url = resolveProjectUrl(parts[1]);
      if (!url) return;
      const config = { title: title || url, url, speed: 30, height: 0, pitch: -10, loop: false, step: 100 };
      const off = parts.some(part => /^(off|false)$/i.test(part));
      parts.slice(2).forEach(part => {
        const eq = part.indexOf("=");
        if (eq < 0) return;
        const key = part.slice(0, eq).trim().toLowerCase();
        const raw = part.slice(eq + 1).trim();
        const number = Number(raw);
        if ((key === "speed" || key === "s") && Number.isFinite(number) && number > 0) config.speed = number;
        if ((key === "height" || key === "h") && Number.isFinite(number)) config.height = number;
        if ((key === "pitch" || key === "p") && Number.isFinite(number)) config.pitch = number;
        if ((key === "step") && Number.isFinite(number) && number > 0) config.step = number;
        if (key === "loop" || key === "l") config.loop = /^(true|1|on|yes)$/i.test(raw);
      });
      if (!off) flyPaths.push(config);
    }

    if (type === "xyz") {
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const url = resolveProjectUrl(parts[1]);
      const off = parts.some(part => /^(off|false)$/i.test(part));
      if (!title || !url) return;
      const { group, title: displayTitle, exclusiveGroup } = parseLayerTitle(title);
      const options = {};
      parts.slice(3).forEach(part => {
        const eq = part.indexOf("=");
        if (eq < 0) return;
        const key = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        const number = Number(raw);
        if (key === "opacity" && Number.isFinite(number)) options.opacity = Math.max(0, Math.min(1, number));
        if ((key === "maximumLevel" || key === "maxZoom") && Number.isInteger(number) && number >= 0) options.maximumLevel = number;
        if (key === "tileSize" && [256, 512].includes(number)) options.tileSize = number;
        if (key === "proxy" && /^(off|false|direct)$/i.test(raw)) options.proxy = false;
      });
      const id = `inspector-layer-${inspectorLayerIndex++}`;
      const item = { id, title: displayTitle, sourceTitle: title, sourceLine: line, url, visible: !off, type: "tile", opacity: options.opacity ?? 0.8, attribution: parts[2] && !/^(on|off|true|false)$/i.test(parts[2]) ? parts[2] : "", proxy: options.proxy !== false, group, exclusiveGroup };
      if (options.maximumLevel !== undefined) item.maximumLevel = options.maximumLevel;
      if (options.tileSize !== undefined) item.tileSize = options.tileSize;
      tileLayers.push(item);
      layerState.set(id, item);
      layerOrder.push(id);
    }

    if (type === "3dtiles" || type === "geojson" || type === "layer") {
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const url = resolveProjectUrl(parts[1]);
      const off = parts.some(part => /^(off|false)$/i.test(part));
      const proxy = !parts.some(part => /^proxy\s*=\s*(off|false|direct)$/i.test(part));
      if (!title) return;
      const { group, title: displayTitle, exclusiveGroup } = parseLayerTitle(title);
      const id = `inspector-layer-${inspectorLayerIndex++}`;
      const item = { id, title: displayTitle, sourceTitle: title, sourceLine: line, type, url, visible: !off, attribution: parts[2] && !/^(on|off|true|false)$/i.test(parts[2]) ? parts[2] : "", proxy, group, exclusiveGroup };
      layers.push(item);
      layerState.set(id, item);
      layerOrder.push(id);
    }
  });

  basemaps.splice(0, basemaps.length, ...parsedBasemaps);
  selectedBasemap = basemaps[0] || null;
  cameraPresets.splice(0, cameraPresets.length, ...parsedCameras);
  const uniqueFlyPaths = [...new Map(flyPaths.map(path => [path.url, path])).values()];
  flyPaths.splice(0, flyPaths.length, ...uniqueFlyPaths);
  renderBasemapSelector();
  renderPresets();
  renderLayerList();
  renderFlyPathSelect();
  void ensureDrawnRouteFlyPath();
  refreshLayers();
  updateSearchProvider();
}

function setupThreeJs() {
  const container = document.querySelector("#cesium-container");
  const canvas = document.createElement("canvas");
  canvas.id = "three-canvas";
  canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;";
  container.append(canvas);

  threeRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  threeRenderer.autoClear = false;
  threeRenderer.setPixelRatio(window.devicePixelRatio);
  const resize = () => {
    if (!viewer?.canvas) return;
    threeRenderer.setSize(viewer.canvas.clientWidth, viewer.canvas.clientHeight, false);
  };
  resize();
  window.addEventListener("resize", resize);

  threeScene = new THREE.Scene();
  threeScene.add(new THREE.HemisphereLight(0xffffff, 0x668080, 2.2));
  threeModel = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x168f84, roughness: 0.6, metalness: 0.1 }),
  );
  const modelPosition = Cesium.Cartesian3.fromDegrees(0, 0, 18);
  threeModel.position.set(modelPosition.x, modelPosition.y, modelPosition.z);
  threeModel.scale.setScalar(10000);
  threeModel.rotation.y = 0.6;
  threeScene.add(threeModel);

  threeCamera = new THREE.Camera();
  threeCamera.matrixAutoUpdate = false;

  viewer.scene.postRender.addEventListener(() => {
    if (!threeRenderer || !threeCamera) return;
    threeRenderer.state.reset();
    threeCamera.matrixWorldInverse.fromArray(viewer.camera.viewMatrix);
    threeCamera.matrixWorld.copy(threeCamera.matrixWorldInverse).invert();
    threeCamera.projectionMatrix.fromArray(viewer.camera.frustum.projectionMatrix);
    threeCamera.projectionMatrixInverse.copy(threeCamera.projectionMatrix).invert();
    threeRenderer.render(threeScene, threeCamera);
  });
}

function updateTopDownButton(is2D) {
  const topDownButton = document.querySelector("#top-down-button");
  if (!topDownButton) return;
  topDownButton.textContent = is2D ? "2D" : "3D";
  topDownButton.setAttribute("aria-label", is2D ? "2D top-down view" : "3D perspective view");
  topDownButton.setAttribute("title", is2D ? "2D top-down view" : "3D perspective view");
}

function setTopDown(is2D) {
  const ssec = viewer.scene.screenSpaceCameraController;
  ssec.enableTilt = !is2D;
  viewer.camera.constrainedAxis = is2D ? Cesium.Cartesian3.UNIT_Z : undefined;
  const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  const pitchDeg = viewer.camera.pitch * 180 / Math.PI;
  flyTo({
    latitude: c.latitude * 180 / Math.PI,
    longitude: c.longitude * 180 / Math.PI,
    height: c.height,
    pitch: pitchDeg,
    heading: viewer.camera.heading * 180 / Math.PI,
  });
  updateTopDownButton(is2D);
}

function setupEvents() {
  document.querySelector("#basemap-select").addEventListener("change", event => {
    selectedBasemap = basemaps.find(b => b.id === event.target.value) || null;
    updateMapAttribution();
    refreshLayers();
  });

  document.querySelector("#apply-camera").addEventListener("click", () => {
    const next = {};
    ["longitude", "latitude", "height", "pitch", "heading"].forEach(key => {
      const value = Number(document.querySelector(`#camera-${key}`).value);
      if (Number.isFinite(value)) next[key] = value;
    });
    flyTo(next);
  });

  const searchProvider = document.querySelector("#search-provider");
  if (searchProvider) {
    searchProvider.addEventListener("change", () => {
      const searchYahooWarning = document.querySelector("#search-yahoo-warning");
      if (searchYahooWarning) searchYahooWarning.style.display = (searchProvider.value === "yahoo") ? "" : "none";
    });
  }
  updateSearchProvider();

  document.querySelector("#search-form").addEventListener("submit", async event => {
    event.preventDefault();
    const query = document.querySelector("#search-query").value.trim();
    const results = document.querySelector("#search-results");
    if (!query) {
      results.innerHTML = '<li style="padding:8px;color:#71818d;">検索語を入力してください。</li>';
      return;
    }
    results.innerHTML = '<li style="padding:8px;color:#71818d;">検索中...</li>';
    try {
      const response = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`, { mode: "cors" });
      if (!response.ok) throw new Error(await response.text() || `検索に失敗しました (${response.status})`);
      const data = await response.json();
      const items = data.map(item => ({
        title: item.properties?.title || item.properties?.name || item.properties?.Name || "",
        address: item.properties?.address || item.properties?.Address || item.properties?.title || "",
        latitude: Number(item.geometry?.coordinates?.[1]),
        longitude: Number(item.geometry?.coordinates?.[0]),
      }));
      const validItems = items.filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
      if (!validItems.length) {
        results.innerHTML = '<li style="padding:8px;color:#71818d;">該当する結果がありません。</li>';
        return;
      }
      results.innerHTML = validItems.map((item, index) => `
        <li style="padding:0;border-bottom:1px solid #e4ecef;">
          <button type="button" data-search-index="${index}" style="width:100%;padding:6px 8px;border:0;background:transparent;cursor:pointer;text-align:left;">
            <span style="display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.title)}</span>
            <span style="display:block;font-size:0.85em;color:#52636d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.address)}</span>
          </button>
        </li>
      `).join("");
      results.querySelectorAll("[data-search-index]").forEach(button => {
        button.addEventListener("click", () => {
          const item = validItems[Number(button.dataset.searchIndex)];
          flyToFeature(item.latitude, item.longitude);
        });
      });
    } catch (error) {
      results.innerHTML = `<li style="padding:8px;color:#a82020;">${escapeHtml(error instanceof Error ? error.message : "検索に失敗しました。")}</li>`;
    }
  });

  document.querySelector("#terrain-toggle").addEventListener("change", event => {
    terrainEnabled = event.target.checked;
    refreshLayers();
  });

  document.querySelector("#dem-source").addEventListener("change", event => {
    selectedDemSource = event.target.value;
    terrainEnabled = true;
    document.querySelector("#terrain-toggle").checked = true;
    refreshLayers();
  });

  document.querySelector("#basemap-drape-3dtiles").addEventListener("change", event => {
    basemapDrape3DTiles = event.target.checked;
    refreshLayers();
  });

  document.querySelector("#drape-terrain-dem").addEventListener("change", event => {
    drapeTerrainSources.dem = event.target.checked;
    refreshLayers();
  });

  document.querySelector("#drape-terrain-tiles3d").addEventListener("change", event => {
    drapeTerrainSources.tiles3d = event.target.checked;
    refreshLayers();
  });

  document.querySelector("#drape-xyz").addEventListener("change", event => {
    drapeLayers.xyz = event.target.checked;
    refreshLayers();
  });

  document.querySelector("#drape-geojson").addEventListener("change", event => {
    drapeLayers.geojson = event.target.checked;
    refreshLayers();
  });

  document.querySelector("#drape-geojson-primitive")?.addEventListener("change", event => {
    geojsonPrimitiveDrape = event.target.checked;
    refreshLayers();
  });

  ["#effect-terrain-lighting", "#effect-translucency", "#effect-fog", "#effect-sky-atmosphere", "#effect-shadows", "#effect-depth-test"].forEach(selector => {
    document.querySelector(selector)?.addEventListener("change", () => updateEffectSettings());
  });

  const transparencyInput = document.querySelector("#underground-transparency");
  const transparencyValue = document.querySelector("#underground-transparency-value");
  transparencyInput.addEventListener("input", event => {
    undergroundTransparency = Number(event.target.value);
    if (transparencyValue) transparencyValue.textContent = `${Math.round(undergroundTransparency * 100)}%`;
    updateUndergroundView();
    updateEffectSettings();
  });

  const undergroundDiveToggle = document.querySelector("#underground-dive-toggle");
  undergroundDiveToggle.checked = undergroundDiveEnabled;
  undergroundDiveToggle.addEventListener("change", event => {
    undergroundDiveEnabled = event.target.checked;
    updateUndergroundView();
  });

  ["#cesium-sse", "#cesium-max-memory"].forEach(selector => {
    document.querySelector(selector).addEventListener("change", () => refreshLayers());
  });

  ["#cesium-dynamic-sse", "#cesium-cull-children", "#cesium-prefer-leaves", "#cesium-skip-lod"].forEach(selector => {
    document.querySelector(selector).addEventListener("change", () => refreshLayers());
  });

  function setClipStatus(message, isError = false) {
    const status = document.querySelector("#clip-status");
    status.textContent = message;
    status.style.color = isError ? "#a82020" : "";
  }

  function applyClip(type) {
    const normals = {
      ns: new Cesium.Cartesian3(1, 0, 0),
      ew: new Cesium.Cartesian3(0, 1, 0),
      h: new Cesium.Cartesian3(0, 0, 1),
    };
    const normal = normals[type];
    if (!normal) {
      activeClippingPlanes.planes = [];
      refreshLayers();
      setClipStatus("クリッピングを解除しました。");
      return;
    }
    try {
      activeClippingPlanes.planes = [createClippingPlaneFromEnu(normal)];
      refreshLayers();
      setClipStatus(`${type.toUpperCase()} 断面を適用しました。`);
    } catch (error) {
      setClipStatus(`断面作成エラー: ${error.message}`, true);
    }
  }

  uiHooks.applyClip = applyClip;

  document.querySelector("#clip-ns").addEventListener("click", () => applyClip("ns"));
  document.querySelector("#clip-ew").addEventListener("click", () => applyClip("ew"));
  document.querySelector("#clip-h").addEventListener("click", () => applyClip("h"));
  document.querySelector("#clip-clear").addEventListener("click", () => applyClip("clear"));

  document.querySelector("#compass-button").addEventListener("click", () => {
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    flyTo({
      latitude: c.latitude * 180 / Math.PI,
      longitude: c.longitude * 180 / Math.PI,
      height: c.height,
      pitch: viewer.camera.pitch * 180 / Math.PI,
      heading: 0,
    });
  });

  document.querySelector("#top-down-button").addEventListener("click", () => {
    setTopDown(viewer.scene.screenSpaceCameraController.enableTilt);
  });

  function getBearing(a, b) {
    const lat1 = a.latitude * Math.PI / 180;
    const lat2 = b.latitude * Math.PI / 180;
    const dLng = (b.longitude - a.longitude) * Math.PI / 180;
    const x = Math.sin(dLng) * Math.cos(lat2);
    const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return Math.atan2(x, y);
  }
  function lerpBearing(a, b, t) {
    let diff = b - a;
    while (diff <= -Math.PI) diff += 2 * Math.PI;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    return a + diff * t;
  }
  function updateFlyPathCamera(distance) {
    const path = flyPathCoords;
    const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
    let flyDistance = distance;
    if (flyDistance > total) flyDistance = total;
    if (flyDistance < 0) flyDistance = 0;

    let idx = 0;
    while (idx + 1 < flyPathCumulativeDistances.length && flyDistance >= flyPathCumulativeDistances[idx + 1]) idx++;
    const nextIdx = Math.min(idx + 1, path.length - 1);
    const segDist = (flyPathCumulativeDistances[nextIdx] - flyPathCumulativeDistances[idx]) || 1;
    const t = (flyDistance - flyPathCumulativeDistances[idx]) / segDist;
    const a = path[idx];
    const b = path[nextIdx];
    flyPathProgress = idx + t;
    const lat = a.latitude + (b.latitude - a.latitude) * t;
    const lng = a.longitude + (b.longitude - a.longitude) * t;
    const alt = a.altitude + (b.altitude - a.altitude) * t;
    const terrain = (a.terrain || 0) + ((b.terrain || 0) - (a.terrain || 0)) * t;
    const height = alt + terrain + flyHeight;
    let heading = getBearing(a, b);
    if (nextIdx + 1 < path.length) {
      const nextBearing = getBearing(path[nextIdx], path[nextIdx + 1]);
      const remaining = (1 - t) * segDist;
      const blendStart = Math.min(segDist, 100);
      const blend = remaining < blendStart ? 1 - (remaining / blendStart) : 0;
      heading = lerpBearing(heading, nextBearing, blend);
    }
    const pitch = Math.max(-85, Math.min(0, flyPath.pitch)) * Math.PI / 180;

    try {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lng, lat, height),
        orientation: { heading, pitch, roll: 0 },
      });
      viewer.scene.requestRender();
    } catch (error) {
      console.error("flyPathLoop setView error:", error);
    }

    if (walkOffsetEl && document.activeElement !== walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
    if (walkTerrainEl) walkTerrainEl.textContent = (alt + flyHeight).toFixed(1);
    if (walkTerrainLabelEl) walkTerrainLabelEl.textContent = "地上高（AGL）";
    if (walkSpeedEl && document.activeElement !== walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
    if (walkPitchEl && document.activeElement !== walkPitchEl) walkPitchEl.value = (pitch * 180 / Math.PI).toFixed(1);
  }
  function getTargetVertexDistance(direction) {
    if (!flyPathCoords || flyPathCoords.length < 2 || !flyPathCumulativeDistances.length) return null;
    const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
    if (direction > 0) {
      if (flyPathDistance >= total - 0.001) return null;
      return total;
    }
    if (flyPathDistance <= 0.001) return null;
    return 0;
  }
  function pauseFlyPath() {
    if (flyPathRafId !== null) {
      cancelAnimationFrame(flyPathRafId);
      flyPathRafId = null;
    }
    flyPathActive = false;
  }
  function toggleFlyPathDirection(direction) {
    if (!flyPathCoords || flyPathCoords.length < 2) return;
    if (flyPathActive && flyPathTargetDistance !== null) {
      const movingForward = flyPathTargetDistance > flyPathDistance;
      const movingBackward = flyPathTargetDistance < flyPathDistance;
      if ((direction > 0 && movingForward) || (direction < 0 && movingBackward)) {
        pauseFlyPath();
        return;
      }
    }
    const target = getTargetVertexDistance(direction);
    if (target === null) return;
    flyPathTargetDistance = target;
    if (walkRafId !== null) {
      cancelAnimationFrame(walkRafId);
      walkRafId = null;
    }
    if (flyPathRafId === null) {
      flyPathActive = true;
      flyPathLastTime = performance.now();
      flyPathRafId = requestAnimationFrame(flyPathLoop);
    }
  }

  function stopFlyPath() {
    flyPathActive = false;
    flyPathTargetDistance = null;
    if (flyPathRafId !== null) {
      cancelAnimationFrame(flyPathRafId);
      flyPathRafId = null;
    }
    if (flyPathEntity) {
      viewer.entities.remove(flyPathEntity);
      flyPathEntity = null;
    }
    flyPath = null;
    flyPathProperties = {};
    flyPathCoords = null;
    flyPathCumulativeDistances = [];
    flyPathDistance = 0;
    flyPathProgress = 0;
    flyPathLinePositions = [];
    updateFlyPointEditor();
  }

  async function startFlyPath(index) {
    if (!Number.isFinite(index) || index < 0 || index >= flyPaths.length) return;
    if (flyPathRafId !== null) {
      cancelAnimationFrame(flyPathRafId);
      flyPathRafId = null;
    }
    flyPath = flyPaths[index];
    try {
      const pathData = await loadFlyGeoJson(flyPath.url);
      flyPathCoords = pathData.points;
      flyPathCumulativeDistances = pathData.distances;
      flyPathProperties = pathData.properties || {};
    } catch (error) {
      console.error("Fly GeoJSON の読み込みに失敗しました:", error);
      flyPathCoords = null;
      flyPathCumulativeDistances = [];
      flyPathProperties = {};
      flyPathActive = false;
      return;
    }
    if (!flyPathCoords || !flyPathCoords.length) return;
    flySpeed = Number.isFinite(flyPath.speed) ? Number(flyPath.speed) : 30;
    flyHeight = Number.isFinite(flyPath.height) ? Number(flyPath.height) : 0;
    if (walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
    if (walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
    if (!flyPathCoords || !flyPathCoords.length) return;
    for (const point of flyPathCoords) {
      const carto = Cesium.Cartographic.fromDegrees(point.longitude, point.latitude);
      point.terrain = carto ? (viewer.scene.globe.getHeight(carto) ?? 0) : 0;
    }
    flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
    if (flyPathEntity) viewer.entities.remove(flyPathEntity);
    flyPathEntity = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => getFlyPathLinePositions(), false),
        width: 4,
        material: new Cesium.PolylineGlowMaterialProperty({ color: Cesium.Color.YELLOW, glowPower: 0.15 }),
      },
    });
    flyPathProgress = 0;
    flyPathDistance = 0;
    flyPathTargetDistance = null;
    flyPathActive = false;
    if (flyPathRafId !== null) {
      cancelAnimationFrame(flyPathRafId);
      flyPathRafId = null;
    }
    updateFlyPathCamera(0);
    updateFlyPointEditor();
  }

  let flyPathLastTime = performance.now();
  const flyPathLoop = (timestamp) => {
    flyPathRafId = null;
    if (!flyPathActive || !flyPathCoords || !flyPathCoords.length) return;
    try {
      const delta = Math.min((timestamp - flyPathLastTime) / 1000, 0.1);
      flyPathLastTime = timestamp;
      applyWalkKeys(delta);

      const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
      if (flyPathTargetDistance !== null) {
        const stepMeters = Math.abs(flySpeed / 3.6) * delta;
        const diff = flyPathTargetDistance - flyPathDistance;
        if (Math.abs(diff) <= stepMeters) {
          flyPathDistance = flyPathTargetDistance;
          flyPathTargetDistance = null;
          flyPathActive = false;
        } else {
          flyPathDistance += Math.sign(diff) * stepMeters;
          if (flyPathDistance > total) flyPathDistance = total;
          if (flyPathDistance < 0) flyPathDistance = 0;
        }
        updateFlyPathCamera(flyPathDistance);
      } else {
        const stepMeters = (flySpeed / 3.6) * delta;
        flyPathDistance += stepMeters;
        if (flyPathDistance > total) {
          if (flyPath.loop) {
            flyPathDistance = total > 0 ? flyPathDistance % total : 0;
          } else {
            flyPathDistance = total;
            updateFlyPathCamera(flyPathDistance);
            stopFlyPath();
            return;
          }
        }
        if (flyPathDistance < 0) {
          if (flyPath.loop && total > 0) {
            flyPathDistance = (total + (flyPathDistance % total)) % total;
          } else {
            flyPathDistance = 0;
            updateFlyPathCamera(flyPathDistance);
            stopFlyPath();
            return;
          }
        }

        updateFlyPathCamera(flyPathDistance);
      }

      if (flyPathActive) flyPathRafId = requestAnimationFrame(flyPathLoop);
    } catch (error) {
      console.error("flyPathLoop error:", error);
      stopFlyPath();
    }
  };

  const modeSelect = document.querySelector("#mode-select");
  const walkOffsetEl = document.querySelector("#walk-offset");
  const walkTerrainEl = document.querySelector("#walk-terrain");
  const walkTerrainLabelEl = document.querySelector("#walk-terrain-label");
  const walkSpeedEl = document.querySelector("#walk-speed");
  const walkPitchEl = document.querySelector("#walk-pitch");
  const flyPresetSelect = document.querySelector("#fly-preset-select");
  const flyPointEditor = document.querySelector("#fly-point-editor");
  const flyPointIndexEl = document.querySelector("#fly-point-index");
  const flyPointOffsetEl = document.querySelector("#fly-point-offset");
  const flyPointSaveEl = document.querySelector("#fly-point-save");
  const flyReverseBtn = document.querySelector("#fly-reverse-btn");
  const walkKeys = new Set();
  function updateFlyPointEditor() {
    if (!flyPointEditor || !flyPointIndexEl || !flyPointOffsetEl) return;
    if (!flyPathCoords || !flyPathCoords.length) {
      flyPointEditor.style.display = "none";
      return;
    }
    flyPointEditor.style.display = "";
    const currentIndex = Math.min(Math.max(0, Math.round(flyPathProgress) || 0), flyPathCoords.length - 1);
    flyPointIndexEl.innerHTML = "";
    for (let i = 0; i < flyPathCoords.length; i++) {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = String(i + 1);
      if (i === currentIndex) option.selected = true;
      flyPointIndexEl.appendChild(option);
    }
    const point = flyPathCoords[currentIndex];
    flyPointOffsetEl.value = Number.isFinite(point.altitude) ? point.altitude.toFixed(1) : "0.0";
  }
  async function saveFlyPointOffsets() {
    if (!flyPathCoords || !flyPath || !flyPath.url) return;
    if (!flyPath.url.startsWith("/api/file")) {
      console.warn("ローカルファイル以外のルートは保存できません");
      return;
    }
    const coordinates = flyPathCoords.map(p => [p.longitude, p.latitude, Number.isFinite(p.altitude) ? p.altitude : 0]);
    const properties = Object.keys(flyPathProperties || {}).length ? flyPathProperties : { heightReference: "Terrain", heightOffset: 20 };
    const geojson = {
      type: "Feature",
      properties,
      geometry: { type: "LineString", coordinates }
    };
    try {
      const response = await fetch(flyPath.url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geojson) });
      if (!response.ok) throw new Error(await response.text());
      console.log("点の高さを保存しました");
    } catch (error) {
      console.error("点の高さの保存に失敗しました:", error);
    }
  }
  function applyWalkKeys(delta) {
    if (!flyPathCoords || flyPathCoords.length < 2) return;
    const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;

    const heightChange = (walkKeys.has("KeyQ") ? 1 : 0) - (walkKeys.has("KeyE") ? 1 : 0);
    if (heightChange !== 0) {
      flyHeight += 10 * heightChange * delta;
      if (flyPathCoords) flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
    }

    const speedChange = (walkKeys.has("Equal") || walkKeys.has("NumpadAdd") ? 1 : 0) -
      (walkKeys.has("Minus") || walkKeys.has("NumpadSubtract") ? 1 : 0);
    if (speedChange !== 0) {
      flySpeed += 20 * speedChange * delta;
      if (flySpeed < 0) flySpeed = 0;
    }

    const pitchChange = (walkKeys.has("ArrowUp") ? 1 : 0) - (walkKeys.has("ArrowDown") ? 1 : 0);
    if (pitchChange !== 0 && flyPath) {
      flyPath.pitch += 20 * pitchChange * delta;
      flyPath.pitch = Math.max(-85, Math.min(0, flyPath.pitch));
    }

    const manualDirection = (walkKeys.has("KeyW") ? 1 : 0) - (walkKeys.has("KeyS") ? 1 : 0);
    if (manualDirection > 0) {
      flyPathTargetDistance = total;
    } else if (manualDirection < 0) {
      flyPathTargetDistance = 0;
    }
  }
  if (walkOffsetEl) {
    walkOffsetEl.addEventListener("input", () => {
      const value = Number(walkOffsetEl.value);
      if (!Number.isFinite(value)) {
        walkOffsetEl.value = flyHeight.toFixed(1);
        return;
      }
      flyHeight = value;
      if (flyPathActive && flyPath) flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
      if (flyPresetSelect) flyPresetSelect.value = "custom";
    });
  }
  if (walkSpeedEl) {
    walkSpeedEl.addEventListener("input", () => {
      const value = Number(walkSpeedEl.value);
      if (!Number.isFinite(value)) {
        walkSpeedEl.value = flySpeed.toFixed(1);
        return;
      }
      flySpeed = value;
      if (flyPresetSelect) flyPresetSelect.value = "custom";
    });
  }
  if (walkPitchEl) {
    walkPitchEl.addEventListener("input", () => {
      const value = Number(walkPitchEl.value);
      if (!Number.isFinite(value)) {
        const currentDeg = (flyPath && Number.isFinite(flyPath.pitch)) ? flyPath.pitch : viewer.camera.pitch * 180 / Math.PI;
        walkPitchEl.value = Number.isFinite(currentDeg) ? currentDeg.toFixed(1) : "-10.0";
        return;
      }
      if (flyPath) {
        flyPath.pitch = Math.max(-85, Math.min(0, value));
        if (flyPathCoords) {
          flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
          updateFlyPathCamera(flyPathDistance);
        }
      } else if (walkModeActive) {
        const pitchRad = Math.max(-85 * Math.PI / 180, Math.min(-5 * Math.PI / 180, value * Math.PI / 180));
        viewer.camera.setView({
          destination: viewer.camera.position,
          orientation: { heading: viewer.camera.heading, pitch: pitchRad, roll: 0 }
        });
      }
      if (flyPresetSelect) flyPresetSelect.value = "custom";
    });
  }
  if (flyPresetSelect) {
    flyPresetSelect.addEventListener("change", () => {
      const presets = {
        walk: { height: 2, speed: 5, pitch: -5 },
        drive: { height: 2, speed: 60, pitch: -10 },
        drone: { height: 200, speed: 60, pitch: -30 },
        overview: { height: 1000, speed: 300, pitch: -45 }
      };
      const preset = presets[flyPresetSelect.value];
      if (!preset) return;
      flyHeight = preset.height;
      flySpeed = preset.speed;
      if (walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
      if (walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
      if (walkPitchEl) walkPitchEl.value = Number.isFinite(preset.pitch) ? preset.pitch.toFixed(1) : "-10.0";
      if (flyPath && Number.isFinite(preset.pitch)) {
        flyPath.pitch = Math.max(-85, Math.min(0, preset.pitch));
      }
      if (flyPathCoords && flyPath) {
        flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
        updateFlyPathCamera(flyPathDistance);
      } else if (walkModeActive) {
        const pitchRad = Math.max(-85 * Math.PI / 180, Math.min(-5 * Math.PI / 180, preset.pitch * Math.PI / 180));
        viewer.camera.setView({
          destination: viewer.camera.position,
          orientation: { heading: viewer.camera.heading, pitch: pitchRad, roll: 0 }
        });
      }
    });
  }
  if (flyPointIndexEl) {
    flyPointIndexEl.addEventListener("change", () => {
      const index = Number(flyPointIndexEl.value);
      if (!flyPathCoords || !flyPathCoords[index]) return;
      flyPointOffsetEl.value = Number.isFinite(flyPathCoords[index].altitude) ? flyPathCoords[index].altitude.toFixed(1) : "0.0";
    });
  }
  if (flyPointOffsetEl) {
    flyPointOffsetEl.addEventListener("input", () => {
      const index = Number(flyPointIndexEl.value);
      const value = Number(flyPointOffsetEl.value);
      if (!flyPathCoords || !flyPathCoords[index] || !Number.isFinite(value)) return;
      flyPathCoords[index].altitude = value;
      if (flyPathCoords) flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
    });
  }
  if (flyPointSaveEl) {
    flyPointSaveEl.addEventListener("click", saveFlyPointOffsets);
  }
  if (flyReverseBtn) {
    flyReverseBtn.addEventListener("click", () => {
      pauseFlyPath();
      if (flyPathCoords && flyPathCoords.length >= 2) {
        flyPathCoords.reverse();
        const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
        flyPathCumulativeDistances = flyPathCumulativeDistances.map((_, i, arr) => total - arr[arr.length - 1 - i]);
        flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
        flyPathDistance = 0;
        updateFlyPathCamera(0);
        updateFlyPointEditor();
      } else if (walkModeActive) {
        const camera = viewer.camera;
        const heading = Cesium.Math.zeroToTwoPi(camera.heading + Math.PI);
        camera.setView({
          destination: camera.position,
          orientation: { heading, pitch: camera.pitch, roll: 0 }
        });
      }
    });
  }
  viewer.canvas.addEventListener("wheel", event => {
    if (!walkModeActive) return;
    event.preventDefault();
    flySpeed = flySpeed + Math.sign(event.deltaY) * 1;
    if (walkSpeedEl && document.activeElement !== walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
  }, { passive: false });
  let walkLastTime = performance.now();
  let autoMove = 0;
  let walkRafId = null;
  const walkLoop = (timestamp) => {
    walkRafId = null;
    const delta = Math.min((timestamp - walkLastTime) / 1000, 0.1);
    walkLastTime = timestamp;
    if (walkModeActive) {
      const camera = viewer.camera;
      let heading = camera.heading;
      let pitch = camera.pitch;

      const turnDelta = 1.5 * delta;
      if (walkKeys.has("KeyA") || walkKeys.has("ArrowLeft")) heading -= turnDelta;
      if (walkKeys.has("KeyD") || walkKeys.has("ArrowRight")) heading += turnDelta;

      const pitchDelta = 0.8 * delta;
      if (walkKeys.has("ArrowUp")) pitch += pitchDelta;
      if (walkKeys.has("ArrowDown")) pitch -= pitchDelta;
      pitch = Math.max(-85 * Math.PI / 180, Math.min(-5 * Math.PI / 180, pitch));

      const manualMove = (walkKeys.has("KeyW") ? 1 : 0) - (walkKeys.has("KeyS") ? 1 : 0);
      const move = (manualMove !== 0) ? manualMove : autoMove;
      const speedChange = (walkKeys.has("Equal") || walkKeys.has("NumpadAdd") ? 1 : 0) -
        (walkKeys.has("Minus") || walkKeys.has("NumpadSubtract") ? 1 : 0);
      flySpeed += 100 * speedChange * delta;
      const moveDistance = (flySpeed / 3.6) * delta;
      if (move !== 0) {
        const normal = viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(camera.position, new Cesium.Cartesian3());
        const dot = Cesium.Cartesian3.dot(camera.direction, normal);
        const horizontal = Cesium.Cartesian3.add(
          camera.direction,
          Cesium.Cartesian3.multiplyByScalar(normal, -dot, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        );
        Cesium.Cartesian3.normalize(horizontal, horizontal);
        camera.move(horizontal, move * moveDistance);
      }

      const carto = Cesium.Cartographic.fromCartesian(camera.position);
      if (carto) {
        const terrainHeight = viewer.scene.globe.getHeight(carto) ?? 0;
        const heightChange = (walkKeys.has("KeyQ") ? 1 : 0) - (walkKeys.has("KeyE") ? 1 : 0);
        flyHeight += 10 * heightChange * delta;
        carto.height = terrainHeight + flyHeight;
        camera.setView({
          destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
          orientation: { heading, pitch, roll: 0 },
        });
        if (walkOffsetEl && document.activeElement !== walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
        if (walkTerrainEl) walkTerrainEl.textContent = terrainHeight.toFixed(1);
        if (walkTerrainLabelEl) walkTerrainLabelEl.textContent = "地形高";
        if (walkSpeedEl && document.activeElement !== walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
        if (walkPitchEl && document.activeElement !== walkPitchEl) walkPitchEl.value = (pitch * 180 / Math.PI).toFixed(1);
      }
      walkRafId = requestAnimationFrame(walkLoop);
    }
  };
  const walkHelp = document.querySelector("#walk-help");
  const ssec = viewer.scene.screenSpaceCameraController;
  const defaultLookEventTypes = ssec.lookEventTypes;
  const defaultZoomEventTypes = ssec.zoomEventTypes ? [...ssec.zoomEventTypes] : [];
  const wheelEventType = Cesium.CameraEventType?.WHEEL;
  let drawTabActive = false;
  const walkZoomWithoutWheel = wheelEventType
    ? defaultZoomEventTypes.filter(t => t !== wheelEventType)
    : defaultZoomEventTypes;
  const setMode = (next) => {
    const isWalk = next === "walk";
    const wasWalk = walkModeActive;
    modeSelect.value = next;
    modeSelect.textContent = isWalk ? "Fly" : "Orbit";
    modeSelect.setAttribute("aria-label", isWalk ? "Fly mode" : "Orbit view");
    walkModeActive = isWalk;
    autoMove = 0;
    walkHelp?.classList.toggle("visible", isWalk || drawTabActive);
    if (flyReverseBtn) flyReverseBtn.disabled = !isWalk;
    if (isWalk) {
      const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
      if (carto) {
        const terrainHeight = viewer.scene.globe.getHeight(carto) ?? 0;
        flyHeight = carto.height - terrainHeight;
      }
    }
    ssec.enableZoom = true;
    ssec.lookEventTypes = defaultLookEventTypes;
    ssec.zoomEventTypes = isWalk && !drawTabActive
      ? walkZoomWithoutWheel
      : defaultZoomEventTypes;
    viewer.scene.mode = Cesium.SceneMode.SCENE3D;
    if (isWalk && !wasWalk) {
      const select = document.querySelector("#fly-path-select");
      const pathValue = select?.value || "__manual__";
      if (pathValue !== "__manual__" && !flyPathActive) {
        const index = Number(pathValue);
        if (Number.isFinite(index) && index >= 0 && index < flyPaths.length) void startFlyPath(index);
      } else if (pathValue === "__manual__" && !walkRafId) {
        stopFlyPath();
        walkLastTime = performance.now();
        walkRafId = requestAnimationFrame(walkLoop);
      }
    }
    if (!isWalk) {
      stopFlyPath();
      if (walkRafId) {
        cancelAnimationFrame(walkRafId);
        walkRafId = null;
      }
    }
  };
  uiHooks.setMode = setMode;
  uiHooks.startFlyPath = startFlyPath;
  uiHooks.stopFlyPath = stopFlyPath;

  modeSelect.addEventListener("click", () => {
    drawTabActive = false;
    stopDrawMode();
    setMode(modeSelect.value === "orbit" ? "walk" : "orbit");
  });
  document.querySelector("#fly-path-select")?.addEventListener("change", () => {
    if (!walkModeActive) return;
    stopFlyPath();
    if (walkRafId) {
      cancelAnimationFrame(walkRafId);
      walkRafId = null;
    }
    const select = document.querySelector("#fly-path-select");
    const pathValue = select?.value || "__manual__";
    if (pathValue !== "__manual__") {
      const index = Number(pathValue);
      if (Number.isFinite(index) && index >= 0 && index < flyPaths.length) void startFlyPath(index);
    } else {
      walkLastTime = performance.now();
      walkRafId = requestAnimationFrame(walkLoop);
    }
  });

  const drawModeToggle = document.querySelector("#draw-mode-toggle");
  function updateDrawModeButton() { if (drawModeToggle) drawModeToggle.classList.toggle("active", drawModeActive); }
  function addDrawPoint(screenPosition) {
    if (!drawModeActive) return;
    const ray = viewer.camera.getPickRay(screenPosition);
    if (!ray) return;
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const point = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height + 20);
    if (drawnPoints.length > 0) {
      const last = drawnPoints[drawnPoints.length - 1];
      const dx = point.x - last.x;
      const dy = point.y - last.y;
      const dz = point.z - last.z;
      if (dx * dx + dy * dy + dz * dz < 25) return;
    }
    drawnPoints.push(point);
    if (!drawLineEntity) {
      drawLineEntity = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => drawnPoints, false),
          width: 4,
          material: new Cesium.PolylineGlowMaterialProperty({ color: Cesium.Color.CYAN, glowPower: 0.15 }),
        },
      });
    }
  }
  function stopDrawMode() {
    drawModeActive = false;
    isDrawing = false;
    lastRightDownTime = 0;
    updateDrawModeButton();
    if (viewer.scene.screenSpaceCameraController) {
      ssec.zoomEventTypes = !walkModeActive || drawTabActive
        ? defaultZoomEventTypes
        : walkZoomWithoutWheel;
    }
  }
  function clearDrawnLine() {
    if (drawLineEntity) {
      viewer.entities.remove(drawLineEntity);
      drawLineEntity = null;
    }
    drawnPoints = [];
  }
  function buildDrawnGeoJson() {
    if (drawnPoints.length < 2) return null;
    const baseHeight = 20;
    const coordinates = drawnPoints.map(p => {
      const c = Cesium.Cartographic.fromCartesian(p);
      const lng = Number((c.longitude * 180 / Math.PI).toFixed(6));
      const lat = Number((c.latitude * 180 / Math.PI).toFixed(6));
      return [lng, lat, baseHeight];
    });
    return {
      type: "Feature",
      properties: { heightReference: "Terrain", heightOffset: baseHeight },
      geometry: { type: "LineString", coordinates },
    };
  }
  function drawnRouteFileName() {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `drawn_route_${timestamp}.geojson`;
  }

  async function saveDrawnLineToFolder(fileName, text) {
    if (!window.showDirectoryPicker) {
      notifyStatus("このブラウザは File System Access API に未対応のため、描画ルートを保存できません。Chrome/Edge で開いてください。", true);
      return;
    }
    const dir = await getDataDirHandle();
    if (!dir) {
      notifyStatus("保存先フォルダが未選択のため、描画ルートは保存されませんでした。インスペクターの「保存先フォルダ」で設定してください。", true);
      return;
    }
    const file = await dir.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
    const objectUrl = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
    flyPaths.push({ title: fileName.replace(/\.geojson$/, ""), url: objectUrl, speed: 30, height: 0, pitch: -10, loop: false, step: 100 });
    renderFlyPathSelect();
    notifyStatus(`描画ルートを ${dir.name}/${fileName} に保存し、FLYパス一覧に登録しました。fly_geojson: タイトル | DATA/${fileName} で永続化できます。`);
  }

  async function cacheDrawnLine() {
    const geojson = buildDrawnGeoJson();
    if (!geojson) return;
    try {
      const fileName = drawnRouteFileName();
      const text = JSON.stringify(geojson, null, 2);
      await saveDrawnLineToFolder(fileName, text);
    } catch (error) {
      if (error && error.name === "AbortError") {
        notifyStatus("フォルダ選択がキャンセルされたため、描画ルートは保存されませんでした。");
        return;
      }
      notifyStatus(`描画ルートの保存に失敗しました: ${error instanceof Error ? error.message : error}`, true);
    }
  }

  function getCanvasPosition(event) {
    const rect = viewer.canvas.getBoundingClientRect();
    return new Cesium.Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
  }
  const RIGHT_DOUBLE_MS = 400;
  let suppressContextMenu = false;
  function onDrawPointerDown(event) {
    if (!drawModeActive || event.button !== 2) return;
    event.preventDefault();
    const now = performance.now();
    const isDouble = now - lastRightDownTime < RIGHT_DOUBLE_MS;
    if (isDouble) {
      lastRightDownTime = 0;
      suppressContextMenu = true;
      if (drawnPoints.length >= 2) {
        void cacheDrawnLine();
        stopDrawMode();
      }
      return;
    }
    lastRightDownTime = now;
    addDrawPoint(getCanvasPosition(event));
  }
  function onDrawContextMenu(event) {
    if (!drawModeActive && !suppressContextMenu) return;
    event.preventDefault();
    suppressContextMenu = false;
  }

  viewer.canvas.addEventListener("pointerdown", onDrawPointerDown, { passive: false });
  viewer.canvas.addEventListener("contextmenu", onDrawContextMenu, { passive: false });

  if (drawModeToggle) {
    drawModeToggle.addEventListener("click", () => {
      if (drawModeActive) {
        stopDrawMode();
      } else {
        if (walkModeActive || flyPathActive) setMode("orbit");
        clearDrawnLine();
        drawModeActive = true;
        updateDrawModeButton();
        if (viewer.scene.screenSpaceCameraController) {
          const ssec = viewer.scene.screenSpaceCameraController;
          ssec.enableZoom = true;
          const rightDrag = Cesium.CameraEventType.RIGHT_DRAG;
          ssec.zoomEventTypes = defaultZoomEventTypes.filter(t => t !== rightDrag && t?.eventType !== rightDrag);
        }
      }
    });
  }
  const openDrawnRoute = document.querySelector("#open-drawn-route");
  if (openDrawnRoute) {
    openDrawnRoute.addEventListener("click", async () => {
      try {
        if (!window.showDirectoryPicker) {
          notifyStatus("このブラウザは File System Access API に未対応です。Chrome/Edge で開いてください。", true);
          return;
        }
        const dir = await getDataDirHandle();
        if (!dir) return;
        await window.showOpenFilePicker({
          startIn: dir,
          types: [{ description: "GeoJSON", accept: { "application/geo+json": [".geojson", ".json"] } }],
        });
      } catch (error) {
        if (error && error.name === "AbortError") return;
        notifyStatus(`保存先フォルダを開けませんでした: ${error instanceof Error ? error.message : error}`, true);
      }
    });
  }

  const lastKeyTap = { KeyW: 0, KeyS: 0 };
  function startFlyPathLoopIfNeeded() {
    if (flyPathRafId === null && flyPathCoords && flyPathCoords.length) {
      flyPathActive = true;
      flyPathLastTime = performance.now();
      flyPathRafId = requestAnimationFrame(flyPathLoop);
    }
  }

  window.addEventListener("keydown", event => {
    if (!walkModeActive) return;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target?.tagName)) return;
    const code = event.code;
    if (["KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyE", "Equal", "Minus", "NumpadAdd", "NumpadSubtract", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(code)) {
      event.preventDefault();
      if (code === "Escape") {
        setMode("orbit");
        return;
      }
      if (code === "KeyW" || code === "KeyS") {
        if (flyPath && flyPathCoords) {
          const direction = code === "KeyW" ? 1 : -1;
          const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
          flyPathTargetDistance = direction > 0 ? total : 0;
          startFlyPathLoopIfNeeded();
        } else if (!flyPathActive) {
          const now = performance.now();
          const direction = code === "KeyW" ? 1 : -1;
          if (!event.repeat && now - lastKeyTap[code] < 300) {
            autoMove = autoMove === direction ? 0 : direction;
          }
          if (!event.repeat) lastKeyTap[code] = now;
        }
      }
      walkKeys.add(code);
      if (!flyPathActive && flyPath && flyPathCoords && ["KeyQ", "KeyE", "Equal", "Minus", "NumpadAdd", "NumpadSubtract", "ArrowUp", "ArrowDown"].includes(code)) {
        applyWalkKeys(0.05);
        updateFlyPathCamera(flyPathDistance);
      }
    }
  });

  window.addEventListener("keyup", event => {
    walkKeys.delete(event.code);
  });

  document.querySelector("#layer-panel-toggle").addEventListener("click", event => {
    const panel = document.querySelector(".control-panel");
    const collapsed = panel.classList.toggle("collapsed");
    event.currentTarget.textContent = collapsed ? "+" : "−";
    event.currentTarget.setAttribute("aria-label", collapsed ? "展開" : "最小化");
  });

  document.querySelector("#basemap-toggle").addEventListener("click", event => {
    const control = document.querySelector(".basemap-control");
    const collapsed = control.classList.toggle("collapsed");
    event.currentTarget.textContent = collapsed ? "+" : "−";
    event.currentTarget.setAttribute("aria-label", collapsed ? "展開" : "最小化");
  });

  document.querySelector("#navigation-toggle").addEventListener("click", event => {
    const toolbar = document.querySelector(".navigation-toolbar");
    const collapsed = toolbar.classList.toggle("collapsed");
    event.currentTarget.textContent = collapsed ? "+" : "−";
    event.currentTarget.setAttribute("aria-label", collapsed ? "展開" : "最小化");
  });

  [".control-panel", ".basemap-control", ".navigation-toolbar", ".chat-panel"].forEach(selector => {
    const panel = document.querySelector(selector);
    if (!panel) return;
    ["click", "mousedown", "dblclick", "touchstart", "touchmove", "wheel"].forEach(type => {
      panel.addEventListener(type, event => event.stopPropagation());
    });
  });

  document.querySelector("#apply-inspector").addEventListener("click", async () => {
    try {
      setInspectorStatus("設定を保存しています。");
      await saveInspectorConfig();
      applyInspector(document.querySelector("#inspector-input").value);
      setInspectorStatus("設定を保存しました。");
    } catch (error) {
      setInspectorStatus(`設定を保存できません: ${error instanceof Error ? error.message : error}`, true);
    }
  });

  document.querySelector("#export-inspector")?.addEventListener("click", () => {
    const text = document.querySelector("#inspector-input").value;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentProjectId || "kasugai_canvas"}.kasc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setInspectorStatus(".kasc ファイルをエクスポートしました。");
  });

  // File System Access API: DATAフォルダへの直接保存(Chromium系のみ)。
  // フォルダハンドルは IndexedDB に保持し、次回以降は権限確認のみで再利用する
  // File System Access API: DATAフォルダへの直接保存(Chromium系のみ)。
  // フォルダハンドルは IndexedDB に保持し、次回以降は権限確認のみで再利用する
  const dataDirStore = {
    open() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("kasugai-canvas", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("handles");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },
    async get(key) {
      try {
        const db = await this.open();
        return await new Promise(resolve => {
          const query = db.transaction("handles", "readonly").objectStore("handles").get(key);
          query.onsuccess = () => resolve(query.result || null);
          query.onerror = () => resolve(null);
        });
      } catch (e) { return null; }
    },
    async set(key, value) {
      try {
        const db = await this.open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("handles", "readwrite");
          tx.objectStore("handles").put(value, key);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {}
    },
  };

  let dataDirHandle = null;
  const dataDirKey = () => `dataDir_${currentProjectId || "default"}`;
  const dataDirName = document.querySelector("#inspector-data-dir-name");

  async function updateDataDirLabel() {
    if (!dataDirName) return;
    if (!window.showDirectoryPicker) {
      dataDirName.textContent = "このブラウザは未対応";
      return;
    }
    if (dataDirHandle) { dataDirName.textContent = dataDirHandle.name; return; }
    const saved = await dataDirStore.get(dataDirKey());
    dataDirName.textContent = saved ? `${saved.name} (要権限確認)` : "未設定";
  }

  async function pickDataDir() {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    dataDirHandle = handle;
    await dataDirStore.set(dataDirKey(), handle);
    await updateDataDirLabel();
    return handle;
  }

  async function getDataDirHandle() {
    if (!window.showDirectoryPicker) return null;
    if (dataDirHandle) {
      if (await dataDirHandle.queryPermission({ mode: "readwrite" }) === "granted") return dataDirHandle;
      if (await dataDirHandle.requestPermission({ mode: "readwrite" }) === "granted") return dataDirHandle;
    }
    const saved = await dataDirStore.get(dataDirKey());
    if (saved) {
      if (await saved.queryPermission({ mode: "readwrite" }) === "granted") { dataDirHandle = saved; return saved; }
      if (await saved.requestPermission({ mode: "readwrite" }) === "granted") { dataDirHandle = saved; return saved; }
    }
    return pickDataDir();
  }

  document.querySelector("#inspector-data-dir")?.addEventListener("click", async () => {
    if (!window.showDirectoryPicker) {
      setInspectorStatus("このブラウザは File System Access API に未対応です。Chrome/Edge で開いてください。", true);
      return;
    }
    try {
      await pickDataDir();
      setInspectorStatus("保存先フォルダを設定しました。");
    } catch (error) {
      if (error && error.name === "AbortError") return;
      setInspectorStatus(`フォルダ選択に失敗しました: ${error instanceof Error ? error.message : error}`, true);
    }
  });
  void updateDataDirLabel();



  document.querySelector("#project-select")?.addEventListener("change", async event => {
    currentProjectId = event.target.value;
    const params = new URLSearchParams(window.location.search);
    if (currentProjectId) params.set("project", currentProjectId);
    else params.delete("project");
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
    try {
      setInspectorStatus("プロジェクトを読み込んでいます。");
      await loadInspectorConfig();
    } catch (error) {
      setInspectorStatus(`プロジェクトを読み込めません: ${error instanceof Error ? error.message : error}`, true);
    }
  });

  document.querySelector("#copy-share-url").addEventListener("click", async () => {
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    const lon = Number(c.longitude * 180 / Math.PI).toFixed(6);
    const lat = Number(c.latitude * 180 / Math.PI).toFixed(6);
    const pitch = Number(viewer.camera.pitch * 180 / Math.PI).toFixed(2);
    const heading = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
    const height = Number(c.height).toFixed(1);
    const url = `${window.location.origin}${window.location.pathname}?longitude=${lon}&latitude=${lat}&height=${height}&pitch=${pitch}&heading=${heading}&project=${encodeURIComponent(currentProjectId)}`;
    document.querySelector("#share-url").value = url;
    await navigator.clipboard?.writeText(url);
  });

  document.querySelector("#shutdown-app").addEventListener("click", async () => {
    if (!backendEnabled) return;
    if (!confirm("KASUGAI Canvasを停止しますか？")) return;
    await fetch("/api/shutdown", { method: "POST" });
  });

  document.querySelector("#check-update").addEventListener("click", () => {
    void checkForUpdate();
  });

  document.querySelector("#install-update").addEventListener("click", () => {
    void installUpdate();
  });

  document.querySelector("#auto-update").addEventListener("change", () => {
    void saveUpdateSettings().catch(error => {
      document.querySelector("#version-status").textContent = `自動更新設定の保存エラー: ${error.message}`;
    });
  });

  document.querySelectorAll(".panel-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".panel-tab").forEach(item => item.classList.toggle("active", item === tab));
      document.querySelectorAll(".plugin-panel").forEach(panel => panel.classList.toggle("active", panel.id === tab.dataset.panel));
    });
  });

  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach(item => item.classList.toggle("active", item === tab));
      document.querySelectorAll(".settings-subpanel").forEach(panel => panel.classList.toggle("active", panel.id === tab.dataset.settingsPanel));
    });
  });

  viewer.camera.changed.addEventListener(() => updateCameraInputs());


  const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  clickHandler.setInputAction(movement => {
    if (walkModeActive) return;
    const picked = viewer.scene.pick(movement.position);
    const attr = document.querySelector("#attr-content");
    attr.replaceChildren();
    document.querySelectorAll(".panel-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.panel === "attr-panel"));
    document.querySelectorAll(".plugin-panel").forEach(panel => panel.classList.toggle("active", panel.id === "attr-panel"));

    if (!picked) {
      attr.textContent = "地物を選択すると属性を表示します。";
      return;
    }

    if (picked instanceof Cesium.Cesium3DTileFeature) {
      const table = document.createElement("table");
      table.style.width = "100%";
      table.style.borderCollapse = "collapse";
      table.style.fontSize = "12px";
      const names = picked.getPropertyNames ? picked.getPropertyNames() : [];
      names.forEach(name => {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.textContent = name;
        th.style.textAlign = "left";
        th.style.padding = "3px 6px";
        th.style.borderBottom = "1px solid #cbd9de";
        const td = document.createElement("td");
        const value = picked.getProperty(name);
        td.textContent = value === undefined ? "" : String(value);
        td.style.padding = "3px 6px";
        td.style.borderBottom = "1px solid #cbd9de";
        tr.append(th, td);
        table.append(tr);
      });
      attr.append(table);
      return;
    }

    if (Cesium.GeoJsonPrimitive && picked.parentPrimitive instanceof Cesium.GeoJsonPrimitive && picked.properties) {
      delete attr.dataset.layerId;
      delete attr.dataset.layerTitle;
      const table = document.createElement("table");
      table.style.width = "100%";
      table.style.borderCollapse = "collapse";
      table.style.fontSize = "12px";
      Object.entries(picked.properties).forEach(([key, value]) => {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.textContent = key;
        th.style.textAlign = "left";
        th.style.padding = "3px 6px";
        th.style.borderBottom = "1px solid #cbd9de";
        const td = document.createElement("td");
        td.textContent = value === undefined ? "" : String(value);
        td.style.padding = "3px 6px";
        td.style.borderBottom = "1px solid #cbd9de";
        tr.append(th, td);
        table.append(tr);
      });
      attr.append(table);
      return;
    }

    const entity = picked.id;
    if (entity?.properties) {
      const ds = entity.entityCollection && entity.entityCollection.owner;
      const match = ds ? vectorDataSources.find(item => item.ds === ds) : null;
      if (match) {
        attr.dataset.layerId = match.id;
        attr.dataset.layerTitle = match.title || match.id;
      } else {
        delete attr.dataset.layerId;
        delete attr.dataset.layerTitle;
      }
      const table = document.createElement("table");
      table.style.width = "100%";
      table.style.borderCollapse = "collapse";
      table.style.fontSize = "12px";
      const values = entity.properties.getValue(Cesium.JulianDate.now()) || {};
      Object.entries(values).forEach(([key, value]) => {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.textContent = key;
        th.style.textAlign = "left";
        th.style.padding = "3px 6px";
        th.style.borderBottom = "1px solid #cbd9de";
        const td = document.createElement("td");
        td.textContent = value === undefined ? "" : String(value);
        td.style.padding = "3px 6px";
        td.style.borderBottom = "1px solid #cbd9de";
        tr.append(th, td);
        table.append(tr);
      });
      attr.append(table);
      return;
    }

    attr.textContent = "選択した地物に属性情報がありません。";
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  let lastRightClick = 0;
  viewer.canvas.addEventListener("contextmenu", event => {
    event.preventDefault();
    if (!walkModeActive) return;
    const now = performance.now();
    if (now - lastRightClick < 400) {
      if (flyPath && flyPathCoords) toggleFlyPathDirection(-1);
      else autoMove = autoMove === -1 ? 0 : -1;
    }
    lastRightClick = now;
  });

  viewer.canvas.addEventListener("dblclick", event => {
    if (!walkModeActive) return;
    if (event.button === 0) {
      if (flyPath && flyPathCoords) toggleFlyPathDirection(1);
      else autoMove = autoMove === 1 ? 0 : 1;
    }
  });

  let middlePointerId = null;
  let lastMiddleRotateX = 0;
  const middleRotateSpeed = 0.005;
  viewer.canvas.addEventListener("pointerdown", event => {
    if (event.button !== 1 || walkModeActive) return;
    const pitchDeg = viewer.camera.pitch * 180 / Math.PI;
    if (pitchDeg > -85) return;
    middlePointerId = event.pointerId;
    lastMiddleRotateX = event.clientX;
    viewer.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false, capture: true });
  viewer.canvas.addEventListener("pointermove", event => {
    if (middlePointerId === null || event.pointerId !== middlePointerId) return;
    if ((event.buttons & 4) === 0) { middlePointerId = null; return; }
    const deltaX = event.clientX - lastMiddleRotateX;
    if (deltaX === 0) return;
    lastMiddleRotateX = event.clientX;
    const newHeading = viewer.camera.heading + deltaX * middleRotateSpeed;
    viewer.camera.setView({
      destination: viewer.camera.position,
      orientation: { heading: newHeading, pitch: -Math.PI / 2, roll: 0 },
    });
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false, capture: true });
  viewer.canvas.addEventListener("pointerup", event => {
    if (middlePointerId === null || event.pointerId !== middlePointerId) return;
    middlePointerId = null;
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false, capture: true });
  viewer.canvas.addEventListener("pointercancel", event => {
    if (middlePointerId === null || event.pointerId !== middlePointerId) return;
    middlePointerId = null;
  }, { passive: false, capture: true });

  const walkHelpToggle = document.querySelector("#walk-help-toggle");
  if (walkHelpToggle) {
    walkHelpToggle.addEventListener("click", () => {
      const minimized = walkHelp.classList.toggle("minimized");
      walkHelpToggle.textContent = minimized ? "+" : "−";
      walkHelpToggle.setAttribute("aria-label", minimized ? "展開" : "最小化");
    });
  }

  document.querySelectorAll(".walk-help-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".walk-help-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".walk-help-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`.walk-help-content[data-tab="${tab.dataset.tab}"]`)?.classList.add("active");
      const nextDrawTab = tab.dataset.tab === "draw";
      if (drawModeActive && !nextDrawTab) stopDrawMode();
      drawTabActive = nextDrawTab;
      setMode(drawTabActive ? "orbit" : "walk");
    });
  });
  setupVectorSearch();
  setupChatPanel();
  setupGoogleSettings();
}

// Google APIキー未設定時はチャットパネルを表示しない。設定保存時に再評価する
// 注意: setupChatPanel は window.kasugaiApi 定義前に呼ばれるため localStorage を直接参照する
function updateChatPanelVisibility() {
  const panel = document.querySelector("#chat-panel");
  if (!panel) return;
  let hasKey = false;
  try { hasKey = !!localStorage.getItem("googleApiKey"); } catch (e) {}
  panel.style.display = hasKey ? "" : "none";
}

function setupGoogleSettings() {
  const keyInput = document.querySelector("#google-api-key");
  const modelSelect = document.querySelector("#google-gemini-model");
  const saveButton = document.querySelector("#google-settings-save");
  const status = document.querySelector("#google-settings-status");
  if (!keyInput || !saveButton) return;
  try {
    keyInput.value = localStorage.getItem("googleApiKey") || "";
    const savedModel = localStorage.getItem("googleGeminiModel");
    if (savedModel && modelSelect) modelSelect.value = savedModel;
  } catch (e) {}
  saveButton.addEventListener("click", () => {
    try {
      localStorage.setItem("googleApiKey", keyInput.value.trim());
      if (modelSelect) localStorage.setItem("googleGeminiModel", modelSelect.value);
      updateChatPanelVisibility();
      if (status) status.textContent = "保存しました。";
    } catch (e) {
      if (status) status.textContent = `保存エラー: ${e.message}`;
    }
  });
}

function setupVectorSearch() {
  const vectorLayer = document.querySelector("#vector-layer");
  const vectorAttr = document.querySelector("#vector-attr");
  const vectorValue = document.querySelector("#vector-value");
  const vectorFlyBtn = document.querySelector("#vector-fly-btn");
  const vectorRefreshBtn = document.querySelector("#vector-refresh-btn");
  const vectorSearchText = document.querySelector("#vector-search-text");
  const vectorTextSearchBtn = document.querySelector("#vector-text-search-btn");
  const vectorSearchResults = document.querySelector("#vector-search-results");

  function performVectorTextSearch() {
    try {
      if (!vectorSearchResults || !vectorSearchData) return;
      const q = vectorSearchText ? String(vectorSearchText.value).trim() : "";
      if (!q) { vectorSearchResults.innerHTML = ""; return; }
      const query = q.toLowerCase();
      const targetLayerId = (vectorLayer && vectorLayer.value) ? vectorLayer.value : "__all__";
      const targetAttr = (vectorAttr && vectorAttr.value) ? vectorAttr.value : "__all__";
      const data = vectorSearchData;
      const res = [];
      const layerIds = (targetLayerId === "__all__") ? ["__all__"] : [targetLayerId];
      for (const layerId of layerIds) {
        try {
          const source = (layerId === "__all__") ? data.all : (data.layers && data.layers[layerId]);
          if (!source) continue;
          const attrList = (targetAttr === "__all__") ? (source.attributes || []) : [targetAttr];
          for (const attr of attrList) {
            if (!attr || attr === "__all__") continue;
            const values = (source.valuesByAttr && Array.isArray(source.valuesByAttr[attr])) ? source.valuesByAttr[attr] : [];
            for (const val of values) {
              const haystack = (String(val) + " " + String(attr)).toLowerCase();
              if (haystack.includes(query)) {
                const layerTitle = (layerId === "__all__") ? "全選択" : ((data.layers && data.layers[layerId] && data.layers[layerId].title) || layerId);
                const pos = (source.featureByAttr && source.featureByAttr[attr] && source.featureByAttr[attr][val]) || null;
                res.push({ layerId: (layerId === "__all__") ? "__all__" : layerId, layerTitle, attr, value: val, lat: pos ? pos.lat : null, lng: pos ? pos.lng : null });
              }
            }
          }
        } catch (e) {}
      }
      if (!res.length) {
        vectorSearchResults.innerHTML = '<li style="padding:4px;color:#71818d;">該当なし</li>';
        return;
      }
      vectorSearchResults.innerHTML = res.slice(0, 50).map((r, i) =>
        '<li class="vector-search-result" data-idx="' + i + '" style="padding:4px;border-bottom:1px solid #e4ecef;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
        escapeHtml(r.layerTitle) + ' / ' + escapeHtml(r.attr) + ' / ' + escapeHtml(r.value) +
        '</li>'
      ).join("");
      vectorSearchResults._resultData = res;
    } catch (e) { console.error("vector text search error", e); }
  }

  if (vectorSearchResults) {
    vectorSearchResults.addEventListener("click", (ev) => {
      try {
        const li = ev.target.closest && ev.target.closest("li[data-idx]");
        if (!li || !vectorSearchResults._resultData) return;
        const r = vectorSearchResults._resultData[Number(li.getAttribute("data-idx"))];
        if (!r) return;
        if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
          flyToFeature(r.lat, r.lng);
        }
      } catch (e) { console.error("vector result click error", e); }
    });
  }

  if (vectorTextSearchBtn) vectorTextSearchBtn.addEventListener("click", performVectorTextSearch);
  if (vectorSearchText) vectorSearchText.addEventListener("keydown", (ev) => { if (ev.key === "Enter") performVectorTextSearch(); });

  if (vectorLayer) {
    vectorLayer.addEventListener("change", () => {
      try {
        const source = getCurrentVectorSource();
        if (vectorAttr) {
          if (source && source.attributes && source.attributes.length) {
            vectorAttr.innerHTML = '<option value="__all__">全選択</option>' + source.attributes.map(a => '<option value="' + escapeHtml(a) + '">' + escapeHtml(a) + '</option>').join("");
            vectorAttr.disabled = false;
          } else {
            vectorAttr.innerHTML = '<option value="__all__">全選択</option>';
            vectorAttr.disabled = true;
          }
          vectorAttr.value = "__all__";
        }
        if (vectorValue) {
          vectorValue.innerHTML = '<option value="">値を選択</option>';
          vectorValue.disabled = true;
        }
        if (vectorFlyBtn) vectorFlyBtn.disabled = true;
        if (vectorAttrWidget && vectorAttrWidget.classList.contains("visible")) {
          buildVectorAttrWidgetRows();
          renderVectorAttrWidget(vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : "");
        }
      } catch (e) { console.error("vector layer change error", e); }
    });
  }

  if (vectorAttr) {
    vectorAttr.addEventListener("change", () => {
      try {
        const source = getCurrentVectorSource();
        const attr = vectorAttr.value;
        if (vectorValue) {
          if (source && source.valuesByAttr && attr && attr !== "__all__" && Array.isArray(source.valuesByAttr[attr])) {
            vectorValue.innerHTML = '<option value="">値を選択</option>' + source.valuesByAttr[attr].map(v => '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>').join("");
            vectorValue.disabled = false;
          } else {
            vectorValue.innerHTML = '<option value="">値を選択</option>';
            vectorValue.disabled = true;
          }
          vectorValue.value = "";
          if (vectorFlyBtn) vectorFlyBtn.disabled = true;
        }
      } catch (e) { console.error("vector attr change error", e); }
    });
  }

  if (vectorValue) {
    vectorValue.addEventListener("change", () => {
      if (vectorFlyBtn) vectorFlyBtn.disabled = !vectorValue.value;
    });
  }

  if (vectorFlyBtn) {
    vectorFlyBtn.addEventListener("click", () => {
      try {
        if (!vectorLayer || !vectorAttr || !vectorValue || !vectorAttr.value || !vectorValue.value) return;
        const source = getCurrentVectorSource();
        const pos = (source && source.featureByAttr && source.featureByAttr[vectorAttr.value] && source.featureByAttr[vectorAttr.value][vectorValue.value]) || null;
        if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
          flyToFeature(pos.lat, pos.lng);
        }
      } catch (e) { console.error("vector fly error", e); }
    });
  }

  if (vectorRefreshBtn) {
    vectorRefreshBtn.addEventListener("click", () => {
      try {
        const status = document.querySelector("#vector-search-status");
        if (status) status.textContent = "読み込み中...";
        buildVectorSearchIndex();
        updateVectorSearchUI();
      } catch (e) { console.error("vector refresh error", e); }
    });
  }

  const vectorAttrListBtn = document.querySelector("#vector-attr-list-btn");
  const vectorAttrWidget = document.querySelector("#vector-attr-widget");
  const vectorAttrWidgetClose = document.querySelector(".vector-attr-widget-close");
  const vectorAttrWidgetResizer = document.querySelector(".vector-attr-widget-resizer");
  const vectorAttrWidgetSearch = document.querySelector("#vector-attr-widget-search");
  const vectorAttrWidgetLayerSelect = document.querySelector("#vector-attr-widget-layer");
  const vectorAttrWidgetHead = document.querySelector("#vector-attr-widget-head");
  const vectorAttrWidgetList = document.querySelector("#vector-attr-widget-list");
  const vectorAttrWidgetCount = document.querySelector("#vector-attr-widget-count");
  const vectorAttrWidgetTitle = document.querySelector(".vector-attr-widget-title");
  let vectorAttrWidgetRows = [];
  let vectorAttrWidgetAttributes = [];
  let vectorAttrWidgetSort = { column: -1, order: 1 };

  function getVectorDataSourceById(layerId) {
    if (layerId === "__all__") return null;
    return vectorDataSources.find(item => item.id === layerId) || null;
  }

  function buildVectorAttrWidgetRows() {
    vectorAttrWidgetRows = [];
    vectorAttrWidgetAttributes = [];
    vectorAttrWidgetSort = { column: -1, order: 1 };
    const layerId = (vectorLayer && vectorLayer.value) ? vectorLayer.value : "__all__";
    const dsItem = getVectorDataSourceById(layerId);
    const source = getCurrentVectorSource();
    if (!dsItem || !source || !source.attributes || !source.attributes.length) return;
    const time = viewer.clock && viewer.clock.currentTime;
    vectorAttrWidgetAttributes = source.attributes.slice();
    const maxRows = 1000;
    let count = 0;
    for (const entity of dsItem.ds.entities.values) {
      if (count++ >= maxRows) break;
      const props = (entity.properties && entity.properties.getValue) ? entity.properties.getValue(time) : (entity.properties || {});
      const row = [];
      for (const attr of vectorAttrWidgetAttributes) {
        const raw = props ? props[attr] : undefined;
        const val = (raw == null) ? "" : (typeof raw === "object" ? JSON.stringify(raw) : String(raw));
        row.push(val);
      }
      const cartesian = getEntityPosition(entity);
      const deg = cartesian ? cartesianToDegrees(cartesian) : null;
      vectorAttrWidgetRows.push({
        values: row,
        lat: deg && Number.isFinite(deg.lat) ? deg.lat : null,
        lng: deg && Number.isFinite(deg.lng) ? deg.lng : null,
      });
    }
  }

  function renderVectorAttrWidget(filter = "") {
    try {
      if (!vectorAttrWidgetList || !vectorAttrWidgetCount || !vectorAttrWidgetTitle) return;
      const query = String(filter).toLowerCase().trim();
      let matched = query ? vectorAttrWidgetRows.filter(row => row.values.some(val => String(val).toLowerCase().includes(query))) : [...vectorAttrWidgetRows];
      if (vectorAttrWidgetSort.column >= 0 && vectorAttrWidgetSort.column < vectorAttrWidgetAttributes.length) {
        const col = vectorAttrWidgetSort.column;
        const order = vectorAttrWidgetSort.order;
        matched.sort((a, b) => {
          const left = a.values[col] || "";
          const right = b.values[col] || "";
          const cmp = String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
          return cmp * order;
        });
      }
      const displayRows = matched.slice(0, 1000);
      const layerTitle = (vectorLayer && vectorLayer.value !== "__all__" && vectorSearchData && vectorSearchData.layers && vectorSearchData.layers[vectorLayer.value] && vectorSearchData.layers[vectorLayer.value].title) ? vectorSearchData.layers[vectorLayer.value].title : "全選択";
      vectorAttrWidgetTitle.textContent = "属性・値一覧" + (layerTitle ? " — " + layerTitle : "");
      if (!vectorAttrWidgetAttributes.length) {
        if (vectorAttrWidgetHead) vectorAttrWidgetHead.innerHTML = "";
        vectorAttrWidgetList.innerHTML = '<tr><td style="padding:12px 14px;color:#71818d;">レイヤを選択してください</td></tr>';
        vectorAttrWidgetCount.textContent = "0 件 / 0 属性";
        return;
      }
      if (vectorAttrWidgetHead) {
        vectorAttrWidgetHead.innerHTML = '<tr>' + vectorAttrWidgetAttributes.map((attr, idx) => {
          const active = vectorAttrWidgetSort.column === idx;
          const marker = active ? (vectorAttrWidgetSort.order > 0 ? ' ▲' : ' ▼') : '';
          return '<th data-idx="' + idx + '" title="クリックで並び替え"' + (active ? ' class="sorted"' : '') + '>' + escapeHtml(attr) + '<span class="sort-marker">' + marker + '</span></th>';
        }).join("") + '</tr>';
      }
      if (!displayRows.length) {
        vectorAttrWidgetList.innerHTML = '<tr><td colspan="' + vectorAttrWidgetAttributes.length + '" style="padding:12px 14px;color:#71818d;">該当する地物がありません</td></tr>';
        vectorAttrWidgetCount.textContent = (query ? "0" : String(vectorAttrWidgetRows.length)) + " 件 / " + vectorAttrWidgetAttributes.length + " 属性";
        return;
      }
      vectorAttrWidgetList.innerHTML = displayRows.map(row => {
        const flyable = Number.isFinite(row.lat) && Number.isFinite(row.lng);
        const dataAttrs = flyable ? 'data-lat="' + row.lat + '" data-lng="' + row.lng + '"' : '';
        const style = flyable ? 'style="cursor:pointer;"' : '';
        return '<tr class="vector-attr-widget-row" ' + dataAttrs + ' ' + style + ' title="' + (flyable ? 'クリックで移動' : '') + '">' +
          row.values.map(val => '<td class="vector-attr-widget-cell" title="' + escapeHtml(val) + '">' + escapeHtml(val) + '</td>').join("") +
          '</tr>';
      }).join("");
      const suffix = (matched.length > displayRows.length) ? " （表示上限 " + displayRows.length + " 件）" : "";
      vectorAttrWidgetCount.textContent = String(matched.length) + " 件 / " + vectorAttrWidgetAttributes.length + " 属性" + suffix;
    } catch (e) { console.error("vector attr widget render error", e); }
  }

  function updateVectorAttrWidgetLayerOptions(layerId) {
    if (!vectorAttrWidgetLayerSelect) return;
    const opts = (vectorSearchData && vectorSearchData.layerOptions) || [];
    let html = '<option value="">レイヤを選択</option>';
    for (const o of opts) {
      html += '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(o.title || o.id) + '</option>';
    }
    vectorAttrWidgetLayerSelect.innerHTML = html;
    const hasLayer = layerId && layerId !== "__all__" && opts.some(o => o.id === layerId);
    vectorAttrWidgetLayerSelect.value = hasLayer ? layerId : "";
  }

  function openVectorAttrWidget(layerId = null) {
    if (!vectorAttrWidget) return;
    if (vectorLayer) {
      if (layerId && layerId !== "__all__" && [...vectorLayer.options].some(option => option.value === layerId)) {
        vectorLayer.value = layerId;
      } else if (!layerId || layerId === "__all__") {
        vectorLayer.value = "__all__";
      }
    }
    updateVectorAttrWidgetLayerOptions(layerId || (vectorLayer ? vectorLayer.value : null));
    buildVectorAttrWidgetRows();
    renderVectorAttrWidget(vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : "");
    vectorAttrWidget.classList.add("visible");
    if (vectorAttrWidgetSearch) vectorAttrWidgetSearch.focus();
  }

  function closeVectorAttrWidget() {
    if (vectorAttrWidget) vectorAttrWidget.classList.remove("visible");
  }

  if (vectorAttrListBtn) vectorAttrListBtn.addEventListener("click", () => openVectorAttrWidget(vectorLayer ? vectorLayer.value : null));
  const attrVectorAttrListBtn = document.querySelector("#attr-vector-attr-list-btn");
  const attrContent = document.querySelector("#attr-content");
  if (attrVectorAttrListBtn) {
    attrVectorAttrListBtn.addEventListener("click", () => {
      const layerId = (attrContent && attrContent.dataset.layerId) ? attrContent.dataset.layerId : (vectorLayer ? vectorLayer.value : null);
      openVectorAttrWidget(layerId);
    });
  }
  if (vectorAttrWidgetClose) vectorAttrWidgetClose.addEventListener("click", closeVectorAttrWidget);
  if (vectorAttrWidgetSearch) {
    vectorAttrWidgetSearch.addEventListener("input", () => renderVectorAttrWidget(vectorAttrWidgetSearch.value));
    vectorAttrWidgetSearch.addEventListener("keydown", (ev) => { if (ev.key === "Enter") renderVectorAttrWidget(vectorAttrWidgetSearch.value); });
  }

  if (vectorAttrWidgetLayerSelect) {
    vectorAttrWidgetLayerSelect.addEventListener("change", () => {
      try { openVectorAttrWidget(vectorAttrWidgetLayerSelect.value); } catch (e) { console.error("vector attr layer change error", e); }
    });
  }

  if (vectorAttrWidgetList) {
    vectorAttrWidgetList.addEventListener("click", (ev) => {
      try {
        const tr = ev.target.closest("tr");
        if (!tr) return;
        const latAttr = tr.getAttribute("data-lat");
        const lngAttr = tr.getAttribute("data-lng");
        if (latAttr == null || lngAttr == null) return;
        const lat = Number(latAttr);
        const lng = Number(lngAttr);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          flyToFeature(lat, lng);
        }
      } catch (e) { console.error("vector attr row click error", e); }
    });
  }

  if (vectorAttrWidgetHead) {
    vectorAttrWidgetHead.addEventListener("click", (ev) => {
      try {
        const th = ev.target.closest("th");
        if (!th || !th.hasAttribute("data-idx")) return;
        const idx = Number(th.getAttribute("data-idx"));
        if (vectorAttrWidgetSort.column === idx) {
          vectorAttrWidgetSort.order *= -1;
        } else {
          vectorAttrWidgetSort = { column: idx, order: 1 };
        }
        renderVectorAttrWidget(vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : "");
      } catch (e) { console.error("vector attr head click error", e); }
    });
  }

  if (vectorAttrWidgetResizer && vectorAttrWidget) {
    let startY = 0;
    let startHeight = 0;
    let isResizing = false;

    function onMouseMove(ev) {
      if (!isResizing) return;
      ev.preventDefault();
      const delta = startY - ev.clientY;
      const nextHeight = startHeight + delta;
      const maxHeight = Math.min(window.innerHeight * 0.9, 1200);
      const clamped = Math.max(120, Math.min(maxHeight, nextHeight));
      vectorAttrWidget.style.height = clamped + "px";
    }

    function onMouseUp() {
      isResizing = false;
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (window.getSelection) window.getSelection().removeAllRanges();
    }

    vectorAttrWidgetResizer.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      isResizing = true;
      startY = ev.clientY;
      startHeight = vectorAttrWidget.offsetHeight;
      document.body.style.cursor = "ns-resize";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });
  }

  window.vectorAttrWidget = { open: openVectorAttrWidget, close: closeVectorAttrWidget };
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const leftPart = Number.isFinite(a[index]) ? a[index] : 0;
    const rightPart = Number.isFinite(b[index]) ? b[index] : 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

async function loadUpdateInfo() {
  const current = document.querySelector("#current-version");
  if (!backendEnabled) {
    if (current) current.textContent = "-";
    return;
  }
  try {
    const [healthResponse, settingsResponse] = await Promise.all([
      fetch("/health"),
      fetch("/api/update/settings"),
    ]);
    if (!healthResponse.ok || !settingsResponse.ok) throw new Error("更新情報を取得できませんでした");
    const health = await healthResponse.json();
    const settings = await settingsResponse.json();
    current.textContent = health.version || "-";
    if (Number.isInteger(health.port)) document.querySelector("#current-port").value = health.port;
    document.querySelector("#auto-update").checked = settings.autoUpdate !== false;
    await checkForUpdate(health.version);
  } catch (error) {
    current.textContent = "-";
    document.querySelector("#version-status").textContent = `更新情報を取得できません: ${error.message}`;
  }
}

async function checkForUpdate(currentVersion = document.querySelector("#current-version").textContent) {
  const status = document.querySelector("#version-status");
  const updateStatus = document.querySelector("#update-status");
  const installButton = document.querySelector("#install-update");
  status.textContent = "最新バージョンを確認中...";
  installButton.hidden = true;
  try {
    const response = await fetch("/api/update/latest");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const latestVersion = data.version || "-";
    document.querySelector("#latest-version").textContent = latestVersion;
    const comparison = compareVersions(currentVersion, latestVersion);
    if (comparison < 0) {
      updateStatus.textContent = "（新しいバージョンがあります）";
      status.textContent = "更新が利用可能です";
      installButton.hidden = false;
      if (document.querySelector("#auto-update").checked) await installUpdate(latestVersion, true);
    } else if (comparison === 0) {
      updateStatus.textContent = "（最新です）";
      status.textContent = "";
    } else {
      updateStatus.textContent = "（現在のバージョンの方が新しいです）";
      status.textContent = "";
    }
  } catch (error) {
    document.querySelector("#latest-version").textContent = "-";
    status.textContent = `更新確認エラー: ${error.message}`;
  }
}

async function installUpdate(latestVersion = document.querySelector("#latest-version").textContent, silent = false) {
  if (!silent && !confirm(`新しいバージョン ${latestVersion} が利用可能です。ダウンロードしてインストールしますか？`)) {
    document.querySelector("#version-status").textContent = "アップデートをキャンセルしました";
    return;
  }
  const button = document.querySelector("#install-update");
  button.disabled = true;
  document.querySelector("#version-status").textContent = "最新版をダウンロードして自動インストールを準備中...";
  try {
    const response = await fetch("/api/update/install", { method: "POST" });
    const body = await response.text();
    let data;
    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      data = {};
    }
    if (!response.ok) throw new Error(data.error || body || `HTTP ${response.status}`);
    document.querySelector("#version-status").textContent = data.message || "アップデートを開始しました";
    void reloadAfterRestart();
  } catch (error) {
    document.querySelector("#version-status").textContent = `自動インストールエラー: ${error.message}`;
    button.disabled = false;
  }
}

async function reloadAfterRestart() {
  const status = document.querySelector("#version-status");
  const ping = async () => {
    try {
      const response = await fetch("/health", { cache: "no-store" });
      return response.ok;
    } catch {
      return false;
    }
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  status.textContent = "更新中... サーバーの再起動を待っています";
  // 旧サーバーの停止を待つ（早すぎるリロードを防ぐ）
  for (let i = 0; i < 60 && await ping(); i++) await sleep(1000);
  // 新サーバーの起動を待ってリロード（カメラ位置はURLハッシュから復元される）
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await ping()) {
      window.location.reload();
      return;
    }
  }
  status.textContent = "再起動を確認できませんでした。手動でページを再読み込みしてください。";
}

async function saveUpdateSettings() {
  if (!backendEnabled) return;
  const autoUpdate = document.querySelector("#auto-update").checked;
  const response = await fetch("/api/update/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoUpdate }),
  });
  if (!response.ok) throw new Error(await response.text());
  document.querySelector("#version-status").textContent = "自動更新設定を保存しました";
}

const defaultConfig = `base: 地理院タイル 標準地図 | https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png | 出典：国土地理院
3dtiles: 東京都/千代田区（建築物LOD1） | https://assets.cms.plateau.reearth.io/assets/0e/e5948a-e95c-4e31-be85-1f8c066ed996/13101_chiyoda-ku_pref_2023_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod1/tileset.json
cam:東京駅|35.653108|139.761449|height=2200.6|pitch=-30|heading=348.5`;

document.querySelector("#current-port").value = window.location.port || (window.location.protocol === "https:" ? "443" : "8510");
setupEvents();

viewer.camera.moveEnd.addEventListener(() => {
  const ssec = viewer.scene.screenSpaceCameraController;
  if (!ssec.enableTilt) return;
  const pitchDeg = viewer.camera.pitch * 180 / Math.PI;
  if (pitchDeg < -85) {
    viewer.camera.setView({
      destination: viewer.camera.position,
      orientation: { heading: viewer.camera.heading, pitch: -84.99 * Math.PI / 180, roll: 0 }
    });
  }
});

setupThreeJs();
applyInspector(defaultConfig);
updateEffectSettings();
const urlCamera = parseUrlCamera(initialCameraSource);

function parseUrlCamera(source = window.location.search + window.location.hash) {
  const hashIndex = source.indexOf("#");
  const searchPart = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const hashPart = hashIndex >= 0 ? source.slice(hashIndex + 1) : "";
  const searchParams = new URLSearchParams(searchPart.startsWith("?") ? searchPart.slice(1) : searchPart);
  const hashParams = new URLSearchParams(hashPart);
  const getNumber = (name, fallback) => {
    const raw = hashParams.get(name) ?? searchParams.get(name);
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    latitude: getNumber("latitude"),
    longitude: getNumber("longitude"),
    height: getNumber("height", DEFAULT_VIEW.height),
    pitch: getNumber("pitch", DEFAULT_VIEW.pitch),
    heading: getNumber("heading", DEFAULT_VIEW.heading),
  };
}

async function resolveInitialCamera() {
  if (Number.isFinite(urlCamera.latitude) && Number.isFinite(urlCamera.longitude)) {
    return urlCamera;
  }
  if (cameraPresets.length) {
    return cameraPresets[0];
  }
  try {
    const response = await fetch("https://ipapi.co/json/");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude, height: 10000, pitch: DEFAULT_VIEW.pitch, heading: 0 };
    }
  } catch (error) {
    console.warn("IP geolocation failed", error);
  }
  return DEFAULT_VIEW;
}

function applyUrlCamera() {
  const camera = parseUrlCamera();
  if (Number.isFinite(camera.latitude) && Number.isFinite(camera.longitude)) {
    flyTo(camera);
  }
}

// AI・外部連携用の操作API。チャットパネルや将来的なエージェント連携から地図を操作する入口
window.kasugaiApi = {
  flyTo,
  getCamera() {
    const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    if (!carto) return null;
    return {
      latitude: Cesium.Math.toDegrees(carto.latitude),
      longitude: Cesium.Math.toDegrees(carto.longitude),
      height: carto.height,
      heading: Cesium.Math.toDegrees(viewer.camera.heading),
      pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
    };
  },
  listLayers() {
    return getOrderedLayerItems().map(layer => ({ id: layer.id, title: layer.title, group: layer.group || "", visible: !!layer.visible, type: layer.type }));
  },
  setLayerVisible(idOrTitle, visible) {
    const layer = getOrderedLayerItems().find(item => item.id === idOrTitle || item.title === idOrTitle);
    if (!layer) return false;
    layer.visible = !!visible;
    if (layer.visible && layer.exclusiveGroup) {
      getOrderedLayerItems().forEach(other => {
        if (other !== layer && other.group === layer.group && other.exclusiveGroup) other.visible = false;
      });
    }
    renderLayerList();
    refreshLayers();
    return true;
  },
  listBasemaps() {
    return basemaps.map(basemap => ({ id: basemap.id, title: basemap.title, selected: basemap === selectedBasemap }));
  },
  setBasemap(idOrTitle) {
    const basemap = basemaps.find(item => item.id === idOrTitle || item.title === idOrTitle);
    if (!basemap) return false;
    selectedBasemap = basemap;
    const select = document.querySelector("#basemap-select");
    if (select) select.value = basemap.id;
    updateMapAttribution();
    refreshLayers();
    return true;
  },
  async searchLocation(query) {
    const response = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`, { mode: "cors" });
    if (!response.ok) throw new Error(`検索に失敗しました (${response.status})`);
    const data = await response.json();
    return data.slice(0, 5).map(item => ({
      title: item.properties?.title || "",
      address: item.properties?.address || "",
      latitude: Number(item.geometry?.coordinates?.[1]),
      longitude: Number(item.geometry?.coordinates?.[0]),
    })).filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  },
  flyToFeature,
  listCameraPresets() {
    return cameraPresets.map(preset => preset.title);
  },
  flyToPreset(name) {
    const preset = cameraPresets.find(item => item.title === name) || cameraPresets.find(item => item.title.includes(name));
    if (!preset) return false;
    flyTo(preset);
    return true;
  },
  setTerrain(enabled) {
    terrainEnabled = !!enabled;
    const toggle = document.querySelector("#terrain-toggle");
    if (toggle) toggle.checked = terrainEnabled;
    refreshLayers();
    return true;
  },
  setEffect(name, enabled) {
    const selectors = {
      lighting: "#effect-terrain-lighting",
      translucency: "#effect-translucency",
      fog: "#effect-fog",
      atmosphere: "#effect-sky-atmosphere",
      shadows: "#effect-shadows",
      depthTest: "#effect-depth-test",
    };
    const input = document.querySelector(selectors[name]);
    if (!input) return false;
    input.checked = !!enabled;
    updateEffectSettings();
    return true;
  },
  setUnderground({ transparency, dive } = {}) {
    if (Number.isFinite(transparency)) {
      undergroundTransparency = Math.max(0, Math.min(1, transparency));
      const slider = document.querySelector("#underground-transparency");
      if (slider) slider.value = String(undergroundTransparency);
      const label = document.querySelector("#underground-transparency-value");
      if (label) label.textContent = `${Math.round(undergroundTransparency * 100)}%`;
    }
    if (typeof dive === "boolean") {
      undergroundDiveEnabled = dive;
      const toggle = document.querySelector("#underground-dive-toggle");
      if (toggle) toggle.checked = dive;
    }
    updateUndergroundView();
    updateEffectSettings();
    return true;
  },
  setClip(type) {
    if (!uiHooks.applyClip) return false;
    uiHooks.applyClip(type);
    return true;
  },
  listFlyPaths() {
    return flyPaths.map((path, index) => ({ index, title: path.title }));
  },
  playFlyPath(nameOrIndex) {
    const index = Number.isInteger(nameOrIndex) ? nameOrIndex : flyPaths.findIndex(path => path.title === nameOrIndex || path.title.includes(nameOrIndex));
    if (index < 0 || index >= flyPaths.length) return false;
    const select = document.querySelector("#fly-path-select");
    if (select) select.value = String(index);
    if (walkModeActive && uiHooks.startFlyPath) {
      uiHooks.stopFlyPath?.();
      void uiHooks.startFlyPath(index);
    } else if (uiHooks.setMode) {
      uiHooks.setMode("walk");
    }
    return true;
  },
  stopFly() {
    if (uiHooks.setMode) uiHooks.setMode("orbit");
    return true;
  },
  listProjects() {
    const select = document.querySelector("#project-select");
    if (!select) return [];
    return [...select.options].map(option => ({ id: option.value, title: option.textContent, selected: option.value === currentProjectId }));
  },
  switchProject(projectId) {
    const select = document.querySelector("#project-select");
    if (!select) return false;
    const exists = [...select.options].some(option => option.value === projectId);
    if (!exists) return false;
    select.value = projectId;
    select.dispatchEvent(new Event("change"));
    return true;
  },
  applyInspector(text) {
    const input = document.querySelector("#inspector-input");
    if (!input || typeof text !== "string") return false;
    input.value = text;
    document.querySelector("#apply-inspector")?.click();
    return true;
  },
  exportInspector() {
    const button = document.querySelector("#export-inspector");
    if (!button) return false;
    button.click();
    return true;
  },
  checkUpdate() {
    document.querySelector("#check-update")?.click();
    return true;
  },
  installUpdate() {
    const button = document.querySelector("#install-update");
    if (!button || button.hidden) return false;
    button.click();
    return true;
  },
  shutdownApp() {
    const button = document.querySelector("#shutdown-app");
    if (!button) return false;
    button.click();
    return true;
  },
  toggleDrawMode() {
    const button = document.querySelector("#draw-mode-toggle");
    if (!button) return { ok: false };
    button.click();
    return { ok: true, drawModeActive };
  },
  vectorSearch(query) {
    if (!vectorSearchData || !query) return [];
    const q = String(query).toLowerCase();
    const results = [];
    const source = vectorSearchData.all;
    if (!source) return results;
    for (const attr of source.attributes || []) {
      for (const val of source.valuesByAttr[attr] || []) {
        if (!(String(val) + " " + String(attr)).toLowerCase().includes(q)) continue;
        const pos = source.featureByAttr?.[attr]?.[val] || null;
        results.push({ attr, value: val, latitude: pos?.lat ?? null, longitude: pos?.lng ?? null });
        if (results.length >= 20) return results;
      }
    }
    return results;
  },
  getShareUrl() {
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    if (!c) return null;
    const lon = Number(c.longitude * 180 / Math.PI).toFixed(6);
    const lat = Number(c.latitude * 180 / Math.PI).toFixed(6);
    const pitch = Number(viewer.camera.pitch * 180 / Math.PI).toFixed(2);
    const heading = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
    const height = Number(c.height).toFixed(1);
    return `${window.location.origin}${window.location.pathname}?longitude=${lon}&latitude=${lat}&height=${height}&pitch=${pitch}&heading=${heading}&project=${encodeURIComponent(currentProjectId)}`;
  },
  addGeoJsonLayer(title, url) {
    if (!title || !url) return false;
    const input = document.querySelector("#inspector-input");
    if (!input) return false;
    input.value = input.value.replace(/\s*$/, "") + `\ngeojson:${title}|${url}\n`;
    document.querySelector("#apply-inspector")?.click();
    return true;
  },
  getGoogleApiKey() {
    try { return localStorage.getItem("googleApiKey") || ""; } catch (e) { return ""; }
  },
  getGeminiModel() {
    try { return localStorage.getItem("googleGeminiModel") || "gemini-3.1-flash-lite"; } catch (e) { return "gemini-3.1-flash-lite"; }
  },
};

// ローカルコマンド: AI接続前でも操作APIの動作確認ができる
async function handleLocalChatCommand(text) {
  const [command, ...args] = text.trim().split(/\s+/);
  if (command === "/fly") {
    const [lat, lng, height] = args.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "使い方: /fly 緯度 経度 [高さm]";
    flyTo({ latitude: lat, longitude: lng, height: Number.isFinite(height) ? height : undefined });
    return `(${lat}, ${lng}) へ移動します。`;
  }
  if (command === "/layers") {
    const items = window.kasugaiApi.listLayers();
    if (!items.length) return "レイヤがありません。";
    return items.map(layer => `${layer.visible ? "●" : "○"} ${layer.title}`).join("\n");
  }
  if (command === "/layer") {
    const onoff = args[0];
    const name = args.slice(1).join(" ");
    if (!/^(on|off)$/i.test(onoff) || !name) return "使い方: /layer on|off レイヤ名";
    const on = /^on$/i.test(onoff);
    const ok = window.kasugaiApi.setLayerVisible(name, on);
    return ok ? `「${name}」を${on ? "表示" : "非表示"}にしました。` : `「${name}」というレイヤが見つかりません。`;
  }
  if (command === "/basemaps") {
    const items = window.kasugaiApi.listBasemaps();
    if (!items.length) return "ベースマップがありません。";
    return items.map(basemap => `${basemap.selected ? "●" : "○"} ${basemap.title}`).join("\n");
  }
  if (command === "/basemap") {
    const name = args.join(" ");
    if (!name) return "使い方: /basemap ベースマップ名";
    const ok = window.kasugaiApi.setBasemap(name);
    return ok ? `ベースマップを「${name}」に切り替えました。` : `「${name}」というベースマップが見つかりません。`;
  }
  if (command === "/search") {
    const query = args.join(" ");
    if (!query) return "使い方: /search 住所・施設名";
    const results = await window.kasugaiApi.searchLocation(query);
    if (!results.length) return "該当する結果がありません。";
    const first = results[0];
    flyToFeature(first.latitude, first.longitude);
    return `候補:\n${results.map(item => `- ${item.title} (${item.address})`).join("\n")}\n先頭の候補へ移動しました。`;
  }
  if (command === "/camera") {
    const camera = window.kasugaiApi.getCamera();
    if (!camera) return "カメラ位置を取得できません。";
    return `緯度 ${camera.latitude.toFixed(5)} / 経度 ${camera.longitude.toFixed(5)} / 高さ ${camera.height.toFixed(0)}m\nheading ${camera.heading.toFixed(1)}° / pitch ${camera.pitch.toFixed(1)}°`;
  }
  return null;
}

// Gemini へ公開するツール定義。実行は window.kasugaiApi に委譲する
const CHAT_TOOLS = [{
  functionDeclarations: [
    {
      name: "flyTo",
      description: "地図カメラを指定座標へ移動する。height/pitch省略時はドローン視点(対象地上+200m・ピッチ-30°)になる",
      parameters: {
        type: "OBJECT",
        properties: {
          latitude: { type: "NUMBER", description: "緯度(度)" },
          longitude: { type: "NUMBER", description: "経度(度)" },
          height: { type: "NUMBER", description: "カメラ高さ(m)。省略時は対象地上+200m" },
          pitch: { type: "NUMBER", description: "ピッチ(度)。省略時は-30(ドローン視点)。-90で真上から俯瞰" },
          heading: { type: "NUMBER", description: "方位(度)" },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "setLayerVisible",
      description: "レイヤ名を指定して表示/非表示を切り替える",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "レイヤ名(listLayersで確認)" },
          visible: { type: "BOOLEAN", description: "trueで表示、falseで非表示" },
        },
        required: ["name", "visible"],
      },
    },
    {
      name: "listLayers",
      description: "登録されているレイヤ一覧(名前・表示状態)を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "getCamera",
      description: "現在のカメラ位置(緯度・経度・高さ・方位・ピッチ)を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "listBasemaps",
      description: "選択可能なベースマップ(背景地図)の一覧と現在の選択を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "setBasemap",
      description: "ベースマップ(背景地図)を名前またはIDで切り替える",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "ベースマップ名またはID(listBasemapsで確認)" },
        },
        required: ["name"],
      },
    },
    {
      name: "searchLocation",
      description: "住所・地名・施設名を検索し、候補(名称・住所・緯度経度)を返す。検索後はflyToまたはflyToFeatureで移動できる",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "検索語(例: 春日井市役所)" },
        },
        required: ["query"],
      },
    },
    {
      name: "flyToFeature",
      description: "指定座標が画面中央に来るようにカメラを後退補正して移動する。地点・地物を見せたい場合はこちら。height/pitch省略時はドローン視点(対象地上+200m・ピッチ-30°)になる",
      parameters: {
        type: "OBJECT",
        properties: {
          latitude: { type: "NUMBER", description: "緯度(度)" },
          longitude: { type: "NUMBER", description: "経度(度)" },
          height: { type: "NUMBER", description: "カメラ高さ(m)。省略時は対象地上+200m" },
          pitch: { type: "NUMBER", description: "ピッチ(度)。省略時は-30(ドローン視点)" },
          heading: { type: "NUMBER", description: "方位(度)" },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "flyToPreset",
      description: "登録済みのカメラプリセット名を指定して移動する。listCameraPresetsで一覧を確認できる",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "プリセット名" },
        },
        required: ["name"],
      },
    },
    {
      name: "listCameraPresets",
      description: "登録済みカメラプリセット名の一覧を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "setTerrain",
      description: "地形(DEM)表示のON/OFF",
      parameters: {
        type: "OBJECT",
        properties: {
          enabled: { type: "BOOLEAN" },
        },
        required: ["enabled"],
      },
    },
    {
      name: "setEffect",
      description: "表示効果のON/OFF。nameは lighting(地形照明) translucency(地下透過) fog(霧) atmosphere(大気) shadows(影) depthTest(地形深度テスト) のいずれか",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          enabled: { type: "BOOLEAN" },
        },
        required: ["name", "enabled"],
      },
    },
    {
      name: "setUnderground",
      description: "地下表示の設定。transparencyは地表の透過率0〜1、diveは地下への移動許可",
      parameters: {
        type: "OBJECT",
        properties: {
          transparency: { type: "NUMBER", description: "0〜1" },
          dive: { type: "BOOLEAN" },
        },
      },
    },
    {
      name: "setClip",
      description: "カメラ中心に断面クリップを作成・解除する。typeは ns ew h clear のいずれか",
      parameters: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", description: "ns / ew / h / clear" },
        },
        required: ["type"],
      },
    },
    {
      name: "listFlyPaths",
      description: "登録済みフライパス(巡視ルート)の一覧を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "playFlyPath",
      description: "フライパス(巡視ルート)を名前または番号で再生し、Flyモードで自動走行する",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "フライパス名(listFlyPathsで確認)" },
        },
        required: ["name"],
      },
    },
    {
      name: "stopFly",
      description: "Flyモード・フライパス再生を停止してOrbit(3D)モードに戻る",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "vectorSearch",
      description: "読み込み済みベクトルデータ(GeoJSON等)の属性を検索し、該当する属性名・値・位置を返す。結果の緯度経度へはflyToFeatureで移動できる",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "検索語(属性名や値の一部)" },
        },
        required: ["query"],
      },
    },
    {
      name: "getShareUrl",
      description: "現在のカメラ位置・プロジェクトを含む共有URLを取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "listProjects",
      description: "切替可能なプロジェクト一覧を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "switchProject",
      description: "プロジェクトを切り替える。レイヤ・カメラプリセット等の設定全体が入れ替わるので、ユーザーが明示した場合のみ使う",
      parameters: {
        type: "OBJECT",
        properties: {
          projectId: { type: "STRING", description: "プロジェクトID(listProjectsで確認)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "toggleDrawMode",
      description: "Drawモード(地図上へのルート描画)をON/OFFする",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "applyInspector",
      description: "インスペクターの設定テキスト(.kasc形式)を登録・適用する。設定全体が上書きされるので、ユーザーが明示した場合のみ使う",
      parameters: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: ".kasc形式の設定テキスト" },
        },
        required: ["text"],
      },
    },
    {
      name: "exportInspector",
      description: "現在の設定を.kascファイルとしてエクスポート(ダウンロード)する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "checkUpdate",
      description: "アプリの最新バージョンを確認する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "installUpdate",
      description: "最新版をインストールする(更新がある場合のみ有効)",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "runCode",
      description: "ブラウザ内サンドボックスでJavaScriptを実行し、戻り値とconsole出力を返す。データ加工・集計・座標計算などに使う。api.flyTo(...)等の地図操作APIが非同期で呼べる(api.<関数名>はkasugaiApiと同じ)。例: const layers = await api.listLayers(); return layers.length; ※DOM・localStorage・外部fetchは不可",
      parameters: {
        type: "OBJECT",
        properties: {
          code: { type: "STRING", description: "実行するJavaScript。returnで値を返す。await使用可" },
        },
        required: ["code"],
      },
    },
    {
      name: "addGeoJsonLayer",
      description: "GeoJSONレイヤをURL指定で追加して即座に適用する。urlはDATA/相対パスまたは外部URL。追加はインスペクター設定に反映されるのでユーザーが明示した場合のみ使う",
      parameters: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "レイヤ名" },
          url: { type: "STRING", description: "GeoJSONのURLまたは DATA/ファイル名" },
        },
        required: ["title", "url"],
      },
    },
    {
      name: "shutdownApp",
      description: "アプリを停止する。確認ダイアログが出るのでユーザーが最終判断する。破壊的操作のためユーザーが明示した場合のみ使う",
      parameters: { type: "OBJECT", properties: {} },
    },
  ],
}];

const CHAT_SYSTEM_INSTRUCTION = "あなたは3D地図アプリ「KASUGAI Canvas」の操作アシスタントです。ユーザーの指示に応じてツールで地図を操作してください。レイヤ名が曖昧な場合はlistLayers、ベースマップ名が曖昧な場合はlistBasemapsで確認し、最も近いものを使ってください。switchProject・applyInspector・shutdownApp・installUpdate・exportInspectorは影響が大きい操作なので、ユーザーが明示的に指示した場合のみ実行し、実行前に一言確認してください。回答は日本語で簡潔に。";

// ブラウザ内コード実行サンドボックス。
// sandbox属性(allow-scriptsのみ・opaque origin)のiframe内で実行するため、
// localStorage・DOM・APIキーにはアクセスできない。地図操作は postMessage 経由の api ブリッジのみ。
let chatSandboxFrame = null;
let chatSandboxReady = null;
const chatSandboxPending = new Map();

function getChatSandbox() {
  if (chatSandboxFrame) return chatSandboxReady;
  const srcdoc = `<!doctype html><script>
    const logs = [];
    ["log", "warn", "error"].forEach(kind => {
      console[kind] = (...items) => {
        logs.push(items.map(item => { try { return typeof item === "object" ? JSON.stringify(item) : String(item); } catch (e) { return String(item); } }).join(" "));
      };
    });
    window.api = new Proxy({}, {
      get: (target, name) => (...args) => new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2) + Date.now();
        const onMessage = event => {
          if (!event.data || event.data.id !== id) return;
          removeEventListener("message", onMessage);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.result);
        };
        addEventListener("message", onMessage);
        parent.postMessage({ id, call: name, args }, "*");
      }),
    });
    addEventListener("message", async event => {
      const data = event.data || {};
      if (!data.id || typeof data.code !== "string") return;
      logs.length = 0;
      try {
        const fn = new Function("api", "return (async () => { " + data.code + " })()");
        const result = await fn(window.api);
        parent.postMessage({ id: data.id, result: result === undefined ? null : result, logs: logs.slice(0, 50) }, "*");
      } catch (error) {
        parent.postMessage({ id: data.id, error: String(error && error.message || error), logs: logs.slice(0, 50) }, "*");
      }
    });
    parent.postMessage({ ready: true }, "*");
  <\/script>`;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.srcdoc = srcdoc;
  frame.style.display = "none";
  chatSandboxFrame = frame;
  chatSandboxReady = new Promise(resolve => {
    const onMessage = event => {
      if (event.source === frame.contentWindow && event.data?.ready) {
        removeEventListener("message", onMessage);
        resolve();
      }
    };
    addEventListener("message", onMessage);
  });
  document.body.append(frame);
  return chatSandboxReady;
}

// サンドボックスへ公開しないAPI（キー等の機密を外部送信されるのを防ぐ）
const CHAT_SANDBOX_BLOCKED_API = new Set(["getGoogleApiKey", "getGeminiModel", "applyInspector", "shutdownApp", "installUpdate"]);

// サンドボックスからの api.XXX 呼び出しを kasugaiApi に橋渡しする
window.addEventListener("message", async event => {
  if (!chatSandboxFrame || event.source !== chatSandboxFrame.contentWindow) return;
  const { id, call, args } = event.data || {};
  if (!id || typeof call !== "string") return;
  const fn = window.kasugaiApi?.[call];
  let out;
  try {
    if (CHAT_SANDBOX_BLOCKED_API.has(call)) throw new Error(`api.${call} はサンドボックスから呼べません`);
    if (typeof fn !== "function") throw new Error(`api.${call} は存在しません`);
    out = { result: await fn(...(Array.isArray(args) ? args : [])) };
  } catch (error) {
    out = { error: String(error && error.message || error) };
  }
  event.source.postMessage({ id, ...out }, "*");
});

// サンドボックス内でJSコードを実行し、戻り値とconsole出力を返す
async function runSandboxedCode(code, timeoutMs = 15000) {
  await getChatSandbox();
  const id = Math.random().toString(36).slice(2) + Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chatSandboxPending.delete(id);
      reject(new Error("実行がタイムアウトしました"));
    }, timeoutMs);
    chatSandboxPending.set(id, { resolve, timer });
    const onMessage = event => {
      if (event.source !== chatSandboxFrame.contentWindow || event.data?.id !== id) return;
      removeEventListener("message", onMessage);
      chatSandboxPending.delete(id);
      clearTimeout(timer);
      const { result, error, logs } = event.data;
      if (error) reject(new Error(error));
      else resolve({ result, logs: logs || [] });
    };
    addEventListener("message", onMessage);
    chatSandboxFrame.contentWindow.postMessage({ id, code }, "*");
  });
}

// AIによる地図移動の既定視点: ドローン(対象地上+200m・ピッチ-30°)
async function applyDroneViewDefaults(args) {
  const merged = { ...args };
  if (!Number.isFinite(Number(merged.pitch))) merged.pitch = -30;
  if (!Number.isFinite(Number(merged.height))) {
    const lat = Number(merged.latitude);
    const lng = Number(merged.longitude);
    merged.height = (await sampleGroundHeight(lat, lng)) + 200;
  }
  return merged;
}

async function executeChatTool(name, args = {}) {
  if (name === "flyTo") {
    flyTo(await applyDroneViewDefaults(args));
    return { ok: true };
  }
  if (name === "flyToFeature") {
    const merged = await applyDroneViewDefaults(args);
    await flyToFeature(Number(merged.latitude), Number(merged.longitude), merged);
    return { ok: true };
  }
  if (name === "setLayerVisible") {
    const ok = window.kasugaiApi.setLayerVisible(args.name, args.visible);
    return { ok, message: ok ? undefined : `「${args.name}」というレイヤが見つかりません` };
  }
  if (name === "listLayers") return { layers: window.kasugaiApi.listLayers() };
  if (name === "getCamera") return { camera: window.kasugaiApi.getCamera() };
  if (name === "listBasemaps") return { basemaps: window.kasugaiApi.listBasemaps() };
  if (name === "setBasemap") {
    const ok = window.kasugaiApi.setBasemap(args.name);
    return { ok, message: ok ? undefined : `「${args.name}」というベースマップが見つかりません` };
  }
  if (name === "searchLocation") {
    const results = await window.kasugaiApi.searchLocation(args.query);
    return { results };
  }
  if (name === "listCameraPresets") return { presets: window.kasugaiApi.listCameraPresets() };
  if (name === "flyToPreset") {
    const ok = window.kasugaiApi.flyToPreset(args.name);
    return { ok, message: ok ? undefined : `「${args.name}」というプリセットが見つかりません` };
  }
  if (name === "setTerrain") return { ok: window.kasugaiApi.setTerrain(args.enabled) };
  if (name === "setEffect") {
    const ok = window.kasugaiApi.setEffect(args.name, args.enabled);
    return { ok, message: ok ? undefined : `未知の効果名: ${args.name}` };
  }
  if (name === "setUnderground") return { ok: window.kasugaiApi.setUnderground(args) };
  if (name === "setClip") return { ok: window.kasugaiApi.setClip(args.type) };
  if (name === "listFlyPaths") return { flyPaths: window.kasugaiApi.listFlyPaths() };
  if (name === "playFlyPath") {
    const ok = window.kasugaiApi.playFlyPath(args.name);
    return { ok, message: ok ? undefined : `「${args.name}」というフライパスが見つかりません` };
  }
  if (name === "stopFly") return { ok: window.kasugaiApi.stopFly() };
  if (name === "vectorSearch") return { results: window.kasugaiApi.vectorSearch(args.query) };
  if (name === "getShareUrl") return { url: window.kasugaiApi.getShareUrl() };
  if (name === "listProjects") return { projects: window.kasugaiApi.listProjects() };
  if (name === "switchProject") {
    const ok = window.kasugaiApi.switchProject(args.projectId);
    return { ok, message: ok ? undefined : `「${args.projectId}」というプロジェクトが見つかりません` };
  }
  if (name === "toggleDrawMode") return window.kasugaiApi.toggleDrawMode();
  if (name === "applyInspector") return { ok: window.kasugaiApi.applyInspector(args.text) };
  if (name === "exportInspector") return { ok: window.kasugaiApi.exportInspector() };
  if (name === "checkUpdate") return { ok: window.kasugaiApi.checkUpdate() };
  if (name === "installUpdate") {
    const ok = window.kasugaiApi.installUpdate();
    return { ok, message: ok ? undefined : "現在インストール可能な更新はありません" };
  }
  if (name === "runCode") {
    try {
      const { result, logs } = await runSandboxedCode(String(args.code || ""));
      return { result, logs };
    } catch (error) {
      return { ok: false, message: String(error && error.message || error) };
    }
  }
  if (name === "addGeoJsonLayer") return { ok: window.kasugaiApi.addGeoJsonLayer(args.title, args.url) };
  if (name === "shutdownApp") return { ok: window.kasugaiApi.shutdownApp() };
  return { ok: false, message: `未知のツール: ${name}` };
}

// Gemini generateContent を呼び、function calling の往復を処理する
async function callGemini(history) {
  const apiKey = window.kasugaiApi.getGoogleApiKey();
  const model = window.kasugaiApi.getGeminiModel();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const executed = [];
  for (let step = 0; step < 5; step++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CHAT_SYSTEM_INSTRUCTION }] },
        contents: history,
        tools: CHAT_TOOLS,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
    const parts = data?.candidates?.[0]?.content?.parts || [];
    history.push({ role: "model", parts });
    const calls = parts.filter(part => part.functionCall);
    if (!calls.length) {
      const text = parts.map(part => part.text || "").join("").trim();
      return { text: text || "(応答なし)", executed };
    }
    const responseParts = [];
    for (const part of calls) {
      const result = await executeChatTool(part.functionCall.name, part.functionCall.args || {});
      executed.push(`${part.functionCall.name}(${JSON.stringify(part.functionCall.args || {})})`);
      responseParts.push({ functionResponse: { name: part.functionCall.name, response: { result } } });
    }
    history.push({ role: "user", parts: responseParts });
  }
  return { text: "ツール実行が上限回数に達しました。", executed };
}

function setupChatPanel() {
  const panel = document.querySelector("#chat-panel");
  if (!panel) return;
  updateChatPanelVisibility();
  const messages = document.querySelector("#chat-messages");
  const form = document.querySelector("#chat-form");
  const input = document.querySelector("#chat-input");
  const history = [];

  // チャット履歴はプロジェクト単位で localStorage に保存する
  const historyKey = `kasugaiChatHistory_${currentProjectId || "default"}`;
  const loadChatLog = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(historyKey) || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch (e) { return []; }
  };
  const saveChatLog = (role, text) => {
    try {
      const log = loadChatLog();
      log.push({ role, text });
      localStorage.setItem(historyKey, JSON.stringify(log.slice(-200)));
    } catch (e) {}
  };

  const addMessage = (role, text, { persist = true } = {}) => {
    const div = document.createElement("div");
    div.className = `chat-message ${role}`;
    div.textContent = text;
    messages.append(div);
    messages.scrollTop = messages.scrollHeight;
    if (persist) saveChatLog(role, text);
  };

  // 保存済み履歴を復元し、Gemini の会話コンテキストも user/model ペアで再構成する
  const savedLog = loadChatLog();
  savedLog.forEach(entry => {
    if (!entry || typeof entry.text !== "string") return;
    addMessage(entry.role, entry.text, { persist: false });
    if (entry.role === "user") history.push({ role: "user", parts: [{ text: entry.text }] });
    else if (entry.role === "assistant") history.push({ role: "model", parts: [{ text: entry.text }] });
  });

  const toggle = document.querySelector("#chat-panel-toggle");
  toggle?.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "+" : "−";
    toggle.setAttribute("aria-label", collapsed ? "展開" : "最小化");
  });

  const clearButton = document.querySelector("#chat-clear");
  clearButton?.addEventListener("click", () => {
    try { localStorage.removeItem(historyKey); } catch (e) {}
    history.length = 0;
    messages.replaceChildren();
    addMessage("system", "履歴をクリアしました。", { persist: false });
  });

  form?.addEventListener("submit", event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMessage("user", text);
    void respondToChat(text);
  });

  // Google APIキーが設定されていれば Gemini (function calling)、未設定ならローカルコマンドのみ。
  // "kasugai:chat" カスタムイベントを購読し detail.reply をセットすれば外部エージェントへ橋渡しできる
  async function respondToChat(text) {
    const detail = { text, reply: null };
    window.dispatchEvent(new CustomEvent("kasugai:chat", { detail }));
    if (typeof detail.reply === "string" && detail.reply) {
      addMessage("assistant", detail.reply);
      return;
    }
    if (text.startsWith("/")) {
      const local = await handleLocalChatCommand(text);
      addMessage("assistant", local || `不明なコマンド: ${text}`);
      return;
    }
    if (!window.kasugaiApi.getGoogleApiKey()) {
      const local = await handleLocalChatCommand(text);
      addMessage("assistant", local || "APIキー未設定です。設定 → Google タブで Gemini API キーを保存すると会話できます。キーは https://aistudio.google.com/apikey から取得できます。\n使えるコマンド: /fly /layers /layer /basemaps /basemap /search /camera");
      return;
    }
    const thinking = document.createElement("div");
    thinking.className = "chat-message assistant";
    thinking.textContent = "…";
    messages.append(thinking);
    messages.scrollTop = messages.scrollHeight;
    try {
      history.push({ role: "user", parts: [{ text }] });
      const { text: reply, executed } = await callGemini(history);
      thinking.remove();
      executed.forEach(call => addMessage("system", `実行: ${call}`));
      addMessage("assistant", reply);
    } catch (error) {
      thinking.remove();
      history.pop();
      addMessage("system", `エラー: ${error.message}`);
    }
  }

  // 初回案内は表示しない（API未設定時のチュートリアル表示を省略）
}

window.addEventListener("popstate", applyUrlCamera);
window.addEventListener("hashchange", applyUrlCamera);

window.addEventListener("pagehide", () => {
  try {
    sessionStorage.setItem("lastCameraSearch", window.location.search + window.location.hash);
  } catch (e) {}
});

(async () => {
  await detectBackend();
  try { await loadProjects(); } catch (e) { console.error(e); }
  try { await loadInspectorConfig(); } catch (e) { console.error(e); }
  try { await loadUpdateInfo(); } catch (e) { console.error(e); }
  const initialCamera = await resolveInitialCamera();
  // 前回のカメラ位置は起動直後に即セット済み。URLの座標が変わっていればそこからFLYTOする
  if (hasLastCamera && lastCameraSearch !== initialCameraSource) {
    if (initialCamera) flyTo(initialCamera);      // 前回の位置から新しいURLへGoogle Earth風にFLYTO
  } else {
    if (initialCamera) flyTo(initialCamera, 0);   // 履歴がない or 同じURL
  }
  renderPresets();
})();
