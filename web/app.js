import * as THREE from "three";

const {
  Deck,
  MapView,
  TerrainLayer,
  TileLayer,
  BitmapLayer,
  GeoJsonLayer,
  Tile3DLayer,
  LayerExtension,
} = window.deck;
const TerrainExtension = window.deck.TerrainExtension || window.deck._TerrainExtension;
const deckContainer = document.querySelector("#deck-container");

const origin = [0, 0];
const inspectorDefault = "";
const minZoom = -20;
const maxZoom = 25;
const terrainMaxZoom = 20;
const terrainSampleZoom = 14;
const urlParams = new URLSearchParams(window.location.search);
const numberParam = (name, fallback) => {
  const value = Number(urlParams.get(name));
  return Number.isFinite(value) ? value : fallback;
};
const clampZoom = zoom => Math.min(maxZoom, Math.max(minZoom, zoom));
const basemaps = [];
const tileMaxZooms = new Map();
let tileZoomRefreshScheduled = false;

function getTileMaxZoom(url) {
  if (tileMaxZooms.has(url)) return tileMaxZooms.get(url);
  const hostname = new URL(url, window.location.href).hostname;
  if (hostname === "tile.openstreetmap.org") return 19;
  if (hostname === "cyberjapandata.gsi.go.jp") return 18;
  return maxZoom;
}

function lowerTileMaxZoom(url, zoom) {
  const nextMaxZoom = Math.max(0, zoom - 1);
  if (nextMaxZoom >= getTileMaxZoom(url)) return;
  tileMaxZooms.set(url, nextMaxZoom);
}

function scheduleTileZoomRefresh() {
  if (tileZoomRefreshScheduled) return;
  tileZoomRefreshScheduled = true;
  requestAnimationFrame(() => {
    tileZoomRefreshScheduled = false;
    refreshLayers();
  });
}

