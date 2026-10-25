// KASUGAI Canvas — OpenLayers フロント
// .kasc プレイヤーモード: projects/<id>/ の .kasc+DATA/ を OpenLayers で再生する
import Map from "https://esm.sh/ol@10.6.1/Map.js";
import View from "https://esm.sh/ol@10.6.1/View.js";
import TileLayer from "https://esm.sh/ol@10.6.1/layer/Tile.js";
import VectorLayer from "https://esm.sh/ol@10.6.1/layer/Vector.js";
import XYZ from "https://esm.sh/ol@10.6.1/source/XYZ.js";
import TileWMS from "https://esm.sh/ol@10.6.1/source/TileWMS.js";
import VectorSource from "https://esm.sh/ol@10.6.1/source/Vector.js";
import GeoJSON from "https://esm.sh/ol@10.6.1/format/GeoJSON.js";
import { fromLonLat, toLonLat, transformExtent } from "https://esm.sh/ol@10.6.1/proj.js";
import { loadKascProject, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeight, parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle, sanitizeAttributionFragment, layerAttribution, buildWmtsTileTemplate, rewriteKascVisibility, themeShowSet, kascTitleInTheme, fillThemeSelect, loadKascBookmarks, parseQgisBookmarksXml, qgisBookmarkToCam, downloadQgisBookmarksXml, downloadKascCamLines } from "../shared/kasc.js";
import { loadVectorItem } from "../shared/vector-load.js";
import { initAiChat, hasBackendFeature } from "../shared/ai-chat.js";
import { createPlayerApi } from "../shared/player-api.js";
import { mountEngineSwitcher, consumeEngineSwitchState } from "../shared/engine-switch.js";

import { groundDeckTileset } from "../shared/deck-ground.js";
import { buildDeckDrapeLayers, invalidateDeckTerrainCovers } from "../shared/deck-drape.js";
import { qmlLegendSwatchDataUrl } from "../shared/qml-2d.js";
import Style from "https://esm.sh/ol@10.6.1/style/Style.js";
import Fill from "https://esm.sh/ol@10.6.1/style/Fill.js";
import Stroke from "https://esm.sh/ol@10.6.1/style/Stroke.js";
import CircleStyle from "https://esm.sh/ol@10.6.1/style/Circle.js";
import Icon from "https://esm.sh/ol@10.6.1/style/Icon.js";
import { loadCompiledQml, olQmlStyleFunction, compiledScaleToResRange } from "../shared/qml-2d.js";
import { defaults as defaultControls } from "https://esm.sh/ol@10.6.1/control/defaults.js";
import ScaleLine from "https://esm.sh/ol@10.6.1/control/ScaleLine.js";
import MousePosition from "https://esm.sh/ol@10.6.1/control/MousePosition.js";
import { createStringXY } from "https://esm.sh/ol@10.6.1/coordinate.js";

const VECTOR_TYPES = new Set(["geojson", "layer", "geoparquet", "parquet", "flatgeobuf", "fgb", "gpkg", "geopackage", "csv", "tsv", "duckdb", "sql"]);

const panel = {
  project: document.querySelector("#project-select"),
  layers: document.querySelector("#layers"),
  basemap: document.querySelector("#basemap-ctl"),
  basemapSelect: document.querySelector("#basemap-select"),
  cams: document.querySelector("#cams"),
  camsImportFile: document.querySelector("#cams-import-file"),
  camsImportCamFile: document.querySelector("#cams-import-cam-file"),
  legends: document.querySelector("#legends"),
  infoLink: document.querySelector("#info-link"),
  unsupported: document.querySelector("#unsupported"),
  searchInput: document.querySelector("#search-input"),
  searchResults: document.querySelector("#search-results"),
  attrTable: document.querySelector("#attr-table"),
  attrSelect: document.querySelector("#attr-layer-select"),
};

const map = new Map({
  target: "map",
  // 出典は Cesium 版と同型の右下オーバーレイで表示（標準Attributionコントロールは無効化）
  controls: defaultControls({ attribution: false }),
  layers: [],
  view: new View({ center: fromLonLat([139.767, 35.681]), zoom: 10 }),
});
window.kascMap = map; // デバッグ/外部連携用参照（KascPanel と同じ公開範囲）
// shared/kasc_panel.js の OpenLayers アダプタが参照する ol グローバル（ESM 取り込み分を公開）
window.ol = {
  layer: { Tile: TileLayer, Vector: VectorLayer },
  source: { XYZ, Vector: VectorSource, TileWMS },
  format: { GeoJSON },
  proj: { fromLonLat, toLonLat, transformExtent },
  style: { Style, Fill, Stroke, Circle: CircleStyle, Icon },
};

// 現在プロジェクトのレイヤーエントリ（表示範囲連動の再クエリ用）
let layerEntries = [];
let lastBaseUrl = "";
let currentBaseEntries = [];
// ?kasc= で読み込んだ .kasc の URL。設定中は URL 書き換え時に
// project= を書かず ?kasc= を維持する(実プロジェクト選択で空に戻る)
let lastKascUrl = "";
let currentProjectId = "";
// URL ハッシュの初期ビューは最初の loadProject で一度だけ適用する
// （プロジェクト切替時はそのプロジェクトの cam/範囲へ移動する既存挙動を維持）
let urlViewConsumed = false;

// OpenLayers ビュー ⇄ URL パラメータ（Cesium 規約: pitch は直下=-90、heading は北=0・時計回り。
// OL の2Dビューはピッチを持たないため、書き出しは -90 固定・読み込みでは無視する）
function mapViewToUrl() {
  const view = map.getView();
  const lonlat = toLonLat(view.getCenter() || [0, 0]);
  const zoom = view.getZoom();
  return {
    latitude: lonlat[1],
    longitude: lonlat[0],
    zoom,
    height: Number.isFinite(zoom) ? zoomToCamHeight(lonlat[1], zoom) : NaN,
    pitch: -90,
    heading: -(view.getRotation() * 180 / Math.PI),
  };
}

function urlViewToViewOptions(v) {
  return {
    center: fromLonLat([v.longitude, v.latitude]),
    zoom: Number.isFinite(v.zoom) ? v.zoom : camToZoom(v),
    rotation: Number.isFinite(v.heading) ? -v.heading * Math.PI / 180 : 0,
  };
}

// アドレスバーのハッシュ書き換え（再読み込み不要）からの復元。Cesium 版 applyUrlCamera と同じ挙動
function applyUrlView() {
  const v = parseUrlView();
  if (hasUrlView(v)) map.getView().animate({ ...urlViewToViewOptions(v), duration: 600 });
}
window.addEventListener("popstate", applyUrlView);
window.addEventListener("hashchange", applyUrlView);

// 表示範囲 → {ranges:[{west,east}], south, north}（日付変更線またぎ対応）
function getViewBounds() {
  try {
    if (!map.getSize()) return null;
    const ext = map.getView().calculateExtent(map.getSize());
    const e4326 = transformExtent(ext, map.getView().getProjection(), "EPSG:4326");
    const norm = d => { const x = ((d + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; };
    const west = norm(e4326[0]), east = norm(e4326[2]);
    const south = Math.max(-89.9, Math.min(89.9, e4326[1]));
    const north = Math.max(-89.9, Math.min(89.9, e4326[3]));
    const ranges = west === east ? [{ west: -180, east: 180 }]
      : west < east ? [{ west, east }]
      : [{ west, east: 180 }, { west: -180, east }];
    return { ranges, south, north };
  } catch (_) { return null; }
}

// ---- deck.gl（3dtiles: 行専用・初回利用時にCDNから遅延ロード） ----
// MapLibre 版と同じ UMD バンドルを使い、OL では @deck.gl/openlayers を使わず
// deck.Deck を #map 上のオーバーレイキャンバスとして viewState を手動同期する
// （OL は2Dビューのため真俯瞰の 2.5D 表示。キャンバス単位のため全 OL レイヤより
// 手前に1枚で描かれ、OL レイヤとの相互挿入はしない）
const DECK_CDN = "https://cdn.jsdelivr.net/npm/deck.gl@9/dist.min.js";
let deckLoadPromise = null;
function loadDeck() {
  if (window.deck) return Promise.resolve(window.deck);
  if (!deckLoadPromise) {
    deckLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = DECK_CDN;
      s.crossOrigin = "anonymous";
      s.onload = () => (window.deck ? resolve(window.deck) : reject(new Error("deck.gl が初期化されませんでした")));
      s.onerror = () => { deckLoadPromise = null; reject(new Error("deck.gl の読み込みに失敗しました")); };
      document.head.append(s);
    });
  }
  return deckLoadPromise;
}

