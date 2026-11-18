// flatgeobuf: の bbox=auto 空間インデックス+Range 範囲読みの検証プローブ
//  1) bbox=auto(既定) 行が {minX..} rect で deserialize → Range リクエスト発行
//  2) bbox=off 行が全件読み込み(Range 不使用)
//  3) 狭い範囲への flyTo で再クエリし地物数が減る
// 実行: node web/verify/results/probe-fgb-range.mjs
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
  ".fgb": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };

const reqLog = [];
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    const mime = MIME[extname(q)] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : data.length - 1;
        reqLog.push({ path: q, range: `${start}-${end}` });
        res.writeHead(206, {
          "content-type": mime, "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${data.length}`,
        });
        res.end(data.subarray(start, end + 1));
        return;
      }
    }
    reqLog.push({ path: q, range: null });
    res.writeHead(200, { "content-type": mime, "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

const prof = join(os.tmpdir(), "kasc-probe-profile-fgb-range");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.on("pageerror", e => console.log("PAGEERR:", String(e).slice(0, 200)));

await page.goto(`${base}/cesium/?kasc=${encodeURIComponent("/verify/fgb-test/fgb-range.kasc")}`,
  { waitUntil: "domcontentloaded" });

// レイヤー読み込み完了を待つ(getLayerGeoJson が地物を返す)
async function waitLayer(titlePart, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const n = await page.evaluate(t => {
      const layer = window.kasugaiApi?.listLayers?.().find(l => (l.title || "").includes(t));
      if (!layer) return -1;
      const gj = window.kasugaiApi.getLayerGeoJson?.(layer.id);
      return gj?.features?.length ?? 0;
    }, titlePart);
    if (n > 0) return n;
    await new Promise(r => setTimeout(r, 500));
  }
  return 0;
}

const autoCount = await waitLayer("countries(bbox=auto)");
const offCount = await waitLayer("countries(bbox=off)");
const layers = await page.evaluate(() => window.kasugaiApi.listLayers());
console.log("layers:", JSON.stringify(layers));

const autoLayer = layers.find(l => (l.title || "").includes("countries(bbox=auto)"));
const offLayer = layers.find(l => (l.title || "").includes("countries(bbox=off)"));
rec("parse.auto", !!autoLayer && autoLayer.bboxAuto === true,
  `bbox=auto 行が既定ONでパース(bboxAuto=${autoLayer?.bboxAuto})`);
rec("parse.off", !!offLayer && offLayer.bboxAuto === false,
  `bbox=off 行がOFFでパース(bboxAuto=${offLayer?.bboxAuto})`);
rec("load.off", offCount > 0, `bbox=off 全件読み込み ${offCount} 地物`);

// countries.fgb へのリクエストに Range: ヘッダが使われたか
const fgbReqs = reqLog.filter(r => r.path.includes("countries.fgb"));
const rangeReqs = fgbReqs.filter(r => r.range);
rec("http.range", rangeReqs.length > 0,
  `countries.fgb への Range リクエスト ${rangeReqs.length} 件/全 ${fgbReqs.length} 件(うち全件取得 ${fgbReqs.filter(r => !r.range).length} 件)`);

// Range 読み出し量が全件読み込みより小さいこと(部分読みの証拠)
const autoGet = fgbReqs.find(r => r.range);
const fullGet = fgbReqs.find(r => !r.range);
if (autoGet && fullGet) {
  const part = Number(autoGet.range.split("-")[1]) - Number(autoGet.range.split("-")[0]);
  rec("http.partial", part < 205680, `Range 読み出し ${part}B < 全量 205680B`);
}

// 初期表示は広域のため地物が読まれている(0 ではない)
rec("load.auto", autoCount > 0, `bbox=auto 範囲読み込み ${autoCount} 地物`);

// 狭い範囲(日本付近)へ移動 → 再クエリで地物が絞られる
const before = reqLog.length;
await page.evaluate(() => window.kasugaiApi.flyTo({ latitude: 36, longitude: 138, height: 800000, pitch: -90 }, 0));
await new Promise(r => setTimeout(r, 4000));
const zoomCount = await page.evaluate(() => {
  const layer = window.kasugaiApi.listLayers().find(l => (l.title || "").includes("countries(bbox=auto)"));
  const gj = window.kasugaiApi.getLayerGeoJson(layer.id);
  return gj?.features?.length ?? 0;
});
const requeryReqs = reqLog.slice(before).filter(r => r.path.includes("countries.fgb") && r.range);
rec("viewport.requery", requeryReqs.length > 0,
  `カメラ移動で再クエリ(Range リクエスト ${requeryReqs.length} 件)`);
rec("viewport.subset", zoomCount > 0 && zoomCount < autoCount,
  `狭範囲で ${zoomCount} 地物(広域時 ${autoCount})`);

srv.close();
await ctx.close();
const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
