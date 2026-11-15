// feature-verify 差分検証プローブ (commit 515b4bd)
//  1) qml-2d: __kasc_lblend/fblend/lgrp + *-layer-blend グルーピング (standalone logic)
//  2) maplibre: 6.18 で line-layer-blend/fill-layer-blend 受理 + sample_qgis 破線グルーピング回帰
//  3) navara: 地形誇張UI / .kasc exaggeration / QML dash・cap → PolylineMaterial
//  4) cesium 1.147 / gsimaps 新sha ブート回帰
// 実行: node web/verify/results/probe-515b4bd.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
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

// ---- probe 用 .kasc + DATA(実ファイル不要・メモリ配信) ----
const PROBE_QML = `<?xml version="1.0"?>
<qgis version="3.34" styleCategories="Symbology">
 <renderer-v2 type="singleSymbol" forceraster="0" enableorderby="0" symbollevels="0">
  <symbols>
   <symbol type="line" name="0" alpha="1" clip_to_extent="1">
    <layer class="SimpleLine" enabled="1" pass="0" blend_mode="6">
     <Option type="Map">
      <Option name="capstyle" type="QString" value="round"/>
      <Option name="customdash" type="QString" value="5;2"/>
      <Option name="customdash_unit" type="QString" value="MM"/>
      <Option name="use_custom_dash" type="QString" value="1"/>
      <Option name="line_color" type="QString" value="200,30,30,255"/>
      <Option name="line_style" type="QString" value="solid"/>
      <Option name="line_width" type="QString" value="2"/>
      <Option name="line_width_unit" type="QString" value="MM"/>
     </Option>
    </layer>
   </symbol>
  </symbols>
 </renderer-v2>
</qgis>`;
const PROBE_GEOJSON = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { n: 1 }, geometry: { type: "LineString",
    coordinates: [[139.75, 35.67], [139.78, 35.70]] } },
]});
const PROBE_KASC = [
  "title: probe-515b4bd",
  "base: GSI標準地図 | https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png | off",
  "terrain: qgis | generator=online | exaggeration=2",
  "geojson: probe/Line | DATA/line.geojson | style=DATA/line.qml",
  "cam:probe|35.685|139.765|h=3000|p=-45",
].join("\n");

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const mem = { "/probe/test.kasc": PROBE_KASC, "/probe/DATA/line.qml": PROBE_QML,
    "/probe/DATA/line.geojson": PROBE_GEOJSON };
  if (mem[p]) { res.writeHead(200, { "content-type": MIME[extname(p)] || "text/plain" }); res.end(mem[p]); return; }
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

const prof = join(os.tmpdir(), "kasc-probe-profile-515b4bd");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0, 200)));