let deckInst = null;             // deck.Deck インスタンス（オーバーレイキャンバス）
// Map は ol.Map の import でシャドウされるため globalThis.Map を使う
const deckDefs = new globalThis.Map(); // lid("deck-N") → { item, url, opacity, pointSize, order }
// 3D Tiles ドレープ設定（deck.gl TerrainExtension。
// Cesium 版のドレープ対象地形=3D Tiles（drape-terrain-tiles3d・
// basemap-drape-3dtiles・drape-xyz/​geojson-tiles3d）に相当）
const drapeTiles3d = { enabled: true, basemap: true, xyz: true, vector: true };

async function ensureDeck() {
  const deck = await loadDeck();
  if (deckInst) return deckInst;
  const canvas = document.createElement("canvas");
  canvas.id = "deck-canvas";
  canvas.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:5;";
  document.querySelector("#map").append(canvas);
  deckInst = new deck.Deck({
    canvas,
    views: new deck.MapView({ repeat: true }),
    initialViewState: { longitude: 0, latitude: 0, zoom: 0, pitch: 0, bearing: 0 },
    controller: false,
    layers: [],
    useDevicePixels: true,
  });
  window.kascDeckInst = deckInst; // デバッグ/外部連携用参照（kascMap と同じ公開範囲）
  return deckInst;
}

// 可視の 3dtiles が1枚でもある時だけドレープを有効化する
// （地形ソースが無いと drape 先が存在しない）
function deckDrapeActive() {
  if (!drapeTiles3d.enabled) return false;
  for (const def of deckDefs.values()) if (def.item.visible !== false) return true;
  return false;
}

// ドレープ対象（選択中ベースマップ + 表示中 XYZ/ベクターレイヤー）を収集する。
// 戻り値の配列順は terrain カバーへの描画順（後ほど前面）
function collectDrapeItems() {
  const rasterItems = [], vectorItems = [];
  if (drapeTiles3d.basemap) {
    const base = currentBaseEntries[Number(panel.basemapSelect?.value ?? 0)]?.item;
    if (base?.url) rasterItems.push(base);
  }
  // layerEntries は .kasc 順（先頭=最前面）。カバー内では後描きが上に出るため逆順に積む
  for (const e of [...layerEntries].reverse()) {
    const it = e.item;
    if (it.visible === false || it.type === "3dtiles") continue;
    if (VECTOR_TYPES.has(it.type)) {
      if (drapeTiles3d.vector && it._geojson?.features?.length) vectorItems.push(it);
    } else if (drapeTiles3d.xyz && it.url) {
      rasterItems.push(it);
    }
  }
  return { rasterItems, vectorItems };
}

// deckDefs から毎回レイヤ実体を再構成する（id 同一ならタイルセットは再読込されない）
function syncDeckLayers() {
  if (!deckInst || !window.deck) return;
  const deck = window.deck;
  const layers = [];
  const drapeOn = deckDrapeActive();
  // deckDefs は追加完了順に並ぶため、.kasc 行順(_idx)で描画順を揃える
  for (const [lid, def] of [...deckDefs.entries()].sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0))) {
    const opts = {
      id: lid,
      // 非表示レイヤーは tileset.json 自体を取得しない（Cesium 版の遅延方針に合わせる）
      data: def.item.visible !== false ? def.url : null,
      visible: def.item.visible !== false,
      opacity: def.opacity,
      // ドレープ有効時は 3D Tiles を地形ソース化する（drape レイヤーの貼り付け先）
      operation: drapeOn ? "terrain+draw" : "draw",
      pickable: true,
      onTilesetLoad: tileset => {
        try {
          const c = tileset?.cartographicCenter;
          if (Array.isArray(c) && !def.item._env) def.item._center = [c[0], c[1]];
          // テレイン不在のためバウンディングボリューム最小高で z=0 平面へ接地させる
          // （.kasc opts: ground=off で無効化、zoffset=<m> で手動補正）
          groundDeckTileset(tileset, def.item.opts);
        } catch (_) {}
      },
    };
    if (def.pointSize) opts.pointSize = def.pointSize;
    layers.push(new deck.Tile3DLayer(opts));
  }
  // ベースマップ/XYZ/ベクターのドレープコピー（TerrainExtension）
  if (drapeOn) layers.push(...buildDeckDrapeLayers(deck, collectDrapeItems(), lastBaseUrl));
  deckInst.setProps({ layers });
}

// deck 未初期化(起動時に可視の 3dtiles が無かった)場合の遅延初期化つき同期。
// 非表示 3dtiles を後から ON にした経路で使う
async function syncDeckLayersAsync() {
  if (!deckInst) {
    try { await ensureDeck(); }
    catch (err) { console.warn("deck 初期化失敗:", err); return; }
  }
  syncDeckLayers();
}

// OL の各フレームでビューを deck へ反映する。OL zoom0=世界256px / deck(Mapbox系)
// zoom0=世界512px なので -1 換算。bearing は OL 回転(反時計)の符号反転、pitch は 0 固定
map.on("postrender", () => {
  if (!deckInst) return;
  const size = map.getSize();
  if (!size) return;
  const view = map.getView();
  const [lon, lat] = toLonLat(view.getCenter() || [0, 0]);
  deckInst.setProps({
    width: size[0],
    height: size[1],
    viewState: {
      longitude: lon,
      latitude: lat,
      zoom: (view.getZoom() ?? 0) - 1,
      bearing: -(view.getRotation() * 180 / Math.PI),
      pitch: 0,
    },
  });
});

