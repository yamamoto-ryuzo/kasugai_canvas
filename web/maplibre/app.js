// KASUGAI Canvas — MapLibre フロント
// .kasc プレイヤーモード: projects/<id>/ の .kasc+DATA/ を MapLibre GL で再生する
import { loadKascProject, resolveKascUrl, camToZoom } from "/shared/kasc.js";
import { loadVectorItem } from "/shared/vector-load.js";

const VECTOR_TYPES = new Set(["geojson", "layer", "geoparquet", "parquet", "flatgeobuf", "fgb", "gpkg", "geopackage", "csv", "tsv"]);

const panel = {
  project: document.querySelector("#project-select"),
  layers: document.querySelector("#layers"),
  unsupported: document.querySelector("#unsupported"),
};

const map = new maplibregl.Map({
  container: "map",
  style: { version: 8, sources: {}, layers: [] },
  center: [139.767, 35.681],
  zoom: 10,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

// 登録済み .kasc レイヤ/ソースの id（GeoJSON は fill/line/circle の3枚を一括管理）
let managedLayers = [];
let managedSources = [];

function removeManaged() {
  for (const id of managedLayers) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of managedSources) {
    if (map.getSource(id)) map.removeSource(id);
  }
  managedLayers = [];
  managedSources = [];
}

function rasterSource(item, baseUrl) {
  const opts = item.opts || {};
  const source = { type: "raster", tiles: [resolveKascUrl(item.url, baseUrl)], tileSize: Number(opts.tilesize) || 256 };
  if (opts.maxzoom ?? opts.maximumlevel) source.maxzoom = Number(opts.maxzoom ?? opts.maximumlevel);
  if (opts.minzoom ?? opts.minimumlevel) source.minzoom = Number(opts.minzoom ?? opts.minimumlevel);
  return source;
}

// .kasc 1行 → レイヤ登録。戻り値はこの項目が持つレイヤ id の配列（表示切替用）
async function addKascLayer(item, baseUrl) {
  const sid = `kasc-${managedSources.length}`;
  const lids = [];
  if (VECTOR_TYPES.has(item.type)) {
    const { geojson } = await loadVectorItem(item, baseUrl);
    map.addSource(sid, { type: "geojson", data: geojson });
    const kinds = [
      ["fill", ["==", ["geometry-type"], "Polygon"], { "fill-color": "#3a7bd5", "fill-opacity": 0.4 }],
      ["line", ["!=", ["geometry-type"], "Point"], { "line-color": "#2c5ea8", "line-width": 1.5 }],
      ["circle", ["==", ["geometry-type"], "Point"], { "circle-radius": 5, "circle-color": "#2c5ea8" }],
    ];
    for (const [kind, filter, paint] of kinds) {
      const lid = `${sid}-${kind}`;
      map.addLayer({ id: lid, type: kind, source: sid, filter, paint, layout: { visibility: item.visible ? "visible" : "none" } });
      lids.push(lid);
    }
  } else {
    map.addSource(sid, rasterSource(item, baseUrl));
    const paint = {};
    if (item.opts?.opacity !== undefined) paint["raster-opacity"] = Number(item.opts.opacity);
    map.addLayer({ id: sid, type: "raster", source: sid, paint, layout: { visibility: item.visible ? "visible" : "none" } });
    lids.push(sid);
  }
  managedSources.push(sid);
  managedLayers.push(...lids);
  return lids;
}

function renderLayerRows(entries, unsupported) {
  panel.layers.innerHTML = "";
  for (const entry of entries) {
    const row = document.createElement("label");
    row.className = "layer-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = entry.item.visible;
    cb.addEventListener("change", () => {
      for (const lid of entry.lids) {
        if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", cb.checked ? "visible" : "none");
      }
    });
    row.append(cb, document.createTextNode(entry.item.title || entry.item.url));
    panel.layers.append(row);
  }
  panel.unsupported.textContent = unsupported.length
    ? `未対応行: ${unsupported.map(i => i.type).join(", ")}（Cesium 版で対応）`
    : "";
}

async function loadProject(id) {
  panel.unsupported.textContent = "読み込み中…";
  removeManaged();
  panel.layers.innerHTML = "";
  const { baseUrl, doc, manifest } = await loadKascProject(id);

  if (panel.project.options.length === 0 && Array.isArray(manifest)) {
    for (const entry of manifest) {
      const opt = document.createElement("option");
      opt.value = entry.id || entry;
      opt.textContent = entry.title || entry.id || entry;
      panel.project.append(opt);
    }
    panel.project.addEventListener("change", () => loadProject(panel.project.value));
  }
  panel.project.value = id;

  const entries = [];
  const unsupported = [...doc.unsupported];

  for (const item of doc.bases) {
    if (item.mode === "none") continue;
    if (item.mode === "transparent") { document.querySelector("#map").style.background = "transparent"; continue; }
    const lids = await addKascLayer(item, baseUrl);
    entries.push({ item, lids });
  }
  if (doc.background) document.querySelector("#map").style.background = doc.background;

  for (const item of doc.layers) {
    try {
      const lids = await addKascLayer(item, baseUrl);
      entries.push({ item, lids });
    } catch (err) {
      unsupported.push({ ...item, type: `${item.type}(読込失敗)` });
    }
  }

  if (doc.cams.length) {
    const cam = doc.cams[0];
    map.jumpTo({ center: [cam.longitude, cam.latitude], zoom: camToZoom(cam) });
  }
  renderLayerRows(entries, unsupported);
  for (const leg of doc.legends) {
    const img = document.createElement("img");
    img.src = resolveKascUrl(leg.url, baseUrl);
    img.alt = leg.title || "legend";
    img.style.cssText = "max-width:100%;display:block;margin:4px 0";
    panel.layers.append(img);
  }
  if (doc.info) {
    const a = document.createElement("a");
    a.href = resolveKascUrl(doc.info, baseUrl);
    a.target = "_blank";
    a.textContent = "プロジェクト情報";
    panel.layers.append(a);
  }
}

map.on("load", () => {
  if (window.KascPanel) KascPanel.init({ engine: "maplibre", map });
  loadProject().catch(err => {
    panel.unsupported.textContent = String(err.message || err);
  });
});
