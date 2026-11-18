// QML 縮尺連動 回帰検証プローブ (qml-scale スキル準拠・機械検証版)
// scale_test: 広域=ポリゴン青(60,100,220)・点1.2mm・ラベル非表示
//             詳細=ポリゴン緑(40,180,60)・点5mm・ラベル表示
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:8510";
const OUT = "C:/Users/ryu.RYU-NOTE/AppData/Local/Temp";
const KASC = encodeURIComponent(`${BASE}/projects/scale_test/kasugai_canvas.kasc`);
// 両国(139.793,35.678) と江東区ポリゴン西端(139.80)が両方入る中心
const C_LON = 139.797, C_LAT = 35.6775;
const PT = [139.793, 35.678];          // 両国 (マーカー計測点)
const POLY_WIDE = [139.82, 35.6725];   // 江東区ポリゴン重心 (広域サンプル)
const POLY_DETAIL = [139.801, 35.678]; // ポリゴン内・西端寄り (詳細サンプル)
const ENGINES = process.argv[2] ? process.argv[2].split(",") : ["cesium", "maplibre", "openlayers", "leaflet"];

const readScale = (page) => page.evaluate(async () =>
  (await import("/shared/qml-style.js")).evalQgisExpression("@map_scale"));

const setView = (page, mode, eng) => page.evaluate(([mode, lon, lat, eng]) => {
  // mode: "wide"=広域(分母>8000) / "detail"=詳細(分母<5000)
  if (window.kasugaiApi?.getViewer) {
    const v = window.kasugaiApi.getViewer();
    v.camera.cancelFlight();
    v.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, mode === "wide" ? 6000 : 1200),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    v.scene.requestRender();
  } else {
    // maplibre は getZoom が 512px 基準(正典-1)なので 1 小さい値を渡す
    const z = eng === "maplibre" ? (mode === "wide" ? 14 : 16) : (mode === "wide" ? 15 : 17);
    window.kasugaiApi?.flyTo({ latitude: lat, longitude: lon, zoom: z, instant: true });
  }
}, [mode, C_LON, C_LAT, eng]);

