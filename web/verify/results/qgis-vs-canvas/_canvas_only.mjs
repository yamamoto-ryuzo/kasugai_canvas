// Canvas 側のみの solo 撮影(QGIS 側は別途)
// 使い方: node _canvas_only.mjs <engine> <bbox> <project> <waitLayer> <layers...>
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const OUT = dirname(fileURLToPath(import.meta.url));
const ENGINE = process.argv[2] || "leaflet";
const BBOX = (process.argv[3] || "139.70,35.68,139.99,35.73").split(",").map(Number);
const PROJECT = process.argv[4] || "_qml_verify";
const WAIT_LAYER = process.argv[5];
const LAYERS = process.argv.slice(6);
const NOBASE = process.env.NOBASE === "1";
// 8510 はインストール版(C:\kasugai スナップショット)、8520 は dev 版
// (server/target/debug → C:\devin\kasugai_canvas\web をライブ配信)。
// 開発中コードの検証は CANVAS_PORT=8520 を使う
const CANVAS = `http://127.0.0.1:${process.env.CANVAS_PORT || "8510"}`;

const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 790, height: 841 } });
pg.on("console", () => {});
const projParam = PROJECT.startsWith("kasc:") ? `kasc=${PROJECT.slice(5)}` : `project=${PROJECT}`;
await pg.goto(`${CANVAS}/${ENGINE}/?${projParam}`, { waitUntil: "domcontentloaded", timeout: 30000 });
await pg.waitForFunction(() => window.kasugaiApi?.isReady === true || window._viewer, undefined, { timeout: 120000, polling: 800 }).catch(() => {});
await pg.waitForTimeout(4000);
// UI 非表示(パネルトグル畳み + CSS 隠し)
await pg.evaluate(() => { try { document.querySelector("#layer-panel-toggle")?.click(); } catch {} }).catch(() => {});
await pg.addStyleTag({ content: "#panel,#chat-panel,#load-progress{display:none!important}" }).catch(() => {});

// compare.mjs canvasVisible の移植版 — cesium は ds.show 直接切替
// (setLayerVisible は refreshLayers の全層 rebuild を起こしページを
// ブロックするため使わない)
async function solo(name, nobase) {
  return pg.evaluate(async ({ only, nobase: nb }) => {
    const api = window.kasugaiApi;
    const out = [];
    if (api?.engine === "cesium" && window._viewer) {
      const v = window._viewer;
      const items = api.listLayers();
      const orig = window.__origVis || (window.__origVis = new Map());
      for (const l of items) if (!orig.has(l.id)) orig.set(l.id, l.visible !== false);
      const visById = new Map();
      for (const l of items) {
        const want = only ? String(l.title || l.id) === only : orig.get(l.id) !== false;
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
        if (want === undefined) { if (nb) il.show = !only; continue; }
        il.show = want;
        if (only && want) { out.push(items.find(l => l.id === il._kasugaiLayerId)?.title || ""); targetRendered = true; }
      }
      if (only && !targetRendered) {
        for (const l of items) {
          if (String(l.title || l.id) !== only) continue;
          try { await api.setLayerVisible(l.id, true); out.push(l.title); } catch (_) {}
        }
      }
      try { v.scene.requestRender?.(); } catch (_) {}
      return out;
    }
    // gsimaps: iframe 内 tilePane を直接隠す
    if (nb && api?.engine === "gsimaps") {
      try {
        const w = document.querySelector("iframe")?.contentWindow;
        const d = w?.document;
        if (only) {
          if (!window.__gsiNobase || window.__gsiNobase.ownerDocument !== d || !d.head.contains(window.__gsiNobase)) {
            window.__gsiNobase = d.createElement("style");
            window.__gsiNobase.textContent =
              ".leaflet-tile-pane,.leaflet-control-minimap{display:none!important}" +
              ".leaflet-container{background:#fff!important}";
            d.head.appendChild(window.__gsiNobase);
          }
        } else if (window.__gsiNobase) { window.__gsiNobase.remove(); window.__gsiNobase = undefined; }
      } catch (_) {}
    }
    // 非cesium: NOBASE 時は setBasemap("none") + leaflet は deck チェックも外す
    if (nb && api?.engine !== "gsimaps" && typeof api?.setBasemap === "function") {
      try {
        if (only) {
          if (window.__savedBasemap === undefined) {
            const sel = (api.listBasemaps?.() || []).find(b => b.selected);
            window.__savedBasemap = sel ? sel.title : null;
          }
          api.setBasemap("none");
          const dcb = document.querySelector("#drape-tiles3d-basemap");
          if (dcb) {
            if (window.__savedDrapeBase === undefined) window.__savedDrapeBase = dcb.checked;
            if (dcb.checked) dcb.click();
          }
        } else {
          if (window.__savedBasemap) { api.setBasemap(window.__savedBasemap); window.__savedBasemap = undefined; }
          const dcb = document.querySelector("#drape-tiles3d-basemap");
          if (dcb && window.__savedDrapeBase === true && !dcb.checked) { dcb.click(); window.__savedDrapeBase = undefined; }
        }
      } catch (_) {}
    }
    const wantMap = new Map();
    const origN = window.__origVisN || (window.__origVisN = new Map());
    for (const l of api?.listLayers?.() || []) {
      if (!origN.has(l.id)) origN.set(l.id, l.visible !== false);
      wantMap.set(l, only ? String(l.title || l.id) === only : origN.get(l.id) !== false);
    }
    for (const [l, want] of wantMap) {
      try {
        const ok = await Promise.race([
          Promise.resolve(api.setLayerVisible(l.id, want)),
          new Promise(res => setTimeout(() => res("TIMEOUT"), 10000)),
        ]);
        if (want && ok !== "TIMEOUT") out.push(l.title);
      } catch (_) {}
    }
    return out;
  }, { only: name, nobase });
}

