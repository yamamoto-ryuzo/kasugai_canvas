// KASUGAI Canvas — MapLibre フロント
// .kasc プレイヤーモード: projects/<id>/ の .kasc+DATA/ を MapLibre GL で再生する
import { loadKascProject, resolveKascUrl, camToZoom } from "/shared/kasc.js";

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
// 登録済み .kasc レイヤの id 一覧（切替・表示制御用）
let managed = [];
function removeManaged() {
  for (const id of managed) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
  managed = [];
}
function rasterSource(item, baseUrl) {
  const opts = item.opts || {};
  const source = { type: "raster", tiles: [resolveKascUrl(item.url, baseUrl)], tileSize: Number(opts.tilesize) || 256 };
  if (opts.maxzoom ?? opts.maximumlevel) source.maxzoom = Number(opts.maxzoom ?? opts.maximumlevel);
  if (opts.minzoom ?? opts.minimumlevel) source.minzoom = Number(opts.minzoom ?? opts.minimumlevel);
  return source;
function addKascLayer(item, baseUrl) {
  const id = `kasc-${managed.length}`;
  if (item.type === "geojson" || item.type === "layer") {
    map.addSource(id, { type: "geojson", data: resolveKascUrl(item.url, baseUrl) });
    // fill / line / circle をジオメトリ別に3枚重ねる
    const kinds = [
      ["fill", ["==", ["geometry-type"], "Polygon"], { "fill-color": "#3a7bd5", "fill-opacity": 0.4 }],
      ["line", ["!=", ["geometry-type"], "Point"], { "line-color": "#2c5ea8", "line-width": 1.5 }],
      ["circle", ["==", ["geometry-type"], "Point"], { "circle-radius": 5, "circle-color": "#2c5ea8" }],
    ];
    for (const [kind, filter, paint] of kinds) {
      const lid = `${id}-${kind}`;
      map.addLayer({ id: lid, type: kind, source: id, filter, paint, layout: { visibility: item.visible ? "visible" : "none" } });
      managed.push(lid);
    }
  } else {
    map.addSource(id, rasterSource(item, baseUrl));
    const paint = {};
    if (item.opts?.opacity !== undefined) paint["raster-opacity"] = Number(item.opts.opacity);
    map.addLayer({ id, type: "raster", source: id, paint, layout: { visibility: item.visible ? "visible" : "none" } });
    managed.push(id);
  return managed[managed.length - (item.type === "geojson" || item.type === "layer" ? 3 : 1)];
function setKascVisible(item, visible) {
  for (const id of item._lids || [item._lid]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
function renderLayerRows(entries, unsupported) {
  panel.layers.innerHTML = "";
  for (const entry of entries) {
    const row = document.createElement("label");
    row.className = "layer-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = entry.item.visible;
    cb.addEventListener("change", () => setKascVisible(entry, cb.checked));
    row.append(cb, document.createTextNode(entry.item.title || entry.item.url));
    panel.layers.append(row);
  panel.unsupported.textContent = unsupported.length
    ? `未対応行: ${unsupported.map(i => i.type).join(", ")}（Cesium 版で対応）`
    : "";
async function loadProject(id) {
  panel.unsupported.textContent = "読み込み中…";
  removeManaged();
  const { baseUrl, doc, manifest } = await loadKascProject(id);
  if (panel.project.options.length === 0 && Array.isArray(manifest)) {
    for (const entry of manifest) {
      const opt = document.createElement("option");
      opt.value = entry.id || entry;
      opt.textContent = entry.title || entry.id || entry;
      panel.project.append(opt);
    panel.project.addEventListener("change", () => loadProject(panel.project.value));
  panel.project.value = id;
  const entries = [];
  const unsupported = [...doc.unsupported];
  for (const item of doc.bases) {
    if (item.mode === "none") continue;
    if (item.mode === "transparent") { document.querySelector("#map").style.background = "transparent"; continue; }
    addKascLayer(item, baseUrl);
    const lid = managed[managed.length - 1];
    entries.push({ item, _lid: lid });
    setKascVisible({ _lid: lid }, item.visible);
  if (doc.background) document.querySelector("#map").style.background = doc.background;
  for (const item of doc.layers) {
    try {
      addKascLayer(item, baseUrl);
      const lids = managed.slice(-3);
      entries.push({ item, _lids: item.type === "xyz" ? [lids[lids.length - 1]] : lids });
    } catch (err) {
      unsupported.push({ ...item, type: `${item.type}(読込失敗)` });
  if (doc.cams.length) {
    const cam = doc.cams[0];
    map.jumpTo({ center: [cam.longitude, cam.latitude], zoom: camToZoom(cam) });
  renderLayerRows(entries, unsupported);
map.on("load", () => {
  if (window.KascPanel) KascPanel.init({ engine: "maplibre", map });
  loadProject().catch(err => {
    panel.unsupported.textContent = String(err.message || err);
  });
