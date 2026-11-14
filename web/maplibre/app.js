// KASUGAI Canvas — MapLibre フロント
// .kasc プレイヤーモード: projects/<id>/ の .kasc+DATA/ を MapLibre GL で再生する
import * as maplibregl from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs";
import { loadKascProject, NON_LAYER_TYPES, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeightView, heightToViewZoom, viewZoomToHeight, groundCenterFromCam, camFromGroundCenter, parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle, appendGroupedTitleOptions, syncBasemapList, sanitizeAttributionFragment, layerAttribution, loadKascInfoContent, buildWmsTileTemplate, buildWmtsTileTemplate, rewriteKascVisibility, rewriteKascLineVisibility, rewriteKascLineOpt, themeShowSet, kascTitleInTheme, normKascTitle, fillThemeSelect, loadKascBookmarks, parseQgisBookmarksXml, qgisBookmarkToCam, downloadQgisBookmarksXml, downloadKascCamLines, projectsBaseUrl, applyPanelTitle, defaultPointRadius, cssColorAlpha, kascOptOn, parseImageOverlay, kascScaleZoomRange, applyKascGroupStates } from "../shared/kasc.js";
import { initI18n, t, applyI18n } from "../shared/i18n.js";
import { createKascPortal } from "../shared/portal.js";
import { compileWhereExpression } from "../shared/where-eval.js";
import { kascTimeSpec, collectTimeValues, featureInTime, timeKey, buildKascTimeControl } from "../shared/kasc-time.js";
import { createKascFlyPaths } from "../shared/fly-kasc.js";
import { backendUrl } from "../shared/backend.js";
import { loadVectorItem, isViewportQueryItem } from "../shared/vector-load.js";
import { diagnoseHubLayerError } from "../shared/hub-diag.js";
import { createMinimap } from "../shared/minimap.js";
import { initGeoTools2d } from "../shared/geo-tools-2d.js";
import { mountSunControls } from "../shared/sun-time.js";
import { createAttrWidget, renderAttrContent, attrEntriesFromProps } from "../shared/attr-widget.js";
import { initAiChat, hasBackendFeature } from "../shared/ai-chat.js";
import { createPlayerApi } from "../shared/player-api.js";
import { configureLive, configureFollow, liveUpdate, liveNotifyCamera, liveNotifySelection, liveWritebackEntries, liveIsActive, liveRenderUrl } from "../shared/live.js";
import { mountLivePanel, syncLivePanel } from "../shared/live-panel.js";
import { mountEngineSwitcher } from "../shared/engine-switch.js";
import { matchSessionState, bindSessionState, applySessionState, sessionBootView } from "../shared/session-state.js";
import { initNavTools } from "../shared/nav-tools.js";
import { coordPins } from "../shared/coord-pins.js";
import { formatLatLng } from "../shared/coords-format.js";
import { installLocalCrsUI } from "../shared/coords-local.js";
import { initPrint, compositeCanvases } from "../shared/print.js";

import { groundDeckTileset } from "../shared/deck-ground.js";
import { buildDeckDrapeLayers, invalidateDeckTerrainCovers, isGoogle3dTilesUrl, withGoogleTileKey, ensureGoogleTileKeyFetch } from "../shared/deck-drape.js";
import { qmlLegendSwatchDataUrl, defaultVectorLegendSpec, installLayerVisibilityResolver, bakeQmlLabels } from "../shared/qml-2d.js";

await initI18n();
applyI18n();

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

