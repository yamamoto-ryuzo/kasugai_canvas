// qgis-vs-canvas/compare.mjs — QGIS と Canvas の同一範囲スクリーンショット比較
// 1) live-drive pyeval で QGIS 地図キャンバスを対象範囲へ設定→screenshot
// 2) Playwright で Canvas を同範囲へ合わせ→ロード完了待機→screenshot
// usage:
//   node compare.mjs <engine> [bbox4326] [project] [waitLayer] [solo[,solo2,...]]
//   solo をカンマ区切りで渡すと 1 セッションで複数層を連続ペア撮影
// 出力: web/verify/results/qgis-vs-canvas/{qgis,canvas}-<engine>[-<layer>].png
import { resolveLiveDirs, getControlPage, LivePage } from "file:///C:/devin/qgis_live_harness/scripts/live-drive.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = process.argv[2] || "cesium";
const BBOX = (process.argv[3] || "139.70,35.68,139.99,35.73").split(",").map(Number);
const PROJECT = process.argv[4] || "ProjectFiles";
const WAIT_LAYER = process.argv[5] || "qmltest_RandomMarkerFill";
const SOLO_LIST = (process.argv[6] || "").split(",").map(s => s.trim()).filter(Boolean);
// NOBASE=1: solo 撮影中はベースマップ(index 0 とタグ無し imagery)を隠し、
// QGIS と同じ白背景条件でレンダリング比較する(heatmap 等の淡い描画用)
const NOBASE = process.env.NOBASE === "1";
const OUT = dirname(fileURLToPath(import.meta.url));
const CANVAS = "http://127.0.0.1:8510";

// --- 1) QGIS 側: ドライバ接続 + 範囲設定 ---
const liveDir = join("C:/devin/qgis_live_harness/test-results/live");
const liveDirs = await resolveLiveDirs(liveDir);
// 死んだセッションの live dir が残ることがあるため、status が応答する
// geo_driver を探す(先頭=最新とは限らない)
let page = null, st = null, bestScore = -1;
// 複数 QGIS が同時起動している場合、目的レイヤ(qmltest_* 等)を持つ
// プロジェクト側を選ぶ。SOLO_LIST 先頭名でスコアリングする
const wantName = SOLO_LIST[0] || WAIT_LAYER;
for (const d of liveDirs.filter(d => d.pluginId === "geo_driver")) {
  const p = new LivePage(d.dir);
  const s = await Promise.race([p.status().catch(() => null), new Promise(r => setTimeout(() => r(null), 12000))]);
  if (!s || !s.pid) continue;
  let score = 0;
  try {
    const nm = await p.pyeval(`
from qgis.core import QgsProject
names = [n.layer().name() for n in QgsProject.instance().layerTreeRoot().findLayers()]
result = str(sum(1 for x in names if x == ${JSON.stringify(wantName)})) + "/" + str(sum(1 for x in names if "qmltest" in x)) + "/" + str(len(names))
`, { timeoutMs: 15000 });
    const [hit, qml, total] = String(nm).split("/").map(Number);
    score = (hit || 0) * 100 + Math.min(qml || 0, 50);
    console.log("driver", s.pid, "layers:", nm, "score:", score);
  } catch { score = 0; }
  if (score > bestScore) { bestScore = score; page = p; st = s; }
  if (score >= 100) break;
}
if (!page) { page = await getControlPage(liveDir); st = await page.status().catch(e => ({ err: String(e) })); }
if (wantName && bestScore === 0) {
  console.log(`WARN: 対象レイヤ ${wantName} を持つドライバが無い — 全 solo が NOTFOUND になり白画像を量産するため中断`);
  process.exit(2);
}
console.log("driver pid:", st.pid, "port:", st.http_port);