// ---- エンジン別 機械読み取り ----
const readers = {
  cesium: async (page) => page.evaluate(() => {
    const v = window._viewer;
    const now = Cesium.JulianDate.now();
    const polys = [], marks = [], labels = [];
    const dsc = v.dataSources;
    const all = [];
    for (let i = 0; i < dsc.length; i++) all.push(...dsc.get(i).entities.values);
    all.forEach(e => {
      if (e.polygon) {
        const c = e.polygon.material?.color?.getValue(now);
        if (c) polys.push([Math.round(c.red * 255), Math.round(c.green * 255), Math.round(c.blue * 255)]);
      }
      if (e.billboard) {
        const img = e.billboard.image?.getValue(now);
        const w = img?.width ?? img?.naturalWidth ?? img?.image?.width ?? null;
        marks.push(w);
      }
      if (e.label) {
        const ddc = e.label.distanceDisplayCondition?.getValue(now);
        const pos = e.position?.getValue(now);
        let vis = null;
        if (ddc && pos) {
          const d = Cesium.Cartesian3.distance(v.camera.position, pos);
          vis = d >= ddc.near && d <= ddc.far;
        }
        labels.push({ ddc: ddc ? [Math.round(ddc.near), Math.round(ddc.far)] : null, vis });
      }
    });
    return { polys, marks, labels };
  }),

  maplibre: async (page) => page.evaluate(async () => {
    const m = window.kascMap;
    await new Promise(res => { if (m.loaded() && !m.isMoving()) res(); else m.once("idle", res); setTimeout(res, 5000); });
    const feats = m.queryRenderedFeatures();
    const fills = new Set(), crs = new Set();
    feats.forEach(f => {
      const p = f.properties || {};
      if (p.__kasc_fill) fills.add(p.__kasc_fill);
      if (p.__kasc_cr != null) crs.add(p.__kasc_cr);
    });
    const labelLayers = m.getStyle().layers
      .filter(l => l.type === "symbol" && JSON.stringify(l.filter || "").includes("__kasc_label"))
      .map(l => ({ id: l.id, minzoom: l.minzoom, maxzoom: l.maxzoom }));
    let labelCount = 0;
    for (const ll of labelLayers) {
      try { labelCount += m.queryRenderedFeatures({ layers: [ll.id] }).length; } catch (_) {}
    }
    const propKeys = [...new Set(feats.flatMap(f => Object.keys(f.properties || {})))].slice(0, 30);
    return { fills: [...fills], crs: [...crs], labelCount, labelLayers, zoom: m.getZoom(), featCount: feats.length, propKeys };
  }),

  openlayers: async (page, mode) => page.evaluate(async ([mode, PT, PW, PD]) => {
    const m = window.kascMap;
    const { fromLonLat } = await import("https://cdn.jsdelivr.net/npm/ol@10.11.0/proj.js");
    const proj = (lonlat) => m.getPixelFromCoordinate(fromLonLat(lonlat));
    const polyc = proj(mode === "wide" ? PW : PD);
    const ptc = proj(PT);
    const out = { fillPx: [], markBox: null, labelRedPx: 0 };
    const isMarker = (r, g, b) => r > 190 && g > 15 && g < 75 && b > 15 && b < 75;   // 220,40,40
    const isLabel = (r, g, b) => r > 140 && r < 210 && g < 15 && b < 15;             // 180,0,0
    for (const cv of document.querySelectorAll(".ol-layer canvas")) {
      const ctx = cv.getContext("2d");
      if (!ctx || !cv.width) continue;
      const sx = cv.width / cv.clientWidth, sy = cv.height / cv.clientHeight;
      const px = Math.round(polyc[0] * sx), py = Math.round(polyc[1] * sy);
      if (px >= 0 && py >= 0 && px < cv.width && py < cv.height) {
        const d = ctx.getImageData(px, py, 1, 1).data;
        if (d[3] > 40) out.fillPx.push([d[0], d[1], d[2]]);
      }
      // マーカー: 点の周辺 ±40px でマーカー色ピクセルの bbox
      const wx = Math.round(ptc[0] * sx), wy = Math.round(ptc[1] * sy);
      let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1, found = 0;
      const W = 45;
      const x0 = Math.max(0, wx - W), x1 = Math.min(cv.width - 1, wx + W);
      const y0 = Math.max(0, wy - W), y1 = Math.min(cv.height - 1, wy + W);
      if (x1 > x0 && y1 > y0) {
        const img = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
        for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          if (img.data[i + 3] < 40) continue;
          if (isMarker(img.data[i], img.data[i + 1], img.data[i + 2])) {
            found++;
            if (x < minx) minx = x; if (x > maxx) maxx = x;
            if (y < miny) miny = y; if (y > maxy) maxy = y;
          }
          if (isLabel(img.data[i], img.data[i + 1], img.data[i + 2])) out.labelRedPx++;
        }
        if (found > 4) out.markBox = [maxx - minx + 1, maxy - miny + 1, found];
      }
    }
    return out;
  }, [mode, PT, POLY_WIDE, POLY_DETAIL]),

  leaflet: async (page) => page.evaluate(() => {
    const paths = [...document.querySelectorAll(".leaflet-overlay-pane svg path, .leaflet-pane svg path")];
    const fills = [...new Set(paths.map(p => p.getAttribute("fill")).filter(f => f && f !== "none"))];
    const icons = [...document.querySelectorAll(".leaflet-marker-icon")].map(el => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    });
    const tips = [...document.querySelectorAll(".leaflet-tooltip")].map(el =>
      ({ disp: getComputedStyle(el).display, vis: el.offsetParent !== null, text: el.textContent }));
    return { fills, icons, tips };
  }),
};

