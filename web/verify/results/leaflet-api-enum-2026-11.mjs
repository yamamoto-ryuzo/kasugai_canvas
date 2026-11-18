// engine-leaflet 監査: Leaflet 1.9.4 + 採用プラグインの API サーフェス実行時列挙
// 出力: leaflet-api-enum-2026-11.json
// 使い方: node web/verify/results/leaflet-api-enum-2026-11.mjs  (サーバー :8510 起動中)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const result = {};
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 160)));

await page.goto(`${BASE}/leaflet/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.L && window.kascMap, { timeout: 90000 });

// プラグインを実ロードしてから列挙（markercluster/heat は lazy load）
await page.evaluate(async () => {
  const load = src => new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });
  try { await load("https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"); } catch (e) { window.__mcErr = String(e); }
  try { await load("https://cdn.jsdelivr.net/npm/leaflet.heat@1.0.1/dist/leaflet-heat-global.js"); } catch (e) { window.__heatErr = String(e); }
});

result.leaflet = await page.evaluate(() => {
  const proto = c => { try { return Object.getOwnPropertyNames(c.prototype).filter(n => n !== "constructor"); } catch { return []; } };
  const pubProto = c => proto(c).filter(n => !n.startsWith("_"));
  const opts = c => { try { return { ...c.prototype.options }; } catch { return null; } };
  const classes = {};
  // L 直下のコンストラクタ相当(大文字始まりの関数)を全列挙
  for (const k of Object.keys(L)) {
    const v = L[k];
    if (typeof v === "function" && /^[A-Z]/.test(k)) {
      classes[k] = { methods: pubProto(v), options: opts(v) };
      if (v === L.TileLayer) classes["TileLayer.WMS"] = { methods: pubProto(L.TileLayer.WMS), options: opts(L.TileLayer.WMS) };
    }
  }
  // ファクトリ/名前空間
  const factories = Object.keys(L).filter(k => typeof L[k] === "function" && /^[a-z]/.test(k));
  const controlFactories = L.control ? Object.keys(L.control) : [];
  const crs = Object.keys(L.CRS || {});
  const handlers = {};
  try {
    const m = window.kascMap;
    for (const h of ["boxZoom", "doubleClickZoom", "dragging", "keyboard", "scrollWheelZoom", "tapHold", "touchZoom", "inertia"]) {
      handlers[h] = m.options[h] !== undefined ? m.options[h] : (m[h] ? "enabled" : "n/a");
    }
  } catch {}
  // 実マップインスタンスの options（Canvas が渡したもの＋既定値）
  const mapOptions = { ...window.kascMap.options };
  // プラグイン
  let mc = null, heat = null;
  try { if (L.MarkerClusterGroup) mc = { methods: pubProto(L.MarkerClusterGroup), options: opts(L.MarkerClusterGroup) }; } catch {}
  try { if (L.HeatLayer) heat = { methods: pubProto(L.HeatLayer), options: opts(L.HeatLayer) }; } catch {}
  // renderer 既定
  const renderer = (() => { try { const r = window.kascMap.getRenderer(L.polyline([[0,0],[0,0]])); return r?.constructor?.name || String(r?.options?.padding); } catch (e) { return String(e); } })();
  return {
    version: L.version,
    exportKeys: Object.keys(L),
    factories, controlFactories, crs, handlers, mapOptions, renderer,
    classes, mc, heat,
    mcErr: window.__mcErr || null, heatErr: window.__heatErr || null,
  };
});

writeFileSync(`${OUT}leaflet-api-enum-2026-11.json`, JSON.stringify(result, null, 2));
const c = result.leaflet;
console.log("L.version:", c.version, "| exports:", c.exportKeys.length, "| classes:", Object.keys(c.classes).length);
console.log("markerClusterGroup:", !!c.mc, "| heatLayer:", !!c.heat);
await browser.close();