// ================= A. standalone logic: qml-2d blend/lgrp =================
try {
  await page.goto(`${base}/projects/projects.json`); // 同一オリジン確立用
  const a = await page.evaluate(async () => {
    const qs = await import("/shared/qml-style.js");
    const q2 = await import("/shared/qml-2d.js");
    const line = (blend) => `<?xml version="1.0"?><qgis version="3.34">
 <renderer-v2 type="singleSymbol"><symbols><symbol type="line" name="0" alpha="1">
  <layer class="SimpleLine" enabled="1" pass="0" ${blend ? `blend_mode="${blend}"` : ""}>
   <Option type="Map"><Option name="customdash" type="QString" value="5;2"/>
   <Option name="use_custom_dash" type="QString" value="1"/>
   <Option name="capstyle" type="QString" value="round"/>
   <Option name="line_color" type="QString" value="200,30,30,255"/>
   <Option name="line_style" type="QString" value="solid"/>
   <Option name="line_width" type="QString" value="2"/></Option></layer>
 </symbol></symbols></renderer-v2></qgis>`;
    const fill = (blend) => `<?xml version="1.0"?><qgis version="3.34">
 <renderer-v2 type="singleSymbol"><symbols><symbol type="fill" name="0" alpha="1">
  <layer class="SimpleFill" enabled="1" pass="0" ${blend ? `blend_mode="${blend}"` : ""}>
   <Option type="Map"><Option name="color" type="QString" value="30,120,200,255"/>
   <Option name="style" type="QString" value="solid"/>
   <Option name="outline_style" type="QString" value="no"/></Option></layer>
 </symbol></symbols></renderer-v2></qgis>`;
    const gj = () => ({ type: "FeatureCollection", features: [
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
      { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] });
    const out = {};
    // blend_mode=6 → multiply + dash → lgrp "multiply|..."
    { const g = gj(); const r = q2.maplibreApplyQml(g, qs.compileQmlStyle(line(6)));
      out.multiply = { lgrp: g.features[0].properties.__kasc_lgrp,
        fblendP: g.features[1].properties.__kasc_lblend,
        lblendLayers: r.kinds.filter(k => k[2]?.["line-layer-blend"]).map(k => k[2]["line-layer-blend"]),
        dashLayers: r.kinds.filter(k => k[2]?.["line-dasharray"]).length,
        lgrpLayers: r.kinds.filter(k => JSON.stringify(k[1]).includes("__kasc_lgrp")).length }; }
    // blend_mode=22 → lighter → plus-lighter
    { const g = gj(); const r = q2.maplibreApplyQml(g, qs.compileQmlStyle(line(22)));
      out.plusLighter = { lgrp: g.features[0].properties.__kasc_lgrp,
        blends: r.kinds.filter(k => k[2]?.["line-layer-blend"]).map(k => k[2]["line-layer-blend"]) }; }
    // blend_mode=5 → darken は MLB_MAP 外 → グルーピング無し(通常合成)
    { const g = gj(); const r = q2.maplibreApplyQml(g, qs.compileQmlStyle(line(5)));
      out.unmapped = { lgrp: g.features[0].properties.__kasc_lgrp ?? null,
        dashOnly: g.features[0].properties.__kasc_lgrp?.startsWith("|"),
        blendLayers: r.kinds.filter(k => k[2]?.["line-layer-blend"]).length }; }
    // fill blend_mode=2 → screen → __kasc_fblend + fill-layer-blend
    { const g = gj(); const r = q2.maplibreApplyQml(g, qs.compileQmlStyle(fill(2)));
      out.fillBlend = { fblend: g.features[1].properties.__kasc_fblend,
        fillBlendLayers: r.kinds.filter(k => k[2]?.["fill-layer-blend"]).map(k => k[2]["fill-layer-blend"]),
        fillLayersTotal: r.kinds.filter(k => k[0] === "fill").length }; }
    // blend_mode=0/無し → 旧来挙動(破線のみ lgrp "|dashJSON")
    { const g = gj(); const r = q2.maplibreApplyQml(g, qs.compileQmlStyle(line(0)));
      out.normal = { lgrp: g.features[0].properties.__kasc_lgrp,
        lineLayers: r.kinds.filter(k => k[0] === "line").length }; }
    return out;
  });
  const m = a.multiply;
  rec("qml2d.lgrp.multiply", m.lblendLayers.includes("multiply") && /^multiply\|/.test(m.lgrp || "") && m.dashLayers >= 1,
    JSON.stringify(m));
  rec("qml2d.lighter_to_plusLighter", a.plusLighter.blends.includes("plus-lighter"), JSON.stringify(a.plusLighter));
  rec("qml2d.unmapped_no_group", a.unmapped.blendLayers === 0 && a.unmapped.dashOnly === true,
    JSON.stringify(a.unmapped));
  rec("qml2d.fill_blend_screen", a.fillBlend.fblend === "screen" && a.fillBlend.fillBlendLayers.includes("screen") && a.fillBlend.fillLayersTotal >= 2,
    JSON.stringify(a.fillBlend));
  rec("qml2d.normal_dash_lgrp", /^\|\[/.test(a.normal.lgrp || "") && a.normal.lineLayers >= 2,
    JSON.stringify(a.normal));
} catch (e) { rec("qml2d.standalone", false, String(e).slice(0, 300)); }

// ================= B. maplibre 6.18 integration =================
try {
  const errsBefore = pageErrors.length;
  await page.goto(`${base}/maplibre/?kasc=${encodeURIComponent(base + "/projects/sample_qgis/kasugai_canvas.kasc")}`);
  await page.waitForFunction(() => window.kascMap && window.kascMap.loaded(), null, { timeout: 120000 });
  await page.waitForTimeout(4000);
  const b = await page.evaluate(async () => {
    const map = window.kascMap;
    const out = { layers: map.getStyle().layers.length };
    // MapLibre 6.18 が *-layer-blend を受理するか実 addLayer で確認
    map.addSource("__probe", { type: "geojson", data: { type: "FeatureCollection", features: [
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[139, 35], [140, 36]] } }] } });
    let ok = {}, err = null;
    try {
      map.addLayer({ id: "__probe_l", type: "line", source: "__probe",
        paint: { "line-color": "#f00", "line-layer-blend": "multiply" } });
      ok.line = map.getPaintProperty("__probe_l", "line-layer-blend");
      map.addLayer({ id: "__probe_f", type: "fill", source: "__probe",
        paint: { "fill-layer-blend": "screen" } });
      ok.fill = map.getPaintProperty("__probe_f", "fill-layer-blend");
    } catch (e) { err = String(e); }
    out.blend = ok; out.err = err;
    // 実データの破線グルーピング回帰: スタイル内に __kasc_lgrp フィルタまたは dasharray レイヤがあるか
    const st = map.getStyle();
    out.lgrpLayers = st.layers.filter(l => JSON.stringify(l.filter || "").includes("__kasc_lgrp")).length;
    out.dashLayers = st.layers.filter(l => l.paint?.["line-dasharray"]).length;
    return out;
  });
  rec("maplibre.blend_accepted", b.blend?.line === "multiply" && b.blend?.fill === "screen" && !b.err,
    JSON.stringify(b));
  rec("maplibre.sample_boot", b.layers > 10, `styleLayers=${b.layers} lgrpLayers=${b.lgrpLayers} dashLayers=${b.dashLayers}`);
  rec("maplibre.no_pageerror", pageErrors.length === errsBefore, `errors=${pageErrors.length - errsBefore}`);
  await page.screenshot({ path: join(OUT, "maplibre-sample.png") });
} catch (e) { rec("maplibre.boot", false, String(e).slice(0, 300)); }

