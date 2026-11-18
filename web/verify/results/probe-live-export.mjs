// 実機 QGIS -> /kasugai エクスポート成果物 (project=ProjectFiles) の
// 全エンジン描画検証。双方向カバレッジの順方向(QGIS->Canvas)確認用。
// 使い方: node web/verify/results/probe-live-export.mjs [engine ...]
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:8510";
const PROJECT = "ProjectFiles";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SHOTS = `${OUT}live-export`;
mkdirSync(SHOTS, { recursive: true });

const engines = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["cesium", "maplibre", "openlayers", "leaflet", "navara", "gsimaps"];

const results = { checks: [], errors: {} };
const ok = (eng, name, cond, extra = "") => {
  results.checks.push({ engine: eng, name, pass: !!cond, extra });
  console.log(cond ? "PASS" : "FAIL", `[${eng}]`, name, extra);
};

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch { browser = await chromium.launch(); }

for (const eng of engines) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on("pageerror", e => errs.push(`[pageerror] ${String(e).slice(0, 200)}`));
  page.on("console", m => {
    if (m.type() === "error") errs.push(`[error] ${m.text().slice(0, 200)}`);
  });
  const url = `${BASE}/${eng}/?project=${PROJECT}`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // エンジン別の描画待機
    await page.waitForTimeout(eng === "cesium" ? 15000 : eng === "gsimaps" ? 12000 : 10000);
    // レイヤ読み込み状況を DOM/状態から採取
    const state = await page.evaluate(() => {
      const s = { title: document.title };
      const el = document.querySelector("#layer-list, .layer-list, [id*=layer]");
      s.layerText = el ? el.textContent.slice(0, 500) : null;
      // 共通のステータス領域があれば拾う
      const st = document.querySelector("#status, .status, [id*=status]");
      s.status = st ? st.textContent.slice(0, 300) : null;
      return s;
    }).catch(e => ({ evalError: String(e) }));
    await page.screenshot({ path: `${SHOTS}/${eng}.png` });
    ok(eng, "page-load", !state.evalError, JSON.stringify(state).slice(0, 200));
    // 致命的エラーのみ FAIL (タイル404や CORS 警告等は別記録)
    const fatal = errs.filter(e =>
      !/404|net::|CORS|Access-Control|favicon|tile|ERR_/i.test(e));
    ok(eng, "no-fatal-error", fatal.length === 0,
       fatal.slice(0, 3).join(" | ") || `nonfatal=${errs.length}`);
    results.errors[eng] = errs.slice(0, 10);
  } catch (e) {
    ok(eng, "page-load", false, String(e).slice(0, 200));
  }
  await page.close();
}

await browser.close();
const pass = results.checks.filter(c => c.pass).length;
console.log(`\n=== ${pass}/${results.checks.length} PASS ===`);
writeFileSync(`${SHOTS}/results.json`, JSON.stringify(results, null, 2));
