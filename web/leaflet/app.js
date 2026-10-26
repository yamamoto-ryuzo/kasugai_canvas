// KASUGAI Canvas — Leaflet フロント
// .kasc プレイヤーモード: projects/<id>/ の .kasc+DATA/ を Leaflet で再生する
import { loadKascProject, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeight, zoomToCamHeightView, parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle, appendGroupedTitleOptions, syncBasemapList, sanitizeAttributionFragment, layerAttribution, buildWmtsTileTemplate, rewriteKascVisibility, themeShowSet, kascTitleInTheme, fillThemeSelect, loadKascBookmarks, parseQgisBookmarksXml, qgisBookmarkToCam, downloadQgisBookmarksXml, downloadKascCamLines } from "../shared/kasc.js";
import { loadVectorItem } from "../shared/vector-load.js";
import { initAiChat, hasBackendFeature } from "../shared/ai-chat.js";
import { createPlayerApi } from "../shared/player-api.js";
import { mountEngineSwitcher, consumeEngineSwitchState } from "../shared/engine-switch.js";

import { groundDeckTileset } from "../shared/deck-ground.js";
import { buildDeckDrapeLayers, invalidateDeckTerrainCovers } from "../shared/deck-drape.js";
import { qmlLegendSwatchDataUrl, specToStyle, loadCompiledQml, compiledScaleToResRange, resToZoom, installLayerVisibilityResolver, qmlLabelElement } from "../shared/qml-2d.js";

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

const map = L.map("map", {
  center: [35.681, 139.767],
  zoom: 10,
  attributionControl: false, // 出典は Cesium 版と同型の右下オーバーレイで表示
});
window.kascMap = map; // デバッグ/外部連携用参照（他エンジンと同じ公開範囲）

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
    if (sub.getTooltip()) sub.setTooltipContent(el);
    else sub.bindTooltip(el, { permanent: true, direction: "center", className: "kasc-label", interactive: false });
  } else if (sub.getTooltip()) {
    sub.unbindTooltip();
  }
}
function refreshQmlLabels() {
  for (const entry of layerEntries) {
    entry.layer?.eachLayer?.(sub => { if (sub._kascLabel) syncLeafletLabel(sub); });
  }
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
function mapViewToUrl() {
  const c = map.getCenter();
  const zoom = map.getZoom();
  return {
    latitude: c.lat,
    longitude: c.lng,
    zoom,
    height: Number.isFinite(zoom) ? zoomToCamHeight(c.lat, zoom) : NaN,
    pitch: -90,
    heading: 0,
  };
}

function urlViewToCenter(v) {
  return {
    center: [v.latitude, v.longitude],
    zoom: Number.isFinite(v.zoom) ? v.zoom : camToZoom(v),
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
            fillColor: s.fill || "#3a7bd5", fillOpacity: 0.5 * o,
            opacity: o, fill: true, interactive: true,
          };
        }
      }
    }
    return isPoint
      ? { radius: 5, color: "#ffffff", weight: 1, fillColor: "#2c5ea8",
          fillOpacity: o, opacity: o, interactive: true }
      : { color: "#2c5ea8", weight: 1.5, fillColor: "#3a7bd5",
          fillOpacity: 0.4 * o, opacity: o, interactive: true };
  };
}

function attrPopupHtml(properties) {
  const html = Object.entries(properties || {}).slice(0, 30)
    .map(([k, v]) => `<b>${k}</b>: ${v}`).join("<br>");
  return html || "(属性なし)";
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
const drapeTiles3d = { enabled: true, basemap: true, xyz: true, vector: true };

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

// .kasc 1行 → Leaflet レイヤ。戻り値は { layer, styleFn, viewportQuery, zoomRange }
// paneName 指定時は新規 pane を作らずその pane に配置する（ベースマップ用）
async function addKascLayer(item, baseUrl, preloaded, paneName) {
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
        setVisible() { if (def.item.visible !== false || deckInst) void syncDeckLayersAsync(); },
        setOpacity(v) { def.opacity = v; syncDeckLayers(); },
      },
      styleFn: null, viewportQuery: false, zoomRange: null, baseOpacity: def.opacity,
    };
  }
  const pane = paneName || newKascPane();
  if (VECTOR_TYPES.has(item.type)) {
    const loaded = preloaded || await loadVectorItem(item, baseUrl, getViewBounds());
    const geojson = loaded.geojson;
    const viewportQuery = !!loaded.viewportQuery;
    if (item.opts?.style) {
      try {
        item._qml = await loadCompiledQml(item.opts.style, baseUrl);
      } catch (e) { console.warn("QML 適用失敗:", item.opts.style, e); }
    }
    const styleFn = makeVectorStyleFn(item);
    const layer = L.geoJSON(geojson, {
      pane,
      style: styleFn,
      pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 5, pane }),
      onEachFeature: (f, l) => {
        if (item._qml?.labelFor) { l._kascLabel = { item, feature: f }; syncLeafletLabel(l); }
        l.on("click", e => {
          if (!popupEnabled) return;
          L.popup({ maxHeight: 240 })
            .setLatLng(e.latlng)
            .setContent(attrPopupHtml(f.properties))
            .openOn(map);
        });
      },
    });
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
    item._geojson = geojson;
    syncDeckLayers(); // 読込完了でドレープコピー対象(_geojson)が増えた場合に反映
    return { layer, styleFn, viewportQuery, zoomRange };
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
  return { layer, styleFn: null, viewportQuery: false, zoomRange: null, baseOpacity };
}

