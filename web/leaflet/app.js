// KASUGAI Canvas — Leaflet フロント
// .kasc プレイヤーモード: projects/<id>/ の .kasc+DATA/ を Leaflet で再生する
import { loadKascProject, NON_LAYER_TYPES, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeightView, heightToViewZoom, viewZoomToHeight, groundCenterFromCam, parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle, appendGroupedTitleOptions, syncBasemapList, sanitizeAttributionFragment, layerAttribution, loadKascInfoContent, buildWmtsTileTemplate, rewriteKascVisibility, rewriteKascLineOpt, themeShowSet, kascTitleInTheme, normKascTitle, fillThemeSelect, loadKascBookmarks, parseQgisBookmarksXml, qgisBookmarkToCam, downloadQgisBookmarksXml, downloadKascCamLines, projectsBaseUrl, applyPanelTitle, resolveDefaultPointStyle, resolveDefaultLineStyle, resolveDefaultPolygonStyle, defaultPointRadius, kascOptOn, parseImageOverlay, kascScaleZoomRange, mergeZoomRange, applyKascGroupStates, parseKascViewValue, parseKascPortalValue, parseKascLinkValue } from "../shared/kasc.js";
import { createKascPortal } from "../shared/portal.js";
import { compileWhereExpression } from "../shared/where-eval.js";
import { initI18n, t, applyI18n } from "../shared/i18n.js";
import { kascTimeSpec, collectTimeValues, featureInTime, buildKascTimeControl } from "../shared/kasc-time.js";
import { loadScriptOnce, loadCssOnce } from "../shared/lazy-lib.js";
import { createKascFlyPaths } from "../shared/fly-kasc.js";
import { backendUrl } from "../shared/backend.js";
import { loadVectorItem, isViewportQueryItem } from "../shared/vector-load.js";
import { diagnoseHubLayerError } from "../shared/hub-diag.js";
import { createMinimap } from "../shared/minimap.js";
import { initGeoTools2d, makeLeafletOverlay } from "../shared/geo-tools-2d.js";
import { createAttrWidget, renderAttrContent, attrEntriesFromProps } from "../shared/attr-widget.js";
import { initAiChat, hasBackendFeature } from "../shared/ai-chat.js";
import { createPlayerApi } from "../shared/player-api.js";
import { configureLive, configureFollow, liveUpdate, liveNotifyCamera, liveNotifySelection, liveWritebackEntries } from "../shared/live.js";
import { mountEngineSwitcher } from "../shared/engine-switch.js";
import { matchSessionState, bindSessionState, applySessionState, sessionBootView } from "../shared/session-state.js";
import { initNavTools } from "../shared/nav-tools.js";
import { coordPins } from "../shared/coord-pins.js";
import { formatLatLng } from "../shared/coords-format.js";
import { installLocalCrsUI } from "../shared/coords-local.js";
import { initPrint, compositeDomMap } from "../shared/print.js";

import { groundDeckTileset } from "../shared/deck-ground.js";
import { buildDeckDrapeLayers, invalidateDeckTerrainCovers, isGoogle3dTilesUrl, withGoogleTileKey, ensureGoogleTileKeyFetch } from "../shared/deck-drape.js";
import { qmlLegendSwatchDataUrl, defaultVectorLegendSpec, specToStyle, loadCompiledQml, compiledScaleToResRange, resToZoom, installLayerVisibilityResolver, qmlLabelElement } from "../shared/qml-2d.js";
import { markerLayersToCanvas, fillPartsToTile } from "../shared/qml-style.js";
import { applyInvertedMaskGeojson } from "../shared/qml-2d.js";

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

const map = L.map("map", {
  center: [35.681, 139.767],
  zoom: 10,
  attributionControl: false, // 出典は Cesium 版と同型の右下オーバーレイで表示
  zoomControl: false, // 拡縮ボタンは出さない（ホイール/ピンチのみ。右上ツールバーは ⌂ のみ）
});
window.kascMap = map; // デバッグ/外部連携用参照（他エンジンと同じ公開範囲）

// 地物(GeoJSON Feature)の範囲へ移動。属性一覧・属性タブの行クリックで共通使用
function focusFeatureExtent(feature) {
  const env = geojsonExtent({ type: "FeatureCollection", features: [feature] });
  if (env) map.fitBounds(envToLatLngBounds(env), { padding: [80, 80], maxZoom: 18 });
}

