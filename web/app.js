import * as THREE from "three";

const Cesium = window.Cesium;

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
viewer.camera.percentageChanged = 0.3;

const basemaps = [];
let selectedBasemap = null;
const cameraPresets = [];
const layers = [];
const tileLayers = [];
const layerState = new Map();
let layerOrder = [];
const expandedLayerGroups = new Set();
let currentProjectId = "";
let yahooAppId = "";
let terrainEnabled = true;
let shadowEnabled = false;
let undergroundViewEnabled = false;
let basemapDrape3DTiles = false;
let infoRequestId = 0;
const activeClippingPlanes = { planes: [] };
const activeDataSources = [];
const activePrimitives = [];
const drapeTerrainSources = { dem: true, tiles3d: true };
const drapeLayers = { xyz: true, geojson: true };
const demSources = {
  reearth: {
    title: "Re:Earth Terrain (標高 / MSL, zoom 19)",
    url: "https://terrain.reearth.land/cesium-mesh/msl",
  },
  "reearth-ellipsoid": {
    title: "Re:Earth Terrain (楕円体高 / WGS84, zoom 19)",
    url: "https://terrain.reearth.land/cesium-mesh/ellipsoid",
  },
  terrarium: {
    title: "Terrarium DEM (AWS, zoom 15)",
    elevationData: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    elevationDecoder: { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 },
    tileSize: 256,
    maxZoom: 15,
    attribution: "Mapzen Terrarium · AWS",
    attributionUrl: "https://registry.opendata.aws/terrain-tiles/",
  },
};
let selectedDemSource = "reearth-ellipsoid";
const maxZoom = 25;

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

function setInspectorStatus(message, isError = false) {
  const status = document.querySelector("#inspector-status");
  status.textContent = message;
  status.style.color = isError ? "#a82020" : "";
}

function flyTo(options = {}) {
  const latitude = Number(options.latitude);
  const longitude = Number(options.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  const latRad = latitude * Math.PI / 180;
  let height = Number(options.height);
  if (!Number.isFinite(height)) {
    const zoom = Number(options.zoom);
    height = Number.isFinite(zoom) ? Math.max(10, 156543.03392 * 256 * Math.max(0.2, Math.cos(latRad)) / (2 ** zoom)) : 1000;
  }
  const pitch = -Math.max(-90, Math.min(90, Number(options.pitch) || 0)) * Math.PI / 180;
  const heading = (Number(options.bearing) || 0) * Math.PI / 180;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, Math.max(1, height)),
    orientation: { heading, pitch, roll: 0 },
    duration: 1.5,
  });
}