const map = new maplibregl.Map({
  container: "map",
  // glyphs は QML <labeling> の symbol レイヤが必要とするフォント PBF。
  // openmaptiles の Noto Sans は日本語を含む(demotiles.maplibre.org は非CJK)
  style: { version: 8, glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf", sources: {}, layers: [] },
  // CJK 文字はリモート glyph PBF を参照せずローカルフォントで描く
  // (glyph サーバの非対応コードポイントで描画エラーになるのを防ぐ)
  localIdeographFontFamily: "sans-serif",
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
    map.getSource(entry.sid)?.setData?.(applyClientWhere(item, item._geojson));
  }
}
let lastBaseUrl = "";
// ?kasc= で読み込んだ .kasc の URL。設定中は URL 書き換え時に
// project= を書かず ?kasc= を維持する(実プロジェクト選択で空に戻る)
let lastKascUrl = "";
let currentProjectId = "";
// .kasc の view: 行で宣言された目的別プリセット
// {name, desc, img, cam, base, layers[], styles{}, wheres{}, line}[]。
// ポータル画面のカードへ展開する(theme: の発展形。フィルタ・カメラ・背景を含む)
const inspectorViews = [];
// .kasc の html: 行で宣言されたポータル HTML セクション {title, spec, line}[]
const inspectorHtmlSections = [];
// .kasc の link: 行で宣言された外部リンクカード {name, url, desc, img, line}[]
const inspectorLinks = [];
// ポータルのカード宣言順リスト {kind:"view"|"link", entry}[]
const inspectorPortalCards = [];
// portal: 行の宣言 {enabled, title, open}。null=行なし
let inspectorPortalSpec = null;
// title: 行のパネルタイトル(ポータル見出しのフォールバックに使う)。null=行なし
let inspectorPanelTitle = null;
// 適用中のビュー名と、適用前スナップショット(ビュー解除で復元)
let activeViewName = null;
let viewSnapshot = null;
// 起動時ポータル自動表示の管理(プロジェクト読込ごとに1回)
let portalAutoOpened = false;
// DATA/ 等の .kasc 相対参照 → URL(Cesium 版 resolveProjectUrl 相当)
const resolveProjectUrl = url => resolveKascUrl(url, lastBaseUrl);
// URL ハッシュの初期ビューは最初の loadProject で一度だけ適用する
// （プロジェクト切替時はそのプロジェクトの cam/範囲へ移動する既存挙動を維持）
let urlViewConsumed = false;

// MapLibre ビュー ⇄ URL パラメータ（Cesium 規約: pitch は直下=-90・水平=0、heading は北=0・時計回り）
// height は正典 height(m)。⇄ 表示ズームの換算は実キャンバス高＋正典 FOV(60°)の
// heightToViewZoom/viewZoomToHeight で行う。MapLibre のネイティブ zoom は 512px
// 基準のため、正典(256px 基準)との間で書き出し +1・読み込み -1 する。
// bearing は heading と同規約（北=0・時計回り）で符号反転しない
const mapCanvasH = () => map.getCanvas()?.clientWidth || 512;
function mapViewToUrl() {
  const c = map.getCenter(); // 地面注視点（画面中心の地面交点）
  const zoom = map.getZoom() + 1;
  const pitch = map.getPitch() - 90;   // 正典 pitch
  const heading = map.getBearing();    // 正典 heading（同規約）
  const slant = viewZoomToHeight(c.lat, zoom, mapCanvasH());
  // 正典 lat/lon/height はカメラ位置: 注視点 + 正典姿勢から逆算する
  const cam = camFromGroundCenter({ latitude: c.lat, longitude: c.lng }, pitch, heading, slant);
  return {
    latitude: cam.latitude,
    longitude: cam.longitude,
    zoom,
    height: cam.height,
    pitch,
    heading,
  };
}

function urlViewToMapOptions(v) {
  const gc = groundCenterFromCam(v); // pitch は座標計算にのみ使用
  return {
    center: [gc.longitude, gc.latitude],
    zoom: (Number.isFinite(v.height) ? heightToViewZoom(gc.latitude, v.height, mapCanvasH())
      : (Number.isFinite(v.zoom) ? v.zoom : camToZoom(v))) - 1,
    bearing: Number.isFinite(v.heading) ? v.heading : 0,
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
const drapeTiles3d = { enabled: true, basemap: true, xyz: true, vector: true, google: false };
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
  if (!deckOverlay || !window.deck) return;
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
  // Google Photorealistic は正しくジオリファレンス済みで、全球規模の
  // boundingVolume からの接地高推定が巨大な誤シフトを起こすため接地しない
  if (!tileset || isGoogle3dTilesUrl(def.url)) return;
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

// スタイル未指定地物の既定値(simplestyle > default_style: > 既定色)を
// データ駆動 paint 式で表現する kind 定義(fill/line/circle)
function defaultVectorKinds() {
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
  return [
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
}

// pmtiles プロトコルは使う行がある時だけ CDN から遅延ロードして登録する
let pmtilesModuleP = null;
let pmtilesProtocol = null;
function ensurePmtiles() {
  pmtilesModuleP ||= import("https://cdn.jsdelivr.net/npm/pmtiles@4.4.1/+esm").then(m => {
    pmtilesProtocol = new m.Protocol();
    maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);
    return m;
  });
  return pmtilesModuleP;
}

// 縮尺表示(minScale=/maxScale=) → レイヤ def の minzoom/maxzoom。
// kascScaleZoomRange は 256px 基準のため MapLibre レイヤ指定では -1。
// 範囲指定が無ければ null を返す
function itemVisZoom(item) {
  const sv = kascScaleZoomRange(item.opts || {}, map.getCenter().lat);
  if (!sv) return null;
  return {
    minzoom: sv.minZoom != null ? Math.max(0, sv.minZoom - 1) : null,
    maxzoom: sv.maxZoom != null ? Math.min(24, sv.maxZoom - 1) : null,
  };
}
// レイヤ def へ縮尺範囲を積集合で適用する(QML ルール範囲と併存可)
function applyVisZoom(def, item) {
  const v = itemVisZoom(item);
  if (!v) return def;
  if (v.minzoom != null) def.minzoom = Math.max(def.minzoom ?? 0, v.minzoom);
  if (v.maxzoom != null) def.maxzoom = Math.min(def.maxzoom ?? 24, v.maxzoom);
  return def;
}

// 非クエリ系ベクター(geojson: 等の全件読み込み系)の where= を
// クライアント評価(shared/where-eval.js)で描画用 GeoJSON へ適用する。
// item._geojson は常に全件を保持する(検索・属性一覧は全件対象の方針)ため、
// ここでは描画対象だけを絞る。クエリ系(gpkg/duckdb/sql)はローダ側で
// SQL へ適用済みのため対象外(Cesium 版 applyClientWhere と同規則)
function applyClientWhere(item, geojson) {
  const where = item?.opts?.where;
  if (!where || !geojson?.features?.length || QUERY_TYPES.has(item.type)) return geojson;
  if (item._whereExpr !== where) {
    item._whereExpr = where;
    try { item._wherePred = compileWhereExpression(where); }
    catch (e) {
      item._wherePred = null;
      console.warn(`${item.title}: where= の式を解釈できません`, e.message);
    }
  }
  if (!item._wherePred) return geojson;
  const kept = geojson.features.filter(f => item._wherePred(f?.properties || {}));
  return kept.length === geojson.features.length ? geojson : { ...geojson, features: kept };
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
  if (item.type === "image") {
    // ジオリファレンス画像オーバーレイ。corners= は TL,TR,BR,BL 順。
    // bbox= は矩形(北西・北東・南東・南西に展開)
    const ov = parseImageOverlay(item);
    let coords = ov.corners;
    if (!coords && ov.bbox) {
      const [w, s, e, n] = ov.bbox;
      coords = [[w, n], [e, n], [e, s], [w, s]];
    }
    if (!coords || coords.length < 4) throw new Error("image: bbox= または corners= の指定が必要です");
    map.addSource(sid, { type: "image", url: resolveKascUrl(item.url, baseUrl), coordinates: coords.slice(0, 4) });
    map.addLayer(applyVisZoom({ id: sid, type: "raster", source: sid, paint: { "raster-opacity": Number(item.opts?.opacity ?? 1) }, layout: { visibility: item.visible ? "visible" : "none" } }, item), beforeId());
    lids.push(sid);
    opas.set(sid, { prop: "raster-opacity", base: Number(item.opts?.opacity ?? 1) });
    managedSources.push(sid);
    managedLayers.push(...lids);
    return { lids, sid, viewportQuery, filters, opas };
  }
  if (item.type === "mvt" || item.type === "pmtiles") {
    // MVT ベクトルタイル / PMTiles(単一ファイル・Range リクエスト)。
    // ソースレイヤ名は layers= 指定 > PMTiles/TileJSON メタデータの vector_layers で決まる
    const url = resolveKascUrl(item.url, baseUrl);
    const opts = item.opts || {};
    const sourceDef = { type: "vector", attribution: layerAttribution(item) || undefined };
    let srcLayers = null;
    if (item.type === "pmtiles") {
      const m = await ensurePmtiles();
      const pm = new m.PMTiles(url);
      pmtilesProtocol.add(pm);
      sourceDef.url = `pmtiles://${url}`;
      try {
        const meta = await pm.getMetadata();
        srcLayers = (meta?.vector_layers || []).map(l => l.id).filter(Boolean);
      } catch (_) {}
    } else if (/\.json($|\?)/i.test(url)) {
      // TileJSON 参照(メタデータに vector_layers があればソースレイヤ自動判別)
      sourceDef.url = url;
      try {
        const tj = await fetch(url).then(r => (r.ok ? r.json() : null));
        srcLayers = (tj?.vector_layers || []).map(l => l.id).filter(Boolean);
      } catch (_) {}
    } else {
      sourceDef.tiles = [url];
    }
    const optLayers = String(opts.srclayers ?? opts.sourcelayers ?? opts.layers ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (optLayers.length) srcLayers = optLayers;
    if (!srcLayers?.length) {
      throw new Error(`${item.type}: ソースレイヤ名が不明です。layers=<名前[,…]> で指定するか TileJSON/PMTiles メタデータが必要です`);
    }
    if (opts.minzoom ?? opts.minimumlevel) sourceDef.minzoom = Number(opts.minzoom ?? opts.minimumlevel);
    if (opts.maxzoom ?? opts.maximumlevel) sourceDef.maxzoom = Number(opts.maxzoom ?? opts.maximumlevel);
    map.addSource(sid, sourceDef);
    const vis = item.visible ? "visible" : "none";
    const before = beforeId();
    for (const sl of srcLayers) {
      for (const [kind, filter, paint] of defaultVectorKinds()) {
        const lid = `${sid}-${sl}-${kind}`;
        map.addLayer(applyVisZoom({ id: lid, type: kind, source: sid, "source-layer": sl, filter, paint, layout: { visibility: vis } }, item), before);
        lids.push(lid);
        if (!filters) filters = new Map();
        filters.set(lid, filter);
        opas.set(lid, { prop: `${kind}-opacity`, base: typeof paint?.[`${kind}-opacity`] === "number" ? paint[`${kind}-opacity`] : 1 });
      }
    }
    managedSources.push(sid);
    managedLayers.push(...lids);
    return { lids, sid, viewportQuery, filters, opas };
  }
  if (VECTOR_TYPES.has(item.type)) {
    const loaded = preloaded || await loadVectorItem(item, baseUrl, getViewBounds());
    const geojson = loaded.geojson;
    viewportQuery = !!loaded.viewportQuery;
    let kinds = defaultVectorKinds();
    const pointColor = (currentDefaultStyles || {}).point?.color ?? "#2c5ea8";
    const pointRadius = (currentDefaultStyles || {}).point?.size ? defaultPointRadius((currentDefaultStyles || {}).point.size) : 5;
    let zoomRange = null;
    let qmlExtra = null;
    if (item.opts?.style) {
      try {
        const { loadCompiledQml, maplibreApplyQml, compiledScaleToResRange, resToZoom } = await import("../shared/qml-2d.js");
        const compiled = await loadCompiledQml(item.opts.style, baseUrl);
        item._qml = compiled;
        const applied = maplibreApplyQml(geojson, compiled);
        kinds = applied.kinds;
        qmlExtra = applied;
        // markerCanvas/fill tile の画像を map.addImage で登録してからレイヤ追加
        for (const reg of [applied.icons, applied.fills]) {
          if (!reg) continue;
          for (const [id, cv] of reg) {
            try {
              if (map.hasImage(id)) continue;
              // MapLibre 系は HTMLCanvasElement 非対応の版があるため
              // ImageData({width,height,data}) 形式で登録する
              const c2d = cv.getContext?.("2d");
              const img = c2d ? c2d.getImageData(0, 0, cv.width, cv.height)
                : { width: cv.width, height: cv.height, data: cv };
              map.addImage(id, img);
            } catch (e) { console.warn("addImage 失敗:", id, e); }
          }
        }
        const range = compiledScaleToResRange(compiled);
        if (range) {
          const lat = map.getCenter().lat;
          zoomRange = {
            // resToZoom は 256px 基準のため maplibre レイヤ指定では -1
            minzoom: Math.max(0, resToZoom(range.maxRes === Infinity ? 1e9 : range.maxRes, lat) - 1),
            maxzoom: Math.min(24, resToZoom(Math.max(range.minRes, 0.01), lat) - 1),
          };
        }
        // ラベルの縮尺表示(rendering scaleVisibility) → symbol レイヤの zoom 範囲
        const ls = applied.labelScaleRange;
        if (ls && (ls.minScale || ls.maxScale)) {
          const lat = map.getCenter().lat;
          qmlExtra.labelZoom = {
            minzoom: ls.maxScale ? Math.max(0, resToZoom(ls.maxScale * 0.00028, lat) - 1) : 0,
            maxzoom: ls.minScale ? Math.min(24, resToZoom(ls.minScale * 0.00028, lat) - 1) : 24,
          };
        }
      } catch (e) { console.warn("QML 適用失敗:", item.opts.style, e); }
    }
    const env = geojsonExtent(geojson);
    if (env) item._env = env;
    item._geojson = geojson;
    const before = beforeId();
    const hasPoints = geojson.features?.some(f => /point/i.test(f?.geometry?.type || ""));
    const wantCluster = hasPoints && (kascOptOn(item.opts?.cluster) || item._qml?.cluster?.kind === "cluster");
    const wantHeat = hasPoints && (kascOptOn(item.opts?.heat ?? item.opts?.heatmap) || !!item._qml?.heatmap);
    // circle 種はクラスタ/ヒートマップ指定時に専用レイヤへ差し替える
    const circleKind = kinds.find(k => k[0] === "circle");
    if (wantCluster) {
      kinds = kinds.filter(([kind]) => kind !== "circle");
    } else if (wantHeat && circleKind) {
      const hm = item._qml?.heatmap;
      const ramp = hm?.ramp;
      kinds = kinds.map(([kind, filter, paint]) => kind === "circle"
        ? ["heatmap", filter, {
            "heatmap-weight": hm ? ["coalesce", ["get", "__kasc_heat"], 1] : 1,
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 15, 3],
            "heatmap-radius": hm
              ? Math.max(hm.radiusPx || 10, 1)
              : ["interpolate", ["linear"], ["zoom"], 0, 2, 15, 22],
            ...(ramp?.length ? {
              "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
                0, "rgba(0,0,0,0)",
                // offset 昇順かつ 0 重複を除く(0 は透過停止として1回のみ)
                ...ramp.filter(s => s.offset > 0).sort((a, b) => a.offset - b.offset)
                  .flatMap(s => [s.offset, `rgba(${s.color.map(v => Math.round(v * 255)).join(",")})`])],
            } : {}),
            "heatmap-opacity": 0.7,
          }] : [kind, filter, paint]);
    }
    map.addSource(sid, { type: "geojson", data: applyClientWhere(item, geojson), attribution: layerAttribution(item) || undefined, ...(wantCluster ? { cluster: true, clusterRadius: Math.max(item._qml?.cluster?.distancePx || 50, 5), clusterMaxZoom: 16 } : {}) });
    const kindCount = {};
    for (const [k] of kinds) kindCount[k] = (kindCount[k] || 0) + 1;
    const kindSeen = {};
    for (const [kind, filter, paint, layout] of kinds) {
      kindSeen[kind] = (kindSeen[kind] || 0) + 1;
      const lid = kindCount[kind] > 1
        ? `${sid}-${kind}-${kindSeen[kind]}` : `${sid}-${kind}`;
      const def = { id: lid, type: kind, source: sid, filter, paint, layout: { ...layout, visibility: item.visible ? "visible" : "none" } };
      if (zoomRange) { def.minzoom = zoomRange.minzoom; def.maxzoom = zoomRange.maxzoom; }
      // ラベル縮尺表示は symbol レイヤへだけ適用(地物描画には影響させない)
      if (kind === "symbol" && qmlExtra?.labelZoom) {
        def.minzoom = Math.max(def.minzoom ?? 0, qmlExtra.labelZoom.minzoom);
        def.maxzoom = Math.min(def.maxzoom ?? 24, qmlExtra.labelZoom.maxzoom);
      }
      map.addLayer(applyVisZoom(def, item), before);
      lids.push(lid);
      if (!filters) filters = new Map();
      filters.set(lid, filter);
      // symbol レイヤに symbol-opacity は無いため text-opacity を使う
      const opaProp = kind === "symbol" ? "text-opacity" : `${kind}-opacity`;
      opas.set(lid, { prop: opaProp, base: typeof paint?.[opaProp] === "number" ? paint[opaProp] : 1 });
    }
    // cluster=on: 件数バッジのクラスタ円 + 件数テキスト + 非クラスタ点
    if (wantCluster) {
      const vis = item.visible ? "visible" : "none";
      const circlePaint = circleKind ? circleKind[2] : { "circle-color": pointColor, "circle-radius": pointRadius };
      const defs = [
        [`${sid}-clusters`, "circle", ["has", "point_count"], {
          "circle-color": ["step", ["get", "point_count"], "#3a7bd5", 10, "#e67e22", 100, "#c0392b"],
          "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 100, 26],
          "circle-opacity": 0.85, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
        }, "circle-opacity"],
        [`${sid}-cluster-count`, "symbol", ["has", "point_count"], {
          "text-color": "#ffffff", "text-opacity": 1,
        }, "text-opacity", { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-allow-overlap": true }],
        [`${sid}-unclustered`, "circle", ["!", ["has", "point_count"]], circlePaint, "circle-opacity"],
      ];
      for (const [lid, kind, filter, paint, opaProp, layout0] of defs) {
        map.addLayer(applyVisZoom({ id: lid, type: kind, source: sid, filter, paint, layout: { ...(layout0 || {}), visibility: vis } }, item), before);
        lids.push(lid);
        if (!filters) filters = new Map();
        filters.set(lid, filter);
        opas.set(lid, { prop: opaProp, base: typeof paint?.[opaProp] === "number" ? paint[opaProp] : 1 });
      }
    }
    syncDeckLayers(); // 読込完了でドレープコピー対象(_geojson)が増えた場合に反映
  } else {
    map.addSource(sid, rasterSource(item, baseUrl));
    const paint = {};
    if (item.opts?.opacity !== undefined) paint["raster-opacity"] = Number(item.opts.opacity);
    map.addLayer(applyVisZoom({ id: sid, type: "raster", source: sid, paint, layout: { visibility: item.visible ? "visible" : "none" } }, item), beforeId());
    lids.push(sid);
    opas.set(sid, { prop: "raster-opacity", base: paint["raster-opacity"] ?? 1 });
  }
  managedSources.push(sid);
  managedLayers.push(...lids);
  // opacity=(0-1): レイヤ透過度。ベクター描画の *-opacity へ乗算する(#58)
  const lop = Number(item.opts?.opacity);
  if (Number.isFinite(lop) && lop < 1) {
    for (const [lid, o] of opas) {
      try {
        const cur = map.getPaintProperty(lid, o.prop);
        map.setPaintProperty(lid, o.prop, ["*", (cur === undefined ? o.base : cur), lop]);
        o.base = (typeof cur === "number" ? cur : o.base) * lop;
      } catch (_) {}
    }
  }
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
    liveWritebackEntries(layerEntries);
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
let timeCtl = null;

// time=/time_end= オプション付きレイヤを収集して時刻スライダーを構築する(#57)。
// setFilter で [time<=T かつ (end無し|end>=T)] を全サブレイヤへ適用する。
function refreshKascTime() {
  const specs = [];
  for (const e of layerEntries || []) {
    const spec = kascTimeSpec(e.item);
    if (!spec || !(e.lids || []).length) continue;
    const values = collectTimeValues(e.item._geojson, spec);
    if (!values.length) continue;
    specs.push({
      label: e.item.title, spec, values,
      apply: t => {
        for (const lid of e.lids) {
          try {
            const base = e.filters?.get(lid);
            const parts = ["all"];
            if (Array.isArray(base)) parts.push(base);
            if (t != null) {
              const tfVals = new Set(), teVals = new Set();
              for (const f of e.item._geojson?.features || []) {
                const p = f.properties || {};
                const s = p[spec.tf];
                if (s != null && timeKey(s) <= t) tfVals.add(s);
                if (spec.te) {
                  const ev = p[spec.te];
                  if (ev != null && timeKey(ev) >= t) teVals.add(ev);
                }
              }
              parts.push(["in", ["get", spec.tf], ["literal", [...tfVals]]]);
              if (spec.te) parts.push(["any", ["!", ["has", spec.te]], ["in", ["get", spec.te], ["literal", [...teVals]]]]);
            }
            map.setFilter(lid, parts.length > 1 ? parts : null);
          } catch (_) {}
        }
      },
    });
  }
  if (!timeCtl) {
    const host = document.getElementById("map")?.parentElement || document.body;
    timeCtl = buildKascTimeControl(host, specs);
  } else timeCtl.setLayers(specs);
}

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
      liveWritebackEntries(layerEntries);
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
        if (e) map.fitBounds([[e.west, e.south], [e.east, e.north]], { padding: 40, duration: 800, maxZoom: 20 });
        else { const gc = groundCenterFromCam(cam); map.flyTo({ center: [gc.longitude, gc.latitude], zoom: heightToViewZoom(gc.latitude, cam.height, mapCanvasH()) - 1 }); }
      });
      panel.cams.append(btn);
    }
  }
}
let currentUnsupported = [];