// 全レイヤのデータ範囲（item._env）の合範囲へ fit する。
// 範囲が取れなければ false を返す。プロジェクト初期表示と ⌂ ボタンで共用
function fitDataExtent({ padding = [40, 40], maxZoom = 17, animate = false } = {}) {
  let env = null;
  for (const { item } of layerEntries) {
    if (!item._env) continue;
    env = env
      ? [Math.min(env[0], item._env.west), Math.min(env[1], item._env.south), Math.max(env[2], item._env.east), Math.max(env[3], item._env.north)]
      : [item._env.west, item._env.south, item._env.east, item._env.north];
  }
  if (!env) return false;
  const bounds = [[env[1], env[0]], [env[3], env[2]]];
  if (animate) map.flyToBounds(bounds, { padding, maxZoom });
  else map.fitBounds(bounds, { padding, maxZoom });
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

// .kasc レイヤは専用 pane に1層ずつ割り当てて積み順を再現する
// （Leaflet の既定 pane ではラスタ/ベクターの混在順が保持できないため）。
// ベースマップは最背面 pane、レイヤーは zIndex 300 から順に積む
map.createPane("kasc-base");
map.getPane("kasc-base").style.zIndex = 150;
let kascPaneSeq = 0;
const managedPanes = [];
function newKascPane() {
  const name = `kasc-l${kascPaneSeq++}`;
  map.createPane(name);
  map.getPane(name).style.zIndex = String(300 + kascPaneSeq);
  managedPanes.push(name);
  return name;
}
function removeManagedPanes() {
  for (const name of managedPanes) {
    map.getPane(name)?.remove();
    delete map._panes[name];
  }
  managedPanes.length = 0;
}

// 現在プロジェクトのレイヤーエントリ（表示範囲連動の再クエリ用）
let layerEntries = [];
// QML 式 is_layer_visible('名前') を item.visible へ解決する(Cesium 版と同規則)
installLayerVisibilityResolver(() => layerEntries.map(e => e.item));

// QML <labeling> のラベルを永久 tooltip として付ける/更新する。
// is_layer_visible で他レイヤーの表示状態を参照し得るため、
// 表示切替のたびに refreshQmlLabels 経由で再評価される
function syncLeafletLabel(sub) {
  const st = sub._kascLabel;
  if (!st) return;
  const el = qmlLabelElement(st.item._qml, st.feature.properties || {});
  if (el) {
    const spec = el._kascLabelSpec || {};
    const [ox, oy] = spec.pixelOffsetOf ? spec.pixelOffsetOf() : [0, 0];
    // 縮尺表示 → zoom 範囲へ変換して保持(zoomend で表示切替)
    st.zoomRange = spec.labelScale ? labelScaleToZoomRange(spec.labelScale) : null;
    st.spec = spec;
    const opts = {
      permanent: true, direction: "center", className: "kasc-label",
      interactive: false, offset: [ox, oy],
    };
    if (sub.getTooltip()) {
      const cur = sub.getTooltip();
      if (Math.abs((cur.options.offset?.[0] || 0) - ox) > 0.5 || Math.abs((cur.options.offset?.[1] || 0) - oy) > 0.5) {
        sub.unbindTooltip(); sub.bindTooltip(el, opts);
      } else sub.setTooltipContent(el);
    } else sub.bindTooltip(el, opts);
  } else {
    st.zoomRange = null;
    if (sub.getTooltip()) sub.unbindTooltip();
  }
}
// ラベル縮尺分母 → Leaflet zoom 範囲
function labelScaleToZoomRange(ls) {
  const lat = map.getCenter()?.lat || 0;
  return {
    minZoom: ls.maxScale ? resToZoom(ls.maxScale * 0.00028, lat) : 0,
    maxZoom: ls.minScale ? resToZoom(ls.minScale * 0.00028, lat) : 99,
  };
}
// 縮尺表示範囲外のラベルは DOM クラスで隠す。あわせて DOM 矩形の重なりを
// 検出して衝突したラベルを隠す(QGIS の「重なったラベルを隠す」近似。
// displayAll/allowOverlap は対象外)
function syncLabelZoomVisibility() {
  const z = map.getZoom();
  const candidates = [];
  for (const entry of layerEntries) {
    entry.layer?.eachLayer?.(sub => {
      const st = sub._kascLabel;
      const tipEl = sub.getTooltip?.()?.getElement?.();
      if (!st || !tipEl) return;
      const r = st.zoomRange;
      const outOfRange = !!r && (z < r.minZoom || z > r.maxZoom);
      tipEl.classList.toggle("kasc-label-hidden", outOfRange);
      const spec = st.spec || {};
      if (!outOfRange && !(spec.allowOverlap || spec.displayAll)) {
        candidates.push({ tipEl, prio: (spec.zIndex || 0) * 100 + (spec.priority || 0) });
      }
    });
  }
  // 衝突回避: 優先度順に矩形を確保し、重なったものを隠す
  candidates.sort((a, b) => b.prio - a.prio);
  const placed = [];
  // obstacleType: 地物 geometry を他ラベルの障害物として事前登録する
  // (ポリゴン/線は bounds、点はマーカーサイズの箱で近似)
  for (const entry of layerEntries) {
    entry.layer?.eachLayer?.(sub => {
      const st = sub._kascLabel;
      if (!st?.spec?.obstacleType) return;
      try {
        let b = null;
        if (sub.getBounds) b = sub.getBounds();
        else if (sub.getLatLng) {
          const half = 8;
          const c = map.latLngToContainerPoint(sub.getLatLng());
          placed.push({ left: c.x - half, top: c.y - half, right: c.x + half, bottom: c.y + half });
          return;
        }
        if (!b) return;
        const p1 = map.latLngToContainerPoint(b.getNorthWest());
        const p2 = map.latLngToContainerPoint(b.getSouthEast());
        placed.push({ left: p1.x, top: p1.y, right: p2.x, bottom: p2.y });
      } catch (_) {}
    });
  }
  for (const c of candidates) {
    const r = c.tipEl.getBoundingClientRect();
    // 0幅/高さの tooltip は判定対象外
    if (!r.width || !r.height) { c.tipEl.classList.toggle("kasc-label-hidden", true); continue; }
    const hit = placed.some(b => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top);
    c.tipEl.classList.toggle("kasc-label-hidden", hit);
    if (!hit) placed.push(r);
  }
}
map.on("zoomend", syncLabelZoomVisibility);
map.on("moveend", syncLabelZoomVisibility);
function refreshQmlLabels() {
  for (const entry of layerEntries) {
    entry.layer?.eachLayer?.(sub => { if (sub._kascLabel) syncLeafletLabel(sub); });
  }
  syncLabelZoomVisibility();
}
let currentBaseEntries = [];
let lastBaseUrl = "";
// ?kasc= で読み込んだ .kasc の URL。設定中は URL 書き換え時に
// project= を書かず ?kasc= を維持する(実プロジェクト選択で空に戻る)
let lastKascUrl = "";
let currentProjectId = "";
// URL ハッシュの初期ビューは最初の loadProject で一度だけ適用する
// （プロジェクト切替時はそのプロジェクトの cam/範囲へ移動する既存挙動を維持）
let urlViewConsumed = false;

// Leaflet ビュー ⇄ URL パラメータ（Cesium 規約: pitch は直下=-90、heading は北=0。
// Leaflet の2Dビューは回転を持たないため、書き出しは pitch=-90/heading=0 固定）
const mapCanvasH = () => map.getSize().x || 512;
function mapViewToUrl() {
  const c = map.getCenter();
  const zoom = map.getZoom();
  return {
    latitude: c.lat,
    longitude: c.lng,
    zoom,
    height: Number.isFinite(zoom) ? viewZoomToHeight(c.lat, zoom, mapCanvasH()) : NaN,
    pitch: -90,
    heading: 0,
  };
}

function urlViewToCenter(v) {
  const gc = groundCenterFromCam(v); // pitch は座標計算にのみ使用
  return {
    center: [gc.latitude, gc.longitude],
    zoom: Number.isFinite(v.height) ? heightToViewZoom(gc.latitude, v.height, mapCanvasH())
      : (Number.isFinite(v.zoom) ? v.zoom : camToZoom(v)),
  };
}

// アドレスバーのハッシュ書き換え（再読み込み不要）からの復元。Cesium 版 applyUrlCamera と同じ挙動
function applyUrlView() {
  const v = parseUrlView();
  if (hasUrlView(v)) { const o = urlViewToCenter(v); map.flyTo(o.center, o.zoom); }
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

function envToLatLngBounds(env) {
  return [[env.south, env.west], [env.north, env.east]];
}

// 凡例シンボル単位の非表示スタイル（opacity/fillOpacity 0 + 操作不可）
const HIDDEN_STYLE = { opacity: 0, fillOpacity: 0, weight: 0, interactive: false };

// QML/既定スタイル → Leaflet Path options。item._legendHidden・
// item._opacityFactor（レイヤー透過度スライダ）をその都度読むため、
// setStyle(styleFn) の再適用で表示切替・透過度変更がそのまま反映される
function makeVectorStyleFn(item) {
  return feature => {
    const props = feature.properties || {};
    const gt = feature.geometry?.type || "";
    const isPoint = /Point/.test(gt);
    const o = item._opacityFactor ?? 1;
    if (item._qml) {
      const names = item._qml.namesFor?.(props);
      if (names?.length && item._legendHidden?.has(names[0])) return HIDDEN_STYLE;
      const spec = item._qml.evaluate(props);
      if (spec) {
        const s = specToStyle(spec);
        if (s) {
          if (isPoint) {
            return { radius: 5, color: s.stroke || "#ffffff", weight: 1,
              fillColor: s.markerColor, fillOpacity: o, opacity: s.stroke ? o : 0.8 * o,
              interactive: true };
          }
          return {
            color: s.stroke || "#2c5ea8", weight: s.strokeWidth ?? 1.5,
            dashArray: s.dash || undefined, dashOffset: undefined,
            lineJoin: s.join || undefined, lineCap: s.cap || undefined,
            fillColor: s.fill || "#3a7bd5", fillOpacity: 0.5 * o,
            opacity: o, fill: true, interactive: true,
          };
        }
      }
    }
    // スタイル未指定地物: simplestyle > default_style: > エンジン既定 の順で解決
    const ds = currentDefaultStyles || {};
    if (isPoint) {
      const s = resolveDefaultPointStyle(props, ds.point, { color: "#2c5ea8", size: 0, opacity: 1 });
      const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      return { radius: s.size ? defaultPointRadius(s.size) : 5,
        color: props.stroke ?? "#ffffff", weight: num(props["stroke-width"]) ?? 1,
        fillColor: s.color, fillOpacity: s.opacity * o,
        opacity: (num(props["stroke-opacity"]) ?? 1) * o, interactive: true };
    }
    if (/Polygon/.test(gt)) {
      const s = resolveDefaultPolygonStyle(props, ds.polygon, ds.line, { fill: "#3a7bd5", fillOpacity: 0.4, stroke: "#2c5ea8", strokeWidth: 1.5, strokeOpacity: 1 });
      return { color: s.stroke, weight: s.strokeWidth, opacity: s.strokeOpacity * o,
        fillColor: s.fill, fillOpacity: s.fillOpacity * o, fill: true, interactive: true };
    }
    const s = resolveDefaultLineStyle(props, ds.line, { color: "#2c5ea8", width: 1.5, opacity: 1 });
    return { color: s.color, weight: s.width, opacity: s.opacity * o, interactive: true };
  };
}

// ---- deck.gl（3dtiles: 行専用・初回利用時にCDNから遅延ロード） ----
// 軽量プレイヤー維持のため 3dtiles を含む .kasc の時だけ読み込む。
// OL 版と同様に deck.Deck を #map 上のオーバーレイキャンバスとして viewState を
// 手動同期する（Leaflet は2Dビューのため真俯瞰の 2.5D 表示。キャンバス単位のため
// 全 Leaflet レイヤより手前に1枚で描かれ、Leaflet レイヤとの相互挿入はしない）
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
let deckCanvas = null;           // オーバーレイ用 canvas 要素（ズームアニメ変形の対象）
const deckDefs = new Map();      // lid("deck-N") → { item, url, opacity, pointSize, order }
// 3D Tiles ドレープ設定（deck.gl TerrainExtension。
// Cesium 版のドレープ対象地形=3D Tiles（drape-terrain-tiles3d・
// basemap-drape-3dtiles・drape-xyz/​geojson-tiles3d）に相当）
const drapeTiles3d = { enabled: true, basemap: true, xyz: true, vector: true, google: false };

// deck が実際に描画している Leaflet ビュー（ズームアニメ中の CSS 変形の基準に使う）
let deckView = { lng: 0, lat: 0, zoom: 0 };

// Leaflet ビュー → deck viewState。Leaflet zoom0=世界256px / deck(Mapbox系)
// zoom0=世界512px なので -1 換算。bearing/pitch は Leaflet 2Dビューに合わせ 0 固定
function deckViewState(center, zoom) {
  const size = map.getSize();
  return {
    width: size.x,
    height: size.y,
    viewState: {
      longitude: center.lng,
      latitude: center.lat,
      zoom: zoom - 1,
      bearing: 0,
      pitch: 0,
    },
  };
}
function syncDeckView() {
  if (!deckInst) return;
  const c = map.getCenter();
  const z = map.getZoom();
  deckView = { lng: c.lng, lat: c.lat, zoom: z };
  deckInst.setProps(deckViewState(c, z));
}

// ズームアニメ中にキャンバスへ掛けた一時変形を解除する
function clearDeckZoomAnim() {
  if (deckCanvas?.style.transform) { deckCanvas.style.transform = ""; deckCanvas.style.transition = ""; }
}

async function ensureDeck() {
  const deck = await loadDeck();
  if (deckInst) return deckInst;
  const canvas = deckCanvas = document.createElement("canvas");
  canvas.id = "deck-canvas";
  // .leaflet-pane(400系・内部に popupPane 700 まで)より手前、コントロール(1000系)より奥
  canvas.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:800;";
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
  syncDeckView();
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

// Leaflet のビュー変化を deck へ反映する。move/resize は実ビュー変化なので viewState を
// 即同期する（ドラッグ・ピンチ・flyTo・慣性パンは move が毎フレーム来るため密着する）。
// zoomanim はホイール/ボタン/ピンチ終端スナップ等の0.25s CSSアニメーション開始時に1度だけ
// 来る。ここで最終ビューへ即座に再描画するとタイル側の変形アニメとズレて deck だけが
// 地面から浮いて見えるため、GridLayer._setZoomTransform と同じ translate+scale を
// キャンバスへ掛けてタイルと一体で変形させる。終了時に来る move で変形を解除して
// 実ビューへ再同期する
map.on("move zoomanim resize", e => {
  if (!deckInst) return;
  if (e.type === "zoomanim" && e.center && e.zoom !== undefined && deckCanvas) {
    // deck の描画ビュー V0(deckView) → アニメ目標 V1(e.center, e.zoom) への
    // コンテナ座標変換: p1 = scale*p0 + scale*origin0 - origin1
    // （origin = project(center, zoom) - size/2。mapPanePos はコンテナ座標では相殺される）
    const scale = map.getZoomScale(e.zoom, deckView.zoom);
    const half = map.getSize().divideBy(2);
    const off = map.project([deckView.lat, deckView.lng], deckView.zoom)
      .multiplyBy(scale)
      .subtract(map.project(e.center, e.zoom))
      .add(half.multiplyBy(1 - scale));
    deckCanvas.style.transition = "transform .25s cubic-bezier(0,0,.25,1)";
    deckCanvas.style.transformOrigin = "0 0";
    L.DomUtil.setTransform(deckCanvas, off, scale);
    return;
  }
  clearDeckZoomAnim();
  syncDeckView();
});

// 非クエリ系ベクターの where= をクライアント評価(shared/where-eval.js)で
// 描画用 GeoJSON へ適用する。item._geojson は常にフルソースを保持し
// (検索・属性一覧は全件対象の方針)、ここでは描画対象だけを絞る。
// クエリ系(gpkg:/duckdb:/sql:)はロード側で絞り込み済みのため対象外
function applyClientWhere(item, source) {
  const where = item?.opts?.where;
  if (!where || !source?.features?.length) return source;
  if (QUERY_TYPES.has(item.type) || item._viewportQuery) return source;
  if (item._whereExpr !== where) {
    item._whereExpr = where;
    try { item._wherePred = compileWhereExpression(where); }
    catch (e) {
      item._wherePred = null;
      console.warn(`${item.title}: where= の式を解釈できません`, e.message);
    }
  }
  if (!item._wherePred) return source;
  const kept = source.features.filter((f, i) => item._wherePred(f, i));
  return kept.length === source.features.length ? source : { ...source, features: kept };
}

// .kasc 1行 → Leaflet レイヤ。戻り値は { layer, styleFn, viewportQuery, zoomRange }
// paneName 指定時は新規 pane を作らずその pane に配置する（ベースマップ用）
async function addKascLayer(item, baseUrl, preloaded, paneName) {
  // 縮尺表示(minScale=/maxScale=) → ズーム範囲。全レイヤ種で zoomRange と
  // 積集合を取り、effectiveVisible/applyEntryVisibility が表示を切り替える
  const _sv = kascScaleZoomRange(item.opts || {}, map.getCenter().lat);
  const itemVisZoom = _sv ? { minzoom: _sv.minZoom ?? -Infinity, maxzoom: _sv.maxZoom ?? Infinity } : null;
  const mergeVisZoom = zr => {
    const m = mergeZoomRange(
      zr ? { minZoom: zr.minzoom, maxZoom: zr.maxzoom } : null, itemVisZoom);
    return m ? { minzoom: m.minZoom ?? -Infinity, maxzoom: m.maxZoom ?? Infinity } : null;
  };
  if (item.type === "3dtiles") {
    // deck.gl Tile3DLayer で描画。deck は Leaflet レイヤではないため地図へは addLayer
    // せず、レイヤー行の表示/不透明度操作を deckDefs へ委譲するスタブを返す
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
      layer: {
        _isDeck: true,
        // 非表示エントリへの初期適用では deckInst 未初期化なら CDN ロード自体を発生させない
        // on=false は縮尺範囲外も含むため zoomHidden として保持する
        setVisible(on) { def.zoomHidden = on === false; if ((def.item.visible !== false && !def.zoomHidden) || deckInst) void syncDeckLayersAsync(); },
        setOpacity(v) { def.opacity = v; syncDeckLayers(); },
      },
      styleFn: null, viewportQuery: false, zoomRange: itemVisZoom, baseOpacity: def.opacity,
    };
  }
  const pane = paneName || newKascPane();
  if (item.type === "image") {
    // ジオリファレンス画像オーバーレイ(現場写真・紙図面)。corners= は外接矩形へ正規化
    const ov = parseImageOverlay(item);
    let env = ov.bbox;
    if (!env && ov.corners) {
      const lons = ov.corners.map(c => c[0]), lats = ov.corners.map(c => c[1]);
      env = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    }
    if (!env) throw new Error("image: bbox= または corners= の指定が必要です");
    const layer = L.imageOverlay(resolveKascUrl(item.url, baseUrl), [[env[1], env[0]], [env[3], env[2]]], {
      pane,
      opacity: Number(item.opts?.opacity ?? 1),
      attribution: layerAttribution(item) || undefined,
    });
    item._env = { west: env[0], south: env[1], east: env[2], north: env[3] };
    return { layer, styleFn: null, viewportQuery: false, zoomRange: itemVisZoom };
  }
  if (VECTOR_TYPES.has(item.type)) {
    const loaded = preloaded || await loadVectorItem(item, baseUrl, getViewBounds());
    // where= は非クエリ系でもクライアント評価で描画側へ適用する
    // (item._geojson はフィルタ前のフルソースを保持)
    const geojson = applyClientWhere(item, loaded.geojson);
    const viewportQuery = !!loaded.viewportQuery;
    if (item.opts?.style) {
      try {
        item._qml = await loadCompiledQml(item.opts.style, baseUrl);
        if (item._qml?.inverted) applyInvertedMaskGeojson(geojson);
      } catch (e) { console.warn("QML 適用失敗:", item.opts.style, e); }
    }
    // opacity=(0-1): レイヤ透過度。スタイル関数のアルファ乗算に引き継ぐ(#58)
    if (item.opts?.opacity !== undefined && item._opacityFactor === undefined) {
      const _o = Number(item.opts.opacity);
      if (Number.isFinite(_o)) item._opacityFactor = _o;
    }
    const styleFn = makeVectorStyleFn(item);
    // cluster=on / heat=on: 点レイヤーのクラスタ表示・ヒートマップ表示。
    // どちらも点地物のみを対象とし、点以外のジオメトリは通常の geoJSON で描画する
    const pointFeatures = geojson.features?.filter(f => /point/i.test(f?.geometry?.type || "")) || [];
    const otherFeatures = (geojson.features || []).filter(f => !/point/i.test(f?.geometry?.type || ""));
    const wantCluster = pointFeatures.length && kascOptOn(item.opts?.cluster);
    const wantHeat = pointFeatures.length && kascOptOn(item.opts?.heat ?? item.opts?.heatmap);
    if (wantCluster || wantHeat) {
      const sub = [];
      if (wantCluster) {
        try {
          await Promise.all([
            loadCssOnce("https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"),
            loadCssOnce("https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css"),
            loadScriptOnce("https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"),
          ]);
          if (L.markerClusterGroup) {
            // KASUGAI の地図は maxZoom 未設定で、markercluster が内部で
            // map.getMaxZoom() を呼んで例外になるため、未設定時のみ仮の上限を置く
            if (map.options.maxZoom == null) map.options.maxZoom = 22;
            const group = L.markerClusterGroup({ pane });
            for (const f of pointFeatures) {
              const [lon, lat] = f.geometry.type === "Point" ? f.geometry.coordinates : f.geometry.coordinates[0];
              group.addLayer(L.circleMarker([lat, lon], { radius: 5, pane }));
            }
            sub.push(group);
          }
        } catch (e) { console.warn("markercluster の読み込みに失敗しました:", e); }
      } else if (wantHeat) {
        try {
          await loadScriptOnce("https://cdn.jsdelivr.net/npm/leaflet.heat@0.2.0/dist/leaflet-heat.js");
          if (L.heatLayer) {
            const pts = pointFeatures.map(f => {
              const c = f.geometry.type === "Point" ? f.geometry.coordinates : f.geometry.coordinates[0];
              return [c[1], c[0], 1];
            });
            sub.push(L.heatLayer(pts, { radius: 25, blur: 15, maxZoom: 17, pane }));
          }
        } catch (e) { console.warn("leaflet.heat の読み込みに失敗しました:", e); }
      }
      // プラグイン未ロード時は通常描画へフォールバック、点以外は常に通常描画
      if (!sub.length || otherFeatures.length) {
        sub.push(L.geoJSON({ type: "FeatureCollection", features: sub.length ? otherFeatures : geojson.features }, {
          pane, style: styleFn,
          pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 5, pane }),
        }));
      }
      const layer = L.layerGroup(sub, { pane });
      const env = geojsonExtent(geojson);
      if (env) item._env = env;
      item._geojson = loaded.geojson;
      syncDeckLayers();
      return { layer, styleFn, viewportQuery, zoomRange: itemVisZoom };
    }
    // QML マーカー canvas → Leaflet Icon のキャッシュ(markerCanvas→dataURL)
    const iconUrlCache = new WeakMap();
    const pointIcon = f => {
      try {
        const spec = item._qml?.evaluate?.(f?.properties || {});
        if (!spec?.markers?.length) return null;
        const cv = markerLayersToCanvas(spec.markers);
        let url = iconUrlCache.get(cv);
        if (!url) { url = cv.toDataURL(); iconUrlCache.set(cv, url); }
        return L.icon({ iconUrl: url, iconSize: [cv.width, cv.height], iconAnchor: [cv.width / 2, cv.height / 2] });
      } catch (_) { return null; }
    };
    const layer = L.geoJSON(geojson, {
      pane,
      style: styleFn,
      pointToLayer: (f, latlng) => {
        const ic = item._qml ? pointIcon(f) : null;
        return ic ? L.marker(latlng, { icon: ic, pane }) : L.circleMarker(latlng, { radius: 5, pane });
      },
      onEachFeature: (f, l) => {
        if (item._qml?.labelFor) { l._kascLabel = { item, feature: f }; syncLeafletLabel(l); }
        l.on("click", e => {
          if (geoTools.isActive()) return; // ツールモード中は頂点拾い優先
          // QGIS ライブ連携: クリック地物を QGIS 側の選択へ逆通知(#62)
          try {
            const fid = f.id ?? f.properties?.id;
            liveNotifySelection({
              layer: item.title || item.url,
              longitude: e.latlng?.lng, latitude: e.latlng?.lat,
              ...(Number.isFinite(Number(fid)) ? { ids: [Number(fid)] } : {}),
            });
          } catch (_) { /* 逆通知失敗は無視 */ }
          // 属性タブ(Cesium 版 attr-panel 相当)を自動で開き、クリックした地物の属性を表示
          window.switchPanelTab?.("attr");
          const entry = layerEntries.find(en => en.item === item);
          renderAttrContent(panel.attrContent, [{
            title: item.title || item.url,
            entries: attrEntriesFromProps(f.properties),
            layerId: entry ? String(layerEntries.indexOf(entry)) : null,
            feature: f,
            flyable: !!f?.geometry,
          }], { onRecordClick: rec => focusFeatureExtent(rec.feature) });
        });
      },
    });
    // パターン塗り(hatch/pointPattern等)を SVG <pattern> で近似する。
    // Leaflet は fillColor のみ対応のため、path の fill 属性を
    // url(#id) へ直接書き換える(setStyle で消えたら再適用)
    const patUrls = new WeakMap();
    const applyPatternFills = () => {
      if (!item._qml) return;
      const renderer = map.getRenderer(layer);
      const svgRoot = renderer?._root || renderer?._container;
      if (!svgRoot) return;
      let defs = svgRoot.querySelector("defs");
      layer.eachLayer(sub => {
        try {
          const f = sub.feature;
          if (!f || !/Polygon/.test(f.geometry?.type || "")) return;
          const spec = item._qml.evaluate(f.properties || {});
          if (!spec?.fillParts?.length) return;
          const { tile } = fillPartsToTile(spec.fillParts);
          if (!tile) return;
          let pid = patUrls.get(tile);
          if (!pid) {
            pid = `kp_${patUrls.size}`;
            if (!defs) { defs = document.createElementNS("http://www.w3.org/2000/svg", "defs"); svgRoot.prepend(defs); }
            const pat = document.createElementNS("http://www.w3.org/2000/svg", "pattern");
            pat.setAttribute("id", pid);
            pat.setAttribute("patternUnits", "userSpaceOnUse");
            pat.setAttribute("width", tile.width); pat.setAttribute("height", tile.height);
            const im = document.createElementNS("http://www.w3.org/2000/svg", "image");
            im.setAttribute("href", tile.toDataURL());
            im.setAttribute("width", tile.width); im.setAttribute("height", tile.height);
            pat.append(im); defs.append(pat);
            patUrls.set(tile, pid);
          }
          const path = sub._path || sub.getElement?.();
          if (path) path.setAttribute("fill", `url(#${pid})`);
          sub._kascPat = pid;
        } catch (_) {}
      });
    };
    layer.on("add", applyPatternFills);
    map.whenReady(() => setTimeout(applyPatternFills, 0));

    let zoomRange = null;
    if (item._qml) {
      const range = compiledScaleToResRange(item._qml);
      if (range) {
        const lat = map.getCenter().lat;
        zoomRange = {
          minzoom: Math.max(0, resToZoom(range.maxRes === Infinity ? 1e9 : range.maxRes, lat)),
          maxzoom: Math.min(24, resToZoom(Math.max(range.minRes, 0.01), lat)),
        };
      }
    }
    const env = geojsonExtent(geojson);
    if (env) item._env = env;
    item._geojson = loaded.geojson;
    syncDeckLayers(); // 読込完了でドレープコピー対象(_geojson)が増えた場合に反映
    return { layer, styleFn, viewportQuery, zoomRange: mergeVisZoom(zoomRange) };
  }
  // ラスタ系（xyz / wms / wmts / base）
  const opts = item.opts || {};
  const url = resolveKascUrl(item.url, baseUrl);
  // .kasc の maxZoom= はタイルソースのネイティブ最大ズーム。そのまま
  // 表示上限(maxZoom)にすると超過ズームでレイヤが消えて真っ白になる
  // ため maxNativeZoom（超過分は最終取得タイルを拡大表示）として解釈
  // する。表示上限自体は 24 まで許す。WMS は任意ズームで再描画できる
  // ので未指定時は上限を設けない
  // ※ undefined を渡すと 1.9.4 の min/max 正規化で maxZoom=NaN になる
  //   (プロトタイプ既定値をundefinedが上書き)ため、未指定キーは省略する
  const nativeMax = Number(opts.maxzoom ?? opts.maximumlevel);
  const common = {
    pane,
    opacity: opts.opacity !== undefined ? Number(opts.opacity) : 1,
    maxZoom: Math.max(24, Number.isFinite(nativeMax) ? nativeMax : 0),
    // 印刷合成でタイルを canvas へ描けるよう CORS 属性を付ける
    // (非対応ソースは画像が読み込めず失敗するため、CORS対応ソース向け)
    crossOrigin: "anonymous",
  };
  const minZ = Number(opts.minzoom ?? opts.minimumlevel);
  if (Number.isFinite(minZ)) common.minZoom = minZ;
  if (Number.isFinite(nativeMax)) common.maxNativeZoom = nativeMax;
  let layer;
  if (item.type === "wms") {
    // Leaflet 組み込みの WMS 対応（BBOX は Leaflet が計算）
    layer = L.tileLayer.wms(url, {
      layers: opts.layers ?? "",
      styles: opts.styles ?? "",
      format: opts.format || "image/png",
      transparent: !/^(false|0|off)$/i.test(String(opts.transparent ?? "true")),
      version: opts.version || "1.1.1",
      tiled: true,
      tileSize: Number(opts.tilesize) || 256,
      ...common,
    });
  } else {
    // wmts: は {z}/{x}/{y} テンプレートへ正規化してタイルレイヤ扱い
    const tileUrl = item.type === "wmts" ? buildWmtsTileTemplate(url, opts) : url;
    layer = L.tileLayer(tileUrl, { tileSize: Number(opts.tilesize) || 256, ...common });
    // ネイティブ最大ズーム不明(or宣言が実際より過大)のソースでは、
    // あるズームのタイル要求が全滅した時点で実データの上限を記憶し、
    // 以降は最終取得成功レベルのタイルを拡大表示する(真っ白化を防ぐ)
    layer.on("load", () => {
      const z = layer._tileZoom;
      if (!z) return;
      const tiles = Object.values(layer._tiles || {}).filter(t => t.coords.z === z);
      if (tiles.length > 0 && tiles.every(t => !t.el.classList.contains("leaflet-tile-loaded"))) {
        layer.options.maxNativeZoom = Math.min(z - 1, layer.options.maxNativeZoom ?? z - 1);
        layer.redraw();
      }
    });
  }
  const baseOpacity = common.opacity;
  return { layer, styleFn: null, viewportQuery: false, zoomRange: itemVisZoom, baseOpacity };
}

