// KASUGAI Canvas — OpenLayers フロント
// .kasc プレイヤーモード: projects/<id>/ の .kasc+DATA/ を OpenLayers で再生する
import Map from "https://esm.sh/ol@10.6.1/Map.js";
import View from "https://esm.sh/ol@10.6.1/View.js";
import TileLayer from "https://esm.sh/ol@10.6.1/layer/Tile.js";
import VectorLayer from "https://esm.sh/ol@10.6.1/layer/Vector.js";
import XYZ from "https://esm.sh/ol@10.6.1/source/XYZ.js";
import VectorSource from "https://esm.sh/ol@10.6.1/source/Vector.js";
import GeoJSON from "https://esm.sh/ol@10.6.1/format/GeoJSON.js";
import { fromLonLat } from "https://esm.sh/ol@10.6.1/proj.js";
import { loadKascProject, resolveKascUrl, camToZoom, geojsonExtent } from "/shared/kasc.js";
import { loadVectorItem } from "/shared/vector-load.js";
import Style from "https://esm.sh/ol@10.6.1/style/Style.js";
import Fill from "https://esm.sh/ol@10.6.1/style/Fill.js";
import Stroke from "https://esm.sh/ol@10.6.1/style/Stroke.js";
import CircleStyle from "https://esm.sh/ol@10.6.1/style/Circle.js";
import Icon from "https://esm.sh/ol@10.6.1/style/Icon.js";
import { loadCompiledQml, olQmlStyleFunction } from "/shared/qml-2d.js";

const VECTOR_TYPES = new Set(["geojson", "layer", "geoparquet", "parquet", "flatgeobuf", "fgb", "gpkg", "geopackage", "csv", "tsv"]);

const panel = {
  project: document.querySelector("#project-select"),
  layers: document.querySelector("#layers"),
  unsupported: document.querySelector("#unsupported"),
};

const map = new Map({
  target: "map",
  layers: [],
  view: new View({ center: fromLonLat([139.767, 35.681]), zoom: 10 }),
});

function xyzSource(item, baseUrl) {
  const opts = item.opts || {};
  const src = { url: resolveKascUrl(item.url, baseUrl), crossOrigin: "anonymous", attributions: item.attr || undefined };
  if (opts.maxzoom ?? opts.maximumlevel) src.maxZoom = Number(opts.maxzoom ?? opts.maximumlevel);
  if (opts.minzoom ?? opts.minimumlevel) src.minZoom = Number(opts.minzoom ?? opts.minimumlevel);
  if (opts.tilesize) src.tileSize = Number(opts.tilesize);
  return new XYZ(src);
}

function bboxExtent(item) {
  const bbox = (item.opts?.bbox || "").split(",").map(Number);
  if (bbox.length !== 4 || bbox.some(Number.isNaN)) return undefined;
  const [w, s, e, n] = bbox;
  return [...fromLonLat([w, s]), ...fromLonLat([e, n])];
}

async function buildLayer(item, baseUrl) {
  const source = xyzSource(item, baseUrl);
  if (VECTOR_TYPES.has(item.type)) {
    const { geojson } = await loadVectorItem(item, baseUrl);
    const layer = new VectorLayer({
      source: new VectorSource({
        attributions: item.attr || undefined,
        features: new GeoJSON().readFeatures(geojson, {
          featureProjection: "EPSG:3857",
          dataProjection: "EPSG:4326",
        }),
      }),
    });
    const env = geojsonExtent(geojson);
    if (env) layer.set("kascEnv", env);
    if (item.opts?.style) {
      try {
        const compiled = await loadCompiledQml(item.opts.style, baseUrl);
        layer.setStyle(olQmlStyleFunction(compiled, { Style, Fill, Stroke, Circle: CircleStyle, Icon }));
      } catch (e) { console.warn("QML 適用失敗:", item.opts.style, e); }
    }
    return layer;
  }
  // xyz / base はラスタタイル
  const layer = new TileLayer({ source });
  if (item.opts?.opacity !== undefined) layer.setOpacity(Number(item.opts.opacity));
  const extent = bboxExtent(item);
  if (extent) layer.setExtent(extent);
  return layer;
}