// compare.mjs 実績版 setCam — cesium: 4隅を worldToWindowCoordinates で
// 投影して全角が画面内に収まるまで高さ反復(pitch はアプリの -85 矯正を
// 考慮して -84)。navara: kascView.setCamera の distance 即時配置。
// 他: kasugaiApi.fitBounds(w,s,e,n) 4引数
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
  try { if (window.kasugaiApi.fitBounds) { window.kasugaiApi.fitBounds(bbox[0], bbox[1], bbox[2], bbox[3]); return "fitBounds"; } } catch (_) {}
  try { if (window.kasugaiApi.zoomToExtent) return window.kasugaiApi.zoomToExtent(bbox[0], bbox[1], bbox[2], bbox[3]); } catch (_) {}
  try { window.kasugaiApi.setView?.({ longitude: midLng, latitude: midLat, zoom: 13 }); } catch (_) {}
})()`;

const isCesium = await pg.evaluate(() => window.kasugaiApi.engine === "cesium");
const camArg = { bbox: BBOX, vw: 790, vh: 841 };
await solo("", false);
await pg.waitForTimeout(1500);
await pg.evaluate(`${setCam.replace(")()", `)(${JSON.stringify(camArg)})`)}`);
// cesium: setView は進行中 flyTo を殺せないため安定するまで再適用
for (let i = 0; i < (isCesium ? 30 : 0); i++) {
  await pg.waitForTimeout(1500);
  const h = await pg.evaluate(`${setCam.replace(")()", `)(${JSON.stringify(camArg)})`)}`);
  await pg.waitForTimeout(800);
  const cam = await pg.evaluate(() => window.kasugaiApi.getCamera?.()).catch(() => null);
  if (cam && Number.isFinite(h) && Math.abs(cam.height - h) / h < 0.02) {
    await pg.waitForTimeout(1200);
    const cam2 = await pg.evaluate(() => window.kasugaiApi.getCamera?.()).catch(() => null);
    if (cam2 && Math.abs(cam2.height - h) / h < 0.02) { console.log("camera stable at", Math.round(cam2.height)); break; }
  }
}
for (const layer of LAYERS) {
  // 遅延 rebuild で ds が後から生えて他層が漏れるため、solo を2連続で
  // 再適用して収束させる(compare.mjs の settled ループ簡易版)
  for (let k = 0; k < 3; k++) {
    await Promise.race([solo(layer, NOBASE), new Promise((_, rej) => setTimeout(() => rej(new Error("solo timeout")), 90000))]).catch(e => console.log(e.message));
    await pg.waitForTimeout(k ? 1500 : 400);
  }
  // cesium は moveEnd→rebuild 連鎖を避けるためカメラ再適用しない
  if (!isCesium) await pg.evaluate(`${setCam.replace(")()", `)(${JSON.stringify(camArg)})`)}`);
  await pg.waitForTimeout(2500);
  await pg.screenshot({ path: join(OUT, `canvas-${ENGINE}-${layer}.png`) });
  console.log("canvas:", `canvas-${ENGINE}-${layer}.png`);
}
await pg.evaluate(() => { try { const api = window.kasugaiApi; (api?.listLayers?.() || []).forEach(l => api.setLayerVisible(l.id ?? l.name, true)); } catch {} });
await browser.close();
console.log("DONE");
