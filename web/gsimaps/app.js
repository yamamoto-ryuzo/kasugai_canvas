// KASUGAI Canvas — GSI Maps フロント（中間エンジン）
// vendored 地理院地図(gsi-cyberjapan/gsimaps, web/vendor/gsimaps/)を同一オリジン
// iframe として組み込み、.kasc プロジェクトを GSI/Leaflet API 経由で再生する。
// 上流コードは無改変で、制御・変換はすべてこの中間層が担う。
//
// .kasc → gsimaps の対応:
//   ベクター系(geojson/gpkg/fgb/parquet/csv/tsv/duckdb/sql) → GeoJSON へ変換し
//     作図リスト(SakuzuListItem)として注入。スタイルは `_`-props へ畳み込み
//   base:/xyz:/wms:/wmts: → 外部タイル(appendOutSideTile)。地理院タイルの
//     ベースは gsimaps 標準ベースマップ(base=)へマップ
//   cam: → #z/lat/lon と setView。theme: → 可視性プリセット
//   非対応(3dtiles 等) → 情報タブへ警告
import {
  loadKascProject, parseKasc, resolveKascUrl, camToZoom, zoomToCamHeight,
  parseUrlView, hasUrlView, writeUrlView, geojsonExtent, splitKascTitle,
  fillThemeSelect, themeShowSet, kascTitleInTheme, rewriteKascVisibility,
  applyPanelTitle, loadKascBookmarks, downloadKascCamLines, downloadQgisBookmarksXml,
  layerAttribution, sanitizeAttributionFragment,
  resolveDefaultPointStyle, resolveDefaultLineStyle, resolveDefaultPolygonStyle,
  defaultPointRadius, buildWmsTileTemplate, buildWmtsTileTemplate,
} from "../shared/kasc.js";
import { loadVectorItem, isViewportQueryItem } from "../shared/vector-load.js";
import { qmlLegendSwatchDataUrl, defaultVectorLegendSpec } from "../shared/qml-2d.js";
import { createAttrWidget, attrEntriesFromProps, renderAttrContent } from "../shared/attr-widget.js";
import { createPlayerApi } from "../shared/player-api.js";
import { mountEngineSwitcher, consumeEngineSwitchState } from "../shared/engine-switch.js";
import { initAiChat } from "../shared/ai-chat.js";

// 診断: この中間エンジンが iframe 内で読み込まれた場合(ネスト)、
// パネルに赤枠+バッジを付けて二重表示の切り分けに使う
if (window.parent !== window) {
  addEventListener("DOMContentLoaded", () => {
    const p = document.getElementById("panel");
    if (p) { p.style.outline = "4px solid #e33"; p.dataset.nested = "1"; }
  });
}

const GSI_VENDOR_URL = "../vendor/gsimaps/index_pm.html";

// ガード: iframe が何らかの経路で gsimaps 以外(自ページ含む)を読んだら
// vendor URL へ戻す。load イベントで即検査して誤表示自体を見せない
let lastVendorSrc = "";
let lastFrameDoc = null;   // 最後に確認した iframe ドキュメント
let booted = false;        // 初回ブート完了後は予期しない再読込を検出する
let rebooting = false;
let lastDocCtx = null;     // 再構築用 {doc, baseUrl}
function guardFrameDoc() {
  try {
    const loc = frame.contentWindow?.location;
    if (!loc || loc.href === "about:blank") return;
    const path = loc.pathname;
    if (GSI_GLOBE_RE.test(path)) {
      // Globe 表示中(上流ページのまま)。2D復帰までは gsimaps 参照を張り直さず、
      // iframe ハッシュの視点だけ親URLへミラーする
      if (!globeMode) { globeMode = true; showGlobeBack(true); }
      lastFrameDoc = frame.contentDocument;
      frame.style.visibility = "visible";
      mirrorGlobeView();
      maybeInjectGlobeLayers();
      return;
    }
    if (!path.endsWith("/vendor/gsimaps/index_pm.html")) {
      if (frame.src) {
        console.warn("[gsimaps] iframe が想定外のページを読込 → vendor へ戻す:", loc.href);
        frame.style.visibility = "hidden";
        frame.src = lastVendorSrc || frame.src;
      }
      return;
    }
    if (globeMode) { globeMode = false; showGlobeBack(false); }
    frame.style.visibility = "visible";
    // 予期しない iframe 再読込では GSI 参照が死ぬため再ブートする
    if (booted && frame.contentDocument !== lastFrameDoc) {
      lastFrameDoc = frame.contentDocument;
      void reboot();
      return;
    }
    lastFrameDoc = frame.contentDocument;
  } catch (_) { /* cross-origin 時は触れない(発生しない想定) */ }
}
// iframe が再読込された時の再初期化: waitGsimaps→参照再取得→現プロジェクト再構築
async function reboot() {
  if (rebooting) return;
  rebooting = true;
  try {
    gmap = null; sakuzu = null; gsiApp = null;
    await waitGsimaps();
    wireMapEvents();
    // 再読込は frame.src の初期ハッシュで起き直るため、親が記録している
    // 現在視点をレイヤ再構築より先に復元する(「一度移動して戻る」対策)
    const v = parseUrlView();
    if (hasUrlView(v) && gmap) {
      gmap.setView([v.latitude, v.longitude], Number.isFinite(v.zoom) ? v.zoom : gmap.getZoom());
    }
    if (lastDocCtx) await buildFromDoc(lastDocCtx);
  } catch (e) { console.error(e); }
  finally { rebooting = false; }
}
// (登録は frame 宣言後)
// layers0.txt のベースマップID。地理院タイルURLの /xyz/<id>/ をキーに、
// gsimaps の base= id へマップする。それ以外は外部タイル扱い
const GSI_BASE_ID_BY_TILE = {
  std: "std", pale: "pale", blank: "blank", english: "english",
  ort: "ort", seamlessphoto: "ort", // ort の実体URLは seamlessphoto
};
const VECTOR_TYPES = new Set([
  "geojson", "layer", "flatgeobuf", "fgb", "geoparquet", "parquet",
  "gpkg", "geopackage", "csv", "tsv", "duckdb", "sql",
]);
const TILE_TYPES = new Set(["xyz", "tile", "wms", "wmts"]);
const DEFAULT_CENTER = { lat: 36.104611, lng: 140.084556 };
const DEFAULT_ZOOM = 5;

