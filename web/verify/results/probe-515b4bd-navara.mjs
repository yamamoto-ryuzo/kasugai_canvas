// navara 再検証(addInitScript で addLayer/update を起動前フック)
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };
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
    coordinates: [[139.75, 35.67], [139.78, 35.70]] } }] });
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
page.setDefaultTimeout(120000);
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0, 200)));

// 起動前に kascView.addLayer / layer.update をフック
await page.addInitScript(() => {
  let _v;
  window.__descs = []; window.__updates = [];
  Object.defineProperty(window, "kascView", {
    configurable: true,
    set(v) {
      _v = v;
      if (v && v.addLayer) {
        const orig = v.addLayer.bind(v);
        v.addLayer = d => {
          try { window.__descs.push(JSON.parse(JSON.stringify(d, (k, x) =>
            x instanceof Float32Array ? [...x] : x))); } catch { window.__descs.push({ raw: String(d && d.type) }); }
          const L = orig(d);
          try { const ou = L?.update?.bind(L);
            if (ou) L.update = x => { try { window.__updates.push(JSON.parse(JSON.stringify(x, (k, y) =>
              y instanceof Float32Array ? [...y] : y))); } catch {} return ou(x); };
          } catch {}
          return L;
        };
      }
    },
    get() { return _v; },
  });
});

try {
  await page.goto(`${base}/navara/?kasc=${encodeURIComponent(base + "/probe/test.kasc")}`,
    { waitUntil: "domcontentloaded", timeout: 120000 });
  // vendor-guard が SW 制御確立で一度リロードするため、リロード後の
  // boot 完了(renderDoc 済=タイトル反映 & descs 捕捉)までポーリング
  let st = null;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    st = await page.evaluate(() => ({
      title: document.title,
      exagg: document.querySelector("#nv-terrain-exagg")?.value,
      descs: (window.__descs || []).map(d => ({
        type: d.type, exagg: d.terrain?.exaggeration,
        dash: d.polyline?.dashArray, cap: d.polyline?.cap, w: d.polyline?.width })),
      updates: (window.__updates || []).map(u => u?.terrain?.exaggeration),
    })).catch(() => null);
    if (st && st.title.includes("probe-515b4bd") && st.descs.length > 0) break;
    await page.waitForTimeout(5000);
  }
  if (!st || !st.title.includes("probe-515b4bd"))
    throw new Error(`boot timeout: ${JSON.stringify(st)}`);
  await page.waitForTimeout(3000); // リスナーバインド + レイヤ非同期処理の猶予
  st = await page.evaluate(() => ({
    title: document.title,
    exagg: document.querySelector("#nv-terrain-exagg")?.value,
    descs: (window.__descs || []).map(d => ({
      type: d.type, exagg: d.terrain?.exaggeration,
      dash: d.polyline?.dashArray, cap: d.polyline?.cap, w: d.polyline?.width })),
    updates: (window.__updates || []).map(u => u?.terrain?.exaggeration),
  }));
  console.log("STATE", JSON.stringify(st, null, 1));
  const terrainDesc = st.descs.find(d => d.type === "terrain");
  rec("navara.boot", st.descs.length > 0, `descs=${st.descs.length} title=${st.title}`);
  rec("navara.kasc.exaggeration_read",
    st.exagg === "2" && (st.updates.includes(2) || terrainDesc?.exagg === 2),
    `input=${st.exagg} updates=${JSON.stringify(st.updates)} terrainDesc.exagg=${terrainDesc?.exagg}`);
  // UI change → 3
  const c2 = await page.evaluate(async () => {
    const n0 = (window.__updates || []).length;
    const inp = document.querySelector("#nv-terrain-exagg");
    inp.value = "3"; inp.dispatchEvent(new Event("change"));
    await new Promise(r => setTimeout(r, 1000));
    return { news: (window.__updates || []).slice(n0).map(u => u?.terrain?.exaggeration) };
  });
  rec("navara.ui.terrain_exaggeration", c2.news.includes(3),
    `update exaggeration after input=3 → ${JSON.stringify(c2.news)}`);
  const c3 = await page.evaluate(async () => {
    const n0 = (window.__updates || []).length;
    document.querySelector("#nv-terrain-exagg-reset")?.click();
    await new Promise(r => setTimeout(r, 800));
    return { v: document.querySelector("#nv-terrain-exagg")?.value,
      news: (window.__updates || []).slice(n0).map(u => u?.terrain?.exaggeration) };
  });
  rec("navara.ui.terrain_exagg_reset", c3.v === "1" && c3.news.includes(1),
    `reset value=${c3.v} updates=${JSON.stringify(c3.news)}`);
  const vec = st.descs.find(d => d.dash || d.cap);
  rec("navara.qml.dash_cap", !!(vec?.dash?.length && vec.cap === "round"),
    vec ? `dashArray=${JSON.stringify(vec.dash)} cap=${vec.cap} width=${vec.w}` :
    `no vector desc with dash/cap; descs=${JSON.stringify(st.descs.map(d => d.type))}`);
  await page.evaluate(() => { window.switchPanelTab?.("display"); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "navara-terrain-exagg.png") });
} catch (e) {
  rec("navara.boot", false, String(e).slice(0, 300));
  try { const t = await page.evaluate(() => document.title + " | " + document.body.innerText.slice(0, 300));
    console.log("PAGE STATE", t); } catch {}
}
console.log("=== pageErrors ==="); pageErrors.slice(0, 10).forEach(e => console.log("ERR", e));
writeFileSync(join(OUT, "probe-515b4bd-navara-results.json"), JSON.stringify(results, null, 2));
await ctx.close(); srv.close();
const fails = results.filter(r => !r.ok);
console.log(`=== DONE pass=${results.length - fails.length} fail=${fails.length} ===`);
process.exit(fails.length ? 1 : 0);