const setExtent = `
from qgis.core import QgsCoordinateReferenceSystem, QgsCoordinateTransform, QgsRectangle, QgsProject
from qgis.utils import iface
xform = QgsCoordinateTransform(QgsCoordinateReferenceSystem("EPSG:4326"), QgsProject.instance().crs(), QgsProject.instance())
r = xform.transformBoundingBox(QgsRectangle(${BBOX.join(",")}))
iface.mapCanvas().setExtent(r)
iface.mapCanvas().refresh()
# QGIS はキャンバスのアスペクト比に合わせて範囲を拡張するため、
# 実際の表示範囲を 4326 へ逆変換して Canvas 側カメラ合わせの正とする
xback = QgsCoordinateTransform(QgsProject.instance().crs(), QgsCoordinateReferenceSystem("EPSG:4326"), QgsProject.instance())
r4326 = xback.transformBoundingBox(iface.mapCanvas().extent())
result = f"{r4326.xMinimum()},{r4326.yMinimum()},{r4326.xMaximum()},{r4326.yMaximum()}"
`;
const extStr = await page.pyeval(setExtent, { timeoutMs: 60000 });
console.log("qgis extent(4326):", extStr);
const extNums = /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(String(extStr));
const BBOX_ACT = extNums ? extNums.slice(1).map(Number) : BBOX;

const qgisSize = await page.pyeval(`
from qgis.utils import iface
s = iface.mapCanvas().size()
result = f"{s.width()}x{s.height()}"
`).catch(() => null);
const [vw, vh] = /(\d+)x(\d+)/.exec(String(qgisSize))?.slice(1).map(Number) || [1400, 900];
console.log("qgis canvas size:", vw, "x", vh);

async function qgisSolo(name) {
  return page.pyeval(`
from qgis.core import QgsProject
root = QgsProject.instance().layerTreeRoot()
hit = ""
for n in root.findLayers():
    nm = n.layer().name()
    want = nm == ${JSON.stringify(name)}
    if "qmltest" in nm:
        n.setItemVisibilityChecked(want)
        if want: hit = nm
    elif not want:
        n.setItemVisibilityChecked(False)
result = hit or "NOTFOUND"
`, { timeoutMs: 30000 });
}
async function qgisAll() {
  return page.pyeval(`
from qgis.core import QgsProject
root = QgsProject.instance().layerTreeRoot()
n = 0
for nd in root.findLayers():
    nd.setItemVisibilityChecked(True); n += 1
result = str(n)
`, { timeoutMs: 30000 });
}
async function qgisShot(tag) {
  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot(join(OUT, `${tag}.png`), { target: "canvas" });
  console.log("qgis:", `${tag}.png`);
}

