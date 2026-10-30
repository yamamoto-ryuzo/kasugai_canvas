// KASUGAI Canvas — MapLibre フロント
// .kasc プレイヤーモード: projects/<id>/ の .kasc+DATA/ を MapLibre GL で再生する
import * as maplibregl from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs";
import { loadKascProject, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeight, zoomToCamHeightView, parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle, appendGroupedTitleOptions, syncBasemapList, sanitizeAttributionFragment, layerAttribution, loadKascInfoContent, buildWmsTileTemplate, buildWmtsTileTemplate, rewriteKascVisibility, themeShowSet, kascTitleInTheme, fillThemeSelect, loadKascBookmarks, parseQgisBookmarksXml, qgisBookmarkToCam, downloadQgisBookmarksXml, downloadKascCamLines, projectsBaseUrl, applyPanelTitle, defaultPointRadius, cssColorAlpha } from "../shared/kasc.js";
import { backendUrl } from "../shared/backend.js";
import { loadVectorItem, isViewportQueryItem } from "../shared/vector-load.js";
import { createAttrWidget, renderAttrContent, attrEntriesFromProps } from "../shared/attr-widget.js";
import { initAiChat, hasBackendFeature } from "../shared/ai-chat.js";
import { createPlayerApi } from "../shared/player-api.js";
import { mountEngineSwitcher, consumeEngineSwitchState } from "../shared/engine-switch.js";
import { initPrint, compositeCanvases } from "../shared/print.js";

import { groundDeckTileset } from "../shared/deck-ground.js";
import { buildDeckDrapeLayers, invalidateDeckTerrainCovers } from "../shared/deck-drape.js";
import { qmlLegendSwatchDataUrl, defaultVectorLegendSpec, installLayerVisibilityResolver, bakeQmlLabels } from "../shared/qml-2d.js";

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
  attrContent: document.querySelector("#attr-content"),
};

