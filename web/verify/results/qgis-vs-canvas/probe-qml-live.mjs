// probe-qml-live.mjs — 起動中 QGIS と dev Canvas の LIVE ペア検証
// QGIS 側: 実 live_dir(~/.qgis-live/run/qgis-<pid>/geo_driver)に直接接続し、
//          __qmltest_verify グループ配下の qmltest_* を層ごとに solo→canvas screenshot
// Canvas 側: dev :8520 に ?kasc=http://127.0.0.1:8089/live/kasc を読ませ、
//          同名層(タイトルの末尾パート)を solo→同範囲 screenshot
// usage: node probe-qml-live.mjs <engine> [layer1,layer2,...]
// env:   CANVAS_PORT(既定8520) NOBASE(既定1)
// 出力:  web/verify/results/qgis-vs-canvas/live-{qgis,canvas}-<engine>-<layer>.png
import { LivePage } from "file:///C:/devin/qgis_live_harness/scripts/live-drive.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const ENGINE = process.argv[2] || "cesium";
const BBOX = [139.70, 35.68, 139.99, 35.73];
const ALL_SOLO = process.argv[3]
  ? process.argv[3].split(",").map(s => s.trim()).filter(Boolean)
  : null;
const NOBASE = (process.env.NOBASE ?? "1") === "1";
const CANVAS = `http://127.0.0.1:${process.env.CANVAS_PORT || "8520"}`;
const KASC = process.env.KASC_URL || "http://127.0.0.1:8089/live/kasc";
const OUT = dirname(fileURLToPath(import.meta.url));

// --- 実 live_dir をレジストリから解決 ---
const regDir = join(homedir(), ".qgis-live");
const reg = readdirSync(regDir).filter(f => f.endsWith("-geo_driver.json"))
  .map(f => { try { return JSON.parse(readFileSync(join(regDir, f), "utf8")); } catch { return null; } })
  .filter(r => r && r.live_dir && existsSync(r.live_dir))
  .sort((a, b) => (b.started || 0) - (a.started || 0))[0];
if (!reg) { console.log("FATAL: no live geo_driver registry"); process.exit(2); }
const page = new LivePage(reg.live_dir);
const st = await page.status().catch(e => ({ err: String(e) }));
if (!st?.pid) { console.log("FATAL: driver not responding", st); process.exit(2); }
console.log("driver pid:", st.pid, "live_dir:", reg.live_dir);

// --- QGIS: 対象レイヤ名一覧(実在確認) ---
const namesRes = await page.pyeval(`
from qgis.core import QgsProject
grp = QgsProject.instance().layerTreeRoot().findGroup('__qmltest_verify')
result = ','.join(sorted(n.layer().name() for n in grp.findLayers())) if grp else ''
`, { timeoutMs: 30000 });
const QGIS_LAYERS = String(namesRes || "").split(",").filter(Boolean);
console.log("qmltest layers in QGIS:", QGIS_LAYERS.length);
const shots = ALL_SOLO || QGIS_LAYERS;

// --- QGIS: 範囲設定 → 実表示範囲を4326で取得 ---
const extStr = await page.pyeval(`
from qgis.core import QgsCoordinateReferenceSystem, QgsCoordinateTransform, QgsRectangle, QgsProject
from qgis.utils import iface
xform = QgsCoordinateTransform(QgsCoordinateReferenceSystem("EPSG:4326"), QgsProject.instance().crs(), QgsProject.instance())
r = xform.transformBoundingBox(QgsRectangle(${BBOX.join(",")}))
iface.mapCanvas().setExtent(r)
iface.mapCanvas().refresh()
xback = QgsCoordinateTransform(QgsProject.instance().crs(), QgsCoordinateReferenceSystem("EPSG:4326"), QgsProject.instance())
r4326 = xback.transformBoundingBox(iface.mapCanvas().extent())
result = f"{r4326.xMinimum()},{r4326.yMinimum()},{r4326.xMaximum()},{r4326.yMaximum()}"
`, { timeoutMs: 60000 });
const extNums = /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(String(extStr));
const BBOX_ACT = extNums ? extNums.slice(1).map(Number) : BBOX;
console.log("qgis extent(4326):", extStr);