const frame = document.getElementById("gsi-frame");
frame.addEventListener("load", guardFrameDoc);
setInterval(guardFrameDoc, 2000);
const inspectorInput = document.getElementById("inspector-input");
const themeSelect = document.getElementById("theme-select");
const projectSelect = document.getElementById("project-select");

let G = null;            // iframe 内の GSI 名前空間
let gmap = null;         // iframe 内の Leaflet map
let sakuzu = null;       // gsimaps 作図リスト
let gsiApp = null;       // gsimaps インスタンス（_baseLayer は遅延生成のため都度参照）
const gsiBase = () => gsiApp?._mainMap?._baseLayer;
let currentProjectId = null;
let lastBaseUrl = null;
let layerEntries = [];   // {item, sakuzu, cb, pending, failed, _siblings}
let baseEntries = [];    // {item, gsiId|null, tileLayer|null}
let baseHidden = false;
let currentCams = [];
let currentThemes = [];
let currentUnsupported = [];
let currentDefaultStyles = {};
let currentManifest = [];

// ---- gsimaps 内部APIへの薄いアクセス ----
function gsiBaseIdFromUrl(url) {
  const m = /(?:maps\.gsi\.go\.jp|cyberjapandata\.gsi\.go\.jp)\/xyz\/([a-z0-9_]+)\//i.exec(String(url || ""));
  return m ? (GSI_BASE_ID_BY_TILE[m[1]] || null) : null;
}

// iframe 側の gsimaps 初期化完了を待つ。vendor 未配置時はタイムアウトで案内。
// 注意: gsimaps は layersJSON 読込→レイヤツリー構築(ls= 適用)完了時に
// "initialized" を発火する。それより前に外部タイルを登録すると初期化で
// tileList が作り直され消されるため、必ず initialized 後に注入する
function waitGsimaps(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      document.getElementById("gsi-missing").hidden = false;
      reject(new Error("地理院地図の初期化がタイムアウトしました"));
    }, timeoutMs);
    const done = gm => {
      clearTimeout(timer);
      const w = frame.contentWindow;
      G = w.GSI;
      gsiApp = gm;
      gmap = gm._mainMap.getMap();
      sakuzu = gm._sakuzuList;
      // gsimaps の L.Hash を無効化: iframe 側が location.hash を書き込むと
      // 親の replaceState と joint session history で競合し iframe が親URLを
      // 拾う/外部ハッシュ変化で視点が引き戻される問題が起きるため、hash 連携は
      // 親側の管理に一元化する。ベンダー側の表示機能には影響しない
      const h = gm._hash;
      if (h) {
        try { h.removeFrom?.(gmap); } catch (_) {}
        try { if (h._interval) clearInterval(h._interval); } catch (_) {}
      }
      interceptGlobeOpen(w);
      resolve();
    };
    const tick = () => {
      try {
        const gm = frame.contentWindow?.GSI?.GLOBALS?.gsimaps;
        // initialized 後のフォールバック判定: sakuzuList+mapLayerList+mapMenu
        // が揃っていれば既に発火済みとみなす
        if (gm?._mainMap?.getMap?.() && gm._sakuzuList &&
            gm._mainMap._mapLayerList && gm._mainMap._mapMenu) {
          return done(gm);
        }
        if (gm?.on && !tick._bound) {
          tick._bound = true;
          gm.on("initialized", () => done(gm));
        }
      } catch (_) { /* 初期化途上・読み込み失敗は次ポーリングへ */ }
      setTimeout(tick, 200);
    };
    tick();
  });
}

// ---- GSI Globe(iframe内表示) ----
// 「Globe」(gsiglobe)は上流では iframe 内 window.open で globe/index_globe.html を
// 別タブへ開き、Canvas の状態を持たない単独ページへ出る。ここでは window.open を
// フックして iframe 内表示へ差し替え、左パネルを維持する。Globe は地理院地図専用
// アプリのため .kasc レイヤは出せないが、「2D地図に戻る」で reboot() が再構築する
let globeMode = false;
let lastGlobeHash = "";
const GSI_GLOBE_RE = /\/vendor\/gsimaps\/globe\/index_globe\.html$/;

function showGlobeBack(on) {
  const b = document.getElementById("globe-back");
  if (b) b.hidden = !on;
}

function interceptGlobeOpen(w) {
  if (!w || w.__kasugaiGlobeHooked) return;
  w.__kasugaiGlobeHooked = true;
  const origOpen = w.open?.bind(w);
  w.open = (url, target, features) => {
    if (typeof url === "string" && /globe\/index_globe\.html/.test(url)) {
      enterGlobe(url);
      return null;
    }
    return origOpen ? origOpen(url, target, features) : null;
  };
}

// iframe 地図の現在視点をデバウンス無しで親URLハッシュへ書き込む
function syncUrlViewNow() {
  try {
    if (!gmap) return;
    const c = gmap.getCenter();
    writeUrlView({
      latitude: c.lat, longitude: c.lng, zoom: gmap.getZoom(),
      height: zoomToCamHeight(c.lat, gmap.getZoom()), pitch: -90, heading: 0,
    }, currentProjectId);
  } catch (_) { /* 視点書込失敗は無視 */ }
}

function enterGlobe(url) {
  syncUrlViewNow();
  globeMode = true;
  lastGlobeHash = "";
  globeInjected = false;
  showGlobeBack(true);
  try {
    frame.src = new URL(url, frame.contentWindow.location.href).href;
  } catch (_) { frame.src = url; }
}