const map = new maplibregl.Map({
  container: "map",
  // glyphs は QML <labeling> の symbol レイヤが必要とするフォント PBF。
  // openmaptiles の Noto Sans は日本語を含む(demotiles.maplibre.org は非CJK)
  style: { version: 8, glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf", sources: {}, layers: [] },
  center: [139.767, 35.681],
  zoom: 10,
  attributionControl: false, // 出典は Cesium 版と同型の右下オーバーレイで表示
});
// 標準 NavigationControl（拡縮・方位）は使わず、右上の
// ナビゲーションツールバー（OpenLayers/Cesium 版と同型）で代替する
window.kascMap = map; // デバッグ/外部連携用参照（他エンジンと同じ公開範囲）

// 地物(GeoJSON Feature)の範囲へ移動。属性一覧・属性タブの行クリックで共通使用
function focusFeatureExtent(feature) {
  const env = geojsonExtent({ type: "FeatureCollection", features: [feature] });
  if (env) map.fitBounds([[env.west, env.south], [env.east, env.north]], { padding: 80, maxZoom: 18 });
}

// 全レイヤのデータ範囲（item._env）の合範囲へ fit する。
// 範囲が取れなければ false を返す。プロジェクト初期表示と ⌂ ボタンで共用
function fitDataExtent({ padding = 40, maxZoom = 17, duration = 0 } = {}) {
  let env = null;
  for (const { item } of layerEntries) {
    if (!item._env) continue;
    env = env
      ? [Math.min(env[0], item._env.west), Math.min(env[1], item._env.south), Math.max(env[2], item._env.east), Math.max(env[3], item._env.north)]
      : [item._env.west, item._env.south, item._env.east, item._env.north];
  }
  if (!env) return false;
  map.fitBounds(env, { padding, maxZoom, duration });
  return true;
}

// 「属性・値一覧」ボトムシート（Cesium 版 vector-attr-widget と同等）。
// レイヤ id は layerEntries のインデックス
const attrWidget = createAttrWidget({
  listLayers: () => layerEntries
    .map((entry, i) => ({ id: String(i), title: splitKascTitle(entry.item.title).title || entry.item.title || entry.item.url, entry }))
    .filter(o => VECTOR_TYPES.has(o.entry.item.type)),
  getFeatures: async entry => {
    const item = entry.item;
    // bbox=auto・:bbox 等の表示範囲連動クエリ系は _geojson が表示中範囲分のみ
    // なので、属性一覧は bounds なしの全件読込にする(Cesium 版の全件クエリと同等)
    if (isViewportQueryItem(item)) {
      const { geojson } = await loadVectorItem(item, lastBaseUrl, null);
      return { features: geojson?.features || [] };
    }
    // `| off` で未読込のレイヤは選択時に読み込む（表示状態は変えない）
    if (entry.deferred) await ensureEntryLoaded(entry);
    if (entry.failed) throw new Error(entry.error || "load failed");
    return { features: item._geojson?.features || [] };
  },
  focusFeature: focusFeatureExtent,
});
// 「選択中のレイヤ属性一覧」: 属性タブに記録された地物のレイヤ(または直前の選択)で開く
document.querySelector("#attr-widget-open")?.addEventListener("click", () => {
  attrWidget.open(panel.attrContent?.dataset.layerId || null);
});

// 登録済み .kasc レイヤ/ソースの id（GeoJSON は fill/line/circle の3枚を一括管理）
let managedLayers = [];
let currentBaseEntries = [];
let managedSources = [];
// 現在プロジェクトのレイヤーエントリ（表示範囲連動の再クエリ用）
let layerEntries = [];
// QML 式 is_layer_visible('名前') を item.visible へ解決する(Cesium 版と同規則)
installLayerVisibilityResolver(() => layerEntries.map(e => e.item));

// QML <labeling> は is_layer_visible で他レイヤーの表示状態を参照し得るため、
// 表示切替のたびに全ラベル付きエントリの __kasc_label を焼き直してソースを更新する
function refreshQmlLabels() {
  for (const entry of layerEntries) {
    const item = entry.item;
    if (!item?._qml?.labelFor || !entry.sid || !item._geojson) continue;
    bakeQmlLabels(item._geojson, item._qml);
    map.getSource(entry.sid)?.setData?.(item._geojson);
  }
}
let lastBaseUrl = "";
// ?kasc= で読み込んだ .kasc の URL。設定中は URL 書き換え時に
// project= を書かず ?kasc= を維持する(実プロジェクト選択で空に戻る)
let lastKascUrl = "";
let currentProjectId = "";
// URL ハッシュの初期ビューは最初の loadProject で一度だけ適用する
// （プロジェクト切替時はそのプロジェクトの cam/範囲へ移動する既存挙動を維持）
let urlViewConsumed = false;

// MapLibre ビュー ⇄ URL パラメータ（Cesium 規約: pitch は直下=-90・水平=0、heading は北=0・時計回り）
// URL/共有側の zoom は 256px タイル基準の正典(camToZoom と同じ。Leaflet/OL が素の値を書く)。
// MapLibre は 512px 基準のため書き出しは +1、読み込みは -1 する
function mapViewToUrl() {
  const c = map.getCenter();
  const zoom = map.getZoom() + 1;
  return {
    latitude: c.lat,
    longitude: c.lng,
    zoom,
    height: zoomToCamHeight(c.lat, zoom),
    pitch: map.getPitch() - 90,
    heading: -map.getBearing(),
  };
}

function urlViewToMapOptions(v) {
  return {
    center: [v.longitude, v.latitude],
    zoom: (Number.isFinite(v.zoom) ? v.zoom : camToZoom(v)) - 1,
    bearing: Number.isFinite(v.heading) ? -v.heading : 0,
    pitch: Number.isFinite(v.pitch) ? Math.max(0, Math.min(60, v.pitch + 90)) : 0,
  };
}

// アドレスバーのハッシュ書き換え（再読み込み不要）からの復元。Cesium 版 applyUrlCamera と同じ挙動
function applyUrlView() {
  const v = parseUrlView();
  if (hasUrlView(v)) map.flyTo(urlViewToMapOptions(v));
}
window.addEventListener("popstate", applyUrlView);
window.addEventListener("hashchange", applyUrlView);

// 表示範囲 → {ranges:[{west,east}], south, north}（日付変更線またぎ対応）
function getViewBounds() {
  try {
    const b = map.getBounds();
    const norm = d => { const x = ((d + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; };
    const west = norm(b.getWest()), east = norm(b.getEast());
    const south = Math.max(-89.9, Math.min(89.9, b.getSouth()));
    const north = Math.max(-89.9, Math.min(89.9, b.getNorth()));
    const ranges = west === east ? [{ west: -180, east: 180 }]
      : west < east ? [{ west, east }]
      : [{ west, east: 180 }, { west: -180, east }];
    return { ranges, south, north };
  } catch (_) { return null; }
}

function removeManaged() {
  for (const id of managedLayers) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of managedSources) {
    if (map.getSource(id)) map.removeSource(id);
  }
  managedLayers = [];
  managedSources = [];
  deckDefs.clear();
  syncDeckLayers();
}

// ---- deck.gl（3dtiles: 行専用・初回利用時にCDNから遅延ロード） ----
// 軽量プレイヤー維持のため 3dtiles を含む .kasc の時だけ読み込む
const DECK_CDN = "https://cdn.jsdelivr.net/npm/deck.gl@9.4.0/dist.min.js";
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

let deckOverlay = null;          // MapLibreOverlay コントロール
const deckDefs = new Map();      // lid("deck-N") → { item, url, opacity, pointSize }
// 3D Tiles ドレープ設定（deck.gl TerrainExtension。
// Cesium 版のドレープ対象地形=3D Tiles（drape-terrain-tiles3d・
// basemap-drape-3dtiles・drape-xyz/​geojson-tiles3d）に相当）
const drapeTiles3d = { enabled: true, basemap: true, xyz: true, vector: true };
// ソース/レイヤ id の採番。並列ロードで managedSources.length を読むと
// 全ジョブ同じ値になるため、単調増加カウンタで一意にする(リセットしない)
let sidSeq = 0;

async function ensureDeckOverlay() {
  const deck = await loadDeck();
  if (deckOverlay) return deckOverlay;
  const Overlay = deck.MapLibreOverlay || deck.MapboxOverlay;
  if (!Overlay) throw new Error("deck.gl の MapLibreOverlay が見つかりません");
  try {
    deckOverlay = new Overlay({ interleaved: true, layers: [] });
    map.addControl(deckOverlay);
  } catch (err) {
    console.warn("deck overlay (interleaved) 失敗 → overlaid で再試行:", err);
    deckOverlay = new Overlay({ interleaved: false, layers: [] });
    map.addControl(deckOverlay);
  }
  window.kascDeckOverlay = deckOverlay; // デバッグ/外部連携用参照（kascMap と同じ公開範囲）
  // 立体を眺められるよう最大ピッチを緩和（既定60では3D Tilesが見づらい）
  try { if (map.getMaxPitch() < 70) map.setMaxPitch(85); } catch (_) {}
  return deckOverlay;
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
  if (!deckOverlay || !window.deck) return;
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
      onClick: info => {
        try {
          const props = info?.object?.properties;
          if (!props) return;
          window.switchPanelTab?.("attr");
          renderAttrContent(panel.attrContent, [{ title: def.item?.title, entries: attrEntriesFromProps(props) }]);
        } catch (_) {}
      },
      onTilesetLoad: tileset => {
        try {
          const c = tileset?.cartographicCenter;
          if (Array.isArray(c) && !def.item._env) def.item._center = [c[0], c[1]];
          def.tileset = tileset;
          regroundDeckDef(def);
        } catch (_) {}
      },
    };
    if (def.pointSize) opts.pointSize = def.pointSize;
    layers.push(new deck.Tile3DLayer(opts));
  }
  // ベースマップ/XYZ/ベクターのドレープコピー（TerrainExtension）
  if (drapeOn) layers.push(...buildDeckDrapeLayers(deck, collectDrapeItems(), lastBaseUrl));
  deckOverlay.setProps({ layers });
}

// overlay 未初期化(起動時に可視の 3dtiles が無かった)場合の遅延初期化つき同期。
// 非表示 3dtiles を後から ON にした経路で使う
async function syncDeckLayersAsync() {
  if (!deckOverlay) {
    try { await ensureDeckOverlay(); }
    catch (err) { console.warn("deck overlay 初期化失敗:", err); return; }
  }
  syncDeckLayers();
}