// --- 2) Canvas 側: 1 セッションでループ ---
const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: vw, height: vh } });
// 前回セッションのカレント状態(vis/camera)が残っていると起動時に
// applySessionState→rerender→refreshLayers の二段 rebuild が走り、
// solo 撮影中の ds チャーンと可視状態の汚染を招く。アプリ起動前に消す
await pg.addInitScript(() => { try { localStorage.removeItem("kasugai:session-state"); } catch (_) {} });
// rebuild 発火元の特定: kasugaiApi 公開メソッドの呼び出しをスタック付きで記録。
// refreshLayers の発火経路(applyInspector/setLayerVisible/applyKascText 等)は
// ほぼ API 経由なので、呼ばれたメソッド名+呼び出し元スタックが取れる
await pg.addInitScript(() => {
  window.__apiCalls = [];
  const wrap = () => {
    const api = window.kasugaiApi;
    if (!api || api.__wrapped) return;
    api.__wrapped = true;
    for (const k of Object.keys(api)) {
      const fn = api[k];
      if (typeof fn !== "function" || k.startsWith("_") || k === "on" || k === "emit" || k === "once") continue;
      api[k] = function (...args) {
        try {
          const st = (new Error().stack || "").split("\n").slice(2, 5).join(" | ");
          window.__apiCalls.push([Date.now(), k, String(args[0] ?? "").slice(0, 40), st.slice(0, 300)]);
        } catch (_) {}
        return fn.apply(this, args);
      };
    }
  };
  const iv = setInterval(() => { wrap(); if (window.kasugaiApi?.__wrapped) clearInterval(iv); }, 50);
});
// rebuild の直接の発火点: refreshLayersImpl は先頭で必ず
// viewer.imageryLayers.removeAll(false) を呼ぶ。ここをラップして
// 呼び出し元スタックを取れば reload/applyInspector の直接呼出元が分かる
await pg.addInitScript(() => {
  window.__rebuildLog = [];
  const hook = () => {
    const v = window._viewer;
    const ils = v && v.imageryLayers;
    if (!ils || ils.__wrapped) return;
    ils.__wrapped = true;
    const orig = ils.removeAll.bind(ils);
    ils.removeAll = function (...a) {
      try {
        window.__rebuildLog.push([Date.now(), (new Error().stack || "").split("\n").slice(1, 14).join(" | ").slice(0, 1200)]);
      } catch (_) {}
      return orig(...a);
    };
  };
  setInterval(hook, 50);
});
// /api/command のリモートコマンド(switchProject/liveSync 等)が検証中に
// 届くと applyInspector→refreshLayers の全 rebuild + item.visible リセットで
// solo が崩れる。リモートコマンド経路は空応答で遮断する
await pg.route("**/api/command**", r => r.fulfill({ status: 200, contentType: "application/json", body: '{"commands":[],"latest":0,"ok":true,"results":[]}' }));
await pg.goto(`${CANVAS}/${ENGINE}/?project=${PROJECT}`, { waitUntil: "domcontentloaded", timeout: 45000 });
await pg.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0, undefined, { timeout: 60000 });
// 起動時の初期カメラ flyTo(cam: 行)・deep link・プロジェクト適用が全て終わるまで待つ。
// isReady 前に触ると解決中の flyTo が後から視点を上書きする
await pg.waitForFunction(() => window.kasugaiApi.isReady === true, undefined, { timeout: 120000, polling: 1000 }).catch(() => console.log("WARN: isReady timeout"));
// #load-progress は初期 hidden なので「hidden を見た」だけでは未ロードと区別が
// 付かない。hidden が続いた時刻を記録して「4s 以上 hidden 安定」を待機条件に使う
await pg.evaluate(() => {
  // 待機判定の状態:
  //   __lpSeenVisible … #load-progress が一度でも visible になったか
  //     (起動直後は refreshLayersImpl の terrain fetch 中も hidden のままで、
  //      「hidden 安定」だけだとロード未開始と完了を区別できない)
  //   __lpHiddenAt … hidden が継続し始めた時刻
  //   __lastDsEvent … ds/primitive 数が最後に変化した時刻(rebuild 活動検出)
  window.__lpSeenVisible = false;
  window.__lpHiddenAt = 0;
  window.__lastDsEvent = Date.now();
  let lastDsCount = -1, lastPrimCount = -1;
  setInterval(() => {
    const lp = document.querySelector("#load-progress");
    if (lp && !lp.hidden) { window.__lpSeenVisible = true; window.__lpHiddenAt = 0; }
    else if (!window.__lpHiddenAt) window.__lpHiddenAt = Date.now();
    const v = window._viewer;
    if (v) {
      const dc = v.dataSources.length, pc = v.scene.primitives.length;
      if (dc !== lastDsCount || pc !== lastPrimCount) {
        lastDsCount = dc; lastPrimCount = pc;
        window.__lastDsEvent = Date.now();
      }
    }
  }, 250);
  // rebuild 検出用: ds 追加/除去と進捗表示の推移を記録
  window.__dsLog = [];
  const lp = document.querySelector("#load-progress");
  const txt = () => `${lp?.hidden ? "H" : "V"}:${lp?.textContent || ""}`;
  let last = txt();
  new MutationObserver(() => { const t = txt(); if (t !== last) { last = t; window.__dsLog.push([Date.now(), "prog", t]); } })
    .observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
  const hook = () => {
    const v = window._viewer;
    if (!v) return setTimeout(hook, 500);
    v.dataSources.dataSourceAdded.addEventListener(d => window.__dsLog.push([Date.now(), "add", String(d._kasugaiLayerId || d.name || "?")]));
    v.dataSources.dataSourceRemoved.addEventListener(d => window.__dsLog.push([Date.now(), "rem", String(d._kasugaiLayerId || d.name || "?")]));
  };
  hook();
});

