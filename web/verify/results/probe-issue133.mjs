// Issue #133 検証: join=/on=/joinprefix=
// ※ join= 機能は意図的に撤去済み(検証資産 _join_test も commit a585e62 で削除)。
//    本プローブは検証対象が存在しないため常に SKIP を返す。
console.log("SKIP issue133 :: join=/on=/joinprefix= 機能は撤去済み(検証対象なし)");
process.exit(0);
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = process.env.PROBE_BASE || "http://127.0.0.1:8510";
const browser = await chromium.launch({
  executablePath: `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1243/chrome-win64/chrome.exe`,
});
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", e.message));
const KASC = encodeURIComponent(`${BASE}/projects/_join_test/join_test.kasc`);
await page.goto(`${BASE}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
// 同一オリジン化してからモジュール直検証(CSV結合・LEFT JOIN・接頭辞・数値キー)
const mod = await page.evaluate(async (base) => {
  const m = await import(`${base}/shared/vector-load.js`);
  const item = { type: "geojson", title: "t", url: `${base}/projects/_join_test/canvas_data/city.geojson`,
    opts: { join: `${base}/projects/_join_test/canvas_data/pop.csv`, on: "code=city_code", joinprefix: "pop_" } };
  const r = await m.loadVectorItem(item, "", null, null);
  return { props: r.geojson.features.map(f => f.properties), joinInfo: r.joinInfo };
}, BASE);
console.log("MODULE=" + JSON.stringify(mod));
// 実経路: entity プロパティに結合列があるか(where 行は1件のみのはず)
try {
  await page.waitForFunction(() => {
    const v = window._viewer || window.viewer;
    if (!v) return false;
    let n = 0;
    for (let i = 0; i < v.dataSources.length; i++) n += v.dataSources.get(i).entities.values.length;
    return n >= 1;
  }, { timeout: 120000 });
} catch (e) { console.log("WAIT_FAIL"); }
const ent = await page.evaluate(() => {
  const v = window._viewer || window.viewer;
  const out = [];
  if (v) for (let i = 0; i < v.dataSources.length; i++)
    for (const e of v.dataSources.get(i).entities.values) {
      try { out.push(e.properties ? e.properties.getValue(v.clock.currentTime) : {}); } catch (_) { out.push({}); }
    }
  return out;
});
console.log("ENTITIES=" + JSON.stringify(ent));
await page.evaluate(() => { const v = window._viewer || window.viewer; if (v && v.dataSources.length) v.flyTo(v.dataSources.get(0)); });
await page.waitForTimeout(3000);
await page.screenshot({ path: join(OUT, "probe-issue133-join.png") });
await browser.close();
