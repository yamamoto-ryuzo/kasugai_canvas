// navara 差分検証 (2026-11-15 検証後コミット分)
//  - c0f4f89: .kasc の light:/scene3d:/terrain: shading・generator 反映
//  - fed45b9: polyline.geometryTypes に polygon 追加(ポリゴン枠線)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const WEB = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL("./", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };
const PROBE_GEOJSON = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { n: 1 }, geometry: { type: "Polygon",
    coordinates: [[[139.75, 35.67], [139.78, 35.67], [139.78, 35.70],
                   [139.75, 35.70], [139.75, 35.67]]] } },
  { type: "Feature", properties: { n: 2 }, geometry: { type: "LineString",
    coordinates: [[139.75, 35.68], [139.78, 35.69]] } }] });
// light az=180 el=45, terrain generator=flat+shading=off, scene3d 全部盛り
const PROBE_KASC = [
  "title: probe-scene3d-diff",
  "base: GSI標準地図 | https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png | off",
  "terrain: qgis | generator=flat | shading=off | exaggeration=2",
  "scene3d: s | background=#123456 | skybox=off | shadows=on | ao=on",
  "light: L | az=180 | el=45 | intensity=2 | color=#ff8800",
  "geojson: probe/Poly | canvas_data/poly.geojson",
  "cam:probe|35.685|139.765|h=3000|p=-45",
].join("\n");
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const mem = { "/probe/test.kasc": PROBE_KASC, "/probe/canvas_data/poly.geojson": PROBE_GEOJSON };
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
const prof = join(os.tmpdir(), "kasc-probe-profile-scene3d");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0, 200)));

