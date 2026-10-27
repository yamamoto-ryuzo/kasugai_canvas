import * as THREE from "three";
import { initI18n, t, applyI18n, setLanguage, getLanguage, SUPPORTED_LANGUAGES, LANGUAGE_NAMES } from "../shared/i18n.js";
import {
  initMcp, listMcpServers, upsertMcpServer, removeMcpServer,
  connectMcpServer, disconnectMcpServer, connectEnabledMcpServers,
  mcpRuntime, mcpDeclarations, callMcpTool,
} from "../shared/mcp.js";
import {
  initBoxAuth, handleBoxRedirect,
} from "../shared/box.js";
import {
  initAiChat, executeChatTool, showReportModal,
  listUiControls as sharedListUiControls, controlUi as sharedControlUi,
  updateChatPanelVisibility, updateBridgeProviderOptions, resyncProviderSelect,
  startRemoteCommandLoop, setBackendCapabilities, isFetchProxyTarget,
} from "../shared/ai-chat.js";
import { loadQmlStyle, compileQmlStyle, setLayerVisibilityResolver, markerLayersToCanvas, fillPartsToTile, rgbaToCss } from "../shared/qml-style.js";
import { applyQmlStyleToDataSource, applyQmlStyleToPrimitive } from "./qml-render.js";
import { wkbToGeoJsonGeometry, sanitizeVectorPropertyValue, quoteSqlIdent, quoteSqlLiteral } from "../shared/vector-decode.js";
import { loadVectorItem } from "../shared/vector-load.js";
import { buildWmsTileTemplate, buildWmtsTileTemplate, rewriteKascLineVisibility, themeShowSet, kascTitleInTheme, fillThemeSelect, loadKascBookmarks, parseQgisBookmarksXml, qgisBookmarkToCam, downloadQgisBookmarksXml, downloadKascCamLines, parseKasc, camToZoomView, zoomToCamHeightView, appendGroupedTitleOptions, syncBasemapList, fetchKascProjectTitle, projectsBaseUrl, PROJECTS_MANIFEST_URL } from "../shared/kasc.js";
import { mountEngineSwitcher, consumeEngineSwitchState } from "../shared/engine-switch.js";

await initI18n();
applyI18n();
mountEngineSwitcher(document.querySelector("#engines"), "cesium");

const Cesium = window.Cesium;

const urlParams = new URLSearchParams(window.location.search);
// カメラ情報はハッシュ(#latitude=...)に置く。ハッシュはアドレスバーで書き換えても
// ページが再読み込みされないため、前のビューからそのままFLYTOできる(Google Earth と同じ挙動)
const initialCameraSource = window.location.search + window.location.hash;
const DEFAULT_VIEW = { latitude: 35.6852, longitude: 139.7528, height: 2000, pitch: -30, heading: 0 };

const viewer = new Cesium.Viewer("cesium-container", {
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  contextOptions: { webgl: { alpha: true } },
  // 「ベースマップ透明」(地表透明+XYZドレープのみ表示)は globe.translucency で
  // baseColor のアルファを効かせる必要があり、その手法は OIT 無効時のみ動作する
  orderIndependentTranslucency: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  vrButton: false,
  infoBox: false,
  selectionIndicator: false,
});

viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.globe.enableLighting = false;
viewer.imageryLayers.removeAll();
viewer.camera.percentageChanged = 0.05;

// 静止時の無駄な再描画をやめる。時刻依存の表示は使っていないため時計も止める
// (shouldAnimate が true のままだとシミュレーション時刻の変化で毎フレーム描画される)
viewer.scene.requestRenderMode = true;
viewer.clock.shouldAnimate = false;
// 開発者ツール・E2E検証からの描画状態確認用(kasugaiApiと同じく内部向けの公開面)
window._viewer = viewer;
const requestRender = () => viewer.scene.requestRender();
// 入力操作起因の変更(CallbackProperty・.show・設定変更等)は自動では描画要求されないため、
// 入力イベントを捕捉して次フレームの描画を要求する。
// requestRender はフラグを立てるだけなので、同じタスク内で行われた変更も描画に間に合う
for (const type of ["click", "dblclick", "contextmenu", "wheel", "keydown", "keyup", "input", "change", "drop", "pointerdown", "pointerup", "pointercancel"]) {
  window.addEventListener(type, requestRender, { capture: true, passive: true });
}
// ルート描画プレビュー等のカーソル追従表示用。pointermove は頻度が高いためキャンバスに限定する
viewer.canvas.addEventListener("pointermove", requestRender, { passive: true });

// リロード直後にデフォルトの地球全体ビューが見えるのを防ぐため、
// 前回のカメラ位置（なければURLの座標）へ描画開始前に同期的に即セットする
let lastCameraSearch = null;
try { lastCameraSearch = sessionStorage.getItem("lastCameraSearch"); } catch (e) {}
const lastCamera = lastCameraSearch ? parseUrlCamera(lastCameraSearch) : null;
const hasLastCamera = !!(lastCamera && Number.isFinite(lastCamera.latitude) && Number.isFinite(lastCamera.longitude));
{
  const startupCamera = hasLastCamera ? lastCamera : parseUrlCamera(initialCameraSource);
  if (Number.isFinite(startupCamera.latitude) && Number.isFinite(startupCamera.longitude)) flyTo(startupCamera, 0);
}

const basemaps = [];
let selectedBasemap = null;
// ベースマップ選択「ベースマップ透明」用: true なら地表色と背景を透明にし、XYZタイルのドレープだけを残す。地形プロバイダ(高さ)は維持される
let globeHidden = false;
// テレイン非表示から復帰した時に元へ戻すため、通常時の地表ベース色を保持する
let globeBaseColor = viewer.scene.globe.baseColor.clone();
const cameraPresets = [];
const layers = [];
const tileLayers = [];
const layerState = new Map();
let layerOrder = [];
const expandedLayerGroups = new Set();
// ?kasc=<url>: 任意URLの .kasc を直接読むモード(サーバレス配信用)。
// DATA/ 等の相対参照は .kasc のある URL 基準で解決する。
// ?project= の標準プロジェクトモードと排他で、プロジェクト選択で解除される
let currentKascUrl = (() => {
  const raw = urlParams.get("kasc");
  if (!raw) return null;
  try { return new URL(raw, window.location.href).href; }
  catch { return null; }
})();
const kascBaseUrl = () => currentKascUrl ? new URL("./", currentKascUrl).href : null;
let currentProjectId = currentKascUrl
  ? (decodeURIComponent(new URL(currentKascUrl).pathname.split("/").pop() || "")
      .replace(/\.kasc$/i, "") || "kasc")
  : (urlParams.get("project") || "default");
let yahooAppId = "";
let terrainEnabled = true;
let undergroundTransparency = 0;
let undergroundDiveEnabled = true;
let undergroundBackgroundColor = Cesium.Color.BLACK;
let basemapDrape3DTiles = false;
// 表示>一般タブ: 透過度スライダ(ベースマップ/レイヤー)の係数と現在のベースマップ ImageryLayer
let basemapOpacityFactor = 1;
let layerOpacityFactor = 1;
let basemapImageryLayer = null;
let infoRequestId = 0;
let walkModeActive = false;
let streetViewPickMode = false;
// Street View カバレッジ表示の状態
let svCoverageDataSource = null;
const svCoverageTiles = new Map(); // "x/y" -> Cesium.Entity[]
let svCoverageRefreshToken = 0;
let svCoverageTimer = null;
let svCoverageListener = null;
let svCoverageAutoOn = false; // 地点拾いモードで自動ONにした場合のみ true（手動ONは維持）
let flyHeight = 20;
let flySpeed = 30;
const flyPaths = [];
let flyPath = null;
let flyPathProperties = {};
let flyPathCoords = null;
let flyPathCumulativeDistances = [];
let flyPathDistance = 0;
let flyPathTargetDistance = null;
let flyPathLinePositions = [];
let flyPathEntity = null;
let flyPathRafId = null;
let flyPathActive = false;
let flyPathProgress = 0;
let flyRafId = null;
let flyLastTime = performance.now();
let drawModeActive = false;
let drawnPoints = [];
let drawnPointHeights = [];
let drawLineEntity = null;
let isDrawing = false;
let lastRightDownTime = 0;
const activeClippingPlanes = { planes: [] };
const uiHooks = {};
const activeDataSources = [];
const vectorDataSources = [];
// 属性値一覧が未ロードレイヤーを選択された際のオンデマンド読み込み結果。
// 使わないデータを起動時に読まないためのキャッシュで、refreshLayers() で破棄する
const vectorAttrLoadCache = new Map();
// 全件読み込み系ベクターレイヤー(geojson:/geoparquet:/flatgeobuf:)のダウンロード＋
// デコード結果キャッシュ。初回に必要となった時点で読み込み、2回目以降の
// refreshLayers(表示切替等)・属性値一覧はメモリの GeoJSON を再利用する。
// クエリ系(duckdb:/sql:)は条件ごとに結果が変わるため対象外。
// キーは id|url で、applyInspector(プロジェクト/インスペクター変更)時に破棄する
const vectorSourceCache = new Map();
// style= で指定された QGIS レイヤースタイル(.qml)の取得・コンパイル結果キャッシュ。
// URL キーで loadQmlStyle の Promise を保持し、applyInspector で破棄する
const qmlStyleCache = new Map();
// QML 式の is_layer_visible('名前') を KASUGAI のレイヤー表示状態に解決する。
// QGIS ではレイヤーツリーのチェック状態を参照するため、ここでは item.visible を返す。
// レイヤー名は QGIS 側のレイヤー名(= .kasc のタイトル末端)と照合し、
// 見つからなければ非表示(false)として扱う(QGIS でレイヤー無しと同じ)
setLayerVisibilityResolver(name => {
  const key = String(name || "").trim();
  if (!key) return false;
  const hit = getOrderedLayerItems().find(item => {
    if (item.title === key || item.id === key) return true;
    const path = (item.group ? `${item.group}/${item.title}` : String(item.title || ""));
    return path.split("/").map(seg => seg.trim()).includes(key);
  });
  return hit ? !!hit.visible : false;
});
// ベクター検索で未ロードレイヤーが選択された際のオンデマンド読み込み結果。
// vectorSourceCache と同じく applyInspector(プロジェクト/インスペクター変更)で破棄する
const vectorSearchLoadedSources = new Map();
// 検索用オンデマンド読み込みに失敗したレイヤー。選択肢変更のたびに再試行しない
const vectorSearchLoadFailed = new Set();
// デコーダーの query 指定でクエリ系レイヤーかを判定する。query は真値
// (常にクエリ系: duckdb:/sql:)または item を受け取る判定関数
// (gpkg:/geopackage: は bbox=auto が既定 ON のため通常はクエリ系。bbox=off 明示時のみ全件読み込み系)
function isQueryDecoder(decoder, item) {
  if (!decoder || !decoder.query) return false;
  return typeof decoder.query === "function" ? !!decoder.query(item) : true;
}
// Cesium.GeoJsonDataSource/GeoJsonPrimitive は crsNames に無い CRS で load を失敗させる。
// 不動産情報ライブラリ API の GeoJSON は crs=urn:ogc:def:crs:EPSG::6668(JGD2011)を付けるため、
// WGS84 と実用同等の地理座標系(4326 系・CRS84・JGD)は crs メンバを剥がして既定として扱う。
// それ以外の投影系は残して load 側のエラーに任せる(黙ってずらさない)
const GEOJSON_WGS84_EQUIV_CRS = /^(urn:ogc:def:crs:)?(OGC:(1\.3:)?CRS84|EPSG::?(4326|4269|4612|6668))$/i;
function normalizeGeoJsonCrs(data) {
  const name = data && data.crs && data.crs.properties && data.crs.properties.name;
  if (name && GEOJSON_WGS84_EQUIV_CRS.test(String(name))) delete data.crs;
  return data;
}
function loadVectorSourceCached(item, decoder) {
  if (isQueryDecoder(decoder, item)) return decoder.load(item);
  if (item.data) return Promise.resolve(item.data);
  const key = `${item.id}|${item.url || ""}`;
  let promise = vectorSourceCache.get(key);
  if (!promise) {
    promise = decoder ? decoder.load(item) : (async () => {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return normalizeGeoJsonCrs(await response.json());
    })();
    promise.catch(() => { if (vectorSourceCache.get(key) === promise) vectorSourceCache.delete(key); });
    vectorSourceCache.set(key, promise);
  }
  return promise;
}
// ベクター entity 描画の合計件数上限(フリーズ防止)。
// 設定 #vector-entity-limit。0・未入力・不正値は無制限
function getVectorEntityLimit() {
  const input = document.querySelector("#vector-entity-limit");
  const value = input ? Number(input.value) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Infinity;
}

// entity 描画前に GeoJSON を残りバジェットの件数まで切り詰める。
// vectorSourceCache の共有オブジェクトを破壊しないよう浅いコピーで返す
function limitGeoJsonFeatures(source, remaining, item) {
  const total = source?.features?.length ?? 0;
  item.entityLimited = null;
  if (!total || total <= remaining) return { source, used: total };
  const shown = Math.max(remaining, 0);
  item.entityLimited = { shown, total };
  console.warn(`${item.title}: ベクター描画件数上限により ${total} 件中 ${shown} 件のみ描画します`);
  return { source: { ...source, features: source.features.slice(0, shown) }, used: shown };
}

// 地物の外接矩形 [west, south, east, north] を返す。null ジオメトリは null。
// 日付変更線またぎは単純な min/max(全域に広がる過大判定=安全側)
function geoJsonFeatureEnvelope(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const walk = coords => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") {
      const lon = coords[0], lat = coords[1] || 0;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    coords.forEach(walk);
  };
  if (geom.type === "GeometryCollection") (geom.geometries || []).forEach(g => walk(g?.coordinates));
  else walk(geom.coordinates);
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

// 地物エンベロープ(envs は Float64Array のフラット配列 [w,s,e,n]×N、NaN=ジオメトリ無し)
// と表示範囲(view.ranges は日付変更線で2分割済み)の交差判定
function envelopeInView(envs, i, view) {
  const s = envs[i * 4 + 1], n = envs[i * 4 + 3];
  if (Number.isNaN(s) || n < view.south || s > view.north) return false;
  const w = envs[i * 4], e = envs[i * 4 + 2];
  return view.ranges.some(r => e >= r.west && w <= r.east);
}

// 地物ごとの外接矩形を item 単位でキャッシュする(ソースが同じなら再計算しない)。
// moveEnd ごとの再スライス判定を O(件数) の矩形比較で済ませるため
function featureEnvelopes(item, source) {
  const cache = item._envCache;
  if (cache && cache.source === source) return cache.envs;
  const envs = new Float64Array(source.features.length * 4).fill(NaN);
  for (let i = 0; i < source.features.length; i++) {
    const e = geoJsonFeatureEnvelope(source.features[i]);
    if (e) envs.set(e, i * 4);
  }
  item._envCache = { source, envs };
  return envs;
}

// 非クエリ系の切り捨て対象レイヤーを「表示範囲内の地物」に絞り込む。
// 全件が範囲内なら元ソースをそのまま返す(コピーを作らない)
function sliceSourceToView(item, source) {
  const view = getViewRanges();
  if (!view || !source?.features?.length) return source;
  const envs = featureEnvelopes(item, source);
  const features = [];
  for (let i = 0; i < source.features.length; i++) {
    if (envelopeInView(envs, i, view)) features.push(source.features[i]);
  }
  return features.length === source.features.length ? source : { ...source, features };
}

// style= の QML 取得に使う fetcher。直接 fetch(CORS 前提)を試し、失敗したら
// ローカルサーバーの /api/fetch 経由にフォールバックする
async function fetchStyleText(url) {
  try {
    const response = await fetch(url, { mode: "cors" });
    if (response.ok) return await response.text();
  } catch (error) { /* CORS 等 → プロキシへ */ }
  if (hasBackendFeature("fetchProxy") && isFetchProxyTarget(url)) {
    const response = await fetch(`${location.origin}/api/fetch?url=${encodeURIComponent(url)}`);
    if (response.ok) return await response.text();
    throw new Error(`HTTP ${response.status}`);
  }
  throw new Error(`スタイルファイルを取得できません: ${url}`);
}
// item.styleUrl の .qml を取得・コンパイルして item.qmlStyle に保持する。
// 失敗時は null(スタイル無しで描画)にフォールバック
async function ensureQmlStyle(item) {
  if (!item.styleUrl) return null;
  if (item.qmlStyle !== undefined) return item.qmlStyle;
  let promise = qmlStyleCache.get(item.styleUrl);
  if (!promise) {
    promise = loadQmlStyle(item.styleUrl, fetchStyleText).catch(error => {
      console.warn(`QML スタイルの読み込みに失敗しました: ${item.styleUrl}`, error);
      return null;
    });
    qmlStyleCache.set(item.styleUrl, promise);
  }
  item.qmlStyle = await promise;
  if (item.qmlStyle?.warnings?.length) {
    console.warn(`QML スタイル ${item.styleUrl}:`, item.qmlStyle.warnings.join(" / "));
  }
  return item.qmlStyle;
}

// ---------------------------------------------------------------------------
// レイヤー一覧の凡例
// ---------------------------------------------------------------------------
// スウォッチ描画結果(dataURL)のキャッシュ。キーは描画指示オブジェクトの JSON
const legendSwatchCache = new Map();
const LEGEND_SWATCH_W = 26;
const LEGEND_SWATCH_H = 16;
// 条件別に分岐する凡例の折りたたみ状態(レイヤーid の Set)。既定は展開
const collapsedLayerLegends = new Set();
// 凡例スウォッチを出しうるレイヤー種別(ベクター系)
const LEGEND_VECTOR_TYPES = new Set(["geojson", "layer", "entities", "geoparquet", "flatgeobuf", "gpkg", "geopackage", "duckdb", "sql"]);

// 描画指示内の canvas/画像をサイズ+src に正規化してキャッシュキーを作る
function legendDescKey(desc) {
  return JSON.stringify(desc, (key, value) => (value instanceof HTMLCanvasElement || value instanceof HTMLImageElement || (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap))
    ? `[img ${value.src || "canvas"} ${value.width}x${value.height}]` : value);
}

// 描画指示 {marker|image|point|line|fill|outline} をスウォッチ dataURL に描く。
// marker/image は元 canvas・画像。line={css,widthPx,dash}、fill={css|tile}、
// outline={css,widthPx,dash}、point={css,sizePx,outlineCss}
function buildLegendSwatchDataUrl(desc) {
  const key = legendDescKey(desc);
  const cached = legendSwatchCache.get(key);
  if (cached) return cached;
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = LEGEND_SWATCH_W * scale;
  canvas.height = LEGEND_SWATCH_H * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  const W = LEGEND_SWATCH_W, H = LEGEND_SWATCH_H;
  const img = desc.marker || desc.image;
  if (img) {
    const ratio = img.height / (img.width || 1) || 1;
    let w = W - 4, h = w * ratio;
    if (h > H - 2) { h = H - 2; w = h / ratio; }
    try { ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h); } catch (error) { /* 未ロード画像等 */ }
  } else if (desc.point) {
    const r = Math.min(Math.max(desc.point.sizePx || 7, 4), H - 4) / 2;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
    ctx.fillStyle = desc.point.css;
    ctx.fill();
    ctx.strokeStyle = desc.point.outlineCss || "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (desc.line) {
    ctx.strokeStyle = desc.line.css;
    ctx.lineWidth = Math.min(Math.max(desc.line.widthPx || 2, 1), 5);
    if (desc.line.dash?.length) ctx.setLineDash(desc.line.dash);
    ctx.beginPath();
    ctx.moveTo(1.5, H / 2);
    ctx.lineTo(W - 1.5, H / 2);
    ctx.stroke();
  } else if (desc.fill || desc.outline) {
    const x = 1.5, y = 2, w = W - 3, h = H - 4;
    if (desc.fill?.tile) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const pattern = ctx.createPattern(desc.fill.tile, "repeat");
      if (pattern) { ctx.fillStyle = pattern; ctx.fillRect(x, y, w, h); }
      ctx.restore();
    } else if (desc.fill?.css) {
      ctx.fillStyle = desc.fill.css;
      ctx.fillRect(x, y, w, h);
    }
    if (desc.outline?.css) {
      ctx.strokeStyle = desc.outline.css;
      ctx.lineWidth = Math.min(Math.max(desc.outline.widthPx || 1, 0.7), 3);
      if (desc.outline.dash?.length) ctx.setLineDash(desc.outline.dash);
      ctx.strokeRect(x, y, w, h);
    } else {
      // 白系・半透明の塗りでも存在が分かるよう薄い輪郭を足す
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 0.7;
      ctx.strokeRect(x, y, w, h);
    }
  }
  const url = canvas.toDataURL();
  if (legendSwatchCache.size >= 300) legendSwatchCache.clear();
  legendSwatchCache.set(key, url);
  return url;
}

// QML コンパイル済みスタイルの legend エントリ spec → スウォッチ描画指示
function legendDescFromQmlSpec(spec) {
  if (!spec) return null;
  if (spec.markers?.length) return { marker: markerLayersToCanvas(spec.markers) };
  if (spec.centroid?.length && !spec.fillParts?.length && !spec.line && !spec.outline) return { marker: markerLayersToCanvas(spec.centroid) };
  if (spec.fillParts?.length || spec.outline) {
    const desc = { outline: spec.outline ? { css: rgbaToCss(spec.outline.color), widthPx: spec.outline.widthPx, dash: spec.outline.dash } : null };
    if (spec.fillParts?.length) {
      const { solidBase, tile } = fillPartsToTile(spec.fillParts);
      desc.fill = tile ? { tile } : solidBase ? { css: rgbaToCss(solidBase) } : null;
    }
    if (desc.fill || desc.outline) return desc;
  }
  if (spec.line) return { line: { css: rgbaToCss(spec.line.color), widthPx: spec.line.widthPx, dash: spec.line.dash } };
  return null;
}

// スタイル未指定ベクターレイヤーの凡例: 描画済み DataSource の先頭の可視 entity から
// 代表スタイルを拾う。未読み込み(非表示等)なら null(凡例なし)
function legendDescFromEntitySample(item) {
  const entry = vectorDataSources.find(e => e.id === item.id);
  const ds = entry?.ds || item.dataSource || null;
  if (!ds) return null;
  const t = Cesium.JulianDate.now();
  const colorOf = material => {
    const value = material?.getValue?.(t);
    return value instanceof Cesium.Color ? value : (value?.color instanceof Cesium.Color ? value.color : null);
  };
  const shown = g => !!g && g.show?.getValue?.(t) !== false;
  for (const entity of ds.entities.values) {
    try {
      if (shown(entity.polygon)) {
        const matValue = entity.polygon.material?.getValue?.(t);
        const fill = colorOf(entity.polygon.material)
          ? { css: colorOf(entity.polygon.material).toCssColorString() }
          : (matValue?.image instanceof HTMLCanvasElement ? { tile: matValue.image } : null);
        const outlineColor = entity.polygon.outline?.getValue?.(t) === true ? entity.polygon.outlineColor?.getValue?.(t) : null;
        return { fill, outline: outlineColor ? { css: outlineColor.toCssColorString(), widthPx: entity.polygon.outlineWidth?.getValue?.(t) || 1 } : null };
      }
      if (shown(entity.polyline)) {
        const color = colorOf(entity.polyline.material);
        return { line: { css: color ? color.toCssColorString() : "#333", widthPx: entity.polyline.width?.getValue?.(t) || 2 } };
      }
      if (shown(entity.billboard)) {
        const image = entity.billboard.image?.getValue?.(t);
        if (image && (image instanceof HTMLCanvasElement || image instanceof HTMLImageElement || (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap))) return { image };
        return { point: { css: "#2b6cb0", sizePx: 8 } };
      }
      if (shown(entity.point)) {
        const color = entity.point.color?.getValue?.(t);
        const outline = entity.point.outlineColor?.getValue?.(t);
        return { point: { css: color ? color.toCssColorString() : "#2b6cb0", sizePx: entity.point.pixelSize?.getValue?.(t) || 8, outlineCss: outline ? outline.toCssColorString() : "" } };
      }
    } catch (error) { /* 取得不能な entity はスキップ */ }
  }
  return null;
}

// レイヤー行の凡例エントリを返す。{entries:[{label,desc,symbolName}]} または null。
// entries>1 なら条件別に分岐表示する。style= 指定レイヤーは .qml 未取得なら
// 読み込みを開始し、解決後に一覧を再描画する
function getLayerLegend(item) {
  if (!item) return null;
  if (item.styleUrl) {
    if (item.qmlStyle === undefined) {
      ensureQmlStyle(item).then(() => { if (layerState.has(item.id)) renderLayerList(); });
      return null;
    }
    const legend = item.qmlStyle?.legend;
    if (legend?.length) {
      return { entries: legend.map(e => ({ label: e.label, symbolName: e.symbolName, desc: e.spec ? legendDescFromQmlSpec(e.spec) : null })) };
    }
  }
  if (LEGEND_VECTOR_TYPES.has(item.type)) {
    const desc = legendDescFromEntitySample(item);
    return desc ? { entries: [{ label: "", desc }] } : null;
  }
  return null;
}

// 凡例の条件別チェックの切り替え。該当シンボルにだけ評価される地物を
// 描画中の DataSource/Primitive へ即時再適用し、未描画なら次回 refreshLayers で反映される
function setLegendSymbolVisible(item, symbolName, visible) {
  if (!item || !symbolName) return;
  if (!item.legendHidden) item.legendHidden = new Set();
  if (visible) item.legendHidden.delete(symbolName);
  else item.legendHidden.add(symbolName);
  if (!item.legendHidden.size) item.legendHidden = null;
  const style = item.qmlStyle;
  if (style) {
    const entry = vectorDataSources.find(e => e.id === item.id);
    if (entry) {
      try { applyQmlStyleToDataSource(entry.ds, style, { clamp: !!item._qmlClamp, hiddenSymbols: item.legendHidden }); }
      catch (error) { console.warn("凡例の再適用に失敗しました:", error); }
    } else {
      const target = layerRuntimeTargets.get(item.id);
      if (Cesium.GeoJsonPrimitive && target instanceof Cesium.GeoJsonPrimitive) {
        try { applyQmlStyleToPrimitive(target, style, item.legendHidden); }
        catch (error) { console.warn("凡例の再適用に失敗しました:", error); }
      }
    }
    requestRender();
  }
  renderLayerList();
}
// レイヤー行の📍フォーカス用: レイヤーID→実行時オブジェクト(ImageryLayer/Tileset/DataSource/Primitive)。
// refreshLayers() のたびに再登録される
const layerRuntimeTargets = new Map();
// IndexedDB "kasugai-canvas": handles(保存先フォルダ) / routes(描画ルート) / plugins(AI生成プラグイン)
function openAppDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kasugai-canvas", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ["handles", "routes", "plugins"]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// AI/ユーザー生成プラグインの保存先。配布物(PLUGIN/・plugins.json)とは分離された
// ブラウザローカルの開発領域。レコードは {id,name,version,description,layer,code,enabled,updatedAt,lastError}
const pluginStore = {
  async list() {
    try {
      const db = await openAppDb();
      return await new Promise(resolve => {
        const query = db.transaction("plugins", "readonly").objectStore("plugins").getAll();
        query.onsuccess = () => resolve(query.result || []);
        query.onerror = () => resolve([]);
      });
    } catch (e) { return []; }
  },
  async get(id) {
    try {
      const db = await openAppDb();
      return await new Promise(resolve => {
        const query = db.transaction("plugins", "readonly").objectStore("plugins").get(id);
        query.onsuccess = () => resolve(query.result ?? null);
        query.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  },
  async put(record) {
    const db = await openAppDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("plugins", "readwrite");
      tx.objectStore("plugins").put(record, record.id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  async remove(id) {
    const db = await openAppDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("plugins", "readwrite");
      tx.objectStore("plugins").delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  async setError(id, message) {
    const record = await this.get(id);
    if (!record) return;
    record.lastError = message || "";
    try { await this.put(record); } catch (e) {}
  },
};

// プラグイン宣言レイヤー(plugins.json の layer 設定由来)。applyInspector で
// layers/layerState/layerOrder がクリアされても再登録されるよう別リストで保持する
const pluginLayers = [];
let pluginLayerSeq = 0;
// AI等が生成したインラインデータの一時レイヤー。inspectorテキストには書き込まず
// (.kascエクスポートに含まれない)、applyInspector 後に末尾へ再登録する
const dataLayers = [];
// インスペクタの plugin: 行で宣言されたプラグイン仕様 {id, options, off}[]。
// applyInspector で再構築し、plugin-loader が inspector-plugins-changed で受けて
// カタログ(plugins.json)/ストレージプラグインのロード・停止を差分管理する
const inspectorPluginSpecs = [];
// インスペクタの theme: 行で宣言された可視性プリセット {name, layers[], line}[]。
// QGIS マップテーマ相当。applyInspector で再構築し #theme-select へ反映する
const inspectorThemes = [];
// インスペクタの bookmark: 行で宣言された QGIS ブックマーク XML 参照
// {title, url}[]。applyInspector で収集し、非同期ロードでカメラプリセットへ展開する
const inspectorBookmarkSpecs = [];
let bookmarkLoadSeq = 0;
let dataLayerSeq = 0;
let vectorSearchData = null;
const activePrimitives = [];
const drapeTerrainSources = { dem: true, tiles3d: false };
// ドレープ対象地形ごとの適用レイヤー種別(DEM と 3D Tiles で個別に選べる)
const drapeLayers = {
  dem: { xyz: true, geojson: true, primitive: false },
  tiles3d: { xyz: true, geojson: true, primitive: false },
};
// レイヤー一覧に件数上限バッジが出ているか(解除時の再描画判定用)
let entityLimitBadgeVisible = false;
const demSources = {
  reearth: {
    title: "Re:Earth Terrain (標高 / elevation, level 14)",
    url: "https://terrain.reearth.land/cesium-mesh/elevation",
  },
  "reearth-ellipsoid": {
    title: "Re:Earth Terrain (楕円体高 / WGS84, level 14)",
    url: "https://terrain.reearth.land/cesium-mesh/ellipsoid",
  },
  gsi5m: {
    title: "地理院 5m+10mメッシュ (DEM5系+10B / 標高TP基準)",
    gsiLayers: ["dem5a_png", "dem5b_png", "dem5c_png", "dem_png"],
  },
  gsi1m: {
    title: "地理院 1mメッシュ (DEM1A / 航空レーザー / 標高TP基準)",
    gsiLayers: ["dem1a_png"],
  },
};
let selectedDemSource = "reearth-ellipsoid";
const DEFAULT_MAXIMUM_LEVEL = 25;

let threeRenderer;
let threeScene;
let threeCamera;
let threeModel;
let backendEnabled = false;
// バックエンドの能力。{tier:"local"|..., features:[...]}。static環境では null のまま
let backendCapabilities = null;
// detectBackend の初回評価が完了したか。capabilities 未確定の間に
// ブリッジ系プロバイダを「無効」と誤判定して自動切替しないためのガード
let backendCapabilitiesResolved = false;
function hasBackendFeature(name) {
  return !!backendCapabilities?.features?.includes(name);
}

// レイヤー行の出典フィールドを解釈する。on/off 等の表示指定や key=value 形式の
// オプション記述(render= / proxy= / attr= 等)が来た場合はオプションとみなし出典にしない
function parseAttributionField(field) {
  const value = String(field || "").trim();
  if (!value || /^(on|off|true|false)$/i.test(value)) return "";
  if (/^[a-z][a-z0-9_]*\s*=/i.test(value)) return "";
  return value;
}

function parseLayerTitle(title) {
  const parts = title.split(/[\\/]/).map(part => part.trim()).filter(Boolean);
  return {
    title: parts.at(-1) || title,
    group: parts.slice(0, -1).join(" / "),
    exclusiveGroup: /[\\/]{2}/.test(title),
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}

// attr 出典フィールドの HTML を許可リストでサニタイズする。
// .kasc の出典には <a>/<img>/装飾タグのみを認め、URLスキームと属性を検証して
// DOM を再構築する。描画時のみ適用し、ファイル上の値(エクスポート等)は変更しない
const ATTRIBUTION_TAGS = new Set(["a", "b", "strong", "i", "em", "u", "sub", "sup", "br", "span", "small", "img"]);
// 中身ごと捨てるタグ(script のコード文字列が出典に漏れないように)
const ATTRIBUTION_DROP_TAGS = new Set(["script", "style", "iframe", "object", "embed", "template"]);

function isSafeAttributionUrl(url) {
  // http(s) またはスキーム無し(相対)のみ。javascript:/data: 等は拒否
  return /^https?:/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

function sanitizeAttributionFragment(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const clean = parent => {
    const fragment = document.createDocumentFragment();
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        fragment.append(document.createTextNode(child.textContent));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (ATTRIBUTION_DROP_TAGS.has(tag)) continue;
        if (!ATTRIBUTION_TAGS.has(tag)) {
          fragment.append(clean(child));
          continue;
        }
        const el = document.createElement(tag);
        if (tag === "a") {
          const href = (child.getAttribute("href") || "").trim();
          if (isSafeAttributionUrl(href)) {
            el.setAttribute("href", href);
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
          }
        } else if (tag === "img") {
          const src = (child.getAttribute("src") || "").trim();
          if (isSafeAttributionUrl(src)) el.setAttribute("src", src);
          const alt = child.getAttribute("alt");
          if (alt) el.setAttribute("alt", alt);
        }
        const title = child.getAttribute("title");
        if (title) el.setAttribute("title", title);
        el.append(clean(child));
        fragment.append(el);
      }
    }
    return fragment;
  };
  return clean(doc.body);
}

function sanitizedAttributionHtml(html) {
  const holder = document.createElement("div");
  holder.append(sanitizeAttributionFragment(html));
  return holder.innerHTML;
}

function appendAttributionText(container, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("<")) {
    const wrapper = document.createElement("span");
    wrapper.append(sanitizeAttributionFragment(trimmed));
    container.append(wrapper);
  } else {
    const span = document.createElement("span");
    span.textContent = ` ${trimmed}`;
    container.append(span);
  }
}

function updateMapAttribution() {
  const attribution = document.querySelector("#map-attribution");
  attribution.replaceChildren();
  if (selectedBasemap?.attribution) appendAttributionText(attribution, selectedBasemap.attribution);
  [...tileLayers, ...layers].forEach(item => {
    if (item.visible && item.attribution) appendAttributionText(attribution, item.attribution);
  });
}

async function detectBackend() {
  // スケールトゥゼロ環境のコールドスタートに備え、応答自体が無い場合は
  // 最大3回までリトライする。404等のHTTP応答は得られ次第即確定（リトライしない）
  for (let attempt = 0; ; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const response = await fetch("/health", { signal: controller.signal, cache: "no-store" });
      clearTimeout(timeout);
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        backendEnabled = data?.name === "kasugai_canvas";
        // ローカルRustサーバー以外（Cloud Run版エージェント等）でも /health が
        // {ok:true} を返せば capabilities を取得する（静的配信のみの環境は404で到達しない）
        if (backendEnabled || data?.ok === true) {
          // 利用可能な機能（fetchプロキシ・プラグイン書込み・エージェント等）を取得する
          const caps = await fetch("/api/capabilities", { cache: "no-store" })
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
          backendCapabilities = caps && caps.tier ? caps : null;
          // サーバー提供の Maps API キーを、ブラウザに未保存の場合のみ自動登録する
          //（ユーザーが手入力した BYO キーがあればそちらを優先）
          try {
            const mapsKey = backendCapabilities?.google?.mapsApiKey;
            if (mapsKey && !localStorage.getItem("googleMapsApiKey")) {
              localStorage.setItem("googleMapsApiKey", mapsKey);
            }
          } catch (e) {}
        }
      }
      backendCapabilitiesResolved = true;
      return;
    } catch {
      if (attempt >= 2) {
        backendEnabled = false;
        backendCapabilitiesResolved = true;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// アプリカテゴリ(クラウド・保存 = ローカルサーバー版のみの機能群)は
// capabilities 判定後にのみ管理ウィンドウのナビに表示する。静的環境では hidden のまま
function updateAppPanelVisibility() {
  const tab = document.querySelector("#manage-nav-app");
  if (tab) tab.hidden = !hasBackendFeature("cloudRclone");
}


function getProjectBaseUrl() {
  return projectsBaseUrl(currentProjectId);
}

// 共有URL等のプロジェクト指定部分。?kasc= モードでは project= ではなく
// kasc=<url> を書いて開き直せるようにする(override 指定時は project= 優先)
function projectQueryParam(projectOverride) {
  if (currentKascUrl && !projectOverride) return `kasc=${encodeURIComponent(currentKascUrl)}`;
  return `project=${encodeURIComponent(projectOverride || currentProjectId)}`;
}

// github.com の /raw/・/blob/ URL は raw.githubusercontent.com へのリダイレクト時に
// Access-Control-Allow-Origin が付かずブラウザの CORS fetch が失敗するため、
// 配信ドメイン直指定に正規化する(レイヤー・スタイル・凡例画像等すべてに効く)
function normalizeRemoteUrl(url) {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)\/(?:raw|blob)\/(.+)$/i.exec(url);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  return url;
}

// projects.json の external:true が付くプロジェクトID。
// .kasc 直接登録(外部プロジェクト)で、参照解決の基点が projects/ ではなく
// 登録フォルダになるもの。loadProjects で構築する
const externalProjectIds = new Set();
// loadProjects で取得した projects.json のエントリ(id → 定義)。
// ローカルサーバー時は dir(プロジェクトルートの実パス)・kasc(実ファイル名)を含む
const projectDefinitions = new Map();

function updateProjectRootPath() {
  const el = document.querySelector("#project-root-path");
  if (!el) return;
  const id = currentProjectId || "default";
  const def = projectDefinitions.get(id);
  el.value = def?.dir || (currentKascUrl ? kascBaseUrl() : `projects/${id}/`);
  el.title = el.value;
}

function resolveProjectUrl(url) {
  if (typeof url !== "string" || !url) return url;
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  // cloud:パス はローカルサーバーの rclone 連携(/api/cloud/file)へ解決する。
  // レイヤーURLに「cloud:フォルダ/ファイル.geojson」と書くだけで接続中の
  // クラウドストレージから読める
  if (/^cloud:/i.test(trimmed)) {
    const path = trimmed.slice(6).replace(/^\/+/, "");
    return `/api/cloud/file?path=${encodeURIComponent(path)}`;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("//")) return normalizeRemoteUrl(trimmed);
  if (trimmed.startsWith("/")) return trimmed;
  // ?kasc= モード: DATA/ 等の相対参照は .kasc のある URL を基準に解決する。
  // ../ 共有参照もブラウザの URL 正規化でそのまま祖先フォルダへ解決される
  if (currentKascUrl) return new URL(trimmed, kascBaseUrl()).href;
  let path = trimmed;
  if (path.startsWith("./")) path = path.slice(2);
  const segments = path.split("/").filter(Boolean);
  // ".." はプロジェクトフォルダの1つ上(ワークスペース)への参照。
  // 例: ../DATA/x → プロジェクト群と並列の共有 DATA/。通常プロジェクトは
  // ブラウザのURL正規化で projects/<id>/../DATA/x → projects/DATA/x に解決。
  // 外部プロジェクトは .. を正規化されないマーカー @parent に置き換えて送り、
  // サーバー側で登録フォルダの親を基点に解決する
  const external = externalProjectIds.has(currentProjectId || "default");
  const safeSegments = [];
  for (const segment of segments) {
    if (segment === "..") {
      if (safeSegments.length && safeSegments[safeSegments.length - 1] !== "..") safeSegments.pop();
      else safeSegments.push("..");
    } else if (segment !== ".") {
      safeSegments.push(segment);
    }
  }
  const resolved = safeSegments
    .map(segment => (segment === ".." && external ? "@parent" : segment))
    .join("/");
  return getProjectBaseUrl() + resolved;
}

async function loadProjects() {
  let definitions = [];
  try {
    const response = await fetch(PROJECTS_MANIFEST_URL, { cache: "no-store" });
    if (response.ok) definitions = await response.json();
  } catch {}
  if (!definitions.length) definitions = [{ id: "default", title: t("project.default") }];
  // ?kasc= で直接読んだ .kasc はマニフェストに無いため、選択中として
  // 一覧へ表示できるよう先頭に仮エントリを足す
  if (currentKascUrl && !definitions.some(p => p.id === currentProjectId)) {
    const kascTitle = await fetchKascProjectTitle(kascBaseUrl());
    definitions.unshift({ id: currentProjectId, title: `${kascTitle || currentProjectId} (.kasc)`, external: true });
  }
  externalProjectIds.clear();
  projectDefinitions.clear();
  const select = document.querySelector("#project-select");
  select.replaceChildren();
  definitions.forEach(project => {
    if (project.external) externalProjectIds.add(project.id);
    projectDefinitions.set(project.id, project);
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.title || project.id;
    if (project.id === currentProjectId) option.selected = true;
    select.append(option);
  });
  updateProjectRootPath();
}

// エンジン切替で引き継がれた状態。loadInspectorConfig で初期テキストへ
// 反映し、残り(可視性・テーマ)は初回適用後に反映する
let switchRestore = null;

async function loadInspectorConfig() {
  try {
    const projectId = currentProjectId || "default";
    const staticUrl = currentKascUrl
      || `${projectsBaseUrl(projectId)}kasugai_canvas.kasc`;
    let text = "";
    try {
      const response = await fetch(staticUrl, { cache: "no-store" });
      if (response.ok) text = await response.text();
    } catch {}
    if (!text) {
      // 明示指定されたプロジェクト/?kasc= の .kasc が無いときに内蔵デフォルトへ
      // 逃げると、別プロジェクト(東京都/千代田区サンプル)が表示されて誤解を招く
      // (プレイヤー系エンジンは空表示)。フォールバックは既定プロジェクトのみ
      if (window.kasugaiAuth?.serverKasc) {
        document.querySelector("#inspector-input").value = "";
        applyInspector("");
        setInspectorStatus(t("inspector.status.noKasc"), true);
        return;
      }
      if (currentKascUrl || currentProjectId !== "default") {
        document.querySelector("#inspector-input").value = "";
        applyInspector("");
        setInspectorStatus(t("inspector.status.notFound"), true);
        return;
      }
      text = defaultConfig;
    }
    // エンジン切替の引継ぎ .kasc があれば初期テキストとして使う
    if (switchRestore?.inspector != null && switchRestore.inspector !== text) text = switchRestore.inspector;
    document.querySelector("#inspector-input").value = text;
    applyInspector(text);
    setInspectorStatus(t("inspector.status.loaded"));
  } catch (error) {
    console.error("設定の読み込みに失敗しました。", error);
    setInspectorStatus(t("inspector.status.loadFailed", { error: error instanceof Error ? error.message : error }), true);
  }
}

async function saveInspectorConfig() {
  // 静的サイト構成のためサーバーへの保存は行わない
  // サーバー .kasc 対応の認証方式（cloudflare/cloudrun 系）時のみ保存する
  const auth = window.kasugaiAuth;
  if (!auth || !auth.serverKasc || !auth.token) return;
  const projectId = currentProjectId || "default";
  const rawText = document.querySelector("#inspector-input").value;
  const text = auth.restoreKasc ? auth.restoreKasc(rawText) : rawText;
  const res = await fetch("/api/kasc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: auth.token, project: projectId, text })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || t("error.saveFailed", { status: res.status }));
  }
  auth.updateKasc?.(projectId, text);
}

// ---- テーマ（theme: 行の可視性プリセット。QGIS マップテーマ相当） ----

// theme: 行の一覧をレイヤーパネル上部のテーマ選択へ反映する。
// theme: 行が無ければセレクト自体を隠す
function updateThemeSelect() {
  fillThemeSelect(document.querySelector("#theme-select"), inspectorThemes, t("theme.selectPrompt"));
}

// テーマ適用: .kasc 行を持つレイヤーの visible を一括更新する。
// inspector テキストの on/off と item.sourceLine/sourceVisible も同期し、
// テキスト⇔地図⇔レイヤー一覧の整合を保つ。.kasc 行を持たない
// 一時レイヤー(inline data 等)はテーマ対象外とする
function applyKascTheme(theme) {
  const show = themeShowSet(theme);
  const all = show == null;
  const items = getOrderedLayerItems().filter(item => item.sourceLine);
  for (const item of items) {
    item.visible = all || kascTitleInTheme(item.sourceTitle || item.title, show);
    item.sourceVisible = item.visible;
  }
  renderLayerList();
  refreshLayers();
  const input = document.querySelector("#inspector-input");
  if (input) {
    const lines = input.value.split(/\r?\n/);
    for (const item of items) {
      const idx = lines.indexOf(item.sourceLine);
      const newLine = rewriteKascLineVisibility(item.sourceLine, show);
      if (idx >= 0) lines[idx] = newLine;
      item.sourceLine = newLine;
    }
    input.value = lines.join("\n");
  }
}

function updateInspectorFromLayerOrder() {
  const input = document.querySelector("#inspector-input");
  if (!input) return;
  const lines = input.value.split(/\r?\n/);
  const layerLineIndices = [];
  lines.forEach((line, index) => {
    const separator = line.indexOf(":");
    if (separator < 0) return;
    const layerType = line.slice(0, separator).toLowerCase().trim();
    if (["xyz", "3dtiles", "geojson", "layer"].includes(layerType) || vectorDecoders.has(layerType)) layerLineIndices.push(index);
  });
  const orderedSourceLines = layerOrder.map(id => layerState.get(id)?.sourceLine).filter(Boolean);
  if (layerLineIndices.length !== orderedSourceLines.length) return;
  layerLineIndices.forEach((index, i) => { lines[index] = orderedSourceLines[i]; });
  input.value = lines.join("\n");
}

async function persistLayerOrder() {
  updateInspectorFromLayerOrder();
  await saveInspectorConfig();
}

function setInspectorStatus(message, isError = false) {
  const status = document.querySelector("#inspector-status");
  status.textContent = message;
  status.style.color = isError ? "#a82020" : "";
}

function flyTo(options = {}, duration = null) {
  const latitude = Number(options.latitude);
  const longitude = Number(options.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  let height = Number(options.height);
  if (!Number.isFinite(height)) height = DEFAULT_VIEW.height;
  const ssec = viewer.scene.screenSpaceCameraController;
  const pitchInput = Number(options.pitch) || 0;
  let pitchDeg = ssec.enableTilt ? Math.min(90, pitchInput) : -90;
  if (ssec.enableTilt && pitchDeg < -85) {
    pitchDeg = -84.99;
  }
  const pitch = pitchDeg * Math.PI / 180;
  const heading = (Number(options.heading) || 0) * Math.PI / 180;
  const destination = Cesium.Cartesian3.fromDegrees(longitude, latitude, height);
  const orientation = { heading, pitch, roll: 0 };
  if (duration === 0) {
    viewer.camera.setView({ destination, orientation });
    return;
  }
  const flight = { destination, orientation };
  if (Number.isFinite(duration)) {
    flight.duration = duration;
  } else {
    // Google Earth 風: 距離に応じて時間を伸ばし、一度ズームアウトしてから降下する弧を描く
    const distance = Cesium.Cartesian3.distance(viewer.camera.position, destination);
    flight.duration = Math.min(7, 1.0 + Math.log2(1 + distance / 1000) * 0.35);
    if (distance > 20000) {
      const currentHeight = Cesium.Cartographic.fromCartesian(viewer.camera.position).height;
      const peak = Math.min(distance * 0.6, 4000000);
      if (peak > Math.max(currentHeight, height)) flight.maximumHeight = peak;
    }
  }
  viewer.camera.flyTo(flight);
}

// bookmark: 由来の範囲プリセット(_extent 保持)へ移動する。height 近似ではなく
// extent そのものへフレームするため、範囲フィットを使う他エンジンと同一の表示になる
function flyToExtent(cam) {
  const e = cam._extent;
  const rect = Cesium.Rectangle.fromDegrees(e.west, e.south, e.east, e.north);
  const ssec = viewer.scene.screenSpaceCameraController;
  viewer.camera.flyTo({
    destination: rect,
    orientation: {
      heading: Cesium.Math.toRadians(Number(cam.heading) || 0),
      pitch: Cesium.Math.toRadians(ssec.enableTilt ? -84.99 : -90),
      roll: 0,
    },
  });
}

// 検索座標の地形標高を事前に読み込んで返す（未読み込みタイルもダウンロードする）
async function sampleGroundHeight(lat, lng) {
  const carto = Cesium.Cartographic.fromDegrees(lng, lat);
  // 1. sampleTerrainMostDetailed で対象タイルを事前ダウンロードして正確な標高を得る
  try {
    if (viewer.terrainProvider && !(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)) {
      const [result] = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto]);
      if (result && Number.isFinite(result.height)) return result.height;
    }
  } catch (e) { /* 取得失敗時は読み込み済みタイルにフォールバック */ }
  // 2. フォールバック: 読み込み済みタイルから取得
  try {
    const sampled = viewer.scene.globe.getHeight(carto);
    if (Number.isFinite(sampled)) return sampled;
  } catch (e) { /* ignore */ }
  return 0;
}

// 目的の座標（ピッチ-90で真下に見える地点）が画面中央に来るように、
// ピッチ・高さ・方位からカメラ位置を後退補正して flyTo する。
// height / pitch / heading を省略した場合は現在のカメラの値を使う
async function flyToFeature(lat, lng, options = {}) {
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  const currentHeight = cartographic ? cartographic.height : DEFAULT_VIEW.height;
  const currentPitchDeg = viewer.camera.pitch * 180 / Math.PI;
  const currentHeadingDeg = viewer.camera.heading * 180 / Math.PI;
  const height = Number.isFinite(options.height) ? options.height : currentHeight;
  let pitchDeg = Number.isFinite(options.pitch) ? options.pitch : currentPitchDeg;
  const headingDeg = Number.isFinite(options.heading) ? options.heading : currentHeadingDeg;

  // flyTo 側のピッチ補正と同じ値を先に適用して距離計算のズレを防ぐ
  const ssec = viewer.scene.screenSpaceCameraController;
  if (!ssec.enableTilt) pitchDeg = -90;
  else if (pitchDeg < -85) pitchDeg = -84.99;

  let cameraLat = lat;
  let cameraLng = lng;
  const pitchRad = Math.abs(pitchDeg) * Math.PI / 180;
  // 真下(-90°)に近い場合は補正不要
  if (Math.abs(pitchDeg) < 89 && pitchRad > 0.01) {
    // 検索座標の地形標高を事前読み込みし、地面からの相対高さで後退距離を計算する
    const groundHeight = await sampleGroundHeight(lat, lng);
    const relativeHeight = Math.max(0, height - groundHeight);
    const distance = relativeHeight / Math.tan(pitchRad);
    const headingRad = headingDeg * Math.PI / 180;
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);
    cameraLat = lat - (distance * Math.cos(headingRad)) / metersPerDegLat;
    cameraLng = lng - (distance * Math.sin(headingRad)) / (metersPerDegLng || 1);
  }
  flyTo({ latitude: cameraLat, longitude: cameraLng, height, pitch: pitchDeg, heading: headingDeg });
}

function extractLineStringCoordinates(geojson) {
  if (!geojson || typeof geojson !== "object") return [];
  const coords = [];
  const collect = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (obj.type === "LineString") {
      if (Array.isArray(obj.coordinates)) coords.push(...obj.coordinates);
    } else if (obj.type === "MultiLineString") {
      (obj.coordinates || []).forEach(line => { if (Array.isArray(line)) coords.push(...line); });
    } else if (obj.type === "Feature") {
      collect(obj.geometry);
    } else if (obj.type === "FeatureCollection" || Array.isArray(obj.features)) {
      (obj.features || []).forEach(collect);
    } else if (obj.type === "GeometryCollection" || Array.isArray(obj.geometries)) {
      (obj.geometries || []).forEach(collect);
    }
  };
  collect(geojson);
  return coords.filter(c => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
}

function buildFlyPath(rawCoords) {
  if (!rawCoords.length) return { points: [], distances: [] };
  const points = rawCoords.map(([lng, lat, alt = 0]) => ({ longitude: lng, latitude: lat, altitude: alt, terrain: 0 }));
  const distances = [0];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = (b.longitude - a.longitude) * 111320 * Math.cos((a.latitude + b.latitude) * Math.PI / 360);
    const dy = (b.latitude - a.latitude) * 111320;
    const dz = (b.altitude - a.altitude);
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0;
    distances.push(distances[distances.length - 1] + segLen);
  }
  return { points, distances };
}

// LineString 座標列（[lng,lat,...] の配列）の総距離(m)を概算する
function flyPathRouteDistance(coords) {
  let dist = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const dx = (coords[i + 1][0] - coords[i][0]) * 111320 * Math.cos((coords[i][1] + coords[i + 1][1]) * Math.PI / 360);
    const dy = (coords[i + 1][1] - coords[i][1]) * 111320;
    dist += Math.sqrt(dx * dx + dy * dy);
  }
  return dist;
}

// GeoJSON properties.fly に保存された飛行設定（addFlyPath が埋め込む）を
// flyPaths エントリへ復元する。リロード後も速度・ピッチ・ループ等が維持される
function applyFlySettingsFromGeoJson(text, entry) {
  try {
    const geojson = JSON.parse(text);
    const fly = geojson?.properties?.fly;
    if (!fly || typeof fly !== "object") {
      // fly設定を持たない旧形式の生成ルート（flyRoute生成物）は距離ベースの
      // 自動プロファイルで速度を補う。手描きルートは従来どおり既定値のまま
      const isGenerated = geojson?.properties?.source === "flyRoute" || geojson?.properties?.heightReference === "MSL";
      if (isGenerated && entry && Number.isFinite(entry.speed)) {
        const profile = flyRouteAutoProfile(flyPathRouteDistance(extractLineStringCoordinates(geojson)));
        if (profile && Number.isFinite(profile.speed)) entry.speed = profile.speed;
      }
      return;
    }
    if (Number.isFinite(fly.speed) && fly.speed > 0) entry.speed = fly.speed;
    if (Number.isFinite(fly.height)) entry.height = fly.height;
    if (Number.isFinite(fly.pitch)) entry.pitch = fly.pitch;
    if (Number.isFinite(fly.step) && fly.step > 0) entry.step = fly.step;
    if (fly.loop !== undefined) entry.loop = !!fly.loop;
    if (fly.view === "center" || fly.view === "camera") entry.view = fly.view;
  } catch (e) { /* 不正なJSONは既定値のまま */ }
}

async function loadFlyGeoJson(url) {
  let text;
  if (typeof url === "string" && url.startsWith("route:")) {
    // IndexedDB の描画ルートを参照（fly_geojson: 名 | route:ルート名）
    const name = decodeURIComponent(url.slice(6));
    text = window._routeStoreGet ? await window._routeStoreGet(currentProjectId || "default", name) : null;
    if (text == null) throw new Error(t("error.routeNotFound", { name }));
  } else {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    text = await response.text();
  }
  const geojson = JSON.parse(text);
  const rawCoords = extractLineStringCoordinates(geojson);
  if (!rawCoords.length) throw new Error(t("error.noLineString"));
  return { ...buildFlyPath(rawCoords), properties: geojson.properties || {} };
}

function buildFlyPathLinePositions(coords) {
  // ルートラインは GeoJSON 本来の高さ（標高 + ルート高度）で描画する
  return coords.map(c => Cesium.Cartesian3.fromDegrees(c.longitude, c.latitude, c.altitude + (c.terrain || 0)));
}

function getFlyPathLinePositions() {
  return flyPathLinePositions;
}

// 候補の中から参照地点（前の経由地やカメラ位置）に最も近いものを選ぶ。
// 同名の遠方地点への誤ヒットを減らすためのヒューリスティック
function pickNearestLocation(items, ref) {
  const valid = (items || []).filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  if (!ref || !Number.isFinite(ref.latitude) || valid.length < 2) return valid[0] || null;
  let best = valid[0];
  let bestDist = Infinity;
  const cos = Math.cos(ref.latitude * Math.PI / 180);
  for (const item of valid) {
    const dx = (item.longitude - ref.longitude) * cos;
    const dy = item.latitude - ref.latitude;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = item; }
  }
  return best;
}

// flyRoute ツール用: waypoint 指定を緯度経度へ解決する。
// {latitude,longitude,height?} はそのまま、{feature:"地物名"} は読込済みベクトルデータを
// vectorSearch で検索（見つからなければジオコーディングにフォールバック）、
// {query:"地名・住所"}/{name:"..."} は searchLocation でジオコーディングする。
// ref を渡すと複数候補から最も近い地点を選ぶ
async function resolveFlyRouteWaypoint(waypoint, provider, ref = null) {
  if (!waypoint || typeof waypoint !== "object") return null;
  const lat = Number(waypoint.latitude);
  const lng = Number(waypoint.longitude);
  const agl = Number(waypoint.height);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { latitude: lat, longitude: lng, agl, label: String(waypoint.name || waypoint.label || `${lat},${lng}`) };
  }
  const featureQuery = waypoint.feature ? String(waypoint.feature) : null;
  if (featureQuery) {
    const hit = pickNearestLocation(window.kasugaiApi.vectorSearch(featureQuery), ref);
    if (hit) return { latitude: hit.latitude, longitude: hit.longitude, agl, label: featureQuery };
  }
  const query = waypoint.query ? String(waypoint.query) : (waypoint.name ? String(waypoint.name) : featureQuery);
  if (query) {
    const items = await window.kasugaiApi.searchLocation(query, provider).catch(() => []);
    const hit = pickNearestLocation(items, ref);
    if (hit) return { latitude: hit.latitude, longitude: hit.longitude, agl, label: hit.title || query };
  }
  return null;
}

// 経由地間を直線補間して密なルート点列を作る（飛行を滑らかにし地形サンプリングを密にするため）
function densifyFlyRoutePoints(points, spacingMeters) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = (b.longitude - a.longitude) * 111320 * Math.cos((a.latitude + b.latitude) * Math.PI / 360);
    const dy = (b.latitude - a.latitude) * 111320;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(segLen / spacingMeters));
    for (let j = 0; j < steps; j++) {
      const s = j / steps;
      out.push({
        latitude: a.latitude + (b.latitude - a.latitude) * s,
        longitude: a.longitude + (b.longitude - a.longitude) * s,
        agl: a.agl + (b.agl - a.agl) * s,
      });
    }
  }
  out.push({ latitude: points[points.length - 1].latitude, longitude: points[points.length - 1].longitude, agl: points[points.length - 1].agl });
  return out;
}

// flyRoute 用: ルート総距離に応じた既定の地上高・速度を返す。
// 短距離は低空低速、長距離は戦闘機並み（高度約10km・2000km/h）の高空高速
function flyRouteAutoProfile(totalMeters) {
  if (!Number.isFinite(totalMeters) || totalMeters < 0) return { agl: 300, speed: 200 };
  if (totalMeters < 2000) return { agl: 50, speed: 80 };
  if (totalMeters < 20000) return { agl: 300, speed: 200 };
  if (totalMeters < 100000) return { agl: 800, speed: 400 };
  if (totalMeters < 500000) return { agl: 3000, speed: 1000 };
  return { agl: 10000, speed: 2000 };
}

// ルート点列の地形標高を一括サンプリングする。
// 取得タイル数は距離に比例するためレベルは距離で適応させる（短距離は精密・長距離は粗く。
// 高高度で飛ぶ長距離ほど細かい地形は不要）。失敗時は読み込み済みタイルにフォールバック
async function sampleRouteTerrain(points, totalMeters = 0) {
  const provider = viewer.terrainProvider;
  const level = totalMeters < 20000 ? 13 : totalMeters < 200000 ? 12 : 11;
  if (provider && !(provider instanceof Cesium.EllipsoidTerrainProvider) && typeof Cesium.sampleTerrain === "function") {
    try {
      const cartos = points.map(p => Cesium.Cartographic.fromDegrees(p.longitude, p.latitude));
      const sampled = await Cesium.sampleTerrain(provider, level, cartos);
      return sampled.map(c => (c && Number.isFinite(c.height)) ? c.height : null);
    } catch (e) { /* フォールバックへ */ }
  }
  return points.map(p => {
    try {
      const h = viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(p.longitude, p.latitude));
      return Number.isFinite(h) ? h : null;
    } catch (e) { return null; }
  });
}

function updateUrlFromCamera() {
  const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  const lon = Number(c.longitude * 180 / Math.PI).toFixed(6);
  const lat = Number(c.latitude * 180 / Math.PI).toFixed(6);
  const pitch = Number(viewer.camera.pitch * 180 / Math.PI).toFixed(2);
  const heading = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
  const height = Number(c.height).toFixed(1);
  const params = new URLSearchParams(window.location.search);
  ["latitude", "longitude", "height", "zoom", "pitch", "heading"].forEach(key => params.delete(key));
  if (currentKascUrl) { params.set("kasc", currentKascUrl); params.delete("project"); }
  else if (currentProjectId) params.set("project", currentProjectId);
  const hashParams = new URLSearchParams();
  hashParams.set("latitude", lat);
  hashParams.set("longitude", lon);
  hashParams.set("height", height);
  // 実ビューポート換算のズームを併記する（2Dエンジンは zoom 優先で読むため
  // height だけではスケールがずれる。傾斜時は直下換算の近似）
  const zoom = camToZoomView({ latitude: Number(lat), height: Number(height) }, viewer.canvas.clientHeight, Cesium.Math.toDegrees(viewer.camera.frustum.fovy));
  hashParams.set("zoom", zoom.toFixed(3));
  hashParams.set("pitch", pitch);
  hashParams.set("heading", heading);
  const search = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}#${hashParams.toString()}`);
}

function updateCameraInputs() {
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  document.querySelector("#camera-latitude").value = Number(cartographic.latitude * 180 / Math.PI).toFixed(6);
  document.querySelector("#camera-longitude").value = Number(cartographic.longitude * 180 / Math.PI).toFixed(6);
  document.querySelector("#camera-height").value = Number(cartographic.height).toFixed(1);
  document.querySelector("#camera-pitch").value = Number(viewer.camera.pitch * 180 / Math.PI).toFixed(2);
  document.querySelector("#camera-heading").value = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
  const compass = document.querySelector("#compass-button");
  if (compass) compass.style.transform = `rotateZ(${-viewer.camera.heading * 180 / Math.PI}deg)`;
  updateUrlFromCamera();
}

function openGoogleEarth() {
  try {
    const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    if (!cartographic || !Number.isFinite(cartographic.latitude) || !Number.isFinite(cartographic.longitude)) return;
    const cameraLat = cartographic.latitude * 180 / Math.PI;
    const cameraLng = cartographic.longitude * 180 / Math.PI;
    const height = Math.max(0, Number(cartographic.height) || 0);
    const headingRad = viewer.camera.heading;
    const pitchRad = viewer.camera.pitch;

    const tiltRad = Math.max(0, Math.min(Math.PI / 2, pitchRad + Math.PI / 2));
    const tiltDeg = tiltRad * 180 / Math.PI;
    const headingDeg = ((headingRad * 180 / Math.PI) % 360 + 360) % 360;

    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(cameraLat * Math.PI / 180);
    let targetLat = cameraLat;
    let targetLng = cameraLng;
    let distance = height;
    if (tiltRad > 0.01) {
      const horizontalDistance = height * Math.tan(tiltRad);
      targetLat = cameraLat + (horizontalDistance * Math.cos(headingRad)) / metersPerDegLat;
      targetLng = cameraLng + (horizontalDistance * Math.sin(headingRad)) / (metersPerDegLng || 1);
      distance = height / Math.cos(tiltRad);
    }

    const url = `https://earth.google.com/web/@${targetLat.toFixed(6)},${targetLng.toFixed(6)},0a,${distance.toFixed(2)}d,35y,${headingDeg.toFixed(1)}h,${tiltDeg.toFixed(1)}t,0r`;
    window.open(url, "_blank");
  } catch (error) {
    console.error("Google Earth 連携エラー:", error);
  }
}

function renderBasemapSelector() {
  const select = document.querySelector("#basemap-select");
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("basemap.none");
  none.selected = !globeHidden && !selectedBasemap;
  select.append(none);
  const hideGlobe = document.createElement("option");
  hideGlobe.value = "__hide_globe__";
  hideGlobe.textContent = t("basemap.transparent");
  hideGlobe.selected = globeHidden;
  select.append(hideGlobe);
  // タイトルの "グループ/名前" 階層は optgroup でグループ化表示する
  // (QGIS エクスポートのベースマップグループ配下サブグループ等)。
  // optgroup があれば select を折りたたみ可能なリスト UI へ置き換える
  appendGroupedTitleOptions(select, basemaps, (basemap, leafTitle) => {
    const option = document.createElement("option");
    option.value = basemap.id;
    option.textContent = leafTitle;
    if (basemap.id === selectedBasemap?.id) option.selected = true;
    return option;
  });
  syncBasemapList(select, {
    expandAll: t("basemap.expandAll"),
    collapseAll: t("basemap.collapseAll"),
  });
}

// CAM / QGIS-XML の2系統。各見出しにその形式の保存・読込ボタンを置く
const CAM_PRESET_GROUPS = [
  { key: "CAM", match: p => !p.bookmark, file: "#cams-import-cam-file",
    onSave: items => downloadKascCamLines(items) },
  { key: "QGIS-XML", match: p => !!p.bookmark, file: "#cams-import-file",
    onSave: items => downloadQgisBookmarksXml(items) },
];
function renderPresets() {
  const container = document.querySelector("#camera-presets");
  container.replaceChildren();
  for (const g of CAM_PRESET_GROUPS) {
    const head = document.createElement("div");
    head.className = "cam-group-label";
    head.append(document.createTextNode(g.key));
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "保存";
    save.addEventListener("click", () => g.onSave(cameraPresets.filter(g.match)));
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "読込";
    load.addEventListener("click", () => document.querySelector(g.file)?.click());
    head.append(save, load);
    container.append(head);
    cameraPresets.forEach((preset, index) => {
      if (!g.match(preset)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = preset.title;
      button.dataset.preset = String(index);
      button.classList.add("preset-button");
      if (preset.bookmark) button.classList.add("bm-btn");
      button.addEventListener("click", () => preset._extent ? flyToExtent(preset) : flyTo(preset));
      container.append(button);
    });
  }
}

// bookmark: 行の QGIS ブックマーク XML を読み込み、カメラプリセットへ追加する。
// applyInspector は同期関数のため、パース時に収集した specs をここで非同期解決する。
// 再適用で specs が入れ替わった場合は古いロード結果を捨てる(seq 管理)
async function loadInspectorBookmarks(specs) {
  const seq = ++bookmarkLoadSeq;
  if (!specs.length) return;
  const resolved = specs.map(spec => ({ ...spec, url: resolveProjectUrl(spec.url) }));
  const cams = await loadKascBookmarks(resolved, "");
  if (seq !== bookmarkLoadSeq || !cams.length) return;
  cameraPresets.push(...cams);
  renderPresets();
}

function getOrderedLayerItems() {
  return layerOrder.map(id => layerState.get(id)).filter(Boolean);
}

function getGroupLayerIds(groupKey) {
  const [groupName, exclusive] = groupKey.split("|");
  return getOrderedLayerItems()
    .filter(layer => (layer.group || "") === groupName && (layer.exclusiveGroup ? "exclusive" : "regular") === exclusive)
    .map(layer => layer.id);
}

// レイヤー一覧の📍ボタン/エージェント用: レイヤー全体が画面に収まるようカメラを移動する。
// 非表示レイヤーは未ロードの場合があるため、表示してからフォーカスする。
// 実行時オブジェクトは refreshLayers() で layerRuntimeTargets に登録される
async function focusLayer(layer) {
  if (!layer) return false;
  if (!layerRuntimeTargets.has(layer.id) && !layer.dataSource && !layer.visible) {
    layer.visible = true;
    if (layer.exclusiveGroup) {
      getOrderedLayerItems().forEach(other => {
        if (other !== layer && other.group === layer.group && other.exclusiveGroup) other.visible = false;
      });
    }
    renderLayerList();
    await refreshLayers();
  }
  let target = layerRuntimeTargets.get(layer.id) || layer.dataSource || null;
  // XYZタイルは範囲情報を持たないため、ImageryLayer未生成時は全世界表示にフォールバックする
  // (bbox= 指定時はその範囲へ flyTo する)
  if (!target && layer.type === "tile") {
    target = layer.bbox
      ? Cesium.Rectangle.fromDegrees(...layer.bbox)
      : Cesium.Rectangle.clone(Cesium.Rectangle.MAX_VALUE);
  }
  if (!target) return false;
  // GeoJsonPrimitive は flyTo の対象外なので内部の Buffer コレクションへフォーカスする
  if (Cesium.GeoJsonPrimitive && target instanceof Cesium.GeoJsonPrimitive) {
    const inner = target.polygons || target.polylines || target.points;
    if (inner) target = inner;
  }
  try {
    return await viewer.flyTo(target, { duration: 2 });
  } catch (error) {
    if (target.boundingSphere) {
      try {
        viewer.camera.flyToBoundingSphere(target.boundingSphere, { duration: 2 });
        return true;
      } catch (e) { /* ignore */ }
    }
    console.warn("レイヤーへのフォーカスに失敗しました:", layer.title, error);
    return false;
  }
}

function renderLayerList() {
  const list = document.querySelector("#layer-list");
  const groupedLayers = new Map();
  getOrderedLayerItems().forEach(layer => {
    const group = layer.group || "";
    const key = `${group}|${layer.exclusiveGroup ? "exclusive" : "regular"}`;
    if (!groupedLayers.has(key)) groupedLayers.set(key, { group, exclusive: !!layer.exclusiveGroup, layers: [] });
    groupedLayers.get(key).layers.push(layer);
  });
  list.innerHTML = [...groupedLayers.values()].map(({ group, exclusive, layers }) => {
    const groupKey = `${group}|${exclusive ? "exclusive" : "regular"}`;
    const groupId = `layer-group-${[...groupKey].map(character => character.charCodeAt(0).toString(16)).join("")}`;
    const groupInputId = `${groupId}-checkbox`;
    const groupChecked = layers.some(layer => layer.visible);
    return `
    <section class="layer-group${group ? " grouped" : ""}${exclusive ? " exclusive" : ""}" data-group-key="${escapeHtml(groupKey)}">
      ${group ? `<div class="layer-group-title" draggable="true"><button class="layer-group-toggle" type="button" aria-label="${t("layer.groupToggle")}" aria-expanded="${expandedLayerGroups.has(groupKey)}">${expandedLayerGroups.has(groupKey) ? "▾" : "▸"}</button><input id="${groupInputId}" class="layer-group-checkbox" type="${exclusive ? "radio" : "checkbox"}" ${exclusive ? `name="${escapeHtml(groupInputId)}"` : ""} data-group-key="${escapeHtml(groupKey)}" ${groupChecked ? "checked" : ""}><label class="layer-group-label" for="${groupInputId}">${escapeHtml(group)}</label>${exclusive ? `<small class="exclusive-badge">${t("layer.exclusive")}</small>` : ""}</div>` : ""}
      <div class="layer-group-children" id="${groupId}"${group && !expandedLayerGroups.has(groupKey) ? " hidden" : ""}>
        ${layers.map((layer, index) => {
          const inputId = `${groupId}-layer-${index}`;
          const filterButton = isQueryDecoder(vectorDecoders.get(layer.type), layer)
            ? `<button class="layer-filter" type="button" data-layer-id="${escapeHtml(layer.id)}" title="${escapeHtml(t("layer.filter"))}" aria-label="${escapeHtml(t("layer.filter"))}">⏷</button>`
            : "";
          const limitBadge = layer.entityLimited
            ? `<small class="entity-limit-badge" title="${escapeHtml(t("layer.entityLimited", { shown: layer.entityLimited.shown, total: layer.entityLimited.total }))}">${layer.entityLimited.shown}/${layer.entityLimited.total}</small>`
            : "";
          const legendEntries = getLayerLegend(layer)?.entries || null;
          const legendMulti = !!legendEntries && legendEntries.length > 1;
          const legendCollapsed = legendMulti && collapsedLayerLegends.has(layer.id);
          const legendToggle = legendMulti
            ? `<button class="layer-legend-toggle" type="button" data-layer-id="${escapeHtml(layer.id)}" aria-label="${escapeHtml(t("layer.legendToggle"))}" aria-expanded="${!legendCollapsed}">${legendCollapsed ? "▸" : "▾"}</button>`
            : "";
          const inlineSwatch = legendEntries && !legendMulti && legendEntries[0].desc
            ? `<img class="legend-swatch" src="${buildLegendSwatchDataUrl(legendEntries[0].desc)}" alt="">`
            : "";
          const legendItems = legendMulti
            ? `<div class="layer-legend-items" data-layer-id="${escapeHtml(layer.id)}"${legendCollapsed ? " hidden" : ""}>${legendEntries.map((entry, entryIndex) => {
                const entryInputId = `${inputId}-legend-${entryIndex}`;
                const hidden = !!entry.symbolName && !!layer.legendHidden?.has(entry.symbolName);
                return `<label class="legend-row" for="${entryInputId}">
                  <input id="${entryInputId}" type="checkbox" class="legend-checkbox" data-layer-id="${escapeHtml(layer.id)}" data-symbol="${escapeHtml(entry.symbolName || "")}" ${hidden ? "" : "checked"}${entry.symbolName ? "" : " disabled"}>
                  ${entry.desc ? `<img class="legend-swatch" src="${buildLegendSwatchDataUrl(entry.desc)}" alt="">` : `<span class="legend-swatch legend-swatch-empty"></span>`}
                  <span class="legend-label">${escapeHtml(entry.label || entry.symbolName || "")}</span>
                </label>`;
              }).join("")}</div>`
            : "";
          return `
        <div class="layer-item">
        <label class="layer-row" for="${inputId}" draggable="true" data-layer-id="${escapeHtml(layer.id)}">
          ${legendToggle}
          <input id="${inputId}" type="${exclusive ? "radio" : "checkbox"}" ${exclusive ? `name="${escapeHtml(groupId)}"` : ""} data-layer-id="${escapeHtml(layer.id)}" data-group="${escapeHtml(layer.group || "")}" data-exclusive="${exclusive ? "true" : "false"}" ${layer.visible ? "checked" : ""}>
          ${inlineSwatch}
          <span>${escapeHtml(layer.title)}</span>
          <span class="layer-status${layer._loadStatus === "loading" ? " loading" : ""}${layer._loadStatus === "failed" ? " failed" : ""}" data-layer-id="${escapeHtml(layer.id)}" title="${escapeHtml(layer._loadError || "")}">${layer._loadStatus === "failed" ? escapeHtml(t("layer.loadFailed")) : ""}</span>
          ${filterButton}
          ${limitBadge}
          <button class="layer-focus" type="button" data-layer-id="${escapeHtml(layer.id)}" title="${escapeHtml(t("layer.focus"))}" aria-label="${escapeHtml(t("layer.focus"))}">📍</button>
        </label>
        ${legendItems}
        </div>`;
        }).join("")}
      </div>
    </section>`;
  }).join("");

  list.querySelectorAll(".layer-group-toggle").forEach(toggle => {
    toggle.addEventListener("click", () => {
      const group = toggle.closest(".layer-group");
      const children = group.querySelector(".layer-group-children");
      const groupKey = group.dataset.groupKey;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      toggle.textContent = expanded ? "▸" : "▾";
      children.hidden = expanded;
      if (expanded) expandedLayerGroups.delete(groupKey);
      else expandedLayerGroups.add(groupKey);
    });
  });

  list.querySelectorAll(".layer-group-checkbox").forEach(input => {
    input.addEventListener("change", () => {
      const group = [...groupedLayers.values()].find(item => `${item.group}|${item.exclusive ? "exclusive" : "regular"}` === input.dataset.groupKey);
      if (!group) return;
      if (group.exclusive) {
        group.layers.forEach(layer => { layer.visible = false; });
        if (input.checked) (group.layers.find(layer => layer.visible) || group.layers[0]).visible = true;
      } else {
        group.layers.forEach(layer => { layer.visible = input.checked; });
      }
      renderLayerList();
      refreshLayers();
    });
  });

  list.querySelectorAll(".layer-group-checkbox").forEach(input => {
    input.addEventListener("click", event => {
      if (input.type === "radio" && input.checked) {
        event.preventDefault();
        input.checked = false;
        input.dispatchEvent(new Event("change"));
      }
    });
  });

  list.querySelectorAll(".layer-row input").forEach(input => {
    input.addEventListener("change", () => {
      const layer = layerState.get(input.dataset.layerId);
      if (!layer) return;
      layer.visible = input.checked;
      if (input.checked && input.dataset.exclusive === "true") {
        getOrderedLayerItems().forEach(other => {
          if (other !== layer && other.group === layer.group && other.exclusiveGroup) other.visible = false;
        });
      }
      renderLayerList();
      refreshLayers();
    });
  });

  list.querySelectorAll(".layer-focus").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void focusLayer(layerState.get(button.dataset.layerId));
    });
  });

  list.querySelectorAll(".layer-filter").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void editLayerQueryFilter(layerState.get(button.dataset.layerId));
    });
  });

  list.querySelectorAll(".layer-legend-toggle").forEach(toggle => {
    toggle.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const id = toggle.dataset.layerId;
      const items = toggle.closest(".layer-item")?.querySelector(".layer-legend-items");
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      toggle.textContent = expanded ? "▸" : "▾";
      if (items) items.hidden = expanded;
      if (expanded) collapsedLayerLegends.add(id);
      else collapsedLayerLegends.delete(id);
    });
  });

  list.querySelectorAll(".legend-checkbox").forEach(input => {
    input.addEventListener("change", () => {
      setLegendSymbolVisible(layerState.get(input.dataset.layerId), input.dataset.symbol, input.checked);
    });
  });

  let draggedId;
  let draggedGroupKey;

  list.querySelectorAll(".layer-group").forEach(groupSection => {
    groupSection.addEventListener("dragover", event => {
      if (!draggedGroupKey || draggedGroupKey === groupSection.dataset.groupKey) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    groupSection.addEventListener("drop", event => {
      if (!draggedGroupKey) return;
      event.preventDefault();
      const sourceKey = draggedGroupKey;
      const targetKey = groupSection.dataset.groupKey;
      if (sourceKey === targetKey) return;
      const sourceIds = getGroupLayerIds(sourceKey);
      const targetIds = getGroupLayerIds(targetKey);
      const sourceFirstIndex = layerOrder.indexOf(sourceIds[0]);
      const targetFirstIndex = layerOrder.indexOf(targetIds[0]);
      const nextOrder = layerOrder.filter(id => !sourceIds.includes(id));
      let insertIndex;
      if (sourceFirstIndex < targetFirstIndex) {
        insertIndex = nextOrder.indexOf(targetIds[targetIds.length - 1]) + 1;
      } else {
        insertIndex = nextOrder.indexOf(targetIds[0]);
      }
      nextOrder.splice(insertIndex, 0, ...sourceIds);
      layerOrder = nextOrder;
      draggedGroupKey = undefined;
      renderLayerList();
      refreshLayers();
      void persistLayerOrder().catch(error => { console.warn("レイヤー順の保存エラー:", error); });
    });
  });

  list.querySelectorAll(".layer-group-title").forEach(title => {
    title.addEventListener("dragstart", event => {
      const groupSection = title.closest(".layer-group");
      if (!groupSection) return;
      draggedGroupKey = groupSection.dataset.groupKey;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedGroupKey);
      groupSection.classList.add("dragging");
    });
    title.addEventListener("dragend", () => {
      const groupSection = title.closest(".layer-group");
      if (groupSection) groupSection.classList.remove("dragging");
      draggedGroupKey = undefined;
    });
  });

  list.querySelectorAll(".layer-row").forEach(row => {
    row.addEventListener("dragstart", event => {
      draggedId = row.dataset.layerId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedId);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => { draggedId = undefined; row.classList.remove("dragging"); });
    row.addEventListener("dragover", event => {
      if (!draggedId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", event => {
      if (!draggedId) return;
      event.preventDefault();
      const sourceId = draggedId || event.dataTransfer.getData("text/plain");
      const targetId = row.dataset.layerId;
      if (!sourceId || sourceId === targetId) return;
      const orderedLayers = getOrderedLayerItems();
      const sourceLayer = orderedLayers.find(item => item.id === sourceId);
      const targetLayer = orderedLayers.find(item => item.id === targetId);
      if (!sourceLayer || !targetLayer || sourceLayer.group !== targetLayer.group || (sourceLayer.exclusiveGroup ? "exclusive" : "regular") !== (targetLayer.exclusiveGroup ? "exclusive" : "regular")) return;
      const nextOrder = orderedLayers.map(item => item.id);
      const sourceIndex = nextOrder.indexOf(sourceId);
      const targetIndex = nextOrder.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) return;
      nextOrder.splice(sourceIndex, 1);
      nextOrder.splice(nextOrder.indexOf(targetId), 0, sourceId);
      layerOrder = nextOrder;
      renderLayerList();
      refreshLayers();
      void persistLayerOrder().catch(error => { console.warn("レイヤー順の保存エラー:", error); });
    });
  });

  list.querySelectorAll(".layer-group-checkbox").forEach(input => {
    const group = [...groupedLayers.values()].find(item => `${item.group}|${item.exclusive ? "exclusive" : "regular"}` === input.dataset.groupKey);
    if (group && !group.exclusive) input.indeterminate = group.layers.some(layer => layer.visible) && group.layers.some(layer => !layer.visible);
  });
}

function renderFlyPathSelect() {
  const select = document.querySelector("#fly-path-select");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="__manual__">' + escapeHtml(t("fly.manual")) + '</option>' +
    flyPaths.map((path, index) => `<option value="${index}">${escapeHtml(path.title)}</option>`).join("");
  const exists = [...select.options].some(option => option.value === current);
  select.value = exists ? current : "__manual__";
  updateFlyPathDeleteButton();
}

// 描画ルート（IndexedDB/フォルダ由来）を選択している時だけ削除・出力ボタンを表示
function updateFlyPathDeleteButton() {
  const delBtn = document.querySelector("#fly-path-delete");
  const downloadBtn = document.querySelector("#fly-path-download");
  const select = document.querySelector("#fly-path-select");
  const index = Number(select?.value);
  const path = Number.isInteger(index) && index >= 0 && index < flyPaths.length ? flyPaths[index] : null;
  if (delBtn) delBtn.style.display = path?.drawn ? "" : "none";
  if (downloadBtn) downloadBtn.style.display = path?.drawn ? "" : "none";
}

async function ensureDrawnRouteFlyPath() {
  if (window._ensureDrawnRouteFlyPath) {
    return await window._ensureDrawnRouteFlyPath();
  }
}

const GSI_DEM_LAYERS = [
  { id: "dem1a_png", maxZ: 17, clampZoom: true },
  { id: "dem5a_png", maxZ: 15, minZ: 15, clampZoom: true },
  { id: "dem5b_png", maxZ: 15, minZ: 15, clampZoom: true },
  { id: "dem5c_png", maxZ: 15, minZ: 15, clampZoom: true },
  { id: "dem_png", maxZ: 14 },
  { id: "demgm_png", maxZ: 8 },
];
const GSI_LAYER_BY_ID = Object.fromEntries(GSI_DEM_LAYERS.map(layer => [layer.id, layer]));

const GSI_MERCATOR_MAX_LAT = 85.05112878;
const GSI_INVALID_PIXEL = 8388608; // 2^23: (R,G,B) = (128,0,0)

function gsiMercatorX(lonDeg, z) {
  return ((lonDeg + 180) / 360) * 256 * (1 << z);
}

function gsiMercatorY(latDeg, z) {
  const clamped = Math.min(Math.max(latDeg, -GSI_MERCATOR_MAX_LAT), GSI_MERCATOR_MAX_LAT);
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 256 * (1 << z);
}

function gsiDecodeHeight(data, offset) {
  const value = data[offset] * 65536 + data[offset + 1] * 256 + data[offset + 2];
  if (value === GSI_INVALID_PIXEL) return 0;
  return (value > GSI_INVALID_PIXEL ? value - 16777216 : value) * 0.01;
}

class GsiDemTerrainProvider {
  constructor(options = {}) {
    this.tilingScheme = new Cesium.GeographicTilingScheme();
    this.outputSize = options.outputSize || 128;
    this.layers = (options.layers || ["dem5a_png"]).map(id => GSI_LAYER_BY_ID[id]).filter(Boolean);
    this.hasVertexNormals = false;
    this.hasWaterMask = false;
    this.maximumLevel = 16;
    this.maxMercatorZ = 17;
    this.availability = {
      isTileAvailable: (level, x, y) => level <= this.maximumLevel && x >= 0 && y >= 0,
    };
    this._tileCache = new Map();
    this.errorEvent = new Cesium.Event();
    this.credit = new Cesium.Credit(t("credit.gsi"));
    this.ready = true;
  }

  getLevelMaximumGeometricError(level) {
    return 156543.03392 / (1 << level);
  }

  getTileDataAvailable(x, y, level) {
    return this.availability.isTileAvailable(level, x, y);
  }

  loadTileDataAvailability() {
    return undefined;
  }

  _fetchSourceTile(layerId, zz, tx, ty) {
    const key = `${layerId}/${zz}/${tx}/${ty}`;
    let promise = this._tileCache.get(key);
    if (promise) return promise;
    promise = (async () => {
      try {
        const url = `https://cyberjapandata.gsi.go.jp/xyz/${layerId}/${zz}/${tx}/${ty}.png`;
        const response = await fetch(url, { mode: "cors" });
        if (!response.ok) return null;
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) { bitmap.close(); return null; }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return ctx.getImageData(0, 0, 256, 256).data;
      } catch (error) {
        return null;
      }
    })();
    if (this._tileCache.size > 2000) this._tileCache.clear();
    this._tileCache.set(key, promise);
    return promise;
  }

  async _loadMercatorTile(x, y, z) {
    // フォールバックなし: 各レイヤーは自身の最大ズームにクランプして並列取得
    const layers = this.layers.filter(layer => z >= (layer.minZ || 0) && (layer.clampZoom || z <= layer.maxZ));
    const results = await Promise.all(layers.map(async layer => {
      const zz = Math.min(z, layer.maxZ);
      const shift = z - zz;
      const tx = x >> shift;
      const ty = y >> shift;
      const pixels = await this._fetchSourceTile(layer.id, zz, tx, ty);
      return pixels ? { pixels, z: zz, x: tx, y: ty } : null;
    }));
    for (const tile of results) {
      if (tile) return tile;
    }
    return null;
  }

  _sampleHeight(tiles, lonDeg, latDeg) {
    for (const tile of tiles) {
      const gx = gsiMercatorX(lonDeg, tile.z) - tile.x * 256;
      const gy = gsiMercatorY(latDeg, tile.z) - tile.y * 256;
      if (gx < 0 || gy < 0 || gx >= 256 || gy >= 256) continue;
      const px = Math.min(255, Math.floor(gx));
      const py = Math.min(255, Math.floor(gy));
      return gsiDecodeHeight(tile.pixels, (py * 256 + px) * 4);
    }
    return 0;
  }

  async requestTileGeometry(x, y, level) {
    const size = this.outputSize;
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level);
    const west = Cesium.Math.toDegrees(rect.west);
    const east = Cesium.Math.toDegrees(rect.east);
    const south = Cesium.Math.toDegrees(rect.south);
    const north = Cesium.Math.toDegrees(rect.north);

    // 地理院タイル(WebメルカトルXYZ)の該当ズームを決定し、範囲内のタイルを列挙
    let z = Math.min(level + 1, this.maxMercatorZ);
    let xMin, xMax, yMin, yMax;
    for (; z >= 0; z -= 1) {
      xMin = Math.max(0, Math.floor(gsiMercatorX(west, z) / 256));
      xMax = Math.min((1 << z) - 1, Math.floor(gsiMercatorX(east - 1e-9, z) / 256));
      yMin = Math.max(0, Math.floor(gsiMercatorY(north, z) / 256));
      yMax = Math.min((1 << z) - 1, Math.floor(gsiMercatorY(south, z) / 256));
      if ((xMax - xMin + 1) * (yMax - yMin + 1) <= 9) break;
    }

    const fetched = await Promise.all(
      Array.from({ length: yMax - yMin + 1 }, (_, iy) => iy + yMin).flatMap(ty =>
        Array.from({ length: xMax - xMin + 1 }, (_, ix) => ix + xMin).map(tx => this._loadMercatorTile(tx, ty, z))
      )
    );
    const tiles = fetched.filter(Boolean);

    const heights = new Float32Array(size * size);
    for (let j = 0; j < size; j += 1) {
      const lat = north - ((j + 0.5) / size) * (north - south);
      for (let i = 0; i < size; i += 1) {
        const lon = west + ((i + 0.5) / size) * (east - west);
        heights[j * size + i] = this._sampleHeight(tiles, lon, lat);
      }
    }

    return new Cesium.HeightmapTerrainData({
      buffer: heights,
      width: size,
      height: size,
      childTileMask: level >= this.maximumLevel ? 0 : 15,
      structure: {
        heightScale: 1.0,
        heightOffset: 0.0,
        elementsPerHeight: 1,
        stride: 1,
        elementMultiplier: 1.0,
        isBigEndian: false,
      },
    });
  }
}


function proxyTileUrl(url, useProxy = true) {
  return url;
}

// リモート URL をローカルサーバーの /api/fetch 経由に書き換える。
// fetchRange 能力(Range/HEAD 転送)があるバックエンドでのみ有効。
// duckdb: の proxy=on で使用。バックエンド無し・相対パスでは元の URL を返す
function proxyFetchUrl(url, useProxy = false) {
  if (!useProxy || !/^https?:\/\//i.test(String(url || ""))) return url;
  if (!hasBackendFeature("fetchRange")) return url;
  if (!isFetchProxyTarget(url)) return url;
  return `${location.origin}/api/fetch?url=${encodeURIComponent(url)}`;
}

function proxyTemplateUrl(url, useProxy = true) {
  return url;
}

function createUrlTemplateProvider(options) {
  const providerOptions = {
    url: proxyTemplateUrl(options.url, options.proxy !== false),
    credit: new Cesium.Credit(sanitizedAttributionHtml(options.attribution || "")),
    maximumLevel: options.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
    tileWidth: options.tileSize || 256,
    tileHeight: options.tileSize || 256,
  };
  // URL の {s} プレースホルダ用サブドメイン（"0123" 等の文字列で指定）
  if (options.subdomains) providerOptions.subdomains = options.subdomains;
  if (Number.isInteger(options.minimumLevel) && options.minimumLevel >= 0) providerOptions.minimumLevel = options.minimumLevel;
  // bbox=西,南,東,北: タイルの存在範囲。範囲外へのリクエスト自体を抑止する
  if (Array.isArray(options.bbox) && options.bbox.length === 4) {
    providerOptions.rectangle = Cesium.Rectangle.fromDegrees(...options.bbox);
  }
  return new Cesium.UrlTemplateImageryProvider(providerOptions);
}

function createClippingPlaneFromEnu(normalEnu) {
  const center = viewer.camera.position.clone();
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
  const normalEcef = Cesium.Matrix4.multiplyByPointAsVector(transform, normalEnu, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(normalEcef, normalEcef);
  const distance = -Cesium.Cartesian3.dot(normalEcef, center);
  return new Cesium.ClippingPlane(normalEcef, distance);
}

function applyClippingPlanes(target) {
  try {
    if (!activeClippingPlanes.planes.length) {
      target.clippingPlanes = undefined;
      return;
    }
    target.clippingPlanes = new Cesium.ClippingPlaneCollection({
      planes: activeClippingPlanes.planes.map(p => new Cesium.ClippingPlane(p.normal, p.distance)),
      edgeWidth: 2,
      edgeColor: Cesium.Color.RED,
      enabled: true,
    });
  } catch (error) {
    console.warn("クリッピング平面の適用に失敗しました:", error);
  }
}

// ベースマップ透明に入る前の HDR / 大気ハロー設定を保持する
let savedHdrForGlobeHidden = null;
let savedGroundAtmosphereForGlobeHidden = null;

function applyGlobeVisibility() {
  const scene = viewer.scene;
  // 「ベースマップ透明」でも globe 自体は描画する。地表色と背景を透明にし、
  // XYZ タイルの ImageryLayer だけが地形起伏の上に残るようにする。
  // 背景を透明にするには HDR を無効化する必要がある(Cesium公式: HDR有効時は
  // フレームバッファのアルファが合成されず不透明になる)
  scene.globe.show = true;
  scene.globe.baseColor = globeHidden ? Cesium.Color.TRANSPARENT : globeBaseColor;
  if (globeHidden) {
    if (savedHdrForGlobeHidden === null) savedHdrForGlobeHidden = scene.highDynamicRange;
    if (savedGroundAtmosphereForGlobeHidden === null) savedGroundAtmosphereForGlobeHidden = scene.globe.showGroundAtmosphere;
    scene.highDynamicRange = false;
    scene.globe.showGroundAtmosphere = false;
    scene.backgroundColor = Cesium.Color.TRANSPARENT;
    // 地表のアルファを baseColor(透明) + imagery(XYZ) のブレンド結果にする。
    // translucency 無効だと globe は不透明パスで描画され baseColor のアルファが無視される
    scene.globe.translucency.enabled = true;
    scene.globe.translucency.frontFaceAlpha = 1;
    scene.globe.translucency.backFaceAlpha = 1;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
  } else {
    if (savedHdrForGlobeHidden !== null) { scene.highDynamicRange = savedHdrForGlobeHidden; savedHdrForGlobeHidden = null; }
    if (savedGroundAtmosphereForGlobeHidden !== null) { scene.globe.showGroundAtmosphere = savedGroundAtmosphereForGlobeHidden; savedGroundAtmosphereForGlobeHidden = null; }
    if (scene.sun) scene.sun.show = true;
    if (scene.moon) scene.moon.show = true;
  }
  document.body.classList.toggle("globe-hidden", globeHidden);
}

function updateUndergroundView() {
  // ベースマップ透明中は地表アルファを baseColor+imagery のブレンド結果に委ねるため、
  // frontFaceAlpha/backFaceAlpha は 1 固定(applyGlobeVisibility 側で管理)
  const alpha = globeHidden ? 1 : 1 - undergroundTransparency;
  viewer.scene.globe.translucency.frontFaceAlpha = alpha;
  viewer.scene.globe.translucency.backFaceAlpha = alpha;
  viewer.scene.globe.undergroundColor = undergroundBackgroundColor;
  viewer.scene.globe.undergroundColorAlphaByDistance = undefined;
  viewer.scene.backgroundColor = globeHidden ? Cesium.Color.TRANSPARENT : undergroundBackgroundColor;
  if (viewer.scene.skyBox) {
    viewer.scene.skyBox.show = !globeHidden && undergroundTransparency === 0 && !undergroundDiveEnabled;
  }
  if (undergroundDiveEnabled) {
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
  } else {
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 1;
  }
}

function updateEffectSettings() {
  const hasTerrain = !(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider);
  const terrainLightingInput = document.querySelector("#effect-terrain-lighting");
  const translucencyInput = document.querySelector("#effect-translucency");
  const fogInput = document.querySelector("#effect-fog");
  const skyAtmosphereInput = document.querySelector("#effect-sky-atmosphere");
  const shadowsInput = document.querySelector("#effect-shadows");
  const depthTestInput = document.querySelector("#effect-depth-test");

  viewer.scene.globe.enableLighting = terrainLightingInput?.checked ?? false;
  viewer.scene.shadows = shadowsInput?.checked ?? false;
  viewer.scene.globe.depthTestAgainstTerrain = (depthTestInput?.checked ?? true) && hasTerrain && undergroundTransparency === 0;
  viewer.scene.globe.translucency.enabled = (translucencyInput?.checked ?? false) || globeHidden;
  if (viewer.scene.fog) viewer.scene.fog.enabled = fogInput?.checked ?? true;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = (skyAtmosphereInput?.checked ?? true) && !globeHidden;
}

function getCesiumTilesetOptions() {
  const sseInput = document.querySelector("#cesium-sse");
  const memoryInput = document.querySelector("#cesium-max-memory");
  const sse = sseInput ? Number(sseInput.value) : 16;
  const maximumMemoryUsage = memoryInput ? Number(memoryInput.value) : 2048;
  return {
    maximumScreenSpaceError: Number.isFinite(sse) && sse >= 0 ? sse : 16,
    maximumMemoryUsage: Number.isFinite(maximumMemoryUsage) && maximumMemoryUsage >= 0 ? maximumMemoryUsage : 2048,
    dynamicScreenSpaceError: document.querySelector("#cesium-dynamic-sse")?.checked ?? false,
    cullWithChildrenBounds: document.querySelector("#cesium-cull-children")?.checked ?? true,
    preferLeaves: document.querySelector("#cesium-prefer-leaves")?.checked ?? false,
    skipLevelOfDetail: document.querySelector("#cesium-skip-lod")?.checked ?? true,
  };
}

function cartesianToDegrees(cartesian) {
  try {
    const c = Cesium.Cartographic.fromCartesian(cartesian);
    return { lat: c.latitude * 180 / Math.PI, lng: c.longitude * 180 / Math.PI };
  } catch (e) { return null; }
}

function getEntityPosition(entity) {
  try {
    const time = viewer.clock && viewer.clock.currentTime;
    if (entity.position) {
      const pos = entity.position.getValue(time);
      if (pos) return pos;
    }
    if (entity.polygon) {
      const hierarchy = entity.polygon.hierarchy.getValue(time);
      const positions = hierarchy && hierarchy.positions;
      if (positions && positions.length) {
        let sum = new Cesium.Cartesian3(0, 0, 0);
        for (const p of positions) sum = Cesium.Cartesian3.add(sum, p, sum);
        return Cesium.Cartesian3.divideByScalar(sum, positions.length, new Cesium.Cartesian3());
      }
    }
    if (entity.polyline) {
      const positions = entity.polyline.positions.getValue(time);
      if (positions && positions.length) {
        let sum = new Cesium.Cartesian3(0, 0, 0);
        for (const p of positions) sum = Cesium.Cartesian3.add(sum, p, sum);
        return Cesium.Cartesian3.divideByScalar(sum, positions.length, new Cesium.Cartesian3());
      }
    }
  } catch (e) {}
  return null;
}

// 1地物分の properties を検索索引へ登録する。getDeg は新規値のときだけ呼ぶ遅延評価。
// 位置情報には layerId を持たせ、「全選択」検索の結果から所属レイヤーを特定できるようにする
function indexVectorFeatureProps(props, getDeg, attrSet, valuesMap, featureMap, allFeatureMap, layerId) {
  for (const key of Object.keys(props)) {
    const raw = props[key];
    if (raw == null || raw === "") continue;
    const val = (typeof raw === "object") ? JSON.stringify(raw) : String(raw);
    attrSet.add(key);
    if (!valuesMap[key]) valuesMap[key] = new Set();
    if (!valuesMap[key].has(val)) {
      valuesMap[key].add(val);
      if (!featureMap[key]) featureMap[key] = {};
      if (!featureMap[key][val]) {
        const deg = getDeg();
        if (deg && Number.isFinite(deg.lat) && Number.isFinite(deg.lng)) {
          const pos = { lat: deg.lat, lng: deg.lng, layerId };
          featureMap[key][val] = pos;
          if (!allFeatureMap[key]) allFeatureMap[key] = {};
          if (!allFeatureMap[key][val]) allFeatureMap[key][val] = pos;
        }
      }
    }
  }
}

// GeoJSON Feature から代表点(頂点座標の平均)を取り出す。primitive 描画レイヤーの索引用
function geoJsonFeatureDegrees(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  let count = 0, lng = 0, lat = 0;
  const walk = coords => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") { lng += coords[0]; lat += coords[1] || 0; count++; return; }
    coords.forEach(walk);
  };
  if (geom.type === "GeometryCollection") (geom.geometries || []).forEach(g => walk(g?.coordinates));
  else walk(geom.coordinates);
  return count ? { lat: lat / count, lng: lng / count } : null;
}

function buildVectorSearchIndex() {
  vectorSearchData = { all: { attributes: [], valuesByAttr: {}, featureByAttr: {} }, layers: {}, layerOptions: [] };
  const time = viewer.clock && viewer.clock.currentTime;
  const allAttrSet = new Set();
  const allValuesMap = {};
  const allFeatureMap = {};
  const commitLayerIndex = (id, title, attrSet, valuesMap, featureMap) => {
    const layerInfo = { title, attributes: [...attrSet].sort((a, b) => a.localeCompare(b)), valuesByAttr: {}, featureByAttr: {} };
    for (const attr of layerInfo.attributes) {
      layerInfo.valuesByAttr[attr] = [...valuesMap[attr]].sort((a, b) => a.localeCompare(b));
      layerInfo.featureByAttr[attr] = featureMap[attr] || {};
    }
    vectorSearchData.layers[id] = layerInfo;
    if (layerInfo.attributes.length) vectorSearchData.layerOptions.push({ id, title });
    for (const attr of layerInfo.attributes) {
      allAttrSet.add(attr);
      if (!allValuesMap[attr]) allValuesMap[attr] = new Set();
      for (const val of layerInfo.valuesByAttr[attr]) allValuesMap[attr].add(val);
    }
  };
  for (const { ds, id, title } of vectorDataSources) {
    // クエリ系レイヤー(duckdb:/sql:)は読み込み済み行だけの索引になるため対象外とし、
    // 検索は常にファイル全件を対象とする SQL フィルター(⏷)に一本化する
    const layerItem = layerState.get(id);
    const layerDecoder = layerItem && vectorDecoders.get(layerItem.type);
    if (isQueryDecoder(layerDecoder, layerItem)) continue;
    const attrSet = new Set();
    const valuesMap = {};
    const featureMap = {};
    try {
      // 件数上限で描画が切り捨てられたレイヤーも全件を検索対象にするため、
      // フルソース(item.geojsonSource)があれば描画済み entity ではなくそちらを索引する
      const fullSource = layerItem.geojsonSource;
      if (fullSource?.features?.length) {
        for (const feature of fullSource.features) {
          const props = feature?.properties;
          if (!props) continue;
          let cachedDeg;
          const getDeg = () => cachedDeg === undefined ? (cachedDeg = geoJsonFeatureDegrees(feature)) : cachedDeg;
          indexVectorFeatureProps(props, getDeg, attrSet, valuesMap, featureMap, allFeatureMap, id);
        }
      } else {
        for (const entity of ds.entities.values) {
          const props = (entity.properties && entity.properties.getValue) ? entity.properties.getValue(time) : (entity.properties || {});
          if (!props) continue;
          let cachedDeg;
          const getDeg = () => cachedDeg === undefined
            ? (cachedDeg = (() => { const c = getEntityPosition(entity); return c ? cartesianToDegrees(c) : null; })())
            : cachedDeg;
          indexVectorFeatureProps(props, getDeg, attrSet, valuesMap, featureMap, allFeatureMap, id);
        }
      }
    } catch (e) {}
    commitLayerIndex(id, title, attrSet, valuesMap, featureMap);
  }
  // primitive 描画(GeoJsonPrimitive)レイヤーは entity 非経由のため vectorDataSources に
  // 載らないが、描画時に保持した GeoJSON(item.geojsonSource)から索引する。
  // 検索パネルで選択されてオンデマンド読み込みされた未ロードレイヤー
  // (vectorSearchLoadedSources)も同じ経路で索引する。
  // クエリ系(duckdb:/sql:)は設計上対象外(検索は全件対象の SQL フィルターに一本化)
  const indexedIds = new Set(vectorDataSources.map(v => v.id));
  for (const id of layerOrder) {
    const item = layerState.get(id);
    const source = item && (item.geojsonSource || vectorSearchLoadedSources.get(id));
    if (!item || indexedIds.has(id) || !source?.features?.length) continue;
    const layerDecoder = vectorDecoders.get(item.type);
    if (isQueryDecoder(layerDecoder, item)) continue;
    const attrSet = new Set();
    const valuesMap = {};
    const featureMap = {};
    try {
      for (const feature of source.features) {
        const props = feature?.properties;
        if (!props) continue;
        let cachedDeg;
        const getDeg = () => cachedDeg === undefined ? (cachedDeg = geoJsonFeatureDegrees(feature)) : cachedDeg;
        indexVectorFeatureProps(props, getDeg, attrSet, valuesMap, featureMap, allFeatureMap, id);
      }
    } catch (e) {}
    commitLayerIndex(id, item.title || item.sourceTitle || id, attrSet, valuesMap, featureMap);
  }
  vectorSearchData.all.attributes = [...allAttrSet].sort((a, b) => a.localeCompare(b));
  for (const attr of vectorSearchData.all.attributes) {
    vectorSearchData.all.valuesByAttr[attr] = [...allValuesMap[attr]].sort((a, b) => a.localeCompare(b));
    vectorSearchData.all.featureByAttr[attr] = allFeatureMap[attr] || {};
  }
  // クエリ系レイヤー(duckdb:/sql:)は検索索引には載せない(検索は全件対象の SQL
  // フィルターに一本化)。属性値一覧の選択肢は索引ではなくレイヤー一覧から
  // 直接構築されるため、ここでは登録しない
}

// 表示中(visible)の索引済みレイヤーIDを返す。「表示レイヤ」検索の対象
// (表示中レイヤーは描画のために必ずロード済みなので索引にも載っている)
function getVisibleIndexedLayerIds() {
  return Object.keys((vectorSearchData && vectorSearchData.layers) || {}).filter(id => {
    const item = layerState.get(id);
    return item && item.visible;
  });
}

// 複数レイヤーの索引を1つのソース(attributes/valuesByAttr/featureByAttr)に集約する
function aggregateVectorSources(layerIds) {
  const attrSet = new Set();
  const valuesMap = {};
  const featureMap = {};
  for (const id of layerIds) {
    const src = vectorSearchData && vectorSearchData.layers && vectorSearchData.layers[id];
    if (!src) continue;
    for (const attr of src.attributes || []) {
      attrSet.add(attr);
      if (!valuesMap[attr]) valuesMap[attr] = new Set();
      if (!featureMap[attr]) featureMap[attr] = {};
      for (const val of src.valuesByAttr[attr] || []) {
        valuesMap[attr].add(val);
        const pos = src.featureByAttr && src.featureByAttr[attr] && src.featureByAttr[attr][val];
        if (pos && !featureMap[attr][val]) featureMap[attr][val] = pos;
      }
    }
  }
  const attributes = [...attrSet].sort((a, b) => a.localeCompare(b));
  const valuesByAttr = {};
  for (const attr of attributes) valuesByAttr[attr] = [...valuesMap[attr]].sort((a, b) => a.localeCompare(b));
  return { attributes, valuesByAttr, featureByAttr: featureMap };
}

function getCurrentVectorSource() {
  try {
    if (!vectorSearchData) return null;
    const layerSelect = document.querySelector("#vector-layer");
    const layerId = layerSelect ? layerSelect.value : "__all__";
    if (layerId === "__all__") return vectorSearchData.all || null;
    if (layerId === "__visible__") return aggregateVectorSources(getVisibleIndexedLayerIds());
    return (vectorSearchData.layers && vectorSearchData.layers[layerId]) || null;
  } catch (e) { return null; }
}

// 「全選択」検索の実行前に、未ロードの非クエリ系ベクターレイヤーをすべて読み込んで
// 索引する。読み込みは検索の実行時のみ(選択しただけでは読まない)。失敗レイヤーは
// vectorSearchLoadFailed で再試行を抑止する。読み込みが発生した場合 true を返す
async function ensureAllVectorSourcesIndexed() {
  const pending = getVectorSearchPendingLayers().filter(item => !vectorSearchLoadFailed.has(item.id));
  if (!pending.length) return false;
  const statusEl = document.querySelector("#vector-search-status");
  if (statusEl) statusEl.textContent = t("common.loading");
  await Promise.all(pending.map(async item => {
    try {
      const dec = vectorDecoders.get(item.type);
      const src = await loadVectorSourceCached(item, dec);
      if (src && Array.isArray(src.features)) vectorSearchLoadedSources.set(item.id, src);
    } catch (e) {
      vectorSearchLoadFailed.add(item.id);
      console.warn("[vector-search] layer load failed:", item.id, e);
    }
  }));
  buildVectorSearchIndex();
  updateVectorSearchUI();
  return true;
}

// 検索パネルのレイヤー選択肢に出す未ロード(未索引)レイヤー。
// 索引には載らないが選択肢には出し、実際に選択されたら読み込んで索引する
// (属性値一覧ウィジェットと同じオンデマンド方式)
function getVectorSearchPendingLayers() {
  const indexedIds = new Set(Object.keys((vectorSearchData && vectorSearchData.layers) || {}));
  return getOrderedLayerItems().filter(item => {
    if (indexedIds.has(item.id)) return false;
    const dec = vectorDecoders.get(item.type);
    if (isQueryDecoder(dec, item)) return false;
    return item.type === "geojson" || item.type === "layer" || item.type === "entities" || !!dec;
  });
}

function updateVectorSearchUI() {
  const layerSelect = document.querySelector("#vector-layer");
  const attrSelect = document.querySelector("#vector-attr");
  const valueSelect = document.querySelector("#vector-value");
  const flyBtn = document.querySelector("#vector-fly-btn");
  const status = document.querySelector("#vector-search-status");
  const data = vectorSearchData;
  if (!layerSelect) return;
  // クエリ系レイヤー(duckdb:/sql:)は読み込み済み行の索引が作れないため検索パネルには出さない
  // (検索は全件対象の SQL フィルターに一本化。索引には非クエリ系しか登録されない)
  const opts = (data && data.layerOptions) || [];
  const pending = getVectorSearchPendingLayers();
  const prevValue = layerSelect.value;
  const unloadedSuffix = t("vector.unloadedSuffix");
  let html = '<option value="__all__">' + escapeHtml(t("common.all")) + '</option>';
  html += '<option value="__visible__">' + escapeHtml(t("vector.visibleLayers")) + '</option>';
  for (const o of opts) {
    html += '<option value="' + escapeHtml(String(o.id)) + '">' + escapeHtml(o.title || o.id) + '</option>';
  }
  for (const o of pending) {
    html += '<option value="' + escapeHtml(String(o.id)) + '">' + escapeHtml((o.title || o.id) + unloadedSuffix) + '</option>';
  }
  layerSelect.innerHTML = html;
  if (prevValue && [...layerSelect.options].some(o => o.value === prevValue)) layerSelect.value = prevValue;
  layerSelect.disabled = (opts.length === 0 && pending.length === 0);
  if (attrSelect) {
    attrSelect.innerHTML = '<option value="__all__">' + escapeHtml(t("common.all")) + '</option>';
    attrSelect.disabled = true;
  }
  if (valueSelect) {
    valueSelect.innerHTML = '<option value="">' + escapeHtml(t("vector.valuePlaceholder")) + '</option>';
    valueSelect.disabled = true;
  }
  if (flyBtn) flyBtn.disabled = true;
  if (status) status.textContent = (data && data.all && data.all.attributes.length) ? t("vector.status.loaded", { count: data.all.attributes.length }) : t("vector.status.none");
  if (layerSelect && !layerSelect.disabled) {
    try { layerSelect.dispatchEvent(new Event("change")); } catch (e) {}
  }
  // 属性値一覧ウィジェットのレイヤー選択肢も索引に追従させる
  uiHooks.refreshVectorAttrWidget?.();
}

// WKB→GeoJSON・属性値の正規化・SQL クォートは vector-decode.js に集約し、
// gpkg-worker.js(Web Worker)からも import する。
// geoparquet:/flatgeobuf:/csv:/tsv: の全件デコードは shared/vector-load.js の
// 共通ローダーへ一本化(プレイヤー系エンジンと同一実装)

// GeoPackage の読み込みは gpkg-worker.js(module Worker)に委譲する。
// sql.js(SQLite WASM)の初期化・ファイル全体の fetch・WKB→GeoJSON デコードが
// すべて別スレッドで走るため、大量地物でも地図操作をブロックしない。
// Worker は開いた DB を url キーで保持するので、bbox=auto の表示範囲
// 再クエリや属性一覧のクエリは再ダウンロード無しで実行できる
let gpkgWorker = null;
let gpkgWorkerReqId = 0;
const gpkgWorkerPending = new Map();
function loadGpkgWorker() {
  if (!gpkgWorker) {
    // baseURI 基準で解決する(location.origin だと GitHub Pages の
    // /<repo>/<channel>/cesium/ 配下で /shared/ へ飛んで 404 になる)
    gpkgWorker = new Worker(new URL("../shared/gpkg-worker.js", document.baseURI), { type: "module" });
    gpkgWorker.onmessage = event => {
      const data = event.data || {};
      const pending = gpkgWorkerPending.get(data.reqId);
      if (!pending) return;
      gpkgWorkerPending.delete(data.reqId);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data);
    };
    gpkgWorker.onerror = event => {
      const error = new Error(event.message || "gpkg-worker の実行に失敗しました");
      for (const pending of gpkgWorkerPending.values()) pending.reject(error);
      gpkgWorkerPending.clear();
      // 起動失敗した Worker を保持し続けると以後の呼出が永久に応答無し
      // (loading 固着)になるため破棄して次回作り直せるようにする
      try { gpkgWorker.terminate(); } catch (e) { /* ignore */ }
      gpkgWorker = null;
    };
  }
  return gpkgWorker;
}
function gpkgWorkerCall(cmd, params = {}) {
  return new Promise((resolve, reject) => {
    const reqId = ++gpkgWorkerReqId;
    gpkgWorkerPending.set(reqId, { resolve, reject });
    loadGpkgWorker().postMessage({ cmd, reqId, ...params });
  });
}
// インスペクター/プロジェクト変更時に Worker が保持する DB を破棄する
function resetGpkgWorkerDbs() {
  if (gpkgWorker) gpkgWorker.postMessage({ cmd: "reset", reqId: 0 });
}

// gpkg:/geopackage: 行、または duckdb: で .gpkg/format=gpkg を指すレイヤーは
// DuckDB ではなく sql.js(Worker)経路で読まれる
function isGpkgBackedItem(item) {
  if (!item) return false;
  if (item.type === "gpkg" || item.type === "geopackage") return true;
  if (item.type === "duckdb") {
    const format = String(item.format || "").toLowerCase();
    return format === "gpkg" || /\.gpkg([?#]|$)/i.test(item.url || "");
  }
  return false;
}

// GeoPackage(.gpkg)を Worker 内の sql.js で読み GeoJSON 化する。
// table= で地物テーブルを指定、省略時は gpkg_geometry_columns の先頭テーブル。
// where=/limit=/columns= は SQL の絞り込み、bbox=auto は GPkgBinary
// エンベロープによる表示範囲フィルター(item.bboxBounds に現在の表示範囲)。
// QGIS が「データベースに保存」したスタイル(layer_styles テーブルの QML)があれば
// useAsDefault を優先してコンパイルし item.qmlStyle に保持する
// (style= 明示指定があるときはそちらを優先し埋め込みは使わない)
async function loadGeoPackageAsGeoJson(item) {
  const res = await gpkgWorkerCall("load", {
    url: proxyFetchUrl(item.url, item.proxy),
    table: item.gpkgTable || null,
    where: item.where || null,
    limit: item.limit || null,
    columns: item.columns || null,
    bbox: item.bboxAuto ? item.bboxBounds : null,
    wantStyle: !item.styleUrl && !item.qmlStyle,
  });
  if (res.total != null) {
    console.info(`[gpkg] ${item.title}: 検索ヒット全 ${res.total} 件 / 表示範囲内 ${res.count} 件`);
  }
  if (res.qml) {
    const style = compileQmlStyle(res.qml, item.url);
    item.qmlStyle = style;
    if (style?.warnings?.length) console.warn(`GPKG 埋め込みスタイル (${item.url}):`, style.warnings.join(" / "));
  }
  return res.geojson;
}

// 属性値一覧ウィジェット用: クエリ系扱いの GPKG レイヤーの属性行を Worker 内の
// DB に直接クエリして取得する。表示用の絞り込み(bbox/limit)は適用せず、
// where= の全件を対象にする(検索は常に全件検索の方針)
async function queryGpkgAttributeRows(item, searchText) {
  const res = await gpkgWorkerCall("attrs", {
    url: proxyFetchUrl(item.url, item.proxy),
    table: item.gpkgTable || null,
    where: item.where || null,
    columns: item.columns || null,
    searchText: searchText || "",
  });
  return { attributes: res.attributes, rows: res.rows };
}

// DuckDB-WASM を CDN から遅延ロードし、SQL で絞り込んでから GeoJSON 化する重い経路。
// hyparquet より重い代わりに WHERE/LIMIT/列選択・空間述語・CSV/JSON 等の
// 複数フォーマットを1エンジンで扱える。Worker は jsdelivr を直指定すると
// cross-origin で起動できないため blob + importScripts で包む。
// CDN 資産(~60MB: 本体wasm+拡張)は sw-duckdb.js(Service Worker)が
// CacheStorage に永続キャッシュするため、実際のダウンロードはバージョンごとに初回のみ
const DUCKDB_WASM_VERSION = "1.32.0";
// Service Worker(sw-duckdb.js)の CacheStorage に本体 wasm が既にあれば
// 初期化のダウンロードは実質無料(ディスク読み込み)とみなせる
async function duckDbAssetsCached() {
  try {
    if (!("caches" in window)) return false;
    const keys = await caches.open("kasugai-duckdb-wasm").then(c => c.keys());
    return keys.some(request => /duckdb-(eh|mvp|coi)\.wasm/.test(request.url));
  } catch (e) { return false; }
}

let duckDbLoaderPromise = null;
function loadDuckDb() {
  if (!duckDbLoaderPromise) {
    const loading = (async () => {
      const duckdb = await import(`https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION}/+esm`);
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(bundle.mainWorker)});`], { type: "text/javascript" }));
      const worker = new Worker(workerUrl);
      const logger = duckdb.VoidLogger ? new duckdb.VoidLogger() : new duckdb.ConsoleLogger();
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      const conn = await db.connect();
      // 拡張ロードはネットワーク取得を伴うため失敗を許容し、可能な範囲で動作する
      try { await conn.query("INSTALL httpfs; LOAD httpfs;"); } catch (error) { console.warn("DuckDB httpfs 拡張の読み込みに失敗:", error); }
      let spatial = false;
      try {
        await conn.query("INSTALL spatial; LOAD spatial;");
        spatial = true;
      } catch (error) {
        console.warn("DuckDB spatial 拡張の読み込みに失敗。WKB/GeoJSONテキストのパススルーのみで動作します:", error);
      }
      // parquet はほぼ必須のため先に入れておく(autoload による途中停止を避ける)
      try { await conn.query("INSTALL parquet; LOAD parquet;"); } catch (error) { /* autoload に任せる */ }
      console.info(`[duckdb] 初期化完了 (spatial: ${spatial})`);
      return { conn, spatial };
    })();
    // 初期化に失敗した Promise は保持せず、次回呼び出しでリトライできるようにする
    loading.catch(() => { if (duckDbLoaderPromise === loading) duckDbLoaderPromise = null; });
    duckDbLoaderPromise = loading;
  }
  return duckDbLoaderPromise;
}

// quoteSqlIdent/quoteSqlLiteral は vector-decode.js から import(Worker と共有)

// DESCRIBE で列名と型(大文字)の一覧を取得する
async function describeDuckDbColumns(conn, selectSql) {
  const table = await conn.query(`DESCRIBE ${selectSql}`);
  return table.toArray().map(row => {
    const plain = typeof row.toJSON === "function" ? row.toJSON() : { ...row };
    return { name: String(plain.column_name), type: String(plain.column_type || "").toUpperCase() };
  });
}

// 結果列からジオメトリ列を推定する。優先順: geom= 指定 > GEOMETRY型 > 慣用名 > BLOB列
function resolveDuckDbGeometryColumn(columns, geomName) {
  if (geomName) {
    const col = columns.find(c => c.name === geomName);
    if (!col) throw new Error(`geom= で指定した列が見つかりません: ${geomName}`);
    return col;
  }
  return columns.find(c => c.type.includes("GEOMETRY") || c.type.includes("WKB"))
    || columns.find(c => /^(geometry|geom|wkb|the_geom)$/i.test(c.name))
    || columns.find(c => c.type === "BLOB")
    || null;
}

// 経度・緯度列を解決する(lon=/lat= 指定または慣用名の自動検出)
function resolveDuckDbLonLat(columns, lonName, latName) {
  const find = (explicit, re) => {
    if (explicit) {
      if (!columns.some(c => c.name === explicit)) throw new Error(`指定した列が見つかりません: ${explicit}`);
      return explicit;
    }
    return columns.find(c => re.test(c.name))?.name || null;
  };
  const lon = find(lonName, /^(lon|lng|longitude)$/i);
  const lat = find(latName, /^(lat|latitude)$/i);
  if ((lon || lat) && !(lon && lat)) throw new Error("経度・緯度の列を両方特定できません(lon=/lat= で指定してください)");
  return lon && lat ? { lon, lat } : null;
}

// ジオメトリ列を GEOMETRY 型として取り出す式(spatial 拡張が必要)。WHERE 句の述語にも使う
function duckDbGeometryCastExpr(col) {
  const name = quoteSqlIdent(col.name);
  if (col.type.includes("GEOMETRY")) return name;
  // WKB は環境により BLOB / WKB_BLOB 型で返るため両方を対象にする
  if (col.type === "BLOB" || col.type.includes("WKB")) return `TRY(ST_GeomFromWKB(${name}))`;
  return `COALESCE(TRY(ST_GeomFromText(${name})), TRY(ST_GeomFromGeoJSON(${name})))`;
}

// ジオメトリ列を取り出す SELECT 式を組み立てる。spatial 拡張があれば WKB バイナリ化して返し
// (テキストシリアライズと JSON.parse の往復を避ける)、無ければ生値を返して JS 側の
// WKB/GeoJSON テキストパースに委ねる
function duckDbGeometryExpr(col, spatial) {
  if (!spatial) return quoteSqlIdent(col.name);
  return `ST_AsWKB(${duckDbGeometryCastExpr(col)})`;
}

// 表示範囲連動フィルター(bbox=auto / :bbox プレースホルダ)が有効なレイヤーか
function isViewportQueryLayer(item) {
  return !!item && (((item.type === "duckdb" || isGpkgBackedItem(item)) && item.bboxAuto) || (item.type === "sql" && /:bbox\b/i.test(item.query || "")));
}

const DUCKDB_WORLD_ENVELOPE = "ST_MakeEnvelope(-180, -90, 180, 90)";
let duckDbBBoxWarned = false;

// 現在の表示範囲を経度範囲配列として返す(日付変更線またぎは2区間)。
// covering bbox 列への範囲述語(row group 統計スキップ)に使う
function getViewRanges() {
  const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rect) return null;
  const normLon = deg => {
    const lon = ((deg + 180) % 360 + 360) % 360 - 180;
    return lon === -180 ? 180 : lon;
  };
  const west = normLon(Cesium.Math.toDegrees(rect.west));
  const east = normLon(Cesium.Math.toDegrees(rect.east));
  const south = Math.max(-89.9, Math.min(89.9, Cesium.Math.toDegrees(rect.south)));
  const north = Math.max(-89.9, Math.min(89.9, Cesium.Math.toDegrees(rect.north)));
  // west === east は ±180 が両端に丸まる全球表示の退化ケース(幅ゼロになるのを防ぐ)
  const ranges = west === east ? [{ west: -180, east: 180 }]
    : west < east ? [{ west, east }]
    : [{ west, east: 180 }, { west: -180, east }];
  return { ranges, south, north };
}

// 現在の表示範囲を ST_MakeEnvelope の SQL 式として返す。日付変更線またぎは2分割の UNION にする
function getViewEnvelopeSql() {
  const bounds = getViewRanges();
  if (!bounds) return null;
  const env = r => `ST_MakeEnvelope(${r.west}, ${bounds.south}, ${r.east}, ${bounds.north})`;
  return bounds.ranges.length === 1 ? env(bounds.ranges[0]) : `ST_Union(${env(bounds.ranges[0])}, ${env(bounds.ranges[1])})`;
}

// 表示範囲連動レイヤーのフィルター状態を現在のカメラ範囲で更新する
function updateViewportFilter(item) {
  item.bboxFilter = getViewEnvelopeSql() || DUCKDB_WORLD_ENVELOPE;
  item.bboxBounds = getViewRanges();
}

// covering bbox 列への範囲述語を組み立てる(row group の min/max 統計による読み飛ばしが効く)
function duckDbCoveringPredicate(refs, bounds) {
  if (!bounds) return null;
  const lon = bounds.ranges.map(r => `(${refs.xmax} >= ${r.west} AND ${refs.xmin} <= ${r.east})`).join(" OR ");
  return `((${lon}) AND ${refs.ymax} >= ${bounds.south} AND ${refs.ymin} <= ${bounds.north})`;
}

// GeoParquet 1.1 covering.bbox 列を parquet_kv_metadata の geo メタデータから検出する
async function detectDuckDbCoveringFromMetadata(conn, url) {
  try {
    const table = await conn.query(`SELECT key, value FROM parquet_kv_metadata(${quoteSqlLiteral(url)}) WHERE key = 'geo'`);
    const row = table.toArray()[0];
    if (!row) return null;
    const raw = row.value;
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
    const geo = JSON.parse(text);
    const covering = geo?.columns?.[geo.primary_column]?.covering?.bbox;
    if (!covering) return null;
    const ref = path => Array.isArray(path) && path.length ? path.map(quoteSqlIdent).join(".") : null;
    const refs = { xmin: ref(covering.xmin), xmax: ref(covering.xmax), ymin: ref(covering.ymin), ymax: ref(covering.ymax) };
    if (!refs.xmin || !refs.xmax || !refs.ymin || !refs.ymax) return null;
    // covering のルート列は表示用属性ではないため出力から除く
    const exclude = new Set([covering.xmin, covering.xmax, covering.ymin, covering.ymax].map(p => Array.isArray(p) ? p[0] : null).filter(Boolean));
    return { refs, exclude };
  } catch { return null; }
}

// covering bbox 列を解決する。優先順: covering= 明示指定 > geo メタデータ > 慣用名 xmin/xmax/ymin/ymax
async function resolveDuckDbCoveringColumns(conn, item, columns) {
  if (Array.isArray(item.covering) && item.covering.length === 4) {
    const [xmin, xmax, ymin, ymax] = item.covering;
    return { refs: { xmin: quoteSqlIdent(xmin), xmax: quoteSqlIdent(xmax), ymin: quoteSqlIdent(ymin), ymax: quoteSqlIdent(ymax) }, exclude: new Set(item.covering) };
  }
  const format = String(item.format || "").toLowerCase();
  const isParquet = format === "parquet" || (!format && /\.parquet([?#]|$)/i.test(item.url || ""));
  if (isParquet) {
    const detected = await detectDuckDbCoveringFromMetadata(conn, item.url);
    if (detected) return detected;
  }
  const find = name => columns.find(c => c.name.toLowerCase() === name)?.name;
  if (["xmin", "xmax", "ymin", "ymax"].every(n => find(n))) {
    return { refs: { xmin: quoteSqlIdent(find("xmin")), xmax: quoteSqlIdent(find("xmax")), ymin: quoteSqlIdent(find("ymin")), ymax: quoteSqlIdent(find("ymax")) }, exclude: new Set() };
  }
  return null;
}

// DuckDB の行値から GeoJSON ジオメトリを取り出す
// (WKBバイナリ / 既にオブジェクト化済みのジオメトリ / GeoJSONテキスト を受理)
function duckDbValueToGeometry(value) {
  if (value instanceof Uint8Array) return wkbToGeoJsonGeometry(value);
  if (value && typeof value === "object" && typeof value.type === "string" && ("coordinates" in value || "geometries" in value)) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{")) {
      try {
        const geom = JSON.parse(text);
        return geom && typeof geom.type === "string" ? geom : null;
      } catch { return null; }
    }
  }
  return null;
}

// Arrow Table の行を GeoJSON FeatureCollection に変換する。
// __geom__ 列をジオメトリとして使い、lonlat 指定時は JS 側で Point を生成する
function duckDbTableToGeoJson(table, lonlat) {
  const fields = table.schema.fields.map(field => field.name);
  const geomKey = fields.includes("__geom__") ? "__geom__" : null;
  const features = [];
  for (const row of table.toArray()) {
    let geometry = geomKey ? duckDbValueToGeometry(row[geomKey]) : null;
    if (!geometry && lonlat) {
      const x = Number(row[lonlat.lon]);
      const y = Number(row[lonlat.lat]);
      if (Number.isFinite(x) && Number.isFinite(y)) geometry = { type: "Point", coordinates: [x, y] };
    }
    if (!geometry) continue;
    const properties = {};
    for (const name of fields) {
      if (name === geomKey) continue;
      properties[name] = sanitizeVectorPropertyValue(row[name]);
    }
    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

// duckdb: のソース SQL 式(format= または拡張子から自動判別)
// proxy=on 時はローカルサーバーの /api/fetch 経由に書き換える(Range 転送対応)
function duckDbSourceSql(item) {
  const literal = quoteSqlLiteral(proxyFetchUrl(item.url, item.proxy));
  const format = String(item.format || "").toLowerCase();
  return format === "parquet" ? `read_parquet(${literal})` :
    format === "csv" || format === "tsv" ? `read_csv_auto(${literal})` :
    format === "json" || format === "geojson" ? `read_json_auto(${literal})` :
    format === "read" ? `ST_Read(${literal})` :
    literal; // 省略時は拡張子から自動判別(置換スキャン)
}

// duckdb: レイヤー。単一ファイルを読み、where=/limit= で絞り込んでから描画する
async function loadDuckDbLayerAsGeoJson(item) {
  // .gpkg は ST_Read が非COI環境でスレッド生成に失敗するため sql.js 経路へ振り分ける。
  // layer_styles(QGIS 埋め込みスタイル)の取得もこの経路で行う
  const format = String(item.format || "").toLowerCase();
  if (format === "gpkg" || /\.gpkg([?#]|$)/i.test(item.url || "")) {
    return loadGeoPackageAsGeoJson(item);
  }
  const { conn, spatial } = await loadDuckDb();
  const source = duckDbSourceSql(item);
  const columns = await describeDuckDbColumns(conn, `SELECT * FROM ${source}`);
  const geomCol = resolveDuckDbGeometryColumn(columns, item.geom);
  const lonlat = geomCol ? null : resolveDuckDbLonLat(columns, item.lon, item.lat);
  if (!geomCol && !lonlat) throw new Error("ジオメトリ列が見つかりません(geom= または lon=/lat= で指定できます)");
  // covering bbox 列(GeoParquet 1.1)があれば xmin/xmax/ymin/ymax の範囲述語で
  // row group 統計スキップが効く。表示範囲フィルター指定時のみ解決する
  const covering = item.bboxFilter ? await resolveDuckDbCoveringColumns(conn, item, columns) : null;
  if (item.columns?.length) {
    const missing = item.columns.filter(name => !columns.some(c => c.name === name));
    if (missing.length) throw new Error(`columns= の列が見つかりません: ${missing.join(", ")}`);
  }
  const geomExpr = geomCol ? `${duckDbGeometryExpr(geomCol, spatial)} AS "__geom__"` : null;
  const excludeCols = geomCol ? [geomCol.name, ...(covering ? [...covering.exclude] : [])] : [];
  const select = geomCol
    ? (item.columns?.length
        ? `SELECT ${item.columns.map(quoteSqlIdent).join(", ")}, ${geomExpr}`
        : `SELECT * EXCLUDE (${excludeCols.map(quoteSqlIdent).join(", ")}), ${geomExpr}`)
    : "SELECT *";
  const predicates = [];
  if (item.where) predicates.push(`(${item.where})`);
  // 表示範囲連動フィルター(bbox=auto): covering 列があれば統計スキップ可能な範囲述語で先に絞り、
  // spatial があれば ST_Intersects で精密判定する。covering のみでも近似フィルターとして機能する
  if (item.bboxFilter) {
    const coveringPred = covering ? duckDbCoveringPredicate(covering.refs, item.bboxBounds) : null;
    if (coveringPred) predicates.push(coveringPred);
    const operand = geomCol
      ? (spatial ? duckDbGeometryCastExpr(geomCol) : null)
      : (spatial ? `ST_Point(${quoteSqlIdent(lonlat.lon)}, ${quoteSqlIdent(lonlat.lat)})` : null);
    if (operand) predicates.push(`ST_Intersects(${operand}, ${item.bboxFilter})`);
    else if (!coveringPred && !duckDbBBoxWarned) {
      duckDbBBoxWarned = true;
      console.warn("bbox フィルターには spatial 拡張または covering bbox 列が必要です。全件読み込みで動作します");
    }
  }
  const clauses = [];
  if (predicates.length) clauses.push(`WHERE ${predicates.join(" AND ")}`);
  if (item.limit) clauses.push(`LIMIT ${Math.floor(item.limit)}`);
  const sql = `${select} FROM ${source} ${clauses.join(" ")}`;
  console.info(`[duckdb] ${item.title}: ${sql}`);
  const table = await conn.query(sql);
  const geojson = duckDbTableToGeoJson(table, lonlat);
  console.info(`[duckdb] ${item.title}: ${geojson.features.length} 件`);
  // 検索は常に全件対象: bbox=auto で表示が表示範囲に絞られていても、
  // where= のヒット数は bbox なしの COUNT(*) で全件として数えて併記する
  if (item.bboxFilter && item.where) {
    try {
      const countTable = await conn.query(`SELECT COUNT(*) AS "n" FROM ${source} WHERE (${item.where})`);
      const total = Number(countTable.toArray()[0]?.n ?? 0);
      console.info(`[duckdb] ${item.title}: 検索ヒット全 ${total} 件 / 表示範囲内 ${geojson.features.length} 件`);
    } catch (e) { /* 件数取得は補助情報のため失敗は無視 */ }
  }
  return geojson;
}

// sql: レイヤー。任意の SELECT 文を実行し、結果のジオメトリ列を GeoJSON 化して描画する
function resolveProjectSql(query) {
  const tokens = [...query.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|\$\$[\s\S]*?\$\$|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-zA-Z_][a-zA-Z0-9_]*|[^\s]/g)];
  const readers = /^(?:read_(?:csv(?:_auto)?|json(?:_auto|_objects|_objects_auto)?|ndjson(?:_auto|_objects)?|parquet)|parquet_scan|st_read|st_readosm)$/i;
  const stack = [];
  let previous = "", offset = 0, out = "";
  for (const token of tokens) {
    const value = token[0];
    if (value.startsWith("--") || value.startsWith("/*")) continue;
    const top = stack[stack.length - 1];
    if (value === "(" || value === "[") {
      stack.push({ close: value === "(" ? ")" : "]", files: value === "(" ? readers.test(previous) : !!top?.files });
    } else if (value === ")" || value === "]") {
      stack.pop();
    } else if (value === "," && top?.close === ")") {
      top.files = false;
    } else if ((value.startsWith("'") || value.startsWith('"')) && (top?.files || /^(from|join)$/i.test(previous))) {
      const quote = value[0];
      const path = value.slice(1, -1).replaceAll(quote + quote, quote);
      if (/^(?:\.\/)?(?:\.\.\/)*DATA\//i.test(path)) {
        out += query.slice(offset, token.index) + quoteSqlLiteral(new URL(resolveProjectUrl(path), window.location.href).href);
        offset = token.index + value.length;
      }
    }
    previous = value;
  }
  return out + query.slice(offset);
}

async function loadDuckDbQueryAsGeoJson(item) {
  const { conn, spatial } = await loadDuckDb();
  // サブクエリとして包むため末尾のセミコロンは除去する
  const query = resolveProjectSql(String(item.query || "").replace(/;+\s*$/, ""));
  // :bbox プレースホルダは表示範囲の envelope に置換される(含まれていれば範囲連動レイヤーになる)
  let effectiveQuery = query;
  if (/:bbox\b/i.test(query)) {
    if (!spatial) throw new Error("sql: の :bbox プレースホルダには spatial 拡張が必要です");
    effectiveQuery = query.replace(/:bbox\b/gi, item.bboxFilter || DUCKDB_WORLD_ENVELOPE);
  }
  const columns = await describeDuckDbColumns(conn, `SELECT * FROM (${effectiveQuery})`);
  const geomCol = resolveDuckDbGeometryColumn(columns, null);
  const lonlat = geomCol ? null : resolveDuckDbLonLat(columns, null, null);
  if (!geomCol && !lonlat) throw new Error("クエリ結果にジオメトリ列がありません(ジオメトリ列、または lon/lat 列が必要です)");
  const geomExpr = geomCol ? `${duckDbGeometryExpr(geomCol, spatial)} AS "__geom__"` : null;
  const sql = geomCol
    ? `SELECT * EXCLUDE (${quoteSqlIdent(geomCol.name)}), ${geomExpr} FROM (${effectiveQuery})`
    : `SELECT * FROM (${effectiveQuery})`;
  console.info(`[duckdb] ${item.title}: ${sql}`);
  const table = await conn.query(sql);
  const geojson = duckDbTableToGeoJson(table, lonlat);
  console.info(`[duckdb] ${item.title}: ${geojson.features.length} 件`);
  return geojson;
}

// 属性値一覧ウィジェット用: クエリ系レイヤーの属性行を DuckDB から取得する。
// 表示用の絞り込み(bbox/limit)は適用せず、where=/ユーザークエリの全件を対象にする
// (検索は常に全件検索の方針)。searchText は属性列への ILIKE 検索として SQL に
// 変換する。LIMIT は付けず全件を取得し、表示側(DOM)だけ上限で切る。
// 位置は spatial の ST_Centroid か lon/lat 列から取る
async function queryDuckDbAttributeRows(item, searchText) {
  const { conn, spatial } = await loadDuckDb();
  let inner, columns, geomCol, lonlat;
  if (item.type === "sql") {
    inner = `(${resolveProjectSql(String(item.query || "").replace(/;+\s*$/, "")).replace(/:bbox\b/gi, DUCKDB_WORLD_ENVELOPE)})`;
    columns = await describeDuckDbColumns(conn, `SELECT * FROM ${inner}`);
    geomCol = resolveDuckDbGeometryColumn(columns, null);
    lonlat = geomCol ? null : resolveDuckDbLonLat(columns, null, null);
  } else {
    inner = duckDbSourceSql(item);
    columns = await describeDuckDbColumns(conn, `SELECT * FROM ${inner}`);
    geomCol = resolveDuckDbGeometryColumn(columns, item.geom);
    lonlat = geomCol ? null : resolveDuckDbLonLat(columns, item.lon, item.lat);
  }
  const geomOperand = geomCol && spatial ? duckDbGeometryCastExpr(geomCol) : null;
  const posExpr = geomOperand
    ? `, ST_X(ST_Centroid(${geomOperand})) AS "__lng__", ST_Y(ST_Centroid(${geomOperand})) AS "__lat__"`
    : "";
  const predicates = [];
  if (item.type === "duckdb" && item.where) predicates.push(`(${item.where})`);
  // ウィジェットの検索文字は全属性列への ILIKE 述語に変換し、ファイル全件を対象に検索する
  const covering = item.type === "duckdb" ? await resolveDuckDbCoveringColumns(conn, item, columns) : null;
  const attrCols = item.columns?.length
    ? item.columns.slice()
    : columns.map(c => c.name).filter(name => name !== geomCol?.name && !(covering && covering.exclude.has(name)));
  const needle = String(searchText || "").trim();
  if (needle && attrCols.length) {
    const lit = quoteSqlLiteral(`%${needle}%`);
    predicates.push(`(${attrCols.map(name => `CAST(${quoteSqlIdent(name)} AS VARCHAR) ILIKE ${lit}`).join(" OR ")})`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  let sql;
  if (item.type === "sql") {
    const exclude = geomCol ? `* EXCLUDE (${quoteSqlIdent(geomCol.name)})` : "*";
    sql = `SELECT ${exclude}${posExpr} FROM ${inner}${where}`;
  } else {
    const excludeCols = [geomCol?.name, ...(covering ? [...covering.exclude] : [])].filter(Boolean);
    const select = item.columns?.length
      ? item.columns.map(quoteSqlIdent).join(", ")
      : excludeCols.length ? `* EXCLUDE (${excludeCols.map(quoteSqlIdent).join(", ")})` : "*";
    sql = `SELECT ${select}${posExpr} FROM ${inner}${where}`;
  }
  console.info(`[duckdb] ${item.title} (属性一覧): ${sql}`);
  const table = await conn.query(sql);
  const fields = table.schema.fields.map(f => f.name);
  const attributes = fields.filter(name => name !== "__lng__" && name !== "__lat__");
  const rows = [];
  for (const row of table.toArray()) {
    const values = attributes.map(name => {
      const v = sanitizeVectorPropertyValue(row[name]);
      return v == null ? "" : String(v);
    });
    let lat = null, lng = null;
    if (fields.includes("__lat__") && Number.isFinite(Number(row.__lat__))) { lat = Number(row.__lat__); lng = Number(row.__lng__); }
    else if (lonlat) {
      const x = Number(row[lonlat.lon]), y = Number(row[lonlat.lat]);
      if (Number.isFinite(x) && Number.isFinite(y)) { lng = x; lat = y; }
    }
    rows.push({ values, lat, lng });
  }
  return { attributes, rows };
}

// GeoJSON 正規化経路のデコーダー一覧。新しい形式はここに type→loader を登録し、
// applyInspector の行パースを追加すれば既存のベクター描画経路に乗る。
// query:true は条件変更・再クエリ(フィルターUI/表示範囲連動)に対応した形式
const vectorDecoders = new Map([
  // 全件読み込み系は shared/vector-load.js へ一本化(item.url は解決済みのため baseUrl 不要)。
  // duckdb/sql は Cesium 側の高機能版(proxy=/属性クエリ/covering)を維持する
  ["geoparquet", { load: item => loadVectorItem({ type: "geoparquet", title: item.title, url: item.url }, "").then(r => r.geojson) }],
  ["flatgeobuf", { load: item => loadVectorItem({ type: "flatgeobuf", title: item.title, url: item.url }, "").then(r => r.geojson) }],
  // gpkg: は bbox=auto が既定 ON のため通常はクエリ系(表示範囲連動)になる。
  // bbox=off を明示した場合だけ全件読み込み系としてキャッシュ・検索索引の対象になる
  ["gpkg", { load: item => loadGeoPackageAsGeoJson(item), query: item => !!(item.where || item.limit || item.columns?.length || item.bboxAuto) }],
  ["geopackage", { load: item => loadGeoPackageAsGeoJson(item), query: item => !!(item.where || item.limit || item.columns?.length || item.bboxAuto) }],
  ["duckdb", { load: item => loadDuckDbLayerAsGeoJson(item), query: true }],
  ["sql", { load: item => loadDuckDbQueryAsGeoJson(item), query: true }],
]);

// 非同期ロード中の再入で vectorDataSources/primitives が二重登録されるのを防ぐ。
// 実行中に再度呼ばれた場合は最新状態で最後にもう一度だけやり直す
let refreshLayersRunning = false;
let refreshLayersQueued = false;
// ---- 段階読み込み: 行ステータス・進捗 ----

// レイヤ行のステータス領域を item._loadStatus(loading/failed)へ同期する。
// renderLayerList 全再描画を待たずに行だけ更新する(スクロール・展開状態を維持)
function syncLayerStatusDom(item) {
  const el = document.querySelector(`#layer-list .layer-status[data-layer-id="${CSS.escape(item.id)}"]`);
  if (!el) return;
  el.classList.toggle("loading", item._loadStatus === "loading");
  el.classList.toggle("failed", item._loadStatus === "failed");
  el.textContent = item._loadStatus === "failed" ? t("layer.loadFailed") : "";
  el.title = item._loadError || "";
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
    progressText.textContent = t("layer.loadingDone", { done, total });
    progressHideTimer = setTimeout(() => { progressEl.hidden = true; }, 1200);
  } else {
    // name が無いとき末尾の区切り記号が残らないよう削る
    progressText.textContent = t("layer.loadingProgress", { done, total, name: label || "" }).replace(/\s*—\s*$/, "");
  }
}

async function refreshLayers() {
  if (refreshLayersRunning) { refreshLayersQueued = true; return; }
  refreshLayersRunning = true;
  try {
    do {
      refreshLayersQueued = false;
      await refreshLayersImpl();
    } while (refreshLayersQueued);
    requestRender();
  } finally {
    refreshLayersRunning = false;
  }
}

async function refreshLayersImpl() {
  viewer.imageryLayers.removeAll(false);
  vectorDataSources.forEach(({ ds, plugin }) => { if (!plugin) try { viewer.dataSources.remove(ds, false); } catch (error) { /* ignore */ } });
  vectorDataSources.length = 0;
  vectorAttrLoadCache.clear();
  activeDataSources.length = 0;
  activePrimitives.forEach(primitive => { try { viewer.scene.primitives.remove(primitive); } catch (error) { /* ignore */ } });
  activePrimitives.length = 0;
  layerRuntimeTargets.clear();

  const demSource = terrainEnabled ? demSources[selectedDemSource] : null;
  if (demSource?.url) {
    const terrainUrl = proxyTileUrl(demSource.url);
    try {
      const metadataResponse = await fetch(terrainUrl.replace(/\/$/, "") + "/layer.json", { cache: "no-store" });
      if (!metadataResponse.ok) throw new Error(`layer.json の取得に失敗しました (HTTP ${metadataResponse.status})`);
      const terrainProvider = Cesium.CesiumTerrainProvider.fromUrl
        ? await Cesium.CesiumTerrainProvider.fromUrl(terrainUrl)
        : await new Promise((resolve, reject) => {
            const provider = new Cesium.CesiumTerrainProvider({ url: terrainUrl });
            if (!provider.readyPromise) {
              reject(new Error("CesiumTerrainProvider.readyPromise is unavailable"));
            } else {
              provider.readyPromise.then(() => resolve(provider)).catch(reject);
            }
          });
      viewer.terrainProvider = terrainProvider;
    } catch (error) {
      console.warn("DEM の読み込みに失敗しました:", error);
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
  } else if (demSource?.gsiLayers) {
    try {
      viewer.terrainProvider = new GsiDemTerrainProvider({ layers: demSource.gsiLayers });
    } catch (error) {
      console.warn("地理院 DEM の初期化に失敗しました:", error);
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
  } else {
    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  }

  const drape3DTiles = isDrape3DTilesActive();
  const orderedItems = getOrderedLayerItems();
  const orderedTileLayers = orderedItems.filter(layer => layer.type === "tile").slice().reverse();
  const orderedOtherLayers = orderedItems.filter(layer => layer.type === "3dtiles" || layer.type === "geojson" || layer.type === "layer" || layer.type === "entities" || vectorDecoders.has(layer.type)).slice().reverse();

  // 読込対象(表示中・データ取得が発生するレイヤー)。entities はプラグイン所有で
  // ここでは読み込まないため除外する。進捗ピルと行ステータスの母数
  const loadTargets = new Set(orderedOtherLayers.filter(item =>
    item.visible && item.type !== "entities" &&
    (item.type === "3dtiles" || item.url || item.data || item.query)));
  let loadedCount = 0;
  // 残りの読込対象(直列のため先頭が現在読み込み中)を名前付きで進捗に出す
  const pendingItems = new Set(loadTargets);
  const pendingLabel = () => {
    const names = [...pendingItems].map(i => i.title || i.url || "");
    return names.length ? names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "") : "";
  };
  const layerDone = item => {
    pendingItems.delete(item);
    updateLoadProgress(++loadedCount, loadTargets.size, pendingLabel());
  };
  const layerOk = item => { item._loadStatus = ""; item._loadError = ""; syncLayerStatusDom(item); layerDone(item); };
  const layerFail = (item, err) => { item._loadStatus = "failed"; item._loadError = String(err?.message || err || ""); syncLayerStatusDom(item); layerDone(item); };
  if (loadTargets.size) updateLoadProgress(0, loadTargets.size, pendingLabel());
  else { clearTimeout(progressHideTimer); if (progressEl) progressEl.hidden = true; }

  // クエリ系レイヤー(duckdb:/sql:)があれば DuckDB-WASM の初期化を先行して開始する。
  // CDN 資産は sw-duckdb.js が永続キャッシュするため、キャッシュ済みなら
  // 非表示レイヤーのぶんまで温めても実質無料(選択をほぼ即応答にできる)。
  // 未キャッシュ(=実質初回)は ~60MB の実コストがかかるため、表示対象の
  // クエリ系があるときだけ先行する(非表示は選択・表示ONの時点で初期化される)
  const queryLayers = orderedOtherLayers.filter(item => isQueryDecoder(vectorDecoders.get(item.type), item));
  const duckQueryLayers = queryLayers.filter(item => !isGpkgBackedItem(item));
  if (duckQueryLayers.length) {
    const warmAll = duckQueryLayers.some(item => item.visible) || await duckDbAssetsCached();
    if (warmAll) void loadDuckDb().catch(() => {});
  }
  // GPKG レイヤー(表示中のみ)があれば sql.js Worker を先行初期化する。
  // wasm は ~1MB と軽いため、表示ONの GPKG がある時だけ温める
  if (orderedOtherLayers.some(item => item.visible && isGpkgBackedItem(item))) {
    void gpkgWorkerCall("warm").catch(() => {});
  }

  // 3D Tiles ドレープ用プロバイダー定義
  const drapeProviders = [];
  if (drape3DTiles) {
    if (basemapDrape3DTiles && selectedBasemap?.url) {
      drapeProviders.push({
        url: selectedBasemap.url,
        attribution: selectedBasemap.attribution,
        maximumLevel: selectedBasemap.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
        tileSize: selectedBasemap.tileSize || 256,
        opacity: selectedBasemap.opacity ?? 1.0,
        proxy: selectedBasemap.proxy,
      });
    }
    if (drapeLayers.tiles3d.xyz) {
      orderedTileLayers.filter(t => t.visible).forEach(item => {
        drapeProviders.push({
          url: item.url,
          attribution: item.attribution,
          maximumLevel: item.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
          tileSize: item.tileSize || 256,
          opacity: item.opacity ?? 0.8,
          proxy: item.proxy,
        });
      });
    }
  }

  // Globe 表面のベースマップ
  if (!globeHidden && selectedBasemap?.url) {
    try {
      const provider = createUrlTemplateProvider({
        url: selectedBasemap.url,
        attribution: selectedBasemap.attribution,
        maximumLevel: selectedBasemap.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
        tileSize: selectedBasemap.tileSize || 256,
      });
      basemapImageryLayer = new Cesium.ImageryLayer(provider, { alpha: (selectedBasemap.opacity ?? 1.0) * basemapOpacityFactor });
      basemapImageryLayer._baseAlpha = selectedBasemap.opacity ?? 1.0;
      viewer.imageryLayers.add(basemapImageryLayer);
    } catch (error) {
      console.warn("ベースマップの作成に失敗しました:", error);
    }
  }

  // Globe 表面の XYZ
  for (const item of orderedTileLayers) {
    if (!item.visible) continue;
    if ((drapeTerrainSources.dem || drape3DTiles) && (!drapeLayers.dem.xyz || !drapeTerrainSources.dem)) continue;
    try {
      const provider = createUrlTemplateProvider({
        url: item.url,
        attribution: item.attribution,
        maximumLevel: item.maximumLevel || DEFAULT_MAXIMUM_LEVEL,
        minimumLevel: item.minimumLevel,
        bbox: item.bbox,
        tileSize: item.tileSize || 256,
      });
      const imageryLayer = new Cesium.ImageryLayer(provider, { alpha: (item.opacity ?? 0.8) * layerOpacityFactor });
      imageryLayer._baseAlpha = item.opacity ?? 0.8;
      viewer.imageryLayers.add(imageryLayer);
      layerRuntimeTargets.set(item.id, imageryLayer);
    } catch (error) {
      console.warn("XYZ タイルの作成に失敗しました:", item.url, error);
    }
  }

  // 3D Tiles / GeoJSON
  // entity 描画するベクター地物の合計上限(フリーズ防止)。primitive 経路は消費しない
  let vectorEntityBudget = getVectorEntityLimit();
  for (const item of orderedOtherLayers) {
    // 読込対象の行にスピナーを出す(非表示・entities は対象外)
    const loadTarget = loadTargets.has(item);
    if (loadTarget) { item._loadStatus = "loading"; item._loadError = ""; syncLayerStatusDom(item); }
    if (!item.visible && item.type === "3dtiles") continue;
    if (item.type === "3dtiles") {
      try {
        const tileset = await Cesium.Cesium3DTileset.fromUrl(proxyTileUrl(withGoogleTileKey(item.url), item.proxy), getCesiumTilesetOptions());
        if (drape3DTiles && Array.isArray(drapeProviders) && drapeProviders.length > 0) {
          drapeProviders.forEach(options => {
            try {
              const provider = createUrlTemplateProvider(options);
              const imageryLayer = new Cesium.ImageryLayer(provider, { alpha: options.opacity ?? 0.8 });
              tileset.imageryLayers.add(imageryLayer);
            } catch (drapeError) {
              console.warn("3D Tiles ドレープレイヤー追加失敗:", options.url, drapeError);
            }
          });
        }
        applyClippingPlanes(tileset);
        viewer.scene.primitives.add(tileset);
        activePrimitives.push(tileset);
        layerRuntimeTargets.set(item.id, tileset);
        if (loadTarget) layerOk(item);
      } catch (error) {
        console.warn("3D Tiles の読み込みに失敗しました:", item.url, error);
        if (loadTarget) layerFail(item, error);
      }
    } else if (item.type === "entities") {
      // プラグイン宣言レイヤー: DataSource は本体で所有・refresh をまたいで存続し、
      // ここでは表示状態の反映と属性検索インデックスへの登録だけを行う
      if (!item.dataSource) continue;
      try { item.dataSource.show = item.visible; } catch (e) {}
      vectorDataSources.push({ ds: item.dataSource, id: item.id, title: item.title, plugin: true });
      layerRuntimeTargets.set(item.id, item.dataSource);
      // ロード済みレイヤーから順に検索索引・選択肢を更新する
      buildVectorSearchIndex();
      updateVectorSearchUI();
    } else if (item.type === "geojson" || item.type === "layer" || vectorDecoders.has(item.type)) {
      // 登録済みデコーダー(GeoParquet/DuckDB等)は GeoJSON に変換してから同じ経路に流す
      const decoder = vectorDecoders.get(item.type);
      try {
        if (!item.url && !item.data && !item.query) continue;
        // 対象地形ごとのベクタードレープ指定。両方 false なら null(クランプなし)
        const vectorDrape = getVectorDrapeFlags();
        const primDem = !!vectorDrape?.dem && drapeLayers.dem.primitive;
        const prim3d = !!vectorDrape?.tiles3d && drapeLayers.tiles3d.primitive;
        // 再描画のたびに描画ソース保持をリセットする(primitive/entity 経路で再セット。
        // 非表示レイヤーに古い GeoJSON が残らないようにする)
        item.geojsonSource = null;
        // entity 描画上限の超過表示もリセット(上限適用は entity 経路のみ)
        item.entityLimited = null;
        item.viewportSliced = false;
        // 非表示レイヤーはロードしない(ダウンロード・デコードとも表示ONの
        // refreshLayers まで遅延する)。表示切替は refreshLayers の全再構築で反映
        // されるため、非表示分を先読みしてもトグルは速くならない
        if (!item.visible) continue;
        // 表示範囲連動レイヤーは現在の表示範囲を絞り込み条件としてセットしてからクエリする
        if (decoder && isViewportQueryLayer(item)) updateViewportFilter(item);
        // style= 指定レイヤーは .qml を先に取得・コンパイルする(失敗時は null で通常描画)
        if (item.styleUrl) await ensureQmlStyle(item);
        // レイヤー行の render=primitive はグローバル設定より優先する明示指定で、
        // HeightReference.NONE のバッチ描画にする(CLAMP系は scene.pick で拾えなくなるため)。
        // クエリ系レイヤーはベクター検索パネルに登録しない(検索は全件対象の SQL フィルターに一本化)
        if (item.renderPrimitive && Cesium.GeoJsonPrimitive) {
          const source = await loadVectorSourceCached(item, decoder);
          await addGeoJsonPrimitiveLayer(item, source);
          if (loadTarget) layerOk(item);
          continue;
        }
        // GeoJsonPrimitive ドレープ(実験的グローバル設定): 全件読み込み系ベクターが対象。
        // render= 明示指定のレイヤーとクエリ系(render= で個別指定する形式)は除外する
        const primitiveDrape = (primDem || prim3d) && Cesium.GeoJsonPrimitive && !isQueryDecoder(decoder, item) && !item.renderSpecified;
        const source = await loadVectorSourceCached(item, decoder);
        // fromGeoJson 経路に統一する: ソースは vectorSourceCache の共有取得で二重
        // ダウンロードにならず、保持した GeoJSON が getLayerGeoJson・検索索引に使える
        if (primitiveDrape) {
          const primitive = await Cesium.GeoJsonPrimitive.fromGeoJson(source, { heightReference: primitiveDrapeHeightReference(primDem, prim3d), scene: viewer.scene });
          applyQmlStyleToPrimitive(primitive, item.qmlStyle, item.legendHidden);
          registerPrimitiveLayer(item, primitive, source);
          if (loadTarget) layerOk(item);
          continue;
        }
        // entity 経路でもフルソースを保持する。件数上限で描画を切り捨てても
        // 検索索引・getLayerGeoJson・属性一覧が全件を対象にできるようにする
        item.geojsonSource = source;
        // 非クエリ系でバジェットを超えるレイヤーは表示範囲内の地物を優先して描画する。
        // moveEnd ごとの再スライスで見えている範囲に追従する(クライアント側 bbox=auto 相当)。
        // バジェット内に収まるレイヤーは従来どおり全件描画のまま
        let drawSource = source;
        if (!isQueryDecoder(decoder, item) && Number.isFinite(vectorEntityBudget) && (source?.features?.length ?? 0) > vectorEntityBudget) {
          drawSource = sliceSourceToView(item, source);
          item.viewportSliced = true;
        }
        const limited = limitGeoJsonFeatures(drawSource, vectorEntityBudget, item);
        vectorEntityBudget -= limited.used;
        // 再スライスの同一判定用に今回描画した地物集合を記録する。
        // スライス中のバッジは「描画数/フルソース全件数」で出す(範囲外で0件でも
        // レイヤーにデータが残っていることが分かるようにする)
        if (item.viewportSliced) {
          item.entityLimited = limited.used < source.features.length
            ? { shown: limited.used, total: source.features.length }
            : null;
          item._slicedFeatures = limited.source.features;
          item._slicedUsed = limited.used;
        }
        const ds = await buildStyledGeoJsonDataSource(limited.source, vectorDrape, item);
        try { ds.show = item.visible; } catch (e) {}
        await viewer.dataSources.add(ds);
        vectorDataSources.push({ ds, id: item.id, title: item.title });
        layerRuntimeTargets.set(item.id, ds);
        // ロード済みのレイヤーから順に検索索引・選択肢を更新する。
        // 重いデコーダーの待機中でも先行レイヤーが検索・属性一覧に出るようにする
        buildVectorSearchIndex();
        updateVectorSearchUI();
        if (loadTarget) layerOk(item);
      } catch (error) {
        console.warn(`${decoder ? item.type.toUpperCase() : "GeoJSON"} の読み込みに失敗しました:`, item.url || item.query || "", error);
        if (loadTarget) layerFail(item, error);
      }
    }
  }

  applyClippingPlanes(viewer.scene.globe);
  updateUndergroundView();
  updateEffectSettings();
  buildVectorSearchIndex();
  updateVectorSearchUI();
  updateMapAttribution();
  applyGlobeVisibility();
  // 件数上限バッジや描画完了後に確定する凡例スウォッチを反映するため再描画する。
  // (entity サンプル方式の凡例は DataSource 構築後でないと色が取れない)
  renderLayerList();
  entityLimitBadgeVisible = layers.some(item => item.entityLimited);
}

// 描画した primitive を scene/管理リストへ登録する。
// geojson は primitive 描画レイヤーが vectorDataSources に載らないため、
// getLayerGeoJson 用に描画に使った GeoJSON を item に保持する
// (参照を1本増やすだけで追加のデコード・ダウンロードは発生しない)
function registerPrimitiveLayer(item, primitive, geojson = null) {
  primitive.show = item.visible;
  viewer.scene.primitives.add(primitive);
  activePrimitives.push(primitive);
  layerRuntimeTargets.set(item.id, primitive);
  item.geojsonSource = geojson;
}

// ドレープ先(地形/3D Tiles)に応じた GeoJsonPrimitive 用の HeightReference を返す
function primitiveDrapeHeightReference(dem, tiles3d) {
  if (dem && tiles3d) return Cesium.HeightReference.CLAMP_TO_GROUND;
  if (tiles3d) return Cesium.HeightReference.CLAMP_TO_3D_TILE;
  if (dem) return Cesium.HeightReference.CLAMP_TO_TERRAIN;
  return Cesium.HeightReference.CLAMP_TO_GROUND;
}

// GeoJSON を GeoJsonPrimitive(entity を介さないバッチ描画)として scene に追加する。
// heightReference は常に NONE: CLAMP 系は内部で scene.vectorProvider(地形タイル焼き込み)
// に回され scene.pick で拾えなくなるため、ピックできる単純な描画を優先する。
// 属性はピック時に picked.properties から参照できる
async function addGeoJsonPrimitiveLayer(item, geojson) {
  const primitive = await Cesium.GeoJsonPrimitive.fromGeoJson(geojson, { allowPicking: true });
  applyQmlStyleToPrimitive(primitive, item.qmlStyle, item.legendHidden);
  registerPrimitiveLayer(item, primitive, geojson);
}

// GeoJSON をスタイル適用済みの GeoJsonDataSource に変換する(初回ロードと再クエリで共用)
function isDrape3DTilesActive() {
  return drapeTerrainSources.tiles3d && layers.some(l => l.visible && l.type === "3dtiles");
}

// 対象地形ごとのベクタードレープ(entity 経路)指定を返す。
// { dem, tiles3d } のどちらかが true のときオブジェクト、どちらも対象外なら null
function getVectorDrapeFlags() {
  const dem = drapeLayers.dem.geojson && drapeTerrainSources.dem;
  const tiles3d = drapeLayers.tiles3d.geojson && isDrape3DTilesActive();
  return dem || tiles3d ? { dem, tiles3d } : null;
}

// drape: getVectorDrapeFlags() の戻り値(null または {dem, tiles3d})
async function buildStyledGeoJsonDataSource(source, drape, item = null) {
  const clamp = !!drape;
  let classification;
  if (drape) {
    if (drape.dem && drape.tiles3d) classification = Cesium.ClassificationType.BOTH;
    else if (drape.tiles3d) classification = Cesium.ClassificationType.CESIUM_3D_TILE;
    else if (drape.dem) classification = Cesium.ClassificationType.TERRAIN;
  }
  const ds = await Cesium.GeoJsonDataSource.load(source, { clampToGround: clamp });
  // GeoJsonDataSource は polygon/polyline に arcType=RHUMB を設定するが、
  // 極域(南極)・日付変更線跨ぎ・重複点を含むデータで rhumb 細分化が暴走し
  // レンダリング全体が停止する既知バグがある(Cesium #7550/#7864/#8599)。
  // GEODESIC に戻して回避する
  const geodesic = new Cesium.ConstantProperty(Cesium.ArcType.GEODESIC);
  for (const entity of ds.entities.values) {
    if (entity.polygon) {
      entity.polygon.outline = new Cesium.ConstantProperty(false);
      entity.polygon.arcType = geodesic;
      if (clamp) entity.polygon.classificationType = new Cesium.ConstantProperty(classification);
    }
    if (entity.polyline) {
      entity.polyline.arcType = geodesic;
      if (clamp) {
        entity.polyline.clampToGround = new Cesium.ConstantProperty(true);
        entity.polyline.classificationType = new Cesium.ConstantProperty(classification);
      }
    }
  }
  // style= の QML スタイルがあれば entity 単位で適用する(失敗しても通常描画は維持)
  if (item?.qmlStyle) {
    item._qmlClamp = clamp;
    try { applyQmlStyleToDataSource(ds, item.qmlStyle, { clamp, hiddenSymbols: item.legendHidden }); }
    catch (error) { console.warn(`QML スタイルの適用に失敗しました: ${item.styleUrl || ""}`, error); }
  }
  return ds;
}

// クエリ系レイヤー(duckdb:/sql:)の描画物を条件変更後に差し替えて再読み込みする
// render=primitive のレイヤーは vectorDataSources に載らないため scene.primitives 側を差し替える
async function reloadVectorLayer(item) {
  const decoder = vectorDecoders.get(item.type);
  if (!decoder) return;
  const entry = vectorDataSources.find(e => e.id === item.id);
  const oldTarget = layerRuntimeTargets.get(item.id);
  const oldPrimitive = Cesium.GeoJsonPrimitive && oldTarget instanceof Cesium.GeoJsonPrimitive ? oldTarget : null;
  if (!entry && !oldPrimitive) return;
  if (isViewportQueryLayer(item)) updateViewportFilter(item);
  if (item.styleUrl) await ensureQmlStyle(item);
  const geojson = await decoder.load(item);
  const vectorDrape = getVectorDrapeFlags();
  const hadLimited = !!item.entityLimited;
  if (item.renderPrimitive && Cesium.GeoJsonPrimitive) {
    if (oldPrimitive) {
      viewer.scene.primitives.remove(oldPrimitive);
      const index = activePrimitives.indexOf(oldPrimitive);
      if (index >= 0) activePrimitives.splice(index, 1);
    }
    // primitive 経路は件数上限の対象外。entity 経路から戻った場合のバッジを消す
    item.entityLimited = null;
    if (hadLimited) renderLayerList();
    await addGeoJsonPrimitiveLayer(item, geojson);
    requestRender();
    return;
  }
  const limited = limitGeoJsonFeatures(geojson, getVectorEntityLimit(), item);
  const ds = await buildStyledGeoJsonDataSource(limited.source, vectorDrape, item);
  try { ds.show = item.visible; } catch (e) {}
  if (hadLimited || item.entityLimited) renderLayerList();
  viewer.dataSources.remove(entry.ds, false);
  await viewer.dataSources.add(ds);
  entry.ds = ds;
  layerRuntimeTargets.set(item.id, ds);
  // entity 描画でもフルソースを保持する(件数上限の切り捨て分も検索・属性の対象にするため)
  item.geojsonSource = geojson;
  requestRender();
}

// カメラ停止後に表示範囲連動レイヤーを再クエリする(camera.moveEnd / camera.changed から
// デバウンスして呼ばれる)。非クエリ系で件数上限を超えたレイヤー(viewportSliced)は
// メモリ上のフルソースから表示範囲内の地物を選び直して再描画する(再ダウンロード・再デコードは無し)
let viewportQueryRefreshRunning = false;
let viewportQueryRefreshQueued = false;
async function refreshViewportLayers() {
  // 実行中に届いたカメラ停止イベントを失わせないよう、最新の表示範囲でもう一度だけ処理する
  if (viewportQueryRefreshRunning) { viewportQueryRefreshQueued = true; return; }
  viewportQueryRefreshRunning = true;
  try {
    do {
      viewportQueryRefreshQueued = false;
      const targets = layers.filter(item => item.visible && isViewportQueryLayer(item));
      const sliced = layers.filter(item => item.visible && item.viewportSliced && item.geojsonSource && vectorDataSources.some(e => e.id === item.id));
      for (const item of targets) {
        updateViewportFilter(item);
        try {
          await reloadVectorLayer(item);
        } catch (error) {
          console.warn(`${item.type.toUpperCase()} レイヤーの再読み込みに失敗しました:`, item.url || item.query || "", error);
        }
      }
      if (targets.length) {
        buildVectorSearchIndex();
        updateVectorSearchUI();
      }
      if (sliced.length) {
        // 再スライス対象以外の entity 描画分を差し引いた残りを、描画順に配分する。
        // プラグインの entities レイヤーは refreshLayersImpl と同じくバジェット対象外
        let remaining = getVectorEntityLimit();
        const slicedIds = new Set(sliced.map(i => i.id));
        if (Number.isFinite(remaining)) {
          for (const entry of vectorDataSources) {
            if (!slicedIds.has(entry.id) && !entry.plugin) remaining -= entry.ds.entities.values.length;
          }
          remaining = Math.max(remaining, 0);
        }
        for (const item of sliced) {
          try {
            remaining -= await resliceViewportLayer(item, remaining);
          } catch (error) {
            console.warn(`${item.type.toUpperCase()} レイヤーの再スライスに失敗しました:`, item.url || item.query || "", error);
          }
        }
        // バッジは「表示範囲内の件数/描画件数」で出す(範囲内が収まれば消える)
        const limitedNow = layers.some(i => i.entityLimited);
        if (limitedNow || entityLimitBadgeVisible) renderLayerList();
        entityLimitBadgeVisible = limitedNow;
      }
    } while (viewportQueryRefreshQueued);
  } finally {
    viewportQueryRefreshRunning = false;
  }
}

// 非クエリ系の切り捨てレイヤーを現在の表示範囲で再スライスして差し替える。
// 新しい DataSource を先に追加してから旧 DataSource を除去し、空白を最小化する
async function resliceViewportLayer(item, remaining) {
  const entry = vectorDataSources.find(e => e.id === item.id);
  if (!entry || !item.geojsonSource) return 0;
  const viewSource = sliceSourceToView(item, item.geojsonSource);
  // 描画対象(件数・中身)が前回と同一なら再構築しない。
  // moveEnd→ピッチ矯正 setView による追発火・moveEnd/changed の二重起動・微小な移動で
  // ビュー矩形が僅かに変わっても選ばれる地物が同じなら entity 再構築は無駄になるため
  const shown = Math.max(0, Math.min(viewSource.features.length, remaining));
  const prev = item._slicedFeatures;
  if (prev && prev.length === shown && viewSource.features.slice(0, shown).every((f, i) => f === prev[i])) {
    return prev.length;
  }
  const limited = limitGeoJsonFeatures(viewSource, remaining, item);
  const ds = await buildStyledGeoJsonDataSource(limited.source, getVectorDrapeFlags(), item);
  try { ds.show = item.visible; } catch (e) {}
  await viewer.dataSources.add(ds);
  viewer.dataSources.remove(entry.ds, false);
  entry.ds = ds;
  layerRuntimeTargets.set(item.id, ds);
  // バッジはフルソース基準(範囲外で0件でも「0/N」でデータ残存を示す)
  item.entityLimited = limited.used < item.geojsonSource.features.length
    ? { shown: limited.used, total: item.geojsonSource.features.length }
    : null;
  item._slicedFeatures = limited.source.features;
  item._slicedUsed = limited.used;
  requestRender();
  return limited.used;
}

// クエリ系レイヤーの条件を対話的に変更する。duckdb: は WHERE 式、sql: はクエリ全文を編集し、
// 変更は .kasc 行(sourceLine)にも反映して inspector テキストとの整合を保つ
async function editLayerQueryFilter(item) {
  if (!item) return;
  const isSql = item.type === "sql";
  const current = isSql ? (item.query || "") : (item.where || "");
  const input = window.prompt(t(isSql ? "layer.filter.promptSql" : "layer.filter.promptWhere"), current);
  if (input === null) return;
  await applyLayerQueryFilter(item, input.trim());
}

// クエリ系レイヤーのフィルター適用本体。⏷ボタンの prompt と AI ツール(setLayerFilter)の共通経路
async function applyLayerQueryFilter(item, value) {
  const isSql = item.type === "sql";
  if (isSql) {
    if (!value) return false;
    item.query = value;
  } else {
    item.where = value || undefined;
  }
  syncLayerSourceLine(item);
  try {
    await reloadVectorLayer(item);
    buildVectorSearchIndex();
    updateVectorSearchUI();
    // 条件変更で一覧内容が変わるため、クエリ系も含めて属性一覧の行を再取得する
    uiHooks.refreshVectorAttrWidget?.(true);
    return true;
  } catch (error) {
    console.warn(`${item.type.toUpperCase()} レイヤーの再読み込みに失敗しました:`, item.url || item.query || "", error);
    return false;
  }
}

// フィルター変更を .kasc 行へ反映する。sourceTitle/元の on-off 指定(sourceVisible)を維持する
function syncLayerSourceLine(item) {
  let line = null;
  if (item.type === "duckdb") {
    const parts = [item.sourceTitle, item.url || "", item.attribution || ""];
    if (item.sourceVisible === false) parts.push("off");
    if (item.where) parts.push(`where=${item.where}`);
    if (item.limit) parts.push(`limit=${item.limit}`);
    if (item.geom) parts.push(`geom=${item.geom}`);
    if (item.lon) parts.push(`lon=${item.lon}`);
    if (item.lat) parts.push(`lat=${item.lat}`);
    if (item.format) parts.push(`format=${item.format}`);
    if (item.columns?.length) parts.push(`columns=${item.columns.join(",")}`);
    if (item.covering?.length) parts.push(`covering=${item.covering.join(",")}`);
    if (item.gpkgTable) parts.push(`table=${item.gpkgTable}`);
    if (item.bboxAuto) parts.push("bbox=auto");
    else if (item.bboxAuto === false) parts.push("bbox=off");
    if (item.renderSpecified) parts.push(item.renderPrimitive ? "render=primitive" : "render=entity");
    if (item.proxy) parts.push("proxy=on");
    if (item.styleUrl) parts.push(`style=${item.styleUrl}`);
    line = `duckdb: ${parts.join(" | ")}`;
  } else if (item.type === "gpkg" || item.type === "geopackage") {
    const parts = [item.sourceTitle, item.url || "", item.attribution || ""];
    if (item.sourceVisible === false) parts.push("off");
    if (item.where) parts.push(`where=${item.where}`);
    if (item.limit) parts.push(`limit=${item.limit}`);
    if (item.columns?.length) parts.push(`columns=${item.columns.join(",")}`);
    if (item.gpkgTable) parts.push(`table=${item.gpkgTable}`);
    if (item.bboxAuto) parts.push("bbox=auto");
    else if (item.bboxAuto === false) parts.push("bbox=off");
    if (item.renderSpecified) parts.push(item.renderPrimitive ? "render=primitive" : "render=entity");
    if (item.proxy === false) parts.push("proxy=off");
    if (item.styleUrl) parts.push(`style=${item.styleUrl}`);
    line = `${item.type}: ${parts.join(" | ")}`;
  } else if (item.type === "sql") {
    line = `sql: ${item.sourceTitle} | ${item.query}${item.renderSpecified ? (item.renderPrimitive ? " | render=primitive" : " | render=entity") : ""}${item.sourceVisible === false ? " | off" : ""}${item.attribution ? ` | attr=${item.attribution}` : ""}${item.styleUrl ? ` | style=${item.styleUrl}` : ""}`;
  }
  if (!line || line === item.sourceLine) return;
  const input = document.querySelector("#inspector-input");
  if (input && item.sourceLine) {
    input.value = input.value.split(/\r?\n/).map(l => (l === item.sourceLine ? line : l)).join("\n");
  }
  item.sourceLine = line;
}

function setupInfoTabs(content) {
  const buttons = [...content.querySelectorAll(".tab-button")];
  const panels = [...content.querySelectorAll(".tab-content")];
  if (!buttons.length || !panels.length) return;
  const activate = index => {
    buttons.forEach((button, i) => button.classList.toggle("active", i === index));
    panels.forEach((panel, i) => {
      panel.classList.toggle("active", i === index);
      panel.hidden = i !== index;
    });
  };
  buttons.forEach((button, index) => button.addEventListener("click", () => activate(index)));
  activate(Math.max(0, buttons.findIndex(button => button.classList.contains("active"))));
}

async function loadInfoContent(url) {
  const content = document.querySelector("#info-content");
  if (!content) return;
  const requestId = ++infoRequestId;
  content.replaceChildren();
  if (!url) return;
  try {
    const infoUrl = url;
    const response = await fetch(infoUrl, { mode: "cors" });
    if (!response.ok) throw new Error(await response.text());
    const html = await response.text();
    if (requestId !== infoRequestId) return;
    const documentFragment = new DOMParser().parseFromString(html, "text/html");
    documentFragment.querySelectorAll("script, iframe, object, embed, form, link, style").forEach(node => node.remove());
    documentFragment.querySelectorAll("*").forEach(node => {
      [...node.attributes].forEach(attribute => {
        if (/^on/i.test(attribute.name) || /javascript:/i.test(attribute.value)) node.removeAttribute(attribute.name);
      });
    });
    content.replaceChildren(...[...documentFragment.body.childNodes].map(node => document.importNode(node, true)));
    setupInfoTabs(content);
  } catch (error) {
    if (requestId === infoRequestId) content.textContent = t("info.loadFailed", { error: error instanceof Error ? error.message : error });
  }
}

// Geocoding/Places/Street View などの Web サービス API 用キー。
// googleMapsWsApiKey（別キー）があればそちらを優先し、無ければ Maps API キーにフォールバックする
// （Web サービス API は HTTP リファラー制限付きキーを拒否するため分離できるようにした）
function getMapsWsKey() {
  try {
    return localStorage.getItem("googleMapsWsApiKey") || localStorage.getItem("googleMapsApiKey") || "";
  } catch (e) { return ""; }
}

// Google Geocoding API。{title,address,latitude,longitude}[] を返す
async function googleGeocodeSearch(query, key) {
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}&language=${encodeURIComponent(getLanguage())}`, { mode: "cors" });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error_message || t("search.failedStatus", { status: response.status }));
  if (data?.status !== "OK" && data?.status !== "ZERO_RESULTS") {
    throw new Error(data?.error_message || data?.status || t("search.failed"));
  }
  return (data?.results || []).map(item => ({
    title: item.formatted_address || "",
    address: item.formatted_address || "",
    latitude: Number(item.geometry?.location?.lat),
    longitude: Number(item.geometry?.location?.lng),
  }));
}

// Google Places API (New) テキスト検索。{title,address,latitude,longitude}[] を返す
async function googlePlacesSearch(query, key) {
  if (!key) throw new Error(t("google.needKey"));
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify({ textQuery: String(query || ""), languageCode: getLanguage(), pageSize: 10 }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || t("search.failedStatus", { status: response.status }));
  return (data?.places || []).map(place => ({
    title: place.displayName?.text || "",
    address: place.formattedAddress || "",
    latitude: Number(place.location?.latitude),
    longitude: Number(place.location?.longitude),
  }));
}

// 検索プロバイダ。いずれも {title,address,latitude,longitude}[] を返す。
// google は Maps API キー(localStorage)、yahoo は .kasc の yahooappid: を使う
const searchProviders = {
  async gsi(query) {
    const response = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`, { mode: "cors" });
    if (!response.ok) throw new Error(await response.text() || t("search.failedStatus", { status: response.status }));
    const data = await response.json();
    return data.map(item => ({
      title: item.properties?.title || item.properties?.name || item.properties?.Name || "",
      address: item.properties?.address || item.properties?.Address || item.properties?.title || "",
      latitude: Number(item.geometry?.coordinates?.[1]),
      longitude: Number(item.geometry?.coordinates?.[0]),
    }));
  },
  // ハイブリッド検索: Geocoding（住所向け）と Places テキスト検索（施設・キーワード向け）を
  // 並列で呼んでマージする。片方が失敗しても他方の結果は返す（両方失敗時のみエラー）
  async google(query) {
    const key = getMapsWsKey();
    if (!key) throw new Error(t("google.needKey"));
    const [geocode, places] = await Promise.allSettled([
      googleGeocodeSearch(query, key),
      googlePlacesSearch(query, key),
    ]);
    const items = [];
    if (geocode.status === "fulfilled") items.push(...geocode.value);
    if (places.status === "fulfilled") items.push(...places.value);
    if (!items.length) {
      if (geocode.status === "rejected") throw geocode.reason;
      if (places.status === "rejected") throw places.reason;
    }
    // 同一地点の重複を除外（座標を ~11m 単位に丸めて比較。Geocoding側を優先して残す）
    const seen = new Set();
    return items.filter(item => {
      if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return false;
      const k = `${Math.round(item.latitude * 1e4)},${Math.round(item.longitude * 1e4)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
  // Places テキスト検索のみ（AIツールや provider="places" 指定用）
  async places(query) {
    return googlePlacesSearch(query, getMapsWsKey());
  },
  async yahoo(query) {
    const response = await fetch(`https://map.yahooapis.jp/geocode/V1/geoCoder?appid=${encodeURIComponent(yahooAppId)}&query=${encodeURIComponent(query)}&output=json`, { mode: "cors" });
    if (!response.ok) throw new Error(await response.text() || t("search.failedStatus", { status: response.status }));
    const data = await response.json();
    return (data?.Feature || []).map(feature => {
      const [lng, lat] = String(feature?.Geometry?.Coordinates || "").split(",");
      return {
        title: feature?.Name || feature?.Property?.Address || "",
        address: feature?.Property?.Address || feature?.Name || "",
        latitude: Number(lat),
        longitude: Number(lng),
      };
    });
  },
};

function updateSearchProvider() {
  const searchProvider = document.querySelector("#search-provider");
  const searchYahooWarning = document.querySelector("#search-yahoo-warning");
  if (!searchProvider) return;
  const yahooOpt = searchProvider.querySelector('option[value="yahoo"]');
  const hasYahoo = yahooAppId && !yahooAppId.includes("あなたのYahoo");
  if (yahooOpt) yahooOpt.disabled = !hasYahoo;
  const googleOpt = searchProvider.querySelector('option[value="google"]');
  const hasGoogle = !!getMapsWsKey();
  if (googleOpt) googleOpt.disabled = !hasGoogle;
  if (!hasYahoo && searchProvider.value === "yahoo") searchProvider.value = "gsi";
  if (!hasGoogle && searchProvider.value === "google") searchProvider.value = "gsi";
  if (searchYahooWarning) searchYahooWarning.style.display = (searchProvider.value === "yahoo") ? "" : "none";
  const svRow = document.querySelector("#streetview-row");
  if (svRow) svRow.style.display = hasGoogle ? "" : "none";
  if (!hasGoogle) {
    if (streetViewPickMode) {
      streetViewPickMode = false;
      updateStreetViewPickButton();
    }
    svCoverageAutoOn = false;
    setStreetViewCoverage(false);
  }
}

// Street View を別タブで開き、結果を検索パネルのステータスに表示する
async function openStreetViewAt(latitude, longitude) {
  const statusEl = document.querySelector("#search-status");
  try {
    const result = await window.kasugaiApi.openStreetView(latitude, longitude);
    if (statusEl) statusEl.textContent = result?.ok ? t("search.streetviewOpened") : t("search.streetviewNone");
  } catch (e) {
    if (statusEl) statusEl.textContent = e instanceof Error ? e.message : String(e);
  }
}

// Street View カバレッジ(青い候補ライン)。Google マップが内部で使う photometa/ac/v1
// (z17タイル単位のパノラマ位置+リンク)を fetch し、リンクを青いラインとして自前描画する。
// 旧来の lyrs=svv ラスタータイルは空タイルを返すようになったため使えない。
// 非公式エンドポイントのため将来変更・停止される可能性あり
const SV_COVERAGE_ZOOM = 17;
const SV_COVERAGE_MAX_TILES = 40;
const SV_COVERAGE_COLOR = Cesium.Color.fromCssColorString("#2e7cf6").withAlpha(0.9);
const SV_COVERAGE_CELL_COLOR = Cesium.Color.fromCssColorString("#2e7cf6").withAlpha(0.12);

function lonLatToSvTile(lon, lat) {
  const n = 2 ** SV_COVERAGE_ZOOM;
  const latRad = Math.min(85.05, Math.max(-85.05, lat)) * Math.PI / 180;
  return {
    x: Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n))),
    y: Math.max(0, Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n))),
  };
}

// photometa/ac/v1 のタイルJSONを Entity 配列に変換する
// tile[1][1] = パノラマ一覧([[type,panoid],_,[[_,_,lat,lng],...]],[リンク先index]) + tile[2] = カバレッジセル(粗い矩形)
function parseSvCoverageTile(tile) {
  const entities = [];
  const panos = [];
  const panoList = Array.isArray(tile?.[1]?.[1]) ? tile[1][1] : null;
  if (panoList) {
    for (const raw of panoList) {
      const head = raw?.[0];
      if (!Array.isArray(head) || head[0]?.[0] === 1) continue;
      const lat = head?.[2]?.[0]?.[2];
      const lng = head?.[2]?.[0]?.[3];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      panos.push({ lat, lng, links: Array.isArray(raw?.[1]) ? raw[1] : [] });
    }
  }
  if (panos.length) {
    for (let i = 0; i < panos.length; i++) {
      let linked = false;
      for (const j of panos[i].links) {
        if (!Number.isInteger(j) || j <= i || !panos[j]) continue;
        linked = true;
        entities.push(new Cesium.Entity({
          polyline: {
            positions: [
              Cesium.Cartesian3.fromDegrees(panos[i].lng, panos[i].lat),
              Cesium.Cartesian3.fromDegrees(panos[j].lng, panos[j].lat),
            ],
            width: 3,
            material: SV_COVERAGE_COLOR,
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        }));
      }
      if (!linked && !panos[i].links.length) {
        // 孤立パノラマは小さな点で残す
        entities.push(new Cesium.Entity({
          position: Cesium.Cartesian3.fromDegrees(panos[i].lng, panos[i].lat),
          point: { pixelSize: 5, color: SV_COVERAGE_COLOR, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
        }));
      }
    }
    return entities;
  }
  // per-pano データが無いタイルはカバレッジセルを薄く塗る
  const cells = Array.isArray(tile?.[2]) ? tile[2] : null;
  if (cells) {
    for (const cell of cells) {
      const a = cell?.[1]?.[0];
      const b = cell?.[1]?.[1];
      const lat1 = a?.[2], lng1 = a?.[3], lat2 = b?.[2], lng2 = b?.[3];
      if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) continue;
      entities.push(new Cesium.Entity({
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(Math.min(lng1, lng2), Math.min(lat1, lat2), Math.max(lng1, lng2), Math.max(lat1, lat2)),
          material: SV_COVERAGE_CELL_COLOR,
        },
      }));
    }
  }
  return entities;
}

// 表示範囲の z17 タイルを取得してカバレッジを描画する（ビュー外タイルは撤去）
async function refreshSvCoverage() {
  const token = ++svCoverageRefreshToken;
  const ds = svCoverageDataSource;
  if (!ds) return;
  const view = getViewRanges();
  if (!view?.ranges?.length) return;
  const wanted = new Map();
  for (const r of view.ranges) {
    const nw = lonLatToSvTile(r.west, view.north);
    const se = lonLatToSvTile(r.east, view.south);
    const cx = (Math.min(nw.x, se.x) + Math.max(nw.x, se.x)) / 2;
    const cy = (Math.min(nw.y, se.y) + Math.max(nw.y, se.y)) / 2;
    const all = [];
    for (let x = Math.min(nw.x, se.x); x <= Math.max(nw.x, se.x); x++) {
      for (let y = Math.min(nw.y, se.y); y <= Math.max(nw.y, se.y); y++) {
        all.push({ x, y, d: (x - cx) ** 2 + (y - cy) ** 2 });
      }
    }
    all.sort((a, b) => a.d - b.d);
    for (const t2 of all.slice(0, SV_COVERAGE_MAX_TILES)) wanted.set(`${t2.x}/${t2.y}`, t2);
  }
  for (const [key, entities] of svCoverageTiles) {
    if (!wanted.has(key)) {
      entities.forEach(e => ds.entities.remove(e));
      svCoverageTiles.delete(key);
    }
  }
  const missing = [...wanted.keys()].filter(k => !svCoverageTiles.has(k));
  await Promise.all(missing.map(async key => {
    const { x, y } = wanted.get(key);
    try {
      const res = await fetch(`https://www.google.com/maps/photometa/ac/v1?pb=!1m1!1smaps_sv.tactile!6m3!1i${x}!2i${y}!3i17!8b1`);
      const text = await res.text();
      if (!res.ok) return;
      const start = text.indexOf("[");
      const entities = start >= 0 ? parseSvCoverageTile(JSON.parse(text.slice(start))) : [];
      if (token !== svCoverageRefreshToken || svCoverageDataSource !== ds) return;
      entities.forEach(e => ds.entities.add(e));
      svCoverageTiles.set(key, entities);
    } catch (e) { /* タイル取得失敗は無視 */ }
  }));
}

function scheduleSvCoverageRefresh() {
  clearTimeout(svCoverageTimer);
  svCoverageTimer = setTimeout(() => { void refreshSvCoverage(); }, 500);
}

async function setStreetViewCoverage(enabled) {
  if (enabled) {
    if (!svCoverageDataSource) {
      svCoverageDataSource = new Cesium.CustomDataSource("sv-coverage");
      await viewer.dataSources.add(svCoverageDataSource);
      svCoverageListener = scheduleSvCoverageRefresh;
      viewer.camera.moveEnd.addEventListener(svCoverageListener);
      void refreshSvCoverage();
    }
  } else if (svCoverageDataSource) {
    if (svCoverageListener) {
      viewer.camera.moveEnd.removeEventListener(svCoverageListener);
      svCoverageListener = null;
    }
    svCoverageRefreshToken++; // 進行中の fetch 結果を破棄
    svCoverageTiles.clear();
    viewer.dataSources.remove(svCoverageDataSource, true);
    svCoverageDataSource = null;
  }
  const checkbox = document.querySelector("#streetview-coverage");
  if (checkbox) checkbox.checked = !!svCoverageDataSource;
}

// Street View 地点拾いモードのボタン表示を更新
function updateStreetViewPickButton() {
  const btn = document.querySelector("#streetview-pick");
  if (!btn) return;
  btn.style.background = streetViewPickMode ? "#ffd88a" : "";
  btn.textContent = t(streetViewPickMode ? "search.streetviewPicking" : "search.streetviewPick");
  const statusEl = document.querySelector("#search-status");
  if (statusEl) statusEl.textContent = streetViewPickMode ? t("search.streetviewHint") : "";
}

// 地点拾いモード中は候補ラインを自動表示し、解除したら自動表示分だけ消す。
// ユーザーが手動でONにしている場合は解除してもそのままにする
async function updateStreetViewPickCoverage() {
  if (streetViewPickMode && !svCoverageDataSource) {
    svCoverageAutoOn = true;
    await setStreetViewCoverage(true);
  } else if (!streetViewPickMode && svCoverageAutoOn) {
    svCoverageAutoOn = false;
    await setStreetViewCoverage(false);
  }
}

// plugin: 行の key=value 値の型変換。真偽値・数値・カンマ区切り(配列)を解釈する
function coercePluginOptionValue(raw) {
  if (/^(true|on|yes)$/i.test(raw)) return true;
  if (/^(false|off|no)$/i.test(raw)) return false;
  if (raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  if (raw.includes(",")) return raw.split(",").map(part => coercePluginOptionValue(part.trim()));
  return raw;
}

function applyInspector(text) {
  const nextLines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsedCameras = [];
  const parsedBasemaps = [];
  // base: の特殊行(transparent/none)で指定された初期表示モード
  let parsedBaseMode = "";
  layerState.clear();
  inspectorPluginSpecs.splice(0, inspectorPluginSpecs.length);
  inspectorThemes.splice(0, inspectorThemes.length);
  inspectorBookmarkSpecs.splice(0, inspectorBookmarkSpecs.length);
  vectorSourceCache.clear();
  // gpkg Worker が url キーで開いたままの DB も破棄する(メモリ解放・再取得)
  resetGpkgWorkerDbs();
  qmlStyleCache.clear();
  vectorSearchLoadedSources.clear();
  vectorSearchLoadFailed.clear();
  tileLayers.splice(0, tileLayers.length);
  layers.splice(0, layers.length);
  basemaps.splice(0, basemaps.length);
  layerOrder = [];
  // 飛行中の再適用でもルート再生を継続できるよう、現在のルート・位置・再生状態を退避する
  const flyResume = flyPath && flyPathCoords?.length
    ? { title: flyPath.title, distance: flyPathDistance, active: flyPathActive }
    : null;
  flyPaths.splice(0, flyPaths.length);
  flyPath = null;
  flyPathProperties = {};
  flyPathCoords = null;
  flyPathCumulativeDistances = [];
  flyPathDistance = 0;
  flyPathTargetDistance = null;
  flyPathLinePositions = [];
  if (flyPathRafId !== null) { cancelAnimationFrame(flyPathRafId); flyPathRafId = null; }
  if (flyPathEntity) { viewer.entities.remove(flyPathEntity); flyPathEntity = null; }
  flyPathActive = false;
  flyPathProgress = 0;

  document.body.style.background = "";
  undergroundBackgroundColor = Cesium.Color.BLACK;
  ++infoRequestId;
  document.querySelector("#info-content").replaceChildren();
  document.querySelector("#legend-panel img").removeAttribute("src");

  let inspectorLayerIndex = 0;
  // cloud: 行(複数ある場合は最後の行を採用)。null=行なし、{stop:true}=停止
  let inspectorCloudSpec = null;
  nextLines.forEach(line => {
    const separator = line.indexOf(":");
    if (separator < 0) return;
    const type = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (type === "background") {
      document.body.style.background = value;
      const baseColor = Cesium.Color.fromCssColorString(value);
      if (baseColor) {
        globeBaseColor = baseColor;
        viewer.scene.globe.baseColor = globeHidden ? Cesium.Color.TRANSPARENT : baseColor;
        undergroundBackgroundColor = baseColor;
      }
    }
    if (type === "yahooappid") {
      yahooAppId = value;
      updateSearchProvider();
    }
    if (type === "info") {
      void loadInfoContent(resolveProjectUrl(value));
    }
    if (type === "legend") {
      const parts = value.split("|").map(part => part.trim());
      document.querySelector("#legend-panel img").src = resolveProjectUrl(parts[parts.length - 1]);
    }

    // theme: 名前 | 表示するレイヤタイトル[|タイトル…]（`*` で全表示）。
    // QGIS マップテーマ相当の可視性プリセット（スタイルは含まない）
    if (type === "theme") {
      const parts = value.split("|").map(part => part.trim());
      inspectorThemes.push({ name: parts[0] || "", layers: parts.slice(1).filter(Boolean), line });
    }

    // cloud: リモート名 | ルートフォルダ(パス or フォルダURL・省略可) | perm=write | drive=K | off
    // → ローカルサーバー版では /api/cloud/serve を呼び rclone 接続を自動実行する。
    // .kasc に書いておけば起動時(プロジェクト読み込み)に自動接続される。
    // cloud: stop / disconnect は接続停止、末尾の off は「設定は残すが接続しない」。
    if (type === "cloud") {
      const parts = value.split("|").map(part => part.trim());
      const spec = { remote: "", root: "", readOnly: true, drive: "", off: false, stop: false, install: true };
      parts.forEach(part => {
        if (!part) return;
        if (/^(stop|disconnect)$/i.test(part) && !spec.remote) { spec.stop = true; return; }
        if (/^(off|false)$/i.test(part)) { spec.off = true; return; }
        const eq = part.indexOf("=");
        const key = eq > 0 ? part.slice(0, eq).trim().toLowerCase() : "";
        if (key === "perm" || key === "mode" || key === "access") {
          spec.readOnly = !/^(write|rw|on)$/i.test(part.slice(eq + 1).trim());
          return;
        }
        // install=off: rclone 未導入時の自動ダウンロードを無効化
        if (key === "install" || key === "autoinstall") {
          spec.install = !/^(off|no|false|0)$/i.test(part.slice(eq + 1).trim());
          return;
        }
        if (key === "drive" || key === "letter") {
          spec.drive = part.slice(eq + 1).trim().replace(/:$/, "").toUpperCase();
          return;
        }
        if (key === "root" || key === "dir" || key === "folder") {
          spec.root = part.slice(eq + 1).trim();
          return;
        }
        if (!spec.remote) spec.remote = part;
        else if (!spec.root) spec.root = part;
      });
      inspectorCloudSpec = spec;
    }

    // plugin: プラグインID | key=value | off
    // plugins.json カタログの同梱プラグインまたは IndexedDB ストレージプラグインを
    // このプロジェクトで有効化する。実際のロード/停止は plugin-loader が
    // inspector-plugins-changed を受けて差分実行する（プロジェクトスコープ扱い）
    if (type === "plugin") {
      const parts = value.split("|").map(part => part.trim());
      const id = parts[0] || "";
      if (!id || id.includes("=")) return;
      const spec = { id, options: {}, off: false };
      parts.slice(1).forEach(part => {
        if (!part) return;
        if (/^(off|false|disable)$/i.test(part)) { spec.off = true; return; }
        if (/^(on|true|enable)$/i.test(part)) return;
        const eq = part.indexOf("=");
        if (eq < 0) return;
        const key = part.slice(0, eq).trim();
        if (key) spec.options[key] = coercePluginOptionValue(part.slice(eq + 1).trim());
      });
      // 同一 id の重複行は後の行を採用する
      const existing = inspectorPluginSpecs.findIndex(entry => entry.id === spec.id);
      if (existing >= 0) inspectorPluginSpecs[existing] = spec;
      else inspectorPluginSpecs.push(spec);
    }

    if (type === "base") {
      const parts = value.split("|").map(part => part.trim());
      // 特殊値: base: 表示名 | transparent（地表透明=ベースマップ透明）/ none（ベースマップなし）。
      // レイヤーリストには加えず初期表示モードだけを決める（行の位置は問わない）
      if (parts[0] && parts[1] && /^(transparent|hide|__hide_globe__)$/i.test(parts[1])) {
        parsedBaseMode = "hide";
      } else if (parts[0] && parts[1] && /^(none|null)$/i.test(parts[1])) {
        parsedBaseMode = "none";
      } else if (parts[0] && parts[1]) {
        const options = {};
        // parts[2] は出典スロットだが、出典無しで maxZoom= 等の
        // オプションキーが来る行もあるため、認識できる key=value は
        // 出典ではなくオプションとして解釈する
        const baseOptKeyRe = /^(tileSize|maximumLevel|maxZoom|opacity|proxy)\s*=/i;
        let attribution = "";
        for (const part of parts.slice(2)) {
          if (/^(on|off|true|false)$/i.test(part)) continue;
          if (!baseOptKeyRe.test(part)) { if (!attribution) attribution = part; continue; }
          const eq = part.indexOf("=");
          const key = part.slice(0, eq).trim();
          const raw = part.slice(eq + 1).trim();
          const number = Number(raw);
          if (key === "tileSize" && [256, 512].includes(number)) options.tileSize = number;
          if ((key === "maximumLevel" || key === "maxZoom") && Number.isInteger(number) && number >= 0) options.maximumLevel = number;
          if (key === "opacity" && Number.isFinite(number)) options.opacity = Math.max(0, Math.min(1, number));
          if (key === "proxy" && /^(off|false|direct)$/i.test(raw)) options.proxy = false;
        }
        parsedBasemaps.push({
          id: `inspector-base-${parsedBasemaps.length}`,
          title: parts[0],
          url: resolveProjectUrl(parts[1]),
          attribution,
          tileSize: options.tileSize || 256,
          opacity: options.opacity ?? 1.0,
          proxy: options.proxy !== false,
          ...(options.maximumLevel === undefined ? {} : { maximumLevel: options.maximumLevel }),
        });
      }
    }

    if (type === "cam") {
      const parts = value.split("|").map(part => part.trim());
      if (parts.length < 3) return;
      const camera = { title: parts[0], latitude: Number(parts[1]), longitude: Number(parts[2]), pitch: -30, heading: 0 };
      parts.slice(3).forEach(part => {
        const [key, raw] = part.split("=");
        const number = Number(raw);
        if ((key === "p" || key === "pitch") && Number.isFinite(number)) camera.pitch = number;
        if ((key === "d" || key === "heading") && Number.isFinite(number)) camera.heading = number;
        if ((key === "h" || key === "height") && Number.isFinite(number)) camera.height = number;
      });
      if (Number.isFinite(camera.latitude) && Number.isFinite(camera.longitude)) parsedCameras.push(camera);
    }

    // bookmark: 名 | XML または bookmark: XML — QGIS ブックマークエクスポート
    // (qgis_bookmarks 形式)への参照。実体は非同期で読み込みカメラプリセットへ展開
    if (type === "bookmark") {
      const parts = value.split("|").map(part => part.trim());
      const url = parts[1] || parts[0];
      if (url) inspectorBookmarkSpecs.push({ title: parts[1] ? parts[0] : null, url });
    }

    if (type === "fly_geojson") {
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const url = resolveProjectUrl(parts[1]);
      if (!url) return;
      const config = { title: title || url, url, speed: 30, height: 0, pitch: -10, loop: false, step: 100, view: "camera" };
      const off = parts.some(part => /^(off|false)$/i.test(part));
      parts.slice(2).forEach(part => {
        const eq = part.indexOf("=");
        if (eq < 0) return;
        const key = part.slice(0, eq).trim().toLowerCase();
        const raw = part.slice(eq + 1).trim();
        const number = Number(raw);
        if ((key === "speed" || key === "s") && Number.isFinite(number) && number > 0) config.speed = number;
        if ((key === "height" || key === "h") && Number.isFinite(number)) config.height = number;
        if ((key === "pitch" || key === "p") && Number.isFinite(number)) config.pitch = number;
        if ((key === "step") && Number.isFinite(number) && number > 0) config.step = number;
        if (key === "loop" || key === "l") config.loop = /^(true|1|on|yes)$/i.test(raw);
        if (key === "view" || key === "v") config.view = /^(center|chase|follow|3rd|third)$/i.test(raw) ? "center" : "camera";
      });
      if (!off) flyPaths.push(config);
    }

    if (type === "xyz") {
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const url = resolveProjectUrl(parts[1]);
      const off = parts.some(part => /^(off|false)$/i.test(part));
      if (!title || !url) return;
      const { group, title: displayTitle, exclusiveGroup } = parseLayerTitle(title);
      const options = {};
      parts.slice(3).forEach(part => {
        const eq = part.indexOf("=");
        if (eq < 0) return;
        const key = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        const number = Number(raw);
        if (key === "opacity" && Number.isFinite(number)) options.opacity = Math.max(0, Math.min(1, number));
        if ((key === "maximumLevel" || key === "maxZoom") && Number.isInteger(number) && number >= 0) options.maximumLevel = number;
        if ((key === "minimumLevel" || key === "minZoom") && Number.isInteger(number) && number >= 0) options.minimumLevel = number;
        if (key === "tileSize" && [256, 512].includes(number)) options.tileSize = number;
        if (key === "proxy" && /^(off|false|direct)$/i.test(raw)) options.proxy = false;
        // bbox=西経,南緯,東経,北緯: タイルの存在範囲(rectangle)。未指定は全世界
        if (key === "bbox" || key === "bounds" || key === "extent") {
          const nums = raw.split(",").map(v => Number(v.trim()));
          if (nums.length === 4 && nums.every(Number.isFinite)) options.bbox = nums;
        }
      });
      const id = `inspector-layer-${inspectorLayerIndex++}`;
      const item = { id, title: displayTitle, sourceTitle: title, sourceLine: line, url, visible: !off, type: "tile", opacity: options.opacity ?? 0.8, attribution: parseAttributionField(parts[2]), proxy: options.proxy !== false, group, exclusiveGroup };
      if (options.maximumLevel !== undefined) item.maximumLevel = options.maximumLevel;
      if (options.minimumLevel !== undefined) item.minimumLevel = options.minimumLevel;
      if (options.bbox) item.bbox = options.bbox;
      if (options.tileSize !== undefined) item.tileSize = options.tileSize;
      tileLayers.push(item);
      layerState.set(id, item);
      layerOrder.push(id);
    }

    if (type === "wms" || type === "wmts") {
      // OGC タイル系: GetMap/GetTile をタイル URL テンプレートへ正規化して
      // 通常の tile レイヤーとして流す(opacity/bbox/ドレープ等の既存機構を共用)
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const rawUrl = parts[1];
      const off = parts.some(part => /^(off|false)$/i.test(part));
      if (!title || !rawUrl) return;
      const url0 = resolveProjectUrl(rawUrl);
      const { group, title: displayTitle, exclusiveGroup } = parseLayerTitle(title);
      const kv = {};
      const options = {};
      // 出典スロット(3番目)に key=value を書いた場合も拾えるよう slice(2) から走査する
      parts.slice(2).forEach(part => {
        const eq = part.indexOf("=");
        if (eq < 0) return;
        const key = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        kv[key.toLowerCase()] = raw;
        const number = Number(raw);
        if (key === "opacity" && Number.isFinite(number)) options.opacity = Math.max(0, Math.min(1, number));
        if ((key === "maximumLevel" || key === "maxZoom") && Number.isInteger(number) && number >= 0) options.maximumLevel = number;
        if ((key === "minimumLevel" || key === "minZoom") && Number.isInteger(number) && number >= 0) options.minimumLevel = number;
        if (key === "tileSize" && [256, 512].includes(number)) options.tileSize = number;
        if (key === "proxy" && /^(off|false|direct)$/i.test(raw)) options.proxy = false;
        if (key === "bbox" || key === "bounds" || key === "extent") {
          const nums = raw.split(",").map(v => Number(v.trim()));
          if (nums.length === 4 && nums.every(Number.isFinite)) options.bbox = nums;
        }
      });
      const url = type === "wms"
        ? buildWmsTileTemplate(url0, kv, "{westProjected},{southProjected},{eastProjected},{northProjected}")
        : buildWmtsTileTemplate(url0, kv);
      const id = `inspector-layer-${inspectorLayerIndex++}`;
      const item = { id, title: displayTitle, sourceTitle: title, sourceLine: line, url, visible: !off, type: "tile", ogcType: type, opacity: options.opacity ?? 0.8, attribution: parseAttributionField(parts[2]) || kv.attr || null, proxy: options.proxy !== false, group, exclusiveGroup };
      if (options.maximumLevel !== undefined) item.maximumLevel = options.maximumLevel;
      if (options.minimumLevel !== undefined) item.minimumLevel = options.minimumLevel;
      if (options.bbox) item.bbox = options.bbox;
      if (options.tileSize !== undefined) item.tileSize = options.tileSize;
      tileLayers.push(item);
      layerState.set(id, item);
      layerOrder.push(id);
    }

    if (type === "3dtiles" || type === "geojson" || type === "geoparquet" || type === "flatgeobuf" || type === "layer" || type === "gpkg" || type === "geopackage") {
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const url = resolveProjectUrl(parts[1]);
      const off = parts.some(part => /^(off|false)$/i.test(part));
      const proxy = !parts.some(part => /^proxy\s*=\s*(off|false|direct)$/i.test(part));
      if (!title) return;
      const { group, title: displayTitle, exclusiveGroup } = parseLayerTitle(title);
      const id = `inspector-layer-${inspectorLayerIndex++}`;
      const item = { id, title: displayTitle, sourceTitle: title, sourceLine: line, type, url, visible: !off, attribution: parseAttributionField(parts[2]), proxy, group, exclusiveGroup };
      // render=primitive|entity: ベクター系の描画方式指定(duckdb:/sql: と同じ意味。
      // primitive は GeoJsonPrimitive バッチ描画、entity は GeoJsonDataSource 描画)
      if (type !== "3dtiles") {
        const render = parts.find(part => /^render\s*=\s*(primitive|fast|batch|entity|datasource)$/i.test(part));
        if (render) {
          item.renderPrimitive = !/=\s*(entity|datasource)$/i.test(render);
          item.renderSpecified = true;
        }
        // attr=出典: 出典スロット(3番目のフィールド)以外でもオプション形式で指定可能にする
        const attr = parts.find(part => /^attr(?:ibution)?\s*=\s*\S/i.test(part));
        if (attr) item.attribution = attr.slice(attr.indexOf("=") + 1).trim();
        // style=QML URL: QGIS レイヤースタイル(.qml)を取得して描画に適用する
        const styleOpt = parts.find(part => /^style\s*=\s*\S/i.test(part));
        if (styleOpt) item.styleUrl = resolveProjectUrl(styleOpt.slice(styleOpt.indexOf("=") + 1).trim());
        // table=地物テーブル名: 複数レイヤーを持つ GPKG の読み取り対象を指定
        const tableOpt = parts.find(part => /^table\s*=\s*\S/i.test(part));
        if (tableOpt) item.gpkgTable = tableOpt.slice(tableOpt.indexOf("=") + 1).trim();
        // GPKG の絞り込みオプション(sql.js に渡す SQLite 式)。
        // where= の値に | は含められない(行の区切り文字)。
        // bbox=auto は既定 ON(表示範囲連動のクエリ系)。常時全件描画にしたい場合は bbox=off で明示解除する
        if (type === "gpkg" || type === "geopackage") {
          const whereOpt = parts.find(part => /^where\s*=\s*\S/i.test(part));
          if (whereOpt) item.where = whereOpt.slice(whereOpt.indexOf("=") + 1).trim();
          const limitOpt = parts.find(part => /^limit\s*=\s*\d+/i.test(part));
          if (limitOpt) {
            const n = Number(limitOpt.slice(limitOpt.indexOf("=") + 1).trim());
            if (Number.isInteger(n) && n > 0) item.limit = n;
          }
          const colsOpt = parts.find(part => /^(?:columns|cols)\s*=\s*\S/i.test(part));
          if (colsOpt) item.columns = colsOpt.slice(colsOpt.indexOf("=") + 1).split(",").map(s => s.trim()).filter(Boolean);
          const bboxOpt = parts.find(part => /^bbox\s*=\s*\S+/i.test(part));
          if (bboxOpt) {
            const v = bboxOpt.slice(bboxOpt.indexOf("=") + 1).trim();
            if (/^(auto|on|true|view|viewport)$/i.test(v)) item.bboxAuto = true;
            else if (/^(off|none|false|static|manual)$/i.test(v)) item.bboxAuto = false;
          }
          if (item.bboxAuto === undefined) item.bboxAuto = true;
          item.sourceVisible = !off;
        }
      }
      layers.push(item);
      layerState.set(id, item);
      layerOrder.push(id);
    }

    // duckdb: タイトル | URL | 出典 | where=/limit=/geom=/lon=/lat=/format=/columns=/covering=/bbox=auto|off/render=/proxy=on | on/off
    // bbox=auto は既定 ON(表示範囲連動)。常時全件描画にしたい場合は bbox=off で明示解除する
    // proxy=on: ローカルサーバーの /api/fetch 経由で取得(CORS回避。Range 転送で Parquet の部分読みも可)
    // 単一ファイルを DuckDB-WASM で読み、SQL の絞り込みを適用してから描画する
    // columns= は読む属性列の絞り込み(列プルーニング)、covering= は xmin,xmax,ymin,ymax の列名指定
    // 描画は既定で entity(GeoJsonDataSource・地形ドレープ可)。render=primitive で
    // GeoJsonPrimitive バッチ(entity 非経由・ドレープ不可だが大量地物向け)に切替可
    if (type === "duckdb") {
      const parts = value.split("|").map(part => part.trim());
      const title = parts[0];
      const url = resolveProjectUrl(parts[1]);
      const off = parts.some(part => /^(off|false)$/i.test(part));
      if (!title || !url) return;
      const { group, title: displayTitle, exclusiveGroup } = parseLayerTitle(title);
      const id = `inspector-layer-${inspectorLayerIndex++}`;
      // parts[2] は出典スロット。ただし key=value 形式(オプション)なら出典ではなく
      // オプションとして解釈するため、その場合は options 走査を parts[2] から始める
      const attribution = parseAttributionField(parts[2]);
      const item = { id, title: displayTitle, sourceTitle: title, sourceLine: line, type, url, visible: !off, sourceVisible: !off, attribution, group, exclusiveGroup, renderPrimitive: false, proxy: false };
      parts.slice(attribution ? 3 : 2).forEach(part => {
        const eq = part.indexOf("=");
        if (eq < 0) return;
        const key = part.slice(0, eq).trim().toLowerCase();
        const raw = part.slice(eq + 1).trim();
        const number = Number(raw);
        if (key === "where" && raw) item.where = raw;
        else if ((key === "geom" || key === "geometry") && raw) item.geom = raw;
        else if ((key === "lon" || key === "lng") && raw) item.lon = raw;
        else if (key === "lat" && raw) item.lat = raw;
        else if (key === "format" && raw) item.format = raw;
        else if ((key === "columns" || key === "cols") && raw) item.columns = raw.split(",").map(s => s.trim()).filter(Boolean);
        else if (key === "covering" && raw) item.covering = raw.split(",").map(s => s.trim()).filter(Boolean);
        else if (key === "render" && /^(primitive|fast|batch|entity|datasource)$/i.test(raw)) {
          item.renderPrimitive = !/^(entity|datasource)$/i.test(raw);
          item.renderSpecified = true;
        }
        else if (key === "bbox") {
          if (/^(auto|on|true|view|viewport)$/i.test(raw)) item.bboxAuto = true;
          else if (/^(off|none|false|static|manual)$/i.test(raw)) item.bboxAuto = false;
        }
        else if (key === "limit" && Number.isInteger(number) && number > 0) item.limit = number;
        else if (key === "proxy") item.proxy = /^(on|true|auto)$/i.test(raw);
        else if ((key === "attr" || key === "attribution") && raw) item.attribution = raw;
        else if (key === "table" && raw) item.gpkgTable = raw;
        // style=QML URL: QGIS レイヤースタイル(.qml)を取得して描画に適用する
        else if ((key === "style" || key === "qml") && raw) item.styleUrl = resolveProjectUrl(raw);
      });
      // 表示範囲連動を既定にする(常時全件描画にしたい場合は bbox=off で明示解除)
      if (item.bboxAuto === undefined) item.bboxAuto = true;
      layers.push(item);
      layerState.set(id, item);
      layerOrder.push(id);
    }

    // sql: タイトル | SELECT文(先頭の | 以降はすべてクエリ文字列として扱い | も使用可)。
    // 末尾の "| off" は非表示指定、"| render=entity" / "| render=primitive" は描画方式、
    // "| attr=出典" は出典表示(値に | は含められない)として末尾から順に解釈する。
    // 描画は既定で entity(地形ドレープ可)
    if (type === "sql") {
      const firstSep = value.indexOf("|");
      const title = firstSep < 0 ? "" : value.slice(0, firstSep).trim();
      let query = firstSep < 0 ? "" : value.slice(firstSep + 1).trim();
      let visible = true;
      let renderPrimitive = false;
      let renderSpecified = false;
      let attribution = "";
      let styleUrl = "";
      const tailRe = /\|\s*(off|false|render\s*=\s*[a-z]+|attr(?:ibution)?\s*=[^|]*|style\s*=\s*[^|]*)\s*$/i;
      let tail;
      while ((tail = tailRe.exec(query))) {
        const seg = tail[1].trim();
        const attrMatch = /^attr(?:ibution)?\s*=\s*(.*)$/i.exec(seg);
        const styleMatch = /^style\s*=\s*(.*)$/i.exec(seg);
        if (attrMatch) attribution = attrMatch[1].trim();
        else if (styleMatch) styleUrl = styleMatch[1].trim();
        else {
          const opt = seg.replace(/\s+/g, "").toLowerCase();
          if (opt === "off" || opt === "false") visible = false;
          else if (/^render=(entity|datasource)$/.test(opt)) { renderPrimitive = false; renderSpecified = true; }
          else if (/^render=(primitive|fast|batch)$/.test(opt)) { renderPrimitive = true; renderSpecified = true; }
          else break;
        }
        query = query.slice(0, tail.index).trim();
      }
      if (!title || !query) return;
      const { group, title: displayTitle, exclusiveGroup } = parseLayerTitle(title);
      const id = `inspector-layer-${inspectorLayerIndex++}`;
      const item = { id, title: displayTitle, sourceTitle: title, sourceLine: line, type, query, visible, sourceVisible: visible, attribution, group, exclusiveGroup, renderPrimitive, renderSpecified };
      if (styleUrl) item.styleUrl = resolveProjectUrl(styleUrl);
      layers.push(item);
      layerState.set(id, item);
      layerOrder.push(id);
    }
  });

  // プラグイン宣言レイヤーは inspector テキスト由来ではないため、
  // パース後に末尾へ再登録する
  for (const item of pluginLayers) {
    layers.push(item);
    layerState.set(item.id, item);
    layerOrder.push(item.id);
  }
  // インラインデータの一時レイヤーも同様に再登録する
  for (const item of dataLayers) {
    layers.push(item);
    layerState.set(item.id, item);
    layerOrder.push(item.id);
  }

  // plugin: 行の宣言を plugin-loader へ通知（カタログ/ストレージからのロード・停止は
  // loader が差分管理する。kasugaiApi 未初期化の起動直前呼び出しでは skip され、
  // 起動時の loadPlugins が最新 specs を読むので問題ない）
  window.kasugaiApi?.emit("inspector-plugins-changed", { plugins: window.kasugaiApi.getInspectorPlugins() });

  syncGoogle3dTilesLayer();
  basemaps.splice(0, basemaps.length, ...parsedBasemaps);
  // base: の先頭が既定。transparent/none の特殊行があれば地表透明/ベースマップなしに
  globeHidden = parsedBaseMode === "hide";
  selectedBasemap = parsedBaseMode ? null : (basemaps[0] || null);
  cameraPresets.splice(0, cameraPresets.length, ...parsedCameras);
  // bookmark: 行の XML を非同期で読み込み、カメラプリセットへ追加する
  void loadInspectorBookmarks(inspectorBookmarkSpecs.slice());
  const uniqueFlyPaths = [...new Map(flyPaths.map(path => [path.url, path])).values()];
  flyPaths.splice(0, flyPaths.length, ...uniqueFlyPaths);
  renderBasemapSelector();
  renderPresets();
  renderLayerList();
  updateThemeSelect();
  renderFlyPathSelect();
  void ensureDrawnRouteFlyPath();
  refreshLayers();
  updateSearchProvider();
  void applyInspectorCloud(inspectorCloudSpec);
  if (flyResume) {
    // 描画ルートは IndexedDB から非同期（直列キュー）で再登録される。
    // まず手動ウォークへ即座にフォールバックして入力を解放しつつ、同一タイトルの
    // ルートが再登録されたら位置・再生状態ごと復帰する（登録タイミングに依存しないようポーリング）
    void (async () => {
      let restored = false;
      for (let i = 0; i < 50 && !restored; i++) {
        uiHooks.resumeManualWalk?.();
        restored = await Promise.resolve(uiHooks.resumeFlyPathByTitle?.(flyResume.title, flyResume.distance, flyResume.active) ?? false).catch(() => false);
        if (!restored) await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
  }
}

// inspector の cloud: 行を実行する。/api/cloud/* はローカルサーバー版のみ
// 登録されるため、静的配信・Cloud Run 環境では status が取れず自動的に何もしない。
// 同一内容で接続済みなら serve を投げ直さない(再適用ごとの rclone 再起動を防ぐ)。
// 自発行した serve については発行時 spec をキーに記憶し、フォルダURL指定のような
// status から完全一致を判定できないケースでも再 apply で再起動しないようにする。
let inspectorCloudAppliedKey = null;
async function applyInspectorCloud(spec) {
  if (!spec) return;
  let status = null;
  try {
    const response = await fetch("/api/cloud/status", { cache: "no-store" });
    if (response.ok) status = await response.json();
  } catch {}
  if (!status) return;
  const setStatus = (text, isError = false) => {
    const el = document.querySelector("#cloud-status");
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "#c0392b" : "";
  };
  const showServing = serving => {
    const el = document.querySelector("#cloud-serve-status");
    if (el) {
      el.textContent = serving
        ? `${serving.remote}:${serving.root || (serving.folderId ? `#${serving.folderId}` : "")} (port ${serving.port}, ${serving.readOnly ? "RO" : "RW"}${serving.drive ? `, ${serving.drive}:` : ""})`
        : t("cloud.serve.none");
    }
  };
  try {
    if (spec.stop) {
      inspectorCloudAppliedKey = null;
      // serving が見えなくても stop は投げる(serve 発行直後の反映待ちで
      // status が Null を返す間に抜けると、後から serve が残り続ける)
      await fetch("/api/cloud/stop", { method: "POST" });
      setStatus(t("cloud.status.stopped"));
      showServing(null);
      return;
    }
    if (spec.off || !spec.remote) return;
    // rclone 未導入なら自動インストール(既定の配置先・install=off で無効化)。
    // インストール先は localStorage の設定値、未設定ならサーバー既定(Windows は C:\kasugai\rclone)
    if (!status.installed && spec.install) {
      setStatus(t("cloud.status.installing"));
      const installBody = {};
      let installDir = "";
      try { installDir = localStorage.getItem("kasugai.cloud.installDir") || ""; } catch (e) {}
      if (installDir) installBody.dir = installDir;
      const res = await fetch("/api/cloud/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(installBody),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || res.statusText);
      // 導入後の状態で serve を続行するため status を取り直す
      const res2 = await fetch("/api/cloud/status", { cache: "no-store" });
      if (res2.ok) status = await res2.json();
      if (!status.installed) throw new Error(t("cloud.rclone.notInstalled"));
    }
    const key = JSON.stringify(spec);
    const serving = status.serving;
    if (serving
      && serving.remote === spec.remote
      && !!serving.readOnly === spec.readOnly
      && (serving.drive || "") === (spec.drive || "")
      && (inspectorCloudAppliedKey === key
        || (!/^https?:\/\//i.test(spec.root) && (serving.root || "") === spec.root))) {
      showServing(serving);
      return;
    }
    setStatus(t("cloud.status.connecting"));
    const body = { remote: spec.remote, root: spec.root, readOnly: spec.readOnly };
    // ドライブ割当は Windows のみ(他OSで渡すとサーバーが400を返す)
    if (spec.drive && status.os === "windows") body.drive = spec.drive;
    const response = await fetch("/api/cloud/serve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || response.statusText);
    const data = text ? JSON.parse(text) : {};
    inspectorCloudAppliedKey = key;
    showServing(data.serving);
    setStatus(t("cloud.status.connected"));
    // クラウドタブの入力欄と揃えるため localStorage にも反映する
    try {
      localStorage.setItem("kasugai.cloud.remote", spec.remote);
      localStorage.setItem("kasugai.cloud.root", spec.root);
      localStorage.setItem("kasugai.cloud.perm", spec.readOnly ? "read" : "write");
      if (spec.drive) localStorage.setItem("kasugai.cloud.drive", spec.drive);
    } catch (e) {}
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

// tile.googleapis.com の URL には Maps API キー（BYO またはサーバー配布）を自動付与する。
// .kasc には key= を書かなくてよく、キーは設定に現れない
function withGoogleTileKey(url) {
  try {
    const u = new URL(url, window.location.href);
    if (u.hostname === "tile.googleapis.com" && !u.searchParams.get("key")) {
      const key = getMapsWsKey();
      if (!key) return url;
      u.searchParams.set("key", key);
      return u.toString();
    }
  } catch (e) {}
  return url;
}

// Google Photorealistic 3D Tiles: MapタブのトグルON時にレイヤ一覧へ自動追加する。
// inspectorテキストには書き込まないため .kasc エクスポートにAPIキーは含まれない。
const GOOGLE_3DTILES_LAYER_ID = "google-photorealistic-3dtiles";
function isGoogle3dTilesUrl(url) {
  try {
    return new URL(url, window.location.href).hostname === "tile.googleapis.com";
  } catch (e) { return false; }
}
function syncGoogle3dTilesLayer() {
  let enabled = false;
  let key = "";
  let toggleSet = false;
  try {
    const stored = localStorage.getItem("googleMaps3dTiles");
    toggleSet = stored !== null;
    enabled = stored === "1";
    key = localStorage.getItem("googleMapsApiKey") || "";
  } catch (e) {}
  // .kasc の 3dtiles: 行で Google Photorealistic が宣言済みならそちらを正本とし、
  // 組み込みレイヤーは追加しない(同名レイヤーの二重登録を防ぐ)。
  // トグルがユーザー操作で明示済みの場合のみ、宣言側の表示状態をトグルに同期する
  const declared = layers.find(item => item.id !== GOOGLE_3DTILES_LAYER_ID && item.type === "3dtiles" && isGoogle3dTilesUrl(item.url));
  const index = layers.findIndex(item => item.id === GOOGLE_3DTILES_LAYER_ID);
  if (declared) {
    if (index !== -1) {
      layers.splice(index, 1);
      layerState.delete(GOOGLE_3DTILES_LAYER_ID);
      const orderIndex = layerOrder.indexOf(GOOGLE_3DTILES_LAYER_ID);
      if (orderIndex !== -1) layerOrder.splice(orderIndex, 1);
    }
    if (toggleSet) declared.visible = enabled && Boolean(key);
    const toggleEl = document.querySelector("#google-3dtiles-toggle");
    if (toggleEl) toggleEl.checked = declared.visible;
    return;
  }
  if (enabled && key) {
    const url = `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key)}`;
    if (index === -1) {
      const item = { id: GOOGLE_3DTILES_LAYER_ID, title: "Google Photorealistic 3D Tiles", sourceTitle: "Google Photorealistic 3D Tiles", type: "3dtiles", url, visible: true, attribution: "Google", proxy: false };
      layers.push(item);
      layerState.set(item.id, item);
      layerOrder.push(item.id);
    } else {
      layers[index].url = url;
    }
  } else if (index !== -1) {
    layers.splice(index, 1);
    layerState.delete(GOOGLE_3DTILES_LAYER_ID);
    const orderIndex = layerOrder.indexOf(GOOGLE_3DTILES_LAYER_ID);
    if (orderIndex !== -1) layerOrder.splice(orderIndex, 1);
  }
}

function setupThreeJs() {
  const container = document.querySelector("#cesium-container");
  const canvas = document.createElement("canvas");
  canvas.id = "three-canvas";
  canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;";
  container.append(canvas);

  threeRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  threeRenderer.autoClear = false;
  threeRenderer.setPixelRatio(window.devicePixelRatio);
  const resize = () => {
    if (!viewer?.canvas) return;
    threeRenderer.setSize(viewer.canvas.clientWidth, viewer.canvas.clientHeight, false);
  };
  resize();
  window.addEventListener("resize", resize);

  threeScene = new THREE.Scene();
  threeScene.add(new THREE.HemisphereLight(0xffffff, 0x668080, 2.2));
  threeModel = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x168f84, roughness: 0.6, metalness: 0.1 }),
  );
  const modelPosition = Cesium.Cartesian3.fromDegrees(0, 0, 18);
  threeModel.position.set(modelPosition.x, modelPosition.y, modelPosition.z);
  threeModel.scale.setScalar(10000);
  threeModel.rotation.y = 0.6;
  threeScene.add(threeModel);

  threeCamera = new THREE.Camera();
  threeCamera.matrixAutoUpdate = false;

  viewer.scene.postRender.addEventListener(() => {
    if (!threeRenderer || !threeCamera) return;
    threeRenderer.state.reset();
    threeCamera.matrixWorldInverse.fromArray(viewer.camera.viewMatrix);
    threeCamera.matrixWorld.copy(threeCamera.matrixWorldInverse).invert();
    threeCamera.projectionMatrix.fromArray(viewer.camera.frustum.projectionMatrix);
    threeCamera.projectionMatrixInverse.copy(threeCamera.projectionMatrix).invert();
    threeRenderer.render(threeScene, threeCamera);
  });
}

function updateTopDownButton(is2D) {
  const topDownButton = document.querySelector("#top-down-button");
  if (!topDownButton) return;
  topDownButton.textContent = is2D ? "2D" : "3D";
  topDownButton.setAttribute("aria-label", is2D ? "2D top-down view" : "3D perspective view");
  topDownButton.setAttribute("title", is2D ? "2D top-down view" : "3D perspective view");
}

// 画面中央に映っている地表地点を返す。地形を優先し、拾えなければ楕円体で補完する
function pickGlobeScreenCenter() {
  const canvas = viewer.scene.canvas;
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const ray = viewer.camera.getPickRay(center);
  if (!ray) return null;
  let cartesian = null;
  try {
    cartesian = viewer.scene.globe.pick(ray, viewer.scene) || null;
  } catch (e) { /* 初期化直後などpickできない場合は楕円体にフォールバック */ }
  return cartesian
    || viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid)
    || null;
}

function setTopDown(is2D) {
  const ssec = viewer.scene.screenSpaceCameraController;
  ssec.enableTilt = !is2D;
  viewer.camera.constrainedAxis = is2D ? Cesium.Cartesian3.UNIT_Z : undefined;
  // 画面中央の地点を基点に、レイヤパネル側と同じ flyToFeature をそのまま使ってflyする。
  // heightにはカメラからその地点までの距離を渡し、切替前後で見え方のスケールを保つ。
  // pitch/headingはflyToFeatureが現在値を引き継ぐので省略（2D時は内部で-90°に固定される）。
  // 中央が地球を捉えない場合はカメラ真下の地点を基点にする
  const center = pickGlobeScreenCenter();
  const carto = center
    ? Cesium.Cartographic.fromCartesian(center)
    : Cesium.Cartographic.fromCartesian(viewer.camera.position);
  void flyToFeature(carto.latitude * 180 / Math.PI, carto.longitude * 180 / Math.PI, {
    height: center ? Cesium.Cartesian3.distance(viewer.camera.position, center) : carto.height,
  });
  updateTopDownButton(is2D);
}

function setupEvents() {
  document.querySelector("#basemap-select").addEventListener("change", event => {
    globeHidden = event.target.value === "__hide_globe__";
    if (!globeHidden) selectedBasemap = basemaps.find(b => b.id === event.target.value) || null;
    applyGlobeVisibility();
    updateMapAttribution();
    refreshLayers();
  });

  document.querySelector("#basemap-globe").addEventListener("click", openGoogleEarth);

  // cam プリセットの qgis_bookmarks XML / cam: 行テキスト 読込
  document.querySelector("#cams-import-file")?.addEventListener("change", async e => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const added = parseQgisBookmarksXml(await f.text()).map(bm => {
      const cam = qgisBookmarkToCam(bm);
      cam.bookmark = true;
      return cam;
    });
    if (!added.length) return;
    cameraPresets.push(...added);
    renderPresets();
  });
  document.querySelector("#cams-import-cam-file")?.addEventListener("change", async e => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const added = parseKasc(await f.text()).cams.map(c => ({
      title: c.name || "cam", latitude: c.latitude, longitude: c.longitude,
      height: c.height, pitch: c.pitch, heading: c.heading,
    }));
    if (!added.length) return;
    cameraPresets.push(...added);
    renderPresets();
  });

  document.querySelector("#apply-camera").addEventListener("click", () => {
    const next = {};
    ["longitude", "latitude", "height", "pitch", "heading"].forEach(key => {
      const value = Number(document.querySelector(`#camera-${key}`).value);
      if (Number.isFinite(value)) next[key] = value;
    });
    flyTo(next);
  });

  const searchProvider = document.querySelector("#search-provider");
  if (searchProvider) {
    searchProvider.addEventListener("change", () => {
      const searchYahooWarning = document.querySelector("#search-yahoo-warning");
      if (searchYahooWarning) searchYahooWarning.style.display = (searchProvider.value === "yahoo") ? "" : "none";
    });
  }
  updateSearchProvider();

  document.querySelector("#search-form").addEventListener("submit", async event => {
    event.preventDefault();
    const query = document.querySelector("#search-query").value.trim();
    const results = document.querySelector("#search-results");
    if (!query) {
      results.innerHTML = '<li style="padding:8px;color:#71818d;">' + escapeHtml(t("search.enterQuery")) + '</li>';
      return;
    }
    results.innerHTML = '<li style="padding:8px;color:#71818d;">' + escapeHtml(t("search.searching")) + '</li>';
    try {
      const provider = searchProviders[searchProvider?.value] || searchProviders.gsi;
      const items = await provider(query);
      const validItems = items.filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
      if (!validItems.length) {
        results.innerHTML = '<li style="padding:8px;color:#71818d;">' + escapeHtml(t("search.noResults")) + '</li>';
        return;
      }
      const hasSvKey = !!getMapsWsKey();
      results.innerHTML = validItems.map((item, index) => `
        <li style="padding:0;border-bottom:1px solid #e4ecef;display:flex;align-items:stretch;">
          <button type="button" data-search-index="${index}" style="flex:1;min-width:0;padding:6px 8px;border:0;background:transparent;cursor:pointer;text-align:left;">
            <span style="display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.title)}</span>
            <span style="display:block;font-size:0.85em;color:#52636d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.address)}</span>
          </button>
          ${hasSvKey ? `<button type="button" data-sv-index="${index}" title="Street View" style="flex:0 0 auto;border:0;border-left:1px solid #e4ecef;background:transparent;cursor:pointer;padding:0 8px;font-size:0.85em;">SV</button>` : ""}
        </li>
      `).join("");
      results.querySelectorAll("[data-search-index]").forEach(button => {
        button.addEventListener("click", () => {
          const item = validItems[Number(button.dataset.searchIndex)];
          flyToFeature(item.latitude, item.longitude);
        });
      });
      results.querySelectorAll("[data-sv-index]").forEach(button => {
        button.addEventListener("click", () => {
          const item = validItems[Number(button.dataset.svIndex)];
          void openStreetViewAt(item.latitude, item.longitude);
        });
      });
    } catch (error) {
      results.innerHTML = `<li style="padding:8px;color:#a82020;">${escapeHtml(error instanceof Error ? error.message : t("search.failed"))}</li>`;
    }
  });

  const streetviewPickBtn = document.querySelector("#streetview-pick");
  if (streetviewPickBtn) {
    streetviewPickBtn.addEventListener("click", () => {
      streetViewPickMode = !streetViewPickMode;
      updateStreetViewPickButton();
      void updateStreetViewPickCoverage();
    });
  }
  const streetviewCoverage = document.querySelector("#streetview-coverage");
  if (streetviewCoverage) {
    streetviewCoverage.addEventListener("change", event => {
      svCoverageAutoOn = false; // 手動操作は自動制御を解除
      setStreetViewCoverage(event.target.checked);
    });
  }

  document.querySelector("#terrain-toggle").addEventListener("change", event => {
    terrainEnabled = event.target.checked;
    refreshLayers();
  });

  // 地形の誇張（CesiumJS 1.113+ の scene.verticalExaggeration。地形と 3D Tiles に同時に効く）
  const terrainExaggInput = document.querySelector("#terrain-exaggeration");
  const terrainExaggValue = document.querySelector("#terrain-exaggeration-value");
  if (terrainExaggInput) {
    terrainExaggInput.addEventListener("input", event => {
      const v = Number(event.target.value);
      viewer.scene.verticalExaggeration = Number.isFinite(v) ? v : 1;
      if (terrainExaggValue) terrainExaggValue.textContent = `×${(Number.isFinite(v) ? v : 1).toFixed(1)}`;
      requestRender();
    });
  }

  // ---- 表示>一般タブ: 透過度スライダ・スケールバー・カーソル座標・クリックポップアップ ----
  const scalebarEl = document.querySelector("#cesium-scalebar");
  const coordsEl = document.querySelector("#cesium-coords");
  const attrPopupEl = document.querySelector("#attr-popup");

  const basemapOpacityInput = document.querySelector("#display-basemap-opacity");
  if (basemapOpacityInput) {
    basemapOpacityInput.addEventListener("input", event => {
      basemapOpacityFactor = Number(event.target.value) || 0;
      if (basemapImageryLayer) basemapImageryLayer.alpha = (basemapImageryLayer._baseAlpha ?? 1) * basemapOpacityFactor;
      requestRender();
    });
  }
  const layerOpacityInput = document.querySelector("#display-layer-opacity");
  if (layerOpacityInput) {
    layerOpacityInput.addEventListener("input", event => {
      layerOpacityFactor = Number(event.target.value) || 0;
      const len = viewer.imageryLayers.length;
      for (let i = 0; i < len; i++) {
        const l = viewer.imageryLayers.get(i);
        if (l === basemapImageryLayer) continue;
        l.alpha = (l._baseAlpha ?? l.alpha) * layerOpacityFactor;
      }
      requestRender();
    });
  }

  // スケールバー: 画面中心の地表までの距離からメートル/ピクセルを出し、
  // 概ね110pxになる丸めた距離(1,2,5系)を表示する。camera.changed で更新
  function updateCesiumScalebar() {
    if (!scalebarEl) return;
    if (!document.querySelector("#display-scalebar")?.checked) { scalebarEl.hidden = true; return; }
    try {
      const canvas = viewer.canvas;
      const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
      const ray = viewer.camera.getPickRay(center);
      const ground = ray && (viewer.scene.globe.pick(ray, viewer.scene) || viewer.camera.pickEllipsoid(center));
      if (!ground) { scalebarEl.hidden = true; return; }
      const dist = Cesium.Cartesian3.distance(viewer.camera.position, ground);
      const fovy = viewer.camera.frustum.fovy;
      const mpp = (2 * dist * Math.tan(fovy / 2)) / canvas.clientHeight;
      if (!Number.isFinite(mpp) || mpp <= 0) { scalebarEl.hidden = true; return; }
      const target = mpp * 110;
      const pow10 = Math.pow(10, Math.floor(Math.log10(target)));
      let nice = pow10;
      for (const m of [1, 2, 5, 10]) { if (m * pow10 >= target) { nice = m * pow10; break; } }
      scalebarEl.style.width = `${Math.max(20, nice / mpp)}px`;
      scalebarEl.textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
      scalebarEl.hidden = false;
    } catch (_) { scalebarEl.hidden = true; }
  }
  viewer.camera.changed.addEventListener(updateCesiumScalebar);
  document.querySelector("#display-scalebar")?.addEventListener("change", updateCesiumScalebar);
  setTimeout(updateCesiumScalebar, 1500);

  // カーソル座標(楕円体上の緯度経度。地形ピックは高負荷のため拾わない)
  viewer.canvas.addEventListener("pointermove", e => {
    if (!coordsEl) return;
    if (!document.querySelector("#display-coords")?.checked) { coordsEl.hidden = true; return; }
    const rect = viewer.canvas.getBoundingClientRect();
    const pos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
    const cart = viewer.camera.pickEllipsoid(pos, viewer.scene.globe.ellipsoid);
    if (!cart) { coordsEl.hidden = true; return; }
    const c = Cesium.Cartographic.fromCartesian(cart);
    coordsEl.textContent = `${(c.latitude * 180 / Math.PI).toFixed(5)}, ${(c.longitude * 180 / Math.PI).toFixed(5)}`;
    coordsEl.hidden = false;
  });
  document.querySelector("#display-coords")?.addEventListener("change", e => {
    if (coordsEl && !e.target.checked) coordsEl.hidden = true;
  });

  // 地物クリックの属性ポップアップ(オプション)。既存の属性パネル表示はそのまま併用する
  viewer.canvas.addEventListener("click", e => {
    if (!attrPopupEl) return;
    attrPopupEl.hidden = true;
    if (!document.querySelector("#display-popup")?.checked) return;
    if (walkModeActive || streetViewPickMode) return;
    const rect = viewer.canvas.getBoundingClientRect();
    const pos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
    const pickedList = viewer.scene.drillPick(pos, 8) || [];
    const time = Cesium.JulianDate.now();
    const seen = new Set();
    const frag = document.createDocumentFragment();
    let count = 0;
    for (const picked of pickedList) {
      const key = picked?.id || picked?.properties || picked;
      if (seen.has(key)) continue;
      seen.add(key);
      let entries = null, label = "";
      if (picked?.id?.properties) {
        entries = Object.entries(picked.id.properties.getValue(time) || {});
        label = typeof picked.id.name === "string" ? picked.id.name : "";
      } else if (picked?.properties) {
        entries = Object.entries(picked.properties);
      } else if (typeof picked?.getPropertyNames === "function") {
        entries = picked.getPropertyNames().map(n => [n, picked.getProperty(n)]);
      }
      if (!entries || !entries.length) continue;
      if (label) {
        const t = document.createElement("div");
        t.className = "attr-popup-title";
        t.textContent = label;
        frag.append(t);
      }
      frag.append(buildAttrTable(entries.slice(0, 30)));
      if (++count >= 4) break;
    }
    if (!count) return;
    attrPopupEl.replaceChildren(frag);
    const vw = viewer.canvas.parentElement.getBoundingClientRect();
    let px = e.clientX - vw.left + 12, py = e.clientY - vw.top + 8;
    attrPopupEl.style.left = `${Math.min(px, Math.max(0, vw.width - 310))}px`;
    attrPopupEl.style.top = `${Math.min(py, Math.max(0, vw.height - 250))}px`;
    attrPopupEl.hidden = false;
  });
  viewer.camera.changed.addEventListener(() => { if (attrPopupEl) attrPopupEl.hidden = true; });

  document.querySelector("#dem-source").addEventListener("change", event => {
    selectedDemSource = event.target.value;
    terrainEnabled = true;
    document.querySelector("#terrain-toggle").checked = true;
    refreshLayers();
  });

  document.querySelector("#basemap-drape-3dtiles").addEventListener("change", event => {
    basemapDrape3DTiles = event.target.checked;
    refreshLayers();
  });

  document.querySelector("#drape-terrain-dem").addEventListener("change", event => {
    drapeTerrainSources.dem = event.target.checked;
    refreshLayers();
  });

  document.querySelector("#drape-terrain-tiles3d").addEventListener("change", event => {
    drapeTerrainSources.tiles3d = event.target.checked;
    refreshLayers();
  });

  // ドレープ対象地形ごとの適用レイヤー(DEM / 3D Tiles × XYZ / ベクター / 高速ドレープ)
  [
    ["#drape-xyz-dem", "dem", "xyz"],
    ["#drape-geojson-dem", "dem", "geojson"],
    ["#drape-geojson-primitive-dem", "dem", "primitive"],
    ["#drape-xyz-tiles3d", "tiles3d", "xyz"],
    ["#drape-geojson-tiles3d", "tiles3d", "geojson"],
    ["#drape-geojson-primitive-tiles3d", "tiles3d", "primitive"],
  ].forEach(([selector, target, kind]) => {
    document.querySelector(selector)?.addEventListener("change", event => {
      drapeLayers[target][kind] = event.target.checked;
      refreshLayers();
    });
  });

  // ベクター描画件数の上限(フリーズ防止)。変更時は全レイヤーを再描画して反映
  document.querySelector("#vector-entity-limit")?.addEventListener("change", () => refreshLayers());

  ["#effect-terrain-lighting", "#effect-translucency", "#effect-fog", "#effect-sky-atmosphere", "#effect-shadows", "#effect-depth-test"].forEach(selector => {
    document.querySelector(selector)?.addEventListener("change", () => updateEffectSettings());
  });

  const transparencyInput = document.querySelector("#underground-transparency");
  const transparencyValue = document.querySelector("#underground-transparency-value");
  transparencyInput.addEventListener("input", event => {
    undergroundTransparency = Number(event.target.value);
    if (transparencyValue) transparencyValue.textContent = `${Math.round(undergroundTransparency * 100)}%`;
    updateUndergroundView();
    updateEffectSettings();
  });

  const undergroundDiveToggle = document.querySelector("#underground-dive-toggle");
  undergroundDiveToggle.checked = undergroundDiveEnabled;
  undergroundDiveToggle.addEventListener("change", event => {
    undergroundDiveEnabled = event.target.checked;
    updateUndergroundView();
  });

  ["#cesium-sse", "#cesium-max-memory"].forEach(selector => {
    document.querySelector(selector).addEventListener("change", () => refreshLayers());
  });

  ["#cesium-dynamic-sse", "#cesium-cull-children", "#cesium-prefer-leaves", "#cesium-skip-lod"].forEach(selector => {
    document.querySelector(selector).addEventListener("change", () => refreshLayers());
  });

  function setClipStatus(message, isError = false) {
    const status = document.querySelector("#clip-status");
    status.textContent = message;
    status.style.color = isError ? "#a82020" : "";
  }

  function applyClip(type) {
    const normals = {
      ns: new Cesium.Cartesian3(1, 0, 0),
      ew: new Cesium.Cartesian3(0, 1, 0),
      h: new Cesium.Cartesian3(0, 0, 1),
    };
    const normal = normals[type];
    if (!normal) {
      activeClippingPlanes.planes = [];
      refreshLayers();
      setClipStatus(t("clip.cleared"));
      return;
    }
    try {
      activeClippingPlanes.planes = [createClippingPlaneFromEnu(normal)];
      refreshLayers();
      setClipStatus(t("clip.applied", { type: type.toUpperCase() }));
    } catch (error) {
      setClipStatus(t("clip.error", { error: error.message }), true);
    }
  }

  uiHooks.applyClip = applyClip;

  document.querySelector("#clip-ns").addEventListener("click", () => applyClip("ns"));
  document.querySelector("#clip-ew").addEventListener("click", () => applyClip("ew"));
  document.querySelector("#clip-h").addEventListener("click", () => applyClip("h"));
  document.querySelector("#clip-clear").addEventListener("click", () => applyClip("clear"));

  document.querySelector("#compass-button").addEventListener("click", () => {
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    flyTo({
      latitude: c.latitude * 180 / Math.PI,
      longitude: c.longitude * 180 / Math.PI,
      height: c.height,
      pitch: viewer.camera.pitch * 180 / Math.PI,
      heading: 0,
    });
  });

  document.querySelector("#top-down-button").addEventListener("click", () => {
    setTopDown(viewer.scene.screenSpaceCameraController.enableTilt);
  });

  function getBearing(a, b) {
    const lat1 = a.latitude * Math.PI / 180;
    const lat2 = b.latitude * Math.PI / 180;
    const dLng = (b.longitude - a.longitude) * Math.PI / 180;
    const x = Math.sin(dLng) * Math.cos(lat2);
    const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return Math.atan2(x, y);
  }
  function lerpBearing(a, b, t) {
    let diff = b - a;
    while (diff <= -Math.PI) diff += 2 * Math.PI;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    return a + diff * t;
  }
  function updateFlyPathCamera(distance) {
    const path = flyPathCoords;
    const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
    let flyDistance = distance;
    if (flyDistance > total) flyDistance = total;
    if (flyDistance < 0) flyDistance = 0;

    let idx = 0;
    while (idx + 1 < flyPathCumulativeDistances.length && flyDistance >= flyPathCumulativeDistances[idx + 1]) idx++;
    const nextIdx = Math.min(idx + 1, path.length - 1);
    const segDist = (flyPathCumulativeDistances[nextIdx] - flyPathCumulativeDistances[idx]) || 1;
    const segT = (flyDistance - flyPathCumulativeDistances[idx]) / segDist;
    const a = path[idx];
    const b = path[nextIdx];
    flyPathProgress = idx + segT;
    const lat = a.latitude + (b.latitude - a.latitude) * segT;
    const lng = a.longitude + (b.longitude - a.longitude) * segT;
    const alt = a.altitude + (b.altitude - a.altitude) * segT;
    const terrain = (a.terrain || 0) + ((b.terrain || 0) - (a.terrain || 0)) * segT;
    const height = alt + terrain + flyHeight;
    let heading = getBearing(a, b);
    if (nextIdx + 1 < path.length) {
      const nextBearing = getBearing(path[nextIdx], path[nextIdx + 1]);
      const remaining = (1 - segT) * segDist;
      const blendStart = Math.min(segDist, 100);
      const blend = remaining < blendStart ? 1 - (remaining / blendStart) : 0;
      heading = lerpBearing(heading, nextBearing, blend);
    }
    const pitchDeg = Math.max(-85, Math.min(flyPath.view === "center" ? -1 : 0, flyPath.pitch));
    const pitch = pitchDeg * Math.PI / 180;
    let camLat = lat;
    let camLng = lng;
    if (flyPath.view === "center") {
      // 画面中心: ルート点が画面中心に来るよう、進行方向の後方・上空にカメラを置く
      const backDistance = flyHeight > 0 ? flyHeight / Math.tan(-pitch) : 0;
      camLat -= (Math.cos(heading) * backDistance) / 111320;
      camLng -= (Math.sin(heading) * backDistance) / (111320 * Math.cos(lat * Math.PI / 180));
    }

    try {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(camLng, camLat, height),
        orientation: { heading, pitch, roll: 0 },
      });
      viewer.scene.requestRender();
    } catch (error) {
      console.error("flyPathLoop setView error:", error);
    }

    if (walkOffsetEl && document.activeElement !== walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
    if (walkTerrainEl) walkTerrainEl.textContent = (alt + flyHeight).toFixed(1);
    if (walkTerrainLabelEl) walkTerrainLabelEl.textContent = t("walk.agl");
    if (walkSpeedEl && document.activeElement !== walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
    if (walkPitchEl && document.activeElement !== walkPitchEl) walkPitchEl.value = (pitch * 180 / Math.PI).toFixed(1);
  }
  function getTargetVertexDistance(direction) {
    if (!flyPathCoords || flyPathCoords.length < 2 || !flyPathCumulativeDistances.length) return null;
    const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
    if (direction > 0) {
      if (flyPathDistance >= total - 0.001) return null;
      return total;
    }
    if (flyPathDistance <= 0.001) return null;
    return 0;
  }
  function pauseFlyPath() {
    if (flyPathRafId !== null) {
      cancelAnimationFrame(flyPathRafId);
      flyPathRafId = null;
    }
    flyPathActive = false;
  }
  function toggleFlyPathDirection(direction) {
    if (!flyPathCoords || flyPathCoords.length < 2) return;
    if (flyPathActive && flyPathTargetDistance !== null) {
      const movingForward = flyPathTargetDistance > flyPathDistance;
      const movingBackward = flyPathTargetDistance < flyPathDistance;
      if ((direction > 0 && movingForward) || (direction < 0 && movingBackward)) {
        pauseFlyPath();
        return;
      }
    }
    const target = getTargetVertexDistance(direction);
    if (target === null) return;
    flyPathTargetDistance = target;
    if (walkRafId !== null) {
      cancelAnimationFrame(walkRafId);
      walkRafId = null;
    }
    if (flyPathRafId === null) {
      flyPathActive = true;
      flyPathLastTime = performance.now();
      flyPathRafId = requestAnimationFrame(flyPathLoop);
    }
  }

  function stopFlyPath() {
    flyPathActive = false;
    flyPathTargetDistance = null;
    if (flyPathRafId !== null) {
      cancelAnimationFrame(flyPathRafId);
      flyPathRafId = null;
    }
    if (flyPathEntity) {
      viewer.entities.remove(flyPathEntity);
      flyPathEntity = null;
    }
    flyPath = null;
    flyPathProperties = {};
    flyPathCoords = null;
    flyPathCumulativeDistances = [];
    flyPathDistance = 0;
    flyPathProgress = 0;
    flyPathLinePositions = [];
    updateFlyPointEditor();
    updateFlyPathVisibilityButton();
  }

  async function startFlyPath(index) {
    if (!Number.isFinite(index) || index < 0 || index >= flyPaths.length) return;
    if (flyPathRafId !== null) {
      cancelAnimationFrame(flyPathRafId);
      flyPathRafId = null;
    }
    flyPath = flyPaths[index];
    try {
      const pathData = await loadFlyGeoJson(flyPath.url);
      flyPathCoords = pathData.points;
      flyPathCumulativeDistances = pathData.distances;
      flyPathProperties = pathData.properties || {};
    } catch (error) {
      console.error("Fly GeoJSON の読み込みに失敗しました:", error);
      flyPathCoords = null;
      flyPathCumulativeDistances = [];
      flyPathProperties = {};
      flyPathActive = false;
      return;
    }
    if (!flyPathCoords || !flyPathCoords.length) return;
    flySpeed = Number.isFinite(flyPath.speed) ? Number(flyPath.speed) : 30;
    flyHeight = Number.isFinite(flyPath.height) ? Number(flyPath.height) : 0;
    if (walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
    if (walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
    if (flyViewSelect) flyViewSelect.value = flyPath.view === "center" ? "center" : "camera";
    if (!flyPathCoords || !flyPathCoords.length) return;
    // heightReference: MSL のルートは座標高度が絶対標高のため地形加算しない
    const absoluteAltitude = /^(msl|absolute)$/i.test(String(flyPathProperties.heightReference || ""));
    for (const point of flyPathCoords) {
      const carto = Cesium.Cartographic.fromDegrees(point.longitude, point.latitude);
      point.terrain = absoluteAltitude ? 0 : (carto ? (viewer.scene.globe.getHeight(carto) ?? 0) : 0);
    }
    flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
    if (flyPathEntity) viewer.entities.remove(flyPathEntity);
    flyPathEntity = viewer.entities.add({
      show: true,
      polyline: {
        positions: new Cesium.CallbackProperty(() => getFlyPathLinePositions(), false),
        width: 8,
        material: new Cesium.PolylineGlowMaterialProperty({ color: Cesium.Color.YELLOW, glowPower: 0.25 }),
      },
    });
    requestRender();
    flyPathProgress = 0;
    flyPathDistance = 0;
    flyPathTargetDistance = null;
    flyPathActive = false;
    if (flyPathRafId !== null) {
      cancelAnimationFrame(flyPathRafId);
      flyPathRafId = null;
    }
    updateFlyPathCamera(0);
    updateFlyPointEditor();
    updateFlyPathVisibilityButton();
  }

  let flyPathLastTime = performance.now();
  const flyPathLoop = (timestamp) => {
    flyPathRafId = null;
    if (!flyPathActive || !flyPathCoords || !flyPathCoords.length) return;
    try {
      // rAF の timestamp はフレーム開始時刻のため直前に取った performance.now() より
      // 過去になり得る。負の delta は flyPathDistance<0 判定で即停止してしまうので 0 下限にする
      const delta = Math.max(0, Math.min((timestamp - flyPathLastTime) / 1000, 0.1));
      flyPathLastTime = timestamp;
      applyWalkKeys(delta);

      const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
      if (flyPathTargetDistance !== null) {
        const stepMeters = Math.abs(flySpeed / 3.6) * delta;
        const diff = flyPathTargetDistance - flyPathDistance;
        if (Math.abs(diff) <= stepMeters) {
          flyPathDistance = flyPathTargetDistance;
          flyPathTargetDistance = null;
          flyPathActive = false;
        } else {
          flyPathDistance += Math.sign(diff) * stepMeters;
          if (flyPathDistance > total) flyPathDistance = total;
          if (flyPathDistance < 0) flyPathDistance = 0;
        }
        updateFlyPathCamera(flyPathDistance);
      } else {
        const stepMeters = (flySpeed / 3.6) * delta;
        flyPathDistance += stepMeters;
        if (flyPathDistance > total) {
          if (flyPath.loop) {
            flyPathDistance = total > 0 ? flyPathDistance % total : 0;
          } else {
            flyPathDistance = total;
            updateFlyPathCamera(flyPathDistance);
            stopFlyPath();
            return;
          }
        }
        if (flyPathDistance < 0) {
          if (flyPath.loop && total > 0) {
            flyPathDistance = (total + (flyPathDistance % total)) % total;
          } else {
            flyPathDistance = 0;
            updateFlyPathCamera(flyPathDistance);
            stopFlyPath();
            return;
          }
        }

        updateFlyPathCamera(flyPathDistance);
      }

      if (flyPathActive) flyPathRafId = requestAnimationFrame(flyPathLoop);
    } catch (error) {
      console.error("flyPathLoop error:", error);
      stopFlyPath();
    }
  };

  const modeSelect = document.querySelector("#mode-select");
  const walkOffsetEl = document.querySelector("#walk-offset");
  const walkTerrainEl = document.querySelector("#walk-terrain");
  const walkTerrainLabelEl = document.querySelector("#walk-terrain-label");
  const walkSpeedEl = document.querySelector("#walk-speed");
  const walkPitchEl = document.querySelector("#walk-pitch");
  const flyPresetSelect = document.querySelector("#fly-preset-select");
  const flyViewSelect = document.querySelector("#fly-view-select");
  const flyPointEditor = document.querySelector("#fly-point-editor");
  const flyPointIndexEl = document.querySelector("#fly-point-index");
  const flyPointOffsetEl = document.querySelector("#fly-point-offset");
  const flyPointSaveEl = document.querySelector("#fly-point-save");
  const flyReverseBtn = document.querySelector("#fly-reverse-btn");
  const walkKeys = new Set();
  function updateFlyPointEditor() {
    if (!flyPointEditor || !flyPointIndexEl || !flyPointOffsetEl) return;
    if (!flyPathCoords || !flyPathCoords.length) {
      flyPointEditor.style.display = "none";
      return;
    }
    flyPointEditor.style.display = "";
    const currentIndex = Math.min(Math.max(0, Math.round(flyPathProgress) || 0), flyPathCoords.length - 1);
    flyPointIndexEl.innerHTML = "";
    for (let i = 0; i < flyPathCoords.length; i++) {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = String(i + 1);
      if (i === currentIndex) option.selected = true;
      flyPointIndexEl.appendChild(option);
    }
    const point = flyPathCoords[currentIndex];
    flyPointOffsetEl.value = Number.isFinite(point.altitude) ? point.altitude.toFixed(1) : "0.0";
  }
  async function saveFlyPointOffsets() {
    if (!flyPathCoords || !flyPath || !flyPath.url) return;
    const coordinates = flyPathCoords.map(p => [p.longitude, p.latitude, Number.isFinite(p.altitude) ? p.altitude : 0]);
    const properties = Object.keys(flyPathProperties || {}).length ? flyPathProperties : { heightReference: "Terrain", heightOffset: 0 };
    const geojson = {
      type: "Feature",
      properties,
      geometry: { type: "LineString", coordinates }
    };
    const text = JSON.stringify(geojson);
    try {
      if (flyPath.drawn?.kind === "idb") {
        await routeStore.set(currentProjectId || "default", flyPath.drawn.name, text);
      } else if (flyPath.drawn?.kind === "server") {
        const result = await window.kasugaiApi.saveDataFile(flyPath.drawn.name, text);
        if (!result?.ok) throw new Error(result?.error || "saveDataFile failed");
      } else if (flyPath.drawn?.kind === "file") {
        const dir = await getDataDirHandle();
        if (!dir) return;
        const file = await dir.getFileHandle(flyPath.drawn.name, { create: true });
        const writable = await file.createWritable();
        await writable.write(text);
        await writable.close();
      } else if (flyPath.url.startsWith("/api/data/")) {
        const response = await fetch(flyPath.url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: text });
        if (!response.ok) throw new Error(await response.text());
      } else {
        console.warn("このルートは保存できません（静的・外部URLのため）");
        return;
      }
      // 保存内容を反映した新しい blob URL に差し替える
      if (flyPath.url.startsWith("blob:")) {
        URL.revokeObjectURL(flyPath.url);
        flyPath.url = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
      }
      console.log("点の高さを保存しました");
    } catch (error) {
      console.error("点の高さの保存に失敗しました:", error);
    }
  }
  function applyWalkKeys(delta) {
    if (!flyPathCoords || flyPathCoords.length < 2) return;
    const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;

    const heightChange = (walkKeys.has("KeyQ") ? 1 : 0) - (walkKeys.has("KeyE") ? 1 : 0);
    if (heightChange !== 0) {
      flyHeight += 10 * heightChange * delta;
      if (flyPath) flyPath.height = flyHeight;
      if (flyPathCoords) flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
    }

    const speedChange = (walkKeys.has("Equal") || walkKeys.has("NumpadAdd") ? 1 : 0) -
      (walkKeys.has("Minus") || walkKeys.has("NumpadSubtract") ? 1 : 0);
    if (speedChange !== 0) {
      flySpeed += 20 * speedChange * delta;
      if (flySpeed < 0) flySpeed = 0;
      if (flyPath) flyPath.speed = flySpeed;
    }

    const pitchChange = (walkKeys.has("ArrowUp") ? 1 : 0) - (walkKeys.has("ArrowDown") ? 1 : 0);
    if (pitchChange !== 0 && flyPath) {
      flyPath.pitch += 20 * pitchChange * delta;
      flyPath.pitch = Math.max(-85, Math.min(0, flyPath.pitch));
    }

    const manualDirection = (walkKeys.has("KeyW") ? 1 : 0) - (walkKeys.has("KeyS") ? 1 : 0);
    if (manualDirection > 0) {
      flyPathTargetDistance = total;
    } else if (manualDirection < 0) {
      flyPathTargetDistance = 0;
    }
  }
  if (walkOffsetEl) {
    walkOffsetEl.addEventListener("input", () => {
      const value = Number(walkOffsetEl.value);
      if (!Number.isFinite(value)) {
        walkOffsetEl.value = flyHeight.toFixed(1);
        return;
      }
      flyHeight = value;
      if (flyPath) flyPath.height = value;
      if (flyPathActive && flyPath) flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
      if (flyPresetSelect) flyPresetSelect.value = "custom";
    });
  }
  if (walkSpeedEl) {
    walkSpeedEl.addEventListener("input", () => {
      const value = Number(walkSpeedEl.value);
      if (!Number.isFinite(value)) {
        walkSpeedEl.value = flySpeed.toFixed(1);
        return;
      }
      flySpeed = value;
      if (flyPath) flyPath.speed = value;
      if (flyPresetSelect) flyPresetSelect.value = "custom";
    });
  }
  if (walkPitchEl) {
    walkPitchEl.addEventListener("input", () => {
      const value = Number(walkPitchEl.value);
      if (!Number.isFinite(value)) {
        const currentDeg = (flyPath && Number.isFinite(flyPath.pitch)) ? flyPath.pitch : viewer.camera.pitch * 180 / Math.PI;
        walkPitchEl.value = Number.isFinite(currentDeg) ? currentDeg.toFixed(1) : "-10.0";
        return;
      }
      if (flyPath) {
        flyPath.pitch = Math.max(-85, Math.min(0, value));
        if (flyPathCoords) {
          flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
          updateFlyPathCamera(flyPathDistance);
        }
      } else if (walkModeActive) {
        const pitchRad = Math.max(-85 * Math.PI / 180, Math.min(-5 * Math.PI / 180, value * Math.PI / 180));
        viewer.camera.setView({
          destination: viewer.camera.position,
          orientation: { heading: viewer.camera.heading, pitch: pitchRad, roll: 0 }
        });
      }
      if (flyPresetSelect) flyPresetSelect.value = "custom";
    });
  }
  if (flyPresetSelect) {
    flyPresetSelect.addEventListener("change", () => {
      const presets = {
        walk: { height: 2, speed: 5, pitch: -5 },
        drive: { height: 2, speed: 60, pitch: -10 },
        drone: { height: 200, speed: 60, pitch: -30 },
        overview: { height: 1000, speed: 300, pitch: -45 }
      };
      const preset = presets[flyPresetSelect.value];
      if (!preset) return;
      flyHeight = preset.height;
      flySpeed = preset.speed;
      if (walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
      if (walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
      if (walkPitchEl) walkPitchEl.value = Number.isFinite(preset.pitch) ? preset.pitch.toFixed(1) : "-10.0";
      if (flyPath) {
        // 高さ・速度もルート設定へ反映（ピッチと同様に再スタート時も維持するため）
        flyPath.height = preset.height;
        flyPath.speed = preset.speed;
        if (Number.isFinite(preset.pitch)) flyPath.pitch = Math.max(-85, Math.min(0, preset.pitch));
      }
      if (flyPathCoords && flyPath) {
        flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
        updateFlyPathCamera(flyPathDistance);
      } else if (walkModeActive) {
        const pitchRad = Math.max(-85 * Math.PI / 180, Math.min(-5 * Math.PI / 180, preset.pitch * Math.PI / 180));
        viewer.camera.setView({
          destination: viewer.camera.position,
          orientation: { heading: viewer.camera.heading, pitch: pitchRad, roll: 0 }
        });
      }
    });
  }
  if (flyViewSelect) {
    flyViewSelect.addEventListener("change", () => {
      if (!flyPath) return;
      flyPath.view = flyViewSelect.value === "center" ? "center" : "camera";
      if (flyPathCoords) updateFlyPathCamera(flyPathDistance);
    });
  }
  if (flyPointIndexEl) {
    flyPointIndexEl.addEventListener("change", () => {
      const index = Number(flyPointIndexEl.value);
      if (!flyPathCoords || !flyPathCoords[index]) return;
      flyPointOffsetEl.value = Number.isFinite(flyPathCoords[index].altitude) ? flyPathCoords[index].altitude.toFixed(1) : "0.0";
    });
  }
  if (flyPointOffsetEl) {
    flyPointOffsetEl.addEventListener("input", () => {
      const index = Number(flyPointIndexEl.value);
      const value = Number(flyPointOffsetEl.value);
      if (!flyPathCoords || !flyPathCoords[index] || !Number.isFinite(value)) return;
      flyPathCoords[index].altitude = value;
      if (flyPathCoords) flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
    });
  }
  if (flyPointSaveEl) {
    flyPointSaveEl.addEventListener("click", saveFlyPointOffsets);
  }
  if (flyReverseBtn) {
    flyReverseBtn.addEventListener("click", () => {
      pauseFlyPath();
      if (flyPathCoords && flyPathCoords.length >= 2) {
        flyPathCoords.reverse();
        const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
        flyPathCumulativeDistances = flyPathCumulativeDistances.map((_, i, arr) => total - arr[arr.length - 1 - i]);
        flyPathLinePositions = buildFlyPathLinePositions(flyPathCoords);
        flyPathDistance = 0;
        updateFlyPathCamera(0);
        updateFlyPointEditor();
      } else if (walkModeActive) {
        const camera = viewer.camera;
        const heading = Cesium.Math.zeroToTwoPi(camera.heading + Math.PI);
        camera.setView({
          destination: camera.position,
          orientation: { heading, pitch: camera.pitch, roll: 0 }
        });
      }
    });
  }
  viewer.canvas.addEventListener("wheel", event => {
    if (!walkModeActive) return;
    event.preventDefault();
    flySpeed = flySpeed + Math.sign(event.deltaY) * 1;
    if (walkSpeedEl && document.activeElement !== walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
  }, { passive: false });
  let walkLastTime = performance.now();
  let autoMove = 0;
  let walkRafId = null;
  const walkLoop = (timestamp) => {
    walkRafId = null;
    const delta = Math.min((timestamp - walkLastTime) / 1000, 0.1);
    walkLastTime = timestamp;
    if (walkModeActive) {
      const camera = viewer.camera;
      let heading = camera.heading;
      let pitch = camera.pitch;

      const turnDelta = 1.5 * delta;
      if (walkKeys.has("KeyA") || walkKeys.has("ArrowLeft")) heading -= turnDelta;
      if (walkKeys.has("KeyD") || walkKeys.has("ArrowRight")) heading += turnDelta;

      const pitchDelta = 0.8 * delta;
      if (walkKeys.has("ArrowUp")) pitch += pitchDelta;
      if (walkKeys.has("ArrowDown")) pitch -= pitchDelta;
      pitch = Math.max(-85 * Math.PI / 180, Math.min(-5 * Math.PI / 180, pitch));

      const manualMove = (walkKeys.has("KeyW") ? 1 : 0) - (walkKeys.has("KeyS") ? 1 : 0);
      const move = (manualMove !== 0) ? manualMove : autoMove;
      const speedChange = (walkKeys.has("Equal") || walkKeys.has("NumpadAdd") ? 1 : 0) -
        (walkKeys.has("Minus") || walkKeys.has("NumpadSubtract") ? 1 : 0);
      flySpeed += 100 * speedChange * delta;
      const moveDistance = (flySpeed / 3.6) * delta;
      if (move !== 0) {
        const normal = viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(camera.position, new Cesium.Cartesian3());
        const dot = Cesium.Cartesian3.dot(camera.direction, normal);
        const horizontal = Cesium.Cartesian3.add(
          camera.direction,
          Cesium.Cartesian3.multiplyByScalar(normal, -dot, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        );
        Cesium.Cartesian3.normalize(horizontal, horizontal);
        camera.move(horizontal, move * moveDistance);
      }

      const carto = Cesium.Cartographic.fromCartesian(camera.position);
      if (carto) {
        const terrainHeight = viewer.scene.globe.getHeight(carto) ?? 0;
        const heightChange = (walkKeys.has("KeyQ") ? 1 : 0) - (walkKeys.has("KeyE") ? 1 : 0);
        flyHeight += 10 * heightChange * delta;
        carto.height = terrainHeight + flyHeight;
        camera.setView({
          destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
          orientation: { heading, pitch, roll: 0 },
        });
        if (walkOffsetEl && document.activeElement !== walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
        if (walkTerrainEl) walkTerrainEl.textContent = terrainHeight.toFixed(1);
        if (walkTerrainLabelEl) walkTerrainLabelEl.textContent = t("walk.terrain");
        if (walkSpeedEl && document.activeElement !== walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
        if (walkPitchEl && document.activeElement !== walkPitchEl) walkPitchEl.value = (pitch * 180 / Math.PI).toFixed(1);
      }
      walkRafId = requestAnimationFrame(walkLoop);
    }
  };
  const walkHelp = document.querySelector("#walk-help");
  const ssec = viewer.scene.screenSpaceCameraController;
  const defaultLookEventTypes = ssec.lookEventTypes;
  const defaultZoomEventTypes = ssec.zoomEventTypes ? [...ssec.zoomEventTypes] : [];
  const wheelEventType = Cesium.CameraEventType?.WHEEL;
  let drawTabActive = false;
  const walkZoomWithoutWheel = wheelEventType
    ? defaultZoomEventTypes.filter(t => t !== wheelEventType)
    : defaultZoomEventTypes;
  const setMode = (next) => {
    const isWalk = next === "walk";
    const wasWalk = walkModeActive;
    modeSelect.value = next;
    modeSelect.textContent = isWalk ? t("nav.fly") : t("nav.orbitMode");
    modeSelect.setAttribute("aria-label", isWalk ? t("nav.flyMode") : t("nav.orbit"));
    walkModeActive = isWalk;
    autoMove = 0;
    walkHelp?.classList.toggle("visible", isWalk || drawTabActive);
    if (flyReverseBtn) flyReverseBtn.disabled = !isWalk;
    if (isWalk) {
      const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
      if (carto) {
        const terrainHeight = viewer.scene.globe.getHeight(carto) ?? 0;
        flyHeight = carto.height - terrainHeight;
      }
    }
    ssec.enableZoom = true;
    ssec.lookEventTypes = defaultLookEventTypes;
    ssec.zoomEventTypes = isWalk && !drawTabActive
      ? walkZoomWithoutWheel
      : defaultZoomEventTypes;
    viewer.scene.mode = Cesium.SceneMode.SCENE3D;
    if (isWalk && !wasWalk) {
      const select = document.querySelector("#fly-path-select");
      const pathValue = select?.value || "__manual__";
      if (pathValue !== "__manual__" && !flyPathActive) {
        const index = Number(pathValue);
        if (Number.isFinite(index) && index >= 0 && index < flyPaths.length) void startFlyPath(index);
      } else if (pathValue === "__manual__" && !walkRafId) {
        stopFlyPath();
        walkLastTime = performance.now();
        walkRafId = requestAnimationFrame(walkLoop);
      }
    }
    if (!isWalk) {
      stopFlyPath();
      if (walkRafId) {
        cancelAnimationFrame(walkRafId);
        walkRafId = null;
      }
    }
  };
  uiHooks.setMode = setMode;
  uiHooks.startFlyPath = startFlyPath;
  uiHooks.stopFlyPath = stopFlyPath;
  // AIツール用: ルートを選択して読み込み、完了後に自動で前進開始する。
  // setMode("walk") 経由では startFlyPath が fire-and-forget で呼ばれるため、
  // 読み込み完了（flyPathCoords 反映）をポーリングで待ってからループを起動する
  uiHooks.playFlyPathAt = async (index, autoplay = true) => {
    const target = flyPaths[index];
    if (!target) return false;
    const select = document.querySelector("#fly-path-select");
    if (select) {
      // エントリは復元済みでも option が未描画の時間窓（ensureDrawnRouteFlyPath 完了前）がある。
      // 存在しない value を代入すると select.value は "" になり setMode が手動扱いするため、先に再描画する
      renderFlyPathSelect();
      select.value = String(index);
    }
    updateFlyPathDeleteButton();
    if (walkModeActive) {
      stopFlyPath();
      if (walkRafId) {
        cancelAnimationFrame(walkRafId);
        walkRafId = null;
      }
      await startFlyPath(index);
    } else {
      setMode("walk");
      // setMode は select.value 経由で startFlyPath を呼ぶ。何らかの理由で拾えなかった場合は直接呼ぶ
      if (flyPath !== target) await startFlyPath(index);
      for (let i = 0; i < 200 && (!flyPathCoords || !flyPathCoords.length); i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (flyPath !== target || !flyPathCoords || !flyPathCoords.length) return false;
    updateFlyPathVisibilityButton();
    if (autoplay) startFlyPathLoopIfNeeded();
    return true;
  };
  // AIツール用: フライパスの速度・高度・ピッチ等を変更する。再生中のルートなら即時反映する
  uiHooks.setFlySettings = (index, settings = {}) => {
    const entry = flyPaths[index];
    if (!entry) return false;
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
    if (num(settings.speed) > 0) entry.speed = num(settings.speed);
    if (num(settings.height) !== undefined) entry.height = num(settings.height);
    if (num(settings.pitch) !== undefined) entry.pitch = Math.max(-85, Math.min(0, num(settings.pitch)));
    if (num(settings.step) > 0) entry.step = num(settings.step);
    if (settings.loop !== undefined) entry.loop = !!settings.loop;
    if (settings.view !== undefined) entry.view = /^(center|chase|follow|3rd|third)$/i.test(String(settings.view)) ? "center" : "camera";
    if (flyPath === entry) {
      if (num(settings.speed) > 0) flySpeed = entry.speed;
      if (num(settings.height) !== undefined) flyHeight = entry.height;
      if (walkSpeedEl) walkSpeedEl.value = flySpeed.toFixed(1);
      if (walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
      if (flyViewSelect) flyViewSelect.value = entry.view;
    }
    return true;
  };
  // AIツール用: 目標の地上高(agl)を高度オフセットへ変換して適用する。
  // Terrain基準ルートはオフセット=地上高そのもの。MSLルート（高度焼き込み済み）は
  // 生成時の地上高(properties.agl、旧形式は疎サンプリングで推定)との差分をオフセットにする
  uiHooks.applyFlyAgl = async (entry, agl) => {
    let text;
    try {
      if (entry.drawn?.kind === "idb" && window._routeStoreGet) {
        text = await window._routeStoreGet(currentProjectId || "default", entry.drawn.name);
      } else {
        text = await (await fetch(entry.url)).text();
      }
    } catch (e) { return false; }
    let geojson;
    try { geojson = JSON.parse(text); } catch (e) { return false; }
    const coords = extractLineStringCoordinates(geojson);
    if (!coords.length) return false;
    let offset = agl;
    if (geojson.properties?.heightReference === "MSL") {
      const originalAgl = Number(geojson.properties?.agl);
      if (Number.isFinite(originalAgl)) {
        offset = agl - originalAgl;
      } else {
        // 生成時の地上高が不明な旧形式ルートは、8点の地形サンプルで焼き込み高度との差から推定する
        const count = Math.min(8, coords.length);
        const pts = [];
        const alts = [];
        for (let i = 0; i < count; i++) {
          const c = coords[Math.floor(i * (coords.length - 1) / Math.max(1, count - 1))];
          pts.push({ longitude: c[0], latitude: c[1] });
          alts.push(Number.isFinite(c[2]) ? c[2] : 0);
        }
        const terr = await sampleRouteTerrain(pts, flyPathRouteDistance(coords));
        const diffs = alts.map((a, i) => Number.isFinite(terr[i]) ? a - terr[i] : null).filter(Number.isFinite).sort((a, b) => a - b);
        offset = agl - (diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0);
      }
      // 目標地上高を保存へ記録（persistFlySettings は fly のみ書き戻すためここで保存）
      try {
        geojson.properties = { ...(geojson.properties || {}), agl };
        const newText = JSON.stringify(geojson);
        if (entry.drawn?.kind === "idb" && window._routeStoreSet) {
          await window._routeStoreSet(currentProjectId || "default", entry.drawn.name, newText);
        } else if (entry.drawn?.kind === "server" && typeof window.kasugaiApi?.saveDataFile === "function") {
          await window.kasugaiApi.saveDataFile(entry.drawn.name, newText);
        }
      } catch (e) { /* 保存失敗は無視 */ }
    }
    entry.height = offset;
    if (flyPath === entry) {
      flyHeight = offset;
      if (walkOffsetEl) walkOffsetEl.value = flyHeight.toFixed(1);
    }
    return true;
  };
  // 設定変更を GeoJSON properties.fly へ書き戻してリロード後も維持する（IDB/サーバー保存の描画ルートのみ）
  uiHooks.persistFlySettings = async (entry) => {
    if (!entry?.drawn) return;
    const fly = { speed: entry.speed, height: entry.height, pitch: entry.pitch, step: entry.step, loop: entry.loop, view: entry.view };
    try {
      if (entry.drawn.kind === "idb" && window._routeStoreGet && window._routeStoreSet) {
        const pid = currentProjectId || "default";
        const geojson = JSON.parse(await window._routeStoreGet(pid, entry.drawn.name));
        geojson.properties = { ...(geojson.properties || {}), fly };
        await window._routeStoreSet(pid, entry.drawn.name, JSON.stringify(geojson));
      } else if (entry.drawn.kind === "server" && typeof window.kasugaiApi?.saveDataFile === "function") {
        const geojson = JSON.parse(await (await fetch(entry.url)).text());
        geojson.properties = { ...(geojson.properties || {}), fly };
        await window.kasugaiApi.saveDataFile(entry.drawn.name, JSON.stringify(geojson));
      }
    } catch (e) { /* 永続化失敗は無視（メモリ上の設定は有効） */ }
  };
  // applyInspector でリセットされたルートをタイトル一致で復帰する。
  // 位置と再生状態も戻す（設定変更で飛行が中断しないようにするため）
  uiHooks.resumeFlyPathByTitle = async (title, distance, wasActive) => {
    if (!walkModeActive || flyPath) return false;
    const index = flyPaths.findIndex(path => path.title === title);
    if (index < 0) return false;
    const select = document.querySelector("#fly-path-select");
    if (select) {
      renderFlyPathSelect();
      select.value = String(index);
    }
    updateFlyPathDeleteButton();
    if (walkRafId !== null) {
      cancelAnimationFrame(walkRafId);
      walkRafId = null;
    }
    await startFlyPath(index);
    if (!flyPathCoords || !flyPathCoords.length) {
      // 読み込み失敗時は flyPath が選択済みのまま残るため、再試行・フォールバックが通るよう戻す
      flyPath = null;
      return false;
    }
    const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
    flyPathDistance = Math.max(0, Math.min(distance || 0, total));
    updateFlyPathCamera(flyPathDistance);
    updateFlyPathVisibilityButton();
    if (wasActive) startFlyPathLoopIfNeeded();
    return true;
  };
  // ルート復帰に失敗した場合、手動ウォークとして入力を受け付けられる状態に戻す
  uiHooks.resumeManualWalk = () => {
    if (!walkModeActive || flyPath || walkRafId !== null) return;
    walkLastTime = performance.now();
    walkRafId = requestAnimationFrame(walkLoop);
  };

  modeSelect.addEventListener("click", () => {
    drawTabActive = false;
    stopDrawMode();
    setMode(modeSelect.value === "orbit" ? "walk" : "orbit");
  });
  const flyPathVisibilityBtn = document.querySelector("#fly-path-visibility");
  function updateFlyPathVisibilityButton() {
    if (!flyPathVisibilityBtn) return;
    const select = document.querySelector("#fly-path-select");
    if (!select || select.value === "__manual__" || !flyPathEntity) {
      flyPathVisibilityBtn.disabled = true;
      flyPathVisibilityBtn.textContent = t("fly.hide");
      return;
    }
    flyPathVisibilityBtn.disabled = false;
    flyPathVisibilityBtn.textContent = flyPathEntity.show ? t("fly.show") : t("fly.hide");
  }
  flyPathVisibilityBtn?.addEventListener("click", () => {
    if (flyPathEntity) {
      flyPathEntity.show = !flyPathEntity.show;
      updateFlyPathVisibilityButton();
    }
  });

  document.querySelector("#fly-path-select")?.addEventListener("change", () => {
    updateFlyPathDeleteButton();
    if (!walkModeActive) return;
    stopFlyPath();
    if (walkRafId) {
      cancelAnimationFrame(walkRafId);
      walkRafId = null;
    }
    const select = document.querySelector("#fly-path-select");
    const pathValue = select?.value || "__manual__";
    if (pathValue !== "__manual__") {
      const index = Number(pathValue);
      if (Number.isFinite(index) && index >= 0 && index < flyPaths.length) void startFlyPath(index);
    } else {
      walkLastTime = performance.now();
      walkRafId = requestAnimationFrame(walkLoop);
    }
    updateFlyPathVisibilityButton();
  });

  document.querySelector("#fly-path-delete")?.addEventListener("click", async () => {
    const select = document.querySelector("#fly-path-select");
    const index = Number(select?.value);
    const path = Number.isInteger(index) && index >= 0 && index < flyPaths.length ? flyPaths[index] : null;
    if (!path?.drawn) return;
    if (!window.confirm(t("fly.confirmDelete", { name: path.title }))) return;
    if (flyPath === path) stopFlyPath();
    if (path.drawn.kind === "idb") {
      await routeStore.remove(currentProjectId || "default", path.drawn.name);
    } else if (path.drawn.kind === "file") {
      const dir = await getDataDirHandle();
      if (!dir) return;
      await dir.removeEntry(path.drawn.name);
    }
    flyPaths.splice(index, 1);
    renderFlyPathSelect();
  });

  // .geojson ファイルを直接選んで IndexedDB へ取り込む
  const importFileInput = document.querySelector("#fly-path-import-file");
  document.querySelector("#fly-path-import")?.addEventListener("click", () => {
    importFileInput?.click();
  });
  importFileInput?.addEventListener("change", async () => {
    const files = [...(importFileInput.files || [])];
    if (!files.length) return;
    const projectId = currentProjectId || "default";
    const existingNames = new Set(await routeStore.names(projectId));
    let lastName = null;
    for (const file of files) {
      const name = file.name.replace(/\.geojson$/i, "");
      if (existingNames.has(name) && !window.confirm(t("fly.confirmOverwrite", { name }))) continue;
      await routeStore.set(projectId, name, await file.text());
      existingNames.add(name);
      lastName = name;
    }
    importFileInput.value = "";
    await ensureDrawnRouteFlyPath();
    if (lastName) {
      const select = document.querySelector("#fly-path-select");
      const idx = flyPaths.findIndex(p => p.title === lastName);
      if (select && idx >= 0) { select.value = String(idx); select.dispatchEvent(new Event("change")); }
    }
  });

  // 選択中の描画ルートを .geojson ファイルとしてダウンロード
  document.querySelector("#fly-path-download")?.addEventListener("click", async () => {
    const select = document.querySelector("#fly-path-select");
    const index = Number(select?.value);
    const path = Number.isInteger(index) && index >= 0 && index < flyPaths.length ? flyPaths[index] : null;
    if (!path?.drawn) return;
    const text = await (await fetch(path.url)).text();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
    a.download = `${path.title}.geojson`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const drawModeToggle = document.querySelector("#draw-mode-toggle");
  function updateDrawModeButton() { if (drawModeToggle) drawModeToggle.classList.toggle("active", drawModeActive); }
  function getDrawAgl() {
    const el = document.querySelector("#draw-agl");
    const value = el ? Number(el.value) : NaN;
    return Number.isFinite(value) ? value : 0;
  }
  function addDrawPoint(screenPosition) {
    if (!drawModeActive) return;
    const ray = viewer.camera.getPickRay(screenPosition);
    if (!ray) return;
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const drawAgl = getDrawAgl();
    const point = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height + drawAgl);
    if (drawnPoints.length > 0) {
      const last = drawnPoints[drawnPoints.length - 1];
      const dx = point.x - last.x;
      const dy = point.y - last.y;
      const dz = point.z - last.z;
      if (dx * dx + dy * dy + dz * dz < 25) return;
    }
    drawnPoints.push(point);
    drawnPointHeights.push(drawAgl);
    flashDrawPoint(point);
    if (!drawLineEntity) {
      drawLineEntity = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => drawnPoints, false),
          width: 4,
          material: new Cesium.PolylineGlowMaterialProperty({ color: Cesium.Color.CYAN, glowPower: 0.15 }),
        },
      });
    }
  }
  function flashDrawPoint(position) {
    const marker = viewer.entities.add({
      position,
      point: { pixelSize: 14, color: Cesium.Color.CYAN.withAlpha(0.9), outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
    });
    setTimeout(() => { viewer.entities.remove(marker); requestRender(); }, 400);
  }
  function updateDrawCursor() {
    viewer.canvas.style.cursor = drawModeActive ? "crosshair" : "";
  }
  function stopDrawMode() {
    drawModeActive = false;
    isDrawing = false;
    lastRightDownTime = 0;
    clearDrawnLine();
    updateDrawModeButton();
    updateDrawCursor();
    if (viewer.scene.screenSpaceCameraController) {
      ssec.zoomEventTypes = !walkModeActive || drawTabActive
        ? defaultZoomEventTypes
        : walkZoomWithoutWheel;
    }
  }
  function clearDrawnLine() {
    if (drawLineEntity) {
      viewer.entities.remove(drawLineEntity);
      drawLineEntity = null;
    }
    drawnPoints = [];
    drawnPointHeights = [];
  }
  function buildDrawnGeoJson() {
    if (drawnPoints.length < 2) return null;
    const coordinates = drawnPoints.map((p, i) => {
      const c = Cesium.Cartographic.fromCartesian(p);
      const lng = Number((c.longitude * 180 / Math.PI).toFixed(6));
      const lat = Number((c.latitude * 180 / Math.PI).toFixed(6));
      const agl = Number.isFinite(drawnPointHeights[i]) ? drawnPointHeights[i] : getDrawAgl();
      return [lng, lat, agl];
    });
    const baseHeight = Number.isFinite(drawnPointHeights[0]) ? drawnPointHeights[0] : getDrawAgl();
    return {
      type: "Feature",
      properties: { heightReference: "Terrain", heightOffset: baseHeight },
      geometry: { type: "LineString", coordinates },
    };
  }
  function drawnRouteFileName() {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `drawn_route_${timestamp}.geojson`;
  }

  async function saveDrawnRoute(name, text) {
    await routeStore.set(currentProjectId || "default", name, text);
  }

  async function cacheDrawnLine() {
    const geojson = buildDrawnGeoJson();
    if (!geojson) return;
    try {
      const name = drawnRouteFileName().replace(/\.geojson$/, "");
      const text = JSON.stringify(geojson, null, 2);
      await saveDrawnRoute(name, text);
      await ensureDrawnRouteFlyPath();
    } catch {}
  }

  function getCanvasPosition(event) {
    const rect = viewer.canvas.getBoundingClientRect();
    return new Cesium.Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
  }
  const RIGHT_DOUBLE_MS = 400;
  let suppressContextMenu = false;
  function onDrawPointerDown(event) {
    if (!drawModeActive || event.button !== 2) return;
    event.preventDefault();
    const now = performance.now();
    const isDouble = now - lastRightDownTime < RIGHT_DOUBLE_MS;
    if (isDouble) {
      lastRightDownTime = 0;
      suppressContextMenu = true;
      if (drawnPoints.length >= 2) {
        void cacheDrawnLine();
        stopDrawMode();
      }
      return;
    }
    lastRightDownTime = now;
    addDrawPoint(getCanvasPosition(event));
  }
  function onDrawContextMenu(event) {
    if (!drawModeActive && !suppressContextMenu) return;
    event.preventDefault();
    suppressContextMenu = false;
  }

  viewer.canvas.addEventListener("pointerdown", onDrawPointerDown, { passive: false });
  viewer.canvas.addEventListener("contextmenu", onDrawContextMenu, { passive: false });

  if (drawModeToggle) {
    drawModeToggle.addEventListener("click", () => {
      if (drawModeActive) {
        stopDrawMode();
      } else {
        if (walkModeActive || flyPathActive) setMode("orbit");
        clearDrawnLine();
        drawModeActive = true;
        updateDrawModeButton();
        updateDrawCursor();
        if (viewer.scene.screenSpaceCameraController) {
          const ssec = viewer.scene.screenSpaceCameraController;
          ssec.enableZoom = true;
          const rightDrag = Cesium.CameraEventType.RIGHT_DRAG;
          ssec.zoomEventTypes = defaultZoomEventTypes.filter(t => t !== rightDrag && t?.eventType !== rightDrag);
        }
      }
    });
  }

  const lastKeyTap = { KeyW: 0, KeyS: 0 };
  function startFlyPathLoopIfNeeded() {
    if (flyPathRafId === null && flyPathCoords && flyPathCoords.length) {
      flyPathActive = true;
      flyPathLastTime = performance.now();
      flyPathRafId = requestAnimationFrame(flyPathLoop);
    }
  }

  window.addEventListener("keydown", event => {
    if (!walkModeActive) return;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target?.tagName)) return;
    const code = event.code;
    if (["KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyE", "Equal", "Minus", "NumpadAdd", "NumpadSubtract", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(code)) {
      event.preventDefault();
      if (code === "Escape") {
        setMode("orbit");
        return;
      }
      if (code === "KeyW" || code === "KeyS") {
        if (flyPath && flyPathCoords) {
          const direction = code === "KeyW" ? 1 : -1;
          const total = flyPathCumulativeDistances[flyPathCumulativeDistances.length - 1] || 0;
          flyPathTargetDistance = direction > 0 ? total : 0;
          startFlyPathLoopIfNeeded();
        } else if (!flyPathActive) {
          const now = performance.now();
          const direction = code === "KeyW" ? 1 : -1;
          if (!event.repeat && now - lastKeyTap[code] < 300) {
            autoMove = autoMove === direction ? 0 : direction;
          }
          if (!event.repeat) lastKeyTap[code] = now;
        }
      }
      walkKeys.add(code);
      if (!flyPathActive && flyPath && flyPathCoords && ["KeyQ", "KeyE", "Equal", "Minus", "NumpadAdd", "NumpadSubtract", "ArrowUp", "ArrowDown"].includes(code)) {
        applyWalkKeys(0.05);
        updateFlyPathCamera(flyPathDistance);
      }
    }
  });

  window.addEventListener("keyup", event => {
    walkKeys.delete(event.code);
  });

  document.querySelector("#layer-panel-toggle").addEventListener("click", event => {
    const panel = document.querySelector(".control-panel");
    const collapsed = panel.classList.toggle("collapsed");
    event.currentTarget.textContent = collapsed ? "+" : "−";
    event.currentTarget.setAttribute("aria-label", collapsed ? t("common.expand") : t("common.minimize"));
  });

  document.querySelector("#basemap-toggle").addEventListener("click", event => {
    const control = document.querySelector(".basemap-control");
    const collapsed = control.classList.toggle("collapsed");
    event.currentTarget.textContent = collapsed ? "+" : "−";
    event.currentTarget.setAttribute("aria-label", collapsed ? t("common.expand") : t("common.minimize"));
  });

  document.querySelector("#navigation-toggle").addEventListener("click", event => {
    const toolbar = document.querySelector(".navigation-toolbar");
    const collapsed = toolbar.classList.toggle("collapsed");
    event.currentTarget.textContent = collapsed ? "+" : "−";
    event.currentTarget.setAttribute("aria-label", collapsed ? t("common.expand") : t("common.minimize"));
  });

  [".control-panel", ".basemap-control", ".navigation-toolbar", ".chat-panel"].forEach(selector => {
    const panel = document.querySelector(selector);
    if (!panel) return;
    ["click", "mousedown", "dblclick", "touchstart", "touchmove", "wheel"].forEach(type => {
      panel.addEventListener(type, event => event.stopPropagation());
    });
  });

  document.querySelector("#apply-inspector").addEventListener("click", async () => {
    try {
      setInspectorStatus(t("inspector.status.saving"));
      await saveInspectorConfig();
      applyInspector(document.querySelector("#inspector-input").value);
      setInspectorStatus(t("inspector.status.saved"));
    } catch (error) {
      setInspectorStatus(t("inspector.status.saveFailed", { error: error instanceof Error ? error.message : error }), true);
    }
  });

  document.querySelector("#theme-select")?.addEventListener("change", event => {
    const theme = inspectorThemes.find(entry => entry.name === event.target.value);
    if (theme) applyKascTheme(theme);
  });

  document.querySelector("#export-inspector")?.addEventListener("click", () => {
    // 認証モードでは /api/data/...?token= に書き換えられたURLが入っているため、
    // エクスポート前に gs:// / r2:// 形式へ戻す(セッショントークンの持ち出し防止)
    const auth = window.kasugaiAuth;
    const rawText = document.querySelector("#inspector-input").value;
    const text = auth && auth.restoreKasc ? auth.restoreKasc(rawText) : rawText;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentProjectId || "kasugai_canvas"}.kasc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setInspectorStatus(t("inspector.status.exported"));
  });

  // File System Access API: DATAフォルダへの直接保存(Chromium系のみ)。
  // フォルダハンドルは IndexedDB に保持し、次回以降は権限確認のみで再利用する
  // File System Access API: DATAフォルダへの直接保存(Chromium系のみ)。
  // フォルダハンドルは IndexedDB に保持し、次回以降は権限確認のみで再利用する
  const dataDirStore = {
    open() {
      return openAppDb();
    },
    async get(key) {
      try {
        const db = await this.open();
        return await new Promise(resolve => {
          const query = db.transaction("handles", "readonly").objectStore("handles").get(key);
          query.onsuccess = () => resolve(query.result || null);
          query.onerror = () => resolve(null);
        });
      } catch (e) { return null; }
    },
    async set(key, value) {
      try {
        const db = await this.open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("handles", "readwrite");
          tx.objectStore("handles").put(value, key);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {}
    },
  };

  // 描画ルート（GeoJSONテキスト）を IndexedDB に保存。キーは "<projectId>/<name>"
  const routeStore = {
    async names(projectId) {
      try {
        const db = await dataDirStore.open();
        return await new Promise(resolve => {
          const query = db.transaction("routes", "readonly").objectStore("routes").getAllKeys();
          query.onsuccess = () => {
            const prefix = `${projectId}/`;
            resolve((query.result || []).map(String).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)));
          };
          query.onerror = () => resolve([]);
        });
      } catch (e) { return []; }
    },
    async get(projectId, name) {
      try {
        const db = await dataDirStore.open();
        return await new Promise(resolve => {
          const query = db.transaction("routes", "readonly").objectStore("routes").get(`${projectId}/${name}`);
          query.onsuccess = () => resolve(query.result ?? null);
          query.onerror = () => resolve(null);
        });
      } catch (e) { return null; }
    },
    async set(projectId, name, text) {
      try {
        const db = await dataDirStore.open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("routes", "readwrite");
          tx.objectStore("routes").put(text, `${projectId}/${name}`);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {}
    },
    async remove(projectId, name) {
      try {
        const db = await dataDirStore.open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("routes", "readwrite");
          tx.objectStore("routes").delete(`${projectId}/${name}`);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {}
    },
  };

  let dataDirHandle = null;
  const dataDirKey = () => `dataDir_${currentProjectId || "default"}`;
  const dataDirName = document.querySelector("#inspector-data-dir-name");

  async function updateDataDirLabel() {
    if (!dataDirName) return;
    if (!window.showDirectoryPicker) {
      dataDirName.textContent = t("inspector.dataDir.unsupported");
      return;
    }
    if (dataDirHandle) { dataDirName.textContent = dataDirHandle.name; return; }
    const saved = await dataDirStore.get(dataDirKey());
    dataDirName.textContent = saved ? t("inspector.dataDir.needsPermission", { name: saved.name }) : t("inspector.dataDir.unset");
  }

  async function pickDataDir() {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    dataDirHandle = handle;
    await dataDirStore.set(dataDirKey(), handle);
    await updateDataDirLabel();
    return handle;
  }

  async function getDataDirHandle() {
    if (!window.showDirectoryPicker) return null;
    if (dataDirHandle) {
      if (await dataDirHandle.queryPermission({ mode: "readwrite" }) === "granted") return dataDirHandle;
      if (await dataDirHandle.requestPermission({ mode: "readwrite" }) === "granted") return dataDirHandle;
    }
    const saved = await dataDirStore.get(dataDirKey());
    if (saved) {
      if (await saved.queryPermission({ mode: "readwrite" }) === "granted") { dataDirHandle = saved; return saved; }
      if (await saved.requestPermission({ mode: "readwrite" }) === "granted") { dataDirHandle = saved; return saved; }
    }
    return pickDataDir();
  }

  // 権限確認・ピッカーを出さず、許可済みのフォルダがある時だけ返す
  async function getGrantedDataDirHandle() {
    if (!window.showDirectoryPicker) return null;
    const handle = dataDirHandle || await dataDirStore.get(dataDirKey());
    if (handle && await handle.queryPermission({ mode: "readwrite" }) === "granted") {
      dataDirHandle = handle;
      return handle;
    }
    return null;
  }

  // DATA/ への保存: ローカルサーバー版は /api/files（ブラウザ非依存）、
  // それ以外は「フォルダを選択」で選んだ FSA フォルダへ書き込む
  async function saveToDataDir(name, content) {
    if (hasBackendFeature("fileWrite")) {
      const project = currentProjectId || "default";
      const rel = String(name).split("/").filter(Boolean).map(encodeURIComponent).join("/");
      const response = await fetch(`/api/files/${encodeURIComponent(project)}/${rel}`, { method: "PUT", body: content });
      if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
      return "server";
    }
    const dir = await getDataDirHandle();
    if (!dir) throw new Error(t("inspector.addFileNoDir"));
    const fileName = String(name).split("/").filter(Boolean).pop();
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return "fsa";
  }

  // 並行呼び出し（init・Drawタブ・addFlyPath 等）が既存チェックのスナップショットで
  // 重複登録するのを防ぐため、処理は直列化する
  let drawnRouteEnsureQueue = Promise.resolve();
  function _ensureDrawnRouteFlyPath() {
    const run = drawnRouteEnsureQueue.then(() => ensureDrawnRouteFlyPathInner());
    drawnRouteEnsureQueue = run.catch(() => {});
    return run;
  }

  async function ensureDrawnRouteFlyPathInner() {
    const projectId = currentProjectId || "default";
    const existing = new Set(flyPaths.map(p => p.title));
    // IndexedDB の描画ルート（ピッカー・権限不要）
    for (const name of await routeStore.names(projectId)) {
      if (existing.has(name)) continue;
      const text = await routeStore.get(projectId, name);
      if (text == null) continue;
      const objectUrl = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
      const path = { title: name, url: objectUrl, speed: 30, height: 0, pitch: -10, loop: false, step: 100, view: "camera", drawn: { kind: "idb", name } };
      applyFlySettingsFromGeoJson(text, path);
      flyPaths.push(path);
      existing.add(name);
    }
    // 保存先フォルダ内の .geojson（許可済みの場合のみ・読み取り専用）
    const dir = await getGrantedDataDirHandle();
    if (dir) {
      try {
        for await (const entry of dir.values()) {
          if (entry.kind !== "file" || !entry.name.endsWith(".geojson")) continue;
          const title = entry.name.replace(/\.geojson$/, "");
          if (existing.has(title)) continue;
          const fileHandle = await dir.getFileHandle(entry.name);
          const file = await fileHandle.getFile();
          const text = await file.text();
          const objectUrl = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
          const path = { title, url: objectUrl, speed: 30, height: 0, pitch: -10, loop: false, step: 100, view: "camera", drawn: { kind: "file", name: entry.name } };
          applyFlySettingsFromGeoJson(text, path);
          flyPaths.push(path);
          existing.add(title);
        }
      } catch (e) { console.error("ensureDrawnRouteFlyPath failed:", e); }
    }
    // ローカルサーバー版: projects/<id>/DATA/ を /api/files で列挙して .geojson をルート化
    if (hasBackendFeature("fileWrite")) {
      try {
        const entries = await window.kasugaiApi.listDataFiles();
        for (const entry of entries) {
          if (!entry.name?.endsWith(".geojson")) continue;
          const title = entry.name.replace(/\.geojson$/, "");
          if (existing.has(title)) continue;
          const url = `${projectsBaseUrl(projectId)}DATA/${entry.name.split("/").map(encodeURIComponent).join("/")}`;
          const path = { title, url, speed: 30, height: 0, pitch: -10, loop: false, step: 100, view: "camera", drawn: { kind: "server", name: entry.name } };
          try { applyFlySettingsFromGeoJson(await (await fetch(url)).text(), path); } catch (e) { /* 既定値のまま */ }
          flyPaths.push(path);
          existing.add(title);
        }
      } catch (e) { console.error("listDataFiles failed:", e); }
    }
    renderFlyPathSelect();
  }
  window._ensureDrawnRouteFlyPath = _ensureDrawnRouteFlyPath;
  window._routeStoreGet = (projectId, name) => routeStore.get(projectId, name);
  window._routeStoreSet = (projectId, name, text) => routeStore.set(projectId, name, text);

  document.querySelector("#inspector-data-dir")?.addEventListener("click", async () => {
    if (!window.showDirectoryPicker) {
      setInspectorStatus(t("inspector.status.fsUnsupported"), true);
      return;
    }
    try {
      await pickDataDir();
      await ensureDrawnRouteFlyPath();
      setInspectorStatus(t("inspector.status.dirSet"));
    } catch (error) {
      if (error && error.name === "AbortError") return;
      setInspectorStatus(t("inspector.status.dirFailed", { error: error instanceof Error ? error.message : error }), true);
    }
  });
  void updateDataDirLabel();

  // ファイルを DATA/ へ保存し、拡張子に応じた .kasc 行を設定へ追記して即時適用する
  const addFileInput = document.querySelector("#inspector-add-file");
  document.querySelector("#inspector-add-file-button")?.addEventListener("click", () => addFileInput?.click());
  addFileInput?.addEventListener("change", async () => {
    const files = [...(addFileInput.files || [])];
    addFileInput.value = "";
    for (const file of files) {
      try {
        await saveToDataDir(file.name, file);
        const ext = file.name.toLowerCase().split(".").pop() || "";
        const type = { geojson: "geojson", json: "geojson", gpkg: "gpkg", geopackage: "gpkg", fgb: "flatgeobuf", parquet: "geoparquet" }[ext];
        if (type) {
          const title = file.name.replace(/\.[^.]+$/, "");
          window.kasugaiApi.addLayer(title, `DATA/${file.name}`, { type });
          setInspectorStatus(t("inspector.addFileSaved", { name: file.name }));
        } else {
          setInspectorStatus(t("inspector.addFileSavedOnly", { name: file.name }));
        }
        void ensureDrawnRouteFlyPath();
      } catch (error) {
        if (error && error.name === "AbortError") continue;
        setInspectorStatus(t("inspector.addFileFailed", { error: error instanceof Error ? error.message : error }), true);
      }
    }
  });



  document.querySelector("#project-select")?.addEventListener("change", async event => {
    currentProjectId = event.target.value;
    // 実プロジェクトの選択は ?kasc= 直読みモードを抜ける
    currentKascUrl = null;
    const params = new URLSearchParams(window.location.search);
    if (currentProjectId) params.set("project", currentProjectId);
    else params.delete("project");
    params.delete("kasc");
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
    updateProjectRootPath();
    // scope:"project" のプラグインレイヤーはプロジェクト単位のデータとして切り離す
    pluginLayers.filter(item => item.scope === "project").forEach(removePluginLayer);
    // plugin: 行で起動したプラグインはレイヤーが除去されるため、新 .kasc 適用後に
    // plugin-loader 側で再起動できるよう切替を通知する
    window.kasugaiApi?.emit("project-changed", { projectId: currentProjectId });
    try {
      setInspectorStatus(t("inspector.status.loadingProject"));
      await loadInspectorConfig();
    } catch (error) {
      setInspectorStatus(t("inspector.status.loadProjectFailed", { error: error instanceof Error ? error.message : error }), true);
    }
  });

  const shareCopyBtn = document.querySelector("#share-copy");
  shareCopyBtn.addEventListener("click", async () => {
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    const lon = Number(c.longitude * 180 / Math.PI).toFixed(6);
    const lat = Number(c.latitude * 180 / Math.PI).toFixed(6);
    const pitch = Number(viewer.camera.pitch * 180 / Math.PI).toFixed(2);
    const heading = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
    const height = Number(c.height).toFixed(1);
    const url = `${window.location.origin}${window.location.pathname}?longitude=${lon}&latitude=${lat}&height=${height}&pitch=${pitch}&heading=${heading}&${projectQueryParam()}`;
    await navigator.clipboard?.writeText(url);
    shareCopyBtn.textContent = "✓";
    setTimeout(() => { shareCopyBtn.textContent = "🔗"; }, 1500);
  });

  document.querySelector("#shutdown-app").addEventListener("click", async () => {
    if (!backendEnabled) return;
    if (!confirm(t("app.confirmShutdown"))) return;
    await fetch("/api/shutdown", { method: "POST" });
  });

  document.querySelector("#check-update").addEventListener("click", () => {
    void checkForUpdate();
  });

  document.querySelector("#install-update").addEventListener("click", () => {
    void installUpdate();
  });

  document.querySelector("#auto-update").addEventListener("change", () => {
    void saveUpdateSettings().catch(error => {
      document.querySelector("#version-status").textContent = t("update.autoSaveError", { error: error.message });
    });
  });

  document.querySelector("#fetch-allow-save")?.addEventListener("click", () => {
    void saveFetchSettings().catch(error => {
      document.querySelector("#fetch-allow-status").textContent = t("update.autoSaveError", { error: error.message });
    });
  });

  const languageSelect = document.querySelector("#language-select");
  if (languageSelect) {
    languageSelect.replaceChildren(...SUPPORTED_LANGUAGES.map(code => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = LANGUAGE_NAMES[code] || code;
      return option;
    }));
    languageSelect.value = getLanguage();
    languageSelect.addEventListener("change", () => { void setLanguage(languageSelect.value); });
  }
  window.addEventListener("kasugai:language-changed", () => {
    renderBasemapSelector();
    renderLayerList();
    renderFlyPathSelect();
    updateVectorSearchUI();
    void loadProjects();
    updateFlyPathVisibilityButton();
    void updateDataDirLabel();
    const modeSelect = document.querySelector("#mode-select");
    if (modeSelect) {
      const isWalk = modeSelect.value === "walk";
      modeSelect.textContent = isWalk ? t("nav.fly") : t("nav.orbitMode");
      modeSelect.setAttribute("aria-label", isWalk ? t("nav.flyMode") : t("nav.orbit"));
    }
  });

  document.querySelectorAll(".panel-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".panel-tab").forEach(item => item.classList.toggle("active", item === tab));
      document.querySelectorAll(".plugin-panel").forEach(panel => panel.classList.toggle("active", panel.id === tab.dataset.panel));
    });
  });

  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const scope = tab.closest(".plugin-panel") || document;
      scope.querySelectorAll(".settings-tab").forEach(item => item.classList.toggle("active", item === tab));
      scope.querySelectorAll(".settings-subpanel").forEach(panel => panel.classList.toggle("active", panel.id === tab.dataset.settingsPanel));
      if (["settings-cloud-panel", "settings-rclone-panel", "settings-drive-panel", "settings-save-panel"].includes(tab.dataset.settingsPanel)) void refreshCloudStatus();
      if (tab.dataset.settingsPanel === "settings-save-panel") void refreshSaveStatus();
    });
  });

  // ---- 管理ウィンドウ（⚙ボタンで開くモードレス・フローティングパネル） ----
  const manageWindow = document.querySelector("#manage-window");
  const manageOpenBtn = document.querySelector("#manage-open");
  if (manageWindow && manageOpenBtn) {
    const setManageOpen = (open) => {
      manageWindow.hidden = !open;
      manageOpenBtn.classList.toggle("active", open);
      if (open) void refreshCloudStatus();
    };
    manageOpenBtn.addEventListener("click", () => setManageOpen(manageWindow.hidden));
    manageWindow.querySelector("#manage-close")?.addEventListener("click", () => setManageOpen(false));
    manageWindow.querySelector("#manage-minimize")?.addEventListener("click", () => manageWindow.classList.toggle("minimized"));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !manageWindow.hidden) setManageOpen(false);
    });
    manageWindow.querySelectorAll(".manage-nav button").forEach((btn) => {
      btn.addEventListener("click", () => {
        manageWindow.querySelectorAll(".manage-nav button").forEach((item) => item.classList.toggle("active", item === btn));
        manageWindow.querySelectorAll(".manage-pane").forEach((pane) => pane.classList.toggle("active", pane.id === btn.dataset.managePane));
        if (btn.dataset.managePane === "manage-app") {
          void refreshCloudStatus();
          void refreshSaveStatus();
        }
      });
    });
    manageWindow.querySelectorAll(".manage-subnav button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pane = btn.closest(".manage-pane");
        pane.querySelectorAll(".manage-subnav button").forEach((item) => item.classList.toggle("active", item === btn));
        pane.querySelectorAll(".settings-subpanel").forEach((panel) => panel.classList.toggle("active", panel.id === btn.dataset.manageSub));
        if (["settings-cloud-panel", "settings-rclone-panel", "settings-drive-panel", "settings-save-panel"].includes(btn.dataset.manageSub)) void refreshCloudStatus();
        if (btn.dataset.manageSub === "settings-save-panel") void refreshSaveStatus();
      });
    });
    const manageTitlebar = manageWindow.querySelector(".manage-titlebar");
    manageTitlebar?.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      event.preventDefault();
      const parent = manageWindow.offsetParent || document.body;
      const parentRect = parent.getBoundingClientRect();
      const rect = manageWindow.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const onMove = (moveEvent) => {
        const maxX = Math.max(0, parentRect.width - rect.width);
        const maxY = Math.max(0, parentRect.height - rect.height);
        const nextX = Math.max(0, Math.min(moveEvent.clientX - parentRect.left - offsetX, maxX));
        const nextY = Math.max(0, Math.min(moveEvent.clientY - parentRect.top - offsetY, maxY));
        manageWindow.style.left = `${nextX}px`;
        manageWindow.style.top = `${nextY}px`;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  // ---- クラウドストレージ設定タブ (rclone 連携) ----
  const cloudEls = {
    panel: document.querySelector("#settings-cloud-panel"),
    unavailable: document.querySelector("#cloud-unavailable"),
    controls: document.querySelector("#cloud-controls"),
    rcloneStatus: document.querySelector("#cloud-rclone-status"),
    installDir: document.querySelector("#cloud-install-dir"),
    recheck: document.querySelector("#cloud-rclone-recheck"),
    install: document.querySelector("#cloud-rclone-install"),
    remote: document.querySelector("#cloud-remote"),
    remoteRefresh: document.querySelector("#cloud-remote-refresh"),
    remoteType: document.querySelector("#cloud-remote-type"),
    remoteAdd: document.querySelector("#cloud-remote-add"),
    root: document.querySelector("#cloud-root"),
    permRead: document.querySelector("#cloud-perm-read"),
    permWrite: document.querySelector("#cloud-perm-write"),
    connect: document.querySelector("#cloud-connect"),
    stop: document.querySelector("#cloud-stop"),
    serveStatus: document.querySelector("#cloud-serve-status"),
    drive: document.querySelector("#cloud-drive"),
    mount: document.querySelector("#cloud-mount"),
    unmount: document.querySelector("#cloud-unmount"),
    inspectorLine: document.querySelector("#cloud-inspector-line"),
    saveKasc: document.querySelector("#cloud-save-kasc"),
    localize: document.querySelector("#cloud-localize"),
    localizeScope: document.querySelector("#cloud-localize-scope"),
    status: document.querySelector("#cloud-status"),
    // rclone タブ(別システム管理: 導入・リモート登録)側の要素
    rcloneUnavailable: document.querySelector("#rclone-unavailable"),
    rcloneControls: document.querySelector("#rclone-controls"),
    rcloneStatusLine: document.querySelector("#rclone-status"),
    // ドライブタブ(Windows net use)側の要素
    driveUnavailable: document.querySelector("#drive-unavailable"),
    driveControls: document.querySelector("#drive-controls"),
    driveStatusLine: document.querySelector("#drive-status"),
  };
  const cloudStorage = {
    get: key => localStorage.getItem(`kasugai.cloud.${key}`) || "",
    set: (key, value) => localStorage.setItem(`kasugai.cloud.${key}`, value || ""),
  };

  const setCloudStatus = (text, isError = false) => {
    if (!cloudEls.status) return;
    cloudEls.status.textContent = text;
    cloudEls.status.style.color = isError ? "#c0392b" : "";
  };
  // rclone タブ側のステータス行(導入・リモート追加の結果表示)
  const setRcloneStatus = (text, isError = false) => {
    if (!cloudEls.rcloneStatusLine) return;
    cloudEls.rcloneStatusLine.textContent = text;
    cloudEls.rcloneStatusLine.style.color = isError ? "#c0392b" : "";
  };
  // ドライブタブ側のステータス行(割当・解除の結果表示)
  const setDriveStatus = (text, isError = false) => {
    if (!cloudEls.driveStatusLine) return;
    cloudEls.driveStatusLine.textContent = text;
    cloudEls.driveStatusLine.style.color = isError ? "#c0392b" : "";
  };

  // ---- 保存タブ (ローカルサーバー版のみ: クラウド保存・納品パッケージ) ----
  const saveEls = {
    unavailable: document.querySelector("#save-unavailable"),
    controls: document.querySelector("#save-controls"),
    status: document.querySelector("#save-status"),
  };
  const setSaveStatus = (text, isError = false) => {
    if (!saveEls.status) return;
    saveEls.status.textContent = text;
    saveEls.status.style.color = isError ? "#c0392b" : "";
  };
  function refreshSaveStatus() {
    if (!saveEls.controls) return;
    const supported = hasBackendFeature("cloudRclone");
    if (saveEls.unavailable) saveEls.unavailable.hidden = supported;
    saveEls.controls.style.display = supported ? "" : "none";
  }

  const cloudApi = async (path, options = {}) => {
    const response = await fetch(`/api/cloud/${path}`, { cache: "no-store", ...options });
    const text = await response.text();
    if (!response.ok) throw new Error(text || response.statusText);
    try { return JSON.parse(text); } catch { return text; }
  };
  const cloudPost = (path, body) =>
    cloudApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });

  // クラウド連携の可否は capabilities 取得後( detectBackend 完了後 )にしか
  // 判定できないため、タブを開いたタイミングで都度評価する
  async function refreshCloudStatus() {
    if (!cloudEls.panel) return null;
    const supported = hasBackendFeature("cloudRclone");
    cloudEls.unavailable.hidden = supported;
    cloudEls.controls.style.display = supported ? "" : "none";
    if (cloudEls.rcloneUnavailable) cloudEls.rcloneUnavailable.hidden = supported;
    if (cloudEls.rcloneControls) cloudEls.rcloneControls.style.display = supported ? "" : "none";
    if (cloudEls.driveUnavailable) cloudEls.driveUnavailable.hidden = supported;
    if (cloudEls.driveControls) cloudEls.driveControls.style.display = supported ? "" : "none";
    if (!supported) return null;
    try {
      const status = await cloudApi("status");
      cloudEls.rcloneStatus.textContent = status.installed
        ? [status.version, status.path].filter(Boolean).join(" — ")
        : t("cloud.rclone.notInstalled");
      const previous = cloudEls.remote.value || cloudStorage.get("remote");
      cloudEls.remote.replaceChildren();
      (status.remotes || []).forEach(name => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        cloudEls.remote.append(option);
      });
      if (previous) cloudEls.remote.value = previous;
      const serving = status.serving;
      cloudEls.serveStatus.textContent = serving
        ? `${serving.remote}:${serving.root || (serving.folderId ? `#${serving.folderId}` : "")} (port ${serving.port}, ${serving.readOnly ? "RO" : "RW"}${serving.drive ? `, ${serving.drive}:` : ""})`
        : t("cloud.serve.none");
      if (serving?.drive) cloudEls.drive.value = serving.drive;
      return status;
    } catch (error) {
      cloudEls.rcloneStatus.textContent = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  if (cloudEls.panel && cloudEls.controls) {
    {
      for (let code = "E".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
        const letter = String.fromCharCode(code);
        const option = document.createElement("option");
        option.value = letter;
        option.textContent = `${letter}:`;
        cloudEls.drive.append(option);
      }
      cloudEls.root.value = cloudStorage.get("root");
      cloudEls.installDir.value = cloudStorage.get("installDir");
      if (cloudStorage.get("perm") === "write") cloudEls.permWrite.checked = true;
      cloudEls.drive.value = cloudStorage.get("drive") || "K";

      cloudEls.recheck.addEventListener("click", () => void refreshCloudStatus());
      cloudEls.remoteRefresh.addEventListener("click", () => void refreshCloudStatus());

      cloudEls.install.addEventListener("click", async () => {
        try {
          setRcloneStatus(t("cloud.status.installing"));
          const dir = cloudEls.installDir.value.trim();
          cloudStorage.set("installDir", dir);
          const result = await cloudPost("install", { dir: dir || undefined });
          setRcloneStatus(t("cloud.status.installed", { path: result.path }));
          await refreshCloudStatus();
        } catch (error) {
          setRcloneStatus(error.message, true);
        }
      });

      cloudEls.remoteAdd.addEventListener("click", async () => {
        // リモート名は種別名をそのまま使う(同名リモートは既存設定を選ぶだけにする)
        const name = cloudEls.remoteType.value;
        if ([...cloudEls.remote.options].some(option => option.value === name)) {
          cloudEls.remote.value = name;
          setRcloneStatus(t("cloud.status.remoteExists", { name }));
          return;
        }
        try {
          await cloudPost("config", { name, type: name });
          setRcloneStatus(t("cloud.status.authorizing"));
          // OAuth 認可の完了を remotes の増加で検出する(最大2分)
          for (let i = 0; i < 40; i++) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            const status = await refreshCloudStatus();
            if (status?.remotes?.includes(name)) {
              setRcloneStatus(t("cloud.status.remoteAdded", { name }));
              return;
            }
          }
          setRcloneStatus(t("cloud.status.authTimeout"), true);
        } catch (error) {
          setRcloneStatus(error.message, true);
        }
      });

      cloudEls.connect.addEventListener("click", async () => {
        const remote = cloudEls.remote.value;
        if (!remote) {
          setCloudStatus(t("cloud.status.noRemote"), true);
          return;
        }
        const readOnly = cloudEls.permRead.checked;
        const root = cloudEls.root.value.trim();
        const drive = cloudEls.drive.value;
        cloudStorage.set("remote", remote);
        cloudStorage.set("root", root);
        cloudStorage.set("perm", readOnly ? "read" : "write");
        cloudStorage.set("drive", drive);
        try {
          setCloudStatus(t("cloud.status.connecting"));
          await cloudPost("serve", { remote, root, readOnly, drive: drive || undefined });
          setCloudStatus(t("cloud.status.connected"));
          await refreshCloudStatus();
        } catch (error) {
          setCloudStatus(error.message, true);
        }
      });

      cloudEls.stop.addEventListener("click", async () => {
        try {
          await cloudPost("stop");
          setCloudStatus(t("cloud.status.stopped"));
          await refreshCloudStatus();
        } catch (error) {
          setCloudStatus(error.message, true);
        }
      });

      cloudEls.mount.addEventListener("click", async () => {
        const drive = cloudEls.drive.value;
        if (!drive) return;
        try {
          await cloudPost("drive", { action: "mount", drive });
          cloudStorage.set("drive", drive);
          setDriveStatus(t("cloud.status.mounted", { drive }));
          await refreshCloudStatus();
        } catch (error) {
          setDriveStatus(error.message, true);
        }
      });

      cloudEls.unmount.addEventListener("click", async () => {
        const drive = cloudEls.drive.value;
        if (!drive) return;
        try {
          await cloudPost("drive", { action: "unmount", drive });
          setDriveStatus(t("cloud.status.unmounted", { drive }));
          await refreshCloudStatus();
        } catch (error) {
          setDriveStatus(error.message, true);
        }
      });

      // 現在の入力値から cloud: 設定行を生成し、インスペクタへ追記(既存行は置換)して適用する。
      // .kasc に残れば次回起動・プロジェクト読み込み時に自動接続される
      cloudEls.inspectorLine?.addEventListener("click", () => {
        const remote = cloudEls.remote.value;
        if (!remote) {
          setSaveStatus(t("cloud.status.noRemote"), true);
          return;
        }
        const segments = [remote];
        const root = cloudEls.root.value.trim();
        if (root) segments.push(root);
        if (cloudEls.permWrite.checked) segments.push("perm=write");
        const drive = cloudEls.drive.value;
        if (drive) segments.push(`drive=${drive}`);
        const line = `cloud: ${segments.join(" | ")}`;
        const input = document.querySelector("#inspector-input");
        if (!input) return;
        const lines = input.value.split(/\r?\n/);
        const index = lines.findIndex(l => /^\s*cloud\s*:/i.test(l));
        if (index >= 0) lines[index] = line;
        else lines.push(line);
        input.value = lines.join("\n");
        setSaveStatus(t("cloud.status.lineAdded"));
        applyInspector(input.value);
      });

      cloudEls.saveKasc.addEventListener("click", async () => {
        // エクスポートと同じく ?token= を gs:// / r2:// に戻してから保存する
        const auth = window.kasugaiAuth;
        const rawText = document.querySelector("#inspector-input")?.value || "";
        const text = auth && auth.restoreKasc ? auth.restoreKasc(rawText) : rawText;
        const fileName = `${currentProjectId || "kasugai_canvas"}.kasc`;
        if (!window.confirm(t("cloud.saveKascConfirm", { name: fileName }))) return;
        try {
          await fetch(`/api/cloud/file?path=${encodeURIComponent(fileName)}`, {
            method: "PUT",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: text,
          }).then(async response => {
            if (!response.ok) throw new Error(await response.text() || response.statusText);
          });
          setSaveStatus(t("cloud.status.kascSaved", { name: fileName }));
        } catch (error) {
          setSaveStatus(error.message, true);
        }
      });

      cloudEls.localize.addEventListener("click", async () => {
        const scope = cloudEls.localizeScope.value;
        const path = scope === "project" ? "DATA/" : "../DATA/";
        if (!window.confirm(t("cloud.localizeConfirm", { path }))) return;
        cloudEls.localize.disabled = true;
        try {
          setSaveStatus(t("cloud.status.localizing"));
          const result = await cloudPost("localize", { project: currentProjectId || "default", scope });
          const parts = [
            result.cloudSynced ? t("cloud.status.localizedCloud") : t("cloud.status.localizedNoCloud"),
          ];
          if (result.downloaded || result.failed?.length || result.kascRewritten) {
            parts.push(t("cloud.status.localizedHttp", { count: result.downloaded ?? 0, path: result.dataReference || path.replace(/\/$/, "") }));
          } else {
            parts.push(t("cloud.status.localizedNothing"));
          }
          if (result.tilesets?.length) {
            const files = result.tilesets.reduce((sum, entry) => sum + (entry.files || 0), 0);
            parts.push(t("cloud.status.localizedTiles", { count: result.tilesets.length, files, path: result.dataReference || path.replace(/\/$/, "") }));
          }
          if (result.tilesetSkipped?.length) parts.push(t("cloud.status.localizedTilesSkipped", { count: result.tilesetSkipped.length }));
          if (result.xyzTiles?.length) parts.push(t("cloud.status.localizedXyz", { count: result.xyzTiles.length, path: result.dataReference || path.replace(/\/$/, "") }));
          if (result.failed?.length) parts.push(t("cloud.status.localizedFailed", { count: result.failed.length }));
          if (result.cloudRefsRemaining) parts.push(t("cloud.status.localizedCloudLeft", { count: result.cloudRefsRemaining }));
          if (result.outputPath) parts.push(t("cloud.status.localizedOut", { path: result.outputPath }));
          setSaveStatus(parts.join(" / "), !!result.failed?.length);
        } catch (error) {
          setSaveStatus(error.message, true);
        } finally {
          cloudEls.localize.disabled = false;
        }
      });
    }
  }

  viewer.camera.changed.addEventListener(() => {
    updateCameraInputs();
    window.kasugaiApi?.emit("camera-changed", window.kasugaiApi.getCamera());
  });


  // 実行時オブジェクト(Tileset/DataSource/Primitive)から対応するレイヤー定義を引く。
  // 属性パネルで「どのグループのどのレイヤーの地物か」を明示するために使う
  const findAttrLayerItem = target => {
    if (!target) return null;
    for (const [id, obj] of layerRuntimeTargets) {
      if (obj === target) return layerState.get(id) || null;
    }
    return null;
  };

  // 「選択中のレイヤ属性一覧」ボタン用にレイヤーIDを dataset に保持する
  const setAttrLayerContext = (attr, item) => {
    if (item) {
      attr.dataset.layerId = item.id;
      attr.dataset.layerTitle = item.title || item.id;
    } else {
      delete attr.dataset.layerId;
      delete attr.dataset.layerTitle;
    }
  };

  // 属性表示の先頭に出す「グループ / レイヤー名」のラベル
  const attrLayerPathText = item => (item?.title ? (item.group ? `${item.group} / ${item.title}` : item.title) : null);

  // 1件分のピック結果を {item,label,entries} に正規化する。
  // 属性を持たない描画物(地形・モデル等)は null を返す
  const describePicked = (picked, time) => {
    if (picked instanceof Cesium.Cesium3DTileFeature) {
      // Cesium 1.9x以降の構造化メタデータは getPropertyIds() で列挙する
      // (getPropertyNames は存在しない場合があり空テーブルになる)
      const names = picked.getPropertyIds ? picked.getPropertyIds()
        : picked.getPropertyNames ? picked.getPropertyNames() : [];
      return {
        item: findAttrLayerItem(picked.tileset || picked.primitive),
        entries: names.map(name => [name, picked.getProperty(name)]),
      };
    }
    if (Cesium.GeoJsonPrimitive && picked.parentPrimitive instanceof Cesium.GeoJsonPrimitive && picked.properties) {
      return {
        item: findAttrLayerItem(picked.parentPrimitive),
        entries: Object.entries(picked.properties),
      };
    }
    const entity = picked.id;
    if (entity?.properties) {
      const ds = entity.entityCollection && entity.entityCollection.owner;
      const match = ds ? vectorDataSources.find(item => item.ds === ds) : null;
      return {
        item: (match && layerState.get(match.id)) || findAttrLayerItem(ds),
        label: typeof entity.name === "string" && entity.name ? entity.name : null,
        entries: Object.entries(entity.properties.getValue(time) || {}),
        entity,
      };
    }
    return null;
  };

  // 同一地物の重複ピック除外用キー。entity は billboard+label 等の
  // 複数描画で重複ヒットしうるため entity で判定する。GeoJsonPrimitive は
  // Multi系ジオメトリのパーツが同一 properties 参照を共有するためそれで判定する。
  // 3D Tiles feature は drillPick の各パスで別インスタンスになりうるため
  // content+featureId の複合キーで判定する
  const tileContentSeq = new WeakMap();
  let tileContentSeqNext = 0;
  const pickedDedupKey = picked => {
    if (picked instanceof Cesium.Cesium3DTileFeature) {
      if (picked.featureId === undefined) return picked;
      const owner = picked.content || picked.tileset || picked.primitive || picked;
      let seq = tileContentSeq.get(owner);
      if (seq === undefined) { seq = tileContentSeqNext++; tileContentSeq.set(owner, seq); }
      return `tile:${seq}:${picked.featureId}`;
    }
    if (Cesium.GeoJsonPrimitive && picked?.parentPrimitive instanceof Cesium.GeoJsonPrimitive) return picked.properties || picked;
    return picked?.id || picked;
  };

  const buildAttrTable = entries => {
    const table = document.createElement("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.style.fontSize = "12px";
    entries.forEach(([key, value]) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = key;
      th.style.textAlign = "left";
      th.style.padding = "3px 6px";
      th.style.borderBottom = "1px solid #cbd9de";
      const td = document.createElement("td");
      td.textContent = value === undefined ? "" : String(value);
      td.style.padding = "3px 6px";
      td.style.borderBottom = "1px solid #cbd9de";
      tr.append(th, td);
      table.append(tr);
    });
    return table;
  };

  // drillPick の深度探索上限。重なりは通常数件だが、無制限だと
  // ピック毎に描画パスが増えるため上限を設ける
  const DRILL_PICK_LIMIT = 16;

  const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  clickHandler.setInputAction(movement => {
    // Street View 地点拾いモード: クリック位置の地表座標で Street View を開く
    if (streetViewPickMode) {
      streetViewPickMode = false;
      updateStreetViewPickButton();
      void updateStreetViewPickCoverage();
      const ray = viewer.camera.getPickRay(movement.position);
      const cartesian = ray
        ? ((() => { try { return viewer.scene.globe.pick(ray, viewer.scene); } catch (e) { return null; } })()
          || viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid))
        : null;
      if (cartesian) {
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        void openStreetViewAt(carto.latitude * 180 / Math.PI, carto.longitude * 180 / Math.PI);
      }
      return;
    }
    if (walkModeActive) return;
    // 重なった地物も拾えるよう drillPick で手前から順に全件取得する
    const pickedList = viewer.scene.drillPick(movement.position, DRILL_PICK_LIMIT) || [];
    const attr = document.querySelector("#attr-content");
    attr.replaceChildren();
    document.querySelectorAll(".panel-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.panel === "attr-panel"));
    document.querySelectorAll(".plugin-panel").forEach(panel => panel.classList.toggle("active", panel.id === "attr-panel"));

    if (!pickedList.length) {
      setAttrLayerContext(attr, null);
      attr.textContent = t("attr.empty");
      return;
    }

    const time = Cesium.JulianDate.now();
    const seen = new Set();
    const records = [];
    for (const picked of pickedList) {
      const key = pickedDedupKey(picked);
      if (seen.has(key)) continue;
      seen.add(key);
      const record = describePicked(picked, time);
      if (record) records.push(record);
    }

    if (!records.length) {
      setAttrLayerContext(attr, null);
      attr.textContent = t("attr.noAttrs");
      return;
    }

    // 「選択中のレイヤ属性一覧」は最前面の地物が属するレイヤーに紐付ける
    setAttrLayerContext(attr, records.map(record => record.item).find(Boolean) || null);

    const multiple = records.length > 1;
    if (multiple) {
      const count = document.createElement("div");
      count.className = "attr-picked-count";
      count.textContent = t("attr.pickedCount", { count: records.length });
      attr.append(count);
    }
    // 複数件時はヘッダーのみ表示し、行クリックで属性を開閉する。
    // 1件のみなら属性を最初から展開する
    records.forEach((record, index) => {
      const block = document.createElement("div");
      block.className = "attr-feature";
      let label = attrLayerPathText(record.item) || record.label || t("attr.otherFeature");
      if (multiple) label = `${index + 1}. ${label}`;
      const header = document.createElement("button");
      header.type = "button";
      header.className = "attr-layer-path attr-feature-toggle";
      const marker = document.createElement("span");
      marker.className = "attr-feature-marker";
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      header.append(marker, labelEl);
      const table = buildAttrTable(record.entries);
      // 属性行クリックでその地物へ飛ぶ(属性・値一覧の行クリックと同じ挙動)。
      // 位置が取れる entity 由来のレコードのみ対象
      const flyCartesian = record.entity ? getEntityPosition(record.entity) : null;
      const flyDeg = flyCartesian ? cartesianToDegrees(flyCartesian) : null;
      if (flyDeg && Number.isFinite(flyDeg.lat) && Number.isFinite(flyDeg.lng)) {
        table.querySelectorAll("tr").forEach(tr => {
          tr.style.cursor = "pointer";
          tr.title = t("vattr.clickToMove");
          tr.addEventListener("click", () => { void flyToFeature(flyDeg.lat, flyDeg.lng); });
        });
      }
      const setOpen = open => {
        table.hidden = !open;
        marker.textContent = open ? "▾" : "▸";
        header.setAttribute("aria-expanded", String(open));
      };
      header.addEventListener("click", () => {
        // 展開した地物のレイヤーを属性一覧ボタンの対象にする
        const open = table.hidden;
        setOpen(open);
        if (open) setAttrLayerContext(attr, record.item);
      });
      setOpen(!multiple);
      block.append(header, table);
      attr.append(block);
    });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  let lastRightClick = 0;
  viewer.canvas.addEventListener("contextmenu", event => {
    event.preventDefault();
    if (!walkModeActive) return;
    const now = performance.now();
    if (now - lastRightClick < 400) {
      if (flyPath && flyPathCoords) toggleFlyPathDirection(-1);
      else autoMove = autoMove === -1 ? 0 : -1;
    }
    lastRightClick = now;
  });

  viewer.canvas.addEventListener("dblclick", event => {
    if (!walkModeActive) return;
    if (event.button === 0) {
      if (flyPath && flyPathCoords) toggleFlyPathDirection(1);
      else autoMove = autoMove === 1 ? 0 : 1;
    }
  });

  let middlePointerId = null;
  let lastMiddleRotateX = 0;
  const middleRotateSpeed = 0.005;
  viewer.canvas.addEventListener("pointerdown", event => {
    if (event.button !== 1 || walkModeActive) return;
    const pitchDeg = viewer.camera.pitch * 180 / Math.PI;
    if (pitchDeg > -85) return;
    middlePointerId = event.pointerId;
    lastMiddleRotateX = event.clientX;
    viewer.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false, capture: true });
  viewer.canvas.addEventListener("pointermove", event => {
    if (middlePointerId === null || event.pointerId !== middlePointerId) return;
    if ((event.buttons & 4) === 0) { middlePointerId = null; return; }
    const deltaX = event.clientX - lastMiddleRotateX;
    if (deltaX === 0) return;
    lastMiddleRotateX = event.clientX;
    const newHeading = viewer.camera.heading + deltaX * middleRotateSpeed;
    viewer.camera.setView({
      destination: viewer.camera.position,
      orientation: { heading: newHeading, pitch: -Math.PI / 2, roll: 0 },
    });
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false, capture: true });
  viewer.canvas.addEventListener("pointerup", event => {
    if (middlePointerId === null || event.pointerId !== middlePointerId) return;
    middlePointerId = null;
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false, capture: true });
  viewer.canvas.addEventListener("pointercancel", event => {
    if (middlePointerId === null || event.pointerId !== middlePointerId) return;
    middlePointerId = null;
  }, { passive: false, capture: true });

  const walkHelpToggle = document.querySelector("#walk-help-toggle");
  if (walkHelpToggle) {
    walkHelpToggle.addEventListener("click", () => {
      const minimized = walkHelp.classList.toggle("minimized");
      walkHelpToggle.textContent = minimized ? "+" : "−";
      walkHelpToggle.setAttribute("aria-label", minimized ? t("common.expand") : t("common.minimize"));
    });
  }

  document.querySelectorAll(".walk-help-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".walk-help-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".walk-help-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`.walk-help-content[data-tab="${tab.dataset.tab}"]`)?.classList.add("active");
      const nextDrawTab = tab.dataset.tab === "draw";
      if (drawModeActive && !nextDrawTab) stopDrawMode();
      drawTabActive = nextDrawTab;
      setMode(drawTabActive ? "orbit" : "walk");
      if (nextDrawTab) void ensureDrawnRouteFlyPath();
    });
  });
  setupVectorSearch();
  void initAiChat({ engine: "cesium" });
  setupGoogleMapsSettings();
}


// 管理 → Google: Maps API キーと Photorealistic 3D Tiles の設定。
// （AI チャットの設定は shared/ai-chat.js の setupAiSettings へ移動）
function setupGoogleMapsSettings() {
  const mapsKeyInput = document.querySelector("#google-maps-api-key");
  const mapsWsKeyInput = document.querySelector("#google-maps-ws-api-key");
  const mapsSaveButton = document.querySelector("#google-maps-settings-save");
  const mapsStatus = document.querySelector("#google-maps-settings-status");
  const tiles3dToggle = document.querySelector("#google-3dtiles-toggle");
  if (!mapsKeyInput || !mapsSaveButton) return;
  try {
    mapsKeyInput.value = localStorage.getItem("googleMapsApiKey") || "";
    if (mapsWsKeyInput) mapsWsKeyInput.value = localStorage.getItem("googleMapsWsApiKey") || "";
    if (tiles3dToggle) tiles3dToggle.checked = localStorage.getItem("googleMaps3dTiles") === "1";
  } catch (e) {}
  mapsSaveButton.addEventListener("click", () => {
    try {
      localStorage.setItem("googleMapsApiKey", mapsKeyInput.value.trim());
      if (mapsWsKeyInput) localStorage.setItem("googleMapsWsApiKey", mapsWsKeyInput.value.trim());
      updateSearchProvider();
      if (mapsStatus) mapsStatus.textContent = t("common.saved");
      if (layerState.has(GOOGLE_3DTILES_LAYER_ID)) {
        syncGoogle3dTilesLayer();
        renderLayerList();
        refreshLayers();
      }
    } catch (e) {
      if (mapsStatus) mapsStatus.textContent = t("common.saveError", { error: e.message });
    }
  });
  tiles3dToggle?.addEventListener("change", () => {
    console.log("[Google3dTiles] toggle changed:", tiles3dToggle.checked);
    try {
      // 入力欄に未保存のキーがあれば保存してから有効化する
      if (tiles3dToggle.checked) {
        const pending = mapsKeyInput.value.trim();
        if (pending && pending !== (localStorage.getItem("googleMapsApiKey") || "")) {
          localStorage.setItem("googleMapsApiKey", pending);
          console.log("[Google3dTiles] 入力欄のキーを自動保存しました");
        }
      }
      const key = localStorage.getItem("googleMapsApiKey") || "";
      if (tiles3dToggle.checked && !key) {
        tiles3dToggle.checked = false;
        if (mapsStatus) mapsStatus.textContent = t("google.needKey");
        console.warn("[Google3dTiles] Maps API キーが未保存のため無効化しました");
        return;
      }
      localStorage.setItem("googleMaps3dTiles", tiles3dToggle.checked ? "1" : "0");
      syncGoogle3dTilesLayer();
      renderLayerList();
      refreshLayers();
      const added = layerState.has(GOOGLE_3DTILES_LAYER_ID);
      console.log(`[Google3dTiles] レイヤ一覧に存在: ${added}`);
      if (mapsStatus) mapsStatus.textContent = added
        ? t("google.tilesAdded")
        : t("google.tilesRemoved");
    } catch (error) {
      console.error("[Google3dTiles] トグル処理でエラー:", error);
      if (mapsStatus) mapsStatus.textContent = t("common.error", { error: error instanceof Error ? error.message : error });
    }
  });
}

function setupVectorSearch() {
  const vectorLayer = document.querySelector("#vector-layer");
  const vectorAttr = document.querySelector("#vector-attr");
  const vectorValue = document.querySelector("#vector-value");
  const vectorFlyBtn = document.querySelector("#vector-fly-btn");
  const vectorRefreshBtn = document.querySelector("#vector-refresh-btn");
  const vectorSearchText = document.querySelector("#vector-search-text");
  const vectorTextSearchBtn = document.querySelector("#vector-text-search-btn");
  const vectorSearchResults = document.querySelector("#vector-search-results");

  // 検索結果へのFLY時に、対象地物が属するレイヤーが非表示なら表示してから飛ぶ
  // (レイヤー一覧の📍フォーカスと同じ扱い。「全選択」検索は非表示レイヤーも対象のため必要)
  function showVectorFlyLayer(layerId) {
    const item = (layerId && layerId !== "__all__" && layerId !== "__visible__") ? layerState.get(layerId) : null;
    if (!item || item.visible) return;
    item.visible = true;
    if (item.exclusiveGroup) {
      getOrderedLayerItems().forEach(other => {
        if (other !== item && other.group === item.group && other.exclusiveGroup) other.visible = false;
      });
    }
    renderLayerList();
    void refreshLayers();
  }

  async function performVectorTextSearch() {
    try {
      if (!vectorSearchResults || !vectorSearchData) return;
      const q = vectorSearchText ? String(vectorSearchText.value).trim() : "";
      if (!q) { vectorSearchResults.innerHTML = ""; return; }
      const query = q.toLowerCase();
      const targetLayerId = (vectorLayer && vectorLayer.value) ? vectorLayer.value : "__all__";
      const targetAttr = (vectorAttr && vectorAttr.value) ? vectorAttr.value : "__all__";
      // 「全選択」は非表示・未ロードのレイヤーも含めた全レイヤーが対象。
      // 検索の実行時に未ロード分をまとめて読み込んでから索引・検索する
      if (targetLayerId === "__all__") await ensureAllVectorSourcesIndexed();
      const data = vectorSearchData;
      const res = [];
      // 「表示レイヤ」は表示中レイヤーだけを対象にレイヤー単位で検索する
      // (結果行にレイヤー名が出る)
      const layerIds = (targetLayerId === "__all__") ? ["__all__"]
        : (targetLayerId === "__visible__") ? getVisibleIndexedLayerIds()
        : [targetLayerId];
      for (const layerId of layerIds) {
        try {
          const source = (layerId === "__all__") ? data.all : (data.layers && data.layers[layerId]);
          if (!source) continue;
          const attrList = (targetAttr === "__all__") ? (source.attributes || []) : [targetAttr];
          for (const attr of attrList) {
            if (!attr || attr === "__all__") continue;
            const values = (source.valuesByAttr && Array.isArray(source.valuesByAttr[attr])) ? source.valuesByAttr[attr] : [];
            for (const val of values) {
              const haystack = (String(val) + " " + String(attr)).toLowerCase();
              if (haystack.includes(query)) {
                const pos = (source.featureByAttr && source.featureByAttr[attr] && source.featureByAttr[attr][val]) || null;
                // 「全選択」では索引の layerId から所属レイヤーを復元する(FLY時の表示切替・結果表示用)
                const resultLayerId = (layerId === "__all__") ? ((pos && pos.layerId) || "__all__") : layerId;
                const layerTitle = (layerId === "__all__")
                  ? ((data.layers && data.layers[resultLayerId] && data.layers[resultLayerId].title)
                    || (layerState.get(resultLayerId) && layerState.get(resultLayerId).title)
                    || t("common.all"))
                  : ((data.layers && data.layers[layerId] && data.layers[layerId].title) || layerId);
                res.push({ layerId: resultLayerId, layerTitle, attr, value: val, lat: pos ? pos.lat : null, lng: pos ? pos.lng : null });
              }
            }
          }
        } catch (e) {}
      }
      if (!res.length) {
        vectorSearchResults.innerHTML = '<li style="padding:4px;color:#71818d;">' + escapeHtml(t("vector.noMatch")) + '</li>';
        return;
      }
      vectorSearchResults.innerHTML = res.slice(0, 50).map((r, i) =>
        '<li class="vector-search-result" data-idx="' + i + '" style="padding:4px;border-bottom:1px solid #e4ecef;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
        escapeHtml(r.layerTitle) + ' / ' + escapeHtml(r.attr) + ' / ' + escapeHtml(r.value) +
        '</li>'
      ).join("");
      vectorSearchResults._resultData = res;
    } catch (e) { console.error("vector text search error", e); }
  }

  if (vectorSearchResults) {
    vectorSearchResults.addEventListener("click", (ev) => {
      try {
        const li = ev.target.closest && ev.target.closest("li[data-idx]");
        if (!li || !vectorSearchResults._resultData) return;
        const r = vectorSearchResults._resultData[Number(li.getAttribute("data-idx"))];
        if (!r) return;
        if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
          showVectorFlyLayer(r.layerId);
          flyToFeature(r.lat, r.lng);
        }
      } catch (e) { console.error("vector result click error", e); }
    });
  }

  if (vectorTextSearchBtn) vectorTextSearchBtn.addEventListener("click", performVectorTextSearch);
  if (vectorSearchText) vectorSearchText.addEventListener("keydown", (ev) => { if (ev.key === "Enter") performVectorTextSearch(); });

  if (vectorLayer) {
    vectorLayer.addEventListener("change", () => {
      try {
        const source = getCurrentVectorSource();
        if (vectorAttr) {
          if (source && source.attributes && source.attributes.length) {
            vectorAttr.innerHTML = '<option value="__all__">' + escapeHtml(t("common.all")) + '</option>' + source.attributes.map(a => '<option value="' + escapeHtml(a) + '">' + escapeHtml(a) + '</option>').join("");
            vectorAttr.disabled = false;
          } else {
            vectorAttr.innerHTML = '<option value="__all__">' + escapeHtml(t("common.all")) + '</option>';
            vectorAttr.disabled = true;
          }
          vectorAttr.value = "__all__";
        }
        if (vectorValue) {
          vectorValue.innerHTML = '<option value="">' + escapeHtml(t("vector.valuePlaceholder")) + '</option>';
          vectorValue.disabled = true;
        }
        if (vectorFlyBtn) vectorFlyBtn.disabled = true;
        // 未ロードレイヤーが選択されたらオンデマンドで読み込み、索引して検索可能にする。
        // 属性値一覧ウィジェットと同じく「候補には出すが選択されるまで読まない」方式
        const selId = vectorLayer.value;
        const selItem = (selId && selId !== "__all__") ? layerState.get(selId) : null;
        const alreadyIndexed = !!(vectorSearchData && vectorSearchData.layers && vectorSearchData.layers[selId]);
        if (selItem && !alreadyIndexed && !vectorSearchLoadFailed.has(selId)) {
          const dec = vectorDecoders.get(selItem.type);
          const searchable = selItem.type === "geojson" || selItem.type === "layer" || selItem.type === "entities" || !!dec;
          if (searchable && !isQueryDecoder(dec, selItem)) {
            const statusEl = document.querySelector("#vector-search-status");
            if (statusEl) statusEl.textContent = t("common.loading");
            loadVectorSourceCached(selItem, dec).then(src => {
              if (src && Array.isArray(src.features)) vectorSearchLoadedSources.set(selId, src);
              buildVectorSearchIndex();
              updateVectorSearchUI();
              // テキスト検索欄に入力済みなら索引更新後に再検索する
              performVectorTextSearch();
            }).catch(e => {
              vectorSearchLoadFailed.add(selId);
              console.warn("[vector-search] layer load failed:", selId, e);
              if (statusEl) statusEl.textContent = t("vector.status.none");
            });
          }
        }
        if (vectorAttrWidget && vectorAttrWidget.classList.contains("visible")) {
          refreshVectorAttrWidgetRows();
        }
      } catch (e) { console.error("vector layer change error", e); }
    });
  }

  if (vectorAttr) {
    vectorAttr.addEventListener("change", () => {
      try {
        const source = getCurrentVectorSource();
        const attr = vectorAttr.value;
        if (vectorValue) {
          if (source && source.valuesByAttr && attr && attr !== "__all__" && Array.isArray(source.valuesByAttr[attr])) {
            vectorValue.innerHTML = '<option value="">' + escapeHtml(t("vector.valuePlaceholder")) + '</option>' + source.valuesByAttr[attr].map(v => '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>').join("");
            vectorValue.disabled = false;
          } else {
            vectorValue.innerHTML = '<option value="">' + escapeHtml(t("vector.valuePlaceholder")) + '</option>';
            vectorValue.disabled = true;
          }
          vectorValue.value = "";
          if (vectorFlyBtn) vectorFlyBtn.disabled = true;
        }
      } catch (e) { console.error("vector attr change error", e); }
    });
  }

  if (vectorValue) {
    vectorValue.addEventListener("change", () => {
      if (vectorFlyBtn) vectorFlyBtn.disabled = !vectorValue.value;
    });
  }

  if (vectorFlyBtn) {
    vectorFlyBtn.addEventListener("click", () => {
      try {
        if (!vectorLayer || !vectorAttr || !vectorValue || !vectorAttr.value || !vectorValue.value) return;
        const source = getCurrentVectorSource();
        const pos = (source && source.featureByAttr && source.featureByAttr[vectorAttr.value] && source.featureByAttr[vectorAttr.value][vectorValue.value]) || null;
        if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
          const flyLayerId = pos.layerId || ((vectorLayer.value !== "__all__" && vectorLayer.value !== "__visible__") ? vectorLayer.value : null);
          showVectorFlyLayer(flyLayerId);
          flyToFeature(pos.lat, pos.lng);
        }
      } catch (e) { console.error("vector fly error", e); }
    });
  }

  if (vectorRefreshBtn) {
    vectorRefreshBtn.addEventListener("click", () => {
      try {
        const status = document.querySelector("#vector-search-status");
        if (status) status.textContent = t("common.loading");
        buildVectorSearchIndex();
        updateVectorSearchUI();
      } catch (e) { console.error("vector refresh error", e); }
    });
  }

  const vectorAttrListBtn = document.querySelector("#vector-attr-list-btn");
  const vectorAttrWidget = document.querySelector("#vector-attr-widget");
  const vectorAttrWidgetClose = document.querySelector(".vector-attr-widget-close");
  const vectorAttrWidgetResizer = document.querySelector(".vector-attr-widget-resizer");
  const vectorAttrWidgetSearch = document.querySelector("#vector-attr-widget-search");
  const vectorAttrWidgetLayerSelect = document.querySelector("#vector-attr-widget-layer");
  const vectorAttrWidgetHead = document.querySelector("#vector-attr-widget-head");
  const vectorAttrWidgetList = document.querySelector("#vector-attr-widget-list");
  const vectorAttrWidgetCount = document.querySelector("#vector-attr-widget-count");
  const vectorAttrWidgetTitle = document.querySelector(".vector-attr-widget-title");
  let vectorAttrWidgetRows = [];
  let vectorAttrWidgetAttributes = [];
  let vectorAttrWidgetSort = { column: -1, order: 1 };
  let vectorAttrWidgetLoading = false;
  let vectorAttrWidgetLoadError = false;
  // 非同期の行構築(クエリ/オンデマンド読み込み)が遅れて解決したときに
  // 新しい選択の結果を上書きしないための世代番号
  let vectorAttrWidgetRequestSeq = 0;

  function getVectorDataSourceById(layerId) {
    if (layerId === "__all__") return null;
    return vectorDataSources.find(item => item.id === layerId) || null;
  }

  // 未ロードレイヤーの DataSource をオンデマンドで読み込む。
  // 同一レイヤーの重複読み込みをキャッシュで抑止し、失敗時は破棄してリトライ可能にする
  function loadAttrWidgetDataSource(layerItem, layerDecoder) {
    let promise = vectorAttrLoadCache.get(layerItem.id);
    if (!promise) {
      promise = (async () => {
        const src = await loadVectorSourceCached(layerItem, layerDecoder);
        return src ? Cesium.GeoJsonDataSource.load(src) : null;
      })();
      promise.catch(() => { if (vectorAttrLoadCache.get(layerItem.id) === promise) vectorAttrLoadCache.delete(layerItem.id); });
      vectorAttrLoadCache.set(layerItem.id, promise);
    }
    return promise;
  }

  // AI が追加するインライン GeoJSON は、地図描画用の Cesium 変換に失敗しても
  // 属性そのものを表示できるよう、元フィーチャから一覧を構築する。
  function buildVectorAttrWidgetRowsFromGeoJson(data) {
    const features = data && data.type === "FeatureCollection" && Array.isArray(data.features) ? data.features : null;
    if (!features) return false;
    const attributes = [...new Set(features.flatMap(feature =>
      feature && feature.properties && typeof feature.properties === "object" ? Object.keys(feature.properties) : []
    ))].sort((a, b) => a.localeCompare(b));
    if (!attributes.length) return false;
    vectorAttrWidgetAttributes = attributes;
    vectorAttrWidgetRows = features.filter(feature => feature && feature.type === "Feature").map(feature => {
      const props = feature.properties || {};
      const deg = geoJsonFeatureDegrees(feature);
      return {
        values: attributes.map(attr => {
          const raw = props[attr];
          return raw == null ? "" : (typeof raw === "object" ? JSON.stringify(raw) : String(raw));
        }),
        lat: deg && Number.isFinite(deg.lat) ? deg.lat : null,
        lng: deg && Number.isFinite(deg.lng) ? deg.lng : null,
      };
    });
    return true;
  }

  async function buildVectorAttrWidgetRows() {
    const requestSeq = ++vectorAttrWidgetRequestSeq;
    const isCurrent = () => requestSeq === vectorAttrWidgetRequestSeq;
    vectorAttrWidgetRows = [];
    vectorAttrWidgetAttributes = [];
    vectorAttrWidgetSort = { column: -1, order: 1 };
    vectorAttrWidgetLoading = false;
    vectorAttrWidgetLoadError = false;
    // ウィジェット側の選択を優先(クエリ系レイヤーは検索パネルの #vector-layer に存在しないため)
    const layerId = (vectorAttrWidgetLayerSelect && vectorAttrWidgetLayerSelect.value) || (vectorLayer && vectorLayer.value) || "__all__";
    // クエリ系レイヤー(duckdb:/sql:)は読み込み済み entity ではなく DuckDB に直接クエリして全件対象で一覧を作る
    const layerItem = layerState.get(layerId);
    const layerDecoder = layerItem && vectorDecoders.get(layerItem.type);
    if (isQueryDecoder(layerDecoder, layerItem)) {
      // クエリ系レイヤーはエンジンへの直接クエリで全件対象の一覧を作る。
      // GPKG は sql.js(Worker)、それ以外は DuckDB-WASM。DuckDB-WASM の
      // 初回初期化は数十秒かかることがあるため読み込み中表示にする
      vectorAttrWidgetLoading = true;
      renderVectorAttrWidget(vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : "");
      try {
        const searchText = vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : "";
        const result = isGpkgBackedItem(layerItem)
          ? await queryGpkgAttributeRows(layerItem, searchText)
          : await queryDuckDbAttributeRows(layerItem, searchText);
        if (!isCurrent()) return;
        vectorAttrWidgetAttributes = result.attributes;
        vectorAttrWidgetRows = result.rows;
      } catch (e) {
        if (!isCurrent()) return;
        vectorAttrWidgetLoadError = true;
        console.warn(`${layerItem.type.toUpperCase()} 属性一覧の取得に失敗しました:`, e);
      } finally {
        if (isCurrent()) vectorAttrWidgetLoading = false;
      }
      return;
    }
    let ds = (getVectorDataSourceById(layerId) || {}).ds || (layerItem && layerItem.dataSource) || null;
    // 未ロードのレイヤー(非表示・ロード待ち)は、選択された時点で実データから直接行を構築する。
    // 使わないデータを起動時に完全読み込みする必要はない
    if (!ds && layerItem && (layerItem.type === "geojson" || layerItem.type === "layer" || layerDecoder)) {
      vectorAttrWidgetLoading = true;
      renderVectorAttrWidget(vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : "");
      try {
        ds = await loadAttrWidgetDataSource(layerItem, layerDecoder);
      } catch (e) {
        if (isCurrent()) {
          if (layerItem.data && buildVectorAttrWidgetRowsFromGeoJson(layerItem.data)) {
            console.warn("属性一覧をGeoJSONの元データから表示します:", layerItem.title, e);
          } else {
            vectorAttrWidgetLoadError = true;
            console.warn("属性一覧の読み込みに失敗しました:", layerItem.url || "", e);
          }
        }
      } finally {
        if (isCurrent()) vectorAttrWidgetLoading = false;
      }
    }
    if (!isCurrent() || !ds) return;
    const time = viewer.clock && viewer.clock.currentTime;
    // 属性列は検索索引があればそこから、未索引(オンデマンド読み込み)は entity から収集する
    const source = (vectorSearchData && vectorSearchData.layers && vectorSearchData.layers[layerId]) || null;
    if (source && source.attributes && source.attributes.length) {
      vectorAttrWidgetAttributes = source.attributes.slice();
    } else {
      const attrSet = new Set();
      for (const entity of ds.entities.values) {
        const props = (entity.properties && entity.properties.getValue) ? entity.properties.getValue(time) : (entity.properties || {});
        if (!props) continue;
        for (const key of Object.keys(props)) {
          const raw = props[key];
          if (raw == null || raw === "") continue;
          attrSet.add(key);
        }
      }
      vectorAttrWidgetAttributes = [...attrSet].sort((a, b) => a.localeCompare(b));
    }
    if (!vectorAttrWidgetAttributes.length) return;
    // GeoJsonDataSource は MultiPolygon 等をパート毎の別 entity に分割する。
    // 同一フィーチャ由来の entity は properties が一致するので、地物単位で1行にまとめる
    const seenRows = new Set();
    for (const entity of ds.entities.values) {
      const props = (entity.properties && entity.properties.getValue) ? entity.properties.getValue(time) : (entity.properties || {});
      const row = [];
      for (const attr of vectorAttrWidgetAttributes) {
        const raw = props ? props[attr] : undefined;
        const val = (raw == null) ? "" : (typeof raw === "object" ? JSON.stringify(raw) : String(raw));
        row.push(val);
      }
      const rowKey = JSON.stringify(row);
      if (seenRows.has(rowKey)) continue;
      seenRows.add(rowKey);
      const cartesian = getEntityPosition(entity);
      const deg = cartesian ? cartesianToDegrees(cartesian) : null;
      vectorAttrWidgetRows.push({
        values: row,
        lat: deg && Number.isFinite(deg.lat) ? deg.lat : null,
        lng: deg && Number.isFinite(deg.lng) ? deg.lng : null,
      });
    }
  }

  function renderVectorAttrWidget(filter = "") {
    try {
      if (!vectorAttrWidgetList || !vectorAttrWidgetCount || !vectorAttrWidgetTitle) return;
      const query = String(filter).toLowerCase().trim();
      let matched = query ? vectorAttrWidgetRows.filter(row => row.values.some(val => String(val).toLowerCase().includes(query))) : [...vectorAttrWidgetRows];
      if (vectorAttrWidgetSort.column >= 0 && vectorAttrWidgetSort.column < vectorAttrWidgetAttributes.length) {
        const col = vectorAttrWidgetSort.column;
        const order = vectorAttrWidgetSort.order;
        matched.sort((a, b) => {
          const left = a.values[col] || "";
          const right = b.values[col] || "";
          const cmp = String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
          return cmp * order;
        });
      }
      const displayRows = matched.slice(0, 1000);
      const widgetLayerId = (vectorAttrWidgetLayerSelect && vectorAttrWidgetLayerSelect.value) || (vectorLayer ? vectorLayer.value : "__all__");
      const layerTitle = (widgetLayerId !== "__all__" && ((vectorSearchData && vectorSearchData.layers && vectorSearchData.layers[widgetLayerId] && vectorSearchData.layers[widgetLayerId].title) || (layerState.get(widgetLayerId) && layerState.get(widgetLayerId).title))) || t("common.all");
      vectorAttrWidgetTitle.textContent = t("vattr.title") + (layerTitle ? " — " + layerTitle : "");
      if (!vectorAttrWidgetAttributes.length) {
        if (vectorAttrWidgetHead) vectorAttrWidgetHead.innerHTML = "";
        const msgKey = vectorAttrWidgetLoading ? "common.loading" : vectorAttrWidgetLoadError ? "vattr.loadFailed" : "vattr.selectLayer";
        vectorAttrWidgetList.innerHTML = '<tr><td style="padding:12px 14px;color:#71818d;">' + escapeHtml(t(msgKey)) + '</td></tr>';
        vectorAttrWidgetCount.textContent = t("vattr.count", { matched: 0, attrs: 0 });
        return;
      }
      if (vectorAttrWidgetHead) {
        vectorAttrWidgetHead.innerHTML = '<tr>' + vectorAttrWidgetAttributes.map((attr, idx) => {
          const active = vectorAttrWidgetSort.column === idx;
          const marker = active ? (vectorAttrWidgetSort.order > 0 ? ' ▲' : ' ▼') : '';
          return '<th data-idx="' + idx + '" title="' + escapeHtml(t("vattr.sort")) + '"' + (active ? ' class="sorted"' : '') + '>' + escapeHtml(attr) + '<span class="sort-marker">' + marker + '</span></th>';
        }).join("") + '</tr>';
      }
      if (!displayRows.length) {
        vectorAttrWidgetList.innerHTML = '<tr><td colspan="' + vectorAttrWidgetAttributes.length + '" style="padding:12px 14px;color:#71818d;">' + escapeHtml(t("vattr.noFeatures")) + '</td></tr>';
        vectorAttrWidgetCount.textContent = t("vattr.count", { matched: query ? 0 : vectorAttrWidgetRows.length, attrs: vectorAttrWidgetAttributes.length });
        return;
      }
      vectorAttrWidgetList.innerHTML = displayRows.map(row => {
        const flyable = Number.isFinite(row.lat) && Number.isFinite(row.lng);
        const dataAttrs = flyable ? 'data-lat="' + row.lat + '" data-lng="' + row.lng + '"' : '';
        const style = flyable ? 'style="cursor:pointer;"' : '';
        return '<tr class="vector-attr-widget-row" ' + dataAttrs + ' ' + style + ' title="' + (flyable ? escapeHtml(t("vattr.clickToMove")) : '') + '">' +
          row.values.map(val => '<td class="vector-attr-widget-cell" title="' + escapeHtml(val) + '">' + escapeHtml(val) + '</td>').join("") +
          '</tr>';
      }).join("");
      const suffix = (matched.length > displayRows.length) ? t("vattr.limitSuffix", { count: displayRows.length }) : "";
      vectorAttrWidgetCount.textContent = t("vattr.count", { matched: matched.length, attrs: vectorAttrWidgetAttributes.length }) + suffix;
    } catch (e) { console.error("vector attr widget render error", e); }
  }

  function updateVectorAttrWidgetLayerOptions(layerId) {
    if (!vectorAttrWidgetLayerSelect) return;
    // 選択肢は検索索引ではなくレイヤー一覧から即時構築する。
    // 未ロードのレイヤーも選択肢に出し、行はロード完了後(クエリ系は選択時の
    // DuckDB 直接クエリ)に利用可能になる
    const opts = getOrderedLayerItems()
      .filter(item => item.type === "geojson" || item.type === "layer" || item.type === "entities" || vectorDecoders.has(item.type));
    let html = '<option value="">' + escapeHtml(t("vattr.layerTitle")) + '</option>';
    for (const o of opts) {
      html += '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(o.title || o.id) + '</option>';
    }
    vectorAttrWidgetLayerSelect.innerHTML = html;
    const hasLayer = layerId && layerId !== "__all__" && opts.some(o => o.id === layerId);
    vectorAttrWidgetLayerSelect.value = hasLayer ? layerId : "";
  }

  // 開いているウィジェットの行を再構築する。クエリ系レイヤーは再クエリが重いため
  // withQueryRows 指定時(フィルター変更等)だけ再取得し、それ以外は既取得行を保持する
  function refreshVectorAttrWidgetRows(withQueryRows = false) {
    if (!vectorAttrWidget || !vectorAttrWidget.classList.contains("visible")) return;
    const layerId = vectorAttrWidgetLayerSelect ? vectorAttrWidgetLayerSelect.value : "";
    const item = layerState.get(layerId);
    const dec = item && vectorDecoders.get(item.type);
    if (isQueryDecoder(dec, item) && !withQueryRows) return;
    void buildVectorAttrWidgetRows().then(() => renderVectorAttrWidget(vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : ""));
  }

  // 検索索引の更新(updateVectorSearchUI)やレイヤー一覧の変更に合わせて、開いて
  // いるウィジェットの選択肢・行を追従させる。選択肢自体はレイヤー一覧由来で
  // ロード非依存だが、行は索引・オンデマンド読み込みの完了に合わせて再構築する
  uiHooks.refreshVectorAttrWidget = (withQueryRows = false) => {
    updateVectorAttrWidgetLayerOptions(vectorAttrWidgetLayerSelect ? vectorAttrWidgetLayerSelect.value : null);
    refreshVectorAttrWidgetRows(withQueryRows);
  };

  async function openVectorAttrWidget(layerId = null) {
    if (!vectorAttrWidget) return;
    if (vectorLayer) {
      if (layerId && layerId !== "__all__" && [...vectorLayer.options].some(option => option.value === layerId)) {
        vectorLayer.value = layerId;
      } else if (!layerId || layerId === "__all__") {
        vectorLayer.value = "__all__";
      }
    }
    updateVectorAttrWidgetLayerOptions(layerId || (vectorLayer ? vectorLayer.value : null));
    await buildVectorAttrWidgetRows();
    renderVectorAttrWidget(vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : "");
    vectorAttrWidget.classList.add("visible");
    if (vectorAttrWidgetSearch) vectorAttrWidgetSearch.focus();
  }

  function closeVectorAttrWidget() {
    if (vectorAttrWidget) vectorAttrWidget.classList.remove("visible");
  }

  if (vectorAttrListBtn) vectorAttrListBtn.addEventListener("click", () => openVectorAttrWidget(vectorLayer ? vectorLayer.value : null));
  const attrVectorAttrListBtn = document.querySelector("#attr-vector-attr-list-btn");
  const attrContent = document.querySelector("#attr-content");
  if (attrVectorAttrListBtn) {
    attrVectorAttrListBtn.addEventListener("click", () => {
      const layerId = (attrContent && attrContent.dataset.layerId) ? attrContent.dataset.layerId : (vectorLayer ? vectorLayer.value : null);
      openVectorAttrWidget(layerId);
    });
  }
  if (vectorAttrWidgetClose) vectorAttrWidgetClose.addEventListener("click", closeVectorAttrWidget);
  window.addEventListener("kasugai:language-changed", () => {
    updateVectorAttrWidgetLayerOptions(vectorAttrWidgetLayerSelect ? vectorAttrWidgetLayerSelect.value : null);
    if (vectorAttrWidget && vectorAttrWidget.classList.contains("visible")) {
      buildVectorAttrWidgetRows().then(() => renderVectorAttrWidget(vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : ""));
    }
  });
  if (vectorAttrWidgetSearch) {
    // クエリ系レイヤーでは検索文字を SQL(ILIKE)に変換してファイル全件を対象に再クエリする。
    // それ以外は取得済み行へのクライアントフィルター
    let attrSearchTimer = null;
    const onAttrSearch = () => {
      const layerId = vectorAttrWidgetLayerSelect ? vectorAttrWidgetLayerSelect.value : "";
      const li = layerState.get(layerId);
      const dec = li && vectorDecoders.get(li.type);
      if (isQueryDecoder(dec, li)) {
        clearTimeout(attrSearchTimer);
        attrSearchTimer = setTimeout(async () => {
          await buildVectorAttrWidgetRows();
          renderVectorAttrWidget(vectorAttrWidgetSearch.value);
        }, 300);
      } else {
        renderVectorAttrWidget(vectorAttrWidgetSearch.value);
      }
    };
    vectorAttrWidgetSearch.addEventListener("input", onAttrSearch);
    vectorAttrWidgetSearch.addEventListener("keydown", (ev) => { if (ev.key === "Enter") onAttrSearch(); });
  }

  if (vectorAttrWidgetLayerSelect) {
    vectorAttrWidgetLayerSelect.addEventListener("change", () => {
      try { openVectorAttrWidget(vectorAttrWidgetLayerSelect.value); } catch (e) { console.error("vector attr layer change error", e); }
    });
  }

  if (vectorAttrWidgetList) {
    vectorAttrWidgetList.addEventListener("click", (ev) => {
      try {
        const tr = ev.target.closest("tr");
        if (!tr) return;
        const latAttr = tr.getAttribute("data-lat");
        const lngAttr = tr.getAttribute("data-lng");
        if (latAttr == null || lngAttr == null) return;
        const lat = Number(latAttr);
        const lng = Number(lngAttr);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          showVectorFlyLayer(vectorAttrWidgetLayerSelect ? vectorAttrWidgetLayerSelect.value : null);
          flyToFeature(lat, lng);
        }
      } catch (e) { console.error("vector attr row click error", e); }
    });
  }

  if (vectorAttrWidgetHead) {
    vectorAttrWidgetHead.addEventListener("click", (ev) => {
      try {
        const th = ev.target.closest("th");
        if (!th || !th.hasAttribute("data-idx")) return;
        const idx = Number(th.getAttribute("data-idx"));
        if (vectorAttrWidgetSort.column === idx) {
          vectorAttrWidgetSort.order *= -1;
        } else {
          vectorAttrWidgetSort = { column: idx, order: 1 };
        }
        renderVectorAttrWidget(vectorAttrWidgetSearch ? vectorAttrWidgetSearch.value : "");
      } catch (e) { console.error("vector attr head click error", e); }
    });
  }

  if (vectorAttrWidgetResizer && vectorAttrWidget) {
    let startY = 0;
    let startHeight = 0;
    let isResizing = false;

    function onMouseMove(ev) {
      if (!isResizing) return;
      ev.preventDefault();
      const delta = startY - ev.clientY;
      const nextHeight = startHeight + delta;
      const maxHeight = Math.min(window.innerHeight * 0.9, 1200);
      const clamped = Math.max(120, Math.min(maxHeight, nextHeight));
      vectorAttrWidget.style.height = clamped + "px";
    }

    function onMouseUp() {
      isResizing = false;
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (window.getSelection) window.getSelection().removeAllRanges();
    }

    vectorAttrWidgetResizer.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      isResizing = true;
      startY = ev.clientY;
      startHeight = vectorAttrWidget.offsetHeight;
      document.body.style.cursor = "ns-resize";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });
  }

  window.vectorAttrWidget = { open: openVectorAttrWidget, close: closeVectorAttrWidget };
}

// 自動更新の無限ループ防止用。更新適用→再起動→リロード後もバージョンが変わらない
// （配布ZIPの中身が古い等）場合に、同一タブ内での再試行を止めるため試行済みバージョンを記録する
const UPDATE_ATTEMPT_KEY = "kasugaiUpdateAttempt";

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const leftPart = Number.isFinite(a[index]) ? a[index] : 0;
    const rightPart = Number.isFinite(b[index]) ? b[index] : 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

async function loadUpdateInfo() {
  const current = document.querySelector("#current-version");
  if (!backendEnabled) {
    if (current) current.textContent = "-";
    return;
  }
  try {
    const [healthResponse, settingsResponse] = await Promise.all([
      fetch("/health"),
      fetch("/api/update/settings"),
    ]);
    if (!healthResponse.ok || !settingsResponse.ok) throw new Error(t("update.fetchFailed"));
    const health = await healthResponse.json();
    const settings = await settingsResponse.json();
    current.textContent = health.version || "-";
    if (Number.isInteger(health.port)) document.querySelector("#current-port").value = health.port;
    document.querySelector("#auto-update").checked = settings.autoUpdate !== false;
    void loadFetchSettings();
    await checkForUpdate(health.version);
  } catch (error) {
    current.textContent = "-";
    document.querySelector("#version-status").textContent = t("update.fetchFailedError", { error: error.message });
  }
}

async function checkForUpdate(currentVersion = document.querySelector("#current-version").textContent) {
  const status = document.querySelector("#version-status");
  const updateStatus = document.querySelector("#update-status");
  const installButton = document.querySelector("#install-update");
  status.textContent = t("update.checking");
  installButton.hidden = true;
  try {
    const response = await fetch("/api/update/latest");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const latestVersion = data.version || "-";
    document.querySelector("#latest-version").textContent = latestVersion;
    const comparison = compareVersions(currentVersion, latestVersion);
    if (comparison < 0) {
      updateStatus.textContent = t("update.availableMark");
      status.textContent = t("update.available");
      installButton.hidden = false;
      if (document.querySelector("#auto-update").checked) {
        let attempted = null;
        try { attempted = sessionStorage.getItem(UPDATE_ATTEMPT_KEY); } catch (e) {}
        if (attempted === latestVersion) {
          status.textContent = t("update.retrySkipped");
        } else {
          await installUpdate(latestVersion, true);
        }
      }
    } else if (comparison === 0) {
      updateStatus.textContent = t("update.latestMark");
      status.textContent = "";
    } else {
      updateStatus.textContent = t("update.newerMark");
      status.textContent = "";
    }
  } catch (error) {
    document.querySelector("#latest-version").textContent = "-";
    status.textContent = t("update.checkError", { error: error.message });
  }
}

async function installUpdate(latestVersion = document.querySelector("#latest-version").textContent, silent = false) {
  if (!silent && !confirm(t("update.confirm", { version: latestVersion }))) {
    document.querySelector("#version-status").textContent = t("update.cancelled");
    return;
  }
  const button = document.querySelector("#install-update");
  button.disabled = true;
  document.querySelector("#version-status").textContent = t("update.preparing");
  try {
    const response = await fetch("/api/update/install", { method: "POST" });
    const body = await response.text();
    let data;
    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      data = {};
    }
    if (!response.ok) throw new Error(data.error || body || `HTTP ${response.status}`);
    try { sessionStorage.setItem(UPDATE_ATTEMPT_KEY, latestVersion); } catch (e) {}
    document.querySelector("#version-status").textContent = data.message || t("update.started");
    void reloadAfterRestart();
  } catch (error) {
    document.querySelector("#version-status").textContent = t("update.installError", { error: error.message });
    button.disabled = false;
  }
}

async function reloadAfterRestart() {
  const status = document.querySelector("#version-status");
  const ping = async () => {
    try {
      const response = await fetch("/health", { cache: "no-store" });
      return response.ok;
    } catch {
      return false;
    }
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  status.textContent = t("update.waiting");
  // 旧サーバーの停止を待つ（早すぎるリロードを防ぐ）
  for (let i = 0; i < 60 && await ping(); i++) await sleep(1000);
  // 新サーバーの起動を待ってリロード（カメラ位置はURLハッシュから復元される）
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await ping()) {
      window.location.reload();
      return;
    }
  }
  status.textContent = t("update.restartFailed");
}

async function saveUpdateSettings() {
  if (!backendEnabled) return;
  const autoUpdate = document.querySelector("#auto-update").checked;
  const response = await fetch("/api/update/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoUpdate }),
  });
  if (!response.ok) throw new Error(await response.text());
  document.querySelector("#version-status").textContent = t("update.settingsSaved");
}

// /api/fetch の接続先許可リスト(ローカル版のみ提供)。社内LAN等の
// プライベートアドレスからデータを取得したい場合の設定UI
async function loadFetchSettings() {
  const section = document.querySelector("#fetch-allow-section");
  if (!section) return;
  try {
    const response = await fetch("/api/fetch/settings");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const settings = await response.json();
    document.querySelector("#fetch-allow").value = (settings.allow || []).join("\n");
    section.hidden = false;
  } catch {
    section.hidden = true;
  }
}

async function saveFetchSettings() {
  const allow = document
    .querySelector("#fetch-allow")
    .value.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const response = await fetch("/api/fetch/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allow }),
  });
  if (!response.ok) throw new Error(await response.text());
  document.querySelector("#fetch-allow-status").textContent = t("update.settingsSaved");
}

const defaultConfig = `base: 地理院タイル 標準地図 | https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png | 出典：国土地理院
3dtiles: 東京都/千代田区（建築物LOD1） | https://assets.cms.plateau.reearth.io/assets/0e/e5948a-e95c-4e31-be85-1f8c066ed996/13101_chiyoda-ku_pref_2023_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod1/tileset.json
cam:東京駅|35.653108|139.761449|height=2200.6|pitch=-30|heading=348.5`;

document.querySelector("#current-port").value = window.location.port || (window.location.protocol === "https:" ? "443" : "8510");
setupEvents();

viewer.camera.moveEnd.addEventListener(() => {
  const ssec = viewer.scene.screenSpaceCameraController;
  if (!ssec.enableTilt) return;
  const pitchDeg = viewer.camera.pitch * 180 / Math.PI;
  if (pitchDeg < -85) {
    viewer.camera.setView({
      destination: viewer.camera.position,
      orientation: { heading: viewer.camera.heading, pitch: -84.99 * Math.PI / 180, roll: 0 }
    });
  }
});

// 表示範囲連動レイヤー(bbox=auto / :bbox / 件数超過レイヤーの再スライス)は
// カメラ停止ごとに範囲絞り込みで再クエリ・再構築する
let viewportQueryTimer = null;
const scheduleViewportRefresh = () => {
  if (!layers.some(item => isViewportQueryLayer(item) || item.viewportSliced)) return;
  clearTimeout(viewportQueryTimer);
  viewportQueryTimer = setTimeout(() => { void refreshViewportLayers(); }, 400);
};
viewer.camera.moveEnd.addEventListener(scheduleViewportRefresh);
// setView 等の即時ジャンプは moveEnd が発火しないことがあるため changed も併用する
// (移動中は連続発火するが、タイマー再セットで実質停止時の1回にデバウンスされる)
viewer.camera.changed.addEventListener(scheduleViewportRefresh);

setupThreeJs();
// サーバー .kasc 対応の認証時はサーバー側の .kasc のみ使い、内蔵デフォルトは適用しない
applyInspector(window.kasugaiAuth?.serverKasc ? "" : defaultConfig);
updateEffectSettings();
const urlCamera = parseUrlCamera(initialCameraSource);

function parseUrlCamera(source = window.location.search + window.location.hash) {
  const hashIndex = source.indexOf("#");
  const searchPart = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const hashPart = hashIndex >= 0 ? source.slice(hashIndex + 1) : "";
  const searchParams = new URLSearchParams(searchPart.startsWith("?") ? searchPart.slice(1) : searchPart);
  const hashParams = new URLSearchParams(hashPart);
  const getNumber = (name, fallback) => {
    const raw = hashParams.get(name) ?? searchParams.get(name);
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const latitude = getNumber("latitude");
  const zoom = getNumber("zoom");
  // 2Dエンジンとの往復URLでは zoom が正典。あれば実FOV・実キャンバス高で
  // 高さへ変換し、無ければ（従来URLやCesium自身のheightのみのURL）は
  // height をそのまま使う
  const height = Number.isFinite(zoom)
    ? zoomToCamHeightView(latitude, zoom, viewer.canvas.clientHeight, Cesium.Math.toDegrees(viewer.camera.frustum.fovy))
    : getNumber("height", DEFAULT_VIEW.height);
  return {
    latitude,
    longitude: getNumber("longitude"),
    height,
    pitch: getNumber("pitch", DEFAULT_VIEW.pitch),
    heading: getNumber("heading", DEFAULT_VIEW.heading),
  };
}

async function resolveInitialCamera() {
  if (Number.isFinite(urlCamera.latitude) && Number.isFinite(urlCamera.longitude)) {
    return urlCamera;
  }
  if (cameraPresets.length) {
    return cameraPresets[0];
  }
  try {
    const response = await fetch("https://ipapi.co/json/");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude, height: 10000, pitch: DEFAULT_VIEW.pitch, heading: 0 };
    }
  } catch (error) {
    console.warn("IP geolocation failed", error);
  }
  return DEFAULT_VIEW;
}

function applyUrlCamera() {
  const camera = parseUrlCamera();
  if (Number.isFinite(camera.latitude) && Number.isFinite(camera.longitude)) {
    flyTo(camera);
  }
}

// AI・外部連携用の操作API。チャットパネルや将来的なエージェント連携から地図を操作する入口
// プラグイン宣言レイヤー: plugins.json の layer 設定またはプラグインからの
// 明示呼び出しで生成し、レイヤ一覧・表示切替・属性検索を本体レイヤーと同じ経路で扱う。
// format:"entities" は CustomDataSource を貸し出し、format:"geojson" は
// setPluginLayerData で渡した GeoJSON を内蔵 geojson レイヤーと同じ描画経路に載せる
async function registerPluginLayer(config = {}, pluginId = "") {
  const format = config.format === "geojson" ? "geojson" : "entities";
  const item = {
    id: `plugin-${pluginId || "anon"}-${pluginLayerSeq++}`,
    title: config.title || pluginId || "Plugin",
    type: format,
    visible: config.visible !== false,
    group: config.group || "",
    scope: config.scope === "project" ? "project" : "app",
    plugin: true,
    pluginId,
    attribution: typeof config.attribution === "string" ? config.attribution : "",
    styleUrl: typeof config.style === "string" && config.style.trim() ? config.style.trim() : null,
    data: normalizeGeoJsonInput(config.data),
    dataSource: null,
  };
  if (format === "entities") {
    const ds = new Cesium.CustomDataSource(item.title);
    await viewer.dataSources.add(ds);
    item.dataSource = ds;
  }
  pluginLayers.push(item);
  layers.push(item);
  layerState.set(item.id, item);
  layerOrder.push(item.id);
  renderLayerList();
  await refreshLayers();
  window.kasugaiApi?.emit("plugin-layer-registered", { id: item.id, pluginId, type: item.type });
  return item;
}

function removePluginLayer(item) {
  if (item.dataSource) { try { viewer.dataSources.remove(item.dataSource, true); } catch (e) {} }
  const pluginIndex = pluginLayers.indexOf(item);
  if (pluginIndex >= 0) pluginLayers.splice(pluginIndex, 1);
  layerState.delete(item.id);
  const orderIndex = layerOrder.indexOf(item.id);
  if (orderIndex >= 0) layerOrder.splice(orderIndex, 1);
  const layerIndex = layers.indexOf(item);
  if (layerIndex >= 0) layers.splice(layerIndex, 1);
  window.kasugaiApi?.emit("plugin-layer-removed", { id: item.id, pluginId: item.pluginId });
}

function findPluginLayer(idOrPluginId) {
  return pluginLayers.find(item => item.id === idOrPluginId || item.pluginId === idOrPluginId) || null;
}

// GeoJSON入力を FeatureCollection に正規化する。
// 単体Feature・裸のジオメトリ・Feature配列・JSON文字列も受け付ける
// (AIがaddDataLayerへFeatureCollection以外を渡しても描画できるようにする。
// .features を持たないソースを通すと描画ループが地物数参照で落ちるため、
// ここで統一する)。変換不能な場合は null
function normalizeGeoJsonInput(input) {
  let data = input;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { return null; } }
  if (!data || typeof data !== "object") return null;
  if (data.type === "FeatureCollection") return Array.isArray(data.features) ? data : null;
  if (data.type === "Feature" || Array.isArray(data)) {
    const features = (Array.isArray(data) ? data : [data]).filter(f => f && f.type === "Feature");
    return features.length ? { type: "FeatureCollection", features } : null;
  }
  if (data.type === "GeometryCollection" || Array.isArray(data.coordinates)) {
    return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: data }] };
  }
  return null;
}

// インラインGeoJSONの一時レイヤー(AIのデータ加工結果の表示用)。
// inspectorテキストには含まれないため .kasc エクスポート対象外で、
// applyInspector 後に dataLayers から再登録されて存続する
async function registerDataLayer(title, geojson) {
  const data = normalizeGeoJsonInput(geojson);
  if (!data) return null;
  const item = {
    id: `data-${++dataLayerSeq}`,
    title: title || `Data ${dataLayerSeq}`,
    type: "geojson",
    visible: true,
    group: "",
    data,
    ephemeral: true,
  };
  dataLayers.push(item);
  layers.push(item);
  layerState.set(item.id, item);
  layerOrder.push(item.id);
  renderLayerList();
  await refreshLayers();
  return item;
}

async function unregisterDataLayer(idOrTitle) {
  const item = dataLayers.find(entry => entry.id === idOrTitle || entry.title === idOrTitle);
  if (!item) return false;
  dataLayers.splice(dataLayers.indexOf(item), 1);
  const orderIndex = layerOrder.indexOf(item.id);
  if (orderIndex >= 0) layerOrder.splice(orderIndex, 1);
  layerState.delete(item.id);
  const layerIndex = layers.indexOf(item);
  if (layerIndex >= 0) layers.splice(layerIndex, 1);
  renderLayerList();
  await refreshLayers();
  return true;
}

// DataSource の entity を GeoJSON FeatureCollection に戻す。
// AI が読み込み済みレイヤーのデータを取得・加工するための出口
function entitiesToGeoJson(ds) {
  const time = viewer.clock && viewer.clock.currentTime;
  const toLngLat = position => {
    const c = Cesium.Cartographic.fromCartesian(position);
    const h = Math.round(c.height * 100) / 100;
    return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude), h];
  };
  const features = [];
  for (const entity of ds.entities.values) {
    let geometry = null;
    try {
      if (entity.polygon?.hierarchy) {
        const hierarchy = entity.polygon.hierarchy.getValue(time);
        const positions = Array.isArray(hierarchy) ? hierarchy : (hierarchy?.positions || []);
        if (positions.length >= 3) {
          const ring = positions.map(toLngLat);
          ring.push([...ring[0]]);
          geometry = { type: "Polygon", coordinates: [ring] };
        }
      }
      if (!geometry && entity.polyline?.positions) {
        const positions = entity.polyline.positions.getValue(time) || [];
        if (positions.length >= 2) geometry = { type: "LineString", coordinates: positions.map(toLngLat) };
      }
      if (!geometry && entity.position) {
        const position = entity.position.getValue(time);
        if (position) geometry = { type: "Point", coordinates: toLngLat(position) };
      }
    } catch (e) { /* ignore */ }
    if (!geometry) continue;
    let properties = {};
    try {
      const bag = entity.properties?.getValue ? entity.properties.getValue(time) : entity.properties;
      if (bag && typeof bag === "object") properties = { ...bag };
    } catch (e) { /* ignore */ }
    if (entity.name && properties.name == null) properties.name = entity.name;
    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

// レイヤ名/IDから GeoJSON を取り出す。インラインデータはそのまま返し、
// 描画時に保持したソース(primitive/entity とも件数上限の切り捨て前フルデータ)を優先し、
// それが無いレイヤーはロード済み DataSource を entity→GeoJSON 変換して返す
function getLayerGeoJson(idOrTitle) {
  const item = getOrderedLayerItems().find(layer => layer.id === idOrTitle || layer.title === idOrTitle);
  if (!item) return null;
  if (item.data && typeof item.data === "object") return item.data;
  if (item.geojsonSource) return item.geojsonSource;
  const entry = vectorDataSources.find(source => source.id === item.id);
  const ds = entry?.ds || item.dataSource || null;
  if (!ds) return null;
  return entitiesToGeoJson(ds);
}

window.kasugaiApi = {
  engine: "cesium",
  flyTo,
  sampleGroundHeight,
  getProjectId() { return currentProjectId; },
  getCamera() {
    const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    if (!carto) return null;
    return {
      latitude: Cesium.Math.toDegrees(carto.latitude),
      longitude: Cesium.Math.toDegrees(carto.longitude),
      height: carto.height,
      heading: Cesium.Math.toDegrees(viewer.camera.heading),
      pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
    };
  },
  listLayers() {
    return getOrderedLayerItems().map(layer => {
      const entry = { id: layer.id, title: layer.title, group: layer.group || "", visible: !!layer.visible, type: layer.type, filter: layer.type === "sql" ? (layer.query || "") : (layer.where || ""), bboxAuto: layer.bboxAuto ?? null, entityLimited: layer.entityLimited || null, viewportSliced: !!layer.viewportSliced };
      const legend = layer.qmlStyle?.legend;
      if (legend?.length > 1) entry.legend = legend.map(e => ({ label: e.label || e.symbolName, visible: !layer.legendHidden?.has(e.symbolName) }));
      return entry;
    });
  },
  // 凡例の条件別シンボルを表示/非表示にする。対象は style=(QML) の分類・段階・
  // ルールレンダラを持つレイヤー。label は凡例ラベルまたはシンボル名
  setLayerLegendVisible(idOrTitle, label, visible) {
    const layer = getOrderedLayerItems().find(item => item.id === idOrTitle || item.title === idOrTitle);
    const legend = layer?.qmlStyle?.legend;
    if (!layer || !legend?.length) return false;
    const key = String(label ?? "").trim();
    const entry = legend.find(e => e.label === key || e.symbolName === key);
    if (!entry?.symbolName) return false;
    setLegendSymbolVisible(layer, entry.symbolName, !!visible);
    return true;
  },
  setLayerVisible(idOrTitle, visible) {
    const layer = getOrderedLayerItems().find(item => item.id === idOrTitle || item.title === idOrTitle);
    if (!layer) return false;
    layer.visible = !!visible;
    if (layer.visible && layer.exclusiveGroup) {
      getOrderedLayerItems().forEach(other => {
        if (other !== layer && other.group === layer.group && other.exclusiveGroup) other.visible = false;
      });
    }
    renderLayerList();
    refreshLayers();
    return true;
  },
  // theme: 行の可視性プリセット一覧/適用（QGIS マップテーマ相当）
  listThemes() {
    return inspectorThemes.map(theme => ({ name: theme.name, layers: [...theme.layers] }));
  },
  applyTheme(name) {
    const theme = inspectorThemes.find(entry => entry.name === name);
    if (!theme) return false;
    applyKascTheme(theme);
    const select = document.querySelector("#theme-select");
    if (select) select.value = theme.name;
    return true;
  },
  async focusLayer(idOrTitle) {
    const layer = getOrderedLayerItems().find(item => item.id === idOrTitle || item.title === idOrTitle);
    if (!layer) return false;
    return focusLayer(layer);
  },
  // クエリ系レイヤー(duckdb/sql/gpkg等)の絞り込み条件を変更する。
  // レイヤー行の ⏷ ボタン（window.prompt ベースで AI から直接操作できない）の API 版
  async setLayerFilter(idOrTitle, filter) {
    const layer = getOrderedLayerItems().find(item => item.id === idOrTitle || item.title === idOrTitle);
    if (!layer) return { ok: false, reason: "notFound" };
    if (layer.type !== "sql" && !isQueryDecoder(vectorDecoders.get(layer.type), layer)) return { ok: false, reason: "unsupported" };
    const ok = await applyLayerQueryFilter(layer, String(filter ?? "").trim());
    return ok ? { ok: true } : { ok: false, reason: "failed" };
  },
  listBasemaps() {
    // 「ベースマップなし」(selectedBasemap=null)と「ベースマップ透明」(globeHidden=true)は
    // basemaps 配列に無い選択肢のため疑似項目として先頭に載せる（AIやコマンドからも選べるように）
    return [
      { id: "none", title: t("basemap.none"), selected: !globeHidden && !selectedBasemap, note: "地表は通常描画・背景地図タイルのみ非表示" },
      { id: "transparent", title: t("basemap.transparent"), selected: globeHidden, note: "地表・大気・背景をすべて透明にし、ドレープ画像だけを残す" },
      ...basemaps.map(basemap => ({ id: basemap.id, title: basemap.title, selected: basemap === selectedBasemap })),
    ];
  },
  setBasemap(idOrTitle) {
    const name = String(idOrTitle ?? "").trim();
    // 疑似項目の解釈: 内部IDと表示名（日本語/英語）の両方を受け付ける
    if (/^(none|なし|ベースマップなし)$/i.test(name) || name === t("basemap.none")) {
      globeHidden = false;
      selectedBasemap = null;
    } else if (/^(transparent|hide|__hide_globe__|透明|ベースマップ透明)$/i.test(name) || name === t("basemap.transparent")) {
      globeHidden = true;
      selectedBasemap = null;
    } else {
      // グループ化タイトル("グループ/名前")は末端名でも一致させる
      const basemap = basemaps.find(item => item.id === name || item.title === name || parseLayerTitle(item.title).title === name);
      if (!basemap) return false;
      globeHidden = false;
      selectedBasemap = basemap;
    }
    const select = document.querySelector("#basemap-select");
    if (select) select.value = globeHidden ? "__hide_globe__" : (selectedBasemap?.id || "");
    applyGlobeVisibility();
    updateMapAttribution();
    refreshLayers();
    return true;
  },
  async searchLocation(query, provider) {
    const fn = searchProviders[provider || document.querySelector("#search-provider")?.value] || searchProviders.gsi;
    const items = await fn(String(query || ""));
    return items.slice(0, 5);
  },
  // Google Places API (New) のテキスト検索。Maps API キーが必要
  async searchPlaces(query) {
    return googlePlacesSearch(query, getMapsWsKey());
  },
  // Google ストリートビューを別タブで開く。存在確認は Street View Static の metadata(無料)で行う。
  // source=outdoor(公式屋外パノラマ)を優先し、無ければ全パノラマにフォールバック。
  // 確認した pano_id を URL に含めて、クリック位置の最寄りパノラマ(屋内・撮影不良等で真っ暗になり得る)への誤着地を防ぐ
  async openStreetView(latitude, longitude) {
    const key = getMapsWsKey();
    if (!key) throw new Error(t("google.needKey"));
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(t("error.invalidUrl"));
    const fetchMeta = async source => {
      const response = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${encodeURIComponent(key)}${source ? `&source=${source}` : ""}`, { mode: "cors" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error_message || t("search.failedStatus", { status: response.status }));
      return data;
    };
    let data = await fetchMeta("outdoor");
    if (data?.status !== "OK") data = await fetchMeta("");
    if (data?.status !== "OK") return { ok: false, status: data?.status || "UNKNOWN" };
    const panoLat = Number(data.location?.lat);
    const panoLng = Number(data.location?.lng);
    const viewpoint = `${Number.isFinite(panoLat) ? panoLat : lat},${Number.isFinite(panoLng) ? panoLng : lng}`;
    const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${viewpoint}${data.pano_id ? `&panoid=${encodeURIComponent(data.pano_id)}` : ""}`;
    window.open(url, "_blank", "noopener");
    return { ok: true, url };
  },
  flyToFeature,
  listCameraPresets() {
    return cameraPresets.map(preset => preset.title);
  },
  flyToPreset(name) {
    const preset = cameraPresets.find(item => item.title === name) || cameraPresets.find(item => item.title.includes(name));
    if (!preset) return false;
    flyTo(preset);
    return true;
  },
  setTerrain(enabled) {
    terrainEnabled = !!enabled;
    const toggle = document.querySelector("#terrain-toggle");
    if (toggle) toggle.checked = terrainEnabled;
    refreshLayers();
    return true;
  },
  setEffect(name, enabled) {
    const selectors = {
      lighting: "#effect-terrain-lighting",
      translucency: "#effect-translucency",
      fog: "#effect-fog",
      atmosphere: "#effect-sky-atmosphere",
      shadows: "#effect-shadows",
      depthTest: "#effect-depth-test",
    };
    const input = document.querySelector(selectors[name]);
    if (!input) return false;
    input.checked = !!enabled;
    updateEffectSettings();
    return true;
  },
  setUnderground({ transparency, dive } = {}) {
    if (Number.isFinite(transparency)) {
      undergroundTransparency = Math.max(0, Math.min(1, transparency));
      const slider = document.querySelector("#underground-transparency");
      if (slider) slider.value = String(undergroundTransparency);
      const label = document.querySelector("#underground-transparency-value");
      if (label) label.textContent = `${Math.round(undergroundTransparency * 100)}%`;
    }
    if (typeof dive === "boolean") {
      undergroundDiveEnabled = dive;
      const toggle = document.querySelector("#underground-dive-toggle");
      if (toggle) toggle.checked = dive;
    }
    updateUndergroundView();
    updateEffectSettings();
    return true;
  },
  setClip(type) {
    if (!uiHooks.applyClip) return false;
    uiHooks.applyClip(type);
    return true;
  },
  listFlyPaths() {
    return flyPaths.map((path, index) => ({ index, title: path.title }));
  },
  // autoplay=true（既定）で読み込み後すぐ自動前進を開始する。
  // false の場合はルート先頭へのカメラ移動のみ（手動でダブルクリック/Wキーで前進開始）
  playFlyPath(nameOrIndex, autoplay = true) {
    const index = Number.isInteger(nameOrIndex) ? nameOrIndex : flyPaths.findIndex(path => path.title === nameOrIndex || path.title.includes(nameOrIndex));
    if (index < 0 || index >= flyPaths.length) return false;
    if (uiHooks.playFlyPathAt) {
      Promise.resolve(uiHooks.playFlyPathAt(index, autoplay)).catch(e => console.error("playFlyPathAt failed:", e));
    }
    return true;
  },
  stopFly() {
    if (uiHooks.setMode) uiHooks.setMode("orbit");
    return true;
  },
  // AIツール用: フライパスの速度・高度・ピッチ・ループ・視点を変更する。
  // name省略時は再生中（なければ選択中）のルートが対象。描画ルートは設定を GeoJSON へ永続化する。
  // settings.agl は地形追従の目標地上高(m)で、内部で高度オフセットへ変換する
  async setFlySettings(nameOrIndex, settings = {}) {
    let index;
    if (Number.isInteger(nameOrIndex)) index = nameOrIndex;
    else if (nameOrIndex !== undefined && nameOrIndex !== null && nameOrIndex !== "") {
      index = flyPaths.findIndex(path => path.title === String(nameOrIndex) || path.title.includes(String(nameOrIndex)));
    } else {
      const sel = Number(document.querySelector("#fly-path-select")?.value);
      index = flyPath ? flyPaths.indexOf(flyPath) : (Number.isInteger(sel) ? sel : -1);
    }
    if (!Number.isInteger(index) || index < 0 || index >= flyPaths.length) return { ok: false };
    const entry = flyPaths[index];
    const agl = Number(settings.agl);
    if (Number.isFinite(agl) && agl >= 0 && uiHooks.applyFlyAgl) await uiHooks.applyFlyAgl(entry, agl);
    if (uiHooks.setFlySettings && !uiHooks.setFlySettings(index, settings)) return { ok: false };
    void Promise.resolve(uiHooks.persistFlySettings?.(entry)).catch(() => {});
    return { ok: true, name: entry.title, speed: entry.speed, height: entry.height, pitch: entry.pitch, loop: entry.loop, view: entry.view };
  },
  // AI が GeoJSON LineString から飛行ルートを作成する。
  // 手描きルートと同じ IndexedDB ストアに保存し ensureDrawnRouteFlyPath 経由で
  // flyPaths に登録するため、リロード後も描画ルートとして復元される
  async addFlyPath(name, geojson, options = {}) {
    const title = String(name || "").trim();
    let parsed = null;
    try { parsed = typeof geojson === "string" ? JSON.parse(geojson) : geojson; } catch (e) { parsed = null; }
    if (!title || !parsed || !extractLineStringCoordinates(parsed).length) return { ok: false };
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
    // 速度未指定ならルート総距離から自動プロファイルを適用する。
    // AI が flyRoute ではなく addFlyPath を直接使った場合でも適切な速度になる
    let speedOpt = num(options.speed);
    if (speedOpt === undefined) {
      speedOpt = flyRouteAutoProfile(flyPathRouteDistance(extractLineStringCoordinates(parsed))).speed;
    }
    // 飛行設定（速度・ピッチ等）を properties.fly として GeoJSON に埋め込み、
    // リロード後の描画ルート復元時も設定が維持されるようにする
    const flySettings = {
      speed: speedOpt,
      height: num(options.height),
      pitch: num(options.pitch),
      step: num(options.step),
      loop: options.loop !== undefined ? !!options.loop : undefined,
      view: options.view !== undefined ? String(options.view) : undefined,
    };
    if (Object.values(flySettings).some(v => v !== undefined)) {
      parsed.properties = { ...(parsed.properties || {}), fly: flySettings };
    }
    const text = JSON.stringify(parsed);
    if (window._routeStoreSet) await window._routeStoreSet(currentProjectId || "default", title, text);
    const prev = flyPaths.findIndex(p => p.title === title);
    if (prev >= 0) flyPaths.splice(prev, 1);
    await ensureDrawnRouteFlyPath();
    if (!flyPaths.some(p => p.title === title)) {
      // routeStore 未初期化時のフォールバック: blob URL の一時登録
      const objectUrl = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
      flyPaths.push({ title, url: objectUrl, speed: 30, height: 0, pitch: -10, loop: false, step: 100, view: "camera" });
    }
    const entry = flyPaths.find(p => p.title === title);
    if (entry) {
      if (num(options.speed) > 0) entry.speed = num(options.speed);
      if (num(options.height) !== undefined) entry.height = num(options.height);
      if (num(options.pitch) !== undefined) entry.pitch = num(options.pitch);
      if (num(options.step) > 0) entry.step = num(options.step);
      if (options.loop !== undefined) entry.loop = !!options.loop;
      if (options.view !== undefined) entry.view = /^(center|chase|follow|3rd|third)$/i.test(String(options.view)) ? "center" : "camera";
    }
    renderFlyPathSelect();
    return { ok: !!entry, name: title };
  },
  // AI flyRoute ツール用: 地点列(A→B・経由地)から飛行ルートを自動生成する。
  // 地名(query)はジオコーディング・地物名(feature)はvectorSearchで座標解決し、
  // 区間を直線補間した上で地形標高をサンプリングして各点に MSL 高度を焼き込む
  // （山岳部で地形に埋まらないようにするため。サンプリング失敗時は Terrain 基準にフォールバック）
  async flyRoute(waypoints, options = {}) {
    const list = Array.isArray(waypoints) ? waypoints : [];
    if (list.length < 2) return { ok: false, reason: "tooFewWaypoints" };
    // 先頭の参照点は現在のカメラ位置、以降は直前の経由地。同名の遠方地点への誤ヒットを減らす
    const camCarto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    let refPoint = camCarto ? { latitude: Cesium.Math.toDegrees(camCarto.latitude), longitude: Cesium.Math.toDegrees(camCarto.longitude) } : null;
    const resolved = [];
    for (const wp of list) {
      const point = await resolveFlyRouteWaypoint(wp, options.provider, refPoint);
      resolved.push(point);
      if (point) refPoint = point;
    }
    const failIndex = resolved.findIndex(p => !p);
    if (failIndex >= 0) {
      const wp = list[failIndex] || {};
      return { ok: false, reason: "waypointFailed", index: failIndex, query: String(wp.query || wp.feature || wp.name || failIndex + 1) };
    }
    // 総距離から既定の地上高・速度を決める（短距離=低空低速、長距離=高空高速）。
    // options.agl / options.speed の明示指定があればそちらを優先する
    const totalDistance = flyPathRouteDistance(resolved.map(r => [r.longitude, r.latitude]));
    const autoProfile = flyRouteAutoProfile(totalDistance);
    const defaultAgl = Number.isFinite(Number(options.agl)) ? Number(options.agl) : autoProfile.agl;
    const speed = Number.isFinite(Number(options.speed)) ? Number(options.speed) : autoProfile.speed;
    for (const point of resolved) if (!Number.isFinite(point.agl)) point.agl = defaultAgl;
    let spacing = Number.isFinite(Number(options.spacing)) && Number(options.spacing) > 0 ? Number(options.spacing) : 200;
    let dense = densifyFlyRoutePoints(resolved, spacing);
    if (dense.length > 800) {
      spacing = spacing * dense.length / 800;
      dense = densifyFlyRoutePoints(resolved, spacing);
    }
    const terrain = await sampleRouteTerrain(dense, totalDistance);
    // 欠損点は両隣の有効値を線形補間して埋める（隣接値コピーだと高度が階段状に変化するため）。
    // 先頭の欠損は最寄りの有効値、末尾の欠損も同様にする
    {
      const validIdx = [];
      for (let i = 0; i < terrain.length; i++) if (Number.isFinite(terrain[i])) validIdx.push(i);
      for (let k = 0; k + 1 < validIdx.length; k++) {
        const a = validIdx[k];
        const b = validIdx[k + 1];
        for (let i = a + 1; i < b; i++) {
          terrain[i] = terrain[a] + (terrain[b] - terrain[a]) * (i - a) / (b - a);
        }
      }
      if (validIdx.length) {
        for (let i = 0; i < validIdx[0]; i++) terrain[i] = terrain[validIdx[0]];
        for (let i = validIdx[validIdx.length - 1] + 1; i < terrain.length; i++) terrain[i] = terrain[validIdx[validIdx.length - 1]];
      }
    }
    const msl = terrain.some(h => Number.isFinite(h));
    const coordinates = dense.map((p, i) => {
      const alt = msl ? (Number.isFinite(terrain[i]) ? terrain[i] : 0) + p.agl : p.agl;
      return [Number(p.longitude.toFixed(6)), Number(p.latitude.toFixed(6)), Math.round(alt * 10) / 10];
    });
    const title = String(options.name || "").trim() || `${resolved[0].label}→${resolved[resolved.length - 1].label}`;
    const geojson = {
      type: "Feature",
      properties: {
        heightReference: msl ? "MSL" : "Terrain",
        heightOffset: 0,
        source: "flyRoute",
        agl: defaultAgl,
        waypoints: resolved.map(r => ({ label: r.label, latitude: r.latitude, longitude: r.longitude })),
      },
      geometry: { type: "LineString", coordinates },
    };
    const added = await window.kasugaiApi.addFlyPath(title, geojson, {
      speed,
      height: options.height,
      pitch: Number.isFinite(Number(options.pitch)) ? Number(options.pitch) : -10,
      loop: options.loop,
      view: options.view,
    });
    if (!added?.ok) return { ok: false, reason: "addFailed" };
    if (options.autoplay !== false) window.kasugaiApi.playFlyPath(added.name);
    return {
      ok: true,
      name: added.name,
      distance: Math.round(totalDistance),
      points: coordinates.length,
      terrainSampled: msl,
      agl: defaultAgl,
      speed,
      waypoints: resolved.map(r => ({ label: r.label, latitude: r.latitude, longitude: r.longitude })),
    };
  },
  listProjects() {
    const select = document.querySelector("#project-select");
    if (!select) return [];
    return [...select.options].map(option => ({ id: option.value, title: option.textContent, selected: option.value === currentProjectId }));
  },
  switchProject(projectId) {
    const select = document.querySelector("#project-select");
    if (!select) return false;
    const exists = [...select.options].some(option => option.value === projectId);
    if (!exists) return false;
    select.value = projectId;
    select.dispatchEvent(new Event("change"));
    return true;
  },
  applyInspector(text) {
    const input = document.querySelector("#inspector-input");
    if (!input || typeof text !== "string") return false;
    input.value = text;
    document.querySelector("#apply-inspector")?.click();
    return true;
  },
  exportInspector() {
    const button = document.querySelector("#export-inspector");
    if (!button) return false;
    button.click();
    return true;
  },
  checkUpdate() {
    document.querySelector("#check-update")?.click();
    return true;
  },
  installUpdate() {
    const button = document.querySelector("#install-update");
    if (!button || button.hidden) return false;
    button.click();
    return true;
  },
  shutdownApp() {
    const button = document.querySelector("#shutdown-app");
    if (!button) return false;
    button.click();
    return true;
  },
  toggleDrawMode() {
    const button = document.querySelector("#draw-mode-toggle");
    if (!button) return { ok: false };
    button.click();
    return { ok: true, drawModeActive };
  },
  vectorSearch(query) {
    if (!vectorSearchData || !query) return [];
    const q = String(query).toLowerCase();
    const results = [];
    const source = vectorSearchData.all;
    if (!source) return results;
    for (const attr of source.attributes || []) {
      for (const val of source.valuesByAttr[attr] || []) {
        if (!(String(val) + " " + String(attr)).toLowerCase().includes(q)) continue;
        const pos = source.featureByAttr?.[attr]?.[val] || null;
        results.push({ attr, value: val, latitude: pos?.lat ?? null, longitude: pos?.lng ?? null, layerId: pos?.layerId ?? null });
        if (results.length >= 20) return results;
      }
    }
    return results;
  },
  getShareUrl() {
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    if (!c) return null;
    const lon = Number(c.longitude * 180 / Math.PI).toFixed(6);
    const lat = Number(c.latitude * 180 / Math.PI).toFixed(6);
    const pitch = Number(viewer.camera.pitch * 180 / Math.PI).toFixed(2);
    const heading = Number(viewer.camera.heading * 180 / Math.PI).toFixed(2);
    const height = Number(c.height).toFixed(1);
    const zoom = camToZoomView({ latitude: Number(lat), height: Number(height) }, viewer.canvas.clientHeight, Cesium.Math.toDegrees(viewer.camera.frustum.fovy)).toFixed(3);
    return `${window.location.origin}${window.location.pathname}?longitude=${lon}&latitude=${lat}&height=${height}&zoom=${zoom}&pitch=${pitch}&heading=${heading}&${projectQueryParam()}`;
  },
  // 任意の座標・視点の共有URLを組み立てる。省略した引数は現在視点を使う。
  // 資料の各節に視点別パーマリンクを埋め込む用途向け
  buildShareUrl({ latitude, longitude, height, pitch, heading, project } = {}) {
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    const current = c ? {
      longitude: c.longitude * 180 / Math.PI,
      latitude: c.latitude * 180 / Math.PI,
      height: c.height,
      pitch: viewer.camera.pitch * 180 / Math.PI,
      heading: viewer.camera.heading * 180 / Math.PI,
    } : {};
    const pick = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    const lon = pick(longitude, current.longitude);
    const lat = pick(latitude, current.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const params = new URLSearchParams();
    params.set("longitude", lon.toFixed(6));
    params.set("latitude", lat.toFixed(6));
    const h = pick(height, current.height);
    const p = pick(pitch, current.pitch);
    const hd = pick(heading, current.heading);
    if (Number.isFinite(h)) {
      params.set("height", h.toFixed(1));
      params.set("zoom", camToZoomView({ latitude: lat, height: h }, viewer.canvas.clientHeight, Cesium.Math.toDegrees(viewer.camera.frustum.fovy)).toFixed(3));
    }
    if (Number.isFinite(p)) params.set("pitch", p.toFixed(2));
    if (Number.isFinite(hd)) params.set("heading", hd.toFixed(2));
    if (typeof project === "string" && project) params.set("project", project);
    else if (currentKascUrl) params.set("kasc", currentKascUrl);
    else params.set("project", currentProjectId);
    return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  },
  // エージェント生成の資料（Markdown/HTML）をモーダル表示する
  showReport(args = {}) {
    showReportModal(args);
    return { ok: true };
  },
  // ベクター系レイヤーを .kasc 行として末尾へ追記し即時適用する。
  // type: geojson/layer/geoparquet/flatgeobuf/gpkg/duckdb(target は URL) / sql(target は SELECT 文)
  addLayer(title, target, { type = "geojson", options = "" } = {}) {
    const input = document.querySelector("#inspector-input");
    const urlTypes = new Set(["geojson", "layer", "geoparquet", "flatgeobuf", "gpkg", "geopackage", "duckdb"]);
    const clean = value => String(value || "").replace(/[\r\n]+/g, " ").trim();
    title = clean(title); target = clean(target); options = clean(options);
    if (!title || !target || !input) return false;
    if (!urlTypes.has(type) && type !== "sql") return false;
    // URL系は「タイトル|URL|出典|オプション」の形式のため、options 指定時は
    // 出典スロットを空で埋める(出典は options 側の attr= で指定できる)
    const line = `${type}:${title}|${target}${urlTypes.has(type) && options ? "|" : ""}${options ? `|${options}` : ""}`;
    input.value = input.value.replace(/\s*$/, "") + `\n${line}\n`;
    document.querySelector("#apply-inspector")?.click();
    return true;
  },
  addGeoJsonLayer(title, url) {
    // サンドボックスブリッジはメソッドを detach して呼ぶため this は使わない
    return window.kasugaiApi.addLayer(title, url);
  },
  getGoogleApiKey() {
    try { return localStorage.getItem("googleApiKey") || ""; } catch (e) { return ""; }
  },
  getGoogleMapsApiKey() {
    try { return localStorage.getItem("googleMapsApiKey") || ""; } catch (e) { return ""; }
  },
  // Web サービス API 用キー（googleMapsWsApiKey 優先・無ければ Maps キー）
  getGoogleMapsWsApiKey() {
    return getMapsWsKey();
  },
  getGeminiModel() {
    try { return localStorage.getItem("googleGeminiModel") || "gemini-3.1-flash-lite"; } catch (e) { return "gemini-3.1-flash-lite"; }
  },
  getViewer() { return viewer; },
  getCesium() { return Cesium; },
  _plugins: [],
  _events: {},
  isReady: false,
  on(event, handler) {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(handler);
    if (event === "ready" && this.isReady) { try { handler(this); } catch (e) { console.error(e); } }
  },
  off(event, handler) {
    if (!this._events[event]) return;
    const idx = this._events[event].indexOf(handler);
    if (idx >= 0) this._events[event].splice(idx, 1);
  },
  emit(event, payload) {
    (this._events[event] || []).slice().forEach(h => { try { h(payload); } catch (e) { console.error(e); } });
  },
  registerPlugin(meta) {
    this._plugins.push(meta);
    this.emit("plugin-registered", meta);
    console.log("[kasugaiApi] プラグイン登録:", meta.id || meta.name);
  },
  // プラグインの登録解除。meta.dispose() があれば呼び出してリソース/イベントを解放する
  unregisterPlugin(id) {
    for (let i = this._plugins.length - 1; i >= 0; i--) {
      const meta = this._plugins[i];
      if (!meta || meta.id !== id) continue;
      this._plugins.splice(i, 1);
      try { meta.dispose?.(); } catch (e) { console.error(e); }
    }
    this.emit("plugin-unregistered", { id });
  },
  getPlugins() { return this._plugins; },
  // インスペクタの plugin: 行で宣言されたプラグイン仕様（plugin-loader が読む）
  getInspectorPlugins() {
    return inspectorPluginSpecs.map(spec => ({ ...spec, options: { ...spec.options } }));
  },
  async registerPluginLayer(config, pluginId) {
    return await registerPluginLayer(config, pluginId);
  },
  getPluginDataSource(idOrPluginId) {
    const item = findPluginLayer(idOrPluginId);
    return item ? item.dataSource : null;
  },
  async setPluginLayerData(idOrPluginId, geojson) {
    const item = findPluginLayer(idOrPluginId);
    const data = normalizeGeoJsonInput(geojson);
    if (!item || item.type !== "geojson" || !data) return false;
    item.data = data;
    await refreshLayers();
    return true;
  },
  async removePluginLayer(idOrPluginId) {
    const item = findPluginLayer(idOrPluginId);
    if (!item) return false;
    removePluginLayer(item);
    renderLayerList();
    await refreshLayers();
    return true;
  },
  // 外部URLからテキスト/JSON/CSV等を取得する。
  // ローカルサーバー版では /api/fetch プロキシ経由（CORS不要）・それ以外は直接fetch（CORS前提）
  async fetchData(url, { maxChars = 400000 } = {}) {
    const target = String(url || "");
    if (!/^https?:\/\//i.test(target)) throw new Error(t("error.invalidUrl"));
    const useProxy = hasBackendFeature("fetchProxy") && isFetchProxyTarget(target);
    const response = await fetch(useProxy ? `/api/fetch?url=${encodeURIComponent(target)}` : target, useProxy ? {} : { mode: "cors" });
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    return { status: response.status, contentType, truncated: text.length > maxChars, text: text.slice(0, maxChars) };
  },
  // 読み込み済みレイヤーの地物を GeoJSON で返す（データ加工の入力用）
  getLayerGeoJson(idOrTitle) {
    return getLayerGeoJson(idOrTitle);
  },
  // GeoJSONオブジェクトを一時レイヤーとして直接表示する
  async addDataLayer(title, geojson) {
    const item = await registerDataLayer(title, geojson);
    return item ? { id: item.id, title: item.title } : null;
  },
  async removeDataLayer(idOrTitle) {
    return await unregisterDataLayer(idOrTitle);
  },
  // ---- DATA/ ファイル（ローカルサーバー版のみ・fileWrite 能力）----
  // DATA/ 内のファイル一覧を {name,size,modified}[] で返す
  async listDataFiles() {
    if (!hasBackendFeature("fileWrite")) return [];
    const project = currentProjectId || "default";
    const response = await fetch(`/api/files?project=${encodeURIComponent(project)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    const data = await response.json().catch(() => ({}));
    return Array.isArray(data?.files) ? data.files : [];
  },
  // content: string / Blob / ArrayBuffer を DATA/<name> へ書き込む（サブフォルダ可）
  async saveDataFile(name, content) {
    if (!hasBackendFeature("fileWrite")) return { ok: false, error: "fileWrite はローカルサーバー版のみで利用できます" };
    const project = currentProjectId || "default";
    const rel = String(name || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
    if (!rel) return { ok: false, error: "name is required" };
    const response = await fetch(`/api/files/${encodeURIComponent(project)}/${rel}`, { method: "PUT", body: content });
    if (!response.ok) return { ok: false, error: await response.text() || `HTTP ${response.status}` };
    return { ok: true, name };
  },
  async deleteDataFile(name) {
    if (!hasBackendFeature("fileWrite")) return { ok: false, error: "fileWrite はローカルサーバー版のみで利用できます" };
    const project = currentProjectId || "default";
    const rel = String(name || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
    if (!rel) return { ok: false, error: "name is required" };
    const response = await fetch(`/api/files/${encodeURIComponent(project)}/${rel}`, { method: "DELETE" });
    if (!response.ok) return { ok: false, error: await response.text() || `HTTP ${response.status}` };
    return { ok: true, name };
  },
  // ---- MCP サーバー（Box 等・データソース接続基盤）----
  // E2E 検証・プラグインからも操作できるよう公開面に置く
  mcp: {
    listServers: () => listMcpServers(),
    upsertServer: entry => upsertMcpServer(entry),
    removeServer: key => removeMcpServer(key),
    connect: key => connectMcpServer(key),
    disconnect: key => disconnectMcpServer(key),
    runtime: key => mcpRuntime(key),
    declarations: () => mcpDeclarations(),
    call: (key, tool, args) => callMcpTool(key, tool, args),
  },
  // チャットツールを直接実行する（E2E 検証用）
  async executeChatTool(name, args = {}) {
    return await executeChatTool(name, args);
  },
  // ---- ストレージプラグイン（IndexedDB・ブラウザローカル）----
  async listStoragePlugins() {
    return (await pluginStore.list()).map(({ code, ...meta }) => meta);
  },
  async getStoragePlugin(id) {
    return await pluginStore.get(id);
  },
  async saveStoragePlugin(record) {
    if (!record || typeof record.id !== "string" || !record.id.trim()) return { ok: false, error: "id is required" };
    if (typeof record.code !== "string" || !record.code.trim()) return { ok: false, error: "code is required" };
    const id = record.id.trim();
    const prev = await pluginStore.get(id);
    const next = {
      id,
      name: String(record.name || prev?.name || id),
      version: String(record.version || prev?.version || "0.1.0"),
      description: String(record.description ?? prev?.description ?? ""),
      layer: record.layer !== undefined ? record.layer : (prev?.layer ?? null),
      code: record.code,
      enabled: record.enabled !== undefined ? !!record.enabled : (prev?.enabled ?? true),
      updatedAt: Date.now(),
      lastError: "",
    };
    try {
      await pluginStore.put(next);
    } catch (error) {
      return { ok: false, error: String(error && error.message || error) };
    }
    // 有効なら即時（再）読み込み。失敗理由は lastError に保存され呼び出し側にも返る
    let loadResult = { ok: true, skipped: true };
    if (next.enabled && window.kasugaiPluginLoader?.load) {
      loadResult = await window.kasugaiPluginLoader.load(id);
    }
    this.emit("storage-plugins-changed", {});
    return { ok: true, id, loaded: !!loadResult.ok && !loadResult.skipped, loadError: loadResult.error || null };
  },
  async removeStoragePlugin(id) {
    const record = await pluginStore.get(id);
    if (!record) return false;
    try { await window.kasugaiPluginLoader?.unload(id); } catch (e) { /* ignore */ }
    await pluginStore.remove(id);
    this.emit("storage-plugins-changed", {});
    return true;
  },
  async setStoragePluginEnabled(id, enabled) {
    const record = await pluginStore.get(id);
    if (!record) return false;
    record.enabled = !!enabled;
    record.updatedAt = Date.now();
    await pluginStore.put(record);
    if (enabled) {
      await window.kasugaiPluginLoader?.load(id);
    } else {
      await window.kasugaiPluginLoader?.unload(id);
    }
    this.emit("storage-plugins-changed", {});
    return true;
  },
  async setStoragePluginError(id, message) {
    await pluginStore.setError(id, message);
    this.emit("storage-plugins-changed", {});
  },
  // ---- 汎用 UI ブリッジ（上部の UI_* / uiBridge* ヘルパー参照）----
  // アプリ内の操作要素を列挙する。filter は target/label の部分一致
  listUiControls: sharedListUiControls,
  // 任意の UI 要素を click/set/get で操作する。set は実ユーザー操作と同じく
  // input→change イベントを発火させるため、設定保存・再描画も通常通り走る
  controlUi: sharedControlUi,
  getCapabilities() {
    // バックエンドの能力情報。静的配信のみの環境では null
    return backendCapabilities ? { ...backendCapabilities } : null;
  },
  // IndexedDBのストレージプラグインを配布用 PLUGIN/ へ昇格させる（ローカルサーバー版のみ）
  async publishStoragePlugin(id) {
    if (!hasBackendFeature("pluginWrite")) {
      return { error: "pluginWrite はローカルサーバー版のみで利用できます" };
    }
    const record = await pluginStore.get(id);
    if (!record) return { error: `plugin '${id}' not found` };
    try {
      const response = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: record.id,
          name: record.name,
          version: record.version,
          description: record.description,
          layer: record.layer,
          code: record.code,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) return { error: data.error || `publish failed (${response.status})` };
      return { ok: true };
    } catch (error) {
      return { error: String(error && error.message || error) };
    }
  },
  getAuth() { return window.kasugaiAuth || null; },
};

window.addEventListener("popstate", applyUrlCamera);
window.addEventListener("hashchange", applyUrlCamera);

window.addEventListener("pagehide", () => {
  try {
    sessionStorage.setItem("lastCameraSearch", window.location.search + window.location.hash);
  } catch (e) {}
});

(async () => {
  await detectBackend();
  setBackendCapabilities(backendCapabilities, backendCapabilitiesResolved);
  // MCP 接続基盤の初期化。capabilities 確定後に行い、mcpProxy の有無で
  // 直叩き→プロキシのフォールバック可否を決める。Box の OAuth 戻りがあればここで処理し、
  // 有効な MCP サーバーへはバックグラウンドで接続する（ツール一覧を activeChatTools へ合成）
  initMcp({ hasProxy: () => hasBackendFeature("mcpProxy") });
  initBoxAuth();
  try {
    const boxResult = await handleBoxRedirect();
    if (boxResult === "done") console.log("[mcp] Box OAuth 接続が完了しました");
  } catch (e) { console.error(e); }
  void connectEnabledMcpServers();
  updateAppPanelVisibility();
  // capabilities 確定後に Copilot/Devin 選択肢の可否を再評価する（アプリ版のみ表示）
  updateBridgeProviderOptions();
  resyncProviderSelect();
  // capabilities 取得後に既定エージェントエンドポイントを反映するため再評価する
  updateChatPanelVisibility();
  try { await loadProjects(); } catch (e) { console.error(e); }
  try { switchRestore = consumeEngineSwitchState(); } catch (e) {}
  // ?kasc=local / localfs:// — File System Access API でローカルフォルダを直読みする
  // （shared/kasc.js のプレイヤー系と同じ入口。fetch シムで DATA/ 等の相対参照も通す）
  try {
    const kascParam = urlParams.get("kasc");
    if (kascParam && (kascParam === "local" || kascParam === "localfs" || /^localfs:/i.test(kascParam))) {
      const lf = await import("../shared/localfs.js");
      if (kascParam === "local" || kascParam === "localfs") {
        currentKascUrl = await lf.openLocalKascUrl();
      } else {
        await lf.pickProjectDir();
        lf.installFetchShim();
        currentKascUrl = kascParam;
      }
      if (currentKascUrl) {
        currentProjectId = decodeURIComponent(new URL(currentKascUrl).pathname.split("/").pop() || "")
          .replace(/\.kasc$/i, "") || "kasc";
      }
    }
  } catch (e) { console.error("localfs の初期化に失敗:", e); }
  try { await loadInspectorConfig(); } catch (e) { console.error(e); }
  // 他エンジンからの切替時、同一プロジェクトなら引き継がれたレイヤ状態
  // (各レイヤの可視性・テーマ選択)を適用する。インスペクタ差分は
  // loadInspectorConfig の初期テキストへ反映済み
  try {
    const st = switchRestore;
    switchRestore = null;
    if (st) {
      if (Array.isArray(st.vis)) {
        const items = getOrderedLayerItems();
        const leafOf = t => String(t).split("/").map(s => s.trim()).pop();
        const exact = new Map(items.map(i => [i.title, i]));
        const byFull = new Map(), byLeaf = new Map();
        for (const i of items) {
          byFull.set(i.sourceTitle || (i.group ? `${i.group}/${i.title}` : i.title), i);
          const k = leafOf(i.title);
          byLeaf.set(k, byLeaf.has(k) ? null : i);
        }
        let changed = false;
        for (const { t: title, v } of st.vis) {
          const item = exact.get(title) || byFull.get(title) || byLeaf.get(leafOf(title));
          if (!item || !!item.visible === !!v) continue;
          item.visible = !!v;
          if (item.visible && item.exclusiveGroup) {
            for (const other of items) {
              if (other !== item && other.group === item.group && other.exclusiveGroup) other.visible = false;
            }
          }
          changed = true;
        }
        if (changed) { renderLayerList(); refreshLayers(); }
      }
      const sel = document.querySelector("#theme-select");
      if (st.theme && sel && [...sel.options].some(o => o.value === st.theme)) sel.value = st.theme;
    }
  } catch (e) { console.error(e); }
  try { await ensureDrawnRouteFlyPath(); } catch (e) { console.error(e); }
  try { await loadUpdateInfo(); } catch (e) { console.error(e); }
  // リモートコマンド経路(local ティアのみ): 外部プロセスが /api/command に POST した
  // コマンドをロングポーリングで受信し、チャットツールと同じ経路(executeChatTool)で実行する。
  // 実行結果は /api/command/results へ返す。破壊的操作はチャット同様確認ダイアログが出る
  startRemoteCommandLoop();
  const initialCamera = await resolveInitialCamera();
  // 前回のカメラ位置は起動直後に即セット済み。URLの座標が変わっていればそこからFLYTOする
  if (hasLastCamera && lastCameraSearch !== initialCameraSource) {
    if (initialCamera) flyTo(initialCamera);      // 前回の位置から新しいURLへGoogle Earth風にFLYTO
  } else {
    if (initialCamera) flyTo(initialCamera, 0);   // 履歴がない or 同じURL
  }
  renderPresets();
  window.kasugaiApi.isReady = true;
  window.kasugaiApi.emit("ready");
})();

// ?follow[=<base>] → geo_webview の /present/state をポーリングして QGIS キャンバスに追従
// （プレイヤー系エンジンと同じ入口。QGIS の2Dキャンバス状態を俯瞰カメラへ反映する）
{
  const followParams = new URLSearchParams(location.search);
  if (followParams.has("follow") || followParams.has("present")) {
    const base = followParams.get("follow") || followParams.get("present") || "";
    const followTick = async () => {
      try {
        const s = await (await fetch(`${base}/present/state`)).json();
        if (typeof s.lon !== "number" || typeof s.lat !== "number") return;
        const height = typeof s.zoom === "number"
          ? zoomToCamHeightView(s.lat, s.zoom, viewer.canvas.clientHeight, Cesium.Math.toDegrees(viewer.camera.frustum.fovy))
          : Cesium.Cartographic.fromCartesian(viewer.camera.position)?.height;
        if (!Number.isFinite(height)) return;
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, height),
          orientation: {
            heading: Cesium.Math.toRadians(-(s.rotation || 0)),
            pitch: -Cesium.Math.PI_OVER_TWO,
            roll: 0,
          },
        });
        requestRender();
      } catch (_) { /* 接続不可時は前回状態を維持 */ }
    };
    setInterval(followTick, 1500);
    void followTick();
  }
}