const judge = (eng, mode, r) => {
  // 期待: wide=青(60,100,220)+小マーカー+ラベル無 / detail=緑(40,180,60)+大マーカー+ラベル有
  const ok = [], ng = [];
  if (eng === "cesium") {
    const c = r.polys[0] || [];
    const green = c[1] > c[0] && c[1] > c[2], blue = c[2] > c[0] && c[2] > c[1];
    (mode === "wide" ? blue : green) ? ok.push("fill") : ng.push(`fill=${JSON.stringify(r.polys)}`);
    const w = r.marks.find(x => x != null);
    if (w == null) ng.push("mark=?");
    else (mode === "wide" ? w <= 14 : w >= 15) ? ok.push(`mark=${w}px`) : ng.push(`mark=${w}px`);
    const lv = r.labels.map(l => l.vis);
    // DDC は距離ゲートのため detail でも遠方ラベルは隠れる。画面内の近いものが見えればOK
    (mode === "wide" ? lv.every(v => v === false) : lv.some(v => v === true)) ? ok.push("label") : ng.push(`label=${JSON.stringify(r.labels)}`);
  } else if (eng === "maplibre") {
    const f = r.fills.join(",");
    const hasGreen = /40|green|#28b43c/i.test(f), hasBlue = /220|blue|#3c64dc/i.test(f);
    (mode === "wide" ? hasBlue && !hasGreen : hasGreen && !hasBlue) ? ok.push("fill") : ng.push(`fill=${f}`);
    const cr = Math.max(...r.crs.map(Number).filter(Number.isFinite));
    if (!Number.isFinite(cr)) ng.push("cr=?");
    else (mode === "wide" ? cr <= 6 : cr >= 8) ? ok.push(`cr=${cr}`) : ng.push(`cr=${cr}`);
    (mode === "wide" ? r.labelCount === 0 : r.labelCount > 0) ? ok.push(`label=${r.labelCount}`) : ng.push(`label=${r.labelCount}`);
  } else if (eng === "openlayers") {
    const c = r.fillPx[0] || [];
    const green = c[1] > c[0] && c[1] > c[2], blue = c[2] > c[0] && c[2] > c[1];
    (mode === "wide" ? blue : green) ? ok.push("fill") : ng.push(`fill=${JSON.stringify(r.fillPx)}`);
    if (!r.markBox) ng.push("mark=notfound");
    else (mode === "wide" ? r.markBox[0] <= 14 : r.markBox[0] >= 15) ? ok.push(`mark=${r.markBox[0]}px`) : ng.push(`mark=${JSON.stringify(r.markBox)}`);
    (mode === "wide" ? r.labelRedPx === 0 : r.labelRedPx > 0) ? ok.push(`label=${r.labelRedPx}px`) : ng.push(`labelpx=${r.labelRedPx}`);
  } else if (eng === "leaflet") {
    const f = r.fills.join(",");
    const hasGreen = /#28b43c|rgb\(40/.test(f), hasBlue = /#3c64dc|rgb\(60/.test(f);
    (mode === "wide" ? hasBlue && !hasGreen : hasGreen && !hasBlue) ? ok.push("fill") : ng.push(`fill=${f}`);
    const w = Math.max(...r.icons.map(i => i[0]).filter(Number.isFinite));
    if (!Number.isFinite(w) || w <= 0) ng.push("mark=?");
    else (mode === "wide" ? w <= 14 : w >= 15) ? ok.push(`mark=${w}px`) : ng.push(`mark=${w}px`);
    const shown = r.tips.filter(t => t.vis).length;
    (mode === "wide" ? shown === 0 : shown > 0) ? ok.push(`label=${shown}`) : ng.push(`label=${JSON.stringify(r.tips)}`);
  }
  return { ok, ng };
};

const browser = await chromium.launch();
const results = {};
for (const eng of ENGINES) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", e => console.log(`[${eng} err]`, String(e).slice(0, 200)));
  results[eng] = {};
  try {
    await page.goto(`${BASE}/${eng}/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, { timeout: 40000 });
    await page.waitForTimeout(4500);
    for (const mode of ["wide", "detail"]) {
      await setView(page, mode, eng);
      await page.waitForTimeout(2600);
      const scale = Math.round(await readScale(page));
      const raw = await readers[eng](page, mode);
      const j = judge(eng, mode, raw);
      results[eng][mode] = { scale, ...j };
      await page.screenshot({ path: `${OUT}/scale-${eng}-${mode}.png` });
      console.log(`${eng} ${mode}: scale=${scale} OK[${j.ok.join(",")}] ${j.ng.length ? "NG[" + j.ng.join(",") + "]" : ""}`);
    }
  } catch (e) {
    console.log(`${eng}: FAILED`, String(e).slice(0, 300));
    results[eng].error = String(e).slice(0, 200);
  }
  await page.close();
}
await browser.close();
console.log("=== SUMMARY ===");
for (const [eng, r] of Object.entries(results)) {
  const allOk = ["wide", "detail"].every(m => r[m] && r[m].ng && r[m].ng.length === 0);
  console.log(`${eng}: ${r.error ? "ERROR " + r.error : allOk ? "PASS" : "FAIL " + JSON.stringify(r)}`);
}