// 表示切替: cesium は item.visible 自体を切替 + ds.show 同期。
// ds.show だけだと refreshLayers/reslice/applyScaleVisibility 等の再描画経路が
// ds.show = item.visible(=true) で他層を復元してしまう。item.visible を変えれば
// rebuild 系が走っても solo が維持される(rebuild 自体は起こさない)。
// setLayerVisible() は refreshLayers の全層 rebuild を起こすので使わない。
async function canvasVisible(only /* ""=all */) {
  return pg.evaluate(async ({ only, nobase }) => {
    const out = [];
    if (window.kasugaiApi.engine === "cesium" && window._viewer) {
      const v = window._viewer;
      const items = window.kasugaiApi.listLayers();
      // 初回に .kasc 行の可視状態をスナップショット(""復元用)
      const orig = window.__origVis || (window.__origVis = new Map());
      for (const l of items) if (!orig.has(l.id)) orig.set(l.id, l.visible !== false);
      const visById = new Map();
      for (const l of items) {
        const want = only ? String(l.title || l.id) === only : orig.get(l.id) !== false;
        l.visible = want;
        visById.set(l.id, want);
      }
      let targetRendered = false; // ds/primitive/imagery いずれかの描画実体
      for (let i = 0; i < v.dataSources.length; i++) {
        const d = v.dataSources.get(i);
        const want = visById.get(d._kasugaiLayerId);
        if (want === undefined) continue; // geo-tools 等のアプリ内 ds は触らない
        d.show = want;
        if (only && want) { out.push(items.find(l => l.id === d._kasugaiLayerId)?.title || ""); targetRendered = true; }
      }
      for (let i = 0; i < v.scene.primitives.length; i++) {
        const p = v.scene.primitives.get(i);
        const want = p && visById.get(p._kasugaiLayerId);
        if (want === undefined) continue;
        p.show = want;
        if (only && want) { out.push(items.find(l => l.id === p._kasugaiLayerId)?.title || ""); targetRendered = true; }
      }
      // xyz/geotiff 等の imagery レイヤー(_kasugaiLayerId 付き)も solo 対象。
      // index 0 のベースマップは原則触らないが、nobase 時は solo で隠して
      // QGIS と同じ白背景条件にする(タグ無し imagery も同様)
      for (let i = 0; i < v.imageryLayers.length; i++) {
        const il = v.imageryLayers.get(i);
        if (!il) continue;
        const want = visById.get(il._kasugaiLayerId);
        if (want === undefined) {
          if (nobase) il.show = !only;
          continue;
        }
        il.show = want;
        if (only && want) { out.push(items.find(l => l.id === il._kasugaiLayerId)?.title || ""); targetRendered = true; }
      }
      // 描画実体が全経路で無い対象(off 行の遅延ロード等)だけ API トグルでロード
      // させる。imagery/primitive 経路の層は ds を持たないので ds だけ見ると
      // 誤爆して setLayerVisible→refreshLayers の全 rebuild を誘発する
      if (only && !targetRendered) {
        for (const l of items) {
          if (String(l.title || l.id) !== only) continue;
          try {
            await window.kasugaiApi.setLayerVisible(l.id, true);
            out.push(l.title);
          } catch (_) {}
        }
      }
      try { v.scene.requestRender?.(); } catch (_) {}
      return out;
    }
    // gsimaps: GSI タイルは setBasemap("none") 対象外のため、iframe 内の
    // tilePane を直接隠して白背景化する(作図/ベクタは別ペインで残る)
    if (nobase && window.kasugaiApi.engine === "gsimaps") {
      try {
        const w = document.querySelector("iframe")?.contentWindow;
        const d = w?.document;
        if (only) {
          // iframe 再読込で document が差し替わると要素が detached になるため
          // 「style が現在の head にぶら下がっているか」で毎回判定して再注入する
          if (!window.__gsiNobase || window.__gsiNobase.ownerDocument !== d || !d.head.contains(window.__gsiNobase)) {
            window.__gsiNobase = d.createElement("style");
            window.__gsiNobase.textContent =
              ".leaflet-tile-pane,.leaflet-control-minimap{display:none!important}" +
              ".leaflet-container{background:#fff!important}";
            d.head.appendChild(window.__gsiNobase);
          }
        } else if (window.__gsiNobase) {
          window.__gsiNobase.remove();
          window.__gsiNobase = undefined;
        }
      } catch (_) {}
    }
    // 非cesium: NOBASE 時はベースマップを none へ(QGIS 白背景条件に合わせる)。
    // solo 解除(only="")で元の選択へ戻す。
    // leaflet のベースマップは deck ドレープ経路のため tilePane 隠しでは
    // 消えず setBasemap("none") が必要(フリーズ原因は別の大容量層)
    if (nobase && window.kasugaiApi.engine !== "gsimaps" && typeof window.kasugaiApi.setBasemap === "function") {
      try {
        if (only) {
          if (window.__savedBasemap === undefined) {
            const sel = (window.kasugaiApi.listBasemaps?.() || []).find(b => b.selected);
            window.__savedBasemap = sel ? sel.title : null;
          }
          window.kasugaiApi.setBasemap("none");
          // leaflet は deck ドレープ経路のベースコピーが別途残るため、
          // drape-tiles3d-basemap チェックも外して白背景にする
          const dcb = document.querySelector("#drape-tiles3d-basemap");
          if (dcb) {
            if (window.__savedDrapeBase === undefined) window.__savedDrapeBase = dcb.checked;
            if (dcb.checked) dcb.click();
          }
        } else {
          if (window.__savedBasemap) {
            window.kasugaiApi.setBasemap(window.__savedBasemap);
            window.__savedBasemap = undefined;
          }
          const dcb = document.querySelector("#drape-tiles3d-basemap");
          if (dcb && window.__savedDrapeBase === true && !dcb.checked) { dcb.click(); window.__savedDrapeBase = undefined; }
        }
      } catch (_) {}
    }
    const viaApi = typeof window.kasugaiApi.setLayerVisible === "function";
    const wantMap = new Map();
    // QGIS 側は非対象レイヤを全て隠すため、Canvas 側も全レイヤを対象に solo する。
    // (qmltest 限定だと DM_C 等が残って白背景条件にならない)
    const origN = window.__origVisN || (window.__origVisN = new Map());
    for (const l of window.kasugaiApi.listLayers()) {
      if (!origN.has(l.id)) origN.set(l.id, l.visible !== false);
      wantMap.set(l, only ? String(l.title || l.id) === only : origN.get(l.id) !== false);
    }
    if (viaApi) {
      for (const [l, want] of wantMap) {
        // 稀に特定層(遅延ロード競合)でトグルが解決しないケースがあるため
        // 層ごとに打ち切って全体ハングを防ぐ(検証ハーネスのみの保険)
        try {
          const ok = await Promise.race([
            Promise.resolve(window.kasugaiApi.setLayerVisible(l.id, want)),
            new Promise(res => setTimeout(() => res("TIMEOUT"), 10000)),
          ]);
          if (want && ok !== "TIMEOUT") out.push(l.title);
        } catch (_) {}
      }
      return out;
    }
    const cbs = [...document.querySelectorAll('#layer-list input[type="checkbox"]')];
    for (const [l, want] of wantMap) {
      const title = String(l.title || l.id);
      const cb = cbs.find(c => {
        const row = c.closest("li,tr,div");
        return (row?.textContent || c.closest("label")?.textContent || "").includes(title);
      });
      if (cb && cb.checked !== want) cb.click();
      if (cb?.checked === want) out.push(title);
    }
    return out;
  }, { only, nobase: NOBASE });
}