const qgisSize = await page.pyeval(`
from qgis.utils import iface
s = iface.mapCanvas().size()
result = f"{s.width()}x{s.height()}"
`).catch(() => null);
const [vw, vh] = /(\d+)x(\d+)/.exec(String(qgisSize))?.slice(1).map(Number) || [1400, 900];
console.log("qgis canvas size:", vw, "x", vh);

// --- QGIS: 対象層を単体・白背景で同期オフスクリーンレンダ ---
// (setItemVisibilityChecked→canvas.grab は非同期再描画でフレームが混在する
// ため使わない。SequentialJob は呼出スレッドで完走し PNG を直接保存する)
async function qgisShot(leaf, tag) {
  const out = await page.pyeval(`
from qgis.core import QgsProject, QgsMapSettings, QgsMapRendererSequentialJob, QgsRectangle, QgsCoordinateReferenceSystem, QgsCoordinateTransform
from qgis.PyQt.QtCore import QSize
from qgis.PyQt.QtGui import QColor
proj = QgsProject.instance()
lay = None
for n in proj.layerTreeRoot().findLayers():
    if n.layer().name() == ${JSON.stringify(leaf)}: lay = n.layer()
if not lay:
    result = "NOTFOUND"
else:
    ms = QgsMapSettings()
    ms.setLayers([lay])
    ms.setDestinationCrs(proj.crs())
    xf = QgsCoordinateTransform(QgsCoordinateReferenceSystem("EPSG:4326"), proj.crs(), proj)
    ms.setExtent(xf.transformBoundingBox(QgsRectangle(${BBOX.join(",")})))
    ms.setOutputSize(QSize(${vw}, ${vh}))
    ms.setBackgroundColor(QColor(255, 255, 255, 255))
    job = QgsMapRendererSequentialJob(ms)
    job.start()
    job.waitForFinished()
    job.renderedImage().save(r"${join(OUT, `${tag}.png`).replaceAll("\\", "/")}")
    result = "ok"
`, { timeoutMs: 90000 });
  console.log("qgis:", tag, "->", out);
}

