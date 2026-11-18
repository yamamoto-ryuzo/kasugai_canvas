// 実機経路検証: geo_webview が出力した .kasc+DATA/ (project=ProjectFiles) を
// 各エンジンで開き、QML 解決・コンソールエラー・警告を収集してスクリーンショット保存
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire("C:/devin/qgis_live_harness/x.cjs");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:8510";
const ENGINES = process.argv[2] ? process.argv[2].split(",") : ["cesium", "maplibre", "openlayers", "leaflet", "navara"];
const SHOTS = "C:/devin/kasugai_canvas/test-results/qml-spec/live-shots";
mkdirSync(SHOTS, { recursive: true });

const url = e => `${BASE}/${e}/?project=ProjectFiles`;

const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
for (const engine of ENGINES) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const logs = [];
  page.on("console", m => {
    const t = m.type(), txt = m.text();
    if (t === "error" || t === "warning") logs.push(`[${t}] ${txt}`);
  });
  page.on("pageerror", e => logs.push(`[pageerror] ${e.message}`));
  page.on("response", r => {
    if (r.status() >= 400 && /\.qml|\.fgb|\.gpkg|canvas_data/.test(r.url()))
      logs.push(`[http ${r.status()}] ${r.url()}`);
  });
  try {
    await page.goto(url(engine), { waitUntil: "domcontentloaded", timeout: 30000 });
    // レイヤー読み込み待ち(エンジン初期化 + fgb/gpkg 非同期ロード)
    await page.waitForTimeout(12000);
    // ベースマップなし(QML 描画検証の規約)
    const baseOk = await page.evaluate(() => window.kasugaiApi?.setBasemap?.("none") ?? null).catch(() => null);
    await page.waitForTimeout(1500);
    const layerInfo = await page.evaluate(() => {
      const api = window.kasugaiApi;
      if (!api) return null;
      const items = api.listLayers?.() || api.layers?.() || null;
      return items;
    }).catch(() => null);
    const qmlWarn = logs.filter(l => /qml|style|スタイル|404|error/i.test(l));
    console.log(`\n===== ${engine} =====`);
    console.log("basemap-none:", baseOk);
    console.log("layers:", JSON.stringify(layerInfo)?.slice(0, 800));
    console.log("console issues:", logs.length ? "" : "(none)");
    for (const l of logs.slice(0, 40)) console.log("  " + l.slice(0, 300));
    await page.screenshot({ path: `${SHOTS}/${engine}-verify.png` });
    console.log("shot:", `${SHOTS}/${engine}-verify.png`);
  } catch (e) {
    console.log(`\n===== ${engine} FAILED: ${e.message} =====`);
  }
  await page.close();
}
await browser.close();