// カメラ合わせ — cesium: flyTo 即時 / 他: fitBounds([w,s,e,n])
// pitch はアプリ側が -85 未満を矯正するため -84 固定 → 真俯瞰前提の
// 高さ公式では画面が狭まるので、4隅を worldToWindowCoordinates で投影して
// 全角が画面内に収まるまで高さを反復増加させる(実ピッチで厳密に一致)
const setCam = `(async ({ bbox, vw, vh }) => {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const midLng = (bbox[0] + bbox[2]) / 2;
  const mPerDegLat = 111320, mPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180);
  const wM = Math.abs(bbox[2] - bbox[0]) * mPerDegLng;
  const hM = Math.abs(bbox[3] - bbox[1]) * mPerDegLat;
  const aspect = vw / vh;
  const tan30 = Math.tan(Math.PI / 6);
  let height = Math.max(hM / (2 * tan30), wM / (2 * tan30 * aspect)) * 1.05;
  const v = window._viewer, C = window.Cesium;
  if (window.kasugaiApi.engine === "cesium" && v && C) {
    const corners = [
      C.Cartesian3.fromDegrees(bbox[0], bbox[1]), C.Cartesian3.fromDegrees(bbox[2], bbox[1]),
      C.Cartesian3.fromDegrees(bbox[0], bbox[3]), C.Cartesian3.fromDegrees(bbox[2], bbox[3])];
    const MARGIN = 8;
    for (let i = 0; i < 20; i++) {
      try { v.camera.cancelFlight?.(); } catch (_) {}
      v.camera.setView({ destination: C.Cartesian3.fromDegrees(midLng, midLat, height), orientation: { heading: 0, pitch: C.Math.toRadians(-84), roll: 0 } });
      v.scene.requestRender();
      await new Promise(r => setTimeout(r, 150));
      let ok = true;
      for (const c of corners) {
        const sp = C.SceneTransforms.worldToWindowCoordinates(v.scene, c);
        if (!sp || sp.x < MARGIN || sp.x > vw - MARGIN || sp.y < MARGIN || sp.y > vh - MARGIN) { ok = false; break; }
      }
      if (ok) break;
      height *= 1.12;
    }
    v.scene.requestRender();
    return height;
  }
  // navara: fitBounds 未実装の3D地球。ThreeView.setCamera の height は
  // 注視点の標高で、カメラは distance(注視点までの距離m)で配置する。
  // FOV60 は Cesium と同じなので distance=height で同じ地面範囲になる。
  // setCamera は即時適用(アニメ無し)で、kasugaiApi.setView 経由だと
  // distance を渡せないため kascView 直叩き
  if (window.kasugaiApi.engine === "navara") {
    try {
      if (window.kascView?.setCamera) {
        window.kascView.setCamera({ lng: midLng, lat: midLat, height: 0, distance: height, heading: 0, pitch: -90, roll: 0 });
        return "navara-dist:" + Math.round(height);
      }
      window.kasugaiApi.setView?.({ lng: midLng, lat: midLat, longitude: midLng, latitude: midLat, height, heading: 0, pitch: -85 });
      return "navara-height:" + Math.round(height);
    } catch (_) {}
  }
  // kasugaiApi.fitBounds の公開シグネチャは (w,s,e,n) の4引数(配列ではない)
  try { if (window.kasugaiApi.fitBounds) { window.kasugaiApi.fitBounds(bbox[0], bbox[1], bbox[2], bbox[3]); return "fitBounds"; } } catch (_) {}
  try { if (window.kasugaiApi.zoomToExtent) return window.kasugaiApi.zoomToExtent(bbox[0], bbox[1], bbox[2], bbox[3]); } catch (_) {}
  try { window.kasugaiApi.setView?.({ longitude: midLng, latitude: midLat, zoom: 13 }); } catch (_) {}
})(${JSON.stringify({ bbox: BBOX_ACT, vw, vh })})`;