function renderLayerRows(entries, unsupported) {
  panel.layers.innerHTML = "";
  const tableBox = document.createElement("div");
  tableBox.className = "note";
  panel.layers.append(tableBox);
  for (const entry of entries) {
    const row = document.createElement("label");
    row.className = "layer-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = entry.item.visible;
    cb.addEventListener("change", () => entry.layer.setVisible(cb.checked));
    const name = document.createElement("span");
    name.textContent = entry.item.title || entry.item.url;
    name.style.cursor = "pointer";
    name.title = "属性一覧を表示";
    name.addEventListener("click", () => {
      const source = entry.layer.getSource?.();
      if (!source?.getFeatures) { tableBox.textContent = "（属性なし）"; return; }
      const feats = source.getFeatures().slice(0, 50);
      const cols = [...new Set(feats.flatMap(f => Object.keys(f.getProperties()).filter(k => k !== "geometry")))].slice(0, 8);
      if (!cols.length) { tableBox.textContent = "（属性なし）"; return; }
      const rows = feats.map(f => {
        const p = f.getProperties();
        return `<tr>${cols.map(c => `<td>${String(p[c] ?? "")}`).join("")}</tr>`;
      }).join("");
      tableBox.innerHTML = `<b>${entry.item.title}</b>（先頭${feats.length}件）<table style="font-size:11px;border-collapse:collapse"><tr>${cols.map(c => `<th style="border:1px solid #ccc;padding:1px 4px;text-align:left">${c}`).join("")}</tr>${rows.replace(/<td>/g, '<td style="border:1px solid #ccc;padding:1px 4px">')}</table>`;
    });
    row.append(cb, name);
    panel.layers.insertBefore(row, tableBox);
  }
  panel.unsupported.textContent = unsupported.length
    ? `未対応行: ${unsupported.map(i => i.type).join(", ")}（Cesium 版で対応）`
    : "";
}