// --- Canvas: Playwright ---
const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: vw, height: vh } });
const pageErrs = [], qmlWarns = [];
pg.on("pageerror", e => pageErrs.push(String(e).slice(0, 200)));
pg.on("console", m => {
  const t = m.text();
  if (/QML スタイル/.test(t)) qmlWarns.push(t.slice(0, 220));
  else if (m.type() === "error" && !/favicon|ui\.config|net::ERR|404|403/.test(t)) pageErrs.push(t.slice(0, 200));
});
await pg.addInitScript(() => { try { localStorage.removeItem("kasugai:session-state"); } catch (_) {} });
await pg.route("**/api/command**", r => r.fulfill({ status: 200, contentType: "application/json", body: '{"commands":[],"latest":0,"ok":true,"results":[]}' }));
await pg.goto(`${CANVAS}/${ENGINE}/?kasc=${encodeURIComponent(KASC)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await pg.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0, undefined, { timeout: 90000 });
await pg.waitForFunction(() => window.kasugaiApi?.isReady === true, undefined, { timeout: 180000, polling: 1000 }).catch(() => console.log("WARN: isReady timeout"));
// ロード静止判定の状態変数
await pg.evaluate(() => {
  window.__lpSeenVisible = false; window.__lpHiddenAt = 0; window.__lastDsEvent = Date.now();
  let lastDs = -1, lastPrim = -1;
  setInterval(() => {
    const lp = document.querySelector("#load-progress");
    if (lp && !lp.hidden) { window.__lpSeenVisible = true; window.__lpHiddenAt = 0; }
    else if (!window.__lpHiddenAt) window.__lpHiddenAt = Date.now();
    const v = window._viewer;
    if (v) {
      const dc = v.dataSources.length, pc = v.scene.primitives.length;
      if (dc !== lastDs || pc !== lastPrim) { lastDs = dc; lastPrim = pc; window.__lastDsEvent = Date.now(); }
    }
  }, 250);
});
const leafOf = t => String(t || "").split("/").pop().trim();

async function canvasVisible(only) {
  return pg.evaluate(async ({ only, nobase }) => {
    const leafOf = t => String(t || "").split("/").pop().trim();
    const out = [];
    if (window.kasugaiApi.engine === "cesium" && window._viewer) {
      const v = window._viewer;
      const items = window.kasugaiApi.listLayers();
      const orig = window.__origVis || (window.__origVis = new Map());
      for (const l of items) if (!orig.has(l.id)) orig.set(l.id, l.visible !== false);
      const visById = new Map();
      for (const l of items) {
        const want = only ? leafOf(l.title || l.id) === only : orig.get(l.id) !== false;
        l.visible = want;
        visById.set(l.id, want);
      }
      let targetRendered = false;
      for (let i = 0; i < v.dataSources.length; i++) {
        const d = v.dataSources.get(i);
        const want = visById.get(d._kasugaiLayerId);
        if (want === undefined) continue;
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
      for (let i = 0; i < v.imageryLayers.length; i++) {
        const il = v.imageryLayers.get(i);
        if (!il) continue;
        const want = visById.get(il._kasugaiLayerId);
        if (want === undefined) { if (nobase) il.show = !only; continue; }
        il.show = want;
        if (only && want) { out.push(items.find(l => l.id === il._kasugaiLayerId)?.title || ""); targetRendered = true; }
      }
      if (only && !targetRendered) {
        for (const l of items) {
          if (leafOf(l.title || l.id) !== only) continue;
          try { await window.kasugaiApi.setLayerVisible(l.id, true); out.push(l.title); } catch (_) {}
        }
      }
      try { v.scene.requestRender?.(); } catch (_) {}
      return out;
    }
    if (nobase && window.kasugaiApi.engine === "gsimaps") {
      try {
        const w = document.querySelector("iframe")?.contentWindow;
        const d = w?.document;
        if (only) {
          if (!window.__gsiNobase || window.__gsiNobase.ownerDocument !== d || !d.head.contains(window.__gsiNobase)) {
            window.__gsiNobase = d.createElement("style");
            window.__gsiNobase.textContent = ".leaflet-tile-pane,.leaflet-control-minimap{display:none!important}.leaflet-container{background:#fff!important}";
            d.head.appendChild(window.__gsiNobase);
          }
        } else if (window.__gsiNobase) { window.__gsiNobase.remove(); window.__gsiNobase = undefined; }
      } catch (_) {}
    }
    if (nobase && window.kasugaiApi.engine !== "gsimaps" && typeof window.kasugaiApi.setBasemap === "function") {
      try {
        if (only) {
          if (window.__savedBasemap === undefined) {
            const sel = (window.kasugaiApi.listBasemaps?.() || []).find(b => b.selected);
            window.__savedBasemap = sel ? sel.title : null;
          }
          window.kasugaiApi.setBasemap("none");
          const dcb = document.querySelector("#drape-tiles3d-basemap");
          if (dcb) { if (window.__savedDrapeBase === undefined) window.__savedDrapeBase = dcb.checked; if (dcb.checked) dcb.click(); }
        } else {
          if (window.__savedBasemap) { window.kasugaiApi.setBasemap(window.__savedBasemap); window.__savedBasemap = undefined; }
          const dcb = document.querySelector("#drape-tiles3d-basemap");
          if (dcb && window.__savedDrapeBase === true && !dcb.checked) { dcb.click(); window.__savedDrapeBase = undefined; }
        }
      } catch (_) {}
    }
    const wantMap = new Map();
    const origN = window.__origVisN || (window.__origVisN = new Map());
    for (const l of window.kasugaiApi.listLayers()) {
      if (!origN.has(l.id)) origN.set(l.id, l.visible !== false);
      wantMap.set(l, only ? leafOf(l.title || l.id) === only : origN.get(l.id) !== false);
    }
    if (typeof window.kasugaiApi.setLayerVisible === "function") {
      for (const [l, want] of wantMap) {
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
    return out;
  }, { only, nobase: NOBASE });
}

// カメラ合わせ(compare.mjs と同じ)
const setCam = `(async ({ bbox, vw, vh }) => {
  const midLat = (bbox[1] + bbox[3]) / 2, midLng = (bbox[0] + bbox[2]) / 2;
  const mPerDegLat = 111320, mPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180);
  const wM = Math.abs(bbox[2] - bbox[0]) * mPerDegLng, hM = Math.abs(bbox[3] - bbox[1]) * mPerDegLat;
  const aspect = vw / vh, tan30 = Math.tan(Math.PI / 6);
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
  if (window.kasugaiApi.engine === "navara") {
    try {
      if (window.kascView?.setCamera) { window.kascView.setCamera({ lng: midLng, lat: midLat, height: 0, distance: height, heading: 0, pitch: -90, roll: 0 }); return "navara-dist:" + Math.round(height); }
      window.kasugaiApi.setView?.({ lng: midLng, lat: midLat, longitude: midLng, latitude: midLat, height, heading: 0, pitch: -85 });
      return "navara-height:" + Math.round(height);
    } catch (_) {}
  }
  try { if (window.kasugaiApi.fitBounds) { window.kasugaiApi.fitBounds(bbox[0], bbox[1], bbox[2], bbox[3]); return "fitBounds"; } } catch (_) {}
})(${JSON.stringify({ bbox: BBOX_ACT, vw, vh })})`;

// --- 実行 ---
console.log("visible on:", (await canvasVisible("")).length, "layers (preload)");
const layerRendered = async (name) => pg.waitForFunction(async (want) => {
  if (!window.__lpSeenVisible || !window.__lpHiddenAt || Date.now() - window.__lpHiddenAt < 4000) return false;
  if (Date.now() - (window.__lastDsEvent || 0) < 4000) return false;
  const leafOf = t => String(t || "").split("/").pop().trim();
  const ls = window.kasugaiApi.listLayers().filter(l => leafOf(l.title || l.id) === want);
  if (!ls.length) return false;
  const v = window._viewer || null;
  for (const l of ls) {
    if (l.type === "tile" || l.type === "xyz") continue;
    let ok = false;
    if (v) {
      for (let i = 0; i < v.dataSources.length; i++) {
        const d = v.dataSources.get(i);
        if (d._kasugaiLayerId === l.id && d.entities.values.length > 0) { ok = true; break; }
      }
      if (!ok) for (let i = 0; i < v.scene.primitives.length; i++) {
        const p = v.scene.primitives.get(i);
        if (p && p._kasugaiLayerId === l.id) { ok = true; break; }
      }
    } else {
      try { const g = await window.kasugaiApi.getLayerGeoJson(l.id); if (g?.features?.length > 0) ok = true; } catch (_) {}
    }
    if (!ok) return false;
  }
  return true;
}, name, { timeout: 180000, polling: 1500 }).then(() => true).catch(() => false);

const waitLayer = shots[0];
console.log("layer loaded:", await layerRendered(waitLayer), `(${waitLayer})`);

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
await pg.evaluate(() => { try { document.querySelector("#layer-panel-toggle")?.click(); } catch (_) {} });
if (!isCesium) await pg.evaluate(() => {
  const st = document.createElement("style");
  st.id = "__solo-hide-ui";
  st.textContent = "#panel,#chat-panel{display:none!important}";
  document.head.appendChild(st);
});
await pg.waitForTimeout(1500);

const results = [];
for (const solo of shots) {
  const tag = `-${solo}`;
  await pg.evaluate(() => { window.__lpHiddenAt = 0; });
  const soloVis = await Promise.race([
    canvasVisible(solo),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`canvasVisible timeout: ${solo}`)), 120000)),
  ]).catch(e => { console.log("canvas solo ERR:", String(e)); return []; });
  console.log("canvas solo:", soloVis.join(","));
  await qgisShot(solo, `live-qgis-${ENGINE}${tag}`);
  if (!isCesium) { await pg.evaluate(setCam); await pg.waitForTimeout(2500); }
  else await pg.waitForTimeout(500);
  // solo 収束確認
  let settled = false;
  for (let attempt = 0; attempt < 10 && !settled; attempt++) {
    await canvasVisible(solo);
    await pg.waitForTimeout(1200);
    const diag = await pg.evaluate((want) => {
      const leafOf = t => String(t || "").split("/").pop().trim();
      const v = window._viewer;
      const idTitle = new Map();
      for (const l of window.kasugaiApi.listLayers()) idTitle.set(l.id, leafOf(l.title || l.id));
      if (!v) return { text: "non-cesium", target: true, others: 0 };
      let target = false, targetInfo = "absent";
      const leaks = [];
      for (let i = 0; i < v.dataSources.length; i++) {
        const d = v.dataSources.get(i);
        const title = idTitle.get(d._kasugaiLayerId);
        const shown = d.entities.values.filter(e => e.show !== false).length;
        if (title === want) { target = d.show !== false && shown > 0; targetInfo = `ents=${d.entities.values.length} shown=${shown} show=${d.show}`; }
        else if (d.show !== false && shown > 0) leaks.push(`ds:${title || "?"}`);
      }
      for (let i = 0; i < v.scene.primitives.length; i++) {
        const p = v.scene.primitives.get(i);
        const title = p && idTitle.get(p._kasugaiLayerId);
        if (title && title !== want && p.show !== false) leaks.push(`prim:${title}`);
        else if (title === want && p.show !== false) { target = true; targetInfo += " +prim"; }
      }
      for (let i = 1; i < v.imageryLayers.length; i++) {
        const il = v.imageryLayers.get(i);
        if (!il || il.show === false) continue;
        const title = idTitle.get(il._kasugaiLayerId);
        if (title === want) { target = true; targetInfo += " +img"; }
        else leaks.push(`img:${title || "?"}:${il.imageryProvider?.constructor?.name || "?"}`);
      }
      return { text: `target ${targetInfo} others=${leaks.length} LEAK=${leaks.join(",")}`, target, others: leaks.length };
    }, solo);
    console.log("  diag:", solo, "→", diag.text);
    settled = diag.target && diag.others === 0;
    if (!settled) await pg.waitForTimeout(4000);
  }
  if (!settled) console.log("WARN: solo not settled:", solo);
  results.push([solo, settled]);
  await pg.evaluate(() => window._viewer?.scene?.requestRender?.());
  await pg.waitForTimeout(800);
  try {
    await pg.screenshot({ path: join(OUT, `live-canvas-${ENGINE}${tag}.png`), timeout: 20000 });
  } catch (_) {
    try {
      const cdp = await pg.context().newCDPSession(pg);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(OUT, `live-canvas-${ENGINE}${tag}.png`), Buffer.from(shot.data, "base64"));
      console.log("(cdp fallback)");
    } catch (e2) { console.log("canvas shot FAILED:", String(e2).slice(0, 120)); }
  }
  console.log("canvas:", `live-canvas-${ENGINE}${tag}.png`);
}
await canvasVisible("").catch(() => {});
console.log("=== SOLO RESULT ===");
for (const [n, ok] of results) console.log(`  ${ok ? "OK" : "WARN"} ${n}`);
console.log("PAGEERR", pageErrs.length, JSON.stringify(pageErrs.slice(0, 8)));
console.log("QMLWARN", qmlWarns.length);
for (const w of qmlWarns.slice(0, 40)) console.log("  ", w);
await browser.close();
console.log("DONE");