function xyzSource(item, baseUrl) {
  const opts = item.opts || {};
  const src = { url: resolveKascUrl(item.url, baseUrl), crossOrigin: "anonymous", attributions: layerAttribution(item) || undefined };
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

async function buildLayer(item, baseUrl, preloaded) {
  if (item.type === "3dtiles") {
    // deck.gl Tile3DLayer で描画。deck は OL レイヤではないため地図へは addLayer せず、
    // レイヤー行の表示/不透明度操作を deckDefs へ委譲するスタブを返す
    const opts = item.opts || {};
    const def = {
      item,
      url: resolveKascUrl(item.url, baseUrl),
      opacity: opts.opacity !== undefined ? Number(opts.opacity) : 1,
      pointSize: opts.pointsize !== undefined ? Number(opts.pointsize) : undefined,
      order: item._idx ?? 0,
    };
    const lid = `deck-${deckDefs.size}`;
    deckDefs.set(lid, def);
    // 可視の 3dtiles がある時だけ deck.gl 本体(CDN)を初期化する。
    // 全て | off なら CDN ロード自体を発生させない
    if (item.visible !== false || deckInst) {
      await ensureDeck();
      syncDeckLayers();
    }
    return {
      _isDeck: true,
      setVisible() { void syncDeckLayersAsync(); },
      setOpacity(v) { def.opacity = v; syncDeckLayers(); },
      get() { return undefined; },
      changed() {},
    };
  }
  if (item.type === "wms" || item.type === "wmts") return buildOgcRasterLayer(item, baseUrl);
  const source = xyzSource(item, baseUrl);
  if (VECTOR_TYPES.has(item.type)) {
    const loaded = preloaded || await loadVectorItem(item, baseUrl, getViewBounds());
    const geojson = loaded.geojson;
    item._geojson = geojson; // 3D Tiles ドレープコピー・属性テーブルの描画ソースとして保持
    item._viewportQuery = !!loaded.viewportQuery;
    const layer = new VectorLayer({
      source: new VectorSource({
        attributions: layerAttribution(item) || undefined,
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
        item._qml = compiled;
        const base = olQmlStyleFunction(compiled, { Style, Fill, Stroke, Circle: CircleStyle, Icon });
        // 凡例シンボル単位の表示切替: 先頭シンボル名が hidden 集合にある地物は描画しない
        layer.setStyle(f => {
          const names = compiled.namesFor?.(f.getProperties() || {});
          if (names?.length && item._legendHidden?.has(names[0])) return null;
          return base(f);
        });
        const range = compiledScaleToResRange(compiled);
        if (range) {
          layer.setMinResolution(range.minRes);
          if (Number.isFinite(range.maxRes)) layer.setMaxResolution(range.maxRes);
        }
      } catch (e) { console.warn("QML 適用失敗:", item.opts.style, e); }
    }
    syncDeckLayers(); // 読込完了でドレープコピー対象(_geojson)が増えた場合に反映
    return layer;
  }
  // xyz / base はラスタタイル
  const layer = new TileLayer({ source });
  if (item.opts?.opacity !== undefined) layer.setOpacity(Number(item.opts.opacity));
  const extent = bboxExtent(item);
  if (extent) layer.setExtent(extent);
  return layer;
}

// wms:/wmts: 行用のラスタレイヤーを作る。
// wms は TileWMS(BBOX は OL が計算)、wmts は {z}/{x}/{y} テンプレートへ正規化して XYZ 扱い
function buildOgcRasterLayer(item, baseUrl) {
  const opts = item.opts || {};
  const url = resolveKascUrl(item.url, baseUrl);
  let layer;
  if (item.type === "wms") {
    const transparent = !/^(false|0|off)$/i.test(String(opts.transparent ?? "true"));
    const params = {
      LAYERS: opts.layers ?? "",
      STYLES: opts.styles ?? "",
      FORMAT: opts.format || "image/png",
      TRANSPARENT: transparent,
      VERSION: opts.version || "1.1.1",
      TILED: true,
    };
    layer = new TileLayer({
      source: new TileWMS({ url, params, crossOrigin: "anonymous", attributions: layerAttribution(item) || undefined }),
    });
  } else {
    layer = new TileLayer({
      source: new XYZ({ url: buildWmtsTileTemplate(url, opts), crossOrigin: "anonymous", attributions: layerAttribution(item) || undefined }),
    });
  }
  if (opts.opacity !== undefined) layer.setOpacity(Number(opts.opacity));
  const extent = bboxExtent(item);
  if (extent) layer.setExtent(extent);
  return layer;
}

function showAttrTable(entry) {
  const tableBox = panel.attrTable;
  const source = entry.layer?.getSource?.();
  const feats = source?.getFeatures ? source.getFeatures().slice(0, 50) : [];
  const cols = [...new Set(feats.flatMap(f => Object.keys(f.getProperties()).filter(k => k !== "geometry")))].slice(0, 8);
  if (!cols.length) { tableBox.textContent = "（属性なし）"; return; }
  const rows = feats.map(f => {
    const p = f.getProperties();
    return `<tr>${cols.map(c => `<td>${String(p[c] ?? "")}`).join("")}</tr>`;
  }).join("");
  tableBox.innerHTML = `<b>${entry.item.title}</b>（先頭${feats.length}件）<table class="attr-table"><tr>${cols.map(c => `<th>${c}`).join("")}</tr>${rows.replace(/<td>/g, "<td>")}</table>`;
}

function applyEntryVisibility(entry) {
  // 未読込(遅延ロード)エントリは layer が無いのでスキップする
  entry.layer?.setVisible?.(!!entry.item.visible);
  syncDeckLayers(); // ドレープコピーの表示追従（deck 未初期化なら no-op）
  updateMapAttribution();
}

// 右下オーバーレイ: 選択中ベースマップ + 表示中レイヤーの出典を重ねて表示（Cesium 版と同規則）
function updateMapAttribution() {
  const el = document.querySelector("#map-attribution");
  if (!el) return;
  el.replaceChildren();
  const seen = new Set();
  const append = raw => {
    const t = String(raw || "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    if (t.startsWith("<")) {
      const w = document.createElement("span");
      w.append(sanitizeAttributionFragment(t));
      el.append(w);
    } else {
      const s = document.createElement("span");
      s.textContent = ` ${t}`;
      el.append(s);
    }
  };
  const active = Number(panel.basemapSelect?.value ?? 0);
  const base = currentBaseEntries[active]?.item;
  if (base) append(layerAttribution(base));
  for (const e of layerEntries) if (e.item.visible) append(layerAttribution(e.item));
}

// レイヤー行の📍: レイヤー範囲へ移動する。非表示なら表示してからフィットする
function focusEntry(entry) {
  const item = entry.item;
  // 未読込(初期遅延)レイヤは読み込んでから範囲へ移動する
  if (entry.deferred) {
    void ensureEntryLoaded(entry).then(ok => { if (ok) focusEntry(entry); });
    return;
  }
  if (!item.visible && entry.cb) { entry.cb.checked = true; entry.cb.dispatchEvent(new Event("change")); }
  let env = item._env || entry.layer?.get?.("kascEnv");
  if (!env && item.opts?.bbox) {
    const b = String(item.opts.bbox).split(",").map(Number);
    if (b.length === 4 && b.every(Number.isFinite)) env = { west: b[0], south: b[1], east: b[2], north: b[3] };
  }
  if (env) {
    const ext = [...fromLonLat([env.west, env.south]), ...fromLonLat([env.east, env.north])];
    map.getView().fit(ext, { padding: [50, 50, 50, 50], maxZoom: 17, duration: 600 });
  } else if (item._center) {
    // 3dtiles: tileset.json 読込時に保存した中心へ移動
    map.getView().animate({ center: fromLonLat(item._center), zoom: 15, duration: 600 });
  }
}

function buildLayerRow(entry, exclusive, radioName, attrCtx) {
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
    tg.setAttribute("aria-expanded", String(!item._legendCollapsed));
    tg.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
      item._legendCollapsed = !item._legendCollapsed;
      tg.textContent = item._legendCollapsed ? "▸" : "▾";
      tg.setAttribute("aria-expanded", String(!item._legendCollapsed));
      if (legendBox) legendBox.hidden = item._legendCollapsed;
    });
    row.append(tg);
  }

  const cb = document.createElement("input");
  cb.type = exclusive ? "radio" : "checkbox";
  if (exclusive) cb.name = radioName;
  cb.checked = item.visible;
  entry.cb = cb;
  cb.addEventListener("change", () => {
    item.visible = cb.checked;
    if (cb.checked && exclusive) {
      for (const sib of entry._siblings || []) {
        if (sib === entry) continue;
        sib.item.visible = false;
        if (sib.cb) sib.cb.checked = false;
        applyEntryVisibility(sib);
      }
    }
    applyEntryVisibility(entry);
    // `| off` で読込を遅延したレイヤは ON のタイミングで初回読み込みする
    if (cb.checked) maybeLoadEntry(entry);
    // 非表示で読み込みが遅延されていた viewport クエリ系は ON 時に即時再クエリ
    if (cb.checked && item._viewportQuery) requeryViewportLayers([entry]);
    entry._groupCtl?.sync();
  });
  row.append(cb);

  // 読込ステータス(読込中スピナー / 未読込 / 読込失敗)表示
  const statusEl = document.createElement("span");
  statusEl.className = "layer-status";
  entry.statusEl = statusEl;
  row.append(statusEl);
  syncRowStatus(entry);

  if (!legendMulti && legendEntries?.[0]?.spec) {
    const sw = document.createElement("img");
    sw.className = "legend-swatch";
    sw.src = qmlLegendSwatchDataUrl(legendEntries[0].spec);
    row.append(sw);
  }

  const name = document.createElement("span");
  name.textContent = entry._leaf || item.url;
  if (item.title && item.title !== entry._leaf) name.title = item.title;
  if (attrCtx.entries.includes(entry)) {
    name.style.cursor = "pointer";
    name.title = "属性一覧を表示";
    name.addEventListener("click", () => {
      attrCtx.select.value = attrCtx.entries.indexOf(entry);
      showAttrTable(entry);
      window.switchPanelTab?.("attr");
    });
  }
  row.append(name);

  const fb = document.createElement("button");
  fb.type = "button";
  fb.className = "layer-focus";
  fb.textContent = "📍";
  fb.title = "レイヤーへ移動";
  fb.addEventListener("click", ev => {
    ev.preventDefault(); ev.stopPropagation();
    focusEntry(entry);
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
        entry.layer?.changed?.(); // スタイル関数の再評価を促す
        syncDeckLayers(); // ドレープコピーにも凡例非表示を反映
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

const collapsedGroups = new Set();

function renderLayerRows(entries, unsupported) {
  panel.layers.innerHTML = "";
  panel.attrSelect.innerHTML = "";
  const attrEntries = entries.filter(e => e.layer?.getSource?.()?.getFeatures?.().length);
  for (const e of attrEntries) {
    const opt = document.createElement("option");
    opt.value = entries.indexOf(e);
    opt.textContent = splitKascTitle(e.item.title).title || e.item.url;
    panel.attrSelect.append(opt);
  }
  panel.attrSelect.onchange = () => showAttrTable(entries[Number(panel.attrSelect.value)]);
  if (attrEntries.length) showAttrTable(attrEntries[0]);
  else panel.attrTable.textContent = "（属性対象レイヤなし）";
  const attrCtx = { entries: attrEntries, select: panel.attrSelect };

  // "グループ/レイヤ名"（"//"は排他グループ）でグループセクション化する
  const grouped = new globalThis.Map(); // Map は ol.Map でシャドウ済みのため globalThis 経由
  for (const entry of entries) {
    const sp = splitKascTitle(entry.item.title);
    entry._leaf = sp.title;
    const key = `${sp.group}|${sp.exclusiveGroup ? "exclusive" : "regular"}`;
    if (!grouped.has(key)) grouped.set(key, { group: sp.group, exclusive: sp.exclusiveGroup, members: [] });
    grouped.get(key).members.push(entry);
  }

  for (const { group, exclusive, members } of grouped.values()) {
    for (const e of members) e._siblings = members;
    if (!group) {
      for (const e of members) panel.layers.append(buildLayerRow(e, false, null, attrCtx));
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
    tg.textContent = collapsedGroups.has(key) ? "▸" : "▾";
    tg.setAttribute("aria-expanded", String(!collapsedGroups.has(key)));
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
    children.hidden = collapsedGroups.has(key);
    for (const e of members) children.append(buildLayerRow(e, exclusive, `grp-${key}`, attrCtx));
    section.append(head, children);
    panel.layers.append(section);

    const ctl = {
      sync() {
        const anyOn = members.some(e => e.item.visible);
        gcb.checked = anyOn;
        gcb.indeterminate = !exclusive && anyOn && members.some(e => !e.item.visible);
      },
    };
    for (const e of members) e._groupCtl = ctl;
    ctl.sync();

    tg.addEventListener("click", () => {
      const collapsed = !children.hidden;
      children.hidden = collapsed;
      tg.textContent = collapsed ? "▸" : "▾";
      tg.setAttribute("aria-expanded", String(!collapsed));
      if (collapsed) collapsedGroups.add(key);
      else collapsedGroups.delete(key);
    });
    gcb.addEventListener("change", () => {
      if (exclusive) {
        // 排他グループ: ON → 先頭(または現表示)のみ表示、OFF → 全て非表示
        const on = gcb.checked ? (members.find(e => e.item.visible) || members[0]) : null;
        for (const e of members) {
          e.item.visible = e === on;
          if (e.cb) e.cb.checked = e === on;
          applyEntryVisibility(e);
          if (e === on) maybeLoadEntry(e);
        }
        if (on?.item._viewportQuery) requeryViewportLayers([on]);
      } else {
        for (const e of members) {
          e.item.visible = gcb.checked;
          if (e.cb) e.cb.checked = gcb.checked;
          applyEntryVisibility(e);
          maybeLoadEntry(e);
        }
        const vq = members.filter(e => gcb.checked && e.item._viewportQuery);
        if (vq.length) requeryViewportLayers(vq);
      }
      ctl.sync();
    });
  }

  panel.unsupported.textContent = unsupported.length
    ? `未対応行: ${unsupported.map(i => i.type).join(", ")}（Cesium 版で対応）`
    : "";
}

// ---- 段階読み込み: 行ステータス・進捗・遅延ロード ----

// renderProject の世代。プロジェクト切替/インスペクタ再適用で旧世代の
// 非同期追加が残って新しい地図を汚さないよう、追加前に世代を照合する
let renderSeq = 0;

// レイヤ行のステータス領域を entry の状態(読込中/未読込/失敗)へ同期する
function syncRowStatus(entry) {
  const el = entry.statusEl;
  if (!el) return;
  el.classList.toggle("loading", !!entry.pending);
  el.classList.toggle("deferred", !entry.pending && !!entry.deferred);
  el.classList.toggle("failed", !entry.pending && !!entry.failed);
  el.textContent = entry.pending ? "" : entry.failed ? "失敗" : entry.deferred ? "未読込" : "";
  el.title = entry.failed ? String(entry.error || "") : entry.deferred ? "表示を ON にすると読み込みます" : "";
}

// 読込完了したレイヤを .kasc 上の正しい描画順へ挿入する。
// layerEntries は .kasc 順(先頭=最前面)。同一 zIndex 内では追加順が描画順なので、
// index より手前で「同一 zIndex・追加済み」の最も近いレイヤの直下へ挿入する。
// 該当なしなら最前面(末尾)へ追加
function insertEntryLayer(entry, index) {
  const layer = entry.layer;
  const z = entry.item.type === "xyz" || entry.item.type === "tile" ? 1 : 2;
  layer.setZIndex(z);
  layer.setVisible(entry.item.visible);
  const arr = map.getLayers().getArray();
  for (let i = index - 1; i >= 0; i--) {
    const l = layerEntries[i]?.layer;
    if (l && l.getZIndex?.() === z && arr.includes(l)) {
      map.getLayers().insertAt(arr.indexOf(l), layer);
      return;
    }
  }
  map.addLayer(layer);
}

// `| off` 等で初期読み込みを遅延したレイヤを、表示 ON の時点で読み込み・追加する
async function ensureEntryLoaded(entry) {
  if (!entry.deferred || entry._loading) return !entry.failed;
  entry._loading = true;
  entry.pending = true;
  syncRowStatus(entry);
  const seq = renderSeq;
  try {
    const index = layerEntries.indexOf(entry);
    const layer = await buildLayer(entry.item, lastBaseUrl);
    if (seq !== renderSeq) return false;
    entry.layer = layer;
    if (!layer._isDeck) insertEntryLayer(entry, index);
    entry.deferred = false;
  } catch (err) {
    if (seq !== renderSeq) return false;
    entry.failed = true;
    entry.error = err?.message || err;
    currentUnsupported.push({ ...entry.item, type: `${entry.item.type}(読込失敗)` });
  }
  entry.pending = false;
  entry._loading = false;
  syncRowStatus(entry);
  updateMapAttribution();
  syncDeckLayers(); // 遅延読込完了でドレープコピー対象が増えた場合に反映
  // 属性テーブル対象・凡例スウォッチが増えるため一覧を再描画する
  renderLayerRows(layerEntries, currentUnsupported);
  return !entry.failed;
}

// 表示 ON で未読込レイヤを読み込む共通フック(チェックボックス・グループ・テーマ経路)
function maybeLoadEntry(entry) {
  if (entry.item.visible !== false && entry.deferred) void ensureEntryLoaded(entry);
}

// 地図上部の読込進捗ピル。完了時は「読込完了」を短時間表示して消える
const progressEl = document.querySelector("#load-progress");
const progressBar = document.querySelector("#load-progress-bar");
const progressText = document.querySelector("#load-progress-text");
let progressHideTimer = null;
function updateLoadProgress(done, total, label) {
  if (!progressEl) return;
  clearTimeout(progressHideTimer);
  progressEl.hidden = false;
  progressBar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  if (total > 0 && done >= total) {
    progressText.textContent = `読込完了 ${done}/${total}`;
    progressHideTimer = setTimeout(() => { progressEl.hidden = true; }, 1200);
  } else {
    progressText.textContent = `レイヤ読込中 ${done}/${total}${label ? ` — ${label}` : ""}`;
  }
}

const inspectorInput = document.querySelector("#inspector-input");
const themeSelect = document.querySelector("#theme-select");
let currentThemes = [];
let currentCams = [];

// cam: プリセット + bookmark: 行(QGISブックマークXML) → カメラタブ。
// CAM / QGIS-XML の2系統をグループ見出し+それぞれの保存・読込ボタンで区別する
const CAM_GROUPS = [
  { key: "CAM", match: c => !c.bookmark, fileKey: "camsImportCamFile",
    onSave: items => downloadKascCamLines(items) },
  { key: "QGIS-XML", match: c => !!c.bookmark, fileKey: "camsImportFile",
    onSave: items => downloadQgisBookmarksXml(items) },
];
function fillCamPanel(cams) {
  panel.cams.innerHTML = "";
  for (const g of CAM_GROUPS) {
    const head = document.createElement("div");
    head.className = "cam-group-label";
    head.append(document.createTextNode(g.key));
    const save = document.createElement("button");
    save.textContent = "保存";
    save.addEventListener("click", () => g.onSave(currentCams.filter(g.match)));
    const load = document.createElement("button");
    load.textContent = "読込";
    load.addEventListener("click", () => panel[g.fileKey].click());
    head.append(save, load);
    panel.cams.append(head);
    for (const cam of cams.filter(g.match)) {
      const btn = document.createElement("button");
      btn.className = "cam-btn" + (cam.bookmark ? " bm-btn" : "");
      btn.textContent = cam.name || `${cam.latitude.toFixed(4)},${cam.longitude.toFixed(4)}`;
      btn.addEventListener("click", () => {
        const e = cam._extent;
        if (e) map.getView().fit([...fromLonLat([e.west, e.south]), ...fromLonLat([e.east, e.north])], { padding: [40, 40, 40, 40], maxZoom: 20, duration: 600 });
        else map.getView().animate({ center: fromLonLat([cam.longitude, cam.latitude]), zoom: camToZoom(cam), duration: 600 });
      });
      panel.cams.append(btn);
    }
  }
}
let currentUnsupported = [];

async function loadProject(id) {
  const { id: loadedId, baseUrl, doc, manifest, raw, kascUrl } = await loadKascProject(id);
  switchRestore = pendingSwitchState;
  pendingSwitchState = null;
  const text = switchRestore?.inspector ?? raw;
  inspectorInput.value = text;
  lastKascUrl = kascUrl || "";
  await renderProject(loadedId, baseUrl, text === raw ? doc : parseKasc(text), manifest);
}

// インスペクターの「登録」: 編集済み .kasc テキストを現在プロジェクトの
// baseUrl で再描画する。プロジェクトファイル自体は書き換えない
async function applyInspectorText(text) {
  const baseUrl = lastBaseUrl || `/projects/${encodeURIComponent(currentProjectId || "default")}/`;
  await renderProject(currentProjectId || "default", baseUrl, parseKasc(text));
}

// 他エンジンからの切替時、同一プロジェクトなら引き継がれたレイヤ状態
// (インスペクタ内容・テーマ選択・各レイヤの可視性)を適用する。
// 状態はモジュール評価時に即消費して保持し(データ読込完了を待たない)、
// loadProject/renderProject の初回描画へそのまま反映する
let pendingSwitchState = consumeEngineSwitchState();
let switchRestore = null;

function applySwitchRestore(sw) {
  if (Array.isArray(sw.vis)) {
    // 注: このファイルの Map は ol/Map（標準Mapではない）のため globalThis.Map を使う
    const exact = new globalThis.Map(layerEntries.map(e => [e.item.title, e]));
    const leafOf = t => String(t).split("/").map(s => s.trim()).pop();
    const byLeaf = new globalThis.Map();
    for (const e of layerEntries) {
      const k = leafOf(e.item.title);
      byLeaf.set(k, byLeaf.has(k) ? null : e);
    }
    let changed = false;
    for (const { t: title, v } of sw.vis) {
      const e = exact.get(title) || byLeaf.get(leafOf(title));
      if (e && !!e.item.visible !== !!v) {
        e.item.visible = !!v;
        applyEntryVisibility(e);
        changed = true;
      }
    }
    if (changed) renderLayerRows(layerEntries, currentUnsupported);
  }
  if (sw.theme && themeSelect && [...themeSelect.options].some(o => o.value === sw.theme)) {
    themeSelect.value = sw.theme;
  }
}

// .kasc 文書(doc)を描画する。loadProject(ファイル読込)と
// インスペクター(テキスト適用)の共通経路
async function renderProject(loadedId, baseUrl, doc, manifest) {
  const seq = ++renderSeq;
  clearTimeout(progressHideTimer);
  if (progressEl) progressEl.hidden = true;
  map.getLayers().clear();
  deckDefs.clear();
  syncDeckLayers();
  layerEntries = [];
  panel.layers.innerHTML = "";
  currentProjectId = loadedId;

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
  panel.project.value = loadedId;

  // 3dtiles: 行は deck.gl で対応するため未対応通知から外す
  const unsupported = doc.unsupported.filter(i => i.type !== "3dtiles");

  // base: は先頭が既定のベースマップ。transparent/none はモード指定（レイヤにしない）
  currentBaseEntries = [];
  const baseEntries = currentBaseEntries;
  for (const item of doc.bases) {
    if (item.mode === "none") continue;
    if (item.mode === "transparent") { document.querySelector("#map").style.background = "transparent"; continue; }
    const layer = await buildLayer(item, baseUrl);
    layer.setZIndex(0);
    map.addLayer(layer);
    baseEntries.push({ item, layer });
  }
  // base: → 左下のベースマップ切替コントロール（先頭、または | off でない最初が既定）
  if (baseEntries.length) {
    const sel = panel.basemapSelect;
    sel.innerHTML = "";
    let active = baseEntries.findIndex(e => e.item.visible !== false);
    if (active < 0) active = 0;
    baseEntries.forEach((entry, i) => {
      const opt = document.createElement("option");
      opt.value = i; opt.textContent = entry.item.title || `base ${i}`;
      sel.append(opt);
      entry.layer.setVisible(i === active);
    });
    sel.value = active;
    sel.onchange = () => {
      baseEntries.forEach((e, i) => e.layer.setVisible(i === Number(sel.value)));
      syncDeckLayers(); // ベースマップのドレープコピーを選択中タイルへ差替える
      updateMapAttribution();
    };
    panel.basemap.hidden = false;
  } else {
    panel.basemap.hidden = true;
  }
  // インスペクター再適用時に前回の背景色が残らないよう、未指定は既定へ戻す
  document.querySelector("#map").style.background = doc.background || "";

  // 初期ビューはレイヤ読込を待たず即時適用する(cam/url 指定が無い場合のみ、
  // 全レイヤ読込後にデータ範囲へ fit する)
  const urlView = urlViewConsumed ? null : parseUrlView();
  urlViewConsumed = true;
  let needExtentFit = false;
  if (hasUrlView(urlView)) {
    const opts = urlViewToViewOptions(urlView);
    const view = map.getView();
    view.setCenter(opts.center);
    view.setZoom(opts.zoom);
    view.setRotation(opts.rotation);
  } else if (doc.cams.length) {
    const cam = doc.cams[0];
    map.getView().setCenter(fromLonLat([cam.longitude, cam.latitude]));
    map.getView().setZoom(camToZoom(cam));
  } else {
    needExtentFit = true;
  }

  // レイヤ行を先に描画して読込状態を行ごとに表示し、データは取得できた順に
  // 正しい描画順(insertEntryLayer)で地図へ追加する。
  // `| off` のベクター行は表示 ON までデータ取得を遅延する
  const orderedItems = [...doc.layers, ...doc.unsupported.filter(i => i.type === "3dtiles")]
    .sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
  const entries = orderedItems.map(item => ({
    item, layer: null, pending: true,
    opa: item.opts?.opacity !== undefined ? Number(item.opts.opacity) : 1,
  }));
  layerEntries = entries;
  lastBaseUrl = baseUrl;
  renderLayerRows(entries, unsupported);
  currentUnsupported = unsupported;
  updateThemeSelect(doc.themes || []);

  // エンジン切替の引継ぎ状態を初期描画へ反映(初回のみ)
  const sw = switchRestore; switchRestore = null;
  if (sw) applySwitchRestore(sw);

  const isDeferred = it => VECTOR_TYPES.has(it.type) && it.visible === false;
  // 残りの読込対象(=読み込み中を含む)を「残りN: 名前…」で進捗に出す
  const restLabel = () => {
    const rest = entries.filter(e => e.pending && !isDeferred(e.item))
      .map(e => splitKascTitle(e.item.title).title || e.item.title || e.item.url);
    return rest.length ? `残り${rest.length}: ${rest.slice(0, 3).join(", ")}${rest.length > 3 ? "…" : ""}` : "";
  };
  const total = entries.filter(e => !isDeferred(e.item)).length;
  let done = 0;
  if (total) updateLoadProgress(0, total, restLabel());
  await Promise.allSettled(entries.map((entry, index) => (async () => {
    const item = entry.item;
    if (isDeferred(item)) {
      // `| off` ベクターはここでは読まず、表示 ON 時に ensureEntryLoaded で読む
      entry.deferred = true;
      entry.pending = false;
      syncRowStatus(entry);
      return;
    }
    try {
      const layer = await buildLayer(item, baseUrl);
      if (seq !== renderSeq) return;
      entry.layer = layer;
      if (!layer._isDeck) insertEntryLayer(entry, index);
    } catch (err) {
      if (seq !== renderSeq) return;
      entry.failed = true;
      entry.error = err?.message || err;
      unsupported.push({ ...item, type: `${item.type}(読込失敗)` });
    }
    entry.pending = false;
    syncRowStatus(entry);
    updateMapAttribution();
    updateLoadProgress(++done, total, restLabel());
  })()));
  if (seq !== renderSeq) return;

  // cam/url 指定が無かった場合だけ、読み込んだレイヤの範囲へ合わせる
  if (needExtentFit) {
    let union = null;
    for (const e of entries) {
      const env = e.layer?.get?.("kascEnv");
      if (!env) continue;
      const ext = [...fromLonLat([env.west, env.south]), ...fromLonLat([env.east, env.north])];
      union = union ? [Math.min(union[0], ext[0]), Math.min(union[1], ext[1]), Math.max(union[2], ext[2]), Math.max(union[3], ext[3])] : ext;
    }
    if (union) map.getView().fit(union, { padding: [30, 30, 30, 30], maxZoom: 17 });
  }
  updateMapAttribution();
  renderLayerRows(entries, unsupported);

  // 凡例（URL 重複はまとめる）→ 凡例タブ
  panel.legends.innerHTML = "";
  const seenLegend = new Set();
  for (const leg of doc.legends) {
    if (!leg.url || seenLegend.has(leg.url)) continue;
    seenLegend.add(leg.url);
    const img = document.createElement("img");
    img.src = resolveKascUrl(leg.url, baseUrl);
    img.alt = leg.title || "legend";
    panel.legends.append(img);
  }
  if (!seenLegend.size) panel.legends.textContent = "（凡例なし）";

  // info: → 情報タブ
  panel.infoLink.innerHTML = "";
  if (doc.info) {
    const a = document.createElement("a");
    a.href = resolveKascUrl(doc.info, baseUrl);
    a.target = "_blank";
    a.textContent = "プロジェクト情報";
    panel.infoLink.append(a);
  }

  // cam: プリセット + bookmark: 行(QGISブックマークXML) → カメラタブ
  const cams = doc.cams.concat(await loadKascBookmarks(doc.bookmarks, baseUrl));
  currentCams = cams;
  fillCamPanel(cams);
  // 各グループ見出しの「読込」ボタンが開く file input のハンドラ
  panel.camsImportFile.onchange = async e => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const added = parseQgisBookmarksXml(await f.text()).map(bm => {
      const cam = qgisBookmarkToCam(bm);
      cam.bookmark = true;
      return cam;
    });
    if (!added.length) return;
    currentCams = currentCams.concat(added);
    fillCamPanel(currentCams);
  };
  panel.camsImportCamFile.onchange = async e => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const added = parseKasc(await f.text()).cams;
    if (!added.length) return;
    currentCams = currentCams.concat(added);
    fillCamPanel(currentCams);
  };

  // 属性検索（ベクターレイヤの全属性を対象）→ 検索タブ
  panel.searchInput.onkeydown = e => {
    if (e.key !== "Enter" || !panel.searchInput.value.trim()) return;
    const needle = panel.searchInput.value.trim().toLowerCase();
    panel.searchResults.innerHTML = "";
    let count = 0;
    for (const { layer, item } of entries) {
      const source = layer?.getSource?.();
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
        panel.searchResults.append(row);
      }
    }
    if (!count) panel.searchResults.textContent = "該当なし";
  };
}

// bbox=auto / :bbox 系レイヤーを現在の表示範囲で再クエリする
function requeryViewportLayers(entries) {
  const bounds = getViewBounds();
  const fmt = new GeoJSON();
  for (const entry of entries) {
    loadVectorItem(entry.item, lastBaseUrl, bounds).then(({ geojson }) => {
      const source = entry.layer?.getSource?.();
      if (!source?.clear || !source.addFeatures) return;
      const feats = fmt.readFeatures(geojson, { featureProjection: "EPSG:3857", dataProjection: "EPSG:4326" });
      source.clear();
      source.addFeatures(feats);
      entry.item._geojson = geojson;
      const env = geojsonExtent(geojson);
      if (env) entry.layer?.set?.("kascEnv", env);
      syncDeckLayers(); // ドレープコピーのデータ更新
    }).catch(err => console.warn("viewport requery 失敗:", entry.item.title, err));
  }
}

// 3D Tiles ドレープ品質: ズーム変化で terrain カバー FBO を現在解像度へ作り直す
let deckCoverZoom = -1;
map.on("moveend", () => {
  const z = map.getView().getZoom() ?? 0;
  if (z === deckCoverZoom) return;
  deckCoverZoom = z;
  invalidateDeckTerrainCovers(deckInst);
});

// 表示範囲の移動に追従して URL 反映 + 再クエリする
let requeryTimer = null;
map.on("moveend", () => {
  // 初期URLを読み取る前の初回moveendでパーマリンクを上書きしないよう消費済みを待つ
  if (urlViewConsumed) writeUrlView(mapViewToUrl(), lastKascUrl ? undefined : currentProjectId);
  const targets = layerEntries.filter(e => e.item._viewportQuery && e.item.visible !== false);
  if (!targets.length) return;
  clearTimeout(requeryTimer);
  requeryTimer = setTimeout(() => requeryViewportLayers(targets), 400);
});

// 地物クリック → 属性ポップアップ
const kascPopup = document.createElement("div");
kascPopup.id = "kasc-popup";
document.querySelector("#map").append(kascPopup);
map.on("singleclick", e => {
  if (!popupEnabled) { kascPopup.style.display = "none"; return; }
  let html = "";
  map.forEachFeatureAtPixel(e.pixel, f => {
    const { geometry, ...props } = f.getProperties ? f.getProperties() : {};
    html = Object.entries(props).slice(0, 30).map(([k, v]) => `<b>${k}</b>: ${v}`).join("<br>");
    return true;
  }, { hitTolerance: 5 });
  // OL の地物にヒットしなければ deck(3dtiles)を pick する
  if (!html && deckInst) {
    try {
      const info = deckInst.pickObject({ x: e.pixel[0], y: e.pixel[1], radius: 5 });
      const props = info?.object?.properties;
      if (props) html = Object.entries(props).slice(0, 30).map(([k, v]) => `<b>${k}</b>: ${v}`).join("<br>");
    } catch (_) {}
  }
  kascPopup.style.display = html ? "block" : "none";
  if (html) { kascPopup.innerHTML = html; kascPopup.style.left = e.pixel[0] + 12 + "px"; kascPopup.style.top = e.pixel[1] + 12 + "px"; }
});

loadProject().catch(err => {
  panel.unsupported.textContent = String(err.message || err);
});

// ?follow[=<base>] → geo_webview の /present/state をポーリングして表示を追従
{
  const params = new URLSearchParams(location.search);
  if (params.has("follow") || params.has("present")) {
    const base = params.get("follow") || params.get("present") || "";
    const tick = async () => {
      try {
        const s = await (await fetch(`${base}/present/state`)).json();
        const view = map.getView();
        if (typeof s.x3857 === "number" && typeof s.y3857 === "number") view.setCenter([s.x3857, s.y3857]);
        else if (typeof s.lon === "number" && typeof s.lat === "number") view.setCenter(fromLonLat([s.lon, s.lat]));
        if (typeof s.zoom === "number") view.setZoom(s.zoom);
        if (typeof s.rotation === "number") view.setRotation(-s.rotation * Math.PI / 180);
      } catch (_) { /* 接続不可時は前回状態を維持 */ }
    };
    setInterval(tick, 1500);
    tick();
  }
}

// ベースマップコントロールの最小化トグル
document.querySelector("#basemap-toggle").addEventListener("click", e => {
  const ctl = document.querySelector("#basemap-ctl");
  ctl.classList.toggle("collapsed");
  e.target.textContent = ctl.classList.contains("collapsed") ? "＋" : "−";
});

// 表示タブ: ベースマップ透過度・回転・レイヤー透過度・スケールバー・座標・ポップアップ
{
  const opacity = document.querySelector("#display-opacity");
  const rotation = document.querySelector("#display-rotation");
  const north = document.querySelector("#display-north");
  opacity?.addEventListener("input", () => {
    map.getLayers().forEach(l => { if (l.getZIndex?.() === 0) l.setOpacity(Number(opacity.value)); });
  });
  rotation?.addEventListener("change", () => {
    map.getView().setRotation(-Number(rotation.value || 0) * Math.PI / 180);
  });
  north?.addEventListener("change", () => {
    if (north.checked) { rotation.value = "0"; map.getView().animate({ rotation: 0, duration: 300 }); }
  });

  const layerOpacity = document.querySelector("#display-layer-opacity");
  layerOpacity?.addEventListener("input", () => {
    const v = Number(layerOpacity.value);
    for (const e of layerEntries) e.layer?.setOpacity?.((e.opa ?? 1) * v);
  });

  const scaleCtl = new ScaleLine({ units: "metric", className: "ol-scale-line kasc-scale" });
  const coordsCtl = new MousePosition({ className: "ol-mouse-position map-coords", coordinateFormat: createStringXY(5), projection: "EPSG:4326" });
  map.addControl(scaleCtl);
  map.addControl(coordsCtl);
  document.querySelector("#display-scalebar")?.addEventListener("change", e => {
    if (e.target.checked) map.addControl(scaleCtl);
    else map.removeControl(scaleCtl);
  });
  document.querySelector("#display-coords")?.addEventListener("change", e => {
    if (e.target.checked) map.addControl(coordsCtl);
    else map.removeControl(coordsCtl);
  });

  document.querySelector("#display-popup")?.addEventListener("change", e => {
    popupEnabled = e.target.checked;
    if (!popupEnabled) kascPopup.style.display = "none";
  });

  // 3D Tiles ドレープ（deck.gl TerrainExtension）。Cesium 版のドレープ対象地形=3D Tiles 相当
  [
    ["#drape-tiles3d", v => { drapeTiles3d.enabled = v; }],
    ["#drape-tiles3d-basemap", v => { drapeTiles3d.basemap = v; }],
    ["#drape-tiles3d-xyz", v => { drapeTiles3d.xyz = v; }],
    ["#drape-tiles3d-vector", v => { drapeTiles3d.vector = v; }],
  ].forEach(([sel, set]) => {
    document.querySelector(sel)?.addEventListener("change", e => { set(e.target.checked); syncDeckLayers(); });
  });
}

// ---- テーマ（theme: 行による可視性プリセット。QGIS マップテーマ相当） ----
function updateThemeSelect(themes) {
  currentThemes = themes || [];
  fillThemeSelect(themeSelect, currentThemes);
}

// テーマ適用: 対象レイヤの item.visible を一括更新し、
// インスペクターの .kasc テキストにも on/off を書き戻して整合を保つ
function applyKascTheme(theme) {
  const show = themeShowSet(theme);
  for (const e of layerEntries) {
    e.item.visible = show == null || kascTitleInTheme(e.item.title, show);
    applyEntryVisibility(e);
    maybeLoadEntry(e);
  }
  renderLayerRows(layerEntries, currentUnsupported);
  inspectorInput.value = rewriteKascVisibility(inspectorInput.value, show);
}

themeSelect?.addEventListener("change", () => {
  const theme = currentThemes.find(t => t.name === themeSelect.value);
  if (theme) applyKascTheme(theme);
});

// ---- 設定: インスペクター（.kasc テキストの表示・編集・適用） ----
// textarea には loadProject 時に現在プロジェクトの .kasc 全文が入る。
// 「登録」はテキスト全体で地図を再構築する（追加型ではなく全置換）
function setInspectorStatus(msg, isError = false) {
  const el = document.querySelector("#inspector-status");
  el.textContent = msg || "";
  el.style.color = isError ? "#c0392b" : "#666";
}

document.querySelector("#apply-inspector")?.addEventListener("click", async () => {
  try {
    setInspectorStatus("適用中…");
    await applyInspectorText(inspectorInput.value);
    setInspectorStatus("適用しました");
  } catch (e) {
    setInspectorStatus(`適用失敗: ${e?.message || e}`, true);
  }
});

document.querySelector("#export-inspector")?.addEventListener("click", () => {
  const blob = new Blob([inspectorInput.value], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "kasugai_canvas.kasc";
  a.click();
  URL.revokeObjectURL(a.href);
  setInspectorStatus("エクスポートしました");
});

// バックエンド機能検出は shared/ai-chat.js の initAiChat(manageBackend) が行い、
// hasBackendFeature は同モジュールから取得する

// DATA/ への保存先。fileWrite 時はサーバー側 projects/<id>/DATA/、
// それ以外は「フォルダを選択」で選んだ DATA/ フォルダ(File System Access API)
let dataDirHandle = null;
const dataDirName = document.querySelector("#inspector-data-dir-name");
function updateDataDirLabel() {
  if (!dataDirName) return;
  if (!window.showDirectoryPicker) { dataDirName.textContent = "このブラウザは非対応"; return; }
  dataDirName.textContent = dataDirHandle ? dataDirHandle.name : "未選択";
}
document.querySelector("#inspector-data-dir")?.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) { setInspectorStatus("このブラウザはフォルダ選択に対応していません", true); return; }
  try {
    dataDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    updateDataDirLabel();
  } catch (e) {
    if (e?.name !== "AbortError") setInspectorStatus(`フォルダ選択失敗: ${e?.message || e}`, true);
  }
});
updateDataDirLabel();