async function loadProject(id) {
  panel.unsupported.textContent = "読み込み中…";
  map.getLayers().clear();
  panel.layers.innerHTML = "";
  const { baseUrl, doc, manifest } = await loadKascProject(id);

  // プロジェクト選択の反映（初回のみ構築）
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

  // base: は先頭が既定のベースマップ。transparent/none はモード指定（レイヤにしない）
  const baseEntries = [];
  for (const item of doc.bases) {
    if (item.mode === "none") continue;
    if (item.mode === "transparent") { document.querySelector("#map").style.background = "transparent"; continue; }
    const layer = await buildLayer(item, baseUrl);
    layer.setZIndex(0);
    map.addLayer(layer);
    baseEntries.push({ item, layer });
  }
  // 複数 base: → ベースマップ切替（先頭が既定）
  baseEntries.forEach((e, i) => e.layer.setVisible(i === 0 && e.item.visible !== false));
  if (baseEntries.length > 1) {
    const sel = document.createElement("select");
    sel.style.cssText = "width:100%;margin-bottom:8px";
    baseEntries.forEach((e, i) => {
      const opt = document.createElement("option");
      opt.value = i; opt.textContent = e.item.title || `base ${i}`;
      sel.append(opt);
    });
    sel.addEventListener("change", () => baseEntries.forEach((e, i) => e.layer.setVisible(i === Number(sel.value))));
    panel.project.insertAdjacentElement("afterend", sel);
  }
  if (doc.background) document.querySelector("#map").style.background = doc.background;

  for (const item of doc.layers) {
    try {
      const layer = await buildLayer(item, baseUrl);
      layer.setZIndex(item.type === "xyz" ? 1 : 2);
      layer.setVisible(item.visible);
      map.addLayer(layer);
      entries.push({ item, layer });
    } catch (err) {
      unsupported.push({ ...item, type: `${item.type}(読込失敗)` });
    }
  }

  if (doc.cams.length) {
    const cam = doc.cams[0];
    map.getView().setCenter(fromLonLat([cam.longitude, cam.latitude]));
    map.getView().setZoom(camToZoom(cam));
  } else {
    // cam 未指定なら読み込んだデータ範囲へフィット
    let union = null;
    for (const { layer } of entries) {
      const env = layer.get?.("kascEnv");
      if (!env) continue;
      const ext = [...fromLonLat([env.west, env.south]), ...fromLonLat([env.east, env.north])];
      union = union ? [Math.min(union[0], ext[0]), Math.min(union[1], ext[1]), Math.max(union[2], ext[2]), Math.max(union[3], ext[3])] : ext;
    }
    if (union) map.getView().fit(union, { padding: [30, 30, 30, 30], maxZoom: 17 });
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
  if (doc.cams.length) {
    const wrap = document.createElement("div");
    for (const cam of doc.cams) {
      const btn = document.createElement("button");
      btn.className = "cam-btn";
      btn.textContent = cam.name || `${cam.latitude.toFixed(4)},${cam.longitude.toFixed(4)}`;
      btn.addEventListener("click", () => {
        map.getView().animate({ center: fromLonLat([cam.longitude, cam.latitude]), zoom: camToZoom(cam), duration: 600 });
      });
      wrap.append(btn);
    }
    panel.layers.append(wrap);
  }
  // 属性検索（ベクターレイヤの全属性を対象）
  const search = document.createElement("input");
  search.placeholder = "属性検索";
  search.style.cssText = "width:100%;box-sizing:border-box;margin-top:6px";
  const results = document.createElement("div");
  search.addEventListener("keydown", e => {
    if (e.key !== "Enter" || !search.value.trim()) return;
    const needle = search.value.trim().toLowerCase();
    results.innerHTML = "";
    let count = 0;
    for (const { layer, item } of entries) {
      const source = layer.getSource?.();
      if (!source?.getFeatures) continue;
      for (const f of source.getFeatures()) {
        if (count >= 20) break;
        const { geometry, ...props } = f.getProperties();
        const hit = Object.entries(props).find(([k, v]) => String(v).toLowerCase().includes(needle));
        if (!hit) continue;
        count++;
        const row = document.createElement("div");
        row.className = "layer-row";
        row.style.cursor = "pointer";
        row.textContent = `${item.title}: ${hit[0]}=${hit[1]}`.slice(0, 60);
        row.addEventListener("click", () => {
          map.getView().fit(f.getGeometry().getExtent(), { padding: [60, 60, 60, 60], maxZoom: 18, duration: 400 });
        });
        results.append(row);
      }
    }
    if (!count) results.textContent = "該当なし";
  });
  panel.layers.append(search, results);
}

// 地物クリック → 属性ポップアップ
const kascPopup = document.createElement("div");
kascPopup.id = "kasc-popup";
document.querySelector("#map").append(kascPopup);
map.on("singleclick", e => {
  let html = "";
  map.forEachFeatureAtPixel(e.pixel, f => {
    const { geometry, ...props } = f.getProperties ? f.getProperties() : {};
    html = Object.entries(props).slice(0, 30).map(([k, v]) => `<b>${k}</b>: ${v}`).join("<br>");
    return true;
  }, { hitTolerance: 5 });
  kascPopup.style.display = html ? "block" : "none";
  if (html) { kascPopup.innerHTML = html; kascPopup.style.left = e.pixel[0] + 12 + "px"; kascPopup.style.top = e.pixel[1] + 12 + "px"; }
});

if (window.KascPanel) KascPanel.init({ engine: "openlayers", map });


loadProject().catch(err => {
  panel.unsupported.textContent = String(err.message || err);
});
