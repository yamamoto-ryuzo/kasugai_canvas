// KASUGAI Canvas — OpenLayers フロント
// .kasc プレイヤーモード: projects/<id>/ の .kasc+DATA/ を OpenLayers で再生する
import Map from "https://cdn.jsdelivr.net/npm/ol@10.11.0/Map.js";
import View from "https://cdn.jsdelivr.net/npm/ol@10.11.0/View.js";
import TileLayer from "https://cdn.jsdelivr.net/npm/ol@10.11.0/layer/Tile.js";
import VectorLayer from "https://cdn.jsdelivr.net/npm/ol@10.11.0/layer/Vector.js";
import HeatmapLayer from "https://cdn.jsdelivr.net/npm/ol@10.11.0/layer/Heatmap.js";
import ImageLayer from "https://cdn.jsdelivr.net/npm/ol@10.11.0/layer/Image.js";
import XYZ from "https://cdn.jsdelivr.net/npm/ol@10.11.0/source/XYZ.js";
import TileWMS from "https://cdn.jsdelivr.net/npm/ol@10.11.0/source/TileWMS.js";
import VectorSource from "https://cdn.jsdelivr.net/npm/ol@10.11.0/source/Vector.js";
import ClusterSource from "https://cdn.jsdelivr.net/npm/ol@10.11.0/source/Cluster.js";
import StaticSource from "https://cdn.jsdelivr.net/npm/ol@10.11.0/source/ImageStatic.js";
import GeoJSON from "https://cdn.jsdelivr.net/npm/ol@10.11.0/format/GeoJSON.js";
import { fromLonLat, toLonLat, transformExtent, getPointResolution } from "https://cdn.jsdelivr.net/npm/ol@10.11.0/proj.js";
import { loadKascProject, NON_LAYER_TYPES, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeightView, heightToViewZoom, viewZoomToHeight, groundCenterFromCam, parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle, appendGroupedTitleOptions, syncBasemapList, sanitizeAttributionFragment, layerAttribution, loadKascInfoContent, buildWmtsTileTemplate, rewriteKascVisibility, rewriteKascLineOpt, themeShowSet, kascTitleInTheme, fillThemeSelect, loadKascBookmarks, parseQgisBookmarksXml, qgisBookmarkToCam, downloadQgisBookmarksXml, downloadKascCamLines, projectsBaseUrl, applyPanelTitle, resolveDefaultPointStyle, resolveDefaultLineStyle, resolveDefaultPolygonStyle, defaultPointRadius, cssColorWithAlpha, kascOptOn, parseImageOverlay, kascScaleResRange } from "../shared/kasc.js";
import { createKascFlyPaths } from "../shared/fly-kasc.js";
import { backendUrl } from "../shared/backend.js";
import { loadVectorItem, isViewportQueryItem } from "../shared/vector-load.js";
import { diagnoseHubLayerError } from "../shared/hub-diag.js";
import { createMinimap } from "../shared/minimap.js";
import { initGeoTools2d } from "../shared/geo-tools-2d.js";
import { createAttrWidget, renderAttrContent, attrEntriesFromProps } from "../shared/attr-widget.js";
import { initAiChat, hasBackendFeature } from "../shared/ai-chat.js";
import { createPlayerApi } from "../shared/player-api.js";
import { mountEngineSwitcher } from "../shared/engine-switch.js";
import { matchSessionState, bindSessionState, applySessionState, sessionBootView } from "../shared/session-state.js";
import { initPrint, compositeCanvases } from "../shared/print.js";
import { initNavTools } from "../shared/nav-tools.js";
import { coordPins } from "../shared/coord-pins.js";
import { formatLatLng } from "../shared/coords-format.js";
import { installLocalCrsUI } from "../shared/coords-local.js";

import { groundDeckTileset } from "../shared/deck-ground.js";
import { buildDeckDrapeLayers, invalidateDeckTerrainCovers, isGoogle3dTilesUrl, withGoogleTileKey, ensureGoogleTileKeyFetch } from "../shared/deck-drape.js";
import { qmlLegendSwatchDataUrl, defaultVectorLegendSpec } from "../shared/qml-2d.js";
import Style from "https://cdn.jsdelivr.net/npm/ol@10.11.0/style/Style.js";
import Fill from "https://cdn.jsdelivr.net/npm/ol@10.11.0/style/Fill.js";
import Stroke from "https://cdn.jsdelivr.net/npm/ol@10.11.0/style/Stroke.js";
import CircleStyle from "https://cdn.jsdelivr.net/npm/ol@10.11.0/style/Circle.js";
import Icon from "https://cdn.jsdelivr.net/npm/ol@10.11.0/style/Icon.js";
import Text from "https://cdn.jsdelivr.net/npm/ol@10.11.0/style/Text.js";
import { loadCompiledQml, olQmlStyleFunction, compiledScaleToResRange, installLayerVisibilityResolver } from "../shared/qml-2d.js";
import { defaults as defaultControls } from "https://cdn.jsdelivr.net/npm/ol@10.11.0/control/defaults.js";
import ScaleLine from "https://cdn.jsdelivr.net/npm/ol@10.11.0/control/ScaleLine.js";
import MousePosition from "https://cdn.jsdelivr.net/npm/ol@10.11.0/control/MousePosition.js";
import { createStringXY } from "https://cdn.jsdelivr.net/npm/ol@10.11.0/coordinate.js";

const VECTOR_TYPES = new Set(["geojson", "layer", "geoparquet", "parquet", "flatgeobuf", "fgb", "gpkg", "geopackage", "csv", "tsv", "duckdb", "sql", "kml", "kmz", "wfs", "shp", "shapefile"]);
// ⏷フィルタ編集の対象（where= またはクエリ全文の再読み込みが効く形式）
const QUERY_TYPES = new Set(["gpkg", "geopackage", "duckdb", "sql"]);

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

const map = new Map({
  target: "map",
  // 出典は Cesium 版と同型の右下オーバーレイ、方位・全体表示は右上の
  // ナビゲーションツールバーで代替するため標準コントロールは無効化
  controls: defaultControls({ attribution: false, zoom: false, rotate: false }),
  layers: [],
  view: new View({ center: fromLonLat([139.767, 35.681]), zoom: 10 }),
});
window.kascMap = map; // デバッグ/外部連携用参照（他エンジンと同じ公開範囲）

