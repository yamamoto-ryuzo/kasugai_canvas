import { writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = "C:/devin/kasugai_canvas/web/verify/results";
const BASE = "http://127.0.0.1:8510";
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const prof = join(os.tmpdir(), "kasc-probe-qmllabel2");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
page.on("pageerror", e => console.log("PAGEERR", String(e).slice(0, 200)));

await page.goto(`${BASE}/cesium/?project=_qml_verify`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(15000);
// fitInPolygonOnly + centroidInside が有効なため、全体図(h=30000)では
// 区市町村ポリゴン内にラベルが収まらず全滅するのが正しい挙動(QGIS と同じ)。
// ラベル描画の確認は詳細ズームで行う
await page.evaluate(() => window.kasugaiApi.flyTo(
  { latitude: 35.66, longitude: 139.75, height: 2500, pitch: -90 }, 0));
await page.waitForTimeout(4000);
const obs = await page.evaluate(() => {
  const v = window._viewer;
  const out = { obstacles: 0, labelsTotal: 0, labelsShown: 0, obsByKind: {} };
  for (const ds of v?.dataSources?._dataSources || []) {
    out.obstacles += ds._qmlObstacles?.length || 0;
    for (const o of ds._qmlObstacles || []) out.obsByKind["kind" + o.kind] = (out.obsByKind["kind" + o.kind] || 0) + 1;
    for (const c of ds._qmlLabels || []) {
      out.labelsTotal++;
      const g = c.entity?.label || c.entity?.billboard;
      if (g?.show?.getValue?.() === true) out.labelsShown++;
    }
  }
  return out;
});
console.log("  cesium:", JSON.stringify(obs));
rec("B3: 障害物が登録されている(obstacle=1 レイヤのみ)", obs.obstacles > 0, JSON.stringify(obs));
rec("B4: ラベルが描画されている(障害物で全滅していない)", obs.labelsShown > 0,
  `${obs.labelsShown}/${obs.labelsTotal}`);
await page.screenshot({ path: `${OUT}/qmllabel-cesium.png` });

const page2 = await ctx.newPage();
page2.setDefaultTimeout(120000);
page2.on("pageerror", e => console.log("PAGEERR(ml)", String(e).slice(0, 200)));
await page2.goto(`${BASE}/maplibre/?project=_qml_verify`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page2.waitForTimeout(20000);
const feat = await page2.evaluate(() => {
  const map = window.kascMap;
  const out = { hit: 0, checked: 0, sources: 0 };
  for (const sid of Object.keys(map.getStyle().sources || {})) {
    let feats = [];
    try {
      const s = map.getSource(sid);
      const d = s?.data || s?._data;
      feats = typeof d === "string" ? [] : (d?.features || []);
      if (!feats.length && s?._options?.data?.features) feats = s._options.data.features;
    } catch (_) {}
    if (!feats.length) { try { feats = map.querySourceFeatures(sid) || []; } catch (_) {} }
    if (feats.length) out.sources++;
    for (const f of feats) {
      out.checked++;
      if (f.properties?.__kasc_label_img) out.hit++;
      else if (f.properties?.__kasc_label) out.textLbl = (out.textLbl || 0) + 1;
    }
  }
  return out;
});
console.log("  ml features:", JSON.stringify(feat));
rec("C3: 地物に __kasc_label_img が焼き込まれている", (feat?.hit || 0) > 0, JSON.stringify(feat));
// 画面に icon が実描画されているか(queryRenderedFeatures で icon レイヤの描画物)。
// 全体図では衝突判定(fitInPolygonOnly 相当)で全滅するのが正しいため詳細ズームで確認
await page2.evaluate(() => {
  const map = window.kascMap;
  map.jumpTo({ center: [139.75, 35.66], zoom: 13 });
});
await page2.waitForTimeout(4000);
const drawn = await page2.evaluate(() => {
  const map = window.kascMap;
  const l = (map.getStyle().layers || []).find(l => l.type === "symbol"
    && JSON.stringify(l.layout?.["icon-image"] || "").includes("__kasc_label_img"));
  if (!l) return { noLayer: true };
  try {
    const feats = map.queryRenderedFeatures(undefined, { layers: [l.id] }) || [];
    return { rendered: feats.length, layerId: l.id };
  } catch (e) { return { err: String(e), layerId: l.id }; }
});
console.log("  ml drawn:", JSON.stringify(drawn));
rec("C4: icon-image ラベルが画面に描画されている", (drawn?.rendered || 0) > 0, JSON.stringify(drawn));
await page2.screenshot({ path: `${OUT}/qmllabel-maplibre.png` });
await ctx.close();
writeFileSync(`${OUT}/qmllabel-probe2.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.filter(r => r.ok).length}/${results.length} PASS`);
process.exit(results.some(r => !r.ok) ? 1 : 0);