// globe の location.hash(#height/lat/lon/power/heading/pitch/roll/&…)を
// Canvas ビューへ変換。起動直後の #zoom/lat/lon/…(ISFROMGSIMAP 形式)も許容
function globeHashView() {
  try {
    const core = String(frame.contentWindow?.location?.hash || "")
      .replace(/^#/, "").replace(/\/?\&.*/, "");
    const parts = core.split("/");
    const lat = Number(parts[1]), lon = Number(parts[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const v0 = Number(parts[0]);
    const isZoom = parts.length <= 4;
    const zoom = isZoom ? v0 : camToZoom({ latitude: lat, height: v0 });
    const heading = Number(parts[4]), pitch = Number(parts[5]);
    return {
      latitude: lat, longitude: lon, zoom,
      height: isZoom ? zoomToCamHeight(lat, zoom) : v0,
      pitch: Number.isFinite(pitch) ? pitch : -90,
      heading: Number.isFinite(heading) ? heading : 0,
    };
  } catch (_) { return null; }
}

function globeHashBase() {
  try {
    const m = /&base=([^&]*)/.exec(frame.contentWindow?.location?.hash || "");
    return m ? decodeURIComponent(m[1]) : null;
  } catch (_) { return null; }
}

// globe 表示中は iframe ハッシュの視点を親URLへミラーする
// (エンジン切替・URL共有・2D復帰が globe の現在視点を拾うため)
function mirrorGlobeView() {
  const h = frame.contentWindow?.location?.hash || "";
  if (h === lastGlobeHash) return;
  lastGlobeHash = h;
  const v = globeHashView();
  if (v) writeUrlView(v, currentProjectId);
}

// 「2D地図に戻る」: globe の現在視点を引き継いで index_pm.html へ戻す。
// 再読込は guardFrameDoc → reboot() が検出し、parseUrlView の視点復元と
// buildFromDoc(lastDocCtx) で全レイヤが再構築される
function exitGlobe() {
  const v = globeHashView();
  if (v) writeUrlView(v, currentProjectId);
  const z = v ? Math.max(2, Math.min(18, Math.round(v.zoom))) : DEFAULT_ZOOM;
  const lat = v ? v.latitude : DEFAULT_CENTER.lat;
  const lng = v ? v.longitude : DEFAULT_CENTER.lng;
  const base = globeHashBase() || "std";
  globeMode = false;
  showGlobeBack(false);
  frame.src = `${GSI_VENDOR_URL}#${z}/${lat.toFixed(6)}/${lng.toFixed(6)}/&base=${base}&ls=${base}&disp=1`;
  lastVendorSrc = frame.src;
}
document.getElementById("globe-back")?.addEventListener("click", exitGlobe);

// ---- Globe 上への Canvas レイヤ注入 ----
// Globe は Cesium アプリ(GLOBE.MAP.viewer)。同一オリジンのため親から直接
// DataSource/ImageryLayer を追加できる。.kasc ベクター行 → GeoJsonDataSource、
// xyz/wms/wmts 行 → ImageryLayer。上流コードは無改変のまま、注入物はこちら側で
// 管理し可視性もパネルのチェックへ同期する
let globeInjected = false;

function globeApis() {
  const w = frame.contentWindow;
  return { viewer: w?.GLOBE?.MAP?.viewer, C: w?.Cesium };
}

// Globe ページの viewer 生成を待って現在のレイヤを注入する
function maybeInjectGlobeLayers() {
  const { viewer, C } = globeApis();
  if (!viewer || !C || globeInjected) return;
  globeInjected = true;
  void injectGlobeLayers();
}

async function injectGlobeLayers() {
  const { viewer, C } = globeApis();
  if (!viewer || !C) { globeInjected = false; return; }
  for (const e of layerEntries) {
    try { await mountGlobeEntry(e); }
    catch (err) { console.warn("[globe] inject:", e.item.title, err); }
  }
  // 外部タイルのベース行も地表イメージとして載せる(GSIベースは globe 側の base= に委譲)
  const sel = document.getElementById("basemap-select");
  const idx = Number(sel?.value ?? -1);
  const b = baseEntries[idx];
  if (b && !b.gsiId && !b._globeImagery && b.item.url && !baseHidden) {
    try { b._globeImagery = addGlobeImagery(b.item); } catch (err) { console.warn("[globe] base:", err); }
  }
}

async function mountGlobeEntry(e) {
  const item = e.item;
  if (e._globeDs || e._globeImagery) return;
  const on = item.visible !== false;
  if (VECTOR_TYPES.has(item.type)) {
    if (!item._geojson) {
      const result = await loadVectorItem(item, lastBaseUrl);
      item._geojson = result.geojson;
    }
    e._globeDs = await addGlobeGeoJson(item._geojson);
    if (e._globeDs) e._globeDs.show = on;
    return;
  }
  if (TILE_TYPES.has(item.type)) {
    e._globeImagery = addGlobeImagery(item);
    if (e._globeImagery) e._globeImagery.show = on;
  }
}

// GeoJSON → Globe の Cesium GeoJsonDataSource。`_`-props の解決済みスタイルを
// entity へ適用する(旧Cesiumでも動くよう clamp 系は存在確認つき)
async function addGlobeGeoJson(geojson) {
  const { viewer, C } = globeApis();
  if (!viewer || !C) return null;
  const features = geojson?.features || [];
  if (!features.length) return null;
  const ds = await C.GeoJsonDataSource.load(
    { type: "FeatureCollection", features }, { clampToGround: true });
  for (const ent of ds.entities.values) styleGlobeEntity(ent, C);
  viewer.dataSources.add(ds);
  return ds;
}

function styleGlobeEntity(ent, C) {
  let p = {};
  try { p = ent.properties?.getValue?.(C.JulianDate.now()) || {}; } catch (_) {}
  const css = (v, fb) => { try { return C.Color.fromCssColorString(v || fb); } catch (_) { return C.Color.fromCssColorString(fb); } };
  const withA = (c, a) => { const x = c.clone(); x.alpha = a == null ? 1 : Number(a); return x; };
  if (ent.billboard || ent.position && !ent.polyline && !ent.polygon) {
    if (ent.billboard) ent.billboard = undefined;
    ent.point = new C.PointGraphics({
      pixelSize: Math.max(2, (Number(p._radius) || 5) * 2),
      color: withA(css(p._fillColor, "#3a7bd5"), p._fillOpacity ?? 1),
      outlineColor: withA(css(p._color, "#ffffff"), p._opacity ?? 1),
      outlineWidth: Number(p._weight) || 1,
    });
    if (C.HeightReference?.CLAMP_TO_GROUND != null && "heightReference" in ent.point)
      ent.point.heightReference = C.HeightReference.CLAMP_TO_GROUND;
  }
  if (ent.polyline) {
    ent.polyline.width = Number(p._weight) || 2;
    ent.polyline.material = withA(css(p._color, "#2c5ea8"), p._opacity ?? 1);
    if ("clampToGround" in ent.polyline) ent.polyline.clampToGround = true;
  }
  if (ent.polygon) {
    ent.polygon.material = withA(css(p._fillColor, "#3a7bd5"), p._fillOpacity ?? 0.4);
    ent.polygon.outline = false; // 地形クランプポリゴンは輪郭描画に非対応
    if ("perPositionHeight" in ent.polygon) ent.polygon.perPositionHeight = false;
    if (C.HeightReference?.CLAMP_TO_GROUND != null && "heightReference" in ent.polygon)
      ent.polygon.heightReference = C.HeightReference.CLAMP_TO_GROUND;
  }
}

// xyz/wmts 行 → UrlTemplateImageryProvider({z}/{x}/{y})、wms 行 →
// WebMapServiceImageryProvider。Leaflet 用 {bbox-epsg-3857} テンプレートは
// Cesium では使えないため wms はプロバイダ側へ分解して渡す
function addGlobeImagery(item) {
  const { viewer, C } = globeApis();
  if (!viewer || !C) return null;
  const opts = item.opts || {};
  if (item.type === "wms") {
    return viewer.imageryLayers.addImageryProvider(new C.WebMapServiceImageryProvider({
      url: resolveKascUrl(item.url, lastBaseUrl),
      layers: opts.layers ?? "",
      parameters: {
        transparent: String(opts.transparent ?? "true"),
        format: opts.format || "image/png",
        version: opts.version || "1.1.1",
        styles: opts.styles || "",
      },
    }));
  }
  const url = tileUrlOf(item); // wmts も {z}/{x}/{y} へ正規化済み
  if (!/\{[zxy]\}/.test(url)) return null;
  return viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url }));
}