async function loadProject(id) {
  // プロジェクト読込ごとの起動時ポータル自動表示を1回に戻す
  portalAutoOpened = false;
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

// QGIS ライブ連携(#62): live.json rev 検出後の適用本体。
// .kasc テキスト不変 かつ data 変更のみ → geojson 系 source.setData で
// 差分更新。style 変更・テキスト変化・それ以外の型は全適用へ。
async function liveApplyText(text, { changed = [], full = false, manifest = null } = {}) {
  const current = (inspectorInput.value || "").trim();
  const styleChanged = (manifest?.changed || [])
    .some(c => c && typeof c === "object" && c.style);
  if (full || styleChanged || String(text || "").trim() !== current) {
    inspectorInput.value = text;
    await applyInspectorText(text);
    return;
  }
  const targets = new Set(
    changed.map(t => normKascTitle(t)).flatMap(t => [t, t.split("/").pop()]));
  const entries = layerEntries.filter(e =>
    !changed.length || targets.has(normKascTitle(e.item?.title || "")));
  const canFast = entries.length > 0 && entries.every(e =>
    ["geojson", "layer"].includes(e.item.type)
    && e.sid && typeof map.getSource(e.sid)?.setData === "function");
  if (!canFast) {
    inspectorInput.value = text;
    await applyInspectorText(text);
    return;
  }
  for (const e of entries) {
    try {
      // where= クライアントフィルタ中は URL 直指定(setData は未加工データを
      // 読む)を避け、fetch してフィルタ済み FC を流す
      if (e.item.opts?.where && !QUERY_TYPES.has(e.item.type)) {
        const res = await fetch(resolveKascUrl(e.item.url, lastBaseUrl));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const gj = await res.json();
        e.item._geojson = gj;
        map.getSource(e.sid).setData(applyClientWhere(e.item, gj));
      } else {
        map.getSource(e.sid).setData(resolveKascUrl(e.item.url, lastBaseUrl));
      }
    } catch (err) { console.warn("live setData failed:", e.item.title, err); }
  }
}

// QGIS 側選択 → 地物ハイライト(#62 双方向)。
// qgis-sel ソースに一致地物だけ流し、黄色オーバーレイで表示する
let qgisSelReady = false;
function qgisSelFeatureId(f) {
  return f?.id ?? f?.properties?.id ?? f?.properties?.fid ?? f?.properties?.FID;
}
function collectQgisSelectedFeatures(sel) {
  if (Array.isArray(sel?.features)) return sel;
  const specs = Array.isArray(sel?.layers) ? sel.layers
    : (sel?.layer || Array.isArray(sel?.ids) ? [sel] : []);
  const features = [];
  for (const spec of specs) {
    const title = normKascTitle(String(spec.layer || spec.title || ""));
    if (!title) continue;
    const leaf = title.split("/").pop();
    const entry = layerEntries.find(e => normKascTitle(e.item?.title || "") === title)
      || layerEntries.find(e => normKascTitle(e.item?.title || "").split("/").pop() === leaf);
    const ids = new Set((spec.ids || []).map(v => String(v)));
    for (const f of entry?.item?._geojson?.features || []) {
      const fid = qgisSelFeatureId(f);
      if (fid != null && ids.has(String(fid))) features.push(f);
    }
  }
  return { type: "FeatureCollection", features };
}
function applyQgisSelection(sel) {
  try {
    if (!qgisSelReady) {
      map.addSource("qgis-sel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "qgis-sel-fill", type: "fill", source: "qgis-sel", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#ff0", "fill-opacity": 0.28 } });
      map.addLayer({ id: "qgis-sel-line", type: "line", source: "qgis-sel", layout: { "line-cap": "round" }, paint: { "line-color": "#ff0", "line-width": 3 } });
      map.addLayer({ id: "qgis-sel-circle", type: "circle", source: "qgis-sel", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": "#ff0", "circle-radius": 7, "circle-stroke-color": "#111", "circle-stroke-width": 1.5 } });
      qgisSelReady = true;
    }
    map.getSource("qgis-sel")?.setData(collectQgisSelectedFeatures(sel));
  } catch (_) { /* ハイライト失敗は無視 */ }
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
  const c = map.getCenter(), z = map.getZoom(), b = map.getBearing(), p = map.getPitch();
  await renderProject(currentProjectId, lastBaseUrl, lastDoc);
  map.jumpTo({ center: c, zoom: z, bearing: b, pitch: p });
}

async function renderProject(loadedId, baseUrl, doc, manifest) {
  const seq = ++renderSeq;
  lastDoc = doc;
  injectGoogle3dTilesItem(doc);
  clearTimeout(progressHideTimer);
  if (progressEl) progressEl.hidden = true;
  removeManaged();
  layerEntries = [];
  panel.layers.innerHTML = "";
  currentProjectId = loadedId;
  applyPanelTitle(doc.title);
  currentDefaultStyles = doc.defaultStyles || null;

  // ポータル(portal:/html:/view:/link: 行)の状態を doc から再構築する
  inspectorViews.splice(0, inspectorViews.length);
  inspectorHtmlSections.splice(0, inspectorHtmlSections.length);
  inspectorLinks.splice(0, inspectorLinks.length);
  inspectorPortalCards.splice(0, inspectorPortalCards.length);
  inspectorPortalSpec = doc.portal || null;
  inspectorPanelTitle = doc.title || null;
  activeViewName = null;
  viewSnapshot = null;
  for (const view of doc.views || []) {
    inspectorViews.push(view);
    inspectorPortalCards.push({ kind: "view", entry: view });
  }
  for (const sec of doc.htmlSections || []) {
    // parseKasc の htmlSections[].spec は「タイトル | 本文」のまま残るため、
    // Cesium 版と同じく先頭フィールドをタイトル・残りを本文として分離する
    const parts = String(sec.spec || "").split("|").map(s => s.trim());
    const body = (parts.length > 1 ? parts.slice(1).join("|") : parts[0]) || "";
    inspectorHtmlSections.push({
      title: parts.length > 1 ? parts[0] : "",
      // lastBaseUrl はこの後で代入されるため、ここでは引数の baseUrl で解決する
      spec: body.startsWith("<") ? body : resolveKascUrl(body, baseUrl),
      line: sec.line,
    });
  }
  for (const link of doc.links || []) {
    inspectorLinks.push(link);
    inspectorPortalCards.push({ kind: "link", entry: link });
  }

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

  // 3dtiles: 行は deck.gl、fly_geojson: 行はフライパスとして対応するため
  // 未対応通知から外す。3dtiles は _idx（.kasc 上の行順）で doc.layers と
  // 混ぜてレイヤツリー順を再現する
  kascFlyPaths.setItems(doc.unsupported);
  const unsupported = doc.unsupported.filter(i => i.type !== "3dtiles" && i.type !== "fly_geojson" && i.type !== "mvt" && i.type !== "pmtiles" && !NON_LAYER_TYPES.has(i.type));

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
  const urlView = urlViewConsumed ? null : sessionBootView(switchRestore);
  urlViewConsumed = true;
  let needExtentFit = false;
  if (hasUrlView(urlView)) {
    map.jumpTo(urlViewToMapOptions(urlView));
  } else if (doc.cams.length) {
    const cam = doc.cams[0];
    { const gc = groundCenterFromCam(cam); map.jumpTo({ center: [gc.longitude, gc.latitude], zoom: heightToViewZoom(gc.latitude, cam.height, mapCanvasH()) - 1 }); }
  } else {
    needExtentFit = true;
  }

  // レイヤ行を先に描画して読込状態を行ごとに表示し、データは取得できた順に
  // 正しい z 順(findInsertBeforeId)で地図へ追加する。
  // `| off` のベクター行は表示 ON までデータ取得を遅延する
  const orderedItems = [...doc.layers, ...doc.unsupported.filter(i => i.type !== "fly_geojson" && !NON_LAYER_TYPES.has(i.type))]
    .sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
  const entries = orderedItems.map(item =>
    ({ item, lids: [], sid: null, filters: null, opas: null, pending: true, unsupported: doc.unsupported.includes(item) && !["3dtiles", "mvt", "pmtiles"].includes(item.type) }));
  layerEntries = entries;
  lastBaseUrl = baseUrl;
  // QGIS ライブ双方向連携(#62): live: 行があれば live.json ポーリング開始
  configureLive(doc, {
    baseUrl,
    kascUrl: lastKascUrl || null,
    applyKascText: liveApplyText,
    getView: () => mapViewToUrl(),
    applySelection: sel => applyQgisSelection(sel),
  });
  syncLivePanel();
  // group: 行の折りたたみ初期状態(#59)。QGIS レイヤーツリーの展開状態を再現
  applyKascGroupStates(doc.groups, expandedLayerGroups);
  renderLayerRows(entries, unsupported);
  currentUnsupported = unsupported;
  updateThemeSelect(doc.themes || []);
  // terrain: 行の垂直誇張(#60)。テレイン ON 時のみ即時反映、入力欄は常時同期
  try {
    const ex = Number(doc.terrain?.opts?.exaggeration);
    if (Number.isFinite(ex) && ex >= 0 && ex !== 1) {
      terrainExaggeration = ex;
      const inp = document.querySelector("#display-terrain-exagg");
      if (inp) inp.value = String(ex);
      if (terrainEnabled && map.getTerrain()) {
        map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: terrainExaggeration });
      }
    }
  } catch (_) {}

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
      entry.error = (await diagnoseHubLayerError(item, err))?.message || err?.message || err;
      unsupported.push({ ...item, type: `${item.type}(読込失敗)` });
    }
    entry.pending = false;
    syncRowStatus(entry);
    updateMapAttribution();
    updateLoadProgress(++done, total, restLabel());
  })()));
  if (seq !== renderSeq) return;
  refreshKascTime();

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

  // ポータルのカード/ボタンを最新の宣言へ同期する。
  // portal: 行があり open=manual でなければ起動時(プロジェクト読込後の初回)に
  // ポータルを自動表示する。インスペクタ再適用では再表示しない
  updatePortalUI();
  if (!portalAutoOpened && inspectorPortalSpec?.enabled && inspectorPortalSpec.open !== "manual") {
    portalAutoOpened = true;
    openPortal();
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

  // プロジェクト再描画で管理レイヤーが removeManaged された分を含め、
  // 共有ストアの状態へ座標ピンレイヤーを再同期する
  coordPins.refresh();
}

