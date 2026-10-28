// KASUGAI Canvas — GSI Maps フロント（中間エンジン）
// vendored 地理院地図(gsi-cyberjapan/gsimaps, web/vendor/gsimaps/)を同一オリジン
// iframe として組み込み、.kasc プロジェクトを GSI/Leaflet API 経由で再生する。
// 上流コードは無改変で、制御・変換はすべてこの中間層が担う。
// vendor 実体は配布物に同梱せず CDN 側提供。ローカルに無い環境では
// index.html 先頭の検出スクリプトがホスト版(kasugai-canvas-web)へ転送するため、
// このモジュールが動く時点で vendor iframe は同一オリジンが保証される
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
  layerAttribution, loadKascInfoContent,
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
let flyPathItems = [];       // .kasc fly_geojson: 行（フライパス定義。player-api の getFlyPaths 経由で AI ツールへ公開）
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
        // removeFrom は this.map=null にするが isListening=false だと残った
        // moveend/hashchange リスナが this.map._loaded で落ちるため、ハンドラ
        // 自体を no-op 化してから detach する
        try { h.onMapMove = () => {}; h.onHashChange = () => {}; } catch (_) {}
        try { h.movingMap = true; h.stopListening?.(); } catch (_) {}
        try { h.removeFrom?.(gmap); } catch (_) {}
        try { if (h.hashChangeInterval) clearInterval(h.hashChangeInterval); } catch (_) {}
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
    if (globeMode || !gmap) return;
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
  globeInjectedFor = null;
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
// globe は hash 変更で自ページを location.reload() する設計のため、注入済みかは
// 「どの viewer に入れたか」で判定する(別 viewer なら参照を掃除して再注入する)
let globeInjectedFor = null;

function globeApis() {
  const w = frame.contentWindow;
  return { viewer: w?.GLOBE?.MAP?.viewer, C: w?.Cesium };
}

// globe 内の GSI 管理オブジェクト(2D の gsiApp 相当)への薄いアクセス
function globeMl() { return frame.contentWindow?.GSI?.GLOBALS?.mapLayerList || null; }
function globeLj() { return frame.contentWindow?.GSI?.GLOBALS?.layersJSON || null; }
// 現在の globe ベースレイヤ(tileList 内の _isBaseLayer エントリ)
function globeBaseLayerInfo() {
  return (globeMl()?.tileList || []).find(i => i._isBaseLayer) || null;
}
// カタログ(layersHash/getBase)からベースマップ info を引く。
// 2D 側の "ort" は globe カタログでは seamlessphoto 相当のためフォールバックする
function globeBaseInfo(key) {
  const lj = globeLj();
  const k = String(key ?? "").trim();
  if (!lj || !k) return null;
  const hash = lj.layersHash || {};
  const bases = (typeof lj.getBase === "function" ? lj.getBase() : null) || [];
  const find = id => hash[id] || bases.find(b => b.id === id)
    || Object.values(hash).find(i => i.id === id || i.title === id) || null;
  const info = find(k) || (k === "ort" ? find("seamlessphoto") : null);
  return info?.url ? info : null;
}

// 前の globe viewer へ注入した参照を掃除する(reload 後は旧参照が死んでいる)
function clearGlobeRefs() {
  for (const e of layerEntries) { e._globeDs = null; e._globeImagery = null; }
  for (const e of baseEntries) e._globeImagery = null;
}

function removeGlobeEntry(entry) {
  const { viewer } = globeApis();
  if (entry._globeDs) { try { viewer?.dataSources.remove(entry._globeDs, true); } catch (_) {} entry._globeDs = null; }
  if (entry._globeImagery) { try { viewer?.imageryLayers.remove(entry._globeImagery, true); } catch (_) {} entry._globeImagery = null; }
}

// Globe ページの viewer 生成を待って現在のレイヤを注入する。
// viewer が前回注入時と別物(= globe が自前で reload した)なら再注入する
function maybeInjectGlobeLayers() {
  const { viewer, C } = globeApis();
  if (!viewer || !C || globeInjectedFor === viewer) return;
  globeInjectedFor = viewer;
  clearGlobeRefs();
  wireGlobeHandlers(viewer, C);
  void injectGlobeLayers();
}

