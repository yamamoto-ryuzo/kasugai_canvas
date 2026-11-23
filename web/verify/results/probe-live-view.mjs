// verify-live-view: geo_webview Canvas Live View の実機検証プローブ
//   QGIS :8089 の /live/kasc（オンデマンド生成）を全エンジンで開き、
//   live: 行接続・レイヤ描画・QML(style=/live/style)供給を確認する。
// 前提: QGIS 実機 :8089 稼働 + Canvas :8510（または :8520 dev）。
// 使い方:
//   node web/verify/results/probe-live-view.mjs [engine ...] [--host 8510]
//   例: node web/verify/results/probe-live-view.mjs cesium maplibre
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const QGIS = "http://127.0.0.1:8089";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SHOTS = `${OUT}live-view`;
mkdirSync(SHOTS, { recursive: true });

const args = process.argv.slice(2);
let host = 8510;
const hi = args.indexOf("--host");
if (hi >= 0) { host = args[hi + 1]; args.splice(hi, 2); }
const BASE = `http://127.0.0.1:${host}`;
const engines = args.length
  ? args
  : ["cesium", "maplibre", "openlayers", "leaflet", "gsimaps", "navara"];

const checks = [];
const ok = (eng, name, cond, extra = "") => {
  checks.push({ engine: eng, name, pass: !!cond, extra });
  console.log(cond ? "PASS" : "FAIL", `[${eng}]`, name, extra ? `:: ${extra}` : "");
};

// --- Phase A: 前提チェック ---
const live = await fetch(`${QGIS}/live/state`).then(r => r.json()).catch(() => null);
ok("qgis", "live-state", !!live && live.ok !== false,
   live ? `rev=${live.rev ?? "?"}` : "no response (要実機)");
if (!live) { console.log("==== 0/1 PASS ===="); process.exit(1); }

// --- Phase B-1: /live/kasc 生成物の構造 ---
const kasc = await fetch(`${QGIS}/live/kasc`).then(r => r.text()).catch(() => "");
const lines = kasc.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#"));
const liveLine = lines.find(l => l.startsWith("live:"));
const styleRefs = lines.filter(l => /[|;]?\s*style=[^ ]*\/live\/style/.test(l));
const featRefs = lines.filter(l => l.includes("/live/features"));
ok("kasc", "live-line", !!liveLine, liveLine?.slice(0, 80));
ok("kasc", "style-refs", styleRefs.length > 0, `${styleRefs.length} lines`);
ok("kasc", "feature-refs", featRefs.length > 0, `${featRefs.length} lines`);

// --- Phase C-1: /live/style の QML 供給 ---
const m = /[|;]?\s*style=(\S*\/live\/style\S*)/.exec(styleRefs[0] || "");
if (m) {
  const qml = await fetch(decodeURIComponent(m[1])).then(r => r.text()).catch(() => "");
  const hasRenderer = /<renderer-v2\b/.test(qml) || /type="singleSymbol"|type="categorizedSymbol"|type="RuleRenderer"|type="graduatedSymbol"/.test(qml);
  ok("qml", "live-style-qml", hasRenderer,
     hasRenderer ? (qml.match(/renderer-v2 type="([^"]+)"/) || [])[1] || "qml-ok"
                 : `len=${qml.length}`);
} else {
  ok("qml", "live-style-qml", false, "no style= reference found");
}

// --- Phase B-2/C: 全エンジンで Live URL を開く ---
const enc = encodeURIComponent(`${QGIS}/live/kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ headless: true }); }

// 404 のうち実害のない既知ノイズ（任意ファイルのプローブ）
const NOISE_404 = /ui\.config\.json|project\.json|projects\.json|favicon/i;
const ASSET_EXT = /\.(svg|png|jpe?g|gif|webp|bmp)$/i;

for (const eng of engines) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [], liveReqs = [], asset404 = [];
  page.on("pageerror", e => errs.push(`[pageerror] ${String(e).slice(0, 200)}`));
  page.on("console", m => {
    if (m.type() === "error" && !NOISE_404.test(m.location()?.url || ""))
      errs.push(`[error] ${m.text().slice(0, 200)}`);
  });
  page.on("request", r => {
    if (r.url().includes("/live/")) liveReqs.push(r.url().split("?")[0]);
  });
  page.on("response", r => {
    const u = r.url();
    if (r.status() >= 400 && !NOISE_404.test(u) &&
        u.includes("/live/") && ASSET_EXT.test(u.split("?")[0]))
      asset404.push(`${r.status()} ${u.split("/live/")[1].slice(0, 80)}`);
  });
  try {
    await page.goto(`${BASE}/${eng}/?kasc=${enc}`,
      { waitUntil: "domcontentloaded", timeout: 60000 });
    const wait = eng === "cesium" ? 15000 : eng === "gsimaps" ? 12000 : 10000;
    // kasugaiApi 出現 + レイヤ認識をポーリング待機
    const deadline = Date.now() + wait + 20000;
    let st = null;
    while (Date.now() < deadline) {
      st = await page.evaluate(() => {
        const api = window.kasugaiApi;
        let layers = null;
        try { layers = api?.listLayers ? api.listLayers().length : null; } catch {}
        return {
          api: !!api,
          layers,
          title: document.title,
          errors: (window.__kascErrors || []).length || 0,
        };
      }).catch(() => null);
      if (st && st.api && st.layers > 0) break;
      await page.waitForTimeout(2000);
    }
    ok(eng, "page-load", !!st && !errs.length,
       errs.slice(0, 2).join(" | ") || `title=${st?.title}`);
    ok(eng, "layers", (st?.layers ?? 0) > 0, `layers=${st?.layers}`);
    ok(eng, "live-fetch", liveReqs.some(u => u.includes("/live/kasc")) ||
       liveReqs.length > 0, `${liveReqs.length} live reqs`);
    // QML 適用の間接確認: style 参照した fetch が成功しているか
    const styled = liveReqs.some(u => u.includes("/live/style"));
    ok(eng, "qml-style-fetch", styled, styled ? "style fetched" : "no style fetch");
    // Q5: QML が参照するシンボル画像が live 経路で解決されるか
    const uniq404 = [...new Set(asset404)];
    ok(eng, "qml-asset-404", uniq404.length === 0,
       uniq404.length ? `${uniq404.length} missing e.g. ${uniq404[0]}` : "all resolved");
    await page.screenshot({ path: `${SHOTS}/${eng}.png`, timeout: 90000 });
    ok(eng, "console-clean", !errs.length, errs[0] || "");
  } catch (e) {
    ok(eng, "page-load", false, String(e).slice(0, 200));
  }
  await page.close().catch(() => {});
}
await browser.close();

writeFileSync(`${SHOTS}/results.json`, JSON.stringify({ checks }, null, 1));
const pass = checks.filter(c => c.pass).length;
console.log(`==== ${pass}/${checks.length} PASS ====`);
process.exit(pass === checks.length ? 0 : 1);
