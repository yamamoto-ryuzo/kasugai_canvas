// navara ブート診断
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".png": "image/png", ".txt": "text/plain" };
const PROBE_KASC = [
  "title: probe-515b4bd",
  "base: GSI標準地図 | https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png | off",
  "terrain: qgis | generator=online | exaggeration=2",
  "geojson: probe/Line | DATA/line.geojson | style=DATA/line.qml",
  "cam:probe|35.685|139.765|h=3000|p=-45",
].join("\n");
const PROBE_QML = `<?xml version="1.0"?><qgis version="3.34"><renderer-v2 type="singleSymbol"><symbols><symbol type="line" name="0" alpha="1"><layer class="SimpleLine" enabled="1" pass="0"><Option type="Map"><Option name="line_color" type="QString" value="200,30,30,255"/><Option name="line_style" type="QString" value="solid"/><Option name="line_width" type="QString" value="2"/></Option></layer></symbol></symbols></renderer-v2></qgis>`;
const PROBE_GEOJSON = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[139.75, 35.67], [139.78, 35.70]] } }] });
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const mem = { "/probe/test.kasc": PROBE_KASC, "/probe/DATA/line.qml": PROBE_QML,
    "/probe/DATA/line.geojson": PROBE_GEOJSON };
  if (mem[p]) { res.writeHead(200, { "content-type": MIME[extname(p)] || "text/plain" }); res.end(mem[p]); return; }
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const data = await readFile(resolve(join(WEB, q)));
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const prof = join(os.tmpdir(), "kasc-probe-profile-515b4bd");
const ctx = await chromium.launchPersistentContext(prof, { channel: "chrome", headless: true });
const page = await ctx.newPage();
page.on("console", m => console.log("[console]", m.type(), m.text().slice(0, 160)));
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 250)));
page.on("requestfailed", r => console.log("[reqfail]", r.url().slice(0, 120), r.failure()?.errorText));
await page.addInitScript(() => {
  let _v; window.__descs = [];
  Object.defineProperty(window, "kascView", { configurable: true,
    set(v) { _v = v;
      if (v?.addLayer) { const o = v.addLayer.bind(v);
        v.addLayer = d => { window.__descs.push(d?.type || "?"); return o(d); }; } },
    get() { return _v; } });
});
await page.goto(`${base}/navara/?kasc=${encodeURIComponent(base + "/probe/test.kasc")}`,
  { waitUntil: "domcontentloaded", timeout: 120000 });
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(10000);
  const s = await page.evaluate(() => ({
    t: document.title, v: !!window.kascView, descs: (window.__descs || []).join(","),
    exagg: document.querySelector("#nv-terrain-exagg")?.value,
    errOverlay: document.body.innerText.includes("初期化失敗"),
    opts: document.querySelectorAll("select option").length,
  })).catch(e => ({ err: String(e).slice(0, 100) }));
  console.log(`t+${(i + 1) * 10}s`, JSON.stringify(s));
  if (s.descs && s.descs.length > 2) break;
}
await page.screenshot({ path: "C:/devin/kasugai_canvas/web/verify/results/navara-diag.png" });
await ctx.close(); srv.close(); process.exit(0);