// --- 実行 ---
const shots = SOLO_LIST.length ? SOLO_LIST : [""];
// 先に Canvas を全ロードさせてからループ（ロード待機は最初の1回だけ重い）
console.log("visible on:", (await canvasVisible("")).length, "layers (preload)");
// 層の「実描画完了」を判定: ds._kasugaiLayerId 一致 + show + entities>0
// (getLayerGeoJson はキャッシュ参照で rebuild 途中でも真を返すため使えない)
// 層の「実描画完了」を判定: ds._kasugaiLayerId 一致 + show + entities>0
// (getLayerGeoJson はキャッシュ参照で rebuild 途中でも真を返すため使えない)。
// rebuild 連鎖対策として (a) progress hidden 4s 安定 (b) prevDs と別の ds を要求
const layerRendered = async (name) => pg.waitForFunction(async (want) => {
  // (a) 進捗ピルが一度は表示され(ロード開始の実測) (b) hidden が4s安定
  // (c) ds/primitive の増減が4s無い — 3条件で初めて「ロード・rebuild 静止」とみなす
  if (!window.__lpSeenVisible || !window.__lpHiddenAt || Date.now() - window.__lpHiddenAt < 4000) return false;
  if (Date.now() - (window.__lastDsEvent || 0) < 4000) return false;
  const ls = window.kasugaiApi.listLayers().filter(l => String(l.title || l.id).includes(want));
  if (!ls.length) return false;
  const v = window._viewer || null;
  for (const l of ls) {
    if (l.type === "tile" || l.type === "xyz") continue;
    let ok = false;
    if (v) {
      for (let i = 0; i < v.dataSources.length; i++) {
        const d = v.dataSources.get(i);
        if (d._kasugaiLayerId === l.id && d.show !== false && d.entities.values.length > 0) { ok = true; break; }
      }
      if (!ok) {
        for (let i = 0; i < v.scene.primitives.length; i++) {
          const p = v.scene.primitives.get(i);
          if (p && p._kasugaiLayerId === l.id && p.show !== false) { ok = true; break; }
        }
      }
    } else {
      // 非cesiumエンジン: geojson 取得できるまで待つ
      try {
        const g = await window.kasugaiApi.getLayerGeoJson(l.id);
        if (g?.features?.length > 0) ok = true;
      } catch (_) {}
    }
    if (!ok) return false;
  }
  window.__gatePass = { seenV: window.__lpSeenVisible, hiddenAt: window.__lpHiddenAt, lastDs: window.__lastDsEvent, now: Date.now() };
  return true;
}, name, { timeout: 180000, polling: 1500 }).then(async () => {
  const g = await pg.evaluate(() => window.__gatePass).catch(() => null);
  if (g) console.log("  gate:", JSON.stringify(g));
  return true;
}).catch(() => false);

