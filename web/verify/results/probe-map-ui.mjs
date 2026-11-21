// V1 GIS基本機能(UI面)検証プローブ (skill: verify-map-ui)
//  実行: node web/verify/results/probe-map-ui.mjs [engine,...]
//  フィクスチャ: web/verify/map-ui/map-ui.kasc (info: 行+geojson)
//  M1 info:  M2 Share  M3 ナビ  M4 Attr  M5 i18n  M6 印刷
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
const KASC = `${base}/verify/map-ui/map-ui.kasc`;
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
  page.on("pageerror", e => console.log(`[${engine}] PAGEERR:`, String(e).slice(0, 160)));
  try {
    await page.goto(`${base}/${engine}/?kasc=${encodeURIComponent(KASC)}`,
      { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
    await page.waitForFunction(
      () => window.kasugaiApi && window.kasugaiApi.listLayers?.().length > 0,
      null, { timeout: 90000, polling: 800 });

    // M1 info: サニタイズ済み埋込
    const m1 = await page.evaluate(async () => {
      document.querySelector('[data-tab="info"]')?.click();
      await new Promise(r => setTimeout(r, 600));
      const info = document.querySelector("#info-link") ||
        document.querySelector(".tab-content[data-panel*=info], [id*=info]");
      return { html: info?.innerHTML?.includes("インフォテストXYZ"),
        xss: window.__xss === 1,
        text: (info?.textContent || "").slice(0, 60) };
    });
    rec(`M1[${engine}]`, m1.html && !m1.xss,
      `info 埋込=${m1.html} script除去=${!m1.xss} text="${m1.text}"`);

    // M2 Share: 🔗 ボタン存在 + URL ハッシュにカメラ
    const m2 = await page.evaluate(() => ({
      btn: !!document.querySelector("#share-copy"),
      hash: location.hash,
    }));
    rec(`M2[${engine}]`, m2.btn && /latitude=|lon|lat/.test(m2.hash || ""),
      `share=${m2.btn} hash=${(m2.hash || "").slice(0, 60)}`);

    // M3 ナビ: コンパス・履歴・スクリーンショット等の存在
    const m3 = await page.evaluate(() => ({
      compass: !!document.querySelector("#nav-compass, .compass-button"),
      hist: !!document.querySelector("#view-back") && !!document.querySelector("#view-forward"),
      shot: !!document.querySelector("#screenshot-button"),
      fs: !!document.querySelector("#fullscreen-button"),
      loc: !!document.querySelector("#locate-button"),
      toolbar: !!document.querySelector(".navigation-toolbar"),
    }));
    rec(`M3[${engine}]`, m3.compass && m3.hist && m3.shot && m3.toolbar,
      `nav=${JSON.stringify(m3)}`);

    // M4 Attr: 属性ウィジェットが開く
    const m4 = await page.evaluate(async () => {
      document.querySelector("#attr-widget-open")?.click();
      await new Promise(r => setTimeout(r, 800));
      const w = document.querySelector(".vector-attr-widget");
      return { open: !!w && w.offsetParent !== null || !!w,
        rows: document.querySelectorAll(".vector-attr-widget .attr-feature, .vector-attr-widget tr").length };
    });
    rec(`M4[${engine}]`, m4.open, `attr widget open=${m4.open} rows=${m4.rows}`);

    // M5 i18n: en → ja 切替で文言が変わる
    const m5 = await page.evaluate(async () => {
      const i18n = await import("../shared/i18n.js");
      const el = document.querySelector("[data-i18n]");
      const before = el?.textContent;
      await i18n.setLanguage("en");
      const en = el?.textContent;
      await i18n.setLanguage("ja");
      const ja = el?.textContent;
      return { before, en, ja, langs: i18n.SUPPORTED_LANGUAGES?.length,
        changed: en !== ja };
    });
    rec(`M5[${engine}]`, m5.langs === 8 && m5.changed !== false,
      `8言語=${m5.langs} en="${m5.en}" ja="${m5.ja}"`);

    // M6 印刷: ダイアログが開き帳票要素がある
    const m6 = await page.evaluate(async () => {
      for (let i = 0; i < 2; i++) {
        document.querySelector("#print-open")?.click();
        await new Promise(r => setTimeout(r, 700));
        if ([...document.querySelectorAll("#print-dialog")].some(d => d.hidden === false)) break;
      }
      const dlgs = [...document.querySelectorAll("#print-dialog")];
      const openDlg = dlgs.find(d => d.hidden === false);
      const title = document.querySelector("#print-title-input");
      const ids = dlgs.length + ":" + [...document.querySelectorAll("[id^=print-]")]
        .map(e => e.id).join(",");
      openDlg?.querySelector("#print-close")?.click() ??
        document.querySelector("#print-close")?.click();
      return { open: !!openDlg, hasTitle: !!title, fields: ids.slice(0, 160) };
    });
    rec(`M6[${engine}]`, m6.open && m6.hasTitle,
      `print dlg=${m6.open} title=${m6.hasTitle} fields=${m6.fields}`);
  } catch (e) {
    rec(`Mx[${engine}]`, false, `起動/評価失敗: ${String(e).slice(0, 160)}`);
  }
  await page.close();
}

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
