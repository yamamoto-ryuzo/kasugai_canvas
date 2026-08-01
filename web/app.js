import * as THREE from "three";

const { Deck, MapView, TerrainLayer, TileLayer, BitmapLayer, GeoJsonLayer, Tile3DLayer } = window.deck;
const TerrainExtension = window.deck.TerrainExtension || window.deck._TerrainExtension;
const deckContainer = document.querySelector("#deck-container");

const origin = [0, 0];
const inspectorDefault = "";
const urlParams = new URLSearchParams(window.location.search);
const numberParam = (name, fallback) => {
  const value = Number(urlParams.get(name));
  return Number.isFinite(value) ? value : fallback;
};
const basemaps = [];

const layerState = new Map([
  ["terrain", { id: "terrain", title: "Terrain", visible: false, type: "terrain" }],
  ["basemap", { id: "basemap", title: "Basemap", visible: false, type: "basemap" }],
]);
const tileLayers = [];
let layerOrder = [...layerState.keys()].filter(id => id !== "basemap");
const cameraPresets = [];

let selectedBasemap;
let terrainSource = "none";
const drapeLayers = {
  xyz: false,
  basemap: false,
  geojson: false,
};
let yahooAppId = "";
let shadowEnabled = false;
let viewState = {
  longitude: numberParam("longitude", origin[0]),
  latitude: numberParam("latitude", origin[1]),
  zoom: numberParam("zoom", 2),
  pitch: numberParam("pitch", 0),
  bearing: numberParam("bearing", 0),
};
let threeRenderer;
let threeScene;
let threeCamera;
let threeModel;

function getDrapeProps(layerType) {
  const hasDemSource = layerState.get("terrain").visible &&
    (terrainSource === "dem" || terrainSource === "both");
  const has3DTilesSource = (terrainSource === "3dtiles" || terrainSource === "both") &&
    getOrderedLayerItems().some(item => item.visible && item.type === "3dtiles" && item.url);
  return drapeLayers[layerType] && TerrainExtension && (hasDemSource || has3DTilesSource)
    ? { extensions: [new TerrainExtension()], terrainDrawMode: "drape" }
    : {};
}