// エントリのデータを現在の表示範囲・条件で再読み込みする。
// player-api の reloadEntryData フックと ⏷ フィルタ編集の共通経路
async function reloadEntryData(entry) {
  const { geojson } = await loadVectorItem(entry.item, lastBaseUrl, getViewBounds());
  entry.item._geojson = geojson;
  const env = geojsonExtent(geojson);
  if (env) entry.item._env = env;
  const src = map.getSource(entry.sid);
  if (src?.setData) src.setData(applyClientWhere(entry.item, geojson));
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
  // QGIS ライブ連携: フィルタ変更をプロジェクトへ書き戻す
  liveWritebackEntries(layerEntries);
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
  for (const entry of entries) {
    loadVectorItem(entry.item, lastBaseUrl, bounds).then(({ geojson }) => {
      entry.item._geojson = geojson;
      const env = geojsonExtent(geojson);
      if (env) entry.item._env = env;
      const src = map.getSource(entry.sid);
      if (src?.setData) src.setData(applyClientWhere(entry.item, geojson));
      syncDeckLayers(); // ドレープコピーのデータ更新
      attrWidget.refresh(); // 表示範囲分の行が差し替わった場合に追従
    }).catch(err => console.warn("viewport requery 失敗:", entry.item.title, err));
  }
}

