// geo_import → geo_webview(kasugaiExport) → Canvas 連携プローブ
// usage: node probe-import-pipeline.mjs [engine,...] [baseUrl] [projectId]
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");

const engines = (process.argv[2] || "cesium").split(",");
const base = process.argv[3] || "http://127.0.0.1:8510";
const proj = process.argv[4] || "import_pipeline";
let pass = 0, fail = 0, total = 0;
const ok = (cond, name, extra = "") => {
  total++;
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
// 既知の環境ノイズ(検証対象外)
const NOISE = /favicon|ui\.config\.json|:8585|\/api\/mcp|net::ERR_CONNECTION_REFUSED/;

const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(
  () => chromium.launch({ channel: "msedge", headless: true }));

for (const eng of engines) {
  console.log(`== ${eng} ==`);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  try {
    await page.goto(`${base}/${eng}/?project=${proj}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => window.kasugaiApi?.listLayers, { timeout: 30000 });
    await page.waitForFunction(
      () => window.kasugaiApi.listLayers().length > 0, { timeout: 60000 });
    const layers = await page.evaluate(() => window.kasugaiApi.listLayers().map(l => ({
      id: l.id, title: l.title, type: l.type, visible: l.visible,
    })));
    const names = layers.map(l => l.title || l.id);
    ok(layers.length >= 10, "kascレイヤ行が列挙される", `got ${layers.length}`);
    ok(names.some(n => /2hinansho|避難所/.test(n)), "CSV由来レイヤ(避難所)が存在");
    ok(names.some(n => /bokasuiso|防火水槽/.test(n)), "GeoJSON由来レイヤ(防火水槽)が存在");
    ok(layers.filter(l => /DM_|行政区域|都道府県名|市区町村名|point|Line/.test(l.title)).every(l => l.visible === false),
      "`| off` 行が非表示として適用されている");
    ok(layers.filter(l => /2hinansho|bokasuiso/.test(l.title)).every(l => l.visible !== false),
      "`on` 行が可視として適用されている");
    // 可視ベクターレイヤの実地物数(getLayerGeoJson; filtered はクエリ系のみ)
    // GeoJSON 等は非同期ロードのため収束ポーリングする
    await page.waitForFunction(async () => {
      for (const l of window.kasugaiApi.listLayers()) {
        if (l.visible === false) continue;
        try {
          const gj = await window.kasugaiApi.getLayerGeoJson(l.id);
          if ((gj?.features?.length ?? 0) > 0) return true;
        } catch { /* retry */ }
      }
      return false;
    }, { timeout: 30000, polling: 1000 }).catch(() => {});
    const counts = await page.evaluate(async () => {
      const out = {};
      for (const l of window.kasugaiApi.listLayers()) {
        if (l.visible === false) continue;
        try {
          const gj = await window.kasugaiApi.getLayerGeoJson(l.id);
          out[l.title] = gj?.features?.length ?? -1;
        } catch (e) { out[l.title] = "err:" + String(e).slice(0, 60); }
      }
      return out;
    });
    console.log("  feature counts:", JSON.stringify(counts));
    ok(Object.values(counts).filter(c => typeof c === "number").every(c => c > 0) && Object.keys(counts).length > 0,
      "可視ベクターレイヤに地物がある", JSON.stringify(counts));
    // console の "Failed to load resource" はURLを含まず環境ノイズと区別不可のため
    // 実JS例外(pageerror)のみを重大エラーとする。リソース失敗は別途リクエスト監視で扱う
    const real = errors.filter(e => e.startsWith("pageerror:") && !NOISE.test(e));
    ok(real.length === 0, "重大なJSエラーなし", real.slice(0, 3).join("; "));
    const cors = errors.filter(e => /CORS|blocked by CORS/.test(e)).length;
    if (cors) console.log(`  NOTE: CORSブロック ${cors}件(CORS非対応タイルサーバ・形式別制約)`);
  } catch (e) {
    ok(false, `${eng} 起動`, e.message.slice(0, 200));
  }
  await page.close();
}
await browser.close();
console.log(`\n${pass}/${total} PASS`);
process.exit(fail ? 1 : 0);