// ================= C. navara =================
try {
  await page.goto(`${base}/navara/?kasc=${encodeURIComponent(base + "/probe/test.kasc")}`);
  await page.waitForFunction(() => window.kascView, null, { timeout: 120000 });
  await page.waitForSelector("#nv-terrain-exagg", { timeout: 60000 });
  await page.waitForTimeout(6000); // terrain/layer 読込待ち
  const c1 = await page.evaluate(() => {
    const inp = document.querySelector("#nv-terrain-exagg");
    // addLayer/update をフックして後続操作を捕捉
    window.__descs = []; window.__updates = [];
    const v = window.kascView;
    const orig = v.addLayer.bind(v);
    v.addLayer = d => { const L = orig(d); window.__descs.push(d);
      try { const ou = L.update?.bind(L); if (ou) L.update = x => { window.__updates.push(x); return ou(x); }; } catch {}
      return L; };
    return { exaggInput: inp?.value, hasView: !!v };
  });
  rec("navara.kasc.exaggeration_read", c1.exaggInput === "2",
    `#nv-terrain-exagg.value=${c1.exaggInput} (kasc terrain: exaggeration=2)`);
  // UI: 誇張 3 へ変更 → terrainLayer.update に exaggeration:3 が届くか
  const c2 = await page.evaluate(async () => {
    const inp = document.querySelector("#nv-terrain-exagg");
    inp.value = "3"; inp.dispatchEvent(new Event("change"));
    await new Promise(r => setTimeout(r, 800));
    const up = window.__updates || [];
    return { updates: up.map(u => u?.terrain?.exaggeration), n: up.length };
  });
  rec("navara.ui.terrain_exaggeration", c2.updates.includes(3),
    `terrainLayer.update exaggeration seq=${JSON.stringify(c2.updates)}`);
  // ↺リセット → 1
  const c3 = await page.evaluate(async () => {
    document.querySelector("#nv-terrain-exagg-reset")?.click();
    await new Promise(r => setTimeout(r, 500));
    const inp = document.querySelector("#nv-terrain-exagg");
    return { v: inp?.value, ups: (window.__updates || []).map(u => u?.terrain?.exaggeration) };
  });
  rec("navara.ui.terrain_exagg_reset", c3.v === "1" && c3.ups.includes(1),
    `after reset value=${c3.v} updates=${JSON.stringify(c3.ups)}`);
  // QML dash/cap: レイヤ一覧から vector レイヤの polyline desc を探す
  const c4 = await page.evaluate(() => {
    const v = window.kascView;
    const found = { keys: Object.keys(v).filter(k => /layer|child|scene/i.test(k)).slice(0, 20) };
    const digs = [];
    const dig = (o, depth, path) => {
      if (!o || depth > 3 || digs.length > 60) return;
      if (Array.isArray(o)) { o.forEach((x, i) => dig(x, depth + 1, `${path}[${i}]`)); return; }
      if (typeof o !== "object") return;
      if (o.polyline?.dashArray || o.desc?.polyline?.dashArray || o.material?.dashArray)
        digs.push({ path, dash: o.polyline?.dashArray || o.desc?.polyline?.dashArray || o.material?.dashArray, cap: o.polyline?.cap || o.desc?.polyline?.cap });
      for (const k of Object.keys(o).slice(0, 40)) {
        if (k.startsWith("_") && k.length > 12) continue;
        try { dig(o[k], depth + 1, `${path}.${k}`); } catch {}
      }
    };
    try { dig(v, 0, "view"); } catch (e) { found.err = String(e); }
    found.digs = digs.slice(0, 8);
    return found;
  });
  const dashHit = c4.digs.find(d => d.dash && (d.dash.length > 0));
  rec("navara.qml.dash_cap", !!dashHit,
    dashHit ? `dashArray=${JSON.stringify([...dashHit.dash])} cap=${dashHit.cap}` :
    `no dashArray found; viewKeys=${JSON.stringify(c4.keys)}`);
  await page.screenshot({ path: join(OUT, "navara-terrain-exagg.png") });
} catch (e) { rec("navara.boot", false, String(e).slice(0, 300)); }