// 地物の範囲へ移動。属性一覧・属性タブの行クリックで共通使用。
// GeoJSON Feature(EPSG:4326)と ol/Feature(EPSG:3857)の両方を受け付ける
function focusFeatureExtent(feature) {
  const geom = feature?.getGeometry?.();
  if (geom) {
    map.getView().fit(geom.getExtent(), { padding: [60, 60, 60, 60], maxZoom: 18, duration: 400 });
    return;
  }
  const env = geojsonExtent({ type: "FeatureCollection", features: [feature] });
  if (env) {
    const ext = [...fromLonLat([env.west, env.south]), ...fromLonLat([env.east, env.north])];
    map.getView().fit(ext, { padding: [60, 60, 60, 60], maxZoom: 18, duration: 400 });
  }
}

// 全レイヤのデータ範囲（item._env / layer の kascEnv）の合範囲へ fit する。
// 範囲が取れなければ false を返す。プロジェクト初期表示と ⌂ ボタンで共用
function fitDataExtent({ padding = [30, 30, 30, 30], maxZoom = 17, duration = 0 } = {}) {
  let union = null;
  for (const e of layerEntries) {
    const env = e.item?._env || e.layer?.get?.("kascEnv");
    if (!env) continue;
    const ext = [...fromLonLat([env.west, env.south]), ...fromLonLat([env.east, env.north])];
    union = union
      ? [Math.min(union[0], ext[0]), Math.min(union[1], ext[1]), Math.max(union[2], ext[2]), Math.max(union[3], ext[3])]
      : ext;
  }
  if (!union) return false;
  map.getView().fit(union, { padding, maxZoom, duration });
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

// 現在プロジェクトのレイヤーエントリ（表示範囲連動の再クエリ用）
let layerEntries = [];
// QML 式 is_layer_visible('名前') を item.visible へ解決する(Cesium 版と同規則)
installLayerVisibilityResolver(() => layerEntries.map(e => e.item));
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
const mapCanvasH = () => map.getSize()?.[0] || 512;
function mapViewToUrl() {
  const view = map.getView();
  const lonlat = toLonLat(view.getCenter() || [0, 0]);
  const zoom = view.getZoom();
  return {
    latitude: lonlat[1],
    longitude: lonlat[0],
    zoom,
    height: Number.isFinite(zoom) ? viewZoomToHeight(lonlat[1], zoom, mapCanvasH()) : NaN,
    pitch: -90,
    heading: -(view.getRotation() * 180 / Math.PI),
  };
}

function urlViewToViewOptions(v) {
  const gc = groundCenterFromCam(v); // pitch は座標計算にのみ使用
  return {
    center: fromLonLat([gc.longitude, gc.latitude]),
    zoom: Number.isFinite(v.height) ? heightToViewZoom(gc.latitude, v.height, mapCanvasH())
      : (Number.isFinite(v.zoom) ? v.zoom : camToZoom(v)),
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

let deckInst = null;             // deck.Deck インスタンス（オーバーレイキャンバス）
// Map は ol.Map の import でシャドウされるため globalThis.Map を使う
const deckDefs = new globalThis.Map(); // lid("deck-N") → { item, url, opacity, pointSize, order }
// 3D Tiles ドレープ設定（deck.gl TerrainExtension。
// Cesium 版のドレープ対象地形=3D Tiles（drape-terrain-tiles3d・
// basemap-drape-3dtiles・drape-xyz/​geojson-tiles3d）に相当）
const drapeTiles3d = { enabled: true, basemap: true, xyz: true, vector: true, google: false };

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
  for (const def of deckDefs.values()) if (def.item.visible !== false && (drapeTiles3d.google || !isGoogle3dTilesUrl(def.url))) return true;
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
      data: def.item.visible !== false && !def.zoomHidden ? def.url : null,
      visible: def.item.visible !== false && !def.zoomHidden,
      opacity: def.opacity,
      // ドレープ有効時は 3D Tiles を地形ソース化する（drape レイヤーの貼り付け先）
      operation: drapeOn && (drapeTiles3d.google || !isGoogle3dTilesUrl(def.url)) ? "terrain+draw" : "draw",
      pickable: true,
      onTilesetLoad: tileset => {
        try {
          const c = tileset?.cartographicCenter;
          if (Array.isArray(c) && !def.item._env) def.item._center = [c[0], c[1]];
          // テレイン不在のためバウンディングボリューム最小高で z=0 平面へ接地させる
          // （.kasc opts: ground=off で無効化、zoffset=<m> で手動補正。
          //   Google Photorealistic はジオリファレンス済みかつ全球規模の
          //   boundingVolume が接地高推定を狂わせるため対象外）
          if (!isGoogle3dTilesUrl(def.url)) groundDeckTileset(tileset, def.item.opts);
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
      // on=false は縮尺範囲外も含むため zoomHidden として保持する
      setVisible(on) { def.zoomHidden = on === false; if ((def.item.visible !== false && !def.zoomHidden) || deckInst) void syncDeckLayersAsync(); },
      setOpacity(v) { def.opacity = v; syncDeckLayers(); },
      get() { return undefined; },
      changed() {},
    };
  }
  if (item.type === "wms" || item.type === "wmts") {
    const ogc = buildOgcRasterLayer(item, baseUrl);
    applyScaleRes(ogc, item);
    return ogc;
  }
  if (item.type === "image") {
    // ジオリファレンス画像オーバーレイ(現場写真・紙図面)。corners= は外接矩形へ正規化
    const ov = parseImageOverlay(item);
    let env = ov.bbox;
    if (!env && ov.corners) {
      const lons = ov.corners.map(c => c[0]), lats = ov.corners.map(c => c[1]);
      env = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    }
    if (!env) throw new Error("image: bbox= または corners= の指定が必要です");
    const layer = new ImageLayer({
      source: new StaticSource({
        url: resolveKascUrl(item.url, baseUrl),
        imageExtent: [...fromLonLat([env[0], env[1]]), ...fromLonLat([env[2], env[3]])],
        attributions: layerAttribution(item) || undefined,
        crossOrigin: "anonymous",
      }),
      opacity: Number(item.opts?.opacity ?? 1),
    });
    layer.set("kascEnv", { west: env[0], south: env[1], east: env[2], north: env[3] });
    applyScaleRes(layer, item);
    return layer;
  }
  const source = xyzSource(item, baseUrl);
  if (VECTOR_TYPES.has(item.type)) {
    const loaded = preloaded || await loadVectorItem(item, baseUrl, getViewBounds());
    const geojson = loaded.geojson;
    item._geojson = geojson; // 3D Tiles ドレープコピー・属性テーブルの描画ソースとして保持
    item._viewportQuery = !!loaded.viewportQuery;
    const features = new GeoJSON().readFeatures(geojson, {
      featureProjection: "EPSG:3857",
      dataProjection: "EPSG:4326",
    });
    const vectorSource = new VectorSource({
      attributions: layerAttribution(item) || undefined,
      features,
    });
    const hasPoints = geojson.features?.some(f => /point/i.test(f?.geometry?.type || ""));
    const wantCluster = hasPoints && kascOptOn(item.opts?.cluster);
    const wantHeat = hasPoints && kascOptOn(item.opts?.heat ?? item.opts?.heatmap);
    const layer = wantHeat
      ? new HeatmapLayer({ source: vectorSource, blur: 15, radius: 10 })
      : new VectorLayer({
          source: wantCluster ? new ClusterSource({ source: vectorSource, distance: 40 }) : vectorSource,
        });
    const env = geojsonExtent(geojson);
    if (env) layer.set("kascEnv", env);
    // クラスタスタイル: 複数地物は件数バッジ、単体は素のスタイル関数へ委譲する
    const clusterStyleFn = baseFn => feature => {
      const inner = feature.get("features");
      if (inner && inner.length > 1) {
        const n = inner.length;
        const color = n < 10 ? "#3a7bd5" : n < 100 ? "#e67e22" : "#c0392b";
        return new Style({
          image: new CircleStyle({
            radius: Math.min(16 + Math.floor(Math.log10(n) * 4), 26),
            fill: new Fill({ color: color + "dd" }),
            stroke: new Stroke({ color: "#ffffff", width: 1.5 }),
          }),
          text: new Text({ text: String(n), fill: new Fill({ color: "#ffffff" }), scale: 1.1 }),
        });
      }
      return baseFn(inner ? inner[0] : feature);
    };
    let baseStyleFn = makeDefaultVectorStyle();
    if (item.opts?.style) {
      try {
        const compiled = await loadCompiledQml(item.opts.style, baseUrl);
        item._qml = compiled;
        const base = olQmlStyleFunction(compiled, { Style, Fill, Stroke, Circle: CircleStyle, Icon, Text });
        // 凡例シンボル単位の表示切替: 先頭シンボル名が hidden 集合にある地物は描画しない
        baseStyleFn = f => {
          const names = compiled.namesFor?.(f.getProperties() || {});
          if (names?.length && item._legendHidden?.has(names[0])) return null;
          return base(f);
        };
        const range = compiledScaleToResRange(compiled);
        if (range) {
          layer.setMinResolution(range.minRes);
          if (Number.isFinite(range.maxRes)) layer.setMaxResolution(range.maxRes);
        }
      } catch (e) { console.warn("QML 適用失敗:", item.opts.style, e); }
    }
    if (!wantHeat) layer.setStyle(wantCluster ? clusterStyleFn(baseStyleFn) : baseStyleFn);
    applyScaleRes(layer, item);
    syncDeckLayers(); // 読込完了でドレープコピー対象(_geojson)が増えた場合に反映
    return layer;
  }
  // xyz / base はラスタタイル
  const layer = new TileLayer({ source });
  if (item.opts?.opacity !== undefined) layer.setOpacity(Number(item.opts.opacity));
  const extent = bboxExtent(item);
  if (extent) layer.setExtent(extent);
  applyScaleRes(layer, item);
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

// 縮尺表示(minScale=/maxScale=) → 解像度範囲でレイヤ可視条件へ反映する。
// OL レイヤは min/maxResolution を持ちレンダラが自動で隠すため、
// deck(3dtiles)スタブの zoomHidden 判定用に effectiveVisible 側でも使う
function applyScaleRes(layer, item) {
  const r = kascScaleResRange(item?.opts || {});
  if (!r) return;
  if (r.minRes > 0) layer.setMinResolution(Math.max(layer.getMinResolution() || 0, r.minRes));
  if (Number.isFinite(r.maxRes)) {
    const cur = layer.getMaxResolution();
    layer.setMaxResolution(Math.min(Number.isFinite(cur) ? cur : Infinity, r.maxRes));
  }
}

function effectiveVisible(entry) {
  if (!entry.item.visible) return false;
  const r = kascScaleResRange(entry.item.opts || {});
  if (r) {
    const res = map.getView().getResolution() ?? Infinity;
    if (res < r.minRes || res > r.maxRes) return false;
  }
  return true;
}

function applyEntryVisibility(entry) {
  // 未読込(遅延ロード)エントリは layer が無いのでスキップする。
  // OL レイヤ本体は min/maxResolution が自動適用されるため、ここでの
  // effectiveVisible 評価は主に deck(3dtiles)スタブの zoomHidden 同期用
  entry.layer?.setVisible?.(effectiveVisible(entry));
  syncDeckLayers(); // ドレープコピーの表示追従（deck 未初期化なら no-op）
  updateMapAttribution();
}

// deck(3dtiles)スタブは解像度範囲を持たないため、解像度変化で表示を再評価する
map.getView().on("change:resolution", () => {
  for (const e of layerEntries) {
    if (e.layer?._isDeck && kascScaleResRange(e.item.opts || {})) e.layer.setVisible(effectiveVisible(e));
  }
});

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

// style= 未指定ベクターの自動凡例: OL 既定スタイル(薄白塗り・#3399CC線)と
// 先頭地物のジオメトリ種別から代表スウォッチ spec を作る(Cesium 版の entity
// サンプル凡例相当)。未読込(遅延ロード)は _geojson が無いので null を返し、
// ensureEntryLoaded 後の renderLayerRows 再描画でスウォッチが出る
const OL_DEFAULT_VECTOR_COLORS = { fill: [1, 1, 1, 0.4], stroke: [0.2, 0.6, 0.8, 1], strokeWidth: 1.25, point: [0.2, 0.6, 0.8, 1] };
// OL 既定スタイルと同じ見た目をベースに、simplestyle > default_style: > OL既定 の
// 順で各項目を解決するスタイル関数。同じ解決結果は Style インスタンスを使い回す
const OL_POINT_DFLT = { color: "rgba(255,255,255,0.4)", size: 0, opacity: 1 };
const OL_LINE_DFLT = { color: "rgba(51,153,204,1)", width: 1.25, opacity: 1 };
const OL_POLY_DFLT = { fill: "rgba(255,255,255,0.4)", fillOpacity: 1, stroke: "rgba(51,153,204,1)", strokeWidth: 1.25, strokeOpacity: 1 };
function makeDefaultVectorStyle() {
  const ds = currentDefaultStyles || {};
  const styleCache = new Map();
  return feature => {
    const props = feature.getProperties() || {};
    const gt = feature.getGeometry()?.getType() || "";
    const key = gt + "|" + JSON.stringify(props);
    let st = styleCache.get(key);
    if (!st) {
      const opts = {};
      if (/Polygon|Collection/.test(gt)) {
        const s = resolveDefaultPolygonStyle(props, ds.polygon, ds.line, OL_POLY_DFLT);
        opts.fill = new Fill({ color: cssColorWithAlpha(s.fill, s.fillOpacity) });
        opts.stroke = new Stroke({ color: cssColorWithAlpha(s.stroke, s.strokeOpacity), width: s.strokeWidth });
      } else if (/Point/.test(gt)) {
        const s = resolveDefaultPointStyle(props, ds.point, OL_POINT_DFLT);
        opts.image = new CircleStyle({
          radius: s.size ? defaultPointRadius(s.size) : 5,
          fill: new Fill({ color: cssColorWithAlpha(s.color, s.opacity) }),
          stroke: new Stroke({ color: cssColorWithAlpha(props.stroke ?? ds.line?.color ?? OL_LINE_DFLT.color, Number(props["stroke-opacity"]) || 1), width: Number(props["stroke-width"]) || 1.25 }),
        });
      } else {
        const s = resolveDefaultLineStyle(props, ds.line, OL_LINE_DFLT);
        opts.stroke = new Stroke({ color: cssColorWithAlpha(s.color, s.opacity), width: s.width });
      }
      st = new Style(opts);
      styleCache.set(key, st);
    }
    return st;
  };
}
function defaultLegendSpec(item) {
  if (item._qml || !VECTOR_TYPES.has(item.type)) return null;
  for (const f of item._geojson?.features || []) {
    const spec = defaultVectorLegendSpec(f?.geometry?.type || "", OL_DEFAULT_VECTOR_COLORS);
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
  if (entry.unsupported) { cb.disabled = true; row.style.opacity = ".45"; row.title = "このエンジン未対応の形式(Cesium 版で対応)"; }
  if (exclusive) cb.name = radioName;
  if (exclusive) {
    cb.addEventListener("pointerdown", () => { cb._wasChecked = cb.checked; });
    cb.addEventListener("click", () => { if (cb._wasChecked) { cb.checked = false; cb.dispatchEvent(new Event("change")); } });
  }
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

  // クエリ系レイヤーの絞り込み条件変更（Cesium 版の ⏷ ボタン相当）
  if (QUERY_TYPES.has(item.type)) {
    const qb = document.createElement("button");
    qb.type = "button";
    qb.className = "layer-filter";
    qb.textContent = "⏷";
    qb.title = item.type === "sql" ? "クエリを編集" : "絞り込み条件（WHERE式）を編集";
    qb.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
      void editEntryQueryFilter(entry);
    });
    row.append(qb);
  }
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

const expandedLayerGroups = new Set();

function renderLayerRows(entries, unsupported) {
  panel.layers.innerHTML = "";

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
      for (const e of members) panel.layers.append(buildLayerRow(e, false, null));
      continue;
    }
    const key = `${group}|${exclusive ? "exclusive" : "regular"}`;
    const section = document.createElement("section");
    section.className = "layer-group" + (exclusive ? " exclusive" : "");
    const head = document.createElement("div");
    head.className = "layer-group-title";
    const tg = document.createElement("button");
    tg.type = "button";
    tg.className = "layer-group-toggle";
    tg.textContent = expandedLayerGroups.has(key) ? "▾" : "▸";
    tg.setAttribute("aria-expanded", String(expandedLayerGroups.has(key)));
    const gcb = document.createElement("input");
    gcb.type = exclusive ? "radio" : "checkbox";
    if (exclusive) gcb.name = `grp-excl-${key}`;
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
    entry.error = (await diagnoseHubLayerError(entry.item, err))?.message || err?.message || err;
    if (!currentUnsupported.some(u => u._idx != null && u._idx === entry.item._idx && /\(読込失敗\)$/.test(u.type))) {
      currentUnsupported.push({ ...entry.item, type: `${entry.item.type}(読込失敗)` });
    }
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

// 地図下部の読込進捗ピル。完了時は「読込完了」を短時間表示して消える
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

// .kasc fly_geojson: 行 → フライパス（player-api のフックへ展開。
// shared/fly-kasc.js がインスペクタ行の追記・書き戻しも面倒を見る）
const kascFlyPaths = createKascFlyPaths({
  resolveUrl: u => resolveKascUrl(u, lastBaseUrl),
  getInspectorText: () => inspectorInput.value,
  setInspectorText: v => { inspectorInput.value = v; },
});
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
        if (e) map.getView().fit([...fromLonLat([e.west, e.south]), ...fromLonLat([e.east, e.north])], { padding: [40, 40, 40, 40], maxZoom: 20, duration: 600 });
        else { const gc = groundCenterFromCam(cam); map.getView().animate({ center: fromLonLat([gc.longitude, gc.latitude]), zoom: heightToViewZoom(gc.latitude, cam.height, mapCanvasH()), duration: 600 }); }
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
let pendingSwitchState = matchSessionState();
let switchRestore = null;

function applySwitchRestore(sw) {
  applySessionState(sw, {
    entries: layerEntries, themeSelect,
    setVisible: (e, on) => { e.item.visible = on; if (!e.unsupported) applyEntryVisibility(e); },
    rerender: () => renderLayerRows(layerEntries, currentUnsupported),
  });
}

// .kasc 文書(doc)を描画する。loadProject(ファイル読込)と
// インスペクター(テキスト適用)の共通経路

// ---- Google Maps（Maps API キー + Photorealistic 3D Tiles） ----
// 設定で ON かつキー保存済みならレイヤ一覧へ自動追加する（.kasc 宣言済みなら重複しない）
const GOOGLE_3DTILES_ID = "google-photorealistic-3dtiles";
const GOOGLE_3DTILES_URL = "https://tile.googleapis.com/v1/3dtiles/root.json";
const google3dTilesEnabled = () =>
  localStorage.getItem("googleMaps3dTiles") === "1" && !!localStorage.getItem("googleMapsApiKey");
// Google 3D Tiles(tileset.json・タイル本体とも key= 必須)向けに fetch フックを仕込む
ensureGoogleTileKeyFetch();
let lastDoc = null;

// doc.layers へ auto 印の Google 3D 行を注入する（既存の auto 行は張り替え、
// 表示状態だけは直前のものを引き継ぐ）
function injectGoogle3dTilesItem(doc) {
  const prev = (doc.layers || []).find(i => i.id === GOOGLE_3DTILES_ID);
  doc.layers = (doc.layers || []).filter(i => i.id !== GOOGLE_3DTILES_ID);
  if (!google3dTilesEnabled()) return;
  if (doc.layers.some(i => i.type === "3dtiles" && isGoogle3dTilesUrl(i.url))) return;
  doc.layers.unshift({
    id: GOOGLE_3DTILES_ID, type: "3dtiles",
    title: "Google Photorealistic 3D Tiles", url: GOOGLE_3DTILES_URL,
    visible: prev ? prev.visible !== false : true,
    _idx: -Number.MAX_SAFE_INTEGER,
  });
}

async function rerenderProjectKeepView() {
  if (!lastDoc) return;
  const v = map.getView();
  const c = v.getCenter(), z = v.getZoom(), r = v.getRotation();
  await renderProject(currentProjectId, lastBaseUrl, lastDoc);
  v.setCenter(c); v.setZoom(z); v.setRotation(r);
}

async function renderProject(loadedId, baseUrl, doc, manifest) {
  const seq = ++renderSeq;
  lastDoc = doc;
  injectGoogle3dTilesItem(doc);
  clearTimeout(progressHideTimer);
  if (progressEl) progressEl.hidden = true;
  map.getLayers().clear();
  deckDefs.clear();
  syncDeckLayers();
  layerEntries = [];
  panel.layers.innerHTML = "";
  currentProjectId = loadedId;
  applyPanelTitle(doc.title);
  currentDefaultStyles = doc.defaultStyles || null;

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
  // 3dtiles: は deck.gl、fly_geojson: はフライパスとして対応するため未対応通知から外す
  kascFlyPaths.setItems(doc.unsupported);
  const unsupported = doc.unsupported.filter(i => i.type !== "3dtiles" && i.type !== "fly_geojson" && !NON_LAYER_TYPES.has(i.type));

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
    // "グループ/名前" タイトルは optgroup でグループ化表示する。
    // optgroup があれば select を折りたたみ可能なリスト UI へ置き換える
    appendGroupedTitleOptions(sel, baseEntries.map(e => e.item), (item, leafTitle, i) => {
      const opt = document.createElement("option");
      opt.value = i; opt.textContent = leafTitle || `base ${i}`;
      return opt;
    });
    baseEntries.forEach((entry, i) => {
      entry.layer.setVisible(i === active);
    });
    sel.value = active;
    // 初期表示は選択中の1レイヤのみ示す畳み状態で同期するため、
    // sel.value 確定後にリストを描画する
    syncBasemapList(sel);
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
  const urlView = urlViewConsumed ? null : sessionBootView(switchRestore);
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
    const gc = groundCenterFromCam(cam);
    map.getView().setCenter(fromLonLat([gc.longitude, gc.latitude]));
    map.getView().setZoom(heightToViewZoom(gc.latitude, cam.height, mapCanvasH()));
  } else {
    needExtentFit = true;
  }

  // レイヤ行を先に描画して読込状態を行ごとに表示し、データは取得できた順に
  // 正しい描画順(insertEntryLayer)で地図へ追加する。
  // `| off` のベクター行は表示 ON までデータ取得を遅延する
  const orderedItems = [...doc.layers, ...doc.unsupported.filter(i => i.type !== "fly_geojson" && !NON_LAYER_TYPES.has(i.type))]
    .sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
  const entries = orderedItems.map(item => ({
    item, layer: null, pending: true,
    unsupported: doc.unsupported.includes(item) && item.type !== "3dtiles",
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
    if (entry.unsupported) { entry.pending = false; syncRowStatus(entry); return; }
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
      entry.error = (await diagnoseHubLayerError(item, err))?.message || err?.message || err;
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

  // プロジェクト再描画で map.getLayers().clear された分を含め、
  // 共有ストアの状態へ座標ピンレイヤーを再同期する
  coordPins.refresh();
}

// エントリのデータを現在の表示範囲・条件で再読み込みする。
// player-api の reloadEntryData フックと ⏷ フィルタ編集の共通経路
async function reloadEntryData(entry) {
  const { geojson } = await loadVectorItem(entry.item, lastBaseUrl, getViewBounds());
  entry.item._geojson = geojson;
  const src = entry.layer?.getSource?.();
  if (src) {
    src.clear();
    src.addFeatures(new GeoJSON().readFeatures(geojson, { featureProjection: "EPSG:3857", dataProjection: "EPSG:4326" }));
  }
  syncDeckLayers(); // ドレープコピーのデータ更新
}

// クエリ系レイヤーの絞り込み条件を対話的に変更し、item とインスペクタ行を
// 同期して再読み込みする（Cesium 版 editLayerQueryFilter 相当）
async function editEntryQueryFilter(entry) {
  const item = entry.item;
  const isSql = item.type === "sql";
  const current = isSql ? (item.url || "") : (item.opts?.where || "");
  const input = window.prompt(isSql ? "SQLクエリを入力" : "WHERE式を入力（空欄で解除）", current);
  if (input === null) return;
  const value = input.trim();
  const oldLine = item.line;
  if (isSql) {
    if (!value) return;
    item.url = value;
    item.line = `sql:${item.title} | ${value}${item.visible === false ? " | off" : ""}`;
  } else {
    item.opts ||= {};
    item.opts.where = value || undefined;
    if (oldLine) item.line = rewriteKascLineOpt(oldLine, "where", value);
  }
  if (oldLine && item.line && item.line !== oldLine) {
    inspectorInput.value = inspectorInput.value
      .split(/\r?\n/).map(l => (l.trim() === oldLine ? item.line : l)).join("\n");
  }
  if (entry.deferred) { renderLayerRows(layerEntries, currentUnsupported); return; }
  try {
    await reloadEntryData(entry);
    attrWidget.refresh();
  } catch (e) {
    console.warn("フィルタ再読み込み失敗:", item.title, e);
  }
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
      attrWidget.refresh(); // 表示範囲分の行が差し替わった場合に追従
    }).catch(err => console.warn("viewport requery 失敗:", entry.item.title, err));
  }
}

// ---- ツール（計測・標高断面・見通し・緯度経度グリッド・エクスポート）----
const toolFmt = new GeoJSON();
const toolSrc = new VectorSource();
const gratSrc = new VectorSource();
const TOOL_LINE_COLORS = { line: "#ffff00", "los-line": "#ffa500", "los-ok": "#32cd32", "los-bad": "#ff0000", grat: "#888888" };
function toolWithAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hex || "#ffff00";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
function toolStyleFn(feature) {
  const kind = feature.get("kind") || "line";
  const customColor = feature.get("color");
  const gt = feature.getGeometry().getType();
  const styles = [];
  if (kind === "poly" || /Polygon/.test(gt)) {
    const c = customColor || "#ffff00";
    styles.push(new Style({ fill: new Fill({ color: toolWithAlpha(c, 0.25) }), stroke: new Stroke({ color: c, width: 2 }) }));
  } else if (/LineString|MultiLineString/.test(gt)) {
    styles.push(new Style({ stroke: new Stroke({ color: customColor || TOOL_LINE_COLORS[kind] || "#ffff00", width: kind === "grat" ? 1 : 3, opacity: kind === "grat" ? 0.55 : 1 }) }));
  } else {
    if (kind !== "label" && kind !== "grat-label") {
      const colors = { "los-block": "#ff0000", hover: "#00bfff" };
      styles.push(new Style({ image: new CircleStyle({ radius: 5, fill: new Fill({ color: customColor || colors[kind] || "#ffff00" }), stroke: new Stroke({ color: "#000", width: 1.5 }) }) }));
    }
    if (feature.get("text")) {
      styles.push(new Style({ text: new Text({ text: String(feature.get("text")), font: "11px sans-serif", fill: new Fill({ color: "#fff" }), stroke: new Stroke({ color: "#000", width: 3 }), offsetY: -12 }) }));
    }
  }
  return styles;
}
map.addLayer(new VectorLayer({ source: gratSrc, style: toolStyleFn, zIndex: 900 }));
map.addLayer(new VectorLayer({ source: toolSrc, style: toolStyleFn, zIndex: 950 }));
const olOverlayOf = src => ({
  update: fc => {
    src.clear();
    if (fc?.features?.length) {
      src.addFeatures(toolFmt.readFeatures(fc, { featureProjection: "EPSG:3857", dataProjection: "EPSG:4326" }));
    }
  },
});
const viewBounds4326 = () => {
  try {
    if (!map.getSize()) return null;
    const e = transformExtent(map.getView().calculateExtent(map.getSize()), map.getView().getProjection(), "EPSG:4326");
    return { west: e[0], south: e[1], east: e[2], north: e[3] };
  } catch (_) { return null; }
};

const geoTools = initGeoTools2d({
  overlay: olOverlayOf(toolSrc),
  graticuleOverlay: olOverlayOf(gratSrc),
  getBounds: viewBounds4326,
  setCursor: c => { map.getViewport().style.cursor = c; },
  setInteractive: on => {
    map.getInteractions().forEach(i => { if (i.constructor?.name === "DoubleClickZoom") i.setActive(!on); });
  },
  fitBounds: box => { try { map.getView().fit(transformExtent(box, "EPSG:4326", map.getView().getProjection()), { padding: [30, 30, 30, 30], duration: 400 }); } catch (_) {} },
  getOrderedLayerItems: () => layerEntries.map((e, i) => (e.item.id ||= String(i), e.item)),
  isVectorLayerItem: item => !!item && VECTOR_TYPES.has(item.type),
  isQueryLayerItem: item => !!item && (item._viewportQuery || isViewportQueryItem(item)),
  getLayerGeoJson: id => {
    const e = layerEntries.find(en => en.item.id === id);
    if (!e) return null;
    const src = e.layer?.getSource?.();
    if (!src?.getFeatures) return e.item._geojson || null;
    return toolFmt.writeFeaturesObject(src.getFeatures(), { featureProjection: "EPSG:3857", dataProjection: "EPSG:4326" });
  },
});

// ミニマップ（表示>一般トグル。範囲矩形+クリック移動）
const minimap = createMinimap({
  container: "#minimap",
  checkbox: "#display-minimap",
  tileUrl: () => currentBaseEntries[Number(panel.basemapSelect?.value ?? 0)]?.item?.url || "",
  getBounds: () => {
    const b = viewBounds4326();
    return b ? [[b.south, b.west], [b.north, b.east]] : null;
  },
  flyTo: ({ lng, lat }) => map.getView().animate({ center: fromLonLat([lng, lat]), duration: 400 }),
});
map.on("movestart", minimap.scheduleUpdate);
map.on("postrender", minimap.scheduleUpdate);

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
  minimap.scheduleUpdate();
  geoTools.scheduleGraticule();
  const targets = layerEntries.filter(e => e.item._viewportQuery && e.item.visible !== false);
  // bbox=auto / :bbox の初回読込に失敗したレイヤーは、移動後の表示範囲で自動リトライする
  // （Cesium 版 reloadFailedVectorLayer 相当。失敗 spec は entry.failed が担う）
  const retry = layerEntries.filter(e => e.item.visible !== false && e.failed && !e.pending && !e._loading && isViewportQueryItem(e.item));
  if (!targets.length && !retry.length) return;
  clearTimeout(requeryTimer);
  requeryTimer = setTimeout(() => {
    if (targets.length) requeryViewportLayers(targets);
    for (const entry of retry) {
      entry.deferred = true; // ensureEntryLoaded 経路で再マウントする
      entry.failed = false;
      void ensureEntryLoaded(entry);
    }
  }, 400);
});

