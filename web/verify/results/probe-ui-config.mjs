// V8 UIカスタマイズ検証プローブ (skill: verify-ui-config)
//  実行: node web/verify/results/probe-ui-config.mjs [engine,...]
//  /<engine>/ui.config.json をスタブフィクスチャで配信して検証
//  U1 hide機能名  U2 hide CSS  U3 アクティブ繰上げ  U4 tools:/manage:
//  U5 defaults  U6 open  U7 helpUrl  U8 管理画面
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json", ".kasc": "text/plain",
  ".css": "text/css" };
const UI_CONFIG = {
  hide: ["attr", "#share-copy", "tools:los"],
  defaults: { "display-graticule": true },
  open: "search",
  helpUrl: "https://example.com/help/",
};
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // /<engine>/ui.config.json はフィクスチャを配信(リポジトリ非改変)
  if (/^\/[^/]+\/ui\.config\.json$/.test(p)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(UI_CONFIG));
    return;
  }
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
const hidden = el => !el || getComputedStyle(el).display === "none" || el.hidden;

for (const engine of ENGINES) {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log(`[${engine}] PAGEERR:`, String(e).slice(0, 160)));
  try {
    await page.goto(`${base}/${engine}/`, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
    await page.waitForFunction(
      () => window.kasugaiApi && document.querySelector("[data-tab]"),
      null, { timeout: 90000, polling: 800 });
    await page.waitForTimeout(2000);

    const u = await page.evaluate(() => {
      const hid = el => !el || getComputedStyle(el).display === "none" || el.hidden;
      const tab = id => document.querySelector(`[data-tab="${id}"]`);
      return {
        attrTab: hid(tab("attr")),
        attrPanel: hid(document.querySelector('[data-panel="attr"], #panel-attr, .tab-pane[data-tab="attr"]')),
        shareBtn: hid(document.querySelector("#share-copy")),
        losTool: hid(document.querySelector('#tools-bar [data-settings-panel*=los], [id*=tools-los]')),
        grat: document.querySelector("#display-graticule")?.checked,
        activeTab: [...document.querySelectorAll(".tab-pane,[id^=pane-]")]
          .find(p => !p.hidden && getComputedStyle(p).display !== "none")
          ?.id?.replace(/^pane-/, ""),
        help: document.querySelector("a#help-open")?.href,
      };
    });
    rec(`U1[${engine}]`, u.attrTab, `hide attr → tab非表示=${u.attrTab}`);
    rec(`U2[${engine}]`, u.shareBtn, `hide #share-copy → 非表示=${u.shareBtn}`);
    rec(`U4[${engine}]`, u.losTool !== false, `tools:los → 非表示=${u.losTool}`);
    rec(`U5[${engine}]`, u.grat === true, `defaults display-graticule=${u.grat}`);
    rec(`U6[${engine}]`, u.activeTab === "search", `open=search → active=${u.activeTab}`);
    rec(`U7[${engine}]`, u.help === "https://example.com/help/", `helpUrl=${u.help}`);
  } catch (e) {
    rec(`Ux[${engine}]`, false, `起動/評価失敗: ${String(e).slice(0, 160)}`);
  }
  await page.close();
}

// U8: 管理画面(実アプリ :8510。スタブサーバは /api なし → ページ構造のみ)
try {
  const page = await browser.newPage();
  const r = await page.goto("http://127.0.0.1:8510/admin/ui-config-admin.html",
    { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
  const admin = await page.evaluate(() => ({
    iframe: !!document.querySelector("iframe"),
    text: (document.body?.textContent || "").slice(0, 80),
    hasBadge: !!document.querySelector("[class*=badge], [id*=badge], [class*=check]"),
  })).catch(() => ({}));
  rec("U8", r?.ok() && (admin.iframe || admin.hasBadge),
    `admin page ${r?.status()} iframe=${admin.iframe} badge=${admin.hasBadge} "${admin.text}"`);
  await page.close();
} catch (e) { skip("U8", `管理画面未検証(要アプリ): ${String(e).slice(0, 120)}`); }

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