function showAttrTable(entry) {
  const tableBox = panel.attrTable;
  const feats = (entry.item._geojson?.features || []).slice(0, 50);
  const cols = [...new Set(feats.flatMap(f => Object.keys(f.properties || {})))].slice(0, 8);
  if (!cols.length) { tableBox.textContent = "（属性なし）"; return; }
  const rows = feats.map(f =>
    `<tr>${cols.map(c => `<td>${String(f.properties[c] ?? "")}`).join("")}</tr>`
  ).join("");
  tableBox.innerHTML = `<b>${entry.item.title}</b>（先頭${feats.length}件）<table class="attr-table"><tr>${cols.map(c => `<th>${c}`).join("")}</tr>${rows}</table>`;
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
  // deck(3dtiles)スタブは Leaflet レイヤではないため専用の同期経路へ回す
  if (entry.layer._isDeck) { entry.layer.setVisible(); updateMapAttribution(); return; }
  const on = effectiveVisible(entry);
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

const collapsedGroups = new Set();

function renderLayerRows(entries, unsupported) {
  panel.layers.innerHTML = "";
  panel.attrSelect.innerHTML = "";
  const attrEntries = entries.filter(e => e.item._geojson?.features?.length);
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
    entry.zoomRange = r.zoomRange;
    entry.baseOpacity = r.baseOpacity;
    entry.item._viewportQuery = r.viewportQuery;
    entry.deferred = false;
    applyEntryVisibility(entry);
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
        if (e) map.flyToBounds([[e.south, e.west], [e.north, e.east]], { padding: [40, 40], maxZoom: 20 });
        else map.flyTo([cam.latitude, cam.longitude], camToZoom(cam));
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
  for (const e of layerEntries) if (e.layer && !e.layer._isDeck && map.hasLayer(e.layer)) map.removeLayer(e.layer);
  for (const e of currentBaseEntries) if (map.hasLayer(e.layer)) map.removeLayer(e.layer);
  removeManagedPanes();
  deckDefs.clear();
  syncDeckLayers();
  layerEntries = [];
  panel.layers.innerHTML = "";
  currentProjectId = loadedId;

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
  const urlView = urlViewConsumed ? null : parseUrlView();
  urlViewConsumed = true;
  let needExtentFit = false;
  if (hasUrlView(urlView)) {
    const o = urlViewToCenter(urlView);
    map.setView(o.center, o.zoom);
  } else if (doc.cams.length) {
    const cam = doc.cams[0];
    map.setView([cam.latitude, cam.longitude], camToZoom(cam));
  } else {
    needExtentFit = true;
  }

  // レイヤ行を先に描画して読込状態を行ごとに表示し、データは取得できた順に
  // 地図へ追加する。専用 pane の zIndex で積み順を再現するため、.kasc 順
  // (先頭=最前面)の末尾から pane を事前割当する(先頭エントリが最大 zIndex)。
  // `| off` のベクター行は表示 ON までデータ取得を遅延する
  const orderedItems = [...doc.layers, ...doc.unsupported.filter(i => i.type === "3dtiles")]
    .sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
  const entries = orderedItems.map(item => ({
    item, layer: null, styleFn: null, zoomRange: null, baseOpacity: 1, pending: true,
  }));
  // 3dtiles は Leaflet pane を持たない(deckDefs 管理)ため割当をスキップする
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].item.type !== "3dtiles") entries[i].paneName = newKascPane();
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
  await Promise.allSettled(entries.map(entry => (async () => {
    const item = entry.item;
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
      entry.zoomRange = r.zoomRange;
      entry.baseOpacity = r.baseOpacity;
      item._viewportQuery = r.viewportQuery;
      applyEntryVisibility(entry);
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
    let env = null;
    for (const { item } of entries) {
      if (!item._env) continue;
      env = env
        ? [Math.min(env[0], item._env.west), Math.min(env[1], item._env.south), Math.max(env[2], item._env.east), Math.max(env[3], item._env.north)]
        : [item._env.west, item._env.south, item._env.east, item._env.north];
    }
    if (env) map.fitBounds([[env[1], env[0]], [env[3], env[2]]], { padding: [40, 40], maxZoom: 17 });
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
    }).catch(err => console.warn("viewport requery 失敗:", entry.item.title, err));
  }
}

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