// ---- ツール（計測・標高断面・見通し・緯度経度グリッド・エクスポート）----
// オーバーレイは geojson ソースへ FC を流し、kind プロパティでスタイル分岐する
const TOOL_SRC = "kasc-tools-src";
const GRAT_SRC = "kasc-grat-src";
let toolLayersReady = false;
function ensureToolLayers() {
  if (toolLayersReady || !map.isStyleLoaded?.()) return;
  try {
    if (!map.getSource(TOOL_SRC)) {
      map.addSource(TOOL_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "kasc-tools-poly", type: "fill", source: TOOL_SRC,
        filter: ["==", ["get", "kind"], "poly"],
        paint: { "fill-color": ["coalesce", ["get", "color"], "#ffff00"], "fill-opacity": 0.25 } });
      map.addLayer({ id: "kasc-tools-line", type: "line", source: TOOL_SRC,
        filter: ["in", ["get", "kind"], ["literal", ["line", "los-line", "los-ok", "los-bad"]]],
        paint: { "line-color": ["coalesce", ["get", "color"], ["match", ["get", "kind"], "los-ok", "#32cd32", "los-bad", "#ff0000", "los-line", "#ffa500", "#ffff00"]], "line-width": 3 } });
      map.addLayer({ id: "kasc-tools-circle", type: "circle", source: TOOL_SRC,
        filter: ["in", ["get", "kind"], ["literal", ["point", "los-block", "hover"]]],
        paint: { "circle-radius": 5, "circle-color": ["coalesce", ["get", "color"], ["match", ["get", "kind"], "los-block", "#ff0000", "hover", "#00bfff", "#ffff00"]], "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } });
      map.addLayer({ id: "kasc-tools-label", type: "symbol", source: TOOL_SRC,
        filter: ["has", "text"],
        layout: { "text-field": ["get", "text"], "text-size": 11, "text-offset": [0, -0.8], "text-anchor": "bottom" },
        paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.5 } });
    }
    if (!map.getSource(GRAT_SRC)) {
      map.addSource(GRAT_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "kasc-grat-line", type: "line", source: GRAT_SRC,
        filter: ["==", ["get", "kind"], "grat"],
        paint: { "line-color": "#888888", "line-opacity": 0.55, "line-width": 1 } });
      map.addLayer({ id: "kasc-grat-label", type: "symbol", source: GRAT_SRC,
        filter: ["==", ["get", "kind"], "grat-label"],
        layout: { "text-field": ["get", "text"], "text-size": 11 },
        paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.5 } });
    }
    toolLayersReady = true;
  } catch (_) { /* スタイル再構築中は次回 */ }
}
const toolOverlayOf = srcId => ({
  update: fc => { ensureToolLayers(); try { map.getSource(srcId)?.setData(fc); } catch (_) {} },
});

const geoTools = initGeoTools2d({
  overlay: toolOverlayOf(TOOL_SRC),
  graticuleOverlay: toolOverlayOf(GRAT_SRC),
  getBounds: () => {
    try {
      const b = map.getBounds();
      const norm = d => { const x = ((d + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; };
      return { west: norm(b.getWest()), south: b.getSouth(), east: norm(b.getEast()), north: b.getNorth() };
    } catch (_) { return null; }
  },
  setCursor: c => { map.getCanvas().style.cursor = c; },
  setInteractive: on => { try { on ? map.doubleClickZoom.disable() : map.doubleClickZoom.enable(); } catch (_) {} },
  // テレイン ON 時は DEM タイルから標高を取る（取れなければ地理院標高APIへフォールバック）
  sampleTerrain: async lnglats => {
    if (!terrainEnabled || !map.getTerrain?.()) return null;
    return lnglats.map(p => {
      try { const h = map.queryTerrainElevation([p.lng, p.lat]); return Number.isFinite(h) ? h : null; }
      catch (_) { return null; }
    });
  },
  fitBounds: box => { try { map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 30, duration: 400 }); } catch (_) {} },
  getOrderedLayerItems: () => layerEntries.map((e, i) => (e.item.id ||= String(i), e.item)),
  isVectorLayerItem: item => !!item && VECTOR_TYPES.has(item.type),
  isQueryLayerItem: item => !!item && (item._viewportQuery || isViewportQueryItem(item)),
  getLayerGeoJson: id => layerEntries.find(e => e.item.id === id)?.item._geojson || null,
});

// ミニマップ（表示>一般トグル。Leaflet 遅延ロード・範囲矩形+クリック移動）
const minimap = createMinimap({
  container: "#minimap",
  checkbox: "#display-minimap",
  tileUrl: () => currentBaseEntries[Number(panel.basemapSelect?.value ?? 0)]?.item?.url || "",
  getBounds: () => {
    const b = map.getBounds();
    return [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]];
  },
  flyTo: ({ lng, lat }) => map.easeTo({ center: [lng, lat], duration: 400 }),
});
map.on("move", minimap.scheduleUpdate);

// 3D Tiles ドレープ品質: ズーム確定で terrain カバー FBO を現在解像度へ作り直す
map.on("zoomend", () => invalidateDeckTerrainCovers(deckOverlay?._deck));

// deck(3dtiles)は MapLibre レイヤではないため minzoom/maxzoom が効かない。
// 縮尺表示(minScale=/maxScale=)指定の deck def はズームに応じて zoomHidden を更新する
map.on("zoomend", () => {
  let dirty = false;
  for (const def of deckDefs.values()) {
    const v = itemVisZoom(def.item);
    if (!v) { if (def.zoomHidden) { def.zoomHidden = false; dirty = true; } continue; }
    const z = map.getZoom();
    const zh = (v.minzoom != null && z < v.minzoom) || (v.maxzoom != null && z > v.maxzoom);
    if (zh !== !!def.zoomHidden) { def.zoomHidden = zh; dirty = true; }
  }
  if (dirty) syncDeckLayers();
});

