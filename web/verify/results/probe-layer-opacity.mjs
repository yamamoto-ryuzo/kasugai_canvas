// 表示>一般タブ「レイヤー透過度」スライダの検証プローブ
//  1) 非QML geojson entity の色アルファが係数に追従し、1 へ戻すと復元される
//  2) QML geojson entity も同様に追従する
//  3) image: オーバーレイ(ImageMaterialProperty)が係数に追従する
// 実行: node web/verify/results/probe-layer-opacity.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL("./", import.meta.url));
mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };

// 1x1 白 PNG(image: オーバーレイ用)
const PNG1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const PROBE_QML = `<?xml version="1.0"?>
<qgis version="3.34" styleCategories="Symbology">
 <renderer-v2 type="singleSymbol" forceraster="0" enableorderby="0" symbollevels="0">
  <symbols>
   <symbol type="fill" name="0" alpha="1" clip_to_extent="1">
    <layer class="SimpleFill" enabled="1" pass="0">
     <Option type="Map">
      <Option name="color" type="QString" value="30,120,200,255"/>
      <Option name="style" type="QString" value="solid"/>
      <Option name="outline_style" type="QString" value="no"/>
     </Option>
    </layer>
   </symbol>
  </symbols>
 </renderer-v2>
</qgis>`;

const POLY = { type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[139.7, 35.6], [139.9, 35.6], [139.9, 35.8], [139.7, 35.8], [139.7, 35.6]]] } };
const PROBE_GEOJSON = JSON.stringify({ type: "FeatureCollection", features: [POLY] });

const PROBE_KASC = [
  "title: probe-layer-opacity",
  "base: GSI標準地図 | https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png | off",
  "geojson: plain | DATA/plain.geojson",
  "geojson: qml | DATA/qml.geojson | style=DATA/qml.qml",
  "image: overlay | DATA/ov.png | bbox=139.7,35.6,139.9,35.8",
  "cam:probe|35.7|139.8|h=50000|p=-90",
].join("\n");

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const mem = { "/probe/test.kasc": PROBE_KASC, "/probe/DATA/qml.qml": PROBE_QML,
    "/probe/DATA/plain.geojson": PROBE_GEOJSON, "/probe/DATA/qml.geojson": PROBE_GEOJSON };
  if (mem[p]) { res.writeHead(200, { "content-type": MIME[extname(p)] || "text/plain" }); res.end(mem[p]); return; }
  if (p === "/probe/DATA/ov.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG1); return; }
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

const prof = join(os.tmpdir(), "kasc-probe-profile-layer-opacity");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0, 200)));

const snap = () => page.evaluate(() => {
  const v = window._viewer;
  const now = window.Cesium.JulianDate.now();
  const alphaOf = prop => {
    try { const c = prop?.getValue?.(now); return c instanceof window.Cesium.Color ? c.alpha : null; }
    catch { return null; }
  };
  const out = { ds: [], imagery: [] };
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    const r = { name: ds.name || `ds${i}`, alphas: [] };
    for (const e of ds.entities.values) {
      const a = alphaOf(e.polygon?.material?.color) ?? alphaOf(e.rectangle?.material?.color)
        ?? alphaOf(e.polyline?.material?.color) ?? alphaOf(e.point?.color)
        ?? alphaOf(e.billboard?.color);
      if (a !== null) r.alphas.push(a);
    }
    out.ds.push(r);
  }
  for (let i = 0; i < v.imageryLayers.length; i++) out.imagery.push(v.imageryLayers.get(i).alpha);
  return out;
});
const setSlider = v => page.evaluate(val => {
  const s = document.querySelector("#display-layer-opacity");
  s.value = String(val);
  s.dispatchEvent(new Event("input", { bubbles: true }));
}, v);
const close = (a, b, tol = 0.03) => a !== null && Math.abs(a - b) <= tol;