// 3D Tiles ドレープ品質: ズーム確定で terrain カバー FBO を現在解像度へ作り直す
map.on("zoomend", () => invalidateDeckTerrainCovers(deckInst));

// QML スケール範囲(zoomRange)を持つレイヤーはズームに応じて出し分ける
map.on("zoomend", () => {
  for (const e of layerEntries) if (e.zoomRange) applyEntryVisibility(e);
});

// 地図クリック → deck(3dtiles)を pick して属性ポップアップ。
// propagatedFrom のあるイベントはベクター地物由来（そちらのポップアップが
// 先に開く）なので、二重表示を避けてこちらは処理しない
map.on("click", e => {
  if (!popupEnabled || !deckInst || e.propagatedFrom) return;
  try {
    const p = e.containerPoint;
    const info = deckInst.pickObject({ x: p.x, y: p.y, radius: 5 });
    const props = info?.object?.properties;
    if (props) {
      L.popup({ maxHeight: 240 }).setLatLng(e.latlng).setContent(attrPopupHtml(props)).openOn(map);
    }
  } catch (_) {}
});

loadProject().catch(err => {
  panel.unsupported.textContent = String(err.message || err);
});

// ?follow[=<base>] → geo_webview の /present/state をポーリングして表示を追従
// （Leaflet は回転を持たないため s.rotation は無視する）
{
  const params = new URLSearchParams(location.search);
  if (params.has("follow") || params.has("present")) {
    const base = params.get("follow") || params.get("present") || "";
    const tick = async () => {
      try {
        const s = await (await fetch(`${base}/present/state`)).json();
        const opt = {};
        if (typeof s.lon === "number" && typeof s.lat === "number") opt.center = [s.lat, s.lon];
        if (typeof s.zoom === "number") opt.zoom = s.zoom;
        if (opt.center || opt.zoom) map.setView(opt.center || map.getCenter(), opt.zoom ?? map.getZoom());
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
    coordsEl.textContent = `${e.latlng.lng.toFixed(5)}, ${e.latlng.lat.toFixed(5)}`;
  });
  document.querySelector("#display-coords")?.addEventListener("change", e => {
    if (coordsEl) coordsEl.style.display = e.target.checked ? "" : "none";
  });

  document.querySelector("#display-popup")?.addEventListener("change", e => {
    popupEnabled = e.target.checked;
    if (!popupEnabled) map.closePopup();
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
let apiPaneSeq = 0;
window.kasugaiApi = createPlayerApi({
  engine: "leaflet",
  getEntries: () => layerEntries,
  getBaseEntries: () => currentBaseEntries,
  getProjectId: () => currentProjectId,
  getBaseUrl: () => lastBaseUrl,
  loadProject,
  applyInspectorText,
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
  flyToView: v => map.flyTo([Number(v.latitude), Number(v.longitude)],
    Number.isFinite(v.zoom) ? v.zoom : camToZoom(v)),
  getViewInfo: () => {
    const c = map.getCenter();
    return { latitude: c.lat, longitude: c.lng, zoom: map.getZoom(), heading: 0, pitchDeg: 0 };
  },
  fitBoundsView: (w, s, e, n) => map.fitBounds([[s, w], [n, e]], { padding: [50, 50], maxZoom: 17 }),
  mountEntry: async (entry, preloaded) => {
    entry.paneName ||= `kasc-pane-api-${++apiPaneSeq}`;
    if (!map.getPane(entry.paneName)) {
      map.createPane(entry.paneName);
      map.getPane(entry.paneName).style.zIndex = 650;
    }
    const r = await addKascLayer(entry.item, lastBaseUrl, preloaded || entry.item._preloaded, entry.paneName);
    entry.layer = r.layer; entry.styleFn = r.styleFn; entry.zoomRange = r.zoomRange;
    entry.baseOpacity = r.baseOpacity; entry.item._viewportQuery = r.viewportQuery;
    applyEntryVisibility(entry);
    updateMapAttribution();
  },
  unmountEntry: entry => {
    if (entry.layer && !entry.layer._isDeck && map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    updateMapAttribution();
  },
  reloadEntryData: async entry => {
    const { geojson } = await loadVectorItem(entry.item, lastBaseUrl, getViewBounds());
    entry.item._geojson = geojson;
    const env = geojsonExtent(geojson);
    if (env) entry.item._env = env;
    entry.layer?.clearLayers?.();
    entry.layer?.addData?.(geojson);
    syncDeckLayers(); // ドレープコピーのデータ更新
  },
  getEntryGeoJson: entry => entry.item._geojson || null,
  setBaseEntryVisible: (entry, on) => {
    if (entry.layer && !entry.layer._isDeck) {
      if (on && !map.hasLayer(entry.layer)) map.addLayer(entry.layer);
      else if (!on && map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    }
    updateMapAttribution();
  },
});
mountEngineSwitcher(document.querySelector("#engines"), "leaflet");
void initAiChat({ engine: "leaflet", manageBackend: true });
