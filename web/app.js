import * as THREE from "three";

const Cesium = window.Cesium;

const urlParams = new URLSearchParams(window.location.search);
// カメラ情報はハッシュ(#latitude=...)に置く。ハッシュはアドレスバーで書き換えても
// ページが再読み込みされないため、前のビューからそのままFLYTOできる(Google Earth と同じ挙動)
const initialCameraSource = window.location.search + window.location.hash;
const DEFAULT_VIEW = { latitude: 35.6852, longitude: 139.7528, height: 2000, pitch: -30, heading: 0 };

const viewer = new Cesium.Viewer("deck-container", {
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
let currentProjectId = urlParams.get("project") || "";
let yahooAppId = "";
let terrainEnabled = true;
let undergroundTransparency = 0;
let undergroundDiveEnabled = true;
let undergroundBackgroundColor = Cesium.Color.BLACK;
let basemapDrape3DTiles = false;
let infoRequestId = 0;
let walkModeActive = false;
let walkTerrainOffset = 20;
let walkMoveSpeed = 30;
const activeClippingPlanes = { planes: [] };
const activeDataSources = [];
const activePrimitives = [];
const drapeTerrainSources = { dem: true, tiles3d: false };
const drapeLayers = { xyz: true, geojson: true };
const demSources = {
  reearth: {
    title: "Re:Earth Terrain (標高 / MSL, level 19)",
    url: "https://terrain.reearth.land/cesium-mesh/msl",
  },
  "reearth-ellipsoid": {
    title: "Re:Earth Terrain (楕円体高 / WGS84, level 19)",
    url: "https://terrain.reearth.land/cesium-mesh/ellipsoid",
  },
  terrarium: {
    title: "Terrarium DEM (AWS, level 15)",
    elevationData: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    elevationDecoder: { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 },
    tileSize: 256,
    maximumLevel: 15,
    attribution: "Mapzen Terrarium · AWS",
    attributionUrl: "https://registry.opendata.aws/terrain-tiles/",
  },
};
let selectedDemSource = "reearth-ellipsoid";
const DEFAULT_MAXIMUM_LEVEL = 25;

let threeRenderer;
let threeScene;
let threeCamera;
let threeModel;

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

function getProjectConfigUrl() {
  return currentProjectId ? `/api/projects/${encodeURIComponent(currentProjectId)}/config` : "/api/config";
}

async function loadProjects() {
  const response = await fetch("/api/projects");
  if (!response.ok) throw new Error(await response.text());
  const definitions = await response.json();
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
    const response = await fetch(getProjectConfigUrl());
    if (!response.ok) throw new Error(await response.text());
    const text = await response.text();
    document.querySelector("#inspector-input").value = text;
    applyInspector(text);
    setInspectorStatus("設定を読み込みました。");
  } catch (error) {
    console.error("設定の読み込みに失敗しました。", error);
    setInspectorStatus(`設定を読み込めません: ${error instanceof Error ? error.message : error}`, true);
  }
}

async function saveInspectorConfig() {
  const response = await fetch(getProjectConfigUrl(), {
    method: "PUT",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: document.querySelector("#inspector-input").value,
  });
  if (!response.ok) throw new Error(await response.text());
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

function flyTo(options = {}, duration = null) {
  const latitude = Number(options.latitude);
  const longitude = Number(options.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  let height = Number(options.height);
  if (!Number.isFinite(height)) height = DEFAULT_VIEW.height;
  const pitch = (viewer.scene.screenSpaceCameraController.enableTilt ? Math.max(-90, Math.min(90, Number(options.pitch) || 0)) : -90) * Math.PI / 180;
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
      ${group ? `<div class="layer-group-title" draggable="true"><button class="layer-group-toggle" type="button" aria-label="グループを展開・折りたたみ" aria-expanded="${expandedLayerGroups.has(groupKey)}">${expandedLayerGroups.has(groupKey) ? "▾" : "▸"}</button><input id="${groupInputId}" class="layer-group-checkbox" type="checkbox" data-group-key="${escapeHtml(groupKey)}" ${groupChecked ? "checked" : ""}><label class="layer-group-label" for="${groupInputId}">${escapeHtml(group)}</label>${exclusive ? '<small class="exclusive-badge">Exclusive</small>' : ""}</div>` : ""}
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

function formatTileUrl(template, index) {
  return template
    .replaceAll("{z}", String(index.z))
    .replaceAll("{x}", String(index.x))
    .replaceAll("{y}", String(index.y));
}

class TerrariumTerrainProvider {
  constructor(options) {
    this.tilingScheme = new Cesium.GeographicTilingScheme();
    this.heightmapWidth = options.tileSize || 256;
    this.heightmapHeight = options.tileSize || 256;
    this.hasVertexNormals = false;
    this.hasWaterMask = false;
    this.elevationData = proxyTemplateUrl(options.elevationData);
    this.elevationDecoder = options.elevationDecoder;
    this.maximumLevel = options.maximumLevel || 15;
    this.availability = {
      isTileAvailable: (level, x, y) => level <= this.maximumLevel && x >= 0 && y >= 0,
    };
  }

  getLevelMaximumGeometricError(level) {
    return 156543.03392 / (1 << level);
  }

  requestTileGeometry(x, y, level, request) {
    if (level > this.maximumLevel) return Promise.reject(new Error("Tile out of range"));
    const url = formatTileUrl(this.elevationData, { x, y, z: level });
    return fetch(url, { mode: "cors" })
      .then(async response => {
        if (!response.ok) throw new Error(`Terrain tile request failed (${response.status}): ${url}`);
        return createImageBitmap(await response.blob());
      })
      .then(bitmap => {
        const canvas = document.createElement("canvas");
        canvas.width = this.heightmapWidth;
        canvas.height = this.heightmapHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Terrain sample canvas is unavailable");
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bitmap, 0, 0, this.heightmapWidth, this.heightmapHeight);
        bitmap.close();
        const image = ctx.getImageData(0, 0, this.heightmapWidth, this.heightmapHeight);
        const { rScaler, gScaler, bScaler, offset } = this.elevationDecoder;
        const count = this.heightmapWidth * this.heightmapHeight;
        const heights = new Float32Array(count);
        for (let i = 0; i < count; i += 1) {
          const offsetPixels = i * 4;
          const r = image.data[offsetPixels];
          const g = image.data[offsetPixels + 1];
          const b = image.data[offsetPixels + 2];
          heights[i] = r * rScaler + g * gScaler + b * bScaler + offset;
        }
        return new Cesium.HeightmapTerrainData({
          buffer: heights,
          width: this.heightmapWidth,
          height: this.heightmapHeight,
          childTileMask: level === this.maximumLevel ? 0 : 15,
          structure: {
            heightScale: 1.0,
            heightOffset: 0.0,
            elementsPerHeight: 1,
            stride: 1,
            elementMultiplier: 1.0,
            isBigEndian: false,
          },
        });
      });
  }
}

function toHex(str) {
  return Array.from(new TextEncoder().encode(str), b => b.toString(16).padStart(2, "0")).join("");
}

function proxyTileUrl(url, useProxy = true) {
  if (typeof url !== "string" || !url.startsWith("http")) return url;
  if (useProxy === false) return url;
  const origin = window.location.origin;
  if (url.startsWith(origin + "/api/tile/")) return url;
  let dir = url;
  let file = "";
  if (!dir.endsWith("/")) {
    const lastSlash = dir.lastIndexOf("/");
    const candidate = dir.slice(lastSlash + 1);
    if (candidate.includes(".")) {
      file = candidate;
      dir = dir.slice(0, lastSlash + 1);
    } else {
      dir += "/";
    }
  }
  const hex = toHex(dir);
  if (file) return `${origin}/api/tile/${hex}/${file}`;
  return `${origin}/api/tile/${hex}/`;
}

function proxyTemplateUrl(url, useProxy = true) {
  if (typeof url !== "string" || !url.startsWith("http")) return url;
  if (useProxy === false) return url;
  if (url.startsWith(window.location.origin)) return url;
  const encoded = encodeURIComponent(url).replace(/%7B/g, "{").replace(/%7D/g, "}");
  return `${window.location.origin}/api/tile?url=${encoded}`;
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

async function refreshLayers() {
  viewer.imageryLayers.removeAll(false);
  activeDataSources.forEach(ds => { try { viewer.dataSources.remove(ds, false); } catch (error) { /* ignore */ } });
  activeDataSources.length = 0;
  activePrimitives.forEach(primitive => { try { viewer.scene.primitives.remove(primitive); } catch (error) { /* ignore */ } });
  activePrimitives.length = 0;

  const demSource = terrainEnabled ? demSources[selectedDemSource] : null;
  if (demSource?.url) {
    const terrainUrl = proxyTileUrl(demSource.url);
    try {
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
  } else if (demSource?.elevationData) {
    try {
      viewer.terrainProvider = new TerrariumTerrainProvider(demSource);
    } catch (error) {
      console.warn("Terrarium DEM の初期化に失敗しました:", error);
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
    if (!item.visible) continue;
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
        if (!clamp) continue;
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
        await viewer.dataSources.add(ds);
        activeDataSources.push(ds);
      } catch (error) {
        console.warn("GeoJSON の読み込みに失敗しました:", item.url, error);
      }
    }
  }

  applyClippingPlanes(viewer.scene.globe);
  updateUndergroundView();
  updateEffectSettings();
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
    const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
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

function applyInspector(text) {
  const nextLines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsedCameras = [];
  const parsedBasemaps = [];
  layerState.clear();
  tileLayers.splice(0, tileLayers.length);
  layers.splice(0, layers.length);
  basemaps.splice(0, basemaps.length);
  layerOrder = [];

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
    if (type === "yahooappid") yahooAppId = value;
    if (type === "info") {
      void loadInfoContent(value);
    }
    if (type === "legend") {
      const parts = value.split("|").map(part => part.trim());
      document.querySelector("#legend-panel img").src = parts[parts.length - 1];
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
          url: parts[1],
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

    if (type === "xyz") {
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const url = parts[1];
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
      const url = parts[1];
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
  renderBasemapSelector();
  renderPresets();
  renderLayerList();
  refreshLayers();
}

function setupThreeJs() {
  const container = document.querySelector("#deck-container");
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
    pitch: is2D ? pitchDeg : Math.max(pitchDeg, -89.99999999999999),
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

  document.querySelector("#search-form").addEventListener("submit", async event => {
    event.preventDefault();
    const query = document.querySelector("#search-query").value.trim();
    const results = document.querySelector("#search-results");
    results.textContent = "検索中...";
    try {
      const useYahoo = yahooAppId && !yahooAppId.includes("あなたのYahoo");
      const params = new URLSearchParams({ query });
      if (useYahoo) params.set("appid", yahooAppId);
      const response = await fetch(`/api/search?${params}`);
      if (!response.ok) throw new Error(await response.text() || `検索に失敗しました (${response.status})`);
      const data = await response.json();
      const items = useYahoo ? (data.Feature || []).map(item => ({
        title: item.Name,
        latitude: Number(item.Geometry?.Coordinates?.split(",")[1]),
        longitude: Number(item.Geometry?.Coordinates?.split(",")[0]),
      })) : data.map(item => ({
        title: item.properties?.title,
        latitude: Number(item.geometry?.coordinates?.[1]),
        longitude: Number(item.geometry?.coordinates?.[0]),
      }));
      results.innerHTML = items.filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
        .map((item, index) => `<button type="button" data-search-index="${index}">${escapeHtml(item.title)}</button>`).join("");
      results.querySelectorAll("[data-search-index]").forEach(button => {
        button.addEventListener("click", () => flyTo({ latitude: items[Number(button.dataset.searchIndex)].latitude, longitude: items[Number(button.dataset.searchIndex)].longitude, height: 300, pitch: -30 }));
      });
    } catch (error) {
      results.textContent = error instanceof Error ? error.message : "検索に失敗しました。";
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

  const modeSelect = document.querySelector("#mode-select");
  const walkOffsetEl = document.querySelector("#walk-offset");
  const walkTerrainEl = document.querySelector("#walk-terrain");
  const walkSpeedEl = document.querySelector("#walk-speed");
  const walkKeys = new Set();
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
      walkMoveSpeed += 100 * speedChange * delta;
      const moveDistance = walkMoveSpeed * delta;
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
        walkTerrainOffset += 10 * heightChange * delta;
        carto.height = terrainHeight + walkTerrainOffset;
        camera.setView({
          destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
          orientation: { heading, pitch, roll: 0 },
        });
        if (walkOffsetEl) walkOffsetEl.textContent = walkTerrainOffset.toFixed(1);
        if (walkTerrainEl) walkTerrainEl.textContent = terrainHeight.toFixed(1);
        if (walkSpeedEl) walkSpeedEl.textContent = (walkMoveSpeed * 3.6).toFixed(1);
      }
      walkRafId = requestAnimationFrame(walkLoop);
    }
  };
  const walkHelp = document.querySelector("#walk-help");
  const ssec = viewer.scene.screenSpaceCameraController;
  const defaultLookEventTypes = ssec.lookEventTypes;
  const defaultZoomEventTypes = ssec.zoomEventTypes ? [...ssec.zoomEventTypes] : [];
  const wheelEventType = Cesium.CameraEventType?.WHEEL;
  const setMode = (next) => {
    const isWalk = next === "walk";
    modeSelect.value = next;
    modeSelect.textContent = isWalk ? "Fly" : "Orbit";
    modeSelect.setAttribute("aria-label", isWalk ? "Fly mode" : "Orbit view");
    walkModeActive = isWalk;
    autoMove = 0;
    walkHelp?.classList.toggle("visible", isWalk);
    if (isWalk) {
      const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
      if (carto) {
        const terrainHeight = viewer.scene.globe.getHeight(carto) ?? 0;
        walkTerrainOffset = carto.height - terrainHeight;
      }
    }
    ssec.enableZoom = true;
    ssec.lookEventTypes = defaultLookEventTypes;
    ssec.zoomEventTypes = isWalk && wheelEventType
      ? defaultZoomEventTypes.filter(t => t !== wheelEventType)
      : defaultZoomEventTypes;
    viewer.scene.mode = Cesium.SceneMode.SCENE3D;
    if (isWalk && !walkRafId) {
      walkLastTime = performance.now();
      walkRafId = requestAnimationFrame(walkLoop);
    }
  };
  modeSelect.addEventListener("click", () => {
    setMode(modeSelect.value === "orbit" ? "walk" : "orbit");
  });
  const lastKeyTap = { KeyW: 0, KeyS: 0 };
  window.addEventListener("keydown", event => {
    if (!walkModeActive) return;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target?.tagName)) return;
    const code = event.code;
    if (["KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyE", "Equal", "Minus", "NumpadAdd", "NumpadSubtract", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(code)) {
      event.preventDefault();
      if (code === "Escape") {
        setMode("orbit");
      } else {
        if (code === "KeyW" || code === "KeyS") {
          const now = performance.now();
          const direction = code === "KeyW" ? 1 : -1;
          if (!event.repeat && now - lastKeyTap[code] < 300) {
            autoMove = autoMove === direction ? 0 : direction;
          }
          if (!event.repeat) lastKeyTap[code] = now;
        }
        walkKeys.add(code);
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

  [".control-panel", ".basemap-control", ".navigation-toolbar"].forEach(selector => {
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

    const entity = picked.id;
    if (entity?.properties) {
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
      autoMove = autoMove === -1 ? 0 : -1;
    }
    lastRightClick = now;
  });

  viewer.canvas.addEventListener("dblclick", event => {
    if (!walkModeActive) return;
    if (event.button === 0) {
      autoMove = autoMove === 1 ? 0 : 1;
    }
  });

  viewer.canvas.addEventListener("wheel", event => {
    if (!walkModeActive) return;
    event.preventDefault();
    const direction = -Math.sign(event.deltaY);
    if (direction === 0) return;
    walkMoveSpeed += 20 * direction;
  }, { passive: false });

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
    });
  });
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
      if (document.querySelector("#auto-update").checked) await installUpdate(latestVersion);
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

async function installUpdate(latestVersion = document.querySelector("#latest-version").textContent) {
  if (!confirm(`新しいバージョン ${latestVersion} が利用可能です。ダウンロードしてインストールしますか？`)) {
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

window.addEventListener("popstate", applyUrlCamera);
window.addEventListener("hashchange", applyUrlCamera);

window.addEventListener("pagehide", () => {
  try {
    sessionStorage.setItem("lastCameraSearch", window.location.search + window.location.hash);
  } catch (e) {}
});

(async () => {
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
