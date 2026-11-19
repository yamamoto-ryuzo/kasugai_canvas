// ポリゴン二重描画の切り分けプローブ
//  rec-formats.kasc は同一 countries データを 4 レイヤー(fgb×2/geoparquet×2)で
//  重ねるため「複数回描画」はレイヤー重複が原因かを確認し、
//  1 レイヤー内で entity/aux が重複生成されていないかを機械検査する
// 実行: node web/verify/results/probe-poly-dup.mjs
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
  ".png": "image/png", ".fgb": "application/octet-stream",
  ".parquet": "application/octet-stream", ".txt": "text/plain" };

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
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

const prof = join(os.tmpdir(), "kasc-probe-profile-poly-dup");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0, 200)));

try {
  const KASC = encodeURIComponent(`${base}/verify/rec-formats/rec-formats.kasc`);
  await page.goto(`${base}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window._viewer && window.kasugaiApi, null, { timeout: 90000 });
  await page.waitForFunction(() =>
    (window.kasugaiApi?.listLayers?.() || []).length >= 7,
    null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(8000); // 各フォーマットのデコード・描画完了待ち

  const snap = await page.evaluate(() => {
    const v = window._viewer;
    const layers = (window.kasugaiApi?.listLayers?.() || []);
    const out = { dataSources: [], primitives: [], perLayer: layers.map(l => ({ id: l.id, type: l.type, title: l.title })) };
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      let poly = 0, auxPoly = 0, line = 0, pt = 0, total = 0;
      for (const e of ds.entities.values) {
        if (e._kascAux) { if (e.polygon) auxPoly++; continue; }
        total++;
        if (e.polygon) poly++;
        else if (e.polyline) line++;
        else if (e.point || e.billboard) pt++;
      }
      out.dataSources.push({ name: ds.name || `ds${i}`, layerId: ds._kasugaiLayerId || null,
        entities: total, poly, auxPoly, line, pt });
    }
    return out;
  });

  console.log("--- dataSources ---");
  for (const d of snap.dataSources) console.log(JSON.stringify(d));
  console.log("--- layers ---");
  for (const l of snap.perLayer) console.log(JSON.stringify(l));

  const fgbDs = snap.dataSources.filter(d =>
    snap.perLayer.some(l => l.id === d.layerId && l.type === "flatgeobuf"));
  const pqDs = snap.dataSources.filter(d =>
    snap.perLayer.some(l => l.id === d.layerId && l.type === "geoparquet"));

  // 1) 同一レイヤIDの dataSource が複数存在しない(二重登録なし)
  const ids = snap.dataSources.map(d => d.layerId).filter(Boolean);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  rec("no_dup_datasource", dupIds.length === 0,
    `重複レイヤID: ${dupIds.length ? dupIds.join(",") : "なし"} (ds=${snap.dataSources.length})`);

  // 2) fgb レイヤーが 2 本ある(bbox=auto / off) → 同一ポリゴンを 2 回描くのは仕様
  rec("fgb.two_layers", fgbDs.length === 2,
    `flatgeobuf ds=${fgbDs.length} (auto+off で同一 countries を各1回描画)`);
  // geoparquet は 全件(example)+where=Africa(example)+範囲(grid 点) の 3 本
  rec("geoparquet.three_layers", pqDs.length === 3,
    `geoparquet ds=${pqDs.length} (全件+where+範囲(grid 点) で各1回描画)`);

  // 3) 1 レイヤー内で補助ポリゴン(_qmlAux)が紛れていない
  const auxTotal = snap.dataSources.reduce((a, d) => a + d.auxPoly, 0);
  rec("no_aux_poly", auxTotal === 0, `aux polygon total=${auxTotal}`);

  // 4) entity 総数が地物数と一致(全 entity が polygon/line/point のいずれか1つ。
  //    grid.parquet のような点レイヤーは poly=0 で pt=地物数になるのが正しい)
  for (const d of [...fgbDs, ...pqDs]) {
    rec(`count.${d.name}`, d.poly + d.line + d.pt === d.entities && d.auxPoly === 0,
      `${d.name}: entities=${d.entities} poly=${d.poly} line=${d.line} pt=${d.pt} aux=${d.auxPoly}`);
  }

  rec("no_pageerror", pageErrors.length === 0,
    `errors=${pageErrors.join(" | ") || "none"}`);
  await page.screenshot({ path: join(OUT, "poly-dup.png") });
} catch (e) { rec("probe.run", false, String(e).slice(0, 400)); }

console.log(JSON.stringify({ pass: results.filter(r => r.ok).length, total: results.length }));
await ctx.close();
srv.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