// 表示範囲の移動に追従して URL 反映 + 再クエリする
let requeryTimer = null;
map.on("moveend", () => {
  // QGIS ライブ連携: カメラ停止で QGIS キャンバスへ逆通知(#62)
  liveNotifyCamera();
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

// 地物クリック → 属性タブを自動で開いて属性を表示(Cesium 版 attr-panel と同様)
map.on("click", e => {
  // 計測・断面・見通しツールのモードがアクティブなら属性ピックより優先して頂点拾いに使う
  if (geoTools.handleClick(e.lngLat)) return;
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
  // QGIS ライブ連携: 最前面の地物を QGIS 側の選択へ逆通知(#62)
  if (records[0]?.title) {
    try {
      const fid = records[0].feature?.id ?? records[0].feature?.properties?.id;
      liveNotifySelection({
        layer: records[0].title,
        longitude: e.lngLat.lng, latitude: e.lngLat.lat,
        ...(Number.isFinite(Number(fid)) ? { ids: [Number(fid)] } : {}),
      });
    } catch (_) { /* 逆通知失敗は無視 */ }
  }
  window.switchPanelTab?.("attr");
  renderAttrContent(panel.attrContent, records, { onRecordClick: rec => focusFeatureExtent(rec.feature) });
});

// ツールモード: ダブルクリック確定とラバーバンドプレビュー
map.on("dblclick", e => { if (geoTools.handleDoubleClick()) e.preventDefault(); });
map.on("mousemove", e => { geoTools.handleMouseMove(e.lngLat); });

map.on("load", () => {
  loadProject().catch(err => {
    panel.unsupported.textContent = String(err.message || err);
  });
});

// ---- QGIS 描画フォールバック・オーバーレイ(#62) ----
// /live/render の透過PNGを image source として重ねる
// (Canvas で描けないレイヤーを QGIS レンダリングで表示)
let qgisRenderOn = false;
let qgisRenderTimer = null;
function setQgisRender(on) {
  qgisRenderOn = !!on;
  if (!qgisRenderOn) {
    try { if (map.getLayer("qgis-render")) map.removeLayer("qgis-render"); } catch (_) {}
    try { if (map.getSource("qgis-render")) map.removeSource("qgis-render"); } catch (_) {}
    return;
  }
  refreshQgisRender();
}
function qgisViewBbox() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}
function adjustBboxAspect(bbox, w, h) {
  const [x0, y0, x1, y1] = bbox;
  const cur = (x1 - x0) / (y1 - y0);
  const tgt = w / h;
  if (!(cur > 0) || !(tgt > 0) || Math.abs(cur - tgt) < 1e-9) return bbox;
  if (cur > tgt) {
    const dh = (x1 - x0) / tgt - (y1 - y0);
    return [x0, y0 - dh / 2, x1, y1 + dh / 2];
  }
  const dw = (y1 - y0) * tgt - (x1 - x0);
  return [x0 - dw / 2, y0, x1 + dw / 2, y1];
}
function refreshQgisRender() {
  if (!qgisRenderOn || !liveIsActive()) return;
  const bbox = qgisViewBbox();
  if (!bbox) return;
  const w = Math.max(1, map.getContainer().clientWidth || 800);
  const h = Math.max(1, map.getContainer().clientHeight || 600);
  const adj = adjustBboxAspect(bbox, w, h);
  const url = liveRenderUrl({ bbox: adj, w, h });
  if (!url) return;
  const coordinates = [
    [adj[0], adj[3]], [adj[2], adj[3]], [adj[2], adj[1]], [adj[0], adj[1]],
  ];
  const src = map.getSource("qgis-render");
  if (src) {
    src.updateImage({ url, coordinates });
    return;
  }
  map.addSource("qgis-render", { type: "image", url, coordinates });
  map.addLayer({ id: "qgis-render", type: "raster", source: "qgis-render",
    paint: { "raster-opacity": 0.9 } });
}
map.on("moveend", () => {
  if (!qgisRenderOn) return;
  clearTimeout(qgisRenderTimer);
  qgisRenderTimer = setTimeout(refreshQgisRender, 700);
});
// QGIS Live 操縦パネル(live: 行検出時にパネル先頭へ表示)
mountLivePanel(document.querySelector("#panel"), { setRender: setQgisRender });

// ?follow[=<base>] → geo_webview の /live/state をポーリングして表示を追従
// (shared/live.js の live セッションへ統合。pitch は保持される)
configureFollow({
  apply: (s, { topdown }) => {
    const opt = {};
    if (typeof s.lon === "number" && typeof s.lat === "number") opt.center = [s.lon, s.lat];
    // /live/state の zoom は OL 規約(256px基準)のため -1
    if (typeof s.zoom === "number") opt.zoom = s.zoom - 1;
    if (typeof s.rotation === "number") opt.bearing = s.rotation;
    if (topdown) opt.pitch = 0;
    map.jumpTo(opt);
  },
});

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
    if (rotInput && document.activeElement !== rotInput) rotInput.value = String(Math.round(b));
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
    const heading = ((map.getBearing()) % 360 + 360) % 360;
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
  rotation?.addEventListener("change", () => map.setBearing(Number(rotation.value || 0)));
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
    coordsEl.textContent = formatLatLng(e.lngLat.lat, e.lngLat.lng);
  });
  installLocalCrsUI({
    anchor: document.querySelector("#coords-datum"),
    pickLatLng: cb => map.once("click", e => cb(e.lngLat)),
  });
  document.querySelector("#display-coords")?.addEventListener("change", e => {
    if (coordsEl) coordsEl.style.display = e.target.checked ? "" : "none";
  });

  // 一般設定を既定値へ戻す（時刻は対象外）
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

  // 太陽日時コントロール → 画面中心の太陽位置を計算して map.setLight（hillshade/extrusion に反映）
  const sunPos = (latDeg, lngDeg, ms) => {
    const rad = Math.PI / 180, day = 86400000;
    const d = ms / day - 0.5 + 2440588 - 2451545;
    const phi = rad * latDeg, lw = rad * -lngDeg;
    const M = rad * (357.5291 + 0.98560028 * d);
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = rad * (280.4665 + 0.98564736 * d) + C + Math.PI;
    const e = rad * 23.4397;
    const dec = Math.asin(Math.sin(L) * Math.sin(e));
    const ra = Math.atan2(Math.sin(L) * Math.cos(e) * -1, Math.cos(L) * -1) - Math.PI / 2;
    const sid = rad * (280.16 + 360.9856235 * d) - lw;
    const H = sid - ra;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    return { azimuth: az / rad + 180, elevation: alt / rad };
  };
  mountSunControls({ tz: document.querySelector("#ml-tz"), datetime: document.querySelector("#ml-datetime"), hour: document.querySelector("#ml-hour") },
    ms => {
      try {
        const c = map.getCenter();
        const s = sunPos(c.lat, c.lng, ms);
        map.setLight({ position: [1.15, s.azimuth, Math.max(0, 90 - s.elevation)], intensity: s.elevation > 0 ? 0.5 : 0.15 });
      } catch (_) {}
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


  const terrainToggle = document.querySelector("#display-terrain");
  const terrainSourceSel = document.querySelector("#display-terrain-source");
  const terrainExaggInput = document.querySelector("#display-terrain-exagg");
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
  terrainExaggInput?.addEventListener("input", () => {
    const v = terrainExaggInput.value === "" ? NaN : Number(terrainExaggInput.value);
    if (!Number.isFinite(v) || v < 0) return;
    terrainExaggeration = v;
    if (terrainEnabled && map.getTerrain()) {
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: terrainExaggeration });
      regroundAllDeck(); // queryTerrainElevation は誇張込みのため再接地が必要
    }
  });
  document.querySelector("#display-terrain-exagg-reset")?.addEventListener("click", () => {
    if (!terrainExaggInput) return;
    terrainExaggInput.value = "1";
    terrainExaggInput.dispatchEvent(new Event("input"));
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
  void applyKascThemeStyles(theme);
  // QGIS ライブ連携: テーマ適用を QGIS プロジェクトへ書き戻す
  liveWritebackEntries(layerEntries, { theme: theme?.name });
}

// theme 行の `;style=` 指定でレイヤーの .qml を差し替えて再マウントする。
// 指定が無いレイヤーは元の style= 指定(_themeBaseStyle に保存)へ戻す。
// QGIS マップテーマが記録する名前付きスタイルの再現(Cesium と同規則)
async function applyKascThemeStyles(theme) {
  const styles = theme?.styles || {};
  for (const e of layerEntries) {
    const item = e.item;
    if (!VECTOR_TYPES.has(item.type)) continue;
    const key = normKascTitle(item.title || "");
    const rel = styles[key] ?? styles[key.split("/").pop()] ?? null;
    if (item._themeBaseStyle === undefined) item._themeBaseStyle = item.opts?.style || null;
    const target = rel ? resolveKascUrl(rel, lastBaseUrl) : item._themeBaseStyle;
    if ((item.opts?.style || null) === target) continue;
    item.opts ||= {};
    if (target) item.opts.style = target; else delete item.opts.style;
    item._qml = null;
    try {
      for (const lid of e.lids || []) { if (deckDefs.has(lid)) deckDefs.delete(lid); else if (map.getLayer(lid)) map.removeLayer(lid); }
      if (e.sid && map.getSource(e.sid)) map.removeSource(e.sid);
      e.lids = []; e.sid = null;
      syncDeckLayers();
      if (item.visible !== false && !e.unsupported) {
        const idx = layerEntries.indexOf(e);
        const r = await addKascLayer(item, lastBaseUrl, item._preloaded,
          () => findInsertBeforeId(idx < 0 ? layerEntries.length : idx));
        e.lids = r.lids; e.sid = r.sid; e.filters = r.filters; e.opas = r.opas;
        item._viewportQuery = r.viewportQuery;
        applyEntryVisibility(e);
      }
    } catch (err) { console.warn("テーマスタイルの適用に失敗:", err); }
  }
  updateMapAttribution();
}

themeSelect?.addEventListener("change", () => {
  const theme = currentThemes.find(t => t.name === themeSelect.value);
  if (theme) applyKascTheme(theme);
});

// ---- ビュー(view: 行。表示+スタイル+フィルタ+カメラ+背景を束ねた目的別プリセット) ----

// ビュー適用前の状態を記録する。ビュー解除でこの状態へ戻す
function captureViewSnapshot() {
  const items = new Map();
  for (const e of layerEntries) {
    if (!e.item?.line) continue;
    items.set(e, { visible: e.item.visible !== false, where: e.item.opts?.where });
  }
  return {
    items,
    camera: { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() },
  };
}

// ビューのメンバレイヤーか( `*` は全レイヤー)。where/style 適用対象の判定に使う
function viewHasLayer(view, item, show) {
  if (show == null) return true;
  return kascTitleInTheme(item.title, show);
}

// レイヤーに対応するビュー側指定(styles/wheres マップ。フルパス→葉名の順で照合)
function viewSpecFor(view, mapName, item) {
  const mapObj = view?.[mapName] || {};
  const key = normKascTitle(item.title || "");
  return mapObj[key] ?? mapObj[key.split("/").pop()];
}

// エントリの where= 変更を地図へ反映する。
// クエリ系/表示範囲連動系は where= を反映した再読み込み、
// それ以外の全件読み込み系はクライアント評価で source.setData だけ更新する
async function applyEntryWhere(entry) {
  const item = entry.item;
  if (!item || !VECTOR_TYPES.has(item.type) || entry.deferred || entry.unsupported) return;
  if (QUERY_TYPES.has(item.type) || item._viewportQuery) {
    await reloadEntryData(entry);
    return;
  }
  if (item._geojson) {
    map.getSource(entry.sid)?.setData?.(applyClientWhere(item, item._geojson));
    syncDeckLayers(); // ドレープコピーのデータ更新
  }
}

// ビュー適用: 表示+フィルタを反映し、スタイル差替・背景・カメラを後続適用する。
// 初回適用時はスナップショットを取る(Cesium 版 applyKascView と同規則)
async function applyKascView(view) {
  if (!view) return;
  if (!viewSnapshot) viewSnapshot = captureViewSnapshot();
  activeViewName = view.name || null;
  const show = themeShowSet(view);
  const items = layerEntries.filter(e => e.item?.line);
  for (const e of items) {
    const item = e.item;
    item.visible = show == null || kascTitleInTheme(item.title, show);
    // ビューのメンバレイヤーは ;where= がなくてもフィルタ解除まで含めて
    // ビュー指定を正とする(スナップショットで解除時に復元される)。
    // ビュー外のレイヤーのフィルタは触らない
    if (viewHasLayer(view, item, show)) {
      const where = viewSpecFor(view, "wheres", item);
      item.opts ||= {};
      if (item.type === "sql") {
        if (where) console.warn(`view:${view.name}: sql: レイヤーへの ;where= は未対応です`, item.title);
      } else {
        item.opts.where = where || undefined;
      }
    }
    applyEntryVisibility(e);
    maybeLoadEntry(e);
  }
  // インスペクターの .kasc 行へ on/off と where= を書き戻す
  // (テーマ適用と同じ規則。sql: 行はクエリ文字列が本文のため where= を書かない)
  {
    const lines = inspectorInput.value.split(/\r?\n/);
    for (const e of items) {
      const item = e.item;
      const idx = lines.findIndex(l => l.trim() === item.line);
      let newLine = rewriteKascLineVisibility(item.line, show);
      if (item.type !== "sql") newLine = rewriteKascLineOpt(newLine, "where", item.opts?.where ?? null);
      if (idx >= 0) lines[idx] = newLine;
      item.line = newLine;
    }
    inspectorInput.value = lines.join("\n");
  }
  // where= 変更を地図へ反映(クエリ系は再読み込み、全件系はクライアントフィルタ)
  await Promise.allSettled(items.map(e => applyEntryWhere(e)));
  renderLayerRows(layerEntries, currentUnsupported);
  // ;style= 指定レイヤーの .qml 差替(テーマと同じ機構)
  void applyKascThemeStyles(view);
  // 背景地図(base=)・カメラ(cam=)は view:/portal data-* 共通ヘルパーへ
  if (view.base) applyViewBase(view.base);
  if (view.cam) applyViewCam(view.cam, `view:${view.name}`);
  // QGIS ライブ連携: ビュー適用を QGIS プロジェクトへ書き戻す
  liveWritebackEntries(layerEntries, { theme: view?.name });
  updatePortalButton();
}

// view base=/portal data-base= 共通: 背景地図をタイトル/葉名で照合して切替。
// none=ベースマップなし、transparent=地表透明(このエンジンでは全 base を消す)
function applyViewBase(rawName) {
  const name = String(rawName || "").trim();
  if (/^(none|off|なし|ベースマップなし|transparent|hide|透明)$/i.test(name)) {
    for (const e of currentBaseEntries) {
      e.lids.forEach(lid => map.getLayer(lid) && map.setLayoutProperty(lid, "visibility", "none"));
    }
    if (panel.basemapSelect) panel.basemapSelect.value = "";
  } else {
    const idx = currentBaseEntries.findIndex(e => {
      const title = e.item.title || "";
      return title === name || splitKascTitle(title).title === name;
    });
    if (idx >= 0 && panel.basemapSelect) {
      panel.basemapSelect.value = String(idx);
      panel.basemapSelect.dispatchEvent(new Event("change"));
      syncBasemapList(panel.basemapSelect);
    }
  }
  syncDeckLayers();
  updateMapAttribution();
}

// view cam=/portal data-cam= 共通: カメラプリセット名で移動
// (カメラタブのボタンと同じ移動規則)
function applyViewCam(name, logPrefix = "data-cam") {
  const preset = currentCams.find(c => c.name === name || c.title === name);
  if (preset) {
    const e = preset._extent;
    if (e) map.fitBounds([[e.west, e.south], [e.east, e.north]], { padding: 40, duration: 800, maxZoom: 20 });
    else { const gc = groundCenterFromCam(preset); map.flyTo({ center: [gc.longitude, gc.latitude], zoom: heightToViewZoom(gc.latitude, preset.height, mapCanvasH()) - 1 }); }
  } else console.warn(`${logPrefix}: cam= のカメラプリセットが見つかりません`, name);
}

// ビュー解除: 適用前スナップショットへ復元する
async function clearKascView() {
  const snap = viewSnapshot;
  activeViewName = null;
  viewSnapshot = null;
  if (!snap) { updatePortalButton(); return; }
  const items = layerEntries.filter(e => e.item?.line);
  for (const e of items) {
    const s = snap.items.get(e);
    if (!s) continue;
    e.item.visible = s.visible;
    e.item.opts ||= {};
    if (e.item.type !== "sql") e.item.opts.where = s.where;
    applyEntryVisibility(e);
    maybeLoadEntry(e);
  }
  // 表示状態を行へ戻す。復元後の可視レイヤータイトルをセットにして
  // rewriteKascLineVisibility で on/off を書き戻す
  const showSet = new Set();
  for (const e of items) {
    if (e.item.visible === false) continue;
    const n = normKascTitle(e.item.title || "");
    if (!n) continue;
    showSet.add(n); showSet.add(n.split("/").pop());
  }
  {
    const lines = inspectorInput.value.split(/\r?\n/);
    for (const e of items) {
      const item = e.item;
      const idx = lines.findIndex(l => l.trim() === item.line);
      let newLine = rewriteKascLineVisibility(item.line, showSet);
      if (item.type !== "sql") newLine = rewriteKascLineOpt(newLine, "where", item.opts?.where ?? null);
      if (idx >= 0) lines[idx] = newLine;
      item.line = newLine;
    }
    inspectorInput.value = lines.join("\n");
  }
  await Promise.allSettled(items.map(e => applyEntryWhere(e)));
  renderLayerRows(layerEntries, currentUnsupported);
  // テーマ/ビュー差替スタイルを元の style= 指定へ戻す
  void applyKascThemeStyles({ styles: {} });
  if (snap.camera) map.jumpTo(snap.camera);
  liveWritebackEntries(layerEntries);
  updatePortalButton();
}

// ---- ポータル(portal:/html:/view:/link: 行で構成する開始画面) ----
// UI 構築は shared/portal.js へ共通化。ここでは状態getterと
// applyView/clearView を束ねた遅延インスタンスを提供する

let _kascPortal = null;
function kascPortal() {
  if (!_kascPortal) {
    _kascPortal = createKascPortal({
      t,
      resolveProjectUrl,
      loadInfoContent: loadKascInfoContent,
      applyView: view => applyKascView(view),
      clearView: () => clearKascView(),
      applyCam: name => applyViewCam(name),
      applyBase: name => applyViewBase(name),
      getActiveViewName: () => activeViewName,
      getPortalSpec: () => inspectorPortalSpec,
      getPanelTitle: () => inspectorPanelTitle,
      getHtmlSections: () => inspectorHtmlSections,
      getCards: () => inspectorPortalCards,
    });
  }
  return _kascPortal;
}
const portalAvailable = () => kascPortal().available();
const updatePortalButton = () => kascPortal().updateButton();
const updatePortalUI = () => kascPortal().update();
const openPortal = () => kascPortal().open();
const closePortal = () => kascPortal().close();

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
    // QGIS ライブ連携: インスペクタ適用をプロジェクトへ書き戻す
    liveWritebackEntries(layerEntries);
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
    // v.zoom は engine ネイティブ(getViewInfo と往復)なので素通し、height 由来は -1
    opts.zoom = Number.isFinite(v.zoom) ? v.zoom : heightToViewZoom(v.latitude, v.height, mapCanvasH()) - 1;
    if (Number.isFinite(v.heading)) opts.bearing = v.heading;
    if (Number.isFinite(v.pitch)) opts.pitch = Math.max(0, Math.min(60, v.pitch + 90));
    // instant=フライパス巡回等の高頻度更新。flyTo の逐次再起動を避け即時配置する
    if (v.instant) map.jumpTo(opts);
    else map.flyTo(opts);
  },
  getViewInfo: () => {
    const c = map.getCenter();
    return { latitude: c.lat, longitude: c.lng, zoom: map.getZoom(), heading: map.getBearing(), pitchDeg: map.getPitch() };
  },
  viewToUrl: () => mapViewToUrl(),
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
  reloadEntryData,
  getEntryGeoJson: entry => entry.item._geojson || null,
  geoTools: () => geoTools,
  getFlyPaths: kascFlyPaths.getFlyPaths,
  persistFlyPath: kascFlyPaths.persistFlyPath,
  syncFlyPathLine: kascFlyPaths.syncFlyPathLine,
  liveSync: async args => liveUpdate(args),
  setBaseEntryVisible: (entry, on) => {
    for (const lid of entry.lids || []) {
      if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", on ? "visible" : "none");
    }
    updateMapAttribution();
  },
});
// view: 行の目的別プリセット一覧/適用/解除とポータル画面の開閉。
// 表示＋スタイル＋フィルタ(＋カメラ/背景)をまとめて適用するテーマの発展形
Object.assign(window.kasugaiApi, {
  listViews() {
    return inspectorViews.map(view => ({
      name: view.name, desc: view.desc, img: view.img, cam: view.cam, base: view.base,
      layers: [...view.layers], active: view.name === activeViewName,
    }));
  },
  async applyView(name) {
    const view = inspectorViews.find(entry => entry.name === name);
    if (!view) return false;
    await applyKascView(view);
    return true;
  },
  async clearView() {
    await clearKascView();
    return true;
  },
  openPortal() { openPortal(); return portalAvailable(); },
  closePortal() { closePortal(); return true; },
});
mountEngineSwitcher(document.querySelector("#engines"), "maplibre");
// ポータル: 🏠ボタンで開始画面を開く / 「地図を開く」・Esc で閉じる / 「ビュー解除」で復元
kascPortal().bindEvents();
window.addEventListener("kasugai:language-changed", () => updatePortalUI());
// カレント状態ファイル(Cesium規約)へ現在値を反映する(変化イベント駆動)
bindSessionState("maplibre");
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
  // 印刷範囲プレビュー用アダプタ
  mapEl: () => map.getContainer(),
  getCenterLonLat: () => { const c = map.getCenter(); return { lon: c.lng, lat: c.lat }; },
  panByPx: (dx, dy) => map.panBy([-dx, -dy], { duration: 0 }),
  zoomToDenom: (d) => {
    const lat = map.getCenter().lat;
    const z = Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) / (d * 0.00028));
    map.jumpTo({ zoom: z });
  },
  fitExtent: async (w, s, e, n) => { map.fitBounds([[w, s], [e, n]], { duration: 0 }); },
});