// ================= D. cesium 1.147 / gsimaps ブート回帰 =================
try {
  await page.goto(`${base}/cesium/`);
  await page.waitForFunction(() => window.Cesium?.VERSION, null, { timeout: 180000 });
  const v = await page.evaluate(() => window.Cesium.VERSION);
  rec("cesium.boot_1.147", v === "1.147.0", `Cesium.VERSION=${v}`);
} catch (e) { rec("cesium.boot", false, String(e).slice(0, 200)); }

try {
  await page.goto(`${base}/gsimaps/`);
  await page.waitForTimeout(20000);
  const g = await page.evaluate(() => ({
    title: document.title,
    canvases: document.querySelectorAll("canvas").length,
    gsi: typeof window.GSI !== "undefined" || !!document.querySelector("#map, .leaflet-container, iframe"),
  }));
  rec("gsimaps.boot_new_sha", g.canvases > 0 || g.gsi, JSON.stringify(g));
} catch (e) { rec("gsimaps.boot", false, String(e).slice(0, 200)); }

console.log("=== pageErrors ==="); pageErrors.slice(0, 10).forEach(e => console.log("ERR", e));
writeFileSync(join(OUT, "probe-515b4bd-results.json"), JSON.stringify(results, null, 2));
await ctx.close(); srv.close();
const fails = results.filter(r => !r.ok);
console.log(`=== DONE pass=${results.length - fails.length} fail=${fails.length} ===`);
process.exit(fails.length ? 1 : 0);