// ツールモード: ダブルクリック確定とラバーバンドプレビュー
map.on("dblclick", e => { if (geoTools.handleDoubleClick()) e.preventDefault(); });
map.on("pointermove", e => {
  if (e.dragging) return;
  const ll = toLonLat(e.coordinate);
  geoTools.handleMouseMove({ lng: ll[0], lat: ll[1] });
});

// 地物クリック → 属性タブを自動で開いて属性を表示(Cesium 版 attr-panel と同様)
map.on("singleclick", e => {
  // 計測・断面・見通しツールのモードがアクティブなら属性ピックより優先して頂点拾いに使う
  {
    const ll = toLonLat(e.coordinate);
    if (geoTools.handleClick({ lng: ll[0], lat: ll[1] })) return;
  }
  // 重なった地物を全件拾い、属性タブへ表示する
  const picked = [];
  map.forEachFeatureAtPixel(e.pixel, (f, l) => { picked.push({ f, l }); }, { hitTolerance: 5 });
  const records = picked.map(({ f, l }) => {
    const entry = layerEntries.find(en => en.layer === l);
    const { geometry, ...props } = f.getProperties ? f.getProperties() : {};
    return {
      title: entry ? (entry.item.title || entry.item.url) : null,
      entries: attrEntriesFromProps(props),
      layerId: entry ? String(layerEntries.indexOf(entry)) : null,
      feature: f,
      flyable: !!f?.getGeometry?.(),
    };
  });
  // OL の地物にヒットしなければ deck(3dtiles)を pick する
  if (!picked.length && deckInst) {
    try {
      const info = deckInst.pickObject({ x: e.pixel[0], y: e.pixel[1], radius: 5 });
      const props = info?.object?.properties;
      if (props) {
        const def = deckDefs.get(info?.layer?.id);
        records.push({ title: def?.item?.title, entries: attrEntriesFromProps(props) });
      }
    } catch (_) {}
  }
  window.switchPanelTab?.("attr");
  renderAttrContent(panel.attrContent, records, { onRecordClick: rec => focusFeatureExtent(rec.feature) });
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
  const collapsed = ctl.classList.toggle("collapsed");
  e.currentTarget.textContent = collapsed ? "+" : "−";
  e.currentTarget.setAttribute("aria-label", collapsed ? "展開" : "最小化");
});