// deck.gl Tile3DLayer の接地高。deck は MapLibre テレインを知らないため
// （z=0 平面基準で描画される）、テレイン ON 時はタイルセット中心の DEM 標高を
// 接地高にする。queryTerrainElevation は誇張込みの高さ[m]を返す。
// OFF・DEM タイル未読込時は 0（z=0 平面へ接地）
function deckGroundLevel(lon, lat) {
  if (!terrainEnabled || !map.getTerrain?.()) return 0;
  try {
    const h = map.queryTerrainElevation([lon, lat]);
    return Number.isFinite(h) ? h : 0;
  } catch (_) { return 0; }
}

function regroundDeckDef(def) {
  const tileset = def.tileset;
  if (!tileset) return;
  const c = tileset.cartographicCenter;
  groundDeckTileset(tileset, def.item.opts, Array.isArray(c) ? deckGroundLevel(c[0], c[1]) : 0);
}

// テレインの ON/OFF・DEM ソース/誇張変更・DEM タイル読込後に全 3D Tiles を再接地する
function regroundAllDeck() {
  for (const def of deckDefs.values()) regroundDeckDef(def);
  map.triggerRepaint();
}

function rasterSource(item, baseUrl) {
  const opts = item.opts || {};
  const url = resolveKascUrl(item.url, baseUrl);
  // wms: は GetMap タイルテンプレート、wmts: は {z}/{x}/{y} テンプレートへ正規化する
  const tileUrl = item.type === "wms" ? buildWmsTileTemplate(url, opts, "{bbox-epsg-3857}")
    : item.type === "wmts" ? buildWmtsTileTemplate(url, opts) : url;
  const source = { type: "raster", tiles: [tileUrl], tileSize: Number(opts.tilesize) || 256, attribution: layerAttribution(item) || undefined };
  if (opts.maxzoom ?? opts.maximumlevel) source.maxzoom = Number(opts.maxzoom ?? opts.maximumlevel);
  if (opts.minzoom ?? opts.minimumlevel) source.minzoom = Number(opts.minzoom ?? opts.minimumlevel);
  return source;
}

// .kasc 1行 → レイヤ登録。戻り値は { lids: レイヤ id 配列(表示切替用), sid: ソース id,
// viewportQuery: 表示範囲連動クエリの有無 }
// beforeIdFn は「追加時点で評価する挿入先レイヤ id」を返す関数(読込完了順が
// .kasc 順とズレても正しい z 順になるよう、追加直前に解決する)
async function addKascLayer(item, baseUrl, preloaded, beforeIdFn) {
  const sid = `kasc-${++sidSeq}`;
  const lids = [];
  let viewportQuery = false;
  let filters = null;
  const opas = new Map(); // lid → {prop, base}（レイヤー透過度スライダの基準値）
  const beforeId = () => (beforeIdFn ? beforeIdFn() : undefined);
  if (item.type === "3dtiles") {
    // deck.gl Tile3DLayer で描画。deck レイヤは MapLibre ソースを持たないので
    // managedLayers/managedSources には登録せず deckDefs で管理する
    const opts = item.opts || {};
    const opacity = opts.opacity !== undefined ? Number(opts.opacity) : 1;
    // 可視の 3dtiles がある時だけ overlay(deck.gl 本体)を初期化する。
    // 全て | off なら deck.gl の CDN ロード自体を発生させない
    if (item.visible !== false || deckOverlay) await ensureDeckOverlay();
    const lid = `deck-${deckDefs.size}`;
    deckDefs.set(lid, {
      item,
      url: resolveKascUrl(item.url, baseUrl),
      opacity,
      pointSize: opts.pointsize !== undefined ? Number(opts.pointsize) : undefined,
      order: item._idx ?? 0,
    });
    lids.push(lid);
    opas.set(lid, { prop: "opacity", base: opacity });
    syncDeckLayers();
    return { lids, sid: lid, viewportQuery, filters, opas };
  }
  if (VECTOR_TYPES.has(item.type)) {
    const loaded = preloaded || await loadVectorItem(item, baseUrl, getViewBounds());
    const geojson = loaded.geojson;
    viewportQuery = !!loaded.viewportQuery;
    // スタイル未指定地物の既定値(simplestyle > default_style: > 既定色)を
    // データ駆動 paint 式で表現する
    const ds = currentDefaultStyles || {};
    const lineColor = ds.line?.color ?? "#2c5ea8";
    const lineWidth = ds.line?.width ?? 1.5;
    const lineOpacity = ds.line?.opacity ?? 1;
    const polyStroke = ds.polygon?.stroke ?? lineColor;
    const polyStrokeW = ds.polygon?.strokeWidth ?? lineWidth;
    const polyStrokeO = ds.polygon?.strokeOpacity ?? lineOpacity;
    const polyFill = ds.polygon?.fill ?? "#3a7bd5";
    const polyFillOpacity = ds.polygon?.fillOpacity ?? (ds.polygon?.fill && cssColorAlpha(ds.polygon.fill) < 1 ? 1 : 0.4);
    const pointColor = ds.point?.color ?? "#2c5ea8";
    const pointRadius = ds.point?.size ? defaultPointRadius(ds.point.size) : 5;
    const pointOpacity = ds.point?.opacity ?? 1;
    let kinds = [
      ["fill", ["==", ["geometry-type"], "Polygon"], {
        "fill-color": ["case", ["has", "fill"], ["to-color", ["get", "fill"]], polyFill],
        "fill-opacity": ["case", ["has", "fill-opacity"], ["to-number", ["get", "fill-opacity"]], polyFillOpacity],
      }],
      ["line", ["!=", ["geometry-type"], "Point"], {
        "line-color": ["case", ["has", "stroke"], ["to-color", ["get", "stroke"]],
          ["case", ["==", ["geometry-type"], "Polygon"], polyStroke, lineColor]],
        "line-width": ["case", ["has", "stroke-width"], ["to-number", ["get", "stroke-width"]],
          ["case", ["==", ["geometry-type"], "Polygon"], polyStrokeW, lineWidth]],
        "line-opacity": ["case", ["has", "stroke-opacity"], ["to-number", ["get", "stroke-opacity"]],
          ["case", ["==", ["geometry-type"], "Polygon"], polyStrokeO, lineOpacity]],
      }],
      ["circle", ["==", ["geometry-type"], "Point"], {
        "circle-radius": ["match", ["to-string", ["get", "marker-size"]],
          "small", defaultPointRadius(24), "medium", defaultPointRadius(48), "large", defaultPointRadius(64), pointRadius],
        "circle-color": ["case", ["has", "marker-color"], ["to-color", ["get", "marker-color"]], pointColor],
        "circle-opacity": pointOpacity,
        "circle-stroke-color": ["case", ["has", "stroke"], ["to-color", ["get", "stroke"]], "#ffffff"],
        "circle-stroke-width": ["case", ["has", "stroke-width"], ["to-number", ["get", "stroke-width"]], 1],
      }],
    ];
    let zoomRange = null;
    if (item.opts?.style) {
      try {
        const { loadCompiledQml, maplibreApplyQml, compiledScaleToResRange, resToZoom } = await import("../shared/qml-2d.js");
        const compiled = await loadCompiledQml(item.opts.style, baseUrl);
        item._qml = compiled;
        kinds = maplibreApplyQml(geojson, compiled).kinds;
        const range = compiledScaleToResRange(compiled);
        if (range) {
          const lat = map.getCenter().lat;
          zoomRange = {
            // resToZoom は 256px 基準のため maplibre レイヤ指定では -1
            minzoom: Math.max(0, resToZoom(range.maxRes === Infinity ? 1e9 : range.maxRes, lat) - 1),
            maxzoom: Math.min(24, resToZoom(Math.max(range.minRes, 0.01), lat) - 1),
          };
        }
      } catch (e) { console.warn("QML 適用失敗:", item.opts.style, e); }
    }
    const env = geojsonExtent(geojson);
    if (env) item._env = env;
    item._geojson = geojson;
    const before = beforeId();
    map.addSource(sid, { type: "geojson", data: geojson, attribution: layerAttribution(item) || undefined });
    for (const [kind, filter, paint, layout] of kinds) {
      const lid = `${sid}-${kind}`;
      const def = { id: lid, type: kind, source: sid, filter, paint, layout: { ...layout, visibility: item.visible ? "visible" : "none" } };
      if (zoomRange) { def.minzoom = zoomRange.minzoom; def.maxzoom = zoomRange.maxzoom; }
      map.addLayer(def, before);
      lids.push(lid);
      if (!filters) filters = new Map();
      filters.set(lid, filter);
      // symbol レイヤに symbol-opacity は無いため text-opacity を使う
      const opaProp = kind === "symbol" ? "text-opacity" : `${kind}-opacity`;
      opas.set(lid, { prop: opaProp, base: typeof paint?.[opaProp] === "number" ? paint[opaProp] : 1 });
    }
    syncDeckLayers(); // 読込完了でドレープコピー対象(_geojson)が増えた場合に反映
  } else {
    map.addSource(sid, rasterSource(item, baseUrl));
    const paint = {};
    if (item.opts?.opacity !== undefined) paint["raster-opacity"] = Number(item.opts.opacity);
    map.addLayer({ id: sid, type: "raster", source: sid, paint, layout: { visibility: item.visible ? "visible" : "none" } }, beforeId());
    lids.push(sid);
    opas.set(sid, { prop: "raster-opacity", base: paint["raster-opacity"] ?? 1 });
  }
  managedSources.push(sid);
  managedLayers.push(...lids);
  return { lids, sid, viewportQuery, filters, opas };
}