// 新しい iframe 地図へのイベント配線(reboot 時にも呼ぶ)
function wireMapEvents() {
  bindViewSync();
  gmap?.on("moveend", scheduleViewportReload);
}

// iframe 地図移動 → 親ページ URL ハッシュ(#latitude=…&zoom=…)へ同期
let boundViewMap = null;
let urlViewTimer = null;
function bindViewSync() {
  if (!gmap || boundViewMap === gmap) return;
  boundViewMap = gmap;
  gmap.on("moveend", () => {
    // 親 replaceState と iframe 側 L.Hash の hash 書込が連鎖すると
    // joint session history で iframe が親URLを拾うケースがあるため、
    // 親への書き込みはデバウンスして頻度を下げる
    clearTimeout(urlViewTimer);
    urlViewTimer = setTimeout(syncUrlViewNow, 300);
  });
}

// ---- スタイル: kasc/simplestyle/default_style → sakuzuList の `_`-props ----
function styledFeature(item, feature) {
  const props = { ...(feature.properties || {}) };
  const gt = feature.geometry?.type || "";
  const ds = currentDefaultStyles || {};
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  if (/Point/.test(gt)) {
    const s = resolveDefaultPointStyle(props, ds.point, { color: "#2c5ea8", size: 0, opacity: 1 });
    props._markerType = "CircleMarker";
    props._radius = s.size ? defaultPointRadius(s.size) : 5;
    props._color = props.stroke ?? "#ffffff";
    props._weight = num(props["stroke-width"]) ?? 1;
    props._fillColor = s.color;
    props._fillOpacity = s.opacity ?? 1;
    props._opacity = num(props["stroke-opacity"]) ?? 1;
  } else if (/Polygon/.test(gt)) {
    const s = resolveDefaultPolygonStyle(props, ds.polygon, ds.line,
      { fill: "#3a7bd5", fillOpacity: 0.4, stroke: "#2c5ea8", strokeWidth: 1.5, strokeOpacity: 1 });
    props._color = s.stroke; props._weight = s.strokeWidth; props._opacity = s.strokeOpacity;
    props._fillColor = s.fill; props._fillOpacity = s.fillOpacity; props._fill = true;
  } else {
    const s = resolveDefaultLineStyle(props, ds.line, { color: "#2c5ea8", width: 1.5, opacity: 1 });
    props._color = s.color; props._weight = s.width; props._opacity = s.opacity;
  }
  return { ...feature, properties: props };
}

// GeoJSON を作図アイテムとして注入。visible=false なら非表示で登録のみ
function injectSakuzuLayer(item, geojson) {
  const fc = { type: "FeatureCollection", features: (geojson?.features || []).map(f => styledFeature(item, f)) };
  const layer = new G.GeoJSON(null, { geodesic: true });
  layer.addData(fc);
  // 地物クリック → 親の属性タブへ(Leaflet 版と同じ導線)
  layer.eachLayer(l => l.on("click", () => showFeatureAttrs(l.feature?.properties || {})));
  const title = item.title || "layer";
  const fileName = /\.[a-z0-9]+$/i.test(title) ? title : `${title}.geojson`;
  const sk = new G.SakuzuListItem(
    sakuzu, G.SakuzuListItem.GEOJSON, title, fileName, layer,
    item.visible !== false, false, null);
  sakuzu._list.push(sk);
  sakuzu.fire("change");
  return sk;
}

function removeSakuzuItem(sk) {
  if (!sk) return;
  try { sk.setVisible(false); } catch (_) {}
  const idx = sakuzu._list.indexOf(sk);
  if (idx >= 0) sakuzu._list.splice(idx, 1);
  sakuzu.fire("change");
}

// ---- ベースマップ ----
// 地理院タイルの base: 行は gsimaps の baseLayer.setActiveId、それ以外の
// xyz/wms/wmts 系は外部タイルとして登録して select で切り替える
function tileUrlOf(item) {
  const url = resolveKascUrl(item.url, lastBaseUrl);
  if (item.type === "wms") return buildWmsTileTemplate(url, item.opts || {});
  if (item.type === "wmts") return buildWmtsTileTemplate(url, item.opts || {});
  return url;
}

// タイル行 → 中間層管理の Leaflet tileLayer。
// gsimaps の外部タイル機構(appendOutSideTile)は refreshTileList で tileList が
// 全置換され消えるため使わず、同一オリジンの Leaflet に直接載せて管理する
function createTileLayer(item) {
  const w = frame.contentWindow;
  const opts = item.opts || {};
  return w.L.tileLayer(tileUrlOf(item), {
    minZoom: opts.minzoom ? Number(opts.minzoom) : undefined,
    maxZoom: opts.maxzoom ? Number(opts.maxzoom) : undefined,
    attribution: layerAttribution(item) || "",
    opacity: 1,
    // base 行は GSI タイルと同じ低 zIndex、オーバーレイはその上
    zIndex: item.type === "base" ? 1 : 10,
  });
}

// ---- レイヤー行 ----
function effectiveVisible(entry) {
  return entry.item.visible !== false;
}