// ナビゲーションツールバー（Cesium 版 .navigation-toolbar と同等:
// 方位コンパス＋北リセット・全体表示・最小化トグル）
{
  const view = map.getView();
  const compass = document.querySelector("#nav-compass");
  const rotInput = document.querySelector("#display-rotation");
  // 回転角 → コンパス針と設定タブの回転入力へ反映（view rotation は
  // heading の符号反転。コンパス針は heading ベースで CSS 回転させる）
  view.on("change:rotation", () => {
    const deg = view.getRotation() * 180 / Math.PI;
    if (compass) compass.style.transform = `rotateZ(${deg}deg)`;
    if (rotInput && document.activeElement !== rotInput) rotInput.value = String(Math.round(-deg));
  });
  compass?.addEventListener("click", () => {
    view.animate({ rotation: 0, duration: 300 });
    if (rotInput) rotInput.value = "0";
  });
  document.querySelector("#nav-home")?.addEventListener("click", () => {
    // データ範囲が取れない場合は初期ビュー（東京駅付近）へ戻す
    if (!fitDataExtent({ padding: [40, 40, 40, 40], duration: 600 })) {
      view.animate({ center: fromLonLat([139.767, 35.681]), zoom: 10, rotation: 0, duration: 600 });
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
// distance は実ビューポート高 + 垂直FOV60° 換算のカメラ距離。
// heading は view rotation の符号反転（getViewState と同規則）、
// OpenLayers は傾斜を持たないため tilt は 0 固定
function openGoogleEarth() {
  try {
    const view = map.getView();
    const [lon, lat] = toLonLat(view.getCenter() || [0, 0]);
    const vh = (map.getSize() || [0, 0])[1];
    const distance = Math.max(50, zoomToCamHeightView(lat, view.getZoom() ?? 10, vh));
    const heading = ((-view.getRotation() * 180 / Math.PI) % 360 + 360) % 360;
    const url = `https://earth.google.com/web/@${lat.toFixed(6)},${lon.toFixed(6)},0a,${distance.toFixed(2)}d,35y,${heading.toFixed(1)}h,0t,0r`;
    window.open(url, "_blank", "noopener");
  } catch (e) { console.error("Google Earth 連携エラー:", e); }
}
document.querySelector("#basemap-globe").addEventListener("click", openGoogleEarth);

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
  const coordsCtl = new MousePosition({ className: "ol-mouse-position map-coords", coordinateFormat: c => formatLatLng(c[1], c[0]), projection: "EPSG:4326" });
  map.addControl(scaleCtl);
  map.addControl(coordsCtl);
  document.querySelector("#display-scalebar")?.addEventListener("change", e => {
    if (e.target.checked) map.addControl(scaleCtl);
    else map.removeControl(scaleCtl);
  });
  installLocalCrsUI({
    anchor: document.querySelector("#coords-datum"),
    pickLatLng: cb => map.once("click", e => {
      const ll = toLonLat(e.coordinate);
      cb({ lat: ll[1], lon: ll[0] });
    }),
  });
  document.querySelector("#display-coords")?.addEventListener("change", e => {
    if (e.target.checked) map.addControl(coordsCtl);
    else map.removeControl(coordsCtl);
  });

  // 一般設定を既定値へ戻す
  document.querySelector("#display-general-reset")?.addEventListener("click", () => {
    const setV = (sel, v, ev) => { const el = document.querySelector(sel); if (el && el.value !== String(v)) { el.value = String(v); el.dispatchEvent(new Event(ev, { bubbles: true })); } };
    const setC = (sel, on) => { const el = document.querySelector(sel); if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event("change", { bubbles: true })); } };
    setV("#display-opacity", 1, "input");
    setV("#display-layer-opacity", 1, "input");
    setV("#display-rotation", 0, "change");
    setC("#display-north", false);
    setC("#display-scalebar", true);
    setC("#display-coords", true);
  });

  // 3D Tiles ドレープ（deck.gl TerrainExtension）。Cesium 版のドレープ対象地形=3D Tiles 相当
  [
    ["#drape-tiles3d", v => { drapeTiles3d.enabled = v; }],
    ["#drape-tiles3d-basemap", v => { drapeTiles3d.basemap = v; }],
    ["#drape-tiles3d-xyz", v => { drapeTiles3d.xyz = v; }],
    ["#drape-tiles3d-vector", v => { drapeTiles3d.vector = v; }],
    ["#drape-tiles3d-google", v => { drapeTiles3d.google = v; }],
  ].forEach(([sel, set]) => {
    document.querySelector(sel)?.addEventListener("change", e => { set(e.target.checked); syncDeckLayers(); });
  });

  // Google Maps 設定（Maps API キー + Photorealistic 3D Tiles 表示）
  const gmapsKeyInput = document.querySelector("#gmaps-api-key");
  const gmapsToggle = document.querySelector("#gmaps-3dtiles-toggle");
  const gmapsStatus = document.querySelector("#gmaps-status");
  if (gmapsKeyInput) gmapsKeyInput.value = localStorage.getItem("googleMapsApiKey") || "";
  if (gmapsToggle) gmapsToggle.checked = localStorage.getItem("googleMaps3dTiles") === "1";
  document.querySelector("#gmaps-save")?.addEventListener("click", () => {
    localStorage.setItem("googleMapsApiKey", gmapsKeyInput?.value.trim() || "");
    localStorage.setItem("googleMaps3dTiles", gmapsToggle?.checked ? "1" : "0");
    if (gmapsStatus) gmapsStatus.textContent = "保存しました";
    void rerenderProjectKeepView();
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
        const type = { geojson: "geojson", json: "geojson", gpkg: "gpkg", geopackage: "gpkg", fgb: "flatgeobuf", parquet: "geoparquet", kml: "kml", kmz: "kmz", shp: "shp", zip: "shp", csv: "csv", tsv: "tsv" }[ext];
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
      zoom: Number.isFinite(v.zoom) ? v.zoom : heightToViewZoom(v.latitude, v.height, mapCanvasH()),
      duration: 600,
    };
    if (Number.isFinite(v.heading)) opts.rotation = -v.heading * Math.PI / 180;
    const view = map.getView();
    // instant=フライパス巡回等の高頻度更新。animate の逐次再起動を避け即時配置する
    if (v.instant) {
      view.setCenter(opts.center);
      view.setZoom(opts.zoom);
      if (opts.rotation !== undefined) view.setRotation(opts.rotation);
    } else {
      view.animate(opts);
    }
  },
  getViewInfo: () => {
    const c = toLonLat(map.getView().getCenter() || [0, 0]);
    return { latitude: c[1], longitude: c[0], zoom: map.getView().getZoom(), heading: -map.getView().getRotation() * 180 / Math.PI, pitchDeg: 0 };
  },
  viewToUrl: () => mapViewToUrl(),
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
  reloadEntryData,
  getEntryGeoJson: entry => {
    const src = entry.layer?.getSource?.();
    if (!src?.getFeatures) return entry.item._geojson || null;
    return new GeoJSON().writeFeaturesObject(src.getFeatures(), { featureProjection: "EPSG:3857", dataProjection: "EPSG:4326" });
  },
  geoTools: () => geoTools,
  setBaseEntryVisible: (entry, on) => { entry.layer?.setVisible?.(on); updateMapAttribution(); },
  getFlyPaths: kascFlyPaths.getFlyPaths,
  persistFlyPath: kascFlyPaths.persistFlyPath,
  syncFlyPathLine: kascFlyPaths.syncFlyPathLine,
});
mountEngineSwitcher(document.querySelector("#engines"), "openlayers");
// カレント状態ファイル(Cesium規約)へ現在値を反映する(変化イベント駆動)
bindSessionState("openlayers");
void initAiChat({ engine: "openlayers", manageBackend: true });