function applyEntryVisibility(entry) {
  let deckDirty = false;
  for (const lid of entry.lids) {
    if (deckDefs.has(lid)) { deckDirty = true; continue; }
    if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", entry.item.visible ? "visible" : "none");
  }
  if (deckDirty) void syncDeckLayersAsync();
  else syncDeckLayers(); // ドレープコピーの表示追従（deck 未初期化なら no-op）
  refreshQmlLabels();
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

// 凡例シンボル単位の表示切替: __kasc_symbol が hidden 集合に含まれる地物をフィルタで除外する
function applyLegendFilter(entry) {
  const hidden = entry.item._legendHidden;
  for (const lid of entry.lids) {
    const orig = entry.filters?.get(lid);
    if (orig === undefined || !map.getLayer(lid)) continue;
    map.setFilter(lid, hidden?.size
      ? ["all", orig, ["!", ["in", ["get", "__kasc_symbol"], ["literal", [...hidden]]]]]
      : orig);
  }
  syncDeckLayers(); // ドレープコピーにも凡例非表示を反映
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
  let env = item._env;
  if (!env && item.opts?.bbox) {
    const b = String(item.opts.bbox).split(",").map(Number);
    if (b.length === 4 && b.every(Number.isFinite)) env = { west: b[0], south: b[1], east: b[2], north: b[3] };
  }
  if (env) map.fitBounds([env.west, env.south, env.east, env.north], { padding: 60, maxZoom: 17, duration: 800 });
  // 3D Tiles は tileset.json 読込後の中心点で移動する
  else if (item._center) map.flyTo({ center: item._center, zoom: 15, duration: 800 });
}

// style= 未指定ベクターの自動凡例: 既定色(塗り #3a7bd5α0.4 / 線・点 #2c5ea8)と
// 先頭地物のジオメトリ種別から代表スウォッチ spec を作る(Cesium 版の entity
// サンプル凡例相当)。未読込(遅延ロード)は _geojson が無いので null を返し、
// ensureEntryLoaded 後の renderLayerRows 再描画でスウォッチが出る
function defaultLegendSpec(item) {
  if (item._qml || !VECTOR_TYPES.has(item.type)) return null;
  for (const f of item._geojson?.features || []) {
    const spec = defaultVectorLegendSpec(f?.geometry?.type || "");
    if (spec) return spec;
  }
  return null;
}

function buildLayerRow(entry, exclusive, radioName) {
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
    tg.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
      item._legendCollapsed = !item._legendCollapsed;
      tg.textContent = item._legendCollapsed ? "▸" : "▾";
      tg.setAttribute("aria-expanded", String(!item._legendCollapsed));
      if (legendBox) legendBox.hidden = item._legendCollapsed;
    });
    tg.setAttribute("aria-expanded", String(!item._legendCollapsed));
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
  syncRowStatus(entry);

  const legendSpec = legendEntries?.[0]?.spec || defaultLegendSpec(item);
  if (!legendMulti && legendSpec) {
    const sw = document.createElement("img");
    sw.className = "legend-swatch";
    sw.src = qmlLegendSwatchDataUrl(legendSpec);
    row.append(sw);
  }

  const name = document.createElement("span");
  name.textContent = entry._leaf || item.url;
  if (item.title && item.title !== entry._leaf) name.title = item.title;
  // ベクターレイヤは名前クリックで「属性・値一覧」ウィジェットを開く
  if (VECTOR_TYPES.has(item.type)) {
    name.style.cursor = "pointer";
    name.title = "属性一覧を表示";
    name.addEventListener("click", () => attrWidget.open(String(layerEntries.indexOf(entry))));
  }
  row.append(name);
  row.append(statusEl);

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
        applyLegendFilter(entry);
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

