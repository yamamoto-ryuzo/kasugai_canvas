// V4 Google Maps Platform 連携検証プローブ (skill: verify-gmaps)
//  実行: node web/verify/results/probe-gmaps.mjs [engine,...]
//  GM1 設定タブ/入力欄の存在  GM2 キー保存→localStorage/状態反映  GM3 3D Tiles 実表示(要キー)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".kasc": "text/plain", ".css": "text/css" };
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
    await page.goto(`${base}/${engine}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.kasugaiApi, null, { timeout: 90000, polling: 800 });
    await page.waitForTimeout(1500);

    const gm = await page.evaluate(async () => {
      const ui = {
        tab: !!document.querySelector("[data-settab=gmaps], [data-tab=gmaps], #setpane-gmaps"),
        key: !!document.querySelector("#gmaps-api-key"),
        toggle: !!document.querySelector("#gmaps-3dtiles-toggle"),
        save: !!document.querySelector("#gmaps-save"),
      };
      // キー保存フロー(ダミーキーで保存ボタン押下 → 状態/localStorage 反映)
      let saved = null, status = "";
      const inp = document.querySelector("#gmaps-api-key");
      const btn = document.querySelector("#gmaps-save");
      if (inp && btn) {
        inp.value = "TEST_KEY_12345";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        btn.click();
        await new Promise(r => setTimeout(r, 800));
        status = document.querySelector("#gmaps-status")?.textContent?.trim() || "";
        saved = Object.keys(localStorage).filter(k => /gmaps|google/i.test(k))
          .map(k => `${k}=${(localStorage.getItem(k) || "").slice(0, 20)}`).join(";");
      }
      return { ui, saved, status };
    });
    rec(`GM1[${engine}]`, gm.ui.tab && gm.ui.key && gm.ui.save,
      `設定UI: ${JSON.stringify(gm.ui)}`);
    rec(`GM2[${engine}]`, !!gm.saved || /保存|saved|登録/i.test(gm.status),
      `キー保存 → storage="${gm.saved}" status="${gm.status}"`);
    skip(`GM3[${engine}]`, "Photorealistic 3D Tiles 実表示には有効な Maps API キーが必要(要キー)");
  } catch (e) {
    rec(`GMx[${engine}]`, false, `起動/評価失敗: ${String(e).slice(0, 160)}`);
  }
  await page.close();
}

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