function applyEntryVisibility(entry) {
  const on = effectiveVisible(entry);
  if (globeMode) {
    // map 参照は死んでいるため globe 注入物の表示だけ同期する
    if (entry._globeDs) entry._globeDs.show = on;
    if (entry._globeImagery) entry._globeImagery.show = on;
    return;
  }
  if (entry.sakuzu) entry.sakuzu.setVisible(on);
  if (entry.tileLayer && gmap) {
    if (on && !gmap.hasLayer(entry.tileLayer)) gmap.addLayer(entry.tileLayer);
    else if (!on && gmap.hasLayer(entry.tileLayer)) gmap.removeLayer(entry.tileLayer);
  }
}

function focusEntry(entry) {
  if (!gmap || globeMode) return;
  const env = entry.item._env || (entry.item._geojson && geojsonExtent(entry.item._geojson));
  if (env) gmap.fitBounds([[env.south, env.west], [env.north, env.east]], { padding: [40, 40] });
  else if (entry.sakuzu?._layer?.getBounds) {
    try { const b = entry.sakuzu._layer.getBounds(); if (b?.isValid?.()) gmap.fitBounds(b, { padding: [40, 40] }); } catch (_) {}
  }
}

async function mountEntry(entry, preloaded) {
  const item = entry.item;
  if (VECTOR_TYPES.has(item.type)) {
    const result = preloaded?.geojson ? { geojson: preloaded.geojson } : await loadVectorItem(item, lastBaseUrl);
    item._geojson = result.geojson;
    item._env = geojsonExtent(result.geojson) || null;
    if (result.viewportQuery) item._viewportQuery = true;
    if (item.opts?.style) entry._qmlPending = true; // QML→_props 変換は未対応
    entry.sakuzu = injectSakuzuLayer(item, item._geojson);
    return;
  }
  if (TILE_TYPES.has(item.type) || item.type === "base") {
    entry.tileLayer = createTileLayer(item);
    if (item.visible !== false && gmap) gmap.addLayer(entry.tileLayer);
    return;
  }
  throw new Error(`未対応の行: ${item.type}`);
}

function unmountEntry(entry) {
  if (entry.sakuzu) { removeSakuzuItem(entry.sakuzu); entry.sakuzu = null; }
  if (entry.tileLayer && gmap?.hasLayer(entry.tileLayer)) gmap.removeLayer(entry.tileLayer);
  entry.tileLayer = null;
}

// viewportQuery 行は表示範囲変化で再取得が必要（moveend で再注入）
async function reloadEntryData(entry) {
  const wasVisible = effectiveVisible(entry);
  removeSakuzuItem(entry.sakuzu);
  entry.sakuzu = null;
  const result = await loadVectorItem(entry.item, lastBaseUrl, viewBounds());
  entry.item._geojson = result.geojson;
  entry.item._env = geojsonExtent(result.geojson) || null;
  entry.sakuzu = injectSakuzuLayer(entry.item, result.geojson);
  if (!wasVisible) entry.sakuzu.setVisible(false);
}

function viewBounds() {
  if (!gmap) return null;
  const b = gmap.getBounds();
  return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
}

let viewportReloadTimer = null;
function scheduleViewportReload() {
  clearTimeout(viewportReloadTimer);
  viewportReloadTimer = setTimeout(() => {
    for (const e of layerEntries) {
      if (e.item._viewportQuery && effectiveVisible(e)) reloadEntryData(e).catch(console.error);
    }
  }, 400);
}

// ---- 属性 ----
const attrContentEl = () => document.getElementById("attr-content");

// iframe 内地物クリック → 属性タブへ表示。`_`-props(中間層の内部スタイル値)は除く
function showFeatureAttrs(props) {
  const el = attrContentEl();
  if (!el) return;
  const clean = {};
  for (const [k, v] of Object.entries(props || {})) if (!k.startsWith("_")) clean[k] = v;
  renderAttrContent(el, attrEntriesFromProps(clean));
}

function focusFeatureExtent(feature) {
  if (!gmap || globeMode) return;
  const env = geojsonExtent({ type: "FeatureCollection", features: feature ? [feature] : [] });
  if (env) gmap.fitBounds([[env.south, env.west], [env.north, env.east]], { padding: [50, 50] });
}

// 「属性・値一覧」ボトムシート(Leaflet 版と同じ共有ウィジェット)
const attrWidget = createAttrWidget({
  listLayers: () => layerEntries
    .map((entry, i) => ({ id: String(i), title: splitKascTitle(entry.item.title).title || entry.item.title || entry.item.url, entry }))
    .filter(o => VECTOR_TYPES.has(o.entry.item.type)),
  getFeatures: async entry => {
    const item = entry.item;
    // bbox 連動クエリ系は表示範囲分しか持たないため、属性一覧は全件読込にする
    if (isViewportQueryItem(item)) {
      const { geojson } = await loadVectorItem(item, lastBaseUrl, null);
      return { features: geojson?.features || [] };
    }
    if (!item._geojson && !entry.failed) await mountEntry(entry);
    if (entry.failed) throw new Error(entry.error || "load failed");
    return { features: item._geojson?.features || [] };
  },
  focusFeature: focusFeatureExtent,
});
document.getElementById("attr-widget-open")?.addEventListener("click", () => {
  attrWidget.open(attrContentEl()?.dataset.layerId || null);
});

// ---- パネル ----
function updateLoadProgress(done, total, label) {
  const el = document.getElementById("load-progress");
  const bar = document.getElementById("load-progress-bar");
  document.getElementById("load-progress-text").textContent =
    total ? `読込中 ${done}/${total}${label ? ` ${label}` : ""}` : "";
  bar.style.width = total ? `${Math.round(done / total * 100)}%` : "0";
  el.hidden = done >= total;
}

// レイヤ行のステータス領域を entry の状態(読込中/失敗)へ同期する
function syncRowStatus(entry) {
  const el = entry.statusEl;
  if (!el) return;
  el.classList.toggle("loading", !!entry.pending);
  el.classList.toggle("failed", !entry.pending && !!entry.failed);
  el.textContent = entry.pending ? "" : entry.failed ? "失敗" : "";
  el.title = entry.failed ? String(entry.error || "") : "";
}