await page.addInitScript(() => {
  let _v;
  window.__descs = []; window.__updates = [];
  Object.defineProperty(window, "kascView", {
    configurable: true,
    set(v) {
      _v = v;
      window.__clearColors = window.__clearColors || [];
      try {
        const r = v && v._renderer;
        if (r && r.setClearColor && !r.__ccHooked) {
          r.__ccHooked = true;
          const oc = r.setClearColor.bind(r);
          r.setClearColor = (...a) => { window.__clearColors.push(a[0]); return oc(...a); };
        }
      } catch (_) {}
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
  let st = null;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    st = await page.evaluate(() => ({
      title: document.title,
      descs: (window.__descs || []).map(d => ({
        type: d.type, exagg: d.terrain?.exaggeration, lit: d.terrain?.lit,
        gtypes: d.polyline?.geometryTypes })),
    })).catch(() => null);
    if (st && st.title.includes("probe-scene3d-diff") && st.descs.length > 0) break;
    await page.waitForTimeout(5000);
  }
  if (!st || !st.title.includes("probe-scene3d-diff"))
    throw new Error(`boot timeout: ${JSON.stringify(st)}`);
  await page.waitForTimeout(3000);
  st = await page.evaluate(() => ({
    title: document.title,
    nvTerrain: document.querySelector("#nv-terrain")?.checked,
    nvShadow: document.querySelector("#nv-shadow")?.checked,
    nvSsao: document.querySelector("#nv-ssao")?.checked,
    nvSunInt: document.querySelector("#nv-sun-int")?.value,
    sun: (() => { const s = window.kascView?.atmosphere?.sunDirection;
      return s ? [s.x, s.y, s.z] : null; })(),
    clearHex: (() => { const a = (window.__clearColors || []).slice(-1)[0];
      if (a == null) return null;
      if (typeof a === "number") return a;
      if (a.isColor) { // linear working space → sRGB hex
        const toSrgb = c => c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
        return (Math.round(toSrgb(a.r) * 255) << 16) |
               (Math.round(toSrgb(a.g) * 255) << 8) |
               Math.round(toSrgb(a.b) * 255); }
      return null; })(),
    layerTypes: (() => { try { return [...(window.kascView?.layers || [])]
      .map(l => l?.type || l?.desc?.type || l?.constructor?.name); } catch (_) { return []; } })(),
    descs: (window.__descs || []).map(d => ({
      type: d.type, exagg: d.terrain?.exaggeration, lit: d.terrain?.lit,
      gtypes: d.polyline?.geometryTypes })),
  }));
  console.log("STATE", JSON.stringify(st, null, 1));
  rec("navara.boot", st.descs.length > 0, `descs=${st.descs.length} title=${st.title}`);

  // generator=flat → 地形 OFF(トグルoff＋現在viewにterrainレイヤ無し)
  rec("navara.kasc.terrain_generator_flat",
    st.nvTerrain === false && !st.layerTypes.includes("terrain"),
    `nv-terrain=${st.nvTerrain} layers=${JSON.stringify(st.layerTypes)}`);

  // scene3d: shadows/ao → トグル同期
  rec("navara.kasc.scene3d_shadows_ao",
    st.nvShadow === true && st.nvSsao === true,
    `shadow=${st.nvShadow} ssao=${st.nvSsao}`);

  // scene3d: background → clearColor=0x123456
  rec("navara.kasc.scene3d_background",
    st.clearHex === 0x123456,
    `clearHex=${st.clearHex == null ? "null" : "0x" + st.clearHex.toString(16)}`);

  // light: az=180 el=45 @ lon=139.765 lat=35.685 → sunDirection 期待値との cos 類似度
  const az = 180 * Math.PI / 180, el = 45 * Math.PI / 180;
  const lam = 139.765 * Math.PI / 180, phi = 35.685 * Math.PI / 180;
  const ce = Math.cos(el);
  const de = Math.sin(az) * ce, dn = Math.cos(az) * ce, du = Math.sin(el);
  const ex = -de * Math.sin(lam) - dn * Math.sin(phi) * Math.cos(lam) + du * Math.cos(phi) * Math.cos(lam);
  const ey = de * Math.cos(lam) - dn * Math.sin(phi) * Math.sin(lam) + du * Math.cos(phi) * Math.sin(lam);
  const ez = dn * Math.cos(phi) + du * Math.sin(phi);
  let cosSim = null;
  if (st.sun) {
    const [sx, sy, sz] = st.sun;
    const nl = Math.hypot(sx, sy, sz), ne = Math.hypot(ex, ey, ez);
    cosSim = (sx * ex + sy * ey + sz * ez) / (nl * ne);
  }
  rec("navara.kasc.light_sun_direction",
    cosSim !== null && cosSim > 0.999,
    `sun=${JSON.stringify(st.sun)} expected=${[ex, ey, ez].map(v => v.toFixed(4))} cos=${cosSim}`);

  // light: intensity=2 → 太陽強さスライダー同期
  rec("navara.kasc.light_intensity",
    Number(st.nvSunInt) === 2,
    `nv-sun-int=${st.nvSunInt}`);

  // ポリゴン枠線: geometryTypes に polygon
  const vec = st.descs.find(d => d.gtypes);
  rec("navara.polyline.geometryTypes_polygon",
    !!vec && vec.gtypes.includes("line") && vec.gtypes.includes("polygon"),
    `gtypes=${JSON.stringify(vec?.gtypes)}`);

  // shading=off → 地形 ON 時に lit:false が desc へ出るか
  const shade = await page.evaluate(async () => {
    const n0 = (window.__descs || []).length;
    const c = document.querySelector("#nv-terrain");
    if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event("change")); }
    await new Promise(r => setTimeout(r, 4000));
    const nd = (window.__descs || []).slice(n0).find(d => d.type === "terrain");
    return { found: !!nd, lit: nd?.terrain?.lit };
  });
  rec("navara.kasc.terrain_shading_off",
    shade.found === false || shade.lit === false,
    `terrain re-add found=${shade.found} lit=${shade.lit}`);

  if (pageErrors.length) console.log("PAGEERRORS", JSON.stringify(pageErrors));
} catch (e) {
  rec("fatal", false, String(e).slice(0, 500));
  if (pageErrors.length) console.log("PAGEERRORS", JSON.stringify(pageErrors));
}
writeFileSync(join(OUT, "probe-2026-11-15-diff-results.json"),
  JSON.stringify(results, null, 1));
await ctx.close().catch(() => {});
srv.close();
const fails = results.filter(r => !r.ok).length;
console.log(`DONE ${results.length - fails}/${results.length} pass`);
process.exit(fails ? 1 : 0);