const expandedLayerGroups = new Set();

function renderLayerRows(entries, unsupported) {
  panel.layers.innerHTML = "";

  // "グループ/レイヤ名"（"//"は排他グループ）でグループセクション化する
  const grouped = new Map();
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
      for (const e of members) panel.layers.append(buildLayerRow(e, false, null));
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
    tg.textContent = expandedLayerGroups.has(key) ? "▾" : "▸";
    tg.setAttribute("aria-expanded", String(expandedLayerGroups.has(key)));
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
    children.hidden = !expandedLayerGroups.has(key);
    for (const e of members) children.append(buildLayerRow(e, exclusive, `grp-${key}`));
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
      if (collapsed) expandedLayerGroups.delete(key);
      else expandedLayerGroups.add(key);
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
  // 開いている属性一覧ウィジェットの選択肢・行をレイヤ一覧へ追従させる
  attrWidget.refresh();
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

// `| off` 等で初期読み込みを遅延したレイヤを、表示 ON の時点で読み込み・追加する。
// 追加位置は findInsertBeforeId で .kasc 上の正しい z 順へ割り込ませる
async function ensureEntryLoaded(entry) {
  if (!entry.deferred || entry._loading) return !entry.failed;
  entry._loading = true;
  entry.pending = true;
  syncRowStatus(entry);
  const seq = renderSeq;
  try {
    const index = layerEntries.indexOf(entry);
    const r = await addKascLayer(entry.item, lastBaseUrl, undefined, () => {
      if (seq !== renderSeq) throw new Error("プロジェクト切替のため中断");
      return findInsertBeforeId(index);
    });
    if (seq !== renderSeq) return false;
    entry.lids = r.lids;
    entry.sid = r.sid;
    entry.filters = r.filters;
    entry.opas = r.opas;
    entry.item._viewportQuery = r.viewportQuery;
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

// 新規レイヤの挿入先(このレイヤの直上に来る既存レイヤ id)を解決する。
// layerEntries は .kasc 順(先頭=最前面)なので、index より手前で既に地図へ
// 追加済みの最も近いエントリの先頭レイヤ直下へ挿入すれば z 順が保たれる。
// 該当なしなら undefined(=最前面へ追加)
function findInsertBeforeId(index) {
  for (let i = index - 1; i >= 0; i--) {
    const lid = layerEntries[i]?.lids?.find(l => map.getLayer(l));
    if (lid) return lid;
  }
  return undefined;
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
// 現在の .kasc の default_style: 行(スタイル未指定地物の既定値)。renderProject で更新
let currentDefaultStyles = null;
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
        if (e) map.fitBounds([[e.west, e.south], [e.east, e.north]], { padding: 40, duration: 800, maxZoom: 20 });
        else map.flyTo({ center: [cam.longitude, cam.latitude], zoom: camToZoom(cam) - 1 });
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
  const baseUrl = lastBaseUrl || projectsBaseUrl(currentProjectId);
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
    const exact = new Map(layerEntries.map(e => [e.item.title, e]));
    const leafOf = t => String(t).split("/").map(s => s.trim()).pop();
    const byLeaf = new Map();
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
  removeManaged();
  layerEntries = [];
  panel.layers.innerHTML = "";
  currentProjectId = loadedId;
  applyPanelTitle(doc.title);
  currentDefaultStyles = doc.defaultStyles || null;

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

  // 3dtiles: 行は deck.gl で対応するため未対応通知から外し、
  // _idx（.kasc 上の行順）で doc.layers と混ぜてレイヤツリー順を再現する
  const unsupported = doc.unsupported.filter(i => i.type !== "3dtiles");

  currentBaseEntries = [];
  const baseEntries = currentBaseEntries;
  for (const item of doc.bases) {
    if (item.mode === "none") continue;
    if (item.mode === "transparent") { document.querySelector("#map").style.background = "transparent"; continue; }
    const { lids } = await addKascLayer(item, baseUrl);
    baseEntries.push({ item, lids });
  }
  // base: → 左下のベースマップ切替コントロール（先頭、または | off でない最初が既定）
  if (baseEntries.length) {
    const sel = panel.basemapSelect;
    sel.innerHTML = "";
    let active = baseEntries.findIndex(e => e.item.visible !== false);
    if (active < 0) active = 0;
    // "グループ/名前" タイトルは optgroup でグループ化表示する。
    // optgroup があれば select を折りたたみ可能なリスト UI へ置き換える
    appendGroupedTitleOptions(sel, baseEntries.map(e => e.item), (item, leafTitle, i) => {
      const opt = document.createElement("option");
      opt.value = i; opt.textContent = leafTitle || `base ${i}`;
      return opt;
    });
    baseEntries.forEach((entry, i) => {
      entry.lids.forEach(lid => map.getLayer(lid) && map.setLayoutProperty(lid, "visibility", i === active ? "visible" : "none"));
    });
    sel.value = active;
    // 初期表示は選択中の1レイヤのみ示す畳み状態で同期するため、
    // sel.value 確定後にリストを描画する
    syncBasemapList(sel);
    sel.onchange = () => {
      baseEntries.forEach((e, i) =>
        e.lids.forEach(lid => map.getLayer(lid) && map.setLayoutProperty(lid, "visibility", i === Number(sel.value) ? "visible" : "none")));
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
    map.jumpTo(urlViewToMapOptions(urlView));
  } else if (doc.cams.length) {
    const cam = doc.cams[0];
    map.jumpTo({ center: [cam.longitude, cam.latitude], zoom: camToZoom(cam) - 1 });
  } else {
    needExtentFit = true;
  }

  // レイヤ行を先に描画して読込状態を行ごとに表示し、データは取得できた順に
  // 正しい z 順(findInsertBeforeId)で地図へ追加する。
  // `| off` のベクター行は表示 ON までデータ取得を遅延する
  const orderedItems = [...doc.layers, ...doc.unsupported.filter(i => i.type === "3dtiles")]
    .sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
  const entries = orderedItems.map(item =>
    ({ item, lids: [], sid: null, filters: null, opas: null, pending: true }));
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
      const r = await addKascLayer(item, baseUrl, undefined, () => {
        if (seq !== renderSeq) throw new Error("プロジェクト切替のため中断");
        return findInsertBeforeId(index);
      });
      if (seq !== renderSeq) return;
      entry.lids = r.lids;
      entry.sid = r.sid;
      entry.filters = r.filters;
      entry.opas = r.opas;
      item._viewportQuery = r.viewportQuery;
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
  if (needExtentFit) fitDataExtent();
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

  // info: → 外部HTMLを情報タブへ埋め込み（全エンジン共通のローダ）
  void loadKascInfoContent(panel.infoLink, doc.info, baseUrl);

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

  // 属性検索（読み込んだベクターの全属性を対象）→ 検索タブ
  panel.searchInput.onkeydown = e => {
    if (e.key !== "Enter" || !panel.searchInput.value.trim()) return;
    const needle = panel.searchInput.value.trim().toLowerCase();
    panel.searchResults.innerHTML = "";
    let count = 0;
    for (const { item } of entries) {
      for (const f of item._geojson?.features || []) {
        if (count >= 20) break;
        const hit = Object.entries(f.properties || {}).find(([k, v]) => String(v).toLowerCase().includes(needle));
        if (!hit) continue;
        count++;
        const row = document.createElement("div");
        row.className = "layer-row";
        row.style.cursor = "pointer";
        row.textContent = `${item.title}: ${hit[0]}=${hit[1]}`.slice(0, 60);
        row.addEventListener("click", () => {
          const env = geojsonExtent({ features: [f] });
          if (env) map.fitBounds([env.west, env.south, env.east, env.north], { padding: 80, maxZoom: 18 });
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
  for (const entry of entries) {
    loadVectorItem(entry.item, lastBaseUrl, bounds).then(({ geojson }) => {
      entry.item._geojson = geojson;
      const env = geojsonExtent(geojson);
      if (env) entry.item._env = env;
      const src = map.getSource(entry.sid);
      if (src?.setData) src.setData(geojson);
      syncDeckLayers(); // ドレープコピーのデータ更新
      attrWidget.refresh(); // 表示範囲分の行が差し替わった場合に追従
    }).catch(err => console.warn("viewport requery 失敗:", entry.item.title, err));
  }
}

// 3D Tiles ドレープ品質: ズーム確定で terrain カバー FBO を現在解像度へ作り直す
map.on("zoomend", () => invalidateDeckTerrainCovers(deckOverlay?._deck));

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

// 地物クリック → 属性タブを自動で開いて属性を表示(Cesium 版 attr-panel と同様)
map.on("click", e => {
  const features = map.queryRenderedFeatures(e.point, { layers: managedLayers });
  // 重なった地物を全件拾う。同一地物が fill/line/symbol の複数スタイルレイヤに
  // またがってヒットするため、ソース+属性で重複を除外する
  const seen = new Set();
  const records = [];
  for (const f of features) {
    const key = `${f.source}|${JSON.stringify(f.properties || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = layerEntries.find(en => en.sid === f.source);
    records.push({
      title: entry ? (entry.item.title || entry.item.url) : null,
      entries: attrEntriesFromProps(f.properties),
      layerId: entry ? String(layerEntries.indexOf(entry)) : null,
      feature: f,
      flyable: !!f.geometry,
    });
  }
  window.switchPanelTab?.("attr");
  renderAttrContent(panel.attrContent, records, { onRecordClick: rec => focusFeatureExtent(rec.feature) });
});

map.on("load", () => {
  loadProject().catch(err => {
    panel.unsupported.textContent = String(err.message || err);
  });
});

// ?follow[=<base>] → geo_webview の /present/state をポーリングして表示を追従
{
  const params = new URLSearchParams(location.search);
  if (params.has("follow") || params.has("present")) {
    const base = params.get("follow") || params.get("present") || "";
    const tick = async () => {
      try {
        const s = await (await fetch(`${base}/present/state`)).json();
        const opt = {};
        if (typeof s.lon === "number" && typeof s.lat === "number") opt.center = [s.lon, s.lat];
        // /present/state の zoom は OL 規約(256px基準)のため -1
        if (typeof s.zoom === "number") opt.zoom = s.zoom - 1;
        if (typeof s.rotation === "number") opt.bearing = -s.rotation;
        map.jumpTo(opt);
      } catch (_) { /* 接続不可時は前回状態を維持 */ }
    };
    setInterval(tick, 1500);
    tick();
  }
}

// ベースマップコントロールの最小化トグル
document.querySelector("#basemap-toggle").addEventListener("click", e => {
  const ctl = document.querySelector("#basemap-ctl");
  const collapsed = ctl.classList.toggle("collapsed");
  e.currentTarget.textContent = collapsed ? "+" : "−";
  e.currentTarget.setAttribute("aria-label", collapsed ? "展開" : "最小化");
});

// ナビゲーションツールバー（OpenLayers/Cesium 版と同型の右上配置:
// 方位コンパス＋北リセット・全体表示・最小化トグル）
{
  const compass = document.querySelector("#nav-compass");
  const rotInput = document.querySelector("#display-rotation");
  // bearing → コンパス針と設定タブの回転入力へ反映。
  // 針は Cesium と同じく -heading 回転（bearing が heading 相当のため -b）
  map.on("move", () => {
    const b = map.getBearing();
    if (compass) compass.style.transform = `rotateZ(${-b}deg)`;
    if (rotInput && document.activeElement !== rotInput) rotInput.value = String(Math.round(-b));
  });
  compass?.addEventListener("click", () => {
    map.easeTo({ bearing: 0, duration: 300 });
    if (rotInput) rotInput.value = "0";
  });
  document.querySelector("#nav-home")?.addEventListener("click", () => {
    // データ範囲が取れない場合は初期ビュー（東京駅付近）へ戻す
    if (!fitDataExtent({ duration: 800 })) {
      map.easeTo({ center: [139.767, 35.681], zoom: 10, bearing: 0, duration: 800 });
    }
  });
  document.querySelector("#navigation-toggle")?.addEventListener("click", e => {
    const bar = e.currentTarget.closest(".navigation-toolbar");
    const collapsed = bar.classList.toggle("collapsed");
    e.currentTarget.textContent = collapsed ? "+" : "−";
    e.currentTarget.setAttribute("aria-label", collapsed ? "展開" : "最小化");
  });
}

// 🌐 ボタン: 現在の表示位置を Google Earth (Web) で開く。
// heading は bearing の符号反転（getViewState と同規則）、
// tilt は pitch、distance は実ビューポート高 + 垂直FOV60° 換算の
// カメラ高で、傾斜時は高さ/cos(tilt) で視線距離へ換算
function openGoogleEarth() {
  try {
    const c = map.getCenter();
    const heading = ((-map.getBearing()) % 360 + 360) % 360;
    const tilt = Math.max(0, Math.min(90, map.getPitch()));
    const tiltRad = tilt * Math.PI / 180;
    const vh = map.getCanvas().clientHeight || map.getContainer().clientHeight;
    const height = Math.max(50, zoomToCamHeightView(c.lat, map.getZoom(), vh));
    const distance = tiltRad > 0.01 ? height / Math.cos(tiltRad) : height;
    const url = `https://earth.google.com/web/@${c.lat.toFixed(6)},${c.lng.toFixed(6)},0a,${distance.toFixed(2)}d,35y,${heading.toFixed(1)}h,${tilt.toFixed(1)}t,0r`;
    window.open(url, "_blank", "noopener");
  } catch (e) { console.error("Google Earth 連携エラー:", e); }
}
document.querySelector("#basemap-globe").addEventListener("click", openGoogleEarth);

// ---- テレイン(3D地形): raster-dem ソース + map.setTerrain ----
// raster-dem は Terrarium/Mapbox encoding のタイルのみ読める
// (地理院 dem_png は独自 encoding のため MapLibre では使えない)
const TERRAIN_SOURCE_ID = "kasc-terrain-dem";
const terrainDemSources = {
  // Cesium 版 demSources と同じ Re:Earth Terrain。terrarium encoding の
  // TileJSON を配信している（z14・全球。mapterhorn-egm08 ベース）
  "reearth-ellipsoid": { url: "https://terrain.reearth.land/terrarium/ellipsoid/tilejson.json" },
  reearth: { url: "https://terrain.reearth.land/terrarium/elevation/tilejson.json" },
  mapterhorn: { url: "https://tiles.mapterhorn.com/tilejson.json" },
  aws: {
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    maxzoom: 15,
    attribution: "© AWS Terrain Tiles / Mapzen",
  },
  maplibre: { url: "https://demotiles.maplibre.org/terrain-tiles/tiles.json" },
};
let terrainEnabled = false;
let terrainDemKey = "none"; // "none" = DEMなし。初期値は DEMソース選択肢の既定と一致させる
let terrainExaggeration = 1;
let appliedTerrainDemKey = null;

function applyTerrain() {
  // "load" は初回スタイル読込で一度しか発火しないため、プロジェクト読込等で
  // スタイル再処理中に来た呼び出しはポーリングで再試行する
  if (!map.isStyleLoaded()) { setTimeout(applyTerrain, 250); return; }
  if (!terrainEnabled) {
    if (map.getTerrain()) map.setTerrain(null);
    // ピッチ緩和は deck.gl overlay 側でも必要なので、overlay 無しの時だけ戻す
    if (!deckOverlay) { try { map.setMaxPitch(60); } catch (_) {} }
    regroundAllDeck();
    return;
  }
  const def = terrainDemSources[terrainDemKey];
  if (!def) return;
  // DEM ソース変更時は terrain を外してからソースを張り替える
  if (appliedTerrainDemKey !== terrainDemKey && map.getSource(TERRAIN_SOURCE_ID)) {
    map.setTerrain(null);
    map.removeSource(TERRAIN_SOURCE_ID);
    appliedTerrainDemKey = null;
  }
  if (!map.getSource(TERRAIN_SOURCE_ID)) {
    const spec = { type: "raster-dem" };
    if (def.url) {
      spec.url = def.url;
    } else {
      spec.tiles = def.tiles;
      spec.tileSize = 256;
      spec.encoding = "terrarium";
      if (def.maxzoom) spec.maxzoom = def.maxzoom;
      if (def.attribution) spec.attribution = def.attribution;
    }
    map.addSource(TERRAIN_SOURCE_ID, spec);
    appliedTerrainDemKey = terrainDemKey;
  }
  map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: terrainExaggeration });
  // 地形を眺められるよう最大ピッチを緩和(deck.gl overlay と同じ措置)
  try { if (map.getMaxPitch() < 70) map.setMaxPitch(85); } catch (_) {}
  regroundAllDeck();
}

// DEM タイルの到着に合わせて 3D Tiles の接地高を再サンプルする。
// テレイン ON 直後・未読込領域では queryTerrainElevation が 0 を返すため、
// タイル読込(sourcedata)をトリガに遅延して再接地する
let regroundTimer = null;
map.on("sourcedata", e => {
  if (e.sourceId !== TERRAIN_SOURCE_ID) return;
  clearTimeout(regroundTimer);
  regroundTimer = setTimeout(regroundAllDeck, 300);
});

// 表示タブ: ベースマップ透過度・回転・レイヤー透過度・スケールバー・座標・ポップアップ
{
  const opacity = document.querySelector("#display-opacity");
  const rotation = document.querySelector("#display-rotation");
  const north = document.querySelector("#display-north");
  opacity?.addEventListener("input", () => {
    for (const entry of currentBaseEntries) {
      entry.lids.forEach(lid => map.getLayer(lid) && map.setPaintProperty(lid, "raster-opacity", Number(opacity.value)));
    }
  });
  rotation?.addEventListener("change", () => map.setBearing(-Number(rotation.value || 0)));
  north?.addEventListener("change", () => {
    if (north.checked) { rotation.value = "0"; map.easeTo({ bearing: 0 }); }
  });

  const layerOpacity = document.querySelector("#display-layer-opacity");
  layerOpacity?.addEventListener("input", () => {
    const v = Number(layerOpacity.value);
    let deckDirty = false;
    for (const e of layerEntries) {
      for (const [lid, o] of e.opas || []) {
        if (map.getLayer(lid)) map.setPaintProperty(lid, o.prop, o.base * v);
        else if (deckDefs.has(lid)) { deckDefs.get(lid).opacity = o.base * v; deckDirty = true; }
      }
    }
    if (deckDirty) syncDeckLayers();
  });

  // スケールは他エンジンと同じ中央下へ置く（addControl は四隅のみ対応のため
  // bottom-left コンテナを index.html 側の CSS で中央寄せしている）
  const scaleCtl = new maplibregl.ScaleControl({ unit: "metric" });
  map.addControl(scaleCtl, "bottom-left");
  document.querySelector("#display-scalebar")?.addEventListener("change", e => {
    if (e.target.checked) map.addControl(scaleCtl, "bottom-left");
    else map.removeControl(scaleCtl);
  });

  const coordsEl = document.querySelector("#map-coords");
  map.on("mousemove", e => {
    if (!coordsEl || !document.querySelector("#display-coords")?.checked) return;
    coordsEl.textContent = `${e.lngLat.lng.toFixed(5)}, ${e.lngLat.lat.toFixed(5)}`;
  });
  document.querySelector("#display-coords")?.addEventListener("change", e => {
    if (coordsEl) coordsEl.style.display = e.target.checked ? "" : "none";
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

  const terrainToggle = document.querySelector("#display-terrain");
  const terrainSourceSel = document.querySelector("#display-terrain-source");
  const terrainExaggSlider = document.querySelector("#display-terrain-exagg");
  terrainToggle?.addEventListener("change", () => {
    terrainEnabled = terrainToggle.checked;
    // "DEMなし" 選択中に ON にした場合は既定の DEM ソースへ戻す
    if (terrainEnabled && !terrainDemSources[terrainDemKey]) {
      terrainDemKey = "reearth-ellipsoid";
      if (terrainSourceSel) terrainSourceSel.value = terrainDemKey;
    }
    applyTerrain();
  });
  terrainSourceSel?.addEventListener("change", () => {
    terrainDemKey = terrainSourceSel.value;
    // DEM ソース選択時はテレイン表示を既定 ON にする（"none"=DEMなし は OFF。
    // Cesium 版 #dem-source と同じ挙動）
    terrainEnabled = terrainDemKey !== "none";
    if (terrainToggle) terrainToggle.checked = terrainEnabled;
    applyTerrain();
  });
  terrainExaggSlider?.addEventListener("input", () => {
    terrainExaggeration = Number(terrainExaggSlider.value);
    if (terrainEnabled && map.getTerrain()) {
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: terrainExaggeration });
      regroundAllDeck(); // queryTerrainElevation は誇張込みのため再接地が必要
    }
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
    const res = await fetch(backendUrl(`/api/files/${encodeURIComponent(project)}/${rel}`), { method: "PUT", body: content });
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

// ---- AI チャット連携（kasugaiApi アダプタ + shared/ai-chat.js） ----
window.kasugaiApi = createPlayerApi({
  engine: "maplibre",
  getEntries: () => layerEntries,
  getBaseEntries: () => currentBaseEntries,
  getProjectId: () => currentProjectId,
  getBaseUrl: () => lastBaseUrl,
  loadProject,
  applyInspectorText,
  getInspectorText: () => inspectorInput.value,
  setInspectorText: v => { inspectorInput.value = v; },
  applyEntryVisibility, focusEntry, maybeLoadEntry, applyLegendFilter,
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
    // undefined キー(bearing/pitch)を渡すと maplibre-gl v5 の flyTo が
    // _calcMatrices でクラッシュしレンダーループが止まるため省略して組み立てる
    const opts = { center: [Number(v.longitude), Number(v.latitude)] };
    // v.zoom は engine ネイティブ(getViewInfo と往復)なので素通し、camToZoom 由来は -1
    opts.zoom = Number.isFinite(v.zoom) ? v.zoom : camToZoom(v) - 1;
    if (Number.isFinite(v.heading)) opts.bearing = -v.heading;
    if (Number.isFinite(v.pitch)) opts.pitch = Math.max(0, Math.min(60, v.pitch + 90));
    // instant=フライパス巡回等の高頻度更新。flyTo の逐次再起動を避け即時配置する
    if (v.instant) map.jumpTo(opts);
    else map.flyTo(opts);
  },
  getViewInfo: () => {
    const c = map.getCenter();
    return { latitude: c.lat, longitude: c.lng, zoom: map.getZoom(), heading: -map.getBearing(), pitchDeg: map.getPitch() };
  },
  fitBoundsView: (w, s, e, n) => map.fitBounds([w, s, e, n], { padding: 60, maxZoom: 17 }),
  mountEntry: async (entry, preloaded) => {
    const idx = layerEntries.indexOf(entry);
    const r = await addKascLayer(entry.item, lastBaseUrl, preloaded || entry.item._preloaded,
      () => findInsertBeforeId(idx < 0 ? layerEntries.length : idx));
    entry.lids = r.lids; entry.sid = r.sid; entry.filters = r.filters; entry.opas = r.opas;
    entry.item._viewportQuery = r.viewportQuery;
    applyEntryVisibility(entry);
    updateMapAttribution();
  },
  unmountEntry: entry => {
    for (const lid of entry.lids || []) {
      if (deckDefs.has(lid)) { deckDefs.delete(lid); continue; }
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (entry.sid && map.getSource(entry.sid)) map.removeSource(entry.sid);
    syncDeckLayers();
    updateMapAttribution();
  },
  reloadEntryData: async entry => {
    const { geojson } = await loadVectorItem(entry.item, lastBaseUrl, getViewBounds());
    entry.item._geojson = geojson;
    const env = geojsonExtent(geojson);
    if (env) entry.item._env = env;
    const src = map.getSource(entry.sid);
    if (src?.setData) src.setData(geojson);
  },
  getEntryGeoJson: entry => entry.item._geojson || null,
  setBaseEntryVisible: (entry, on) => {
    for (const lid of entry.lids || []) {
      if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", on ? "visible" : "none");
    }
    updateMapAttribution();
  },
});
mountEngineSwitcher(document.querySelector("#engines"), "maplibre");
void initAiChat({ engine: "maplibre", manageBackend: true });

// 印刷: タイル読み込み完了(idle)後に地図canvasを取得
// (preserveDrawingBuffer不要)。deck.gl 等のオーバーレイcanvasも合成する
initPrint({
  button: document.querySelector("#print-open"),
  captureMap: async () => {
    await new Promise(res => {
      const t = setTimeout(res, 15000);
      map.once("idle", () => { clearTimeout(t); res(); });
      map.triggerRepaint();
    });
    const c = compositeCanvases(map.getContainer());
    return c ? c.toDataURL("image/png") : null;
  },
  getScaleDenominator: () => {
    const lat = map.getCenter().lat;
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, map.getZoom());
    return mpp / 0.00028;
  },
  getNorthAngleDeg: () => -map.getBearing(),
});