function createAdaptiveTileData(urlTemplate) {
  return async ({url, signal, index}) => {
    let response;
    try {
      response = await fetch(url, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      lowerTileMaxZoom(urlTemplate, index.z);
      scheduleTileZoomRefresh();
      return null;
    }
    if ([400, 404, 416].includes(response.status)) {
      lowerTileMaxZoom(urlTemplate, index.z);
      scheduleTileZoomRefresh();
      return null;
    }
    if (!response.ok) throw new Error(`Tile request failed (${response.status}): ${url}`);
    return createImageBitmap(await response.blob());
  };
}

const layerState = new Map([
  ["terrain", { id: "terrain", title: "Terrain", visible: true, type: "terrain" }],
  ["basemap", { id: "basemap", title: "Basemap", visible: false, type: "basemap" }],
]);
const tileLayers = [];
let layerOrder = [...layerState.keys()].filter(id => id !== "basemap");
const cameraPresets = [];
const demSources = {
  terrarium: {
    title: "Terrarium DEM (AWS, zoom 15)",
    elevationData: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    elevationDecoder: { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 },
    tileSize: 256,
  },
  reearth: {
    title: "Re:Earth Terrain (標高 / MSL, zoom 19)",
    elevationData: "https://terrain.reearth.land/terrarium/elevation/{z}/{x}/{y}.png",
    elevationDecoder: { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 },
    tileSize: 512,
    attribution: "Re:Earth Terrain · Mapterhorn (CC BY 4.0)",
  },
  "reearth-ellipsoid": {
    title: "Re:Earth Terrain (楕円体高 / WGS84, zoom 19)",
    elevationData: "https://terrain.reearth.land/terrarium/ellipsoid/{z}/{x}/{y}.png",
    elevationDecoder: { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 },
    tileSize: 512,
    attribution: "Re:Earth Terrain · Mapterhorn (CC BY 4.0)",
  },
};

let selectedBasemap;
let selectedDemSource = "reearth-ellipsoid";
const terrainFollowState = {
  requestId: 0,
  sampleKey: "",
  tileCache: new Map(),
};
const drapeTerrainSources = {
  dem: true,
  tiles3d: true,
};
const drapeLayers = {
  xyz: true,
  geojson: true,
};
let yahooAppId = "";
let shadowEnabled = false;
let basemapDrape3DTiles = false;
let deck;
let viewState = {
  longitude: numberParam("longitude", origin[0]),
  latitude: numberParam("latitude", origin[1]),
  zoom: clampZoom(numberParam("zoom", 2)),
  pitch: numberParam("pitch", 0),
  bearing: numberParam("bearing", 0),
  minZoom,
  maxZoom,
};
let threeRenderer;
let threeScene;
let threeCamera;
let threeModel;

function formatTileUrl(template, index) {
  return template
    .replaceAll("{z}", String(index.z))
    .replaceAll("{x}", String(index.x))
    .replaceAll("{y}", String(index.y));
}

const directXYZDrapeModule = {
  name: "directXYZDrape",
  vs: `
layout(std140) uniform directXYZDrapeUniforms {
  bool enabled;
  vec2 origin;
  vec2 grid;
  float zoom;
} directXYZDrape;
out vec2 directXYZDrapeUV;
out float directXYZDrapeVisible;
`,
  fs: `
precision highp float;
in vec2 directXYZDrapeUV;
in float directXYZDrapeVisible;
uniform sampler2D directXYZDrapeTexture;
`,
  uniformTypes: {
    enabled: "i32",
    origin: "vec2<f32>",
    grid: "vec2<f32>",
    zoom: "f32",
  },
  getUniforms: props => props || {},
  inject: {
    "vs:#main-end": `
      vec2 directXYZDrapeWorld = vec2(
        (geometry.position.x + project.commonOrigin.x) / 512.0,
        1.0 - (geometry.position.y + project.commonOrigin.y) / 512.0
      );
      vec2 directXYZDrapeTile = directXYZDrapeWorld * exp2(directXYZDrape.zoom);
      vec2 directXYZDrapeAtlasTile = floor(directXYZDrapeTile) - directXYZDrape.origin;
      directXYZDrapeVisible = float(
        directXYZDrape.enabled &&
        all(greaterThanEqual(directXYZDrapeAtlasTile, vec2(0.0))) &&
        all(lessThan(directXYZDrapeAtlasTile, directXYZDrape.grid))
      );
      directXYZDrapeUV = vec2(
        (directXYZDrapeAtlasTile.x + fract(directXYZDrapeTile.x)) / directXYZDrape.grid.x,
        1.0 - (directXYZDrapeAtlasTile.y + fract(directXYZDrapeTile.y)) / directXYZDrape.grid.y
      );
    `,
    "fs:DECKGL_FILTER_COLOR": `
      if (directXYZDrapeVisible > 0.5) {
        vec4 directXYZDrapeColor = texture(directXYZDrapeTexture, directXYZDrapeUV);
        color.rgb = mix(color.rgb, directXYZDrapeColor.rgb, directXYZDrapeColor.a);
      }
    `,
  },
};

class DirectXYZDrapeAtlas {
  constructor() {
    this.device = null;
    this.texture = null;
    this.enabled = false;
    this.origin = [0, 0];
    this.grid = [1, 1];
    this.zoom = 0;
    this.source = null;
    this.viewState = null;
    this.key = "";
    this.generation = 0;
    this.abortController = null;
  }

  setDevice(device) {
    if (this.device === device) return;
    this.texture?.destroy();
    this.device = device;
    this.texture = this.createTexture(1, 1, new Uint8Array([0, 0, 0, 0]));
    this.key = "";
    this.update();
  }

  createTexture(width, height, data) {
    return this.device.createTexture({
      id: "direct-xyz-drape-atlas",
      width,
      height,
      format: "rgba8unorm",
      data,
      sampler: {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "nearest",
      },
    });
  }

  request(source, nextViewState) {
    this.source = source || null;
    this.viewState = nextViewState || null;
    this.update();
  }

  disable() {
    if (!this.enabled && !this.abortController) return;
    this.enabled = false;
    this.abortController?.abort();
    this.abortController = null;
    this.generation += 1;
    deck?.redraw(true);
  }

  getShaderProps() {
    return {
      enabled: this.enabled ? 1 : 0,
      origin: this.origin,
      grid: this.grid,
      zoom: this.zoom,
      directXYZDrapeTexture: this.texture,
    };
  }

  update() {
    if (!this.device || !this.source || !this.viewState) return;
    const sourceMaxZoom = this.source.maxZoom ?? getTileMaxZoom(this.source.url);
    const zoom = Math.max(0, Math.min(sourceMaxZoom, Math.ceil(this.viewState.zoom)));
    const scale = 2 ** zoom;
    const centerX = Math.floor((this.viewState.longitude + 180) / 360 * scale);
    const latitude = Math.max(-85.05112878, Math.min(85.05112878, this.viewState.latitude));
    const sine = Math.sin(latitude * Math.PI / 180);
    const centerY = Math.floor(
      (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale,
    );
    const maxTextureSize = this.device.limits?.maxTextureDimension2D || 4096;
    const gridSize = Math.max(
      1,
      Math.min(6, scale, Math.floor(maxTextureSize / this.source.tileSize)),
    );
    const startX = centerX - Math.floor(gridSize / 2);
    const startY = Math.max(0, Math.min(scale - gridSize, centerY - Math.floor(gridSize / 2)));
    const key = [
      this.source.url,
      this.source.tileSize,
      zoom,
      startX,
      startY,
      gridSize,
    ].join(":");
    if (key === this.key) return;
    this.key = key;
    this.enabled = false;
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    const generation = ++this.generation;
    void this.build(
      { source: this.source, zoom, scale, startX, startY, gridSize },
      abortController.signal,
      generation,
    );
  }

  async build({ source, zoom, scale, startX, startY, gridSize }, signal, generation) {
    const size = source.tileSize * gridSize;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Direct XYZ drape canvas is unavailable");

    const tiles = [];
    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize; x += 1) {
        const tileX = ((startX + x) % scale + scale) % scale;
        const tileY = startY + y;
        const url = formatTileUrl(source.url, { x: tileX, y: tileY, z: zoom });
        tiles.push({ x, y, url });
      }
    }
    const images = await Promise.all(tiles.map(async tile => {
      try {
        const response = await fetch(tile.url, { signal });
        if (!response.ok) return null;
        return { ...tile, image: await createImageBitmap(await response.blob()) };
      } catch (error) {
        if (signal.aborted) return null;
        console.warn(`BASEMAP direct drape tile failed: ${tile.url}`, error);
        return null;
      }
    }));
    if (signal.aborted || generation !== this.generation) {
      images.forEach(tile => tile?.image.close());
      return;
    }
    images.forEach(tile => {
      if (!tile) return;
      context.drawImage(
        tile.image,
        tile.x * source.tileSize,
        tile.y * source.tileSize,
        source.tileSize,
        source.tileSize,
      );
      tile.image.close();
    });
    const texture = this.createTexture(size, size, canvas);
    if (signal.aborted || generation !== this.generation) {
      texture.destroy();
      return;
    }
    this.texture?.destroy();
    this.texture = texture;
    this.origin = [startX, startY];
    this.grid = [gridSize, gridSize];
    this.zoom = zoom;
    this.enabled = true;
    deck?.redraw(true);
  }
}