// style 未指定ベクターの自動凡例: Leaflet 版と同じ既定色スウォッチ spec を
// 先頭地物のジオメトリ種別から作る
function defaultLegendSpec(item) {
  if (!VECTOR_TYPES.has(item.type)) return null;
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

  const cb = document.createElement("input");
  cb.type = exclusive ? "radio" : "checkbox";
  if (exclusive) cb.name = radioName;
  cb.checked = item.visible !== false;
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
    if (cb.checked) maybeLoadEntry(entry);
    entry._groupCtl?.sync();
  });
  row.append(cb);

  const statusEl = document.createElement("span");
  statusEl.className = "layer-status";
  entry.statusEl = statusEl;
  syncRowStatus(entry);

  const legendSpec = defaultLegendSpec(item);
  if (legendSpec) {
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
    name.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
      attrWidget.open(String(layerEntries.indexOf(entry)));
    });
  }
  row.append(name, statusEl);

  const fb = document.createElement("button");
  fb.type = "button";
  fb.className = "layer-focus";
  fb.textContent = "📍";
  fb.title = "レイヤーへ移動";
  fb.addEventListener("click", ev => { ev.preventDefault(); ev.stopPropagation(); focusEntry(entry); });
  row.append(fb);
  wrap.append(row);
  return wrap;
}

const expandedLayerGroups = new Set();

// "グループ/レイヤ名"（"//"は排他グループ）でグループセクション化する。
// Leaflet 版と同じ構造: 折りたたみ・グループチェック(不確定表示)・排他バッジ
function renderLayerRows() {
  const box = document.getElementById("layers");
  box.replaceChildren();
  const grouped = new Map();
  for (const entry of layerEntries) {
    const sp = splitKascTitle(entry.item.title);
    entry._leaf = sp.title;
    const key = `${sp.group}|${sp.exclusiveGroup ? "exclusive" : "regular"}`;
    if (!grouped.has(key)) grouped.set(key, { group: sp.group, exclusive: sp.exclusiveGroup, members: [] });
    grouped.get(key).members.push(entry);
  }

  for (const { group, exclusive, members } of grouped.values()) {
    for (const e of members) e._siblings = members;
    if (!group) {
      for (const e of members) box.append(buildLayerRow(e, false, null));
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
    box.append(section);

    const ctl = {
      sync() {
        const anyOn = members.some(e => e.item.visible !== false);
        gcb.checked = anyOn;
        gcb.indeterminate = !exclusive && anyOn && members.some(e => e.item.visible === false);
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
        const on = gcb.checked ? (members.find(e => e.item.visible !== false) || members[0]) : null;
        for (const e of members) {
          e.item.visible = e === on;
          if (e.cb) e.cb.checked = e === on;
          applyEntryVisibility(e);
          if (e === on) maybeLoadEntry(e);
        }
      } else {
        for (const e of members) {
          e.item.visible = gcb.checked;
          if (e.cb) e.cb.checked = gcb.checked;
          applyEntryVisibility(e);
          maybeLoadEntry(e);
        }
      }
      ctl.sync();
    });
  }

  const unsup = document.getElementById("unsupported");
  unsup.textContent = currentUnsupported.length
    ? `未対応行: ${[...new Set(currentUnsupported.map(i => i.type))].join(", ")}（Cesium 版で対応）`
    : "";
}

// ---- テーマ ----
function updateThemeSelect(themes) {
  currentThemes = themes || [];
  fillThemeSelect(themeSelect, currentThemes);
}
function applyKascTheme(theme) {
  const show = themeShowSet(theme);
  for (const e of layerEntries) {
    e.item.visible = show == null || kascTitleInTheme(e.item.title, show);
    applyEntryVisibility(e);
    maybeLoadEntry(e);
  }
  renderLayerRows();
  inspectorInput.value = rewriteKascVisibility(inspectorInput.value, show);
}
themeSelect?.addEventListener("change", () => {
  const theme = currentThemes.find(t => t.name === themeSelect.value);
  if (theme) applyKascTheme(theme);
});

// ---- カメラ ----
function fillCamPanel(cams) {
  const box = document.getElementById("cams");
  box.replaceChildren();
  for (const c of cams || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cam-btn" + (c.bookmark ? " bm-btn" : "");
    b.textContent = c.name || `${Number(c.latitude).toFixed(4)},${Number(c.longitude).toFixed(4)}`;
    b.title = `${c.latitude}, ${c.longitude}`;
    b.addEventListener("click", () => {
      if (c._extent && gmap) gmap.fitBounds([[c._extent.south, c._extent.west], [c._extent.north, c._extent.east]], { padding: [30, 30] });
      else flyToCam(c);
    });
    box.append(b);
  }
}
function flyToCam(cam) {
  if (!gmap || globeMode) return;
  const zoom = Number.isFinite(cam.zoom) ? cam.zoom : camToZoom(cam);
  gmap.setView([Number(cam.latitude), Number(cam.longitude)], zoom);
}
document.getElementById("cams-save-kasc")?.addEventListener("click", () => downloadKascCamLines(currentCams));
document.getElementById("cams-save-qgis")?.addEventListener("click", () => downloadQgisBookmarksXml(currentCams));
document.getElementById("cams-load")?.addEventListener("click", () => document.getElementById("cams-import-file")?.click());
document.getElementById("cams-import-file")?.addEventListener("change", async e => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const text = await file.text();
  const list = (await import("../shared/kasc.js")).parseQgisBookmarksXml(text);
  for (const bm of list) { const c = (await import("../shared/kasc.js")).qgisBookmarkToCam(bm); c.bookmark = true; currentCams.push(c); }
  fillCamPanel(currentCams);
});

// ---- 検索（親側のデータを対象。gsimaps 検索は外部依存のため使わない）----
document.getElementById("search-input")?.addEventListener("input", () => {
  const q = document.getElementById("search-input").value.trim();
  const box = document.getElementById("search-results");
  box.replaceChildren();
  if (!q || !window.kasugaiApi) return;
  for (const hit of window.kasugaiApi.vectorSearch(q)) {
    const el = document.createElement("div");
    el.className = "search-hit";
    el.innerHTML = `<small>${hit.layer} / ${hit.property}</small>${String(hit.value).slice(0, 60)}`;
    el.addEventListener("click", () => {
      if (Number.isFinite(hit.latitude) && gmap) gmap.setView([hit.latitude, hit.longitude], Math.max(gmap.getZoom(), 14));
    });
    box.append(el);
  }
});