// ---- ナビゲーション共通ツール（shared/nav-tools.js）----
initNavTools({
  el: document.getElementById("map"),
  getView: () => ({ lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }),
  setView: v => map.jumpTo({ center: [v.lng, v.lat], zoom: v.zoom, bearing: v.bearing || 0, pitch: v.pitch || 0 }),
  viewsEqual: (x, y) => x && y && Math.abs(x.lat - y.lat) < 1e-7 && Math.abs(x.lng - y.lng) < 1e-7 && Math.abs((x.zoom ?? 0) - (y.zoom ?? 0)) < 0.001 && Math.abs((x.bearing ?? 0) - (y.bearing ?? 0)) < 0.5 && Math.abs((x.pitch ?? 0) - (y.pitch ?? 0)) < 0.5,
  flyTo: (lat, lng) => map.flyTo({ center: [lng, lat] }),
  fitBounds: (w, s, e, n) => map.fitBounds([[w, s], [e, n]]),
  isTilted: () => map.getPitch() > 0.5 || Math.abs(map.getBearing()) > 0.5,
  centerZoom: (c, scale) => map.flyTo({ center: [c.lng, c.lat], zoom: map.getZoom() - Math.log2(scale) }),
  onMoveStart: cb => map.on("movestart", cb),
  onMoveEnd: cb => map.on("moveend", cb),
  toLatLng: (x, y) => { const ll = map.unproject([x, y]); return { lat: ll.lat, lng: ll.lng }; },
  setMarker: ll => { initNavTools._mk?.remove(); initNavTools._mk = ll ? new maplibregl.Marker().setLngLat([ll.lng, ll.lat]).addTo(map) : null; },
  capturePng: () => new Promise(res => { map.once("render", () => map.getCanvas().toBlob(res, "image/png")); map.triggerRepaint(); }),
  nativeBoxZoom: true,
});