function createMapLayers() {
  const layers = [];
  if (TerrainExtension && GeoJsonLayer) {
    layers.push(new GeoJsonLayer({
      id: "terrain-effect-bootstrap",
      data: [],
      visible: false,
      extensions: [new TerrainExtension()],
      terrainDrawMode: "drape",
    }));
  }
  const basemapId = selectedBasemap?.id || "none";
  if (layerState.get("basemap").visible && selectedBasemap &&
    (!layerState.get("terrain").visible || terrainSource === "3dtiles" || terrainSource === "both")) {
    layers.push(new TileLayer({
      id: `basemap-${selectedBasemap.id}`,
      data: selectedBasemap.url,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      renderSubLayers: props => new BitmapLayer({
        ...props,
        id: `${props.id}-bitmap`,
        data: null,
        image: props.data,
        bounds: props.tile.bbox.west
          ? [props.tile.bbox.west, props.tile.bbox.south, props.tile.bbox.east, props.tile.bbox.north]
          : undefined,
        ...getDrapeProps("basemap"),
      }),
    }));
  }
  if (layerState.get("terrain").visible && (terrainSource === "dem" || terrainSource === "both")) {
    layers.push(new TerrainLayer({
      id: `terrain-${terrainSource}-${basemapId}`,
      elevationData: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      texture: layerState.get("basemap").visible && terrainSource === "dem"
        ? selectedBasemap?.url
        : undefined,
      elevationDecoder: { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 },
      minZoom: 0,
      maxZoom: 14,
      tileSize: 256,
      meshMaxError: 10,
      operation: "terrain+draw",
      color: [255, 255, 255],
      material: {
        ambient: shadowEnabled ? 0.35 : 1,
        diffuse: shadowEnabled ? 0.65 : 0,
        shininess: shadowEnabled ? 8 : 0,
        specularColor: [0, 0, 0],
      },
      visible: layerState.get("terrain").visible,
    }));
  }
  getOrderedLayerItems().filter(item => item.type === "tile").forEach(item => {
    if (!item.visible) return;
    layers.push(new TileLayer({
      id: item.id,
      data: item.url,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      renderSubLayers: props => new BitmapLayer({
        ...props,
        id: `${props.id}-bitmap`,
        data: null,
        image: props.data,
        bounds: [props.tile.bbox.west, props.tile.bbox.south, props.tile.bbox.east, props.tile.bbox.north],
        opacity: item.opacity,
        ...getDrapeProps("xyz"),
      }),
    }));
  });
  const orderedItems = getOrderedLayerItems().sort((left, right) => {
    if (terrainSource !== "3dtiles" && terrainSource !== "both") return 0;
    return Number(right.type === "3dtiles") - Number(left.type === "3dtiles");
  });
  orderedItems.forEach(item => {
    if (item.type === "tile" || item.type === "terrain" || item.type === "basemap" || item.type === "three") return;
    if (!item.visible || !item.url) return;
    if (item.type === "geojson") {
      layers.push(new GeoJsonLayer({
        id: item.id,
        data: item.url,
        filled: true,
        stroked: true,
        getFillColor: [70, 125, 156, 35],
        getLineColor: [45, 90, 110, 210],
        getLineWidth: 2,
        lineWidthMinPixels: 1,
        ...getDrapeProps("geojson"),
        pickable: true,
        onClick: info => showAttribute(info.object),
      }));
    }
    if (item.type === "3dtiles" && Tile3DLayer) {
      const isTerrainSource = terrainSource === "3dtiles" || terrainSource === "both";
      layers.push(new Tile3DLayer({
        data: item.url,
        id: isTerrainSource
          ? `${item.id}-terrain-source`
          : item.id,
        operation: isTerrainSource
          ? "terrain+draw"
          : "draw",
        pickable: "3d",
        onClick: info => showAttribute(info.object),
        onTilesetLoad: tileset => {
          const layer = layerState.get(item.id);
          if (layer) layer.status = `loaded (${tileset?.asset?.version || "3D Tiles"})`;
          renderLayerList();
        },
        onTileError: error => {
          const layer = layerState.get(item.id);
          if (layer) layer.status = `error: ${error?.message || "tile load failed"}`;
          renderLayerList();
          console.error(`3D Tiles load failed: ${item.url}`, error);
        },
      }));
    } else if (item.type === "3dtiles" && !Tile3DLayer) {
      item.status = "Tile3DLayer is not available in the deck.gl bundle";
      renderLayerList();
    }
  });
  return layers;
}

const deck = new Deck({
  parent: deckContainer,
  views: new MapView({ repeat: false }),
  initialViewState: viewState,
  controller: { dragRotate: true, touchRotate: true, scrollZoom: true, doubleClickZoom: true, minPitch: 0, maxPitch: 179 },
  onViewStateChange: ({ viewState: next }) => {
    viewState = { ...viewState, ...next };
    deck.setProps({ viewState });
    updateCameraInputs();
  },
  onWebGLInitialized: gl => {
    threeRenderer = new THREE.WebGLRenderer({ canvas: gl.canvas, context: gl, alpha: true });
    threeRenderer.autoClear = false;
    threeRenderer.setPixelRatio(1);
    threeScene = new THREE.Scene();
    threeScene.add(new THREE.HemisphereLight(0xffffff, 0x668080, 2.2));
    threeModel = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x168f84, roughness: 0.6, metalness: 0.1 }),
    );
    threeScene.add(threeModel);
    threeCamera = new THREE.Camera();
    threeCamera.matrixAutoUpdate = false;
  },
  onAfterRender: () => {
    if (!threeRenderer || !threeScene || !threeCamera || !threeModel) return;
    const viewport = deck.getViewports()[0];
    if (!viewport) return;
    threeRenderer.setViewport(0, 0, viewport.width, viewport.height);
    threeRenderer.resetState();
    threeCamera.matrixWorldInverse.fromArray(viewport.viewMatrix);
    threeCamera.matrixWorld.copy(threeCamera.matrixWorldInverse).invert();
    threeCamera.projectionMatrix.fromArray(viewport.projectionMatrix);
    threeCamera.projectionMatrixInverse.copy(threeCamera.projectionMatrix).invert();
    threeModel.visible = Boolean(layerState.get("three-model")?.visible);
    threeModel.position.fromArray(viewport.projectPosition([origin[0], origin[1], 18]));
    threeModel.scale.setScalar(0.00035);
    threeModel.rotation.y = 0.6;
    threeRenderer.render(threeScene, threeCamera);
  },
  layers: createMapLayers(),
});