async function saveToDataDir(name, content) {
  if (hasBackendFeature("fileWrite")) {
    const project = currentProjectId || "default";
    const rel = String(name).split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const res = await fetch(`/api/files/${encodeURIComponent(project)}/${rel}`, { method: "PUT", body: content });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    return;
  }
  if (!window.showDirectoryPicker) throw new Error("ファイル保存にはローカルサーバー版または対応ブラウザが必要です");
  if (!dataDirHandle) {
    dataDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    updateDataDirLabel();
  }
  const fh = await dataDirHandle.getFileHandle(String(name).split("/").filter(Boolean).pop(), { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

// ファイルを DATA/ へ保存し、拡張子に応じた .kasc 行を設定へ追記して即時適用する
{
  const addFileInput = document.querySelector("#inspector-add-file");
  document.querySelector("#inspector-add-file-button")?.addEventListener("click", () => addFileInput?.click());
  addFileInput?.addEventListener("change", async () => {
    const files = [...(addFileInput.files || [])];
    addFileInput.value = "";
    let appended = 0;
    for (const file of files) {
      try {
        await saveToDataDir(file.name, file);
        const ext = file.name.toLowerCase().split(".").pop() || "";
        const type = { geojson: "geojson", json: "geojson", gpkg: "gpkg", geopackage: "gpkg", fgb: "flatgeobuf", parquet: "geoparquet" }[ext];
        if (type) {
          const title = file.name.replace(/\.[^.]+$/, "");
          inspectorInput.value = inspectorInput.value.replace(/\s*$/, "") + `\n${type}:${title} | DATA/${file.name}\n`;
          appended++;
          setInspectorStatus(`${file.name} を DATA/ へ保存し設定に追記しました`);
        } else {
          setInspectorStatus(`${file.name} を DATA/ へ保存しました（未対応形式のため行は未追記）`);
        }
      } catch (e) {
        if (e?.name === "AbortError") continue;
        setInspectorStatus(`保存失敗: ${e?.message || e}`, true);
      }
    }
    if (appended) {
      try { await applyInspectorText(inspectorInput.value); }
      catch (e) { setInspectorStatus(`適用失敗: ${e?.message || e}`, true); }
    }
  });
}

let popupEnabled = true;

// ---- AI チャット連携（kasugaiApi アダプタ + shared/ai-chat.js） ----
window.kasugaiApi = createPlayerApi({
  engine: "openlayers",
  getEntries: () => layerEntries,
  getBaseEntries: () => currentBaseEntries,
  getProjectId: () => currentProjectId,
  getBaseUrl: () => lastBaseUrl,
  loadProject,
  applyInspectorText,
  getInspectorText: () => inspectorInput.value,
  setInspectorText: v => { inspectorInput.value = v; },
  applyEntryVisibility, focusEntry, maybeLoadEntry,
  applyLegendFilter: entry => { entry.layer?.changed?.(); },
  rerenderLayers: () => renderLayerRows(layerEntries, currentUnsupported),
  getThemes: () => currentThemes,
  applyThemeByName: name => {
    const theme = currentThemes.find(t => t.name === name);
    if (!theme) return false;
    applyKascTheme(theme);
    if (themeSelect) themeSelect.value = theme.name;
    return true;
  },
  getCams: () => currentCams,
  flyToView: v => {
    // heading 未指定時は rotation を渡さない（undefined は現在角を壊し得るため）
    const opts = {
      center: fromLonLat([Number(v.longitude), Number(v.latitude)]),
      zoom: Number.isFinite(v.zoom) ? v.zoom : camToZoom(v),
      duration: 600,
    };
    if (Number.isFinite(v.heading)) opts.rotation = -v.heading * Math.PI / 180;
    map.getView().animate(opts);
  },
  getViewInfo: () => {
    const c = toLonLat(map.getView().getCenter() || [0, 0]);
    return { latitude: c[1], longitude: c[0], zoom: map.getView().getZoom(), heading: -map.getView().getRotation() * 180 / Math.PI, pitchDeg: 0 };
  },
  fitBoundsView: (w, s, e, n) => map.getView().fit([...fromLonLat([w, s]), ...fromLonLat([e, n])], { padding: [50, 50, 50, 50], maxZoom: 17 }),
  mountEntry: async (entry, preloaded) => {
    const layer = await buildLayer(entry.item, lastBaseUrl, preloaded || entry.item._preloaded);
    entry.layer = layer;
    if (!layer._isDeck) insertEntryLayer(entry, layerEntries.indexOf(entry));
    applyEntryVisibility(entry);
    updateMapAttribution();
  },
  unmountEntry: entry => {
    if (entry.layer && !entry.layer._isDeck) map.removeLayer(entry.layer);
    updateMapAttribution();
  },
  reloadEntryData: async entry => {
    const { geojson } = await loadVectorItem(entry.item, lastBaseUrl, getViewBounds());
    entry.item._geojson = geojson;
    const src = entry.layer?.getSource?.();
    if (src) {
      src.clear();
      src.addFeatures(new GeoJSON().readFeatures(geojson, { featureProjection: "EPSG:3857", dataProjection: "EPSG:4326" }));
    }
    syncDeckLayers(); // ドレープコピーのデータ更新
  },
  getEntryGeoJson: entry => {
    const src = entry.layer?.getSource?.();
    if (!src?.getFeatures) return entry.item._geojson || null;
    return new GeoJSON().writeFeaturesObject(src.getFeatures(), { featureProjection: "EPSG:3857", dataProjection: "EPSG:4326" });
  },
  setBaseEntryVisible: (entry, on) => { entry.layer?.setVisible?.(on); updateMapAttribution(); },
});
mountEngineSwitcher(document.querySelector("#engines"), "openlayers");
void initAiChat({ engine: "openlayers", manageBackend: true });