// ---- 座標ピン（shared/coord-pins.js の共有 GeoJSON を一般レイヤーとして描画）----
// layerEntries に正規エントリを持つため、レイヤ一覧・属性表示(クリック)・
// 属性検索・属性一覧ウィジェットが通常レイヤーと同じ経路で使える
const PIN_SID = "coord-pins";
const PIN_LID = "coord-pins-circle";
let pinEntry = null;
function syncCoordPinLayer(fc) {
  // プロジェクト再描画(removeManaged)で消えた分を含め、ストアの状態へ収束させる
  if (pinEntry && !layerEntries.includes(pinEntry)) pinEntry = null;
  // スタイル未ロード(sessionStorage 復元直後の初回 notify 等)では
  // レイヤ行だけ先行登録し、地図ソースは renderProject 後の refresh で張る
  const loaded = map.isStyleLoaded();
  const src = loaded ? map.getSource(PIN_SID) : null;
  if (!fc.features.length) {
    if (loaded && map.getLayer(PIN_LID)) map.removeLayer(PIN_LID);
    if (src) map.removeSource(PIN_SID);
    managedLayers = managedLayers.filter(l => l !== PIN_LID);
    managedSources = managedSources.filter(s => s !== PIN_SID);
    if (pinEntry) {
      const i = layerEntries.indexOf(pinEntry);
      if (i >= 0) layerEntries.splice(i, 1);
      pinEntry = null;
      renderLayerRows(layerEntries, currentUnsupported);
    }
    return;
  }
  if (!pinEntry) {
    pinEntry = { item: { title: "座標ピン", type: "geojson", visible: true }, lids: [PIN_LID], sid: PIN_SID, pending: false };
    layerEntries.unshift(pinEntry);
    renderLayerRows(layerEntries, currentUnsupported);
  }
  pinEntry.item._geojson = fc;
  const env = geojsonExtent(fc);
  if (env) pinEntry.item._env = env;
  if (src) src.setData(fc);
  else if (loaded) {
    map.addSource(PIN_SID, { type: "geojson", data: fc });
    map.addLayer({
      id: PIN_LID, type: "circle", source: PIN_SID,
      layout: { visibility: pinEntry.item.visible !== false ? "visible" : "none" },
      paint: {
        "circle-radius": 7,
        "circle-color": ["coalesce", ["get", "marker-color"], "#e33d3d"],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
      },
    });
    managedSources.push(PIN_SID);
    managedLayers.push(PIN_LID);
  }
}
coordPins.setRenderer(syncCoordPinLayer);
