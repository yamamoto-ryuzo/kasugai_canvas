// V1 描画ガード検証プローブ (skill: verify-render-guard)
//  実行: node web/verify/results/probe-render-guard.mjs [engine,...]
//  G1 limit= 行オプション(feature数上限)  G2 表示制御コントロール列挙
//  G3 グレーティクル/表示切替(controlUi)  G4 地形/ドレープ(cesium: sampleGroundHeight)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".geojson": "application/geo+json", ".kasc": "text/plain", ".css": "text/css" };
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    const fp = resolve(join(WEB, p.endsWith("/") ? p + "index.html" : p));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(fp)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const ENGINES = (process.argv[2] || "maplibre,leaflet").split(",");

const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const skip = (id, detail) => { results.push({ id, ok: null });
  console.log(`SKIP ${id} :: ${detail}`); };

for (const engine of ENGINES) {
  const page = await browser.newPage();
  try {
    const url = `${base}/${engine}/?kasc=${encodeURIComponent(`${base}/verify/guard/guard.kasc`)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
    await page.waitForFunction(
      () => window.kasugaiApi && window.kasugaiApi.listLayers?.().length > 0,
      null, { timeout: 90000, polling: 800 });
    await page.waitForTimeout(1000);

    const g = await page.evaluate(async () => {
      const api = window.kasugaiApi;
      const layers = api.listLayers?.() || [];
      const lyr = layers.find(l => /pt-limit2|gpkg/i.test(l.id + (l.title || "") + (l.url || ""))) || layers[0];
      let count = -1;
      try {
        const gj = await api.getLayerGeoJson?.(lyr.id) || await api.getLayerFilteredGeoJson?.(lyr.id);
        count = gj?.features?.length ?? -1;
      } catch {}
      const ctrls = (api.listUiControls?.() || [])
        .filter(c => /shadow|terrain|graticule|drape|effect|atmosphere|sky/i.test(c.target || c.id || ""));
      const ids = ctrls.map(c => c.target || c.id).slice(0, 12);
      // グレーティクル切替 → DOM チェックボックス同期
      let toggled = false;
      try {
        api.controlUi?.("#display-graticule", { value: true });
        toggled = document.querySelector("#display-graticule")?.checked === true;
      } catch {}
      let ground = null;
      try { ground = await api.sampleGroundHeight?.(135.0, 34.0); } catch {}
      return { layerId: lyr?.id, count, ids, toggled, ground };
    });
    rec(`G1[${engine}]`, g.count === 2, `limit=2 → features=${g.count} (layer=${g.layerId})`);
    rec(`G2[${engine}]`, g.ids.length > 0, `表示制御: ${g.ids.join(",") || "なし"}`);
    rec(`G3[${engine}]`, g.toggled, `controlUi(display-graticule)→checked=${g.toggled}`);
    if (engine === "cesium")
      rec(`G4[${engine}]`, typeof g.ground === "number", `sampleGroundHeight=${g.ground}`);
    else
      skip(`G4[${engine}]`, "地形サンプル/ドレープは cesium/deck 系の検証項目");
  } catch (e) {
    rec(`Gx[${engine}]`, false, `起動/評価失敗: ${String(e).slice(0, 160)}`);
  }
  await page.close();
}

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