// 印刷: rendercomplete 後に .ol-layer canvas を表示位置で合成
initPrint({
  button: document.querySelector("#print-open"),
  captureMap: async () => {
    const c = await new Promise(res => {
      map.once("rendercomplete", () => res(compositeCanvases(map.getTargetElement())));
      map.renderSync();
    });
    return c ? c.toDataURL("image/png") : null;
  },
  getScaleDenominator: () => {
    const v = map.getView();
    const res = getPointResolution(v.getProjection(), v.getResolution(), v.getCenter(), "m");
    return res > 0 ? res / 0.00028 : null;
  },
  getNorthAngleDeg: () => map.getView().getRotation() * 180 / Math.PI,
});

// ---- ナビゲーション共通ツール（shared/nav-tools.js）----
import("https://cdn.jsdelivr.net/npm/ol@10.11.0/Overlay.js").then(() => {});
initNavTools({
  el: document.getElementById("map"),
  getView: () => { const c = toLonLat(map.getView().getCenter()); return { lat: c[1], lng: c[0], zoom: map.getView().getZoom(), rotation: map.getView().getRotation() }; },
  setView: v => { map.getView().setCenter(fromLonLat([v.lng, v.lat])); map.getView().setZoom(v.zoom); map.getView().setRotation(v.rotation || 0); },
  viewsEqual: (x, y) => x && y && Math.abs(x.lat - y.lat) < 1e-7 && Math.abs(x.lng - y.lng) < 1e-7 && Math.abs((x.zoom ?? 0) - (y.zoom ?? 0)) < 0.001 && Math.abs((x.rotation ?? 0) - (y.rotation ?? 0)) < 0.01,
  flyTo: (lat, lng) => map.getView().animate({ center: fromLonLat([lng, lat]), duration: 500 }),
  fitBounds: (w, s, e, n) => map.getView().fit(transformExtent([w, s, e, n], "EPSG:4326", map.getView().getProjection()), { duration: 300 }),
  onMoveStart: cb => map.on("movestart", cb),
  onMoveEnd: cb => map.on("moveend", cb),
  toLatLng: (x, y) => { const c = map.getCoordinateFromPixel([x, y]); if (!c) return null; const ll = toLonLat(c); return { lat: ll[1], lng: ll[0] }; },
  setMarker: ll => {
    if (initNavTools._ov) { map.removeOverlay(initNavTools._ov); initNavTools._ov = null; }
    if (ll) {
      const el = document.createElement("div");
      el.textContent = "📍"; el.style.cssText = "font-size:22px;pointer-events:none;text-shadow:0 0 3px #fff;";
      import("https://cdn.jsdelivr.net/npm/ol@10.11.0/Overlay.js").then(m => {
        initNavTools._ov = new m.default({ element: el, position: fromLonLat([ll.lng, ll.lat]), positioning: "bottom-center", stopEvent: false });
        map.addOverlay(initNavTools._ov);
      });
    }
  },
  capturePng: () => new Promise(res => {
    map.once("rendercomplete", () => { const c = compositeCanvases(map.getViewport()); c ? c.toBlob(res, "image/png") : res(null); });
    map.renderSync();
  }),
});

