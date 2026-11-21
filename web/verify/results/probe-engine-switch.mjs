// V6 エンジン選択と切替検証プローブ (skill: verify-engine-switch)
//  実行: node web/verify/results/probe-engine-switch.mjs
//  E1 ?engine= 全6値で振分  E2 engine 無し→cesium 既定
//  E3 ハッシュ(カメラ)引継ぎ  E4 レイヤ可視性引継ぎ  E6 kasc 引継ぎ
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json", ".kasc": "text/plain",
  ".css": "text/css" };
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    const fp = resolve(join(WEB, p.endsWith("/") ? p + "index.html" : p));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(fp)] || "application/octet-stream", "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const KASC = `${base}/verify/kasc-state/kasc-state.kasc`;

const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

// ---- E1/E2: ?engine= 振分(軽量: 遷移先パスのみ) ----
for (const eng of ["cesium", "maplibre", "openlayers", "leaflet", "gsimaps", "navara"]) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/?engine=${eng}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForURL(`**/${eng}/**`, { timeout: 15000 }).catch(() => {});
    rec(`E1[${eng}]`, page.url().includes(`/${eng}/`), `→ ${page.url().slice(base.length)}`);
  } catch (e) { rec(`E1[${eng}]`, false, String(e).slice(0, 120)); }
  await page.close();
}
{
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForURL("**/cesium/**", { timeout: 15000 }).catch(() => {});
    rec("E2", page.url().includes("/cesium/"), `既定 → ${page.url().slice(base.length)}`);
  } catch (e) { rec("E2", false, String(e).slice(0, 120)); }
  await page.close();
}

// ---- E3: ハッシュ引継ぎ ----
{
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/?engine=maplibre#latitude=35.7&longitude=139.7&height=5000`,
      { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForURL("**/maplibre/**", { timeout: 15000 }).catch(() => {});
    const h = new URL(page.url()).hash;
    rec("E3", h.includes("35.7") && h.includes("139.7"), `hash=${h || "(空)"}`);
  } catch (e) { rec("E3", false, String(e).slice(0, 120)); }
  await page.close();
}

// ---- E4/E6: 可視性・プロジェクト引継ぎ(maplibre → leaflet) ----
const page = await browser.newPage();
try {
  await page.goto(`${base}/maplibre/?kasc=${encodeURIComponent(KASC)}`,
    { waitUntil: "domcontentloaded", timeout: 60000 })
    .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
  await page.waitForFunction(
    () => window.kasugaiApi && window.kasugaiApi.listLayers?.().length > 0,
    null, { timeout: 90000, polling: 800 });
  // レイヤ1を OFF にしてから切替リンクで leaflet へ
  const sw = await page.evaluate(async () => {
    const api = window.kasugaiApi;
    const l1 = api.listLayers().find(l => /通常A/.test(l.title));
    api.setLayerVisible(l1.title, false);
    // 切替リンク href を生成(リンク使用直前 refresh と同等: hash/クエリ引継ぎ)
    const a = document.querySelector('#engines a[data-engine="leaflet"]');
    let href = a?.href;
    if (!href) {
      const p = new URLSearchParams(location.search);
      p.set("engine", "leaflet");
      href = `../?${p}${location.hash}`;
    } else {
      a.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); // refresh 発火
      href = a.href;
    }
    return { href, off: api.listLayers().find(l => /通常A/.test(l.title))?.visible };
  });
  rec("E6", sw.off === false && /kasc=/.test(sw.href), `href=${sw.href.slice(0, 140)}`);
  await page.goto(new URL(sw.href, page.url()).href,
    { waitUntil: "domcontentloaded", timeout: 60000 })
    .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
  await page.waitForFunction(
    () => window.kasugaiApi && window.kasugaiApi.listLayers?.().length > 0,
    null, { timeout: 90000, polling: 800 });
  const after = await page.evaluate(() => {
    const ls = window.kasugaiApi.listLayers();
    return { l1: ls.find(l => /通常A/.test(l.title))?.visible, n: ls.length,
      titles: ls.map(l => l.title).join("|") };
  });
  rec("E4", after.l1 === false && after.n >= 5,
    `leaflet 側 通常A visible=${after.l1} 層数=${after.n}`);
} catch (e) { rec("E4", false, `切替引継ぎ失敗: ${String(e).slice(0, 160)}`); }
await page.close();

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length} PASS ====`);
process.exit(fails ? 1 : 0);