const loaded = await layerRendered(WAIT_LAYER);
console.log("layer loaded:", loaded, `(${WAIT_LAYER})`);

// カメラ安定化（cesium: setView は進行中 flyTo を殺せないのでループ）
const isCesium = await pg.evaluate(() => window.kasugaiApi.engine === "cesium");
await pg.evaluate(setCam);
for (let i = 0; i < (isCesium ? 30 : 0); i++) {
  await pg.waitForTimeout(1500);
  const h = await pg.evaluate(setCam);
  await pg.waitForTimeout(800);
  const cam = await pg.evaluate(() => window.kasugaiApi.getCamera?.()).catch(() => null);
  if (cam && Number.isFinite(h) && Math.abs(cam.height - h) / h < 0.02) {
    await pg.waitForTimeout(1200);
    const cam2 = await pg.evaluate(() => window.kasugaiApi.getCamera?.()).catch(() => null);
    if (cam2 && Math.abs(cam2.height - h) / h < 0.02) { console.log("camera stable at", Math.round(cam2.height)); break; }
  }
  if (i === 29) console.log("WARN: camera unstable");
}
// パネル最小化（存在するエンジンのみ）
await pg.evaluate(() => { try { document.querySelector("#layer-panel-toggle")?.click(); } catch (_) {} });
// 非cesium: 左レイヤパネル・AIチャットが地図を覆うため solo 比較中は隠す
// (#panel-toggle はレイヤ一覧を消すと待機関数の視認診断に影響し得るため CSS で隠す)
if (!isCesium) await pg.evaluate(() => {
  const st = document.createElement("style");
  st.id = "__solo-hide-ui";
  st.textContent = "#panel,#chat-panel{display:none!important}";
  document.head.appendChild(st);
});
await pg.waitForTimeout(1500);