function updateCameraInputs() {
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  document.querySelector("#camera-latitude").value = Number(cartographic.latitude * 180 / Math.PI).toFixed(6);
  document.querySelector("#camera-longitude").value = Number(cartographic.longitude * 180 / Math.PI).toFixed(6);
  document.querySelector("#camera-zoom").value = Number(cartographic.height).toFixed(1);
  document.querySelector("#camera-pitch").value = Number(-viewer.camera.pitch * 180 / Math.PI).toFixed(2);
  document.querySelector("#camera-bearing").value = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
  const needle = document.querySelector(".compass-needle");
  if (needle) needle.style.transform = `translate(-50%, -92%) rotateZ(${-viewer.camera.heading * 180 / Math.PI}deg)`;
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
      ${group ? `<div class="layer-group-title"><button class="layer-group-toggle" type="button" aria-label="グループを展開・折りたたみ" aria-expanded="${expandedLayerGroups.has(groupKey)}">${expandedLayerGroups.has(groupKey) ? "▾" : "▸"}</button><input id="${groupInputId}" class="layer-group-checkbox" type="checkbox" data-group-key="${escapeHtml(groupKey)}" ${groupChecked ? "checked" : ""}><label class="layer-group-label" for="${groupInputId}">${escapeHtml(group)}</label>${exclusive ? '<small class="exclusive-badge">Exclusive</small>' : ""}</div>` : ""}
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
  list.querySelectorAll(".layer-row").forEach(row => {
    row.addEventListener("dragstart", event => {
      draggedId = row.dataset.layerId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedId);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => { draggedId = undefined; row.classList.remove("dragging"); });
    row.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
    row.addEventListener("drop", event => {
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
    this.elevationData = options.elevationData;
    this.elevationDecoder = options.elevationDecoder;
    this.maxZoom = options.maxZoom || 15;
    this.availability = {
      isTileAvailable: (level, x, y) => level <= this.maxZoom && x >= 0 && y >= 0,
    };
  }

  getLevelMaximumGeometricError(level) {
    return 156543.03392 / (1 << level);
  }

  requestTileGeometry(x, y, level, request) {
    if (level > this.maxZoom) return Promise.reject(new Error("Tile out of range"));
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
          childTileMask: level === this.maxZoom ? 0 : 15,
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

function createUrlTemplateProvider(options) {
  return new Cesium.UrlTemplateImageryProvider({
    url: options.url,
    credit: new Cesium.Credit(options.attribution || ""),
    maximumLevel: options.maxZoom || maxZoom,
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
  const hasTerrain = !(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider);
  viewer.scene.globe.depthTestAgainstTerrain = hasTerrain && !undergroundViewEnabled;
  viewer.scene.globe.translucency.enabled = undergroundViewEnabled;
  if (undergroundViewEnabled) {
    viewer.scene.globe.translucency.frontFaceAlpha = 0.5;
    viewer.scene.globe.translucency.backFaceAlpha = 0.5;
    viewer.scene.globe.undergroundColor = Cesium.Color.BLACK;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = -1000;
  } else {
    viewer.scene.globe.undergroundColor = Cesium.Color.BLACK;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 1;
  }
}

async function refreshLayers() {
  viewer.imageryLayers.removeAll(false);
  activeDataSources.forEach(ds => { try { viewer.dataSources.remove(ds, false); } catch (error) { /* ignore */ } });
  activeDataSources.length = 0;
  activePrimitives.forEach(primitive => { try { viewer.scene.primitives.remove(primitive); } catch (error) { /* ignore */ } });
  activePrimitives.length = 0;

  const demSource = terrainEnabled ? demSources[selectedDemSource] : null;
  if (demSource?.url) {
    try {
      const terrainProvider = Cesium.CesiumTerrainProvider.fromUrl
        ? await Cesium.CesiumTerrainProvider.fromUrl(demSource.url)
        : await new Promise((resolve, reject) => {
            const provider = new Cesium.CesiumTerrainProvider({ url: demSource.url });
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

  viewer.scene.globe.enableLighting = shadowEnabled;
  viewer.scene.shadows = shadowEnabled;

  const visible3DTiles = layers.some(l => l.visible && l.type === "3dtiles");
  const drape3DTiles = drapeTerrainSources.tiles3d && visible3DTiles;

  // 3D Tiles ドレープ用プロバイダー定義
  const drapeProviders = [];
  if (drape3DTiles) {
    if (basemapDrape3DTiles && selectedBasemap?.url) {
      drapeProviders.push({
        url: selectedBasemap.url,
        attribution: selectedBasemap.attribution,
        maxZoom: selectedBasemap.maxZoom || maxZoom,
        tileSize: selectedBasemap.tileSize || 256,
        opacity: selectedBasemap.opacity ?? 1.0,
      });
    }
    if (drapeLayers.xyz) {
      tileLayers.filter(t => t.visible).forEach(item => {
        drapeProviders.push({
          url: item.url,
          attribution: item.attribution,
          maxZoom: item.maxZoom || maxZoom,
          tileSize: item.tileSize || 256,
          opacity: item.opacity ?? 0.8,
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
        maxZoom: selectedBasemap.maxZoom || maxZoom,
        tileSize: selectedBasemap.tileSize || 256,
      });
      viewer.imageryLayers.add(new Cesium.ImageryLayer(provider, { alpha: selectedBasemap.opacity ?? 1.0 }));
    } catch (error) {
      console.warn("ベースマップの作成に失敗しました:", error);
    }
  }

  // Globe 表面の XYZ
  for (const item of tileLayers) {
    if (!item.visible) continue;
    if (drape3DTiles && drapeLayers.xyz) continue;
    try {
      const provider = createUrlTemplateProvider({
        url: item.url,
        attribution: item.attribution,
        maxZoom: item.maxZoom || maxZoom,
        tileSize: item.tileSize || 256,
      });
      viewer.imageryLayers.add(new Cesium.ImageryLayer(provider, { alpha: item.opacity ?? 0.8 }));
    } catch (error) {
      console.warn("XYZ タイルの作成に失敗しました:", item.url, error);
    }
  }

  // 3D Tiles / GeoJSON
  for (const item of layers) {
    if (!item.visible) continue;
    if (item.type === "3dtiles") {
      try {
        const tileset = await Cesium.Cesium3DTileset.fromUrl(item.url);
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
        const ds = await Cesium.GeoJsonDataSource.load(item.url, { clampToGround: true });
        for (const entity of ds.entities.values) {
          if (entity.polygon) entity.polygon.outline = new Cesium.ConstantProperty(false);
          if (entity.polyline) entity.polyline.clampToGround = new Cesium.ConstantProperty(true);
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
  ++infoRequestId;
  document.querySelector("#info-content").replaceChildren();
  document.querySelector("#legend-panel img").removeAttribute("src");

  let inspectorLayerIndex = 0;
  nextLines.forEach(line => {
    const separator = line.indexOf(":");
    if (separator < 0) return;
    const type = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (type === "background") document.body.style.background = value;
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
          if (key === "maxZoom" && Number.isInteger(number) && number >= 0) options.maxZoom = number;
          if (key === "opacity" && Number.isFinite(number)) options.opacity = Math.max(0, Math.min(1, number));
        });
        parsedBasemaps.push({
          id: `inspector-base-${parsedBasemaps.length}`,
          title: parts[0],
          url: parts[1],
          attribution: parts[2] || "",
          tileSize: options.tileSize || 256,
          opacity: options.opacity ?? 1.0,
          ...(options.maxZoom === undefined ? {} : { maxZoom: options.maxZoom }),
        });
      }
    }

    if (type === "cam") {
      const parts = value.split("|").map(part => part.trim());
      if (parts.length < 3) return;
      const camera = { title: parts[0], latitude: Number(parts[1]), longitude: Number(parts[2]), pitch: 30, bearing: 0 };
      parts.slice(3).forEach(part => {
        const [key, raw] = part.split("=");
        const number = Number(raw);
        if (key === "p" && Number.isFinite(number)) camera.pitch = Math.abs(number);
        if (key === "d" && Number.isFinite(number)) camera.bearing = number;
        if (key === "h" && Number.isFinite(number)) camera.height = number;
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
        if (key === "maxZoom" && Number.isInteger(number) && number >= 0) options.maxZoom = number;
        if (key === "tileSize" && [256, 512].includes(number)) options.tileSize = number;
      });
      const id = `inspector-layer-${inspectorLayerIndex++}`;
      const item = { id, title: displayTitle, sourceTitle: title, url, visible: !off, type: "tile", opacity: options.opacity ?? 0.8, attribution: parts[2] || "", group, exclusiveGroup };
      if (options.maxZoom !== undefined) item.maxZoom = options.maxZoom;
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
      if (!title) return;
      const { group, title: displayTitle, exclusiveGroup } = parseLayerTitle(title);
      const id = `inspector-layer-${inspectorLayerIndex++}`;
      const item = { id, title: displayTitle, sourceTitle: title, type, url, visible: !off, attribution: parts[2] || "", group, exclusiveGroup };
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

function setupEvents() {
  document.querySelector("#basemap-select").addEventListener("change", event => {
    selectedBasemap = basemaps.find(b => b.id === event.target.value) || null;
    updateMapAttribution();
    refreshLayers();
  });

  document.querySelector("#apply-camera").addEventListener("click", () => {
    const next = {};
    ["longitude", "latitude", "zoom", "pitch", "bearing"].forEach(key => {
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
        button.addEventListener("click", () => flyTo({ latitude: items[Number(button.dataset.searchIndex)].latitude, longitude: items[Number(button.dataset.searchIndex)].longitude, zoom: 19, pitch: 30 }));
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

  document.querySelector("#shadow-toggle").addEventListener("change", event => {
    shadowEnabled = event.target.checked;
    refreshLayers();
  });

  document.querySelector("#underground-toggle").addEventListener("change", event => {
    undergroundViewEnabled = event.target.checked;
    updateUndergroundView();
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
      pitch: -viewer.camera.pitch * 180 / Math.PI,
      bearing: 0,
    });
  });

  document.querySelector("#top-down-button").addEventListener("click", () => {
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    flyTo({
      latitude: c.latitude * 180 / Math.PI,
      longitude: c.longitude * 180 / Math.PI,
      height: c.height,
      pitch: 0,
      bearing: viewer.camera.heading * 180 / Math.PI,
    });
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
    const pitch = Number(-viewer.camera.pitch * 180 / Math.PI).toFixed(2);
    const bearing = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
    const height = Number(c.height).toFixed(1);
    const url = `${window.location.origin}${window.location.pathname}?longitude=${lon}&latitude=${lat}&pitch=${pitch}&bearing=${bearing}&height=${height}&project=${encodeURIComponent(currentProjectId)}`;
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
  } catch (error) {
    document.querySelector("#version-status").textContent = `自動インストールエラー: ${error.message}`;
    button.disabled = false;
  }
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
cam:東京駅|35.653108|139.761449|h=2200.6|p=-30|d=348.5`;

document.querySelector("#current-port").value = window.location.port || (window.location.protocol === "https:" ? "443" : "8510");
setupEvents();
setupThreeJs();
applyInspector(defaultConfig);
if (cameraPresets.length) flyTo(cameraPresets[0]);
renderPresets();
(async () => {
  try { await loadProjects(); } catch (e) { console.error(e); }
  try { await loadInspectorConfig(); } catch (e) { console.error(e); }
  try { await loadUpdateInfo(); } catch (e) { console.error(e); }
})();
