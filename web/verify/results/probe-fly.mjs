// V2 Fly モード検証プローブ (skill: verify-fly)
//  実行: node web/verify/results/probe-fly.mjs [engine,...]
//  F1 fly_geojson 登録(listFlyPaths)  F2 再生(playFlyPath→view移動)  F3 stopFly
//  F4 fly API 面(getFlyPaths/persistFlyPath hooks)  F5 FlyTo(ドローン視点)
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
    const url = `${base}/${engine}/?kasc=${encodeURIComponent(`${base}/verify/fly/fly.kasc`)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
    await page.waitForFunction(
      () => window.kasugaiApi && typeof window.kasugaiApi.listFlyPaths === "function",
      null, { timeout: 90000, polling: 800 });
    await page.waitForTimeout(1500);

    const f = await page.evaluate(async () => {
      const api = window.kasugaiApi;
      const paths = api.listFlyPaths?.() || [];
      const before = api.getCamera?.() || {};
      let moved = false, playErr = null;
      if (paths.length) {
        try { api.playFlyPath(paths[0].name ?? 0, true); } catch (e) { playErr = String(e).slice(0, 80); }
        await new Promise(r => setTimeout(r, 2500));
        const mid = api.getCamera?.() || {};
        moved = Math.abs((mid.latitude ?? 0) - (before.latitude ?? 0)) > 0.005
          || Math.abs((mid.longitude ?? 0) - (before.longitude ?? 0)) > 0.005
          || Math.abs((mid.height ?? 0) - (before.height ?? 0)) > 50;
        api.stopFly?.();
      }
      return { n: paths.length, names: paths.map(p => p.name || p.title).join(","),
        moved, playErr, stopped: api.stopFly?.() === true,
        hasDraw: typeof api.flyRoute === "function" || typeof api.addFlyPath === "function" };
    });
    rec(`F1[${engine}]`, f.n > 0, `fly_geojson 登録: paths=${f.n} (${f.names})`);
    rec(`F2[${engine}]`, f.moved, `再生→view移動=${f.moved} ${f.playErr || ""}`);
    rec(`F3[${engine}]`, f.stopped !== false, `stopFly=${f.stopped}`);
    skip(`F4[${engine}]`, `ルート描画UI操作は対話式(要実機)。addFlyPath API=${f.hasDraw}`);
    // F5: flyTo ドローン視点(高度付き視点移動 — プレゼン用 FlyTo)
    const d = await page.evaluate(async () => {
      // playFlyPath の GeoJSON 読込は非同期のため、F2 の stopFly 後に再生ループが
      // 開始される場合がある。確実に停止させてから flyTo する
      window.kasugaiApi.stopFly?.();
      await new Promise(r => setTimeout(r, 800));
      try { window.kasugaiApi.flyTo?.({ latitude: 35.0, longitude: 136.0, height: 2000, pitch: -30 }); } catch {}
      let v = {};
      for (let i = 0; i < 16; i++) {
        await new Promise(r => setTimeout(r, 500));
        v = window.kasugaiApi.getCamera?.() || {};
        if (Math.abs((v.latitude ?? 0) - 35.0) < 0.3) break;
      }
      return { lat: v.latitude, ok: Math.abs((v.latitude ?? 0) - 35.0) < 0.3 };
    });
    rec(`F5[${engine}]`, d.ok, `flyTo(ドローン視点) → lat=${Number(d.lat).toFixed(3)}`);
  } catch (e) {
    rec(`Fx[${engine}]`, false, `起動/評価失敗: ${String(e).slice(0, 160)}`);
  }
  await page.close();
}

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