try {
  const errsBefore = pageErrors.length;
  await page.goto(`${base}/cesium/?kasc=${encodeURIComponent(base + "/probe/test.kasc")}`);
  await page.waitForFunction(() => window._viewer && window._viewer.dataSources.length >= 2,
    null, { timeout: 120000 });
  await page.waitForTimeout(4000); // QML スタイル適用・image オーバーレイ待ち
  const before = await snap();
  rec("boot.datasources", before.ds.length >= 2, JSON.stringify(before));
  // GeoJsonDataSource は ds.name が自動採番のためアルファで識別する:
  // qml 側は QML 色(30,120,200,255)=alpha 1、plain 側は Cesium 既定塗り=alpha 100/255
  const ov = before.ds.find(d => /overlay/i.test(d.name));
  const vecs = before.ds.filter(d => d !== ov && d.alphas.length > 0);
  const qml = vecs.find(d => Math.abs(d.alphas[0] - 1) < 0.01);
  const plain = vecs.find(d => Math.abs(d.alphas[0] - 100 / 255) < 0.01);
  rec("boot.layers", !!plain && !!qml && !!ov,
    `names=${before.ds.map(d => `${d.name}:${d.alphas.join("/")}`).join(",")}`);

  // ---- 0.4 へ ----
  await setSlider(0.4);
  await page.waitForTimeout(800);
  const faded = await snap();
  const check = (name, baseDs, fadedDs) => {
    if (!baseDs || !fadedDs) return { ok: false, detail: "ds missing" };
    const pairs = baseDs.alphas.map((b, i) => [b, fadedDs.alphas[i]]).filter(p => p[0] !== null);
    const ok = pairs.length > 0 && pairs.every(([b, f]) => close(f, b * 0.4));
    return { ok, detail: `base=${baseDs.alphas} faded=${fadedDs.alphas}` };
  };
  const rPlain = check("plain", plain, plain && faded.ds.find(d => d.name === plain.name));
  const rQml = check("qml", qml, qml && faded.ds.find(d => d.name === qml.name));
  const rOv = check("overlay", ov, ov && faded.ds.find(d => d.name === ov.name));
  rec("fade.plain_entity", rPlain.ok, rPlain.detail);
  rec("fade.qml_entity", rQml.ok, rQml.detail);
  rec("fade.image_overlay", rOv.ok, rOv.detail);

  // ---- 1.0 へ戻す(復元) ----
  await setSlider(1.0);
  await page.waitForTimeout(800);
  const restored = await snap();
  const checkRestore = (baseDs, restDs) => {
    if (!baseDs || !restDs) return { ok: false, detail: "ds missing" };
    const pairs = baseDs.alphas.map((b, i) => [b, restDs.alphas[i]]).filter(p => p[0] !== null);
    const ok = pairs.length > 0 && pairs.every(([b, r]) => close(r, b));
    return { ok, detail: `base=${baseDs.alphas} restored=${restDs.alphas}` };
  };
  const rrPlain = checkRestore(plain, plain && restored.ds.find(d => d.name === plain.name));
  const rrQml = checkRestore(qml, qml && restored.ds.find(d => d.name === qml.name));
  const rrOv = checkRestore(ov, ov && restored.ds.find(d => d.name === ov.name));
  rec("restore.plain_entity", rrPlain.ok, rrPlain.detail);
  rec("restore.qml_entity", rrQml.ok, rrQml.detail);
  rec("restore.image_overlay", rrOv.ok, rrOv.detail);

  rec("no_pageerror", pageErrors.length === errsBefore,
    `errors=${pageErrors.slice(errsBefore).join(" | ") || "none"}`);
  await page.screenshot({ path: join(OUT, "layer-opacity.png") });
} catch (e) { rec("probe.run", false, String(e).slice(0, 400)); }

console.log(JSON.stringify({ pass: results.filter(r => r.ok).length, total: results.length }));
await ctx.close();
srv.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