function refreshLayers() {
  deck.setProps({ layers: createMapLayers() });
}

function parseLayerTitle(title) {
  const parts = title.split(/[\\/]/).map(part => part.trim()).filter(Boolean);
  return {
    title: parts.at(-1) || title,
    group: parts.slice(0, -1).join(" / "),
    exclusiveGroup: /[\\/]{2}/.test(title),
  };
}

function getOrderedLayerItems() {
  const items = [...layerState.values(), ...tileLayers].filter(layer => layer.id !== "basemap");
  const byId = new Map(items.map(layer => [layer.id, layer]));
  layerOrder = [...layerOrder.filter(id => byId.has(id)), ...items.map(item => item.id).filter(id => !layerOrder.includes(id))];
  return layerOrder.map(id => byId.get(id)).filter(Boolean);
}

function renderLayerList() {
  const list = document.querySelector("#layer-list");
  const groupedLayers = new Map();
  getOrderedLayerItems().filter(layer => layer.id !== "terrain").forEach(layer => {
    const group = layer.group || "";
    if (!groupedLayers.has(group)) groupedLayers.set(group, []);
    groupedLayers.get(group).push(layer);
  });
  list.innerHTML = [...groupedLayers].map(([group, layers]) => `
    <div class="layer-group" data-group="${group}">
      ${group ? `<div class="layer-group-title">${group}</div>` : ""}
      ${layers.map(layer => `
    <div class="layer-row" draggable="true" data-layer-id="${layer.id}">
      <input type="checkbox" data-layer-id="${layer.id}" data-group="${layer.group || ""}" data-exclusive="${layer.exclusiveGroup ? "true" : "false"}" ${layer.visible ? "checked" : ""} ${layer.id === "google-photorealistic" || (layer.type === "3dtiles" && !Tile3DLayer) ? "disabled" : ""}>
      <span>${layer.title}</span>
      <small>${layer.status || (layer.type === "tile" ? "Tile" : layer.type)}</small>
    </div>
      `).join("")}
    </div>
  `).join("");
  list.querySelectorAll("input").forEach(input => {
    input.addEventListener("change", () => {
      const layer = layerState.get(input.dataset.layerId) || tileLayers.find(item => item.id === input.dataset.layerId);
      if (!layer) return;
      layer.visible = input.checked;
      if (input.checked && input.dataset.exclusive === "true" && input.dataset.group) {
        [...layerState.values(), ...tileLayers].forEach(other => {
          if (other !== layer && other.group === input.dataset.group) other.visible = false;
        });
        renderLayerList();
      }
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
    row.addEventListener("dragend", () => {
      draggedId = undefined;
      row.classList.remove("dragging");
    });
    row.addEventListener("dragover", event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", event => {
      event.preventDefault();
      const sourceId = draggedId || event.dataTransfer.getData("text/plain");
      const targetId = row.dataset.layerId;
      if (!sourceId || sourceId === targetId) return;
      const orderedLayers = getOrderedLayerItems();
      const sourceLayer = orderedLayers.find(item => item.id === sourceId);
      const targetLayer = orderedLayers.find(item => item.id === targetId);
      if (!sourceLayer || !targetLayer || sourceLayer.group !== targetLayer.group) return;
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
}

function updateCameraInputs() {
  ["longitude", "latitude", "zoom", "pitch", "bearing"].forEach(key => {
    const input = document.querySelector(`#camera-${key}`);
    if (input && document.activeElement !== input) input.value = Number(viewState[key]).toFixed(4);
  });
  const params = new URLSearchParams();
  ["longitude", "latitude", "zoom", "pitch", "bearing"].forEach(key => {
    params.set(key, Number(viewState[key]).toFixed(6));
  });
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
  const compass = document.querySelector("#compass-button");
  if (compass) compass.style.transform = `rotate(${-viewState.bearing}deg)`;
}

function flyTo(next) {
  viewState = { ...viewState, ...next };
  deck.setProps({ viewState });
  updateCameraInputs();
}

function showAttribute(object) {
  document.querySelector("#attr-content").textContent = object
    ? JSON.stringify(object, null, 2)
    : "属性情報がありません。";
}

function shareUrl() {
  return `${window.location.origin}${window.location.pathname}?${new URLSearchParams({
    longitude: viewState.longitude.toFixed(6),
    latitude: viewState.latitude.toFixed(6),
    zoom: viewState.zoom.toFixed(6),
    pitch: viewState.pitch.toFixed(6),
    bearing: viewState.bearing.toFixed(6),
  })}`;
}

function renderPresets() {
  document.querySelector("#camera-presets").innerHTML = cameraPresets.map((preset, index) =>
    `<button class="preset-button" data-preset="${index}">${preset.title}</button>`,
  ).join("");
  document.querySelectorAll("[data-preset]").forEach(button => {
    button.addEventListener("click", () => flyTo(cameraPresets[Number(button.dataset.preset)]));
  });
}

function renderBasemapSelector() {
  const select = document.querySelector("#basemap-select");
  select.innerHTML = [
    '<option value="">ベースマップなし</option>',
    ...basemaps.map(item => `<option value="${item.id}">${item.title}</option>`),
  ].join("");
  select.value = selectedBasemap?.id || "";
}

function applyInspector(text) {
  const nextLines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsedCameras = [];
  const parsedBasemaps = [];
  const inspectorLayerIds = new Set();
  const inspectorTileIds = new Set();
  yahooAppId = "";
  document.body.style.background = "";
  document.querySelector("#info-panel iframe").src = "about:blank";
  document.querySelector("#legend-panel img").removeAttribute("src");
  nextLines.forEach(line => {
    const separator = line.indexOf(":");
    if (separator < 0) return;
    const type = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (type === "background") document.body.style.background = value;
    if (type === "yahooappid") yahooAppId = value;
    if (type === "info") document.querySelector("#info-panel iframe").src = value;
    if (type === "legend") {
      const parts = value.split("|").map(part => part.trim());
      document.querySelector("#legend-panel img").src = parts[parts.length - 1];
    }
    if (type === "base") {
      const parts = value.split("|").map(part => part.trim());
      if (parts[0] && parts[1]) parsedBasemaps.push({
        id: `inspector-base-${parsedBasemaps.length}`,
        title: parts[0],
        url: parts[1],
        attribution: parts[2] || "",
      });
    }
    if (type === "cam") {
      const parts = value.split("|").map(part => part.trim());
      if (parts.length < 3) return;
      const camera = { title: parts[0], latitude: Number(parts[1]), longitude: Number(parts[2]), zoom: 12, pitch: 30, bearing: 0 };
      parts.slice(3).forEach(part => {
        const [key, raw] = part.split("=");
        const number = Number(raw);
        if (key === "p" && Number.isFinite(number)) camera.pitch = Math.abs(number);
        if (key === "d" && Number.isFinite(number)) camera.bearing = number;
        if (key === "h" && Number.isFinite(number)) {
          camera.height = number;
          camera.zoom = Math.max(1, Math.min(20, Math.log2(591657550 / number)));
        }
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
      const existing = tileLayers.find(item =>
        item.sourceTitle === title || item.title === title || item.url === url);
      if (existing) {
        existing.visible = !off;
        existing.title = displayTitle;
        existing.sourceTitle = title;
        existing.group = group;
        existing.exclusiveGroup = exclusiveGroup;
        inspectorTileIds.add(existing.id);
      } else {
        const id = `inspector-xyz-${title}-${url}`.replace(/[^a-zA-Z0-9_-]/g, "-");
        tileLayers.push({
          id,
          title: displayTitle,
          sourceTitle: title,
          url,
          visible: !off,
          type: "tile",
          opacity: 0.8,
          group,
          exclusiveGroup,
        });
        layerOrder.push(id);
        inspectorTileIds.add(id);
      }
      return;
    }
    if (type === "3dtiles" || type === "geojson" || type === "layer") {
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const url = parts[1];
      const off = parts.some(part => /^(off|false)$/i.test(part));
      if (!title) return;
      const id = `inspector-${type}-${title}-${url || "none"}`.replace(/[^a-zA-Z0-9_-]/g, "-");
      const { group, title: displayTitle, exclusiveGroup } = parseLayerTitle(title);
      const existing = [...layerState.values()].find(item =>
        item.sourceTitle === title || item.title === title || (item.type === type && url && item.url === url));
      if (existing) {
        existing.visible = !off;
        existing.url = url || existing.url;
        existing.group = group;
        existing.title = displayTitle;
        existing.sourceTitle = title;
        existing.exclusiveGroup = exclusiveGroup;
        inspectorLayerIds.add(existing.id);
      } else {
        layerState.set(id, {
          id,
          title: displayTitle,
          sourceTitle: title,
          visible: !off,
          type,
          url,
          group,
          exclusiveGroup,
        });
        layerOrder.push(id);
        inspectorLayerIds.add(id);
      }
    }
  });
  [...layerState.keys()].forEach(id => {
    if (id !== "terrain" && id !== "basemap" && !inspectorLayerIds.has(id)) layerState.delete(id);
  });
  tileLayers.splice(0, tileLayers.length, ...tileLayers.filter(item => inspectorTileIds.has(item.id)));
  basemaps.splice(0, basemaps.length, ...parsedBasemaps);
  selectedBasemap = basemaps[0];
  layerState.get("basemap").visible = Boolean(selectedBasemap);
  renderBasemapSelector();
  document.querySelector("#map-attribution").textContent = selectedBasemap?.attribution || "";
  cameraPresets.splice(0, cameraPresets.length, ...parsedCameras);
  renderPresets();
  renderLayerList();
  refreshLayers();
}

renderBasemapSelector();
document.querySelector("#basemap-select").addEventListener("change", event => {
  selectedBasemap = basemaps.find(item => item.id === event.target.value);
  layerState.get("basemap").visible = Boolean(selectedBasemap);
  document.querySelector("#map-attribution").textContent = selectedBasemap?.attribution || "";
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
    const endpoint = yahooAppId
      ? `https://map.yahooapis.jp/search/V1/LocalSearch?appid=${encodeURIComponent(yahooAppId)}&query=${encodeURIComponent(query)}&output=json`
      : `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
    const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`検索に失敗しました (${response.status})`);
    const data = await response.json();
    const items = yahooAppId ? (data.Feature || []).map(item => ({
      title: item.Name,
      latitude: Number(item.Geometry?.Coordinates?.split(",")[1]),
      longitude: Number(item.Geometry?.Coordinates?.split(",")[0]),
    })) : data.map(item => ({ title: item.display_name, latitude: Number(item.lat), longitude: Number(item.lon) }));
    results.innerHTML = items.filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
      .map((item, index) => `<button type="button" data-search-index="${index}">${item.title}</button>`).join("");
    results.querySelectorAll("[data-search-index]").forEach(button => {
      button.addEventListener("click", () => flyTo({ latitude: items[Number(button.dataset.searchIndex)].latitude, longitude: items[Number(button.dataset.searchIndex)].longitude, zoom: 15 }));
    });
  } catch (error) {
    results.textContent = error instanceof Error ? error.message : "検索に失敗しました。";
  }
});
document.querySelector("#copy-share-url").addEventListener("click", async () => {
  const url = shareUrl();
  document.querySelector("#share-url").value = url;
  await navigator.clipboard?.writeText(url);
});
document.querySelector("#terrain-toggle").addEventListener("change", event => {
  if (event.target.checked) {
    if (terrainSource === "none") terrainSource = "dem";
  } else {
    terrainSource = "none";
  }
  document.querySelector("#terrain-source").value = terrainSource;
  layerState.get("terrain").visible = terrainSource !== "none";
  refreshLayers();
  renderLayerList();
});
document.querySelector("#terrain-source").addEventListener("change", event => {
  terrainSource = event.target.value;
  layerState.get("terrain").visible = terrainSource !== "none";
  document.querySelector("#terrain-toggle").checked = terrainSource !== "none";
  refreshLayers();
  renderLayerList();
});
Object.entries(drapeLayers).forEach(([layerType]) => {
  document.querySelector(`#drape-${layerType}`).addEventListener("change", event => {
    drapeLayers[layerType] = event.target.checked;
    refreshLayers();
  });
});
document.querySelector("#shadow-toggle").addEventListener("change", event => {
  shadowEnabled = event.target.checked;
  refreshLayers();
});
const inspectorInput = document.querySelector("#inspector-input");
const inspectorStatus = document.querySelector("#inspector-status");

function setInspectorStatus(message, isError = false) {
  inspectorStatus.textContent = message;
  inspectorStatus.style.color = isError ? "#a82020" : "";
}

async function loadInspectorConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(await response.text());
    inspectorInput.value = await response.text();
    applyInspector(inspectorInput.value);
    setInspectorStatus("設定を読み込みました。");
  } catch (error) {
    console.error("インスペクター設定の読み込みに失敗しました。", error);
    setInspectorStatus(`設定を読み込めません: ${error instanceof Error ? error.message : error}`, true);
  }
}

async function saveInspectorConfig() {
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: inspectorInput.value,
  });
  if (!response.ok) throw new Error(await response.text());
}

inspectorInput.value = inspectorDefault;
document.querySelector("#apply-inspector").addEventListener("click", async () => {
  try {
    setInspectorStatus("設定を保存しています。");
    await saveInspectorConfig();
    applyInspector(inspectorInput.value);
    setInspectorStatus("設定を保存しました。");
  } catch (error) {
    console.error("インスペクター設定の保存に失敗しました。", error);
    setInspectorStatus(`設定を保存できません: ${error instanceof Error ? error.message : error}`, true);
  }
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
  ["click", "dblclick", "pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "dragstart", "contextmenu"].forEach(type => {
    panel.addEventListener(type, event => event.stopPropagation());
  });
});
document.querySelectorAll(".panel-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".panel-tab").forEach(item => item.classList.toggle("active", item === tab));
    document.querySelectorAll(".plugin-panel").forEach(panel => {
      panel.classList.toggle("active", panel.id === tab.dataset.panel);
    });
  });
});
document.querySelector("#compass-button").addEventListener("click", () => flyTo({ bearing: 0 }));
document.querySelector("#top-down-button").addEventListener("click", () => flyTo({ pitch: 0 }));

applyInspector(inspectorDefault);
renderPresets();
updateCameraInputs();
void loadInspectorConfig();
