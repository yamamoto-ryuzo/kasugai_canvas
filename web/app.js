import * as THREE from "three";

const { Deck, MapView, TerrainLayer, TileLayer, BitmapLayer } = window.deck;
const deckContainer = document.querySelector("#deck-container");

const origin = [139.7671, 35.6812];
const urlParams = new URLSearchParams(window.location.search);
const numberParam = (name, fallback) => {
  const value = Number(urlParams.get(name));
  return Number.isFinite(value) ? value : fallback;
};
const basemaps = [
  {
    id: "osm",
    title: "OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
  },
  {
    id: "gsi",
    title: "国土地理院 標準地図",
    url: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",
    attribution: "© Geospatial Information Authority of Japan",
  },
];

const layerState = new Map([
  ["terrain", { id: "terrain", title: "Terrain", visible: true, type: "terrain" }],
  ["basemap", { id: "basemap", title: "Basemap", visible: true, type: "basemap" }],
  ["three-model", { id: "three-model", title: "Three.js model", visible: true, type: "three" }],
]);
const tileLayers = [];
const cameraPresets = [
  { title: "東京駅", longitude: 139.7671, latitude: 35.6812, zoom: 14, pitch: 45, bearing: 0 },
  { title: "富士山", longitude: 138.7274, latitude: 35.3606, zoom: 10, pitch: 45, bearing: 0 },
];

let selectedBasemap = basemaps[0];
let viewState = {
  longitude: numberParam("longitude", origin[0]),
  latitude: numberParam("latitude", origin[1]),
  zoom: numberParam("zoom", 14),
  pitch: numberParam("pitch", 45),
  bearing: numberParam("bearing", 0),
};
let threeRenderer;
let threeScene;
let threeCamera;
let threeModel;

function createMapLayers() {
  const layers = [];
  if (layerState.get("basemap").visible && !layerState.get("terrain").visible) {
    layers.push(new TileLayer({
      id: "basemap",
      data: selectedBasemap.url,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      renderSubLayers: props => new BitmapLayer({
        ...props,
        id: `${props.id}-bitmap`,
        image: props.data,
        bounds: props.tile.bbox.west
          ? [props.tile.bbox.west, props.tile.bbox.south, props.tile.bbox.east, props.tile.bbox.north]
          : undefined,
      }),
    }));
  }
  if (layerState.get("terrain").visible) {
    layers.push(new TerrainLayer({
      id: "terrain",
      elevationData: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      texture: layerState.get("basemap").visible ? selectedBasemap.url : undefined,
      elevationDecoder: { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 },
      minZoom: 0,
      maxZoom: 14,
      tileSize: 256,
      meshMaxError: 10,
      color: [255, 255, 255],
      material: {
        ambient: 1,
        diffuse: 0,
        shininess: 0,
        specularColor: [0, 0, 0],
      },
      visible: layerState.get("terrain").visible,
    }));
  }
  tileLayers.forEach(item => {
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
        image: props.data,
        bounds: [props.tile.bbox.west, props.tile.bbox.south, props.tile.bbox.east, props.tile.bbox.north],
        opacity: item.opacity,
      }),
    }));
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
    threeModel.visible = layerState.get("three-model").visible;
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

function renderLayerList() {
  const list = document.querySelector("#layer-list");
  list.innerHTML = [...layerState.values(), ...tileLayers].map(layer => `
    <label class="layer-row">
      <input type="checkbox" data-layer-id="${layer.id}" ${layer.visible ? "checked" : ""}>
      <span>${layer.title}</span>
      <small>${layer.type === "tile" ? "Tile" : "System"}</small>
    </label>
  `).join("");
  list.querySelectorAll("input").forEach(input => {
    input.addEventListener("change", () => {
      const layer = layerState.get(input.dataset.layerId) || tileLayers.find(item => item.id === input.dataset.layerId);
      if (!layer) return;
      layer.visible = input.checked;
      refreshLayers();
    });
  });
}

function updateCameraInputs() {
  ["longitude", "latitude", "zoom", "pitch", "bearing"].forEach(key => {
    const input = document.querySelector(`#camera-${key}`);
    if (input && document.activeElement !== input) input.value = Number(viewState[key]).toFixed(4);
  });
  const status = document.querySelector("#view-status");
  if (status) {
    status.textContent =
      `緯度 ${viewState.latitude.toFixed(6)}  経度 ${viewState.longitude.toFixed(6)}  ` +
      `ズーム ${viewState.zoom.toFixed(2)}  傾き ${viewState.pitch.toFixed(1)}°  方位 ${viewState.bearing.toFixed(1)}°`;
  }
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

function renderPresets() {
  document.querySelector("#camera-presets").innerHTML = cameraPresets.map((preset, index) =>
    `<button class="preset-button" data-preset="${index}">${preset.title}</button>`,
  ).join("");
  document.querySelectorAll("[data-preset]").forEach(button => {
    button.addEventListener("click", () => flyTo(cameraPresets[Number(button.dataset.preset)]));
  });
}

document.querySelector("#basemap-select").innerHTML = basemaps
  .map(item => `<option value="${item.id}">${item.title}</option>`).join("");
document.querySelector("#basemap-select").addEventListener("change", event => {
  selectedBasemap = basemaps.find(item => item.id === event.target.value) || basemaps[0];
  document.querySelector("#map-attribution").textContent = selectedBasemap.attribution;
  refreshLayers();
});
document.querySelector("#add-tile-form").addEventListener("submit", event => {
  event.preventDefault();
  const title = document.querySelector("#tile-title").value.trim();
  const url = document.querySelector("#tile-url").value.trim();
  if (!title || !url) return;
  tileLayers.push({ id: `tile-${Date.now()}`, title, url, visible: true, type: "tile", opacity: 0.8 });
  event.target.reset();
  renderLayerList();
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
document.querySelector("#terrain-toggle").addEventListener("change", event => {
  layerState.get("terrain").visible = event.target.checked;
  refreshLayers();
  renderLayerList();
});
document.querySelector("#compass-button").addEventListener("click", () => flyTo({ bearing: 0 }));
document.querySelector("#top-down-button").addEventListener("click", () => flyTo({ pitch: 0 }));

renderLayerList();
renderPresets();
updateCameraInputs();