for (const solo of shots) {
  const tag = solo ? `-${solo}` : "";
  if (solo) {
    console.log("qgis solo:", await qgisSolo(solo));
    // ds.show 直接切替のため rebuild は起きない。ds 未構築層の API フォールバック
    // 用に hidden 安定計測だけリセットする
    await pg.evaluate(() => { window.__lpHiddenAt = 0; });
    // ページフリーズで evaluate が永久 pending になる事故を検出するため打ち切り
    const soloVis = await Promise.race([
      canvasVisible(solo),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`canvasVisible timeout: ${solo}`)), 120000)),
    ]);
    console.log("canvas solo:", soloVis.join(","));
  } else {
    console.log("qgis all:", await qgisAll());
    console.log("canvas all:", (await canvasVisible("")).length, "layers");
  }
  await qgisShot(`qgis-${ENGINE}${tag}`);
  // cesium: カメラ再適用は moveEnd→viewport/scale refresh 連鎖(rebuild)を
  // 誘発するため撮影ループでは行わない(安定化済みのカメラを維持する)
  if (!isCesium) { await pg.evaluate(setCam); await pg.waitForTimeout(2500); }
  else await pg.waitForTimeout(500);
  // 描画実在の確認は rebuild/遅延ロードが静まってから行う。
  // rebuild や後追い ds 構築は ds.show=effectiveLayerShow(item) で他層を
  // 再表示するため、「対象のみ show」の状態が2連続で確認できるまで収束を待つ
  if (solo) {
    let settled = false;
    for (let attempt = 0; attempt < 10 && !settled; attempt++) {
      await canvasVisible(solo);
      await pg.waitForTimeout(1200);
      const diag = await pg.evaluate((want) => {
        const v = window._viewer;
        const idTitle = new Map();
        for (const l of window.kasugaiApi.listLayers()) idTitle.set(l.id, String(l.title || l.id));
        // 2D エンジンは ds/primitive 収束概念が無く setLayerVisible で即時再描画
        // されるため収束待ち不要(即 settled にする)
        if (!v) return { text: "non-cesium engine", target: true, others: 0 };
        let target = false, targetInfo = "absent";
        const leaks = [];
        for (let i = 0; i < v.dataSources.length; i++) {
          const d = v.dataSources.get(i);
          const title = idTitle.get(d._kasugaiLayerId);
          const shown = d.entities.values.filter(e => e.show !== false).length;
          if (title === want) { target = d.show !== false && shown > 0; targetInfo = `ents=${d.entities.values.length} shown=${shown} show=${d.show}`; }
          else if (d.show !== false && shown > 0) leaks.push(`ds:${title || d._kasugaiLayerId || d.name || "?"}`);
        }
        for (let i = 0; i < v.scene.primitives.length; i++) {
          const p = v.scene.primitives.get(i);
          const title = p && idTitle.get(p._kasugaiLayerId);
          if (title && title !== want && p.show !== false) leaks.push(`prim:${title}`);
        }
        for (let i = 1; i < v.imageryLayers.length; i++) {
          const il = v.imageryLayers.get(i);
          if (!il || il.show === false) continue;
          const title = idTitle.get(il._kasugaiLayerId);
          if (title === want) { target = true; targetInfo += " +img"; }
          else leaks.push(`img:${title || il._kasugaiLayerId || "?"}:${il.imageryProvider?.constructor?.name || "?"}`);
        }
        const leakStr = leaks.length ? ` LEAK=${leaks.join(",")}` : "";
        return { text: `target ${targetInfo} others=${leaks.length}${leakStr}`, target, others: leaks.length };
      }, solo);
      console.log("  diag:", solo, "→", diag.text);
      settled = diag.target && diag.others === 0;
      if (!settled) await pg.waitForTimeout(4000);
    }
    if (!settled) console.log("WARN: solo not settled:", solo);
  }
  await pg.evaluate(() => window._viewer?.scene?.requestRender?.());
  await pg.waitForTimeout(800);
  // font ロード待ちで screenshot が詰まる場合は CDP で直接撮る
  try {
    await pg.screenshot({ path: join(OUT, `canvas-${ENGINE}${tag}.png`), timeout: 20000 });
  } catch (_) {
    try {
      const cdp = await pg.context().newCDPSession(pg);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(OUT, `canvas-${ENGINE}${tag}.png`), Buffer.from(shot.data, "base64"));
      console.log("(cdp fallback)");
    } catch (e2) { console.log("canvas shot FAILED:", String(e2).slice(0, 120)); }
  }
  console.log("canvas:", `canvas-${ENGINE}${tag}.png`, new Date().toISOString().slice(11, 19));
}
// 終了前に可視状態を .kasc 既定へ戻す(session-state の vis に solo 状態が
// 残ると次回起動で applySessionState が非表示を復元してしまう)
await canvasVisible("").catch(() => {});
const dsLog = await pg.evaluate(() => (window.__dsLog || []).map(([t, k, v]) => `${new Date(t).toISOString().slice(11, 19)} ${k} ${v}`)).catch(() => []);
if (dsLog.length) console.log("dsLog:\n" + dsLog.join("\n"));
const apiCalls = await pg.evaluate(() => (window.__apiCalls || []).map(([t, k, a, s]) => `${new Date(t).toISOString().slice(11, 19)} ${k}(${a}) ← ${s}`)).catch(() => []);
if (apiCalls.length) console.log("apiCalls:\n" + apiCalls.join("\n"));
const rebuilds = await pg.evaluate(() => (window.__rebuildLog || []).map(([t, s]) => `\n${new Date(t).toISOString().slice(11, 19)} ${s}`)).catch(() => []);
if (rebuilds.length) console.log("rebuilds:" + rebuilds.join("\n"));
await browser.close();
console.log("DONE");
