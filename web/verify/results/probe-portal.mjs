// V9 ポータル検証プローブ (skill: verify-portal)
//  実行: node web/verify/results/probe-portal.mjs [cesium,maplibre,...]
//  フィクスチャ: web/verify/portal/portal.kasc + noportal.kasc
//  V1 portal:宣言/open=auto  V2 view:一括適用  V3 解除→スナップショット復元
//  V4 link:カード  V5 html:セクション  V6 data-* 宣言的操作  V7 常時ポータル
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json", ".kasc": "text/plain",
  ".css": "text/css", ".xml": "application/xml" };
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
const KASC = `${base}/verify/portal/portal.kasc`;
const KASC_NONE = `${base}/verify/portal/noportal.kasc`;
const ENGINES = (process.argv[2] || "cesium,maplibre,openlayers,leaflet").split(",");

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
  page.on("pageerror", e => console.log(`[${engine}] PAGEERR:`, String(e).slice(0, 160)));
  try {
    await page.goto(`${base}/${engine}/?kasc=${encodeURIComponent(KASC)}`,
      { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
    await page.waitForFunction(
      () => window.kasugaiApi && window.kasugaiApi.listLayers?.().length > 0,
      null, { timeout: 90000, polling: 800 });
    // portal open=auto の描画待ち(cesium は読込が遅い場合があるため 8s までポーリング)
    await page.waitForFunction(
      () => document.querySelector("#portal-overlay")?.hidden === false,
      null, { timeout: 8000, polling: 500 }).catch(() => {});

    const v1 = await page.evaluate(() => ({
      overlay: !document.querySelector("#portal-overlay")?.hidden,
      title: document.querySelector("#portal-title")?.textContent || "",
      cards: [...document.querySelectorAll("#portal-body button, #portal-body a")]
        .map(b => (b.textContent || "").trim().slice(0, 24)),
      html: (document.querySelector("#portal-body")?.innerHTML || "").includes("テストお知らせXYZ"),
      openBtn: !!document.querySelector("#portal-open"),
    }));
    rec(`V1[${engine}]`, v1.overlay && /検証ポータル/.test(v1.title),
      `open=auto overlay=${v1.overlay} title="${v1.title}"`);
    rec(`V4[${engine}]`, v1.cards.some(c => /外部リンク/.test(c)),
      `link カード=${v1.cards.join("/") || "none"}`);
    rec(`V5[${engine}]`, v1.html, `html セクション埋込=${v1.html}`);

    // V2: view カード押下 → 適用 & ポータル閉じ
    const v2 = await page.evaluate(async () => {
      const find = t => [...document.querySelectorAll("#portal-body button")]
        .find(b => (b.textContent || "").includes(t));
      const before = Object.fromEntries(window.kasugaiApi.listLayers().map(l => [l.title, l.visible]));
      find("レイヤ1のみ")?.click();
      await new Promise(r => setTimeout(r, 1500));
      const mid = Object.fromEntries(window.kasugaiApi.listLayers().map(l => [l.title, l.visible]));
      const closed = document.querySelector("#portal-overlay")?.hidden !== false;
      return { before, mid, closed };
    });
    const l2off = Object.entries(v2.mid).some(([t, v]) => /レイヤ2|対象外/.test(t) && v === false) &&
                  Object.entries(v2.mid).some(([t, v]) => /レイヤ1/.test(t) && v === true);
    rec(`V2[${engine}]`, l2off && v2.closed,
      `view適用 mid=${JSON.stringify(v2.mid)} 閉じ=${v2.closed}`);

    // V3: 解除 → 適用前スナップショット復元(対象外=off 状態へ戻る)
    const v3 = await page.evaluate(async () => {
      document.querySelector("#portal-open")?.click();
      await new Promise(r => setTimeout(r, 800));
      const clear = document.querySelector("#portal-clear");
      const hasClear = !!clear;
      if (clear && clear.closest("#portal-footer")?.hidden === false) clear.click();
      else clear?.click();
      await new Promise(r => setTimeout(r, 1200));
      const after = Object.fromEntries(window.kasugaiApi.listLayers().map(l => [l.title, l.visible]));
      return { hasClear, after };
    });
    const restored = Object.entries(v3.after).some(([t, v]) => /対象外/.test(t) && v === false);
    rec(`V3[${engine}]`, restored,
      `解除後=${JSON.stringify(v3.after)} clear=${v3.hasClear}`);

    // V7: 宣言なしプロジェクトでも 🏠 常駐・既定ガイド
    const page2 = await browser.newPage();
    try {
      await page2.goto(`${base}/${engine}/?kasc=${encodeURIComponent(KASC_NONE)}`,
        { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
      await page2.waitForFunction(
        () => window.kasugaiApi && window.kasugaiApi.listLayers?.().length > 0,
        null, { timeout: 90000, polling: 800 });
      await page2.waitForTimeout(2500);
      const v7 = await page2.evaluate(async () => {
        const btn = document.querySelector("#portal-open");
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 1000));
        const body = document.querySelector("#portal-body");
        return { btn: !!btn,
          open: document.querySelector("#portal-overlay")?.hidden === false,
          guide: (body?.textContent || "").length > 20 };
      });
      rec(`V7[${engine}]`, v7.btn && v7.open && v7.guide,
        `🏠=${v7.btn} 開=${v7.open} 既定ガイド=${v7.guide}`);
    } catch (e) { rec(`V7[${engine}]`, false, `常時ポータル失敗: ${String(e).slice(0, 120)}`); }
    await page2.close();

    // V6: data-view 宣言的操作(html: 内の data-view 属性)
    skip(`V6[${engine}]`, "data-view/link/cam/base/clear/close の宣言的操作はカスタム html: フィクスチャが必要 — 次回項目");
  } catch (e) {
    rec(`Vx[${engine}]`, false, `起動/評価失敗: ${String(e).slice(0, 160)}`);
  }
  await page.close();
}

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