// ---- 座標ピン（shared/coord-pins.js の共有 GeoJSON を一般レイヤーとして描画）----
// layerEntries に正規エントリを持つため、レイヤ一覧・属性表示(クリック)・
// 属性検索・属性一覧ウィジェットが通常レイヤーと同じ経路で使える
let pinEntry = null;
const pinSource = new VectorSource();
const pinLayer = new VectorLayer({
  source: pinSource,
  style: f => new Style({
    image: new CircleStyle({
      radius: 7,
      fill: new Fill({ color: f.get("marker-color") || "#e33d3d" }),
      stroke: new Stroke({ color: "#fff", width: 2 }),
    }),
  }),
});
const pinLayerOnMap = () => map.getLayers().getArray().includes(pinLayer);
function syncCoordPinLayer(fc) {
  // プロジェクト再描画(map.getLayers().clear)で消えた分を含め、ストアの状態へ収束させる
  if (pinEntry && !layerEntries.includes(pinEntry)) {
    pinEntry = null;
    if (pinLayerOnMap()) map.removeLayer(pinLayer);
  }
  if (!fc.features.length) {
    if (pinEntry) {
      const i = layerEntries.indexOf(pinEntry);
      if (i >= 0) layerEntries.splice(i, 1);
      pinEntry = null;
      renderLayerRows(layerEntries, currentUnsupported);
    }
    if (pinLayerOnMap()) map.removeLayer(pinLayer);
    pinSource.clear();
    return;
  }
  if (!pinEntry) {
    pinEntry = { item: { title: "座標ピン", type: "geojson", visible: true }, layer: pinLayer, pending: false, opa: 1 };
    layerEntries.unshift(pinEntry);
    renderLayerRows(layerEntries, currentUnsupported);
  }
  pinEntry.item._geojson = fc;
  const env = geojsonExtent(fc);
  if (env) { pinEntry.item._env = env; pinLayer.set("kascEnv", env); }
  pinSource.clear();
  pinSource.addFeatures(new GeoJSON().readFeatures(fc, { featureProjection: "EPSG:3857", dataProjection: "EPSG:4326" }));
  if (!pinLayerOnMap()) insertEntryLayer(pinEntry, layerEntries.indexOf(pinEntry));
}
coordPins.setRenderer(syncCoordPinLayer);