const directXYZDrapeAtlas = new DirectXYZDrapeAtlas();
const directXYZDrapeSupported = Boolean(LayerExtension && Tile3DLayer);
const DirectXYZDrapeExtension = LayerExtension && class extends LayerExtension {
  static extensionName = "DirectXYZDrapeExtension";

  getShaders() {
    return { modules: [directXYZDrapeModule] };
  }

  initializeState(context) {
    directXYZDrapeAtlas.setDevice(context.device);
  }

  draw() {
    this.setShaderModuleProps({ directXYZDrape: directXYZDrapeAtlas.getShaderProps() });
  }
};

function getTerrainTileIndex(longitude, latitude) {
  const scale = 2 ** terrainSampleZoom;
  const x = Math.min(scale - 1, Math.max(0, Math.floor((longitude + 180) / 360 * scale)));
  const sine = Math.sin(latitude * Math.PI / 180);
  const y = Math.min(
    scale - 1,
    Math.max(0, Math.floor((0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale)),
  );
  const pixelX = ((longitude + 180) / 360 * scale - x);
  const pixelY = ((0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale - y);
  return { x, y, z: terrainSampleZoom, pixelX, pixelY };
}

async function getTerrainTilePixels(source, index) {
  const url = formatTileUrl(source.elevationData, index);
  const cached = terrainFollowState.tileCache.get(url);
  if (cached) return cached;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`DEM tile request failed (${response.status}): ${url}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  canvas.width = source.tileSize;
  canvas.height = source.tileSize;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("DEM sample canvas is unavailable");
  context.drawImage(bitmap, 0, 0, source.tileSize, source.tileSize);
  bitmap.close();
  const pixels = context.getImageData(0, 0, source.tileSize, source.tileSize);
  if (terrainFollowState.tileCache.size >= 32) {
    terrainFollowState.tileCache.delete(terrainFollowState.tileCache.keys().next().value);
  }
  terrainFollowState.tileCache.set(url, pixels);
  return pixels;
}

async function updateTerrainFollow(next = viewState) {
  if (!layerState.get("terrain").visible) return;
  const source = demSources[selectedDemSource];
  if (!source) return;
  const index = getTerrainTileIndex(next.longitude, next.latitude);
  const sampleX = Math.min(source.tileSize - 1, Math.floor(index.pixelX * source.tileSize));
  const sampleY = Math.min(source.tileSize - 1, Math.floor(index.pixelY * source.tileSize));
  const sampleKey = `${selectedDemSource}:${index.x}:${index.y}:${Math.floor(sampleX / 16)}:${Math.floor(sampleY / 16)}`;
  if (sampleKey === terrainFollowState.sampleKey) return;
  terrainFollowState.sampleKey = sampleKey;
  const requestId = ++terrainFollowState.requestId;
  try {
    const pixels = await getTerrainTilePixels(source, index);
    if (requestId !== terrainFollowState.requestId) return;
    const offset = (sampleY * pixels.width + sampleX) * 4;
    const elevation = pixels.data[offset] * 256 +
      pixels.data[offset + 1] +
      pixels.data[offset + 2] / 256 - 32768;
    if (!Number.isFinite(elevation)) throw new Error("DEM sample is not a finite elevation");
    viewState = { ...viewState, position: [0, 0, elevation] };
    deck.setProps({ viewState });
  } catch (error) {
    if (requestId !== terrainFollowState.requestId) return;
    terrainFollowState.sampleKey = "";
    console.error("地形追従用DEMの取得に失敗しました。", error);
  }
}

function clearTerrainFollow() {
  terrainFollowState.requestId += 1;
  terrainFollowState.sampleKey = "";
  viewState = { ...viewState };
  delete viewState.position;
  deck.setProps({ viewState });
}

function updateMapAttribution() {
  const credits = [selectedBasemap?.attribution];
  const demSource = demSources[selectedDemSource];
  if (layerState.get("terrain").visible && demSource?.attribution) credits.push(demSource.attribution);
  document.querySelector("#map-attribution").textContent = credits.filter(Boolean).join(" | ");
}

function createMapLayers() {
  const layers = [];
  const demSource = demSources[selectedDemSource];
  const basemapId = selectedBasemap?.id || "none";
  const terrainVisible = layerState.get("terrain").visible;
  const orderedItems = getOrderedLayerItems();
  const usesDem = drapeTerrainSources.dem;
  const uses3DTiles = drapeTerrainSources.tiles3d;
  const hasDemSource = usesDem && terrainVisible;
  const has3DTilesSource = uses3DTiles &&
    orderedItems.some(item => item.visible && item.type === "3dtiles" && item.url);
  const hasBasemap3DTilesSource = basemapDrape3DTiles &&
    orderedItems.some(item => item.visible && item.type === "3dtiles" && item.url);
  const has3DTilesTerrainSource = has3DTilesSource;
  const hasDrapeSource = hasDemSource || has3DTilesSource;
  const basemapUses3DTiles = Boolean(
    layerState.get("basemap").visible &&
    selectedBasemap &&
    hasBasemap3DTilesSource &&
    directXYZDrapeSupported,
  );
  if (basemapUses3DTiles) directXYZDrapeAtlas.request(selectedBasemap, viewState);
  else directXYZDrapeAtlas.disable();
  const isDrapeTarget = layerType =>
    Boolean(drapeLayers[layerType] && hasDrapeSource && TerrainExtension);
  const getDrapeProps = layerType => isDrapeTarget(layerType)
    ? { extensions: [new TerrainExtension()], terrainDrawMode: "drape" }
    : {};
  const getDrapeLayerId = (id, layerType) =>
    `${id}-${isDrapeTarget(layerType) ? "drape" : "plain"}`;
  const create3DTilesLayer = item => {
    if (!Tile3DLayer) {
      item.status = "Tile3DLayer is not available in the deck.gl bundle";
      return null;
    }
    return new Tile3DLayer({
      data: item.url,
      id: has3DTilesTerrainSource
        ? `${item.id}-terrain-source`
        : item.id,
      operation: has3DTilesTerrainSource
        ? "terrain+draw"
        : "draw",
      pickable: "3d",
      ...(basemapUses3DTiles ? { extensions: [new DirectXYZDrapeExtension()] } : {}),
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
    });
  };
  const createBasemapLayer = () => new TileLayer({
    id: `basemap-${selectedBasemap.id}-plain`,
    data: selectedBasemap.url,
    minZoom,
    maxZoom: selectedBasemap.maxZoom ?? getTileMaxZoom(selectedBasemap.url),
    getTileData: createAdaptiveTileData(selectedBasemap.url),
    tileSize: selectedBasemap.tileSize,
    refinementStrategy: "best-available",
    renderSubLayers: props => new BitmapLayer({
      ...props,
      id: `${props.id}-bitmap`,
      data: null,
      image: props.data,
      bounds: props.tile.bbox.west
        ? [props.tile.bbox.west, props.tile.bbox.south, props.tile.bbox.east, props.tile.bbox.north]
        : undefined,
    }),
  });
  if (layerState.get("basemap").visible && selectedBasemap && !terrainVisible && !basemapUses3DTiles) {
    layers.push(createBasemapLayer());
  }
  if (terrainVisible) {
    layers.push(new TerrainLayer({
      id: `terrain-${selectedDemSource}-${basemapId}`,
      elevationData: demSource.elevationData,
      texture: layerState.get("basemap").visible
        ? selectedBasemap?.url
        : undefined,
      elevationDecoder: demSource.elevationDecoder,
      minZoom,
      maxZoom: terrainMaxZoom,
      tileSize: demSource.tileSize,
      meshMaxError: 10,
      operation: hasDemSource
        ? "terrain+draw"
        : "draw",
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
  orderedItems.forEach(item => {
    if (item.type === "terrain" || item.type === "basemap" || item.type === "three") return;
    if (!item.visible || !item.url) return;
    if (item.type === "3dtiles") {
      const layer = create3DTilesLayer(item);
      if (layer) layers.push(layer);
      return;
    }
    if (item.type === "tile") {
      layers.push(new TileLayer({
        id: getDrapeLayerId(item.id, "xyz"),
        data: item.url,
        minZoom,
        maxZoom: getTileMaxZoom(item.url),
        getTileData: createAdaptiveTileData(item.url),
        tileSize: 256,
        refinementStrategy: "best-available",
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
      return;
    }
    if (item.type === "geojson") {
      layers.push(new GeoJsonLayer({
        id: getDrapeLayerId(item.id, "geojson"),
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
  });
  return layers;
}

deck = new Deck({
  parent: deckContainer,
  views: new MapView({ repeat: false }),
  initialViewState: viewState,
  controller: { dragRotate: true, touchRotate: true, scrollZoom: true, doubleClickZoom: true, minPitch: 0, maxPitch: 179 },
  onViewStateChange: ({ viewState: next }) => {
    const nextViewState = {
      ...viewState,
      ...next,
      zoom: clampZoom(next.zoom ?? viewState.zoom),
    };
    const changed = ["longitude", "latitude", "zoom", "pitch", "bearing"].some(
      key => nextViewState[key] !== viewState[key],
    );
    viewState = nextViewState;
    if (changed) deck.setProps({ viewState: nextViewState });
    updateCameraInputs();
    void updateTerrainFollow(viewState);
    if (basemapDrape3DTiles) directXYZDrapeAtlas.request(selectedBasemap, viewState);
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
    <label class="layer-row" draggable="true" data-layer-id="${layer.id}">
      <input type="checkbox" data-layer-id="${layer.id}" data-group="${layer.group || ""}" data-exclusive="${layer.exclusiveGroup ? "true" : "false"}" ${layer.visible ? "checked" : ""} ${layer.id === "google-photorealistic" || (layer.type === "3dtiles" && !Tile3DLayer) ? "disabled" : ""}>
      <span>${layer.title}</span>
      <small>${layer.status || (layer.type === "tile" ? "Tile" : layer.type)}</small>
    </label>
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
  viewState = {
    ...viewState,
    ...next,
    zoom: clampZoom(next.zoom ?? viewState.zoom),
  };
  deck.setProps({ viewState });
  updateCameraInputs();
  void updateTerrainFollow(viewState);
  if (basemapDrape3DTiles) directXYZDrapeAtlas.request(selectedBasemap, viewState);
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
      if (parts[0] && parts[1]) {
        const options = {};
        parts.slice(3).forEach(part => {
          const [key, raw] = part.split("=", 2);
          const number = Number(raw);
          if (key === "tileSize" && [256, 512].includes(number)) options.tileSize = number;
          if (key === "maxZoom" && Number.isInteger(number) && number >= 0 && number <= maxZoom) {
            options.maxZoom = number;
          }
        });
        parsedBasemaps.push({
          id: `inspector-base-${parsedBasemaps.length}`,
          title: parts[0],
          url: parts[1],
          attribution: parts[2] || "",
          tileSize: options.tileSize || 256,
          ...(options.maxZoom === undefined ? {} : { maxZoom: options.maxZoom }),
        });
      }
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
          const zoom = Math.log2(591657550 / number);
          if (Number.isFinite(zoom)) camera.zoom = zoom;
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
  updateMapAttribution();
  cameraPresets.splice(0, cameraPresets.length, ...parsedCameras);
  renderPresets();
  renderLayerList();
  refreshLayers();
}

renderBasemapSelector();
document.querySelector("#basemap-select").addEventListener("change", event => {
  selectedBasemap = basemaps.find(item => item.id === event.target.value);
  layerState.get("basemap").visible = Boolean(selectedBasemap);
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
  layerState.get("terrain").visible = event.target.checked;
  if (event.target.checked) void updateTerrainFollow(viewState);
  else clearTerrainFollow();
  updateMapAttribution();
  refreshLayers();
  renderLayerList();
});
document.querySelector("#dem-source").addEventListener("change", event => {
  selectedDemSource = event.target.value;
  layerState.get("terrain").visible = true;
  terrainFollowState.sampleKey = "";
  void updateTerrainFollow(viewState);
  document.querySelector("#terrain-toggle").checked = true;
  updateMapAttribution();
  refreshLayers();
  renderLayerList();
});
Object.entries(drapeTerrainSources).forEach(([source]) => {
  document.querySelector(`#drape-terrain-${source}`).addEventListener("change", event => {
    drapeTerrainSources[source] = event.target.checked;
    refreshLayers();
  });
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
document.querySelector("#basemap-drape-3dtiles").addEventListener("change", event => {
  basemapDrape3DTiles = event.target.checked;
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
  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach(item => item.classList.toggle("active", item === tab));
      document.querySelectorAll(".settings-subpanel").forEach(panel => {
        panel.classList.toggle("active", panel.id === tab.dataset.settingsPanel);
      });
    });
  });
});
document.querySelector("#compass-button").addEventListener("click", () => flyTo({ bearing: 0 }));
document.querySelector("#top-down-button").addEventListener("click", () => flyTo({ pitch: 0 }));

applyInspector(inspectorDefault);
renderPresets();
updateCameraInputs();
void updateTerrainFollow(viewState);
void loadInspectorConfig();