// 表示状態 + QML スケール範囲(zoomRange)の両方を見て add/remove を判定する
function effectiveVisible(entry) {
  if (!entry.item.visible) return false;
  if (entry.zoomRange) {
    const z = map.getZoom();
    if (z < entry.zoomRange.minzoom || z > entry.zoomRange.maxzoom) return false;
  }
  return true;
}

function applyEntryVisibility(entry) {
  // 未読込(遅延ロード)エントリは layer が無いのでスキップする
  if (!entry.layer) { updateMapAttribution(); return; }
  const on = effectiveVisible(entry);
  // deck(3dtiles)スタブは Leaflet レイヤではないため専用の同期経路へ回す
  if (entry.layer._isDeck) { entry.layer.setVisible(on); updateMapAttribution(); return; }
  if (on && !map.hasLayer(entry.layer)) map.addLayer(entry.layer);
  else if (!on && map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
  syncDeckLayers(); // ドレープコピーの表示追従（deck 未初期化なら no-op）
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

// 凡例シンボル単位の表示切替: styleFn が _legendHidden を見るため setStyle 再適用で切替
function applyLegendFilter(entry) {
  if (entry.styleFn && entry.layer?.setStyle) entry.layer.setStyle(entry.styleFn);
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
  if (env) map.flyToBounds(envToLatLngBounds(env), { padding: [60, 60], maxZoom: 17 });
  else if (item._center) map.flyTo([item._center[1], item._center[0]], 15);
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
// setStyle で時刻外の地物を HIDDEN_STYLE にする(クラスタ/heat は対象外)。
function refreshKascTime() {
  const specs = [];
  for (const e of layerEntries || []) {
    const spec = kascTimeSpec(e.item);
    if (!spec || !e.layer || typeof e.layer.eachLayer !== "function"
        || typeof e.styleFn !== "function") continue;
    const values = collectTimeValues(e.item._geojson, spec);
    if (!values.length) continue;
    specs.push({
      label: e.item.title, spec, values,
      apply: t => {
        try {
          e.layer.eachLayer(sub => {
            if (typeof sub.setStyle !== "function" || !sub.feature) return;
            const ok = t == null
              || featureInTime(sub.feature.properties, spec, t);
            sub.setStyle(ok ? e.styleFn(sub.feature) : HIDDEN_STYLE);
          });
        } catch (_) {}
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
// 積み順は renderProject で事前割当した paneName(pane zIndex)で保たれる
async function ensureEntryLoaded(entry) {
  if (!entry.deferred || entry._loading) return !entry.failed;
  entry._loading = true;
  entry.pending = true;
  syncRowStatus(entry);
  const seq = renderSeq;
  try {
    const r = await addKascLayer(entry.item, lastBaseUrl, null, entry.paneName);
    if (seq !== renderSeq) return false;
    entry.layer = r.layer;
    entry.styleFn = r.styleFn;
    refreshKascTime();
    entry.zoomRange = r.zoomRange;
    entry.baseOpacity = r.baseOpacity;
    entry.item._viewportQuery = r.viewportQuery;
    entry.deferred = false;
    applyEntryVisibility(entry);
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

// ---- ポータル(portal:/html:/view:/link: 行で構成する開始画面) ----
// renderProject で parseKasc 済みの doc から再構築する(Cesium 版 applyInspector と同規則)
// view: 行の目的別プリセット {name, desc, img, cam, base, layers[], styles{}, wheres{}, line}[]
const inspectorViews = [];
// html: 行のポータル HTML セクション {title, spec, line}[]
const inspectorHtmlSections = [];
// link: 行の外部リンクカード {name, url, desc, img, line}[]
const inspectorLinks = [];
// view:/link: カードの宣言順リスト {kind:"view"|"link", entry}[]
const inspectorPortalCards = [];
// portal: 行の宣言 {enabled, title, open}。null=行なし
let inspectorPortalSpec = null;
// title: 行のパネルタイトル(ポータル見出しのフォールバック)。null=行なし
let inspectorPanelTitle = null;
// 適用中のビュー名と、適用前スナップショット(ビュー解除で復元)
let activeViewName = null;
let viewSnapshot = null;
// 起動時ポータル自動表示の管理(プロジェクト読込ごとに1回)
let portalAutoOpened = false;

// cam: プリセット + bookmark: 行(QGISブックマークXML) → カメラタブ。
// CAM / QGIS-XML の2系統をグループ見出し+それぞれの保存・読込ボタンで区別する
const CAM_GROUPS = [
  { key: "CAM", match: c => !c.bookmark, fileKey: "camsImportCamFile",
    onSave: items => downloadKascCamLines(items) },
  { key: "QGIS-XML", match: c => !!c.bookmark, fileKey: "camsImportFile",
    onSave: items => downloadQgisBookmarksXml(items) },
];
// cam: プリセットボタンと view: 行の cam= 適用で共用のカメラ移動
function flyToCamPreset(cam) {
  const e = cam._extent;
  if (e) map.flyToBounds([[e.south, e.west], [e.north, e.east]], { padding: [40, 40], maxZoom: 20 });
  else { const gc = groundCenterFromCam(cam); map.flyTo([gc.latitude, gc.longitude], heightToViewZoom(gc.latitude, cam.height, mapCanvasH())); }
}
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
      btn.addEventListener("click", () => flyToCamPreset(cam));
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
  // プロジェクト読込ごとの起動時ポータル自動表示を1回に戻す
  portalAutoOpened = false;
  await renderProject(loadedId, baseUrl, text === raw ? doc : parseKasc(text), manifest);
}

// インスペクターの「登録」: 編集済み .kasc テキストを現在プロジェクトの
// baseUrl で再描画する。プロジェクトファイル自体は書き換えない
// QGIS ライブ連携(#62): 更新検出 → 全体再適用(レイヤ単位差分は
// cesium/maplibre が対応。本エンジンは互換ビューとして全適用)
async function liveApplyText(text) {
  const inp = document.querySelector("#inspector-input");
  if (inp) inp.value = text;
  await applyInspectorText(text);
}

async function applyInspectorText(text) {
  const baseUrl = lastBaseUrl || projectsBaseUrl(currentProjectId);
  inspectorInput.value = text;
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
  const c = map.getCenter(), z = map.getZoom();
  await renderProject(currentProjectId, lastBaseUrl, lastDoc);
  map.setView(c, z);
}

async function renderProject(loadedId, baseUrl, doc, manifest) {
  const seq = ++renderSeq;
  lastDoc = doc;
  injectGoogle3dTilesItem(doc);
  clearTimeout(progressHideTimer);
  if (progressEl) progressEl.hidden = true;
  for (const e of layerEntries) if (e.layer && !e.layer._isDeck && map.hasLayer(e.layer)) map.removeLayer(e.layer);
  for (const e of currentBaseEntries) if (map.hasLayer(e.layer)) map.removeLayer(e.layer);
  removeManagedPanes();
  deckDefs.clear();
  syncDeckLayers();
  layerEntries = [];
  panel.layers.innerHTML = "";
  currentProjectId = loadedId;
  applyPanelTitle(doc.title);
  currentDefaultStyles = doc.defaultStyles || null;

  // portal:/view:/html:/link: 行 → ポータル画面状態へ展開
  // (本エンジンは parseKasc の doc を直接使う。カードは view:/link: の宣言順で混ぜる)
  inspectorViews.splice(0, inspectorViews.length, ...(doc.views || []));
  inspectorHtmlSections.splice(0, inspectorHtmlSections.length,
    // shared parseKasc の html: spec は「タイトル | 本体」全体なので、
    // Cesium 版と同じ「本体のみ(タイトルなし1フィールド形式も可)」へ正規化する
    ...(doc.htmlSections || []).map(sec => {
      const value = sec.line ? sec.line.slice(sec.line.indexOf(":") + 1) : String(sec.spec || "");
      const parts = value.split("|").map(p => p.trim());
      return { title: sec.title || "", spec: parts.slice(1).join("|") || parts[0] || "", line: sec.line };
    }));
  inspectorLinks.splice(0, inspectorLinks.length, ...(doc.links || []));
  inspectorPortalSpec = doc.portal || null;
  inspectorPanelTitle = doc.title || null;
  activeViewName = null;
  viewSnapshot = null;
  {
    const cards = [
      ...inspectorViews.map(entry => ({ kind: "view", entry })),
      ...inspectorLinks.map(entry => ({ kind: "link", entry })),
    ];
    const kascText = inspectorInput.value || "";
    const pos = c => {
      const i = c.entry.line ? kascText.indexOf(c.entry.line) : -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    inspectorPortalCards.splice(0, inspectorPortalCards.length,
      ...cards.sort((a, b) => pos(a) - pos(b)));
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

  // 3dtiles: 行は deck.gl で対応するため未対応通知から外し、
  // _idx（.kasc 上の行順）で doc.layers と混ぜてレイヤツリー順を再現する
  // 3dtiles: は deck.gl、fly_geojson: はフライパスとして対応するため未対応通知から外す
  kascFlyPaths.setItems(doc.unsupported);
  const unsupported = doc.unsupported.filter(i => i.type !== "3dtiles" && i.type !== "fly_geojson" && !NON_LAYER_TYPES.has(i.type));

  currentBaseEntries = [];
  const baseEntries = currentBaseEntries;
  for (const item of doc.bases) {
    if (item.mode === "none") continue;
    if (item.mode === "transparent") { document.querySelector("#map").style.background = "transparent"; continue; }
    const r = await addKascLayer(item, baseUrl, null, "kasc-base");
    baseEntries.push({ item, layer: r.layer });
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
      if (i === active) map.addLayer(entry.layer);
      else if (map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    });
    sel.value = active;
    // 初期表示は選択中の1レイヤのみ示す畳み状態で同期するため、
    // sel.value 確定後にリストを描画する
    syncBasemapList(sel);
    sel.onchange = () => {
      baseEntries.forEach((e, i) => {
        if (i === Number(sel.value)) map.addLayer(e.layer);
        else if (map.hasLayer(e.layer)) map.removeLayer(e.layer);
      });
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
    const o = urlViewToCenter(urlView);
    map.setView(o.center, o.zoom);
  } else if (doc.cams.length) {
    const cam = doc.cams[0];
    { const gc = groundCenterFromCam(cam); map.setView([gc.latitude, gc.longitude], heightToViewZoom(gc.latitude, cam.height, mapCanvasH())); }
  } else {
    needExtentFit = true;
  }

  // レイヤ行を先に描画して読込状態を行ごとに表示し、データは取得できた順に
  // 地図へ追加する。専用 pane の zIndex で積み順を再現するため、.kasc 順
  // (先頭=最前面)の末尾から pane を事前割当する(先頭エントリが最大 zIndex)。
  // `| off` のベクター行は表示 ON までデータ取得を遅延する
  const orderedItems = [...doc.layers, ...doc.unsupported.filter(i => i.type !== "fly_geojson" && !NON_LAYER_TYPES.has(i.type))]
    .sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
  const entries = orderedItems.map(item => ({
    item, layer: null, styleFn: null, zoomRange: null, baseOpacity: 1, pending: true,
    unsupported: doc.unsupported.includes(item) && item.type !== "3dtiles",
  }));
  // 3dtiles は Leaflet pane を持たない(deckDefs 管理)ため割当をスキップする
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].item.type !== "3dtiles") entries[i].paneName = newKascPane();
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
  // group: 行の折りたたみ初期状態(#59)。QGIS レイヤーツリーの展開状態を再現
  applyKascGroupStates(doc.groups, expandedLayerGroups);
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
  await Promise.allSettled(entries.map(entry => (async () => {
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
      const r = await addKascLayer(item, baseUrl, null, entry.paneName);
      if (seq !== renderSeq) return;
      entry.layer = r.layer;
      entry.styleFn = r.styleFn;
      refreshKascTime();
      entry.zoomRange = r.zoomRange;
      entry.baseOpacity = r.baseOpacity;
      item._viewportQuery = r.viewportQuery;
      applyEntryVisibility(entry);
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
          if (env) map.fitBounds(envToLatLngBounds(env), { padding: [80, 80], maxZoom: 18 });
        });
        panel.searchResults.append(row);
      }
    }
    if (!count) panel.searchResults.textContent = "該当なし";
  };

  // プロジェクト再描画で除去された管理レイヤー・pane を含め、
  // 共有ストアの状態へ座標ピンレイヤーを再同期する
  coordPins.refresh();

  // ポータル画面へ現在の宣言状態を反映する。
  // portal: 行があり open=manual でなければプロジェクト読込ごとの初回に自動表示する
  // (インスペクタ再適用では portalAutoOpened が立ったままなので再表示しない)
  updatePortalUI();
  if (!portalAutoOpened && inspectorPortalSpec?.enabled && inspectorPortalSpec.open !== "manual") {
    portalAutoOpened = true;
    openPortal();
  }
}

// エントリのデータを現在の表示範囲・条件で再読み込みする。
// player-api の reloadEntryData フックと ⏷ フィルタ編集の共通経路
async function reloadEntryData(entry) {
  const { geojson } = await loadVectorItem(entry.item, lastBaseUrl, getViewBounds());
  entry.item._geojson = geojson;
  const env = geojsonExtent(geojson);
  if (env) entry.item._env = env;
  entry.layer?.clearLayers?.();
  entry.layer?.addData?.(geojson);
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
      entry.layer?.clearLayers?.();
      entry.layer?.addData?.(geojson);
      syncDeckLayers(); // ドレープコピーのデータ更新
      attrWidget.refresh(); // 表示範囲分の行が差し替わった場合に追従
    }).catch(err => console.warn("viewport requery 失敗:", entry.item.title, err));
  }
}

// ---- ツール（計測・標高断面・見通し・緯度経度グリッド・エクスポート）----
const toolOverlay = makeLeafletOverlay(L, map);
const geoTools = initGeoTools2d({
  overlay: toolOverlay,
  graticuleOverlay: { update: fc => toolOverlay.updateGraticule(fc) },
  getBounds: () => {
    const b = map.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  },
  setCursor: c => { map.getContainer().style.cursor = c; },
  setInteractive: on => { try { on ? map.doubleClickZoom.disable() : map.doubleClickZoom.enable(); } catch (_) {} },
  fitBounds: box => { try { map.fitBounds([[box[1], box[0]], [box[3], box[2]]], { padding: [30, 30] }); } catch (_) {} },
  getOrderedLayerItems: () => layerEntries.map((e, i) => (e.item.id ||= String(i), e.item)),
  isVectorLayerItem: item => !!item && VECTOR_TYPES.has(item.type),
  isQueryLayerItem: item => !!item && (item._viewportQuery || isViewportQueryItem(item)),
  getLayerGeoJson: id => layerEntries.find(e => e.item.id === id)?.item._geojson || null,
});

// ミニマップ（表示>一般トグル。範囲矩形+クリック移動）
const minimap = createMinimap({
  container: "#minimap",
  checkbox: "#display-minimap",
  tileUrl: () => currentBaseEntries[Number(panel.basemapSelect?.value ?? 0)]?.item?.url || "",
  getBounds: () => {
    const b = map.getBounds();
    return [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]];
  },
  flyTo: ({ lng, lat }) => map.flyTo([lat, lng], map.getZoom()),
});
map.on("move", minimap.scheduleUpdate);

// 表示範囲の移動に追従して URL 反映 + 再クエリする
let requeryTimer = null;
map.on("moveend", () => {
  // 初期URLを読み取る前の初回moveendでパーマリンクを上書きしないよう消費済みを待つ
  if (urlViewConsumed) writeUrlView(mapViewToUrl(), lastKascUrl ? undefined : currentProjectId);
  // QGIS ライブ連携: カメラ停止で QGIS キャンバスへ逆通知(#62)
  liveNotifyCamera();
  minimap.scheduleUpdate();
  geoTools.scheduleGraticule();
  const targets = layerEntries.filter(e => e.item._viewportQuery && e.item.visible !== false);
  // bbox=auto / :bbox の初回読込に失敗したレイヤーは、移動後の表示範囲で自動リトライする
  const retry = layerEntries.filter(e => e.item.visible !== false && e.failed && !e.pending && !e._loading && isViewportQueryItem(e.item));
  if (!targets.length && !retry.length) return;
  clearTimeout(requeryTimer);
  requeryTimer = setTimeout(() => {
    if (targets.length) requeryViewportLayers(targets);
    for (const entry of retry) {
      entry.deferred = true;
      entry.failed = false;
      void ensureEntryLoaded(entry);
    }
  }, 400);
});

// ツールモード: ダブルクリック確定とラバーバンドプレビュー
map.on("dblclick", () => { geoTools.handleDoubleClick(); });
map.on("mousemove", e => { geoTools.handleMouseMove(e.latlng); });

// 3D Tiles ドレープ品質: ズーム確定で terrain カバー FBO を現在解像度へ作り直す
map.on("zoomend", () => invalidateDeckTerrainCovers(deckInst));

// QML スケール範囲(zoomRange)を持つレイヤーはズームに応じて出し分ける
map.on("zoomend", () => {
  for (const e of layerEntries) if (e.zoomRange) applyEntryVisibility(e);
});

// 地図クリック → deck(3dtiles)を pick して属性タブ表示。
// ベクター地物(Leaflet interactive path)由来のクリックは地物側ハンドラで
// 属性タブを更新済みのため、二重表示・クリアをしない。
// (map の click には propagatedFrom が乗らないため DOM ターゲットで判定)
map.on("click", e => {
  // 計測・断面・見通しツールのモードがアクティブなら頂点拾いに使う
  if (geoTools.handleClick(e.latlng)) return;
  const target = e.originalEvent?.target;
  if (target && target.closest && target.closest(".leaflet-interactive")) return;
  window.switchPanelTab?.("attr");
  if (!deckInst) { renderAttrContent(panel.attrContent, []); return; }
  try {
    const p = e.containerPoint;
    const info = deckInst.pickObject({ x: p.x, y: p.y, radius: 5 });
    const props = info?.object?.properties;
    if (props) {
      const def = deckDefs.get(info?.layer?.id);
      renderAttrContent(panel.attrContent, [{ title: def?.item?.title, entries: attrEntriesFromProps(props) }]);
    } else {
      renderAttrContent(panel.attrContent, []);
    }
  } catch (_) {}
});

loadProject().catch(err => {
  panel.unsupported.textContent = String(err.message || err);
});

// ?follow[=<base>] → geo_webview の /live/state をポーリングして表示を追従
// (shared/live.js の live セッションへ統合。Leaflet は回転を持たないため無視)
configureFollow({
  apply: s => {
    const opt = {};
    if (typeof s.lon === "number" && typeof s.lat === "number") opt.center = [s.lat, s.lon];
    if (typeof s.zoom === "number") opt.zoom = s.zoom;
    if (opt.center || opt.zoom) map.setView(opt.center || map.getCenter(), opt.zoom ?? map.getZoom());
  },
});

// QGIS 側選択 → 地物ハイライト(#62 双方向)
let qgisSelGroup = null;
function qgisSelFeatureId(f) {
  return f?.id ?? f?.properties?.id ?? f?.properties?.fid ?? f?.properties?.FID;
}
function applyQgisSelection(sel) {
  try {
    if (!qgisSelGroup) qgisSelGroup = L.layerGroup().addTo(map);
    qgisSelGroup.clearLayers();
    const specs = Array.isArray(sel?.layers) ? sel.layers
      : (sel?.layer || Array.isArray(sel?.ids) ? [sel] : []);
    const features = [...(Array.isArray(sel?.features) ? sel.features : [])];
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
    if (!features.length) return;
    L.geoJSON({ type: "FeatureCollection", features }, {
      interactive: false,
      style: { color: "#ffff00", weight: 3, fillColor: "#ffff00", fillOpacity: 0.28 },
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 7, color: "#111", weight: 1.5, fillColor: "#ffff00", fillOpacity: 1 }),
    }).addTo(qgisSelGroup);
  } catch (_) { /* ハイライト失敗は無視 */ }
}

// ベースマップコントロールの最小化トグル
document.querySelector("#basemap-toggle").addEventListener("click", e => {
  const ctl = document.querySelector("#basemap-ctl");
  const collapsed = ctl.classList.toggle("collapsed");
  e.currentTarget.textContent = collapsed ? "+" : "−";
  e.currentTarget.setAttribute("aria-label", collapsed ? "展開" : "最小化");
});

// ナビゲーションツールバー（OpenLayers/Cesium 版と同型の右上配置。
// Leaflet は地図回転を持たないためコンパスは出さず ⌂ 全体表示と最小化のみ）
{
  document.querySelector("#nav-home")?.addEventListener("click", () => {
    // データ範囲が取れない場合は初期ビュー（東京駅付近）へ戻す
    if (!fitDataExtent({ animate: true })) map.flyTo([35.681, 139.767], 10);
  });
  document.querySelector("#navigation-toggle")?.addEventListener("click", e => {
    const bar = e.currentTarget.closest(".navigation-toolbar");
    const collapsed = bar.classList.toggle("collapsed");
    e.currentTarget.textContent = collapsed ? "+" : "−";
    e.currentTarget.setAttribute("aria-label", collapsed ? "展開" : "最小化");
  });
}

// 🌐 ボタン: 現在の表示位置を Google Earth (Web) で開く。
// distance は実ビューポート高 + 垂直FOV60° 換算のカメラ距離
// (Google Earth は d=視線距離なので、メルカトル m/px から実寸変換する)。
// Leaflet は回転・傾斜を持たないため heading/tilt は 0 固定
function openGoogleEarth() {
  try {
    const c = map.getCenter();
    const vh = map.getSize().y;
    const distance = Math.max(50, zoomToCamHeightView(c.lat, map.getZoom(), vh));
    const url = `https://earth.google.com/web/@${c.lat.toFixed(6)},${c.lng.toFixed(6)},0a,${distance.toFixed(2)}d,35y,0h,0t,0r`;
    window.open(url, "_blank", "noopener");
  } catch (e) { console.error("Google Earth 連携エラー:", e); }
}
document.querySelector("#basemap-globe").addEventListener("click", openGoogleEarth);

// 表示タブ: ベースマップ透過度・レイヤー透過度・スケールバー・座標・ポップアップ
// （Leaflet は地図回転を持たないため回転・北固定の設定は設けない）
{
  const opacity = document.querySelector("#display-opacity");
  opacity?.addEventListener("input", () => {
    const active = Number(panel.basemapSelect?.value ?? 0);
    const base = currentBaseEntries[active];
    base?.layer?.setOpacity?.(Number(opacity.value));
  });

  const layerOpacity = document.querySelector("#display-layer-opacity");
  layerOpacity?.addEventListener("input", () => {
    const v = Number(layerOpacity.value);
    for (const e of layerEntries) {
      e.item._opacityFactor = v;
      if (e.styleFn && e.layer?.setStyle) e.layer.setStyle(e.styleFn);
      else e.layer?.setOpacity?.((e.baseOpacity ?? 1) * v);
    }
  });

  const scaleCtl = L.control.scale({ imperial: false });
  scaleCtl.addTo(map);
  document.querySelector("#display-scalebar")?.addEventListener("change", e => {
    if (e.target.checked) scaleCtl.addTo(map);
    else scaleCtl.remove();
  });

  const coordsEl = document.querySelector("#map-coords");
  map.on("mousemove", e => {
    if (!coordsEl || !document.querySelector("#display-coords")?.checked) return;
    coordsEl.textContent = formatLatLng(e.latlng.lat, e.latlng.lng);
  });
  installLocalCrsUI({
    anchor: document.querySelector("#coords-datum"),
    pickLatLng: cb => map.once("click", e => cb(e.latlng)),
  });
  document.querySelector("#display-coords")?.addEventListener("change", e => {
    if (coordsEl) coordsEl.style.display = e.target.checked ? "" : "none";
  });

  // 一般設定を既定値へ戻す
  document.querySelector("#display-general-reset")?.addEventListener("click", () => {
    const setV = (sel, v, ev) => { const el = document.querySelector(sel); if (el && el.value !== String(v)) { el.value = String(v); el.dispatchEvent(new Event(ev, { bubbles: true })); } };
    const setC = (sel, on) => { const el = document.querySelector(sel); if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event("change", { bubbles: true })); } };
    setV("#display-opacity", 1, "input");
    setV("#display-layer-opacity", 1, "input");
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
      if (e.layer && !e.layer._isDeck && map.hasLayer(e.layer)) map.removeLayer(e.layer);
      e.layer = null;
      if (item.visible !== false && !e.unsupported) {
        const r = await addKascLayer(item, lastBaseUrl, item._preloaded, e.paneName);
        e.layer = r.layer; e.styleFn = r.styleFn; e.zoomRange = r.zoomRange;
        e.baseOpacity = r.baseOpacity; item._viewportQuery = r.viewportQuery;
        applyEntryVisibility(e);
        refreshKascTime();
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

// レイヤーに対応するビュー側指定(styles/wheres マップ。フルパス→葉名の順で照合)
function viewSpecFor(view, mapName, item) {
  const map = view?.[mapName] || {};
  const key = normKascTitle(item.title || "");
  return map[key] ?? map[key.split("/").pop()];
}

// ビューのメンバレイヤーか( `*` は全レイヤー)。where/style 適用対象の判定に使う
function viewHasLayer(view, item, show) {
  if (show == null) return true;
  return kascTitleInTheme(item.title, show);
}

// ビュー適用前の状態を記録する。ビュー解除でこの状態へ戻す。
// ;style= の復元は applyKascThemeStyles の _themeBaseStyle 機構が担うため
// ここでは表示・フィルタ・カメラ・ベースマップのみ保持する
function captureViewSnapshot() {
  const items = new Map();
  for (const e of layerEntries) {
    items.set(e.item, {
      visible: e.item.visible !== false,
      where: e.item.opts?.where,
    });
  }
  const c = map.getCenter();
  return {
    items,
    camera: { lat: c.lat, lng: c.lng, zoom: map.getZoom() },
    baseIndex: Number.isFinite(Number(panel.basemapSelect?.value)) ? Number(panel.basemapSelect.value) : null,
  };
}

// item.opts.where の変更をインスペクター行へ書き戻す(editEntryQueryFilter と同規則)。
// item.line がテーマ/ビュー適用の書き戻しで変化している場合はタイトル照合へ
// フォールバックし、現在の行を基準に where= だけを書き換える
function rewriteInspectorWhereLine(item, where) {
  const lines = (inspectorInput.value || "").split(/\r?\n/);
  let idx = item.line ? lines.findIndex(l => l.trim() === item.line) : -1;
  if (idx < 0) {
    const want = normKascTitle(item.title || "");
    idx = lines.findIndex(l => {
      const t = l.trim();
      const sep = t.indexOf(":");
      if (sep < 0) return false;
      const title = t.slice(sep + 1).split("|")[0].trim();
      return title && normKascTitle(title) === want;
    });
  }
  if (idx < 0) return;
  const cur = lines[idx].trim();
  // where= は行の最終オプション(値は行末まで=式中の | も値)。先に | で分割した
  // フィールドから where= 以降を値として取り出し、off 等のフラグは where= の
  // 手前へ置く(where= より後ろのトークンは式の一部として扱われる)
  const fields = cur.split("|").map(f => f.trim());
  const wIdx = fields.findIndex((f, i) => i > 0 && /^where\s*=/i.test(f));
  if (wIdx >= 0) fields.splice(wIdx);
  const tailBool = /^(on|off|true|false)$/i.test(fields.at(-1) || "") ? fields.pop() : null;
  const rest = fields;
  if (tailBool) rest.push(tailBool);
  if (where !== null && where !== undefined && where !== "") rest.push(`where=${where}`);
  const newLine = rest.join(" | ");
  if (newLine === cur) return;
  lines[idx] = newLine;
  inspectorInput.value = lines.join("\n");
  item.line = newLine;
}

// where= 変更を地図へ反映する。クエリ系(gpkg:/duckdb:/sql:)はロード側の
// フィルタ経路で再取得し、全件保持の非クエリ系(geojson: 等)は
// クライアント評価フィルタで描画データを作り直す
async function applyEntryWhereChange(entry) {
  const item = entry.item;
  // 未読込(遅延ロード)は表示 ON 時の addKascLayer で opts.where が効く
  if (entry.deferred || !entry.layer) return;
  const query = QUERY_TYPES.has(item.type) || item._viewportQuery || isViewportQueryItem(item);
  if (query && entry.layer?.addData && entry.layer?.clearLayers) {
    await reloadEntryData(entry);
    attrWidget.refresh();
    return;
  }
  if (!query && !item._qml && entry.layer?.addData && entry.layer?.clearLayers) {
    entry.layer.clearLayers();
    const fc = applyClientWhere(item, item._geojson);
    if (fc?.features?.length) entry.layer.addData(fc);
    syncDeckLayers();
    return;
  }
  // addData 非対応の構造(cluster/heat の L.layerGroup 等)は pane 維持で再構築。
  // 非クエリ系は保持済みの全ソースを preloaded として渡し再取得を避ける
  if (entry.layer && !entry.layer._isDeck && map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
  entry.layer = null;
  const preloaded = !query && item._geojson ? { geojson: item._geojson } : (item._preloaded || null);
  const r = await addKascLayer(item, lastBaseUrl, preloaded, entry.paneName);
  entry.layer = r.layer;
  entry.styleFn = r.styleFn;
  entry.zoomRange = r.zoomRange;
  entry.baseOpacity = r.baseOpacity;
  item._viewportQuery = r.viewportQuery;
  applyEntryVisibility(entry);
  refreshKascTime();
}

// ベースマップ番号の適用(ビューの base= と解除時の復元で共用)。
// 既存のセレクト変更ハンドラ経由で切り替える(リスト UI ・ドレープ・出典も追従)
function applyBaseIndex(idx) {
  const sel = panel.basemapSelect;
  if (!sel || !currentBaseEntries.length || idx == null) return;
  if (Number(sel.value) !== idx) {
    sel.value = String(idx);
    sel.dispatchEvent(new Event("change"));
  }
}

// ビューの base= 指定: ベースマップセレクトのタイトル/葉名で照合して切替。
// none/off 系は全ベースマップを外す
function applyViewBase(name) {
  const sel = panel.basemapSelect;
  const nm = String(name || "").trim();
  if (!sel || !currentBaseEntries.length) return;
  if (/^(none|off|なし|ベースマップなし)$/i.test(nm)) {
    currentBaseEntries.forEach(e => { if (map.hasLayer(e.layer)) map.removeLayer(e.layer); });
    updateMapAttribution();
    return;
  }
  const idx = currentBaseEntries.findIndex(e => {
    const t = normKascTitle(e.item.title || "");
    return t === nm || t.split("/").pop() === nm;
  });
  if (idx < 0) { console.warn("view: base= のベースマップが見つかりません", nm); return; }
  applyBaseIndex(idx);
}

// ビュー適用: 表示+フィルタを反映し、スタイル差替・背景・カメラを後続適用する。
// 初回適用時はスナップショットを取る(Cesium 版 applyKascView と同規則)
async function applyKascView(view) {
  if (!view) return;
  if (!viewSnapshot) viewSnapshot = captureViewSnapshot();
  activeViewName = view.name || null;
  const show = themeShowSet(view); // null = `*` 全表示
  // ;where= を先に item.opts へ反映しておき、遅延読込を含む全描画経路で効かせる。
  // ビューのメンバレイヤーは ;where= がなくてもフィルタ解除まで含めて
  // ビュー指定を正とする(スナップショットで解除時に復元される)。
  // ビュー外のレイヤーのフィルタは触らない
  const whereTargets = [];
  for (const e of layerEntries) {
    const item = e.item;
    if (!VECTOR_TYPES.has(item.type)) continue;
    if (item.type === "sql") {
      // sql: はクエリ本文がフィルタであり、where= フィールドは行構造上書けない
      if (viewHasLayer(view, item, show) && viewSpecFor(view, "wheres", item))
        console.warn(`view:${view.name}: sql: レイヤーへの ;where= は未対応です`, item.title);
      continue;
    }
    if (!viewHasLayer(view, item, show)) continue;
    const where = viewSpecFor(view, "wheres", item) || undefined;
    if ((item.opts?.where || undefined) === where) continue;
    item.opts ||= {};
    item.opts.where = where;
    rewriteInspectorWhereLine(item, where);
    whereTargets.push(e);
  }
  // 表示＋未読込レイヤの遅延ロード(テーマ適用と同じ機構)
  for (const e of layerEntries) {
    e.item.visible = show == null || kascTitleInTheme(e.item.title, show);
    applyEntryVisibility(e);
    maybeLoadEntry(e);
  }
  renderLayerRows(layerEntries, currentUnsupported);
  // インスペクターの .kasc テキストにも on/off を書き戻して整合を保つ
  inspectorInput.value = rewriteKascVisibility(inspectorInput.value, show);
  // 読込済みエントリのフィルタ反映
  for (const e of whereTargets) await applyEntryWhereChange(e);
  // 背景地図(base=): タイトル/葉名で照合してベースマップセレクトを切替
  if (view.base) applyViewBase(view.base);
  // ;style= 指定レイヤーの .qml 差替(テーマと同じ機構)
  void applyKascThemeStyles(view);
  // cam= 指定カメラプリセットへ移動
  if (view.cam) {
    const cam = currentCams.find(c => (c.name || "") === view.cam);
    if (cam) flyToCamPreset(cam);
    else console.warn(`view:${view.name}: cam= のカメラプリセットが見つかりません`, view.cam);
  }
  // QGIS ライブ連携: ビュー適用を QGIS プロジェクトへ書き戻す
  liveWritebackEntries(layerEntries, { theme: view?.name });
  updatePortalButton();
}

// ビュー解除: 適用前スナップショットへ復元する
async function clearKascView() {
  const snap = viewSnapshot;
  activeViewName = null;
  viewSnapshot = null;
  if (!snap) { updatePortalButton(); return; }
  const whereTargets = [];
  for (const e of layerEntries) {
    const s = snap.items.get(e.item);
    if (!s) continue;
    e.item.visible = s.visible;
    const where = s.where ?? undefined;
    if (e.item.type !== "sql" && (e.item.opts?.where || undefined) !== where) {
      e.item.opts ||= {};
      e.item.opts.where = where;
      whereTargets.push(e);
    }
  }
  for (const e of layerEntries) {
    applyEntryVisibility(e);
    maybeLoadEntry(e);
  }
  // 表示状態を行へ戻す。復元後の可視レイヤータイトルをセットにして書き戻す
  const showSet = new Set();
  for (const e of layerEntries) if (e.item.visible !== false) {
    const n = normKascTitle(e.item.title || "");
    showSet.add(n);
    showSet.add(n.split("/").pop());
  }
  inspectorInput.value = rewriteKascVisibility(inspectorInput.value, showSet);
  for (const e of whereTargets) {
    rewriteInspectorWhereLine(e.item, e.item.opts?.where ?? null);
    await applyEntryWhereChange(e);
  }
  renderLayerRows(layerEntries, currentUnsupported);
  if (snap.baseIndex != null) applyBaseIndex(snap.baseIndex);
  // テーマ/ビュー差替スタイルを元の style= 指定へ戻す
  void applyKascThemeStyles({ styles: {} });
  if (snap.camera && Number.isFinite(snap.camera.lat)) map.flyTo([snap.camera.lat, snap.camera.lng], snap.camera.zoom);
  liveWritebackEntries(layerEntries);
  updatePortalButton();
}

// ---- ポータル画面の共有UI(shared/portal.js)へのエンジン側バインド ----

let _kascPortal = null;
function kascPortal() {
  if (!_kascPortal) {
    _kascPortal = createKascPortal({
      t,
      resolveProjectUrl: u => resolveKascUrl(u, lastBaseUrl),
      loadInfoContent: (el, spec, _unused, err) => loadKascInfoContent(el, spec, lastBaseUrl, err),
      applyView: view => applyKascView(view),
      clearView: () => clearKascView(),
      applyCam: name => {
        const cam = currentCams.find(c => (c.name || "") === name || c.title === name);
        if (cam) flyToCamPreset(cam);
        else console.warn("data-cam: カメラプリセットが見つかりません", name);
      },
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

// 🏠ボタンで開始画面を開く / 「地図を開く」・Esc で閉じる / 「ビュー解除」で復元
kascPortal().bindEvents();

// i18n(ポータル文言と静的DOMの data-i18n 属性)。切替時はポータルを再描画する
void initI18n().then(() => { applyI18n(); updatePortalUI(); });
window.addEventListener("kasugai:language-changed", () => updatePortalUI());

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
let apiPaneSeq = 0;
window.kasugaiApi = createPlayerApi({
  engine: "leaflet",
  getEntries: () => layerEntries,
  getBaseEntries: () => currentBaseEntries,
  getProjectId: () => currentProjectId,
  getBaseUrl: () => lastBaseUrl,
  loadProject,
  applyInspectorText,
  liveSync: async args => liveUpdate(args),
  getInspectorText: () => inspectorInput.value,
  setInspectorText: v => { inspectorInput.value = v; },
  applyEntryVisibility, focusEntry, maybeLoadEntry,
  applyLegendFilter: entry => applyEntryVisibility(entry),
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
    const center = [Number(v.latitude), Number(v.longitude)];
    const zoom = Number.isFinite(v.zoom) ? v.zoom : heightToViewZoom(v.latitude, v.height, mapCanvasH());
    // instant=フライパス巡回等の高頻度更新。flyTo の逐次再起動を避け即時配置する
    if (v.instant) map.setView(center, zoom, { animate: false });
    else map.flyTo(center, zoom);
  },
  getViewInfo: () => {
    const c = map.getCenter();
    return { latitude: c.lat, longitude: c.lng, zoom: map.getZoom(), heading: 0, pitchDeg: 0 };
  },
  viewToUrl: () => mapViewToUrl(),
  fitBoundsView: (w, s, e, n) => map.fitBounds([[s, w], [n, e]], { padding: [50, 50], maxZoom: 17 }),
  mountEntry: async (entry, preloaded) => {
    entry.paneName ||= `kasc-pane-api-${++apiPaneSeq}`;
    if (!map.getPane(entry.paneName)) {
      map.createPane(entry.paneName);
      map.getPane(entry.paneName).style.zIndex = 650;
    }
    const r = await addKascLayer(entry.item, lastBaseUrl, preloaded || entry.item._preloaded, entry.paneName);
    entry.layer = r.layer; entry.styleFn = r.styleFn; entry.zoomRange = r.zoomRange;
    refreshKascTime();
    entry.baseOpacity = r.baseOpacity; entry.item._viewportQuery = r.viewportQuery;
    applyEntryVisibility(entry);
    updateMapAttribution();
  },
  unmountEntry: entry => {
    if (entry.layer && !entry.layer._isDeck && map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    updateMapAttribution();
  },
  reloadEntryData,
  getEntryGeoJson: entry => entry.item._geojson || null,
  geoTools: () => geoTools,
  setBaseEntryVisible: (entry, on) => {
    if (entry.layer && !entry.layer._isDeck) {
      if (on && !map.hasLayer(entry.layer)) map.addLayer(entry.layer);
      else if (!on && map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    }
    updateMapAttribution();
  },
  getFlyPaths: kascFlyPaths.getFlyPaths,
  persistFlyPath: kascFlyPaths.persistFlyPath,
  syncFlyPathLine: kascFlyPaths.syncFlyPathLine,
});
// view: 行の目的別プリセット一覧/適用/解除とポータル画面の開閉(Cesium 版と同じAPI面)
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
  async clearView() { await clearKascView(); return true; },
  openPortal() { openPortal(); return portalAvailable(); },
  closePortal() { closePortal(); return true; },
});
mountEngineSwitcher(document.querySelector("#engines"), "leaflet");
// カレント状態ファイル(Cesium規約)へ現在値を反映する(変化イベント駆動)
bindSessionState("leaflet");
void initAiChat({ engine: "leaflet", manageBackend: true });

// 印刷: Leaflet は DOM 描画のためタイルimg・SVGオーバーレイ・マーカーを
// 表示位置で合成する(CORS非対応タイルがある場合は取得失敗→地図なし帳票)
initPrint({
  button: document.querySelector("#print-open"),
  captureMap: async () => {
    const r = await compositeDomMap(map.getContainer());
    return r ? r.canvas.toDataURL("image/png") : null;
  },
  getScaleDenominator: () => {
    const size = map.getSize();
    const p0 = map.containerPointToLatLng([size.x / 2, size.y / 2]);
    const p1 = map.containerPointToLatLng([size.x / 2 + 64, size.y / 2]);
    const mpp = map.distance(p0, p1) / 64;
    return mpp > 0 ? mpp / 0.00028 : null;
  },
  getNorthAngleDeg: () => 0,
  // 印刷範囲プレビュー用アダプタ
  mapEl: () => map.getContainer(),
  getCenterLonLat: () => { const c = map.getCenter(); return { lon: c.lng, lat: c.lat }; },
  panByPx: (dx, dy) => map.panBy([-dx, -dy], { animate: false }),
  zoomToDenom: (d) => {
    const lat = map.getCenter().lat;
    const z = Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) / (d * 0.00028));
    map.setZoom(z);
  },
  fitExtent: async (w, s, e, n) => { map.fitBounds([[s, w], [n, e]]); },
});

// ---- ナビゲーション共通ツール（shared/nav-tools.js）----
initNavTools({
  el: document.getElementById("map"),
  getView: () => ({ lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() }),
  setView: v => map.setView([v.lat, v.lng], v.zoom, { animate: false }),
  flyTo: (lat, lng) => map.flyTo([lat, lng]),
  fitBounds: (w, s, e, n) => map.flyToBounds([[s, w], [n, e]]),
  onMoveStart: cb => map.on("movestart", cb),
  onMoveEnd: cb => map.on("moveend", cb),
  toLatLng: (x, y) => { const ll = map.containerPointToLatLng([x, y]); return { lat: ll.lat, lng: ll.lng }; },
  setMarker: ll => { initNavTools._mk?.remove(); initNavTools._mk = ll ? L.marker([ll.lat, ll.lng]).addTo(map) : null; },
  nativeBoxZoom: true,
});

// ---- 座標ピン（shared/coord-pins.js の共有 GeoJSON を一般レイヤーとして描画）----
// layerEntries に正規エントリを持つため、レイヤ一覧・属性表示(クリック)・
// 属性検索・属性一覧ウィジェットが通常レイヤーと同じ経路で使える
let pinEntry = null;
function syncCoordPinLayer(fc) {
  // プロジェクト再描画(removeManagedPanes で pane ごと除去)で消えた分を含め、
  // ストアの状態へ収束させる。L.geoJSON グループは同期のたびに作り直す
  if (pinEntry && !layerEntries.includes(pinEntry)) pinEntry = null;
  if (pinEntry?.layer && map.hasLayer(pinEntry.layer)) map.removeLayer(pinEntry.layer);
  if (!fc.features.length) {
    if (pinEntry) {
      const i = layerEntries.indexOf(pinEntry);
      if (i >= 0) layerEntries.splice(i, 1);
      pinEntry = null;
      renderLayerRows(layerEntries, currentUnsupported);
    }
    return;
  }
  if (!pinEntry) {
    pinEntry = { item: { title: "座標ピン", type: "geojson", visible: true }, layer: null, paneName: newKascPane(), pending: false, baseOpacity: 1 };
    layerEntries.unshift(pinEntry);
  }
  const entry = pinEntry;
  entry.item._geojson = fc;
  const env = geojsonExtent(fc);
  if (env) entry.item._env = env;
  entry.layer = L.geoJSON(fc, {
    pane: entry.paneName,
    pointToLayer: (f, ll) => L.circleMarker(ll, {
      radius: 7, pane: entry.paneName,
      color: "#fff", weight: 2,
      fillColor: f.properties?.["marker-color"] || "#e33d3d", fillOpacity: 1,
    }),
    onEachFeature: (f, l) => {
      l.on("click", () => {
        if (geoTools.isActive()) return; // ツールモード中は頂点拾い優先
        // 属性タブ(Cesium 版 attr-panel 相当)へ通常地物と同じ内容を表示する
        window.switchPanelTab?.("attr");
        renderAttrContent(panel.attrContent, [{
          title: entry.item.title,
          entries: attrEntriesFromProps(f.properties),
          layerId: String(layerEntries.indexOf(entry)),
          feature: f,
          flyable: !!f?.geometry,
        }], { onRecordClick: rec => focusFeatureExtent(rec.feature) });
      });
    },
  });
  applyEntryVisibility(entry);
  renderLayerRows(layerEntries, currentUnsupported);
}
coordPins.setRenderer(syncCoordPinLayer);