// ---- ベースマップ select ----
function rebuildBasemapSelect() {
  const sel = document.getElementById("basemap-select");
  sel.replaceChildren();
  const none = document.createElement("option");
  none.value = "-1"; none.textContent = "ベースマップなし";
  sel.append(none);
  baseEntries.forEach((e, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = e.item.title || `base ${i + 1}`;
    sel.append(o);
  });
  sel.value = baseHidden ? "-1" : "0";
}
function applyBaseSelection() {
  if (globeMode) return;
  const sel = document.getElementById("basemap-select");
  const idx = Number(sel?.value ?? -1);
  baseHidden = idx < 0;
  // gsimaps 標準ベースマップ: .kasc の先頭 GSI ベース行が選ばれた時だけ使い、
  // それ以外・なし選択時は blank(白地図)にして外部タイルを実質ベースにする
  const gsiEntry = baseEntries.find(e => e.gsiId);
  const active = baseEntries[idx];
  const bl = gsiBase();
  if (bl) {
    const id = (!baseHidden && active?.gsiId) ? active.gsiId
      : (!baseHidden && !active && gsiEntry?.gsiId) ? gsiEntry.gsiId : "blank";
    try { bl.setActiveId(id); } catch (_) {}
  } else {
    // _baseLayer は gsimaps 内部で遅延生成されるため未到達時は一度だけ再試行
    setTimeout(applyBaseSelection, 800);
  }
  baseEntries.forEach((e, i) => {
    if (!e.tileLayer || !gmap) return;
    const on = !baseHidden && i === idx;
    if (on && !gmap.hasLayer(e.tileLayer)) gmap.addLayer(e.tileLayer);
    else if (!on && gmap.hasLayer(e.tileLayer)) gmap.removeLayer(e.tileLayer);
  });
}
document.getElementById("basemap-select")?.addEventListener("change", applyBaseSelection);