// globe 側イベント: 地物クリック → 属性タブ、camera moveEnd → viewportQuery 再読込
function wireGlobeHandlers(viewer, C) {
  try {
    const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(ev => {
      const picked = viewer.scene.pick(ev.position);
      const ent = picked?.id?.properties ? picked.id
        : (picked?.primitive?.id?.properties ? picked.primitive.id : null);
      if (!ent) return;
      const owner = layerEntries.find(e => e._globeDs?.entities?.contains?.(ent));
      if (!owner) return;
      let props = {};
      try { props = ent.properties.getValue(C.JulianDate.now()) || {}; } catch (_) {}
      showFeatureAttrs(props, splitKascTitle(owner.item.title).title || owner.item.title);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  } catch (_) { /* クリック配線失敗は表示自体を妨げない */ }
  try { viewer.camera.moveEnd.addEventListener(scheduleViewportReload); } catch (_) {}
}

async function injectGlobeLayers() {
  const { viewer, C } = globeApis();
  if (!viewer || !C) { globeInjectedFor = null; return; }
  // ベースはレイヤ読込を待たず先に確定する(GSIベースは globe 側 setBaseLayer、
  // 外部タイルは自前 imagery。遅い duckdb 等の mount で遅延しないよう先に呼ぶ)
  applyBaseSelection();
  for (const e of layerEntries) {
    try { await mountGlobeEntry(e); }
    catch (err) { console.warn("[globe] inject:", e.item.title, err); }
  }
}

async function mountGlobeEntry(e, preloaded) {
  const item = e.item;
  if (e._globeDs || e._globeImagery) return;
  const on = item.visible !== false;
  if (VECTOR_TYPES.has(item.type)) {
    if (!item._geojson) {
      const result = preloaded?.geojson ? { geojson: preloaded.geojson } : await loadVectorItem(item, lastBaseUrl);
      item._geojson = result.geojson;
      item._env = geojsonExtent(result.geojson) || null;
      if (result.viewportQuery) item._viewportQuery = true;
      if (item.opts?.style) e._qmlPending = true; // QML→_props 変換は未対応
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

// ---- Globe カメラ/ビュー操作 ----
// globe 表示中は gmap(2D Leaflet)が死んでいるため、Canvas 側の視点操作は
// Cesium カメラへ変換して橋渡しする。高度は .kasc cam/URL ビューと同じ換算式
function globeFlyTo(view = {}) {
  const { viewer, C } = globeApis();
  if (!viewer || !C) return false;
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
  const cam = viewer.camera;
  const carto = cam.positionCartographic;
  const lat = Number.isFinite(num(view.latitude)) ? num(view.latitude) : C.Math.toDegrees(carto.latitude);
  const lon = Number.isFinite(num(view.longitude)) ? num(view.longitude) : C.Math.toDegrees(carto.longitude);
  const height = Number.isFinite(num(view.height)) ? num(view.height)
    : (Number.isFinite(num(view.zoom)) ? zoomToCamHeight(lat, num(view.zoom)) : carto.height);
  const heading = Number.isFinite(num(view.heading)) ? num(view.heading) : C.Math.toDegrees(cam.heading);
  const pitch = Number.isFinite(num(view.pitch)) ? num(view.pitch) : C.Math.toDegrees(cam.pitch);
  try {
    const destination = C.Cartesian3.fromDegrees(lon, lat, Math.max(10, height));
    const orientation = {
      heading: C.Math.toRadians(heading),
      pitch: C.Math.toRadians(pitch),
      roll: C.Math.toRadians(Number.isFinite(num(view.roll)) ? num(view.roll) : 0),
    };
    // instant=フライパス巡回等の高頻度更新。flyTo の逐次再起動を避け即時配置する
    if (view.instant) cam.setView({ destination, orientation });
    else cam.flyTo({ destination, orientation });
    return true;
  } catch (_) { return false; }
}

function globeViewInfo() {
  const { viewer, C } = globeApis();
  if (!viewer || !C) return null;
  const cam = viewer.camera;
  const carto = cam.positionCartographic;
  const latitude = C.Math.toDegrees(carto.latitude);
  const longitude = C.Math.toDegrees(carto.longitude);
  const height = carto.height;
  return {
    latitude, longitude, height,
    zoom: camToZoom({ latitude, height }),
    heading: C.Math.toDegrees(cam.heading),
    // getCamera() は pitchDeg-90 を .kasc pitch として返すため +90 で補正する
    pitchDeg: C.Math.toDegrees(cam.pitch) + 90,
  };
}

function globeFitBounds(w, s, e, n) {
  const { viewer, C } = globeApis();
  if (!viewer || !C) return false;
  try {
    viewer.camera.flyTo({ destination: C.Rectangle.fromDegrees(w, s, e, n) });
    return true;
  } catch (_) { return false; }
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
  // 地物クリック → 親の属性タブへ(Leaflet 版と同じ導線)。
  // G.GeoJSON は gsimaps 独自ラッパーで eachLayer を持たず、内部の実
  // L.GeoJSON は this.layer に格納されるため、それ経由で付与する
  try {
    const inner = layer.layer || layer;
    if (typeof inner.eachLayer === "function") {
      inner.eachLayer(l => l.on?.("click", () =>
        showFeatureAttrs(l.feature?.properties || {}, splitKascTitle(item.title).title || item.title)));
    }
  } catch (_) { /* クリック付与失敗は表示自体を妨げない */ }
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
  const layerOpts = {
    minZoom: opts.minzoom ? Number(opts.minzoom) : undefined,
    maxZoom: opts.maxzoom ? Number(opts.maxzoom) : undefined,
    attribution: layerAttribution(item) || "",
    opacity: opts.opacity != null ? Number(opts.opacity) : 1,
    // base 行は GSI タイルと同じ低 zIndex、オーバーレイはその上
    zIndex: item.type === "base" ? 1 : 10,
  };
  // undefined だと Leaflet 既定値('abc')を undefined で上書きし _getSubdomain が
  // 落ちるため、値がある時だけ渡す
  if (opts.subdomains) layerOpts.subdomains = String(opts.subdomains);
  return w.L.tileLayer(tileUrlOf(item), layerOpts);
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
  const env = entry.item._env || (entry.item._geojson && geojsonExtent(entry.item._geojson));
  if (globeMode) {
    if (env) globeFitBounds(env.west, env.south, env.east, env.north);
    return;
  }
  if (!gmap) return;
  if (env) gmap.fitBounds([[env.south, env.west], [env.north, env.east]], { padding: [40, 40] });
  else if (entry.sakuzu?._layer?.getBounds) {
    try { const b = entry.sakuzu._layer.getBounds(); if (b?.isValid?.()) gmap.fitBounds(b, { padding: [40, 40] }); } catch (_) {}
  }
}

async function mountEntry(entry, preloaded) {
  const item = entry.item;
  if (globeMode) { await mountGlobeEntry(entry, preloaded); return; }
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
  removeGlobeEntry(entry);
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
  if (globeMode) {
    removeGlobeEntry(entry);
    await mountGlobeEntry(entry);
    if (!wasVisible) entry.item.visible = false;
    applyEntryVisibility(entry);
    return;
  }
  entry.sakuzu = injectSakuzuLayer(entry.item, result.geojson);
  if (!wasVisible) entry.sakuzu.setVisible(false);
}

function viewBounds() {
  if (globeMode) {
    const { viewer, C } = globeApis();
    try {
      const r = viewer?.camera.computeViewRectangle();
      if (r) {
        return {
          west: C.Math.toDegrees(r.west), south: C.Math.toDegrees(r.south),
          east: C.Math.toDegrees(r.east), north: C.Math.toDegrees(r.north),
        };
      }
    } catch (_) { /* 範囲取得失敗時は全件読込へフォールバック */ }
    return null;
  }
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
function showFeatureAttrs(props, title) {
  const el = attrContentEl();
  if (!el) return;
  const clean = {};
  for (const [k, v] of Object.entries(props || {})) if (!k.startsWith("_")) clean[k] = v;
  renderAttrContent(el, [{ title: title || null, entries: attrEntriesFromProps(clean) }]);
}

function focusFeatureExtent(feature) {
  const env = geojsonExtent({ type: "FeatureCollection", features: feature ? [feature] : [] });
  if (globeMode) {
    if (env) globeFitBounds(env.west, env.south, env.east, env.north);
    return;
  }
  if (!gmap) return;
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
  if (globeMode) {
    globeFlyTo({
      latitude: Number(cam.latitude), longitude: Number(cam.longitude),
      height: Number.isFinite(cam.height) ? cam.height : undefined,
      zoom: Number.isFinite(cam.zoom) ? cam.zoom : undefined,
      heading: cam.heading, pitch: cam.pitch,
    });
    return;
  }
  if (!gmap) return;
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
      if (!Number.isFinite(hit.latitude)) return;
      if (globeMode) {
        globeFlyTo({ latitude: hit.latitude, longitude: hit.longitude, zoom: Math.max(globeViewInfo()?.zoom || 0, 14) });
        return;
      }
      if (gmap) gmap.setView([hit.latitude, hit.longitude], Math.max(gmap.getZoom(), 14));
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
  const sel = document.getElementById("basemap-select");
  const idx = Number(sel?.value ?? -1);
  baseHidden = idx < 0;
  if (globeMode) { applyGlobeBaseSelection(idx); return; }
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

// globe 中のベース切替: GSI カタログにあるベースは globe 標準の setBaseLayer で
// 差し替え、それ以外(外部タイル)は globe ベースを隠して自前 imagery を最下段へ、
// 「なし」選択時はベース imagery を非表示にする
function applyGlobeBaseSelection(idx) {
  const { viewer } = globeApis();
  const layers = viewer?.imageryLayers;
  const ml = globeMl();
  if (!layers) return;
  if (!ml) {
    // mapLayerList は globe 側の layersJSON 読込完了まで遅延生成されるため再試行する
    setTimeout(() => { if (globeMode) applyBaseSelection(); }, 800);
    return;
  }
  for (const e of baseEntries) if (e._globeImagery) e._globeImagery.show = false;
  const active = baseEntries[idx];
  const gsiInfo = !baseHidden && active?.gsiId ? globeBaseInfo(active.gsiId) : null;
  if (gsiInfo) {
    try {
      const cur = globeBaseLayerInfo();
      if (cur?.id !== gsiInfo.id || cur?._visibleInfo?.layer?.show === false) ml.setBaseLayer(gsiInfo);
      const nb = globeBaseLayerInfo();
      if (nb?._visibleInfo?.layer) nb._visibleInfo.layer.show = true;
    } catch (err) { console.warn("[globe] setBaseLayer:", err); }
    return;
  }
  const cur = globeBaseLayerInfo();
  if (cur?._visibleInfo?.layer) cur._visibleInfo.layer.show = false;
  if (!baseHidden && active?.item?.url) {
    if (!active._globeImagery) {
      try {
        active._globeImagery = addGlobeImagery(active.item);
        if (active._globeImagery) layers.lowerToBottom(active._globeImagery);
      } catch (err) { console.warn("[globe] base:", err); }
    }
    if (active._globeImagery) active._globeImagery.show = true;
  }
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
    removeGlobeEntry(e);
  }
  layerEntries = [];
  for (const e of baseEntries) {
    if (e.tileLayer && gmap?.hasLayer(e.tileLayer)) gmap.removeLayer(e.tileLayer);
    if (e._globeImagery) {
      try { globeApis().viewer?.imageryLayers.remove(e._globeImagery, true); } catch (_) {}
      e._globeImagery = null;
    }
  }
  baseEntries = [];
  currentUnsupported = [];
  flyPathItems = [];
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
  // fly_geojson: はフライパスとして扱う（未対応警告には出さない）
  flyPathItems = doc.unsupported.filter(i => i.type === "fly_geojson");
  currentUnsupported = doc.unsupported.filter(i => i.type !== "fly_geojson");
  lastBaseUrl = baseUrl || lastBaseUrl;

  // base: 行（GSI は select 項目として登録、外部タイルも同様）
  for (const item of doc.bases) {
    const gsiId = gsiBaseIdFromUrl(item.url);
    const entry = { item, gsiId, tileLayer: null };
    baseEntries.push(entry);
  }
  // base 行の外部タイル分は作成のみ（表示は applyBaseSelection が制御）
  // globe 中は Leaflet が無いため tileLayer は作らず imagery 側へ委ねる
  for (const e of baseEntries) {
    if (e.gsiId || e.item.mode || globeMode) continue; // transparent/none はタイル無し
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
  // info: → 外部HTMLを情報タブへ埋め込み（全エンジン共通のローダ）
  void loadKascInfoContent(document.getElementById("info-link"), doc.info, baseUrl);
  // 凡例（URL 重複はまとめる）→ 凡例タブ。他エンジン(Leaflet等)と同じ処理
  const legendsBox = document.getElementById("legends");
  legendsBox?.replaceChildren();
  const seenLegend = new Set();
  for (const lg of doc.legends || []) {
    if (!lg.url || seenLegend.has(lg.url)) continue;
    seenLegend.add(lg.url);
    const img = document.createElement("img");
    img.src = resolveKascUrl(lg.url, baseUrl);
    img.alt = lg.title || "凡例";
    img.style.maxWidth = "100%";
    legendsBox?.append(img);
  }
  if (!seenLegend.size && legendsBox) legendsBox.textContent = "（凡例なし）";

  // 初回表示: URL/cam 指定が無ければデータ範囲へフィット
  if (!noFit) {
    const env = layerEntries.map(e => e.item._env).find(Boolean);
    if (env) {
      if (globeMode) globeFitBounds(env.west, env.south, env.east, env.north);
      else if (gmap) gmap.fitBounds([[env.south, env.west], [env.north, env.east]], { padding: [40, 40] });
    }
  }
}

// ---- GSI 表示レイヤの取得・取り込み ----
// iframe 内 gsimaps の _mapLayerList(tileList=タイル系/list=ファイル系)を読み、
// Canvas レイヤ(xyz行)へ反映する。tileList は先頭=最前面のため、取り込みは
// 末尾から mount して積み順を再現する。
// globe 中は gsiApp 参照が死んでいるため、同名構造を持つ GSI.GLOBALS 側を使う
const gsiMl = () => globeMode ? globeMl() : gsiApp?._mainMap?._mapLayerList;
const gsiLj = () => globeMode ? globeLj() : gsiApp?._mainMap?._layersJSON;

// カタログ/表示中レイヤの info が .kasc の xyz: 行で表現できるかを判定する
function gsiTileImportable(info) {
  const url = String(info?.url || "");
  // ベースマップフォルダ(layerBaseFolderSYS)の子は gsimaps のベース切替対象で、
  // オーバーレイ取り込みするとベースと二重描画になるため対象外とする
  const isBase = globeMode
    ? (!!info?._isBaseLayer || !!frame.contentWindow?.GSI?.GLOBALS?.isBaseLayer?.(info))
    : (info.parent && info.parent.title_sys === frame.contentWindow?.CONFIG?.layerBaseFolderSYS);
  if (isBase) return { importable: false, reason: "ベースマップレイヤ(setGsiBasemap で切替)" };
  if (info._isComparePhoto) return { importable: false, reason: "時系列表示レイヤは取り込めません" };
  if (info.layerType === "kml" || /\.kml(\?|$)/i.test(url)) return { importable: false, reason: "KML レイヤは.kascで表現できません" };
  if (/\{z\}/i.test(url) && /\.(png|jpe?g|webp|gif|avif)(\?.*)?$/i.test(url)) return { importable: true, reason: "" };
  if (/\{z\}/i.test(url)) return { importable: false, reason: "ベクタ系タイル(geojson等)は.kascのxyz行で表現できません" };
  return { importable: false, reason: "タイルURLではないため取り込めません" };
}

function gsiDisplayedLayers() {
  const ml = gsiMl();
  if (!ml) return [];
  const rows = [];
  const readInfo = (info, kind) => {
    const vi = info._visibleInfo || {};
    // プロトコル相対を https へ正規化(.kasc へ書き出す形に揃える)
    const url = String(info.url || "").replace(/^\/\//, "https://");
    const { importable, reason } = gsiTileImportable(info);
    const imported = layerEntries.some(e => e.item._gsiId === info.id || (url && e.item.url === url));
    return {
      id: info.id || "", title: String(info.title || info.id || ""), kind, url,
      importable, reason, imported,
      visible: !vi._isHidden,
      opacity: Number.isFinite(vi.opacity) ? vi.opacity : 1,
      minZoom: info.minZoom, maxZoom: info.maxZoom,
      legendUrl: info.legendUrl || "", outside: !!info._isOutside,
      subdomains: String(info.subdomains || info.subdmains || ""),
      attribution: String(info.attribution || ""),
    };
  };
  for (const info of ml.tileList || []) rows.push(readInfo(info, "tile"));
  for (const info of ml.list || []) rows.push(readInfo(info, "file"));
  return rows;
}

function gsiLayerAttr(l) {
  if (l.attribution) return l.attribution;
  if (/(maps|cyberjapandata)\.gsi\.go\.jp/i.test(l.url)) return "国土地理院";
  return "";
}

// 表示中レイヤを Canvas レイヤ+インスペクタ(.kasc)へ反映。
// ids 省略時は取込可能な全レイヤ。同一 id/URL の既存レイヤはスキップする
async function importGsiLayers({ ids = null } = {}) {
  const wanted = gsiDisplayedLayers().filter(l => !ids?.length || ids.includes(l.id) || ids.includes(l.title));
  if (!wanted.length) return { ok: false, message: "対象レイヤが見つかりません(地理院地図側でレイヤが表示されていない、または id/タイトルが不一致)", imported: [], skipped: [], unsupported: [], failed: [] };
  const unsupported = wanted.filter(l => !l.importable).map(l => ({ id: l.id, title: l.title, reason: l.reason }));
  const skipped = wanted.filter(l => l.importable && l.imported).map(l => ({ id: l.id, title: l.title, reason: "取り込み済み" }));
  const imported = [], failed = [], lines = [];
  for (const l of wanted.filter(l => l.importable && !l.imported).slice().reverse()) {
    const title = l.title.replace(/\|/g, "/");
    const opts = {};
    if (Number.isFinite(l.minZoom)) opts.minzoom = l.minZoom;
    if (Number.isFinite(l.maxZoom)) opts.maxzoom = l.maxZoom;
    if (l.opacity < 1) opts.opacity = l.opacity;
    if (l.subdomains) opts.subdomains = l.subdomains;
    const attr = gsiLayerAttr(l); if (attr) opts.attr = attr;
    const item = { type: "xyz", title, url: l.url, opts, visible: l.visible, _gsiId: l.id, _idx: 1e9 + layerEntries.length };
    const entry = { item, pending: true };
    layerEntries.push(entry);
    try {
      await mountEntry(entry);
      applyEntryVisibility(entry);
      entry.pending = false;
      imported.push({ id: l.id, title });
      const optStr = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(" | ");
      lines.push(`xyz:${title} | ${l.url}${optStr ? ` | ${optStr}` : ""}${l.visible ? "" : " | off"}`);
    } catch (err) {
      layerEntries.splice(layerEntries.indexOf(entry), 1);
      failed.push({ id: l.id, title, reason: String(err?.message || err) });
    }
  }
  if (lines.length) {
    inspectorInput.value = `${String(inspectorInput.value || "").replace(/\s*$/, "")}\n${lines.join("\n")}\n`;
  }
  renderLayerRows();
  const parts = [`${imported.length}件取り込み`];
  if (skipped.length) parts.push(`${skipped.length}件スキップ(取込済み)`);
  if (unsupported.length) parts.push(`${unsupported.length}件未対応`);
  if (failed.length) parts.push(`${failed.length}件失敗`);
  return { ok: imported.length > 0 || skipped.length > 0, imported, skipped, unsupported, failed, message: parts.join("・") };
}

// ---- GSI 表示レイヤの操作(透過/並べ替え/削除) ----
// tileList/list の info オブジェクトを id またはタイトルで引く
function gsiFindLayerInfo(key) {
  const ml = gsiMl();
  const k = String(key ?? "").trim();
  if (!ml || !k) return null;
  for (const arr of [ml.tileList || [], ml.list || []]) {
    const hit = arr.find(i => i.id === k) || arr.find(i => i.title === k);
    if (hit) return hit;
  }
  return null;
}

function gsiIsBaseInfo(info) {
  if (globeMode) {
    return !!info?._isBaseLayer || !!frame.contentWindow?.GSI?.GLOBALS?.isBaseLayer?.(info);
  }
  return !!info?.parent && info.parent.title_sys === frame.contentWindow?.CONFIG?.layerBaseFolderSYS;
}

// 透過率設定は表示中レイヤーパネルのスライダと同じ経路
// (ベースフォルダの子は _baseLayer.setOpacity、それ以外は layer.setOpacity。
//  globe 側は ImageryLayer.alpha を直接書き換える)
function setGsiLayerOpacity(key, opacity) {
  const ml = gsiMl();
  const info = gsiFindLayerInfo(key);
  if (!ml || !info) return { ok: false, reason: "notFound" };
  const op = Math.min(1, Math.max(0, Number(opacity)));
  if (!Number.isFinite(op)) return { ok: false, reason: "invalid" };
  if (globeMode) {
    if (info._visibleInfo?.layer) info._visibleInfo.layer.alpha = op;
  } else if (gsiIsBaseInfo(info)) gsiApp?._mainMap?._baseLayer?.setOpacity(op);
  else if (info._visibleInfo?.layer?.setOpacity) info._visibleInfo.layer.setOpacity(op);
  else if (info._visibleInfo?.layer && frame.contentWindow?.GSI?.LayerOpacitySetter) {
    new frame.contentWindow.GSI.LayerOpacitySetter().setOpacity(info._visibleInfo.layer, op);
  }
  if (info._visibleInfo) info._visibleInfo.opacity = op;
  ml.fire("change");
  return { ok: true, opacity: op };
}

// tileList 先頭=最前面。position は top/front・bottom/back・up・down・数値index
function moveGsiLayer(key, position) {
  const ml = gsiMl();
  const info = gsiFindLayerInfo(key);
  const arr = ml?.tileList;
  if (!arr || !info) return { ok: false, reason: "notFound" };
  const idx = arr.indexOf(info);
  if (idx < 0) return { ok: false, reason: "notTile" };
  let to = idx;
  const p = String(position ?? "").toLowerCase();
  if (p === "top" || p === "front") to = 0;
  else if (p === "bottom" || p === "back") to = arr.length - 1;
  else if (p === "up") to = Math.max(0, idx - 1);
  else if (p === "down") to = Math.min(arr.length - 1, idx + 1);
  else {
    const n = Number(position);
    if (Number.isFinite(n)) to = Math.min(arr.length - 1, Math.max(0, Math.round(n)));
  }
  if (to !== idx) { arr.splice(idx, 1); arr.splice(to, 0, info); ml._initZIndex?.(arr); }
  ml.fire("change");
  return { ok: true, index: to };
}

function removeGsiLayer(key) {
  const ml = gsiMl();
  const info = gsiFindLayerInfo(key);
  if (!ml || !info) return { ok: false, reason: "notFound" };
  if (gsiIsBaseInfo(info)) return { ok: false, reason: "baseLayer" };
  ml.remove(info);
  return { ok: true };
}

// ---- GSI レイヤカタログ(layersJSON)検索・直接追加 ----
// layersHash は id → カタログ info の辞書。url を持たない LayerGroup 節は除外する
function gsiCatalogIds() {
  const ml = gsiMl();
  return new Set([...(ml?.tileList || []), ...(ml?.list || [])].map(i => i.id));
}
function gsiConfirmIds() {
  const cc = frame.contentWindow?.CONFIG?.CONFIRM_LAYERS || {};
  const ids = new Set();
  for (const c of Object.values(cc)) for (const id of c?.layers || []) ids.add(id);
  return ids;
}

// info/グループノードの祖先フォルダ名を含む検索用文字列。
// 「珠洲地区（1/2撮影）」のような地区名だけの災害レイヤも
// 親フォルダ名(令和6年(2024年)能登半島地震)で絞り込めるようにする
function gsiPathText(info) {
  if (info._gsiPathText) return info._gsiPathText;
  const parts = [String(info.id || ""), String(info.title || ""), String(info.src || "")];
  let p = info.parent, guard = 0;
  while (p && guard++ < 8) { if (p.title) parts.push(String(p.title)); p = p.parent; }
  return (info._gsiPathText = parts.join(" ").toLowerCase());
}

// トピックファイル等の src 参照 LayerGroup はツリー展開まで entries を持たず
// layersHash にも登録されない(例: 令和6年能登半島地震=layers_20240102noto.txt)。
// 未ロード群は _data ツリー内にあり、src を読んで _initializeTree すると
// layersHash へ登録される。matchFn 指定時はパス文字列が一致するグループのみ読む
async function gsiLoadLazyGroups(matchFn = null) {
  const lj = gsiLj();
  if (!lj) return 0;
  const cache = frame.contentWindow?.GSI?.GLOBALS?.layersJSONCache;
  const doneUrls = new Set();
  let loaded = 0;
  for (let iter = 0; iter < 8; iter++) {
    const pending = new Map(); // url → node(同一srcの重複定義を除外)
    const walk = nodes => (nodes || []).forEach(n => {
      if (!n || typeof n !== "object") return;
      if (n.entries) walk(n.entries);
      else if (n.src && !n._gsiLazyDone && (!matchFn || matchFn(gsiPathText(n)))) {
        // src_url は "./layers_txt/xxx.txt" のような相対指定なので frame.src 基準で解決する
        const base = new URL(String(n.src_url || "."), frame.src).href;
        const url = new URL(n.src, base).href;
        if (!doneUrls.has(url)) pending.set(url, n);
      }
    });
    walk(lj._data);
    walk(lj.tree);
    if (!pending.size) break;
    await Promise.all([...pending].map(async ([url, g]) => {
      g._gsiLazyDone = true;
      doneUrls.add(url);
      try {
        let text = cache?.[url] ?? cache?.[g.src] ?? null;
        if (text == null) {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) return;
          text = await res.text();
        }
        const json = JSON.parse(text);
        if (!Array.isArray(json?.layers)) return;
        json.layers.forEach(l => { l.parent = g; l.src_url = g.src_url; });
        g.entries = json.layers;
        lj._initializeTree(g.entries, g);
        loaded++;
      } catch (_) { /* 読み込めない src はスキップ */ }
    }));
  }
  return loaded;
}

// filter 指定時はパス文字列が一致する遅延トピック群を読み込んでから絞り込む
async function listGsiCatalog(filter) {
  const q = String(filter || "").toLowerCase().trim();
  if (q) await gsiLoadLazyGroups(path => path.includes(q));
  const hash = gsiLj()?.layersHash || {};
  const active = gsiCatalogIds(), confirm = gsiConfirmIds();
  const out = [];
  let total = 0;
  for (const info of Object.values(hash)) {
    if (!info?.url) continue;
    if (q && !gsiPathText(info).includes(q)) continue;
    total++;
    if (out.length < 100) out.push({
      id: info.id || "", title: String(info.title || info.id || ""),
      url: String(info.url || "").replace(/^\/\//, "https://"), layerType: info.layerType || "tile",
      legendUrl: info.legendUrl || "", cocotile: !!info.cocotile,
      active: active.has(info.id), needsConfirm: confirm.has(info.id),
    });
  }
  return { total, truncated: total > out.length, layers: out };
}

// レイヤツリーを開かずカタログ info を _mapLayerList.append へ直接登録。
// noFinishMove=true で自動フィットを抑止(AIは flyTo で制御)。
// CONFIRM_LAYERS 該当は確認ダイアログが出るため未追加として confirmPending を返す
async function addGsiLayer(key, { hidden = false } = {}) {
  const lj = gsiLj();
  const ml = gsiMl();
  if (!lj || !ml) return { ok: false, reason: "unavailable" };
  const k = String(key ?? "").trim();
  const find = () => {
    const hash = lj.layersHash || {};
    return hash[k] || Object.values(hash).find(i => i.title === k && i.url) || null;
  };
  let info = find();
  if (!info?.url) { await gsiLoadLazyGroups(); info = find(); }
  if (!info?.url) {
    // 見つからない場合は類似候補を提示する。括弧書きと空白を除去した
    // 正規化文字列で部分一致し、半分以上のトークンが当たるものを上位8件返す
    const norm = s => String(s).replace(/[（(].*?[）)]/g, "").replace(/\s+/g, "").toLowerCase();
    const toks = k.split(/\s+/).map(norm).filter(t => t.length >= 2);
    const candidates = toks.length ? Object.values(lj.layersHash || {})
      .filter(i => i?.url)
      .map(i => ({ i, m: toks.filter(t => norm(gsiPathText(i)).includes(t)).length }))
      .filter(x => x.m > 0 && x.m / toks.length >= 0.5)
      .sort((a, b) => b.m - a.m)
      .slice(0, 8).map(x => ({ id: x.i.id, title: String(x.i.title || x.i.id) })) : [];
    return { ok: false, reason: "notFound", candidates };
  }
  if (ml.exists(info)) return { ok: true, already: true, id: info.id, title: info.title };
  ml.append(info, true, hidden);
  return ml.exists(info)
    ? { ok: true, id: info.id, title: info.title }
    : { ok: false, confirmPending: true, id: info.id, title: info.title,
        reason: "確認ダイアログ保留中です(地理院地図側の確認を承認してください)" };
}

// ---- GSI ベースマップ(地図の種類)の取得・切替 ----
// カタログは _layersJSON.getBase()(layers0.txt=ベースマップフォルダ相当)。
// _baseLayer.setActiveId が表示切替。.kasc への永続化は base: 行で行う
function gsiBasemapEntries() {
  const lj = gsiLj();
  const list = (typeof lj?.getBase === "function" ? lj.getBase() : null)
    || gsiBase()?.baseLayerList || [];
  const activeId = globeMode
    ? (globeBaseLayerInfo()?.id ?? null)
    : (() => { try { return gsiBase()?.getActiveId() ?? null; } catch (_) { return null; } })();
  const selIdx = Number(document.getElementById("basemap-select")?.value ?? -1);
  const selectedGsiId = !baseHidden && selIdx >= 0 ? baseEntries[selIdx]?.gsiId || null : null;
  return list.filter(b => b?.id && b.url).map(b => ({
    id: String(b.id), title: String(b.title || b.id),
    // プロトコル相対(//host)を https へ正規化して返す(.kasc・file:// でも解決できる形)
    url: String(b.url).replace(/^\/\//, "https://"),
    maxNativeZoom: b.maxNativeZoom,
    active: b.id === activeId,
    selected: b.id === selectedGsiId,
    imported: baseEntries.some(e => e.gsiId === b.id),
  }));
}

// .kasc 記述用の地理院タイルURL。プロトコル相対を https 化し、ホストは
// 既存 .kasc/geo_webview 出力と同じ cyberjapandata 側へ寄せ、
// キャッシュキー(?_=)は落とす
function gsiKascBaseUrl(url) {
  return String(url).split("?")[0]
    .replace(/^\/\//, "https://")
    .replace("://maps.gsi.go.jp", "://cyberjapandata.gsi.go.jp");
}

// id/タイトルで地理院地図のベースマップを切替え、対応する base: 行を
// .kasc へ反映する(無ければ追記)。他エンジンへ切り替えても同じベースが再現される
function setGsiBasemap(key) {
  const k = String(key ?? "").trim();
  // globe 中は globe 標準の setBaseLayer で切替え、base: 行の追記は 2D と共通
  if (globeMode) {
    const info = globeBaseInfo(k);
    if (!info) return { ok: false, reason: "notFound", message: `ベースマップ「${k}」が見つかりません(listGsiBasemaps で id/タイトルを確認)` };
    const ml = globeMl();
    if (!ml) return { ok: false, reason: "unavailable" };
    try { ml.setBaseLayer(info); } catch (err) { return { ok: false, reason: String(err?.message || err) }; }
    const b = { id: info.id, title: String(info.title || info.id), url: gsiKascBaseUrl(info.url) };
    let added = false;
    let idx = baseEntries.findIndex(e => e.gsiId === b.id);
    if (idx < 0) {
      baseEntries.push({ item: { type: "base", title: b.title, url: b.url, opts: {}, _idx: 1e9 + baseEntries.length }, gsiId: b.id, tileLayer: null });
      idx = baseEntries.length - 1;
      inspectorInput.value = `${String(inspectorInput.value || "").replace(/\s*$/, "")}\nbase:${b.title.replace(/\|/g, "/")} | ${b.url} | 出典：国土地理院\n`;
      added = true;
      rebuildBasemapSelect();
    }
    const gsel = document.getElementById("basemap-select");
    if (gsel) gsel.value = String(idx);
    baseHidden = false;
    applyBaseSelection();
    return { ok: true, id: b.id, title: b.title, added, active: globeBaseLayerInfo()?.id ?? null };
  }
  const b = gsiBasemapEntries().find(x => x.id === k || x.title === k);
  if (!b) return { ok: false, reason: "notFound", message: `ベースマップ「${k}」が見つかりません(listGsiBasemaps で id/タイトルを確認)` };
  let added = false;
  let idx = baseEntries.findIndex(e => e.gsiId === b.id);
  if (idx < 0) {
    const url = gsiKascBaseUrl(b.url);
    baseEntries.push({ item: { type: "base", title: b.title, url, opts: {}, _idx: 1e9 + baseEntries.length }, gsiId: b.id, tileLayer: null });
    idx = baseEntries.length - 1;
    inspectorInput.value = `${String(inspectorInput.value || "").replace(/\s*$/, "")}\nbase:${b.title.replace(/\|/g, "/")} | ${url} | 出典：国土地理院\n`;
    added = true;
    rebuildBasemapSelect();
  }
  const sel = document.getElementById("basemap-select");
  if (sel) sel.value = String(idx);
  baseHidden = false;
  applyBaseSelection();
  let active = null;
  try { active = gsiBase()?.getActiveId() ?? null; } catch (_) { /* 未到達時は null */ }
  return { ok: true, id: b.id, title: b.title, added, active };
}

// ---- GSI カタログから .kasc への直接取り込み ----
// GSI 側に表示していなくても、カタログ(layersHash)の info から xyz: 行を
// 生成して Canvas レイヤ＋インスペクタへ反映する。
// 表示中レイヤの取り込みは importGsiLayers、こちらはカタログ直接版
async function importGsiCatalog({ ids = null } = {}) {
  let wanted = Object.values(gsiLj()?.layersHash || {})
    .filter(i => i?.url && (!ids?.length || ids.includes(i.id) || ids.includes(i.title)));
  if (!wanted.length) {
    // 遅延ロードのトピック群(src参照)を読み込んで再検索
    await gsiLoadLazyGroups();
    wanted = Object.values(gsiLj()?.layersHash || {})
      .filter(i => i?.url && (!ids?.length || ids.includes(i.id) || ids.includes(i.title)));
  }
  if (!wanted.length) return { ok: false, message: "対象レイヤが見つかりません(listGsiCatalog で id/タイトルを確認)", imported: [], skipped: [], unsupported: [], failed: [] };
  const unsupported = [], skipped = [], imported = [], failed = [], lines = [];
  for (const info of wanted) {
    const url = String(info.url || "").replace(/^\/\//, "https://");
    const title = String(info.title || info.id || "");
    const chk = gsiTileImportable(info);
    if (!chk.importable) { unsupported.push({ id: info.id, title, reason: chk.reason }); continue; }
    if (layerEntries.some(e => e.item._gsiId === info.id || e.item.url === url)) { skipped.push({ id: info.id, title, reason: "取り込み済み" }); continue; }
    const opts = {};
    if (Number.isFinite(info.minZoom)) opts.minzoom = info.minZoom;
    if (Number.isFinite(info.maxZoom)) opts.maxzoom = info.maxZoom;
    const subs = String(info.subdomains || info.subdmains || ""); if (subs) opts.subdomains = subs;
    const attr = info.attribution || (/(maps|cyberjapandata)\.gsi\.go\.jp/i.test(url) ? "国土地理院" : "");
    if (attr) opts.attr = attr;
    const item = { type: "xyz", title: title.replace(/\|/g, "/"), url, opts, visible: true, _gsiId: info.id, _idx: 1e9 + layerEntries.length };
    const entry = { item, pending: true };
    layerEntries.push(entry);
    try {
      await mountEntry(entry);
      applyEntryVisibility(entry);
      entry.pending = false;
      imported.push({ id: info.id, title });
      const optStr = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(" | ");
      lines.push(`xyz:${item.title} | ${url}${optStr ? ` | ${optStr}` : ""}`);
    } catch (err) {
      layerEntries.splice(layerEntries.indexOf(entry), 1);
      failed.push({ id: info.id, title, reason: String(err?.message || err) });
    }
  }
  if (lines.length) {
    inspectorInput.value = `${String(inspectorInput.value || "").replace(/\s*$/, "")}\n${lines.join("\n")}\n`;
  }
  renderLayerRows();
  const parts = [`${imported.length}件取り込み`];
  if (skipped.length) parts.push(`${skipped.length}件スキップ(取込済み)`);
  if (unsupported.length) parts.push(`${unsupported.length}件未対応`);
  if (failed.length) parts.push(`${failed.length}件失敗`);
  return { ok: imported.length > 0 || skipped.length > 0, imported, skipped, unsupported, failed, message: parts.join("・") };
}

// ---- GSI 表示中レイヤの一時非表示/再表示 ----
// レイヤ解除(removeGsiLayer)とは別に、表示中レイヤーパネルの「非表示」
// チェックと同じ状態(_visibleInfo._isHidden + レイヤの着脱)を切り替える
function setGsiLayerHidden(key, hidden) {
  const ml = gsiMl();
  const info = gsiFindLayerInfo(key);
  if (!ml || !info) return { ok: false, reason: "notFound" };
  if (gsiIsBaseInfo(info)) return { ok: false, reason: "baseLayer" };
  const vi = info._visibleInfo;
  if (!vi?.layer) return { ok: false, reason: "notMounted" };
  const on = !hidden;
  vi._isHidden = !!hidden;
  if (globeMode) {
    // globe 側は imageryLayer._setVisible(show 切替)で着脱する
    if (vi.layer._setVisible) vi.layer._setVisible(globeApis().viewer, on);
    else vi.layer.show = on;
  } else {
    if (on && !gmap.hasLayer(vi.layer)) gmap.addLayer(vi.layer);
    else if (!on && gmap.hasLayer(vi.layer)) gmap.removeLayer(vi.layer);
  }
  ml.fire("change");
  return { ok: true, hidden: !!hidden };
}

// ---- GSI 作図の削除 ----
// listGsiSakuzu の index/タイトルで作図を削除する(Canvas管理レイヤ由来の
// ours=true は Canvas レイヤ側の操作に任せるため対象外)
function removeGsiSakuzu({ indices = null } = {}) {
  if (globeMode) return { ok: false, message: "Globe表示中は作図を操作できません。「2D地図に戻る」後に実行してください" };
  const wanted = gsiSakuzuItems().filter(s => !s.ours &&
    (!indices?.length || indices.includes(s.index) || indices.includes(s.title)));
  if (!wanted.length) return { ok: false, message: "対象の作図が見つかりません(Canvas管理レイヤ以外の作図がありません)", removed: [] };
  const removed = [];
  for (const s of wanted) {
    const item = sakuzu._list[s.index];
    if (!item) continue;
    removeSakuzuItem(item);
    removed.push({ index: s.index, title: s.title });
  }
  return { ok: removed.length > 0, removed, message: `${removed.length}件削除` };
}

// ---- 地理院DEMによる地点標高 ----
// 地理院地図の標高API(getelevation.php)を直接呼ぶ。elevation は m、
// source はメッシュ種別(例: 5mメッシュ（レーザ）)
async function getGsiElevation(latitude, longitude) {
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, reason: "invalid" };
  const u = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${encodeURIComponent(lon)}&lat=${encodeURIComponent(lat)}&outtype=JSON`;
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { ok: false, reason: `http ${r.status}` };
  const j = await r.json();
  return { ok: true, latitude: lat, longitude: lon, elevation: j?.elevation ?? null, source: j?.hsrc || "" };
}

// ---- gsi.go.jp 形式のビュークエリ(視点+ベース+表示レイヤ+disp) ----
// vendored gsimaps のリンク生成(getLinkUrl)と同じ組立を
// PageStateManager 経由で行い、共有URLと Globe 進入URLの両方に使う
function gsiViewQueryString() {
  const psm = gsiApp?._pageStateManager;
  if (!psm) return "";
  try {
    let qs = psm.getPositionQueryString() || "";
    if (qs !== "") qs += "/1/";
    for (const part of [
      psm.getBaseLayerQueryString?.(),
      psm.getLayersQueryString?.(),
      psm.getTileViewSetting?.(),
    ]) {
      if (part) qs += (qs !== "" ? "&" : "#") + part;
    }
    return qs;
  } catch (_) { return ""; }
}

// 現在の視点・ベース・表示中レイヤを maps.gsi.go.jp の URL で返す。
// リンクを実サイトで開くと同じ状態が再現される
function getGsiShareUrl() {
  // globe の iframe ハッシュはそのまま gsi.go.jp globe の permalink 形式
  if (globeMode) {
    const h = frame.contentWindow?.location?.hash || "";
    return h && h !== "#"
      ? { ok: true, url: `https://maps.gsi.go.jp/globe/index_globe.html${h}` }
      : { ok: false, reason: "unavailable" };
  }
  const qs = gsiViewQueryString();
  if (!qs) return { ok: false, reason: "unavailable" };
  return { ok: true, url: `https://maps.gsi.go.jp/${qs}` };
}

// Globe への進入/復帰。上流の「Globe」ボタンが組み立てるのと同じ
// ビュークエリを付けて enterGlobe へ渡す(vendor 側のwindow.openフックと同経路)
function setGsiGlobe(on) {
  if (on) {
    if (globeMode) return { ok: true, already: true, globe: true };
    const qs = gsiViewQueryString();
    // CONFIG.GLOBEURL("./globe/index_globe.html")はiframe内ロケーション基準
    const globe = frame.contentWindow?.CONFIG?.GLOBEURL || "./globe/index_globe.html";
    enterGlobe(`${globe}${qs || ""}`);
    return { ok: true, globe: true };
  }
  if (!globeMode) return { ok: true, already: true, globe: false };
  exitGlobe();
  return { ok: true, globe: false };
}

// ---- GSI 作図(sakuzu)の取り込み ----
// Canvas が注入した sakuzu item(entry.sakuzu と同一)は既存レイヤ扱いで除外。
// 取り込みは GeoJSON コピー(元の作図は二重描画防止で非表示化)。
// fileWrite 可能環境では DATA/ へ保存し geojson: 行として .kasc 永続化する
function gsiSakuzuItems() {
  // globe 中は sakuzu(2D側)参照が死んでいるため一覧は空を返す
  if (globeMode) return [];
  const ours = new Set(layerEntries.map(e => e.sakuzu).filter(Boolean));
  return (sakuzu?._list || []).map((item, i) => {
    let features = 0;
    try {
      const gj = item._layer?.toGeoJSON?.();
      features = gj?.type === "FeatureCollection" ? gj.features.length : (gj ? 1 : 0);
    } catch (_) { /* toGeoJSON 非対応の層は0件扱い */ }
    return {
      index: i, title: String(item.getTitle?.() || item._title || `作図${i + 1}`),
      fileName: String(item.getFileName?.() || ""), dataType: item.getDataType?.() ?? item._dataType,
      visible: !!item.getVisible?.(), features, ours: ours.has(item),
    };
  });
}

async function importGsiSakuzu({ indices = null } = {}) {
  if (globeMode) return { ok: false, message: "Globe表示中は取り込めません。「2D地図に戻る」後に実行してください" };
  const wanted = gsiSakuzuItems().filter(s => !s.ours &&
    (!indices?.length || indices.includes(s.index) || indices.includes(s.title)));
  if (!wanted.length) return { ok: false, message: "対象の作図が見つかりません(Canvas管理レイヤ以外の作図がありません)", imported: [], skipped: [], failed: [] };
  const imported = [], skipped = [], failed = [];
  for (const s of wanted) {
    const item = sakuzu._list[s.index];
    try {
      const gj = item?._layer?.toGeoJSON?.();
      const geojson = gj?.type === "Feature" ? { type: "FeatureCollection", features: [gj] } : gj;
      if (!geojson?.features?.length) { skipped.push({ index: s.index, title: s.title, reason: "地物なし" }); continue; }
      const title = s.title.replace(/\|/g, "/");
      let persistent = false;
      try {
        const name = `gsi_sakuzu_${s.index}_${Date.now().toString(36)}.geojson`;
        const saved = await window.kasugaiApi.saveDataFile(name, JSON.stringify(geojson));
        if (saved?.ok) {
          await window.kasugaiApi.addLayer(title, `DATA/${name}`, { type: "geojson" });
          persistent = true;
        }
      } catch (_) { /* fileWrite 不可環境は一時レイヤーへフォールバック */ }
      if (!persistent) await window.kasugaiApi.addDataLayer(title, geojson);
      try { item.setVisible(false); } catch (_) { /* 元作図の非表示化失敗は無視 */ }
      imported.push({ index: s.index, title, features: geojson.features.length, persistent });
    } catch (err) {
      failed.push({ index: s.index, title: s.title, reason: String(err?.message || err) });
    }
  }
  const parts = [`${imported.length}件取り込み`];
  if (skipped.length) parts.push(`${skipped.length}件スキップ`);
  if (failed.length) parts.push(`${failed.length}件失敗`);
  const sessionOnly = imported.length && imported.every(x => !x.persistent);
  return { ok: imported.length > 0 || skipped.length > 0, imported, skipped, failed,
    persistent: imported.some(x => x.persistent),
    message: parts.join("・") + (sessionOnly ? "（この環境では DATA/ 保存不可のため一時レイヤー。永続化はローカルサーバー版で）" : "") };
}

// ---- kasugaiApi（AI/外部制御） ----
function maybeLoadEntry(entry) {
  if (globeMode) {
    if (entry.pending || entry._globeDs || entry._globeImagery) return;
    entry.pending = true;
    mountGlobeEntry(entry)
      .then(() => { entry.pending = false; renderLayerRows(); })
      .catch(err => { entry.pending = false; entry.failed = true; entry.error = err?.message || err; renderLayerRows(); console.warn(err); });
    return;
  }
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
  flyToView: v => {
    if (globeMode) { globeFlyTo(v); return; }
    gmap?.setView([Number(v.latitude), Number(v.longitude)],
      Number.isFinite(v.zoom) ? v.zoom : camToZoom(v));
  },
  getViewInfo: () => {
    // Globe 表示中は gmap が無いため Cesium カメラから視点を返す
    if (globeMode) return globeViewInfo() || globeHashView();
    if (!gmap) return null;
    const c = gmap.getCenter();
    return { latitude: c.lat, longitude: c.lng, zoom: gmap.getZoom(), heading: 0, pitchDeg: 0 };
  },
  fitBoundsView: (w, s, e, n) => {
    if (globeMode) { globeFitBounds(w, s, e, n); return; }
    gmap?.fitBounds([[s, w], [n, e]], { padding: [50, 50] });
  },
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
    if (globeMode) {
      removeGlobeEntry(entry);
      await mountGlobeEntry(entry);
    } else {
      entry.sakuzu = injectSakuzuLayer(entry.item, result.geojson);
    }
    applyEntryVisibility(entry);
  },
  getEntryGeoJson: entry => entry.item._geojson || null,
  setBaseEntryVisible: (entry, on) => {
    if (globeMode) {
      // globe 側のベース表示切替は現在選択行として扱い applyGlobeBaseSelection へ委譲
      const idx = baseEntries.indexOf(entry);
      const sel = document.getElementById("basemap-select");
      if (on && sel && idx >= 0) { sel.value = String(idx); applyBaseSelection(); }
      else if (!on && sel && Number(sel.value) === idx) { sel.value = "-1"; applyBaseSelection(); }
      return;
    }
    const bl = gsiBase();
    if (entry.gsiId && bl) { try { if (on) bl.setActiveId(entry.gsiId); } catch (_) {} }
    if (entry.tileLayer && gmap) {
      if (on && !gmap.hasLayer(entry.tileLayer)) gmap.addLayer(entry.tileLayer);
      else if (!on && gmap.hasLayer(entry.tileLayer)) gmap.removeLayer(entry.tileLayer);
    }
  },
  // .kasc fly_geojson: 行 → フライパス定義（speedはm/s。setFlySettings の書き戻し用に _item を持たせる）
  getFlyPaths: () => flyPathItems.map(item => {
    const o = item.opts || {};
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
    return {
      title: item.title || item.url,
      url: resolveKascUrl(item.url, lastBaseUrl),
      speed: num(o.speed), height: num(o.height), pitch: num(o.pitch),
      loop: /^(true|1|on|yes)$/i.test(o.loop || ""), view: o.view,
      _item: item,
    };
  }),
  // flyRoute/addFlyPath の永続化: GeoJSON を DATA/ へ保存し fly_geojson: 行を追記。
  // ファイル書込み可能なローカルサーバー版のみ（静的配信ではメモリ登録のみで false を返す）
  persistFlyPath: async (title, geojson, path) => {
    const safe = String(title || "route").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "route";
    const name = `fly_${safe}.geojson`;
    const r = await window.kasugaiApi.saveDataFile(name, JSON.stringify(geojson)).catch(() => null);
    if (!r?.ok) return false;
    const opts = [`speed=${Math.round(path.speed * 10) / 10}`];
    if (Number.isFinite(path.height)) opts.push(`height=${path.height}`);
    if (Number.isFinite(path.pitch)) opts.push(`pitch=${path.pitch}`);
    if (path.loop) opts.push("loop=true");
    const line = `fly_geojson:${title}|DATA/${name}|${opts.join("|")}`;
    inspectorInput.value = `${inspectorInput.value.replace(/\s*$/, "")}\n${line}\n`;
    // セッション内でも getFlyPaths が拾えるよう item 登録（memoryFlyPaths と同名なら先勝ちで一つに見える）
    flyPathItems.push({
      type: "fly_geojson", title, url: `DATA/${name}`, visible: true,
      opts: Object.fromEntries(opts.map(o => o.split("="))), line,
    });
    return true;
  },
  // setFlySettings で書き換えた item.opts をインスペクタの fly_geojson: 行へ反映
  syncFlyPathLine: item => {
    if (!item?.line || !inspectorInput.value.includes(item.line)) return;
    const o = item.opts || {};
    const parts = [`fly_geojson:${item.title || ""}`, item.url || ""];
    for (const k of ["speed", "height", "pitch", "step", "view"]) {
      if (o[k] !== undefined && o[k] !== "") parts.push(`${k}=${o[k]}`);
    }
    if (o.loop) parts.push(`loop=${o.loop}`);
    const nl = parts.join("|");
    inspectorInput.value = inspectorInput.value.replace(item.line, nl);
    item.line = nl;
  },
});
// gsimaps 専用: 地理院地図の表示中レイヤ取得・取り込み・操作・カタログ追加・
// 作図取り込み（他エンジンではメソッドが無いため各ツールは自動的に非公開になる）
Object.assign(window.kasugaiApi, {
  listGsiLayers: () => gsiDisplayedLayers(),
  importGsiLayers: opts => importGsiLayers(opts),
  setGsiLayerOpacity, moveGsiLayer, removeGsiLayer,
  listGsiCatalog, addGsiLayer, importGsiCatalog: opts => importGsiCatalog(opts),
  listGsiSakuzu: () => gsiSakuzuItems(),
  importGsiSakuzu: opts => importGsiSakuzu(opts),
  removeGsiSakuzu: opts => removeGsiSakuzu(opts),
  listGsiBasemaps: () => gsiBasemapEntries(),
  setGsiBasemap, setGsiLayerHidden,
  getGsiElevation: (lat, lon) => getGsiElevation(lat, lon),
  getGsiShareUrl: () => getGsiShareUrl(),
  setGsiGlobe: on => setGsiGlobe(on),
  // Globe(Cesium)表示中のみ有効な表示効果。2D 中・未対応の効果名・旧Cesiumに
  // プロパティが無い場合は false（ツール側は「不明な効果」として返る）
  setEffect: (name, enabled) => {
    const { viewer } = globeApis();
    if (!viewer) return false;
    const on = !!enabled;
    try {
      const scene = viewer.scene, globe = scene?.globe;
      switch (String(name)) {
        case "lighting": if (globe && "enableLighting" in globe) { globe.enableLighting = on; return true; } return false;
        case "atmosphere": if (scene?.skyAtmosphere && "show" in scene.skyAtmosphere) { scene.skyAtmosphere.show = on; return true; } return false;
        case "fog": if (scene?.fog && "enabled" in scene.fog) { scene.fog.enabled = on; return true; } return false;
        case "depthTest": if (globe && "depthTestAgainstTerrain" in globe) { globe.depthTestAgainstTerrain = on; return true; } return false;
        case "shadows": if ("shadows" in viewer) { viewer.shadows = on; return true; } return false;
        default: return false;
      }
    } catch (_) { return false; }
  },
  // flyTo のドローン視点(height=地上+200m)に使う実標高。
  // 未指定座標は地図中心。getelevation.php が返す hsrc メッシュの値
  sampleGroundHeight: async (lat, lng) => {
    const center = globeMode ? globeViewInfo() : gmap?.getCenter();
    const c = (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng }
      : (center ? { lat: center.lat ?? center.latitude, lng: center.lng ?? center.longitude } : {});
    const r = await getGsiElevation(c.lat, c.lng).catch(() => null);
    return Number.isFinite(r?.elevation) ? r.elevation : 0;
  },
});
// 汎用 setBasemap は .kasc 未登録の GSI ベースマップ名も受け付ける
// (base: 行の自動追記まで行う setGsiBasemap へフォールバック)
const genericSetBasemap = window.kasugaiApi.setBasemap;
window.kasugaiApi.setBasemap = name => genericSetBasemap(name) || !!setGsiBasemap(name).ok;
document.getElementById("gsi-import-layers")?.addEventListener("click", async () => {
  const r = await importGsiLayers().catch(err => ({ ok: false, message: String(err?.message || err) }));
  setInspectorStatus(r.message || "", !r.ok);
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
  get gsiLayerList() { return gsiMl(); },
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
