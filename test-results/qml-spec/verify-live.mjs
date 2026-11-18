// 実機検証: geo_webview /kasugai エクスポート済み ProjectFiles を各エンジンで描画確認。
// キャッシュ回避のため no-cache ヘッダを全リクエストへ付与
import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
import { mkdirSync } from "node:fs";

const PROJ = process.argv[2] || "ProjectFiles";
const ENGINES = (process.argv[3] || "cesium,maplibre,openlayers,leaflet,navara").split(",");
mkdirSync("test-results/qml-spec/live-shots", { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));

for (const eng of ENGINES) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.route("**/*", route => route.continue({ headers: { ...route.request().headers(), "cache-control": "no-cache" } }));
  const errors = [], qmlWarns = [], fnWarns = [];
  page.on("console", m => {
    const t = m.text();
    if (m.type() === "error") errors.push(t.slice(0, 250));
    if (/QML スタイル/.test(t)) qmlWarns.push(t.slice(0, 250));
    if (/未対応関数/.test(t)) fnWarns.push(t.slice(0, 200));
  });
  page.on("pageerror", e => errors.push("PAGEERROR: " + String(e).slice(0, 250)));
  const url = `http://127.0.0.1:8510/${eng}/?project=${PROJ}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(eng === "cesium" || eng === "navara" ? 20000 : 12000);
  const info = await page.evaluate(async () => {
    const r = { layers: null, labels: null, exprScale: null, visExpr: null, mlLabels: null };
    try {
      const api = window.kasugaiApi;
      if (api?.listLayers) r.layers = api.listLayers().length;
    } catch {}
    try {
      const m = await import("/shared/qml-style.js");
      r.exprScale = m.evalQgisExpression("@map_scale", {});
      r.visExpr = m.evalQgisExpression("if( is_layer_visible('都道府県名'), \"N03_001\" ,'') || if( is_layer_visible('市区町村名'),\"N03_004\",'')", { N03_001: "東京都", N03_004: "世田谷区" });
    } catch (e) { r.exprErr = String(e).slice(0, 120); }
    try {
      const v = window._viewer;
      if (v?.dataSources) {
        let n = 0;
        for (let i = 0; i < v.dataSources.length; i++)
          for (const e of v.dataSources.get(i).entities.values) if (e.label || e.billboard) n++;
        r.labels = n;
      }
    } catch {}
    try {
      if (window.kascMap?.queryRenderedFeatures) {
        const feats = window.kascMap.queryRenderedFeatures();
        r.mlLabels = feats.filter(f => f.layer?.type === "symbol" && f.properties?.__kasc_label).length;
      }
    } catch {}
    try {
      if (window.kascMap?.eachLayer) { let n = 0; window.kascMap.eachLayer(l => { if (l._kascLabel) n++; }); r.labels = n; }
      if (window.kascMap?.getLayers) { let n = 0; window.kascMap.getLayers().forEach(l => n += l.getSource?.()?.getFeatures?.()?.length || 0); r.olFeats = n; }
    } catch {}
    return r;
  });
  await page.screenshot({ path: `test-results/qml-spec/live-shots/${eng}.png` });
  console.log(JSON.stringify({ engine: eng, ...info, qmlWarns: qmlWarns.length, fnWarns, errors: errors.slice(0, 5) }));
  await ctx.close();
}
await browser.close();