// ---- inspector ----
function setInspectorStatus(msg, isError = false) {
  const el = document.getElementById("inspector-status");
  el.textContent = msg || "";
  el.style.color = isError ? "#c0392b" : "#666";
}
async function applyInspectorText(text) {
  const doc = parseKasc(String(text ?? ""));
  await buildFromDoc({ doc, baseUrl: lastBaseUrl });
  inspectorInput.value = String(text ?? "");
}
document.getElementById("apply-inspector")?.addEventListener("click", async () => {
  try { setInspectorStatus("適用中…"); await applyInspectorText(inspectorInput.value); setInspectorStatus("適用しました"); }
  catch (e) { setInspectorStatus(`適用失敗: ${e?.message || e}`, true); }
});
document.getElementById("export-inspector")?.addEventListener("click", () => {
  const blob = new Blob([inspectorInput.value], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "kasugai_canvas.kasc"; a.click();
  URL.revokeObjectURL(a.href);
  setInspectorStatus("エクスポートしました");
});

// ---- プロジェクト切替 ----
function fillProjectSelect(manifest, selected) {
  projectSelect.replaceChildren();
  for (const entry of manifest || []) {
    const id = entry.id || entry;
    const o = document.createElement("option");
    o.value = id; o.textContent = entry.title || id;
    projectSelect.append(o);
  }
  if (selected) projectSelect.value = selected;
}
projectSelect?.addEventListener("change", () => { void loadProject(projectSelect.value); });

async function loadProject(projectId) {
  const proj = await loadKascProject(projectId);
  currentManifest = proj.manifest;
  fillProjectSelect(proj.manifest, proj.id);
  await applyProject(proj);
}

// ---- .kasc doc → gsimaps 構築 ----
function resetAll() {
  for (const e of layerEntries) {
    if (e.sakuzu) removeSakuzuItem(e.sakuzu);
    if (e.tileLayer && gmap?.hasLayer(e.tileLayer)) gmap.removeLayer(e.tileLayer);
  }
  layerEntries = [];
  for (const e of baseEntries) {
    if (e.tileLayer && gmap?.hasLayer(e.tileLayer)) gmap.removeLayer(e.tileLayer);
  }
  baseEntries = [];
  currentUnsupported = [];
}

async function applyProject(proj) {
  lastBaseUrl = proj.baseUrl;
  currentProjectId = proj.id;
  inspectorInput.value = proj.raw || "";
  applyPanelTitle(proj.doc.title || proj.title);
  // 起動用ハッシュ: URL ビュー > 最初の cam > 既定
  const uv = parseUrlView();
  const cam = proj.doc.cams.find(c => !c.bookmark) || proj.doc.cams[0];
  const lat = hasUrlView(uv) ? uv.latitude : (cam?.latitude ?? DEFAULT_CENTER.lat);
  const lng = hasUrlView(uv) ? uv.longitude : (cam?.longitude ?? DEFAULT_CENTER.lng);
  const zoom = hasUrlView(uv) && Number.isFinite(uv.zoom) ? uv.zoom : (cam ? camToZoom(cam) : DEFAULT_ZOOM);
  // 最初の表示 GSI ベース行 → base=。無ければ std（後で外部タイルが上に乗る）
  const gsiBaseRow = proj.doc.bases.find(b => b.visible !== false && gsiBaseIdFromUrl(b.url));
  const baseId = gsiBaseRow ? gsiBaseIdFromUrl(gsiBaseRow.url) : "std";
  const z = Math.max(2, Math.min(18, Math.round(zoom)));
  frame.src = `${GSI_VENDOR_URL}#${z}/${lat.toFixed(6)}/${lng.toFixed(6)}/&base=${baseId}&ls=${baseId}&disp=1`;
  lastVendorSrc = frame.src;
  await waitGsimaps();
  wireMapEvents();
  await buildFromDoc({ doc: proj.doc, baseUrl: proj.baseUrl, noFit: hasUrlView(uv) || !!cam });
  booted = true;
  // エンジン切替時の引継ぎ状態を一度だけ消費
  const sw = consumeEngineSwitchState();
  if (sw?.inspector) {
    inspectorInput.value = sw.inspector;
    await applyInspectorText(sw.inspector);
    if (sw.theme) {
      const th = currentThemes.find(t => t.name === sw.theme);
      if (th) { themeSelect.value = th.name; applyKascTheme(th); }
    }
  }
}

async function buildFromDoc({ doc, baseUrl, noFit = false }) {
  lastDocCtx = { doc, baseUrl };
  resetAll();
  currentDefaultStyles = doc.defaultStyles || {};
  currentUnsupported = [...doc.unsupported];
  lastBaseUrl = baseUrl || lastBaseUrl;

  // base: 行（GSI は select 項目として登録、外部タイルも同様）
  for (const item of doc.bases) {
    const gsiId = gsiBaseIdFromUrl(item.url);
    const entry = { item, gsiId, tileLayer: null };
    baseEntries.push(entry);
  }
  // base 行の外部タイル分は作成のみ（表示は applyBaseSelection が制御）
  for (const e of baseEntries) {
    if (e.gsiId || e.item.mode) continue; // transparent/none はタイル無し
    try { e.tileLayer = createTileLayer({ ...e.item, type: "xyz" }); } catch (err) { console.warn(err); }
  }
  rebuildBasemapSelect();
  applyBaseSelection();

  // ベクター・タイル行
  layerEntries = doc.layers
    .filter(item => VECTOR_TYPES.has(item.type) || TILE_TYPES.has(item.type))
    .map(item => ({ item, pending: true }));
  renderLayerRows();
  let done = 0;
  const total = layerEntries.length;
  for (const e of layerEntries) {
    try {
      await mountEntry(e);
      e.pending = false;
    } catch (err) {
      console.warn(e.item.title, err);
      e.pending = false; e.failed = true;
      e.error = err?.message || err;
      currentUnsupported.push({ type: `${e.item.type}(読込失敗)` });
    }
    updateLoadProgress(++done, total, e.item.title);
    renderLayerRows();
  }
  updateLoadProgress(total, total);

  // cam/bookmark/テーマ/凡例/情報
  const bmCams = await loadKascBookmarks(doc.bookmarks, baseUrl).catch(() => []);
  currentCams = [...doc.cams, ...bmCams];
  fillCamPanel(currentCams);
  updateThemeSelect(doc.themes);
  applyPanelTitle(doc.title || null);
  const info = document.getElementById("info-link");
  info.replaceChildren();
  if (doc.info) info.append(sanitizeAttributionFragment(doc.info));
  const legendsBox = document.getElementById("legends");
  legendsBox?.replaceChildren();
  if (doc.legends?.length) {
    for (const lg of doc.legends) {
      const img = document.createElement("img");
      img.src = resolveKascUrl(lg.url, baseUrl);
      img.alt = lg.title || "凡例";
      img.style.maxWidth = "100%";
      legendsBox?.append(img);
    }
  }

  // 初回表示: URL/cam 指定が無ければデータ範囲へフィット
  if (!noFit) {
    const env = layerEntries.map(e => e.item._env).find(Boolean);
    if (env && gmap) gmap.fitBounds([[env.south, env.west], [env.north, env.east]], { padding: [40, 40] });
  }
}

// ---- kasugaiApi（AI/外部制御） ----
function maybeLoadEntry(entry) {
  if (globeMode) { void mountGlobeEntry(entry); return; }
  if (entry.pending || entry.sakuzu || entry.tileLayer) return;
  entry.pending = true;
  mountEntry(entry).then(() => { entry.pending = false; renderLayerRows(); })
    .catch(err => { entry.pending = false; entry.failed = true; renderLayerRows(); console.warn(err); });
}

window.kasugaiApi = createPlayerApi({
  engine: "gsimaps",
  getEntries: () => layerEntries,
  getBaseEntries: () => baseEntries,
  getProjectId: () => currentProjectId,
  getBaseUrl: () => lastBaseUrl,
  loadProject,
  applyInspectorText,
  getInspectorText: () => inspectorInput.value,
  setInspectorText: v => { inspectorInput.value = v; },
  applyEntryVisibility, focusEntry, maybeLoadEntry,
  applyLegendFilter: entry => applyEntryVisibility(entry),
  rerenderLayers: renderLayerRows,
  getThemes: () => currentThemes,
  applyThemeByName: name => {
    const theme = currentThemes.find(t => t.name === name);
    if (!theme) return false;
    applyKascTheme(theme);
    if (themeSelect) themeSelect.value = theme.name;
    return true;
  },
  getCams: () => currentCams,
  flyToView: v => gmap?.setView([Number(v.latitude), Number(v.longitude)],
    Number.isFinite(v.zoom) ? v.zoom : camToZoom(v)),
  getViewInfo: () => {
    if (!gmap) return null;
    const c = gmap.getCenter();
    return { latitude: c.lat, longitude: c.lng, zoom: gmap.getZoom(), heading: 0, pitchDeg: 0 };
  },
  fitBoundsView: (w, s, e, n) => gmap?.fitBounds([[s, w], [n, e]], { padding: [50, 50] }),
  mountEntry: async (entry, preloaded) => {
    await mountEntry(entry, preloaded);
    applyEntryVisibility(entry);
  },
  unmountEntry,
  reloadEntryData: async entry => {
    const result = await loadVectorItem(entry.item, lastBaseUrl, viewBounds());
    entry.item._geojson = result.geojson;
    entry.item._env = geojsonExtent(result.geojson) || null;
    removeSakuzuItem(entry.sakuzu);
    entry.sakuzu = injectSakuzuLayer(entry.item, result.geojson);
    applyEntryVisibility(entry);
  },
  getEntryGeoJson: entry => entry.item._geojson || null,
  setBaseEntryVisible: (entry, on) => {
    const bl = gsiBase();
    if (entry.gsiId && bl) { try { if (on) bl.setActiveId(entry.gsiId); } catch (_) {} }
    if (entry.tileLayer && gmap) {
      if (on && !gmap.hasLayer(entry.tileLayer)) gmap.addLayer(entry.tileLayer);
      else if (!on && gmap.hasLayer(entry.tileLayer)) gmap.removeLayer(entry.tileLayer);
    }
  },
});
mountEngineSwitcher(document.querySelector("#engines"), "gsimaps");
void initAiChat({ engine: "gsimaps", manageBackend: true });
// ai-chat.js が body 直下に作る #chat-panel(fixed 浮遊)を左ドックの AI 区画へ移設。
// 再生成・遅延生成にも対応するため MutationObserver で常時監視する
function dockChatPanel() {
  const chat = document.querySelector("#chat-panel");
  const dock = document.querySelector("#ai-section");
  if (chat && dock && chat.parentElement !== dock) dock.appendChild(chat);
}
new MutationObserver(dockChatPanel).observe(document.body, { childList: true });
setTimeout(dockChatPanel, 0);
// デバッグ/検証用（内部構造の読み取りのみ）
window._gsimapsDbg = {
  get baseEntries() { return baseEntries; },
  get layerEntries() { return layerEntries; },
  get gsiLayerList() { return gsiApp?._mainMap?._mapLayerList; },
};

// ---- 起動 ----
(async () => {
  try {
    await loadProject();
  } catch (e) {
    console.error(e);
    setInspectorStatus(`読み込み失敗: ${e?.message || e}`, true);
    document.getElementById("unsupported").textContent = `プロジェクト読込失敗: ${e?.message || e}`;
  }
})();
