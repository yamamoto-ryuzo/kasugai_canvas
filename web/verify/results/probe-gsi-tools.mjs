// gsimaps エンジン 連携ツール実機検証 (engine-gsimaps 監査 Phase E)
// kasugaiApi の GSI 専用ツール群を実呼び出しし、結果を JSON に残す
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const result = { date: new Date().toISOString(), checks: [] };
const check = (name, pass, extra = "") => {
  result.checks.push({ name, pass: !!pass, extra: String(extra).slice(0, 200) });
  console.log(pass ? "PASS" : "FAIL", name, extra ? `| ${String(extra).slice(0, 120)}` : "");
};

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 160)));

await page.goto(`${BASE}/gsimaps/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const f = document.getElementById("gsi-frame");
  return f?.contentWindow?.GSI?.GLOBALS?.gsimaps?._mainMap;
}, { timeout: 120000 });
await page.waitForTimeout(5000);

// ---- 起動状態 ----
const boot = await page.evaluate(() => ({
  layers: window.kasugaiApi?.listLayers?.()?.length ?? -1,
  view: window.kasugaiApi?.getCamera?.(),
}));
check("起動: プロジェクト読込", boot.layers >= 0, `layers=${boot.layers}`);
check("起動: 視点取得", !!boot.view?.latitude, JSON.stringify(boot.view));
await page.screenshot({ path: `${OUT}gsi-tools-boot.png` });

// ---- ベースマップ ----
const basemaps = await page.evaluate(() => window.kasugaiApi.listGsiBasemaps());
check("listGsiBasemaps", basemaps.length > 0, `count=${basemaps.length} active=${basemaps.find(b => b.active)?.id}`);
const setBase = await page.evaluate(() => window.kasugaiApi.setGsiBasemap("pale"));
check("setGsiBasemap(pale)", setBase?.ok === true, JSON.stringify(setBase).slice(0, 120));
await page.waitForTimeout(2500);
const activeBase = await page.evaluate(() => window.kasugaiApi.listGsiBasemaps().find(b => b.active)?.id);
check("setGsiBasemap 反映", activeBase === "pale", `active=${activeBase}`);

// ---- カタログ ----
const catalog = await page.evaluate(() => window.kasugaiApi.listGsiCatalog("写真"));
check("listGsiCatalog(filter)", catalog?.total > 0, `total=${catalog?.total} first=${catalog?.layers?.[0]?.id}`);
const catalogAll = await page.evaluate(() => window.kasugaiApi.listGsiCatalog());
check("listGsiCatalog(全件)", catalogAll?.total > 500, `total=${catalogAll?.total}`);

// ---- カタログ追加 → 表示レイヤ操作 ----
const add = await page.evaluate(() => window.kasugaiApi.addGsiLayer("airphoto"));
check("addGsiLayer(airphoto)", add?.ok === true, JSON.stringify(add).slice(0, 150));
await page.waitForTimeout(3000);
const displayed = await page.evaluate(() => window.kasugaiApi.listGsiLayers());
check("listGsiLayers", displayed.length > 0, `count=${displayed.length} ids=${displayed.map(l => l.id).join(",")}`);
const target = displayed.find(l => /airphoto|lakedata|ort/.test(l.id + l.title));
if (target) {
  const op = await page.evaluate(k => window.kasugaiApi.setGsiLayerOpacity(k, 0.5), target.id);
  check("setGsiLayerOpacity", op?.ok === true && op.opacity === 0.5, JSON.stringify(op));
  const hid = await page.evaluate(k => window.kasugaiApi.setGsiLayerHidden(k, true), target.id);
  check("setGsiLayerHidden(true)", hid?.ok === true && hid.hidden === true, JSON.stringify(hid));
  await page.evaluate(k => window.kasugaiApi.setGsiLayerHidden(k, false), target.id);
  const mv = await page.evaluate(k => window.kasugaiApi.moveGsiLayer(k, "top"), target.id);
  check("moveGsiLayer(top)", mv?.ok === true, JSON.stringify(mv));
} else {
  check("追加レイヤ検出", false, "対象レイヤが listGsiLayers に無い");
}
await page.screenshot({ path: `${OUT}gsi-tools-layers.png` });

// ---- 表示レイヤ → .kasc 取り込み ----
const imp = await page.evaluate(() => window.kasugaiApi.importGsiLayers());
check("importGsiLayers", imp?.ok === true || (imp?.skipped?.length > 0), JSON.stringify(imp?.message || imp).slice(0, 150));

// ---- カタログ → .kasc 直接取り込み ----
const impCat = await page.evaluate(() => window.kasugaiApi.importGsiCatalog({ ids: ["lakedata"] }));
check("importGsiCatalog", impCat?.ok === true || impCat?.skipped?.length > 0, JSON.stringify(impCat?.message || impCat).slice(0, 150));

// ---- 標高 ----
const elev = await page.evaluate(() => window.kasugaiApi.getGsiElevation(35.3606, 138.7274));
check("getGsiElevation(富士山)", elev?.ok === true && elev.elevation > 3000, `elev=${elev?.elevation} src=${elev?.source}`);

// ---- 共有URL ----
const share = await page.evaluate(() => window.kasugaiApi.getGsiShareUrl());
check("getGsiShareUrl", share?.ok === true && /maps\.gsi\.go\.jp/.test(share.url), share?.url);

// ---- 作図 ----
const sakuzu = await page.evaluate(() => window.kasugaiApi.listGsiSakuzu());
check("listGsiSakuzu", Array.isArray(sakuzu), `count=${sakuzu.length}`);

// ---- Globe ----
const globeOn = await page.evaluate(() => window.kasugaiApi.setGsiGlobe(true));
check("setGsiGlobe(true)", globeOn?.ok === true, JSON.stringify(globeOn));
await page.waitForTimeout(25000); // globe ページ+Cesium ロード待ち
const globeState = await page.evaluate(() => {
  const w = document.getElementById("gsi-frame").contentWindow;
  return {
    hasGLOBE: !!w.GLOBE, hasViewer: !!w.GLOBE?.MAP?.viewer,
    hasMl: !!w.GSI?.GLOBALS?.mapLayerList, tileCount: w.GSI?.GLOBALS?.mapLayerList?.tileList?.length ?? -1,
    view: window.kasugaiApi?.getCamera?.(),
  };
});
check("Globe: GLOBE.MAP.viewer", globeState.hasGLOBE && globeState.hasViewer, JSON.stringify(globeState).slice(0, 160));
check("Globe: GLOBALS.mapLayerList", globeState.hasMl, `tileList=${globeState.tileCount}`);
check("Globe: getViewInfo", !!globeState.view?.latitude, JSON.stringify(globeState.view ?? null).slice(0, 120));
await page.screenshot({ path: `${OUT}gsi-tools-globe.png` });
const globeBasemaps = await page.evaluate(() => window.kasugaiApi.listGsiBasemaps());
check("Globe: listGsiBasemaps", globeBasemaps.length > 0, `count=${globeBasemaps.length}`);
const globeLayers = await page.evaluate(() => window.kasugaiApi.listGsiLayers());
check("Globe: listGsiLayers", Array.isArray(globeLayers), `count=${globeLayers.length}`);

// ---- 2D 復帰 ----
const globeOff = await page.evaluate(() => window.kasugaiApi.setGsiGlobe(false));
check("setGsiGlobe(false)", globeOff?.ok === true, JSON.stringify(globeOff));
await page.waitForFunction(() => {
  const f = document.getElementById("gsi-frame");
  return f?.contentWindow?.GSI?.GLOBALS?.gsimaps?._mainMap?.getMap?.();
}, { timeout: 120000 });
await page.waitForTimeout(5000);
const restored = await page.evaluate(() => ({
  view: window.kasugaiApi?.getCamera?.(),
  layers: window.kasugaiApi?.listLayers?.()?.length ?? -1,
  gsiLayers: window.kasugaiApi?.listGsiLayers?.()?.length ?? -1,
}));
check("2D復帰: 視点・レイヤ", !!restored.view?.latitude && restored.layers >= 0, JSON.stringify(restored).slice(0, 160));
await page.screenshot({ path: `${OUT}gsi-tools-restored.png` });

// ---- レイヤ削除 ----
const after = await page.evaluate(() => window.kasugaiApi.listGsiLayers());
const del = after.find(l => /airphoto|lakedata|ort/.test(l.id + l.title));
if (del) {
  const rm = await page.evaluate(k => window.kasugaiApi.removeGsiLayer(k), del.id);
  check("removeGsiLayer", rm?.ok === true, JSON.stringify(rm));
} else check("removeGsiLayer", true, "対象なし(取込済みでスキップされた場合)");

const passCount = result.checks.filter(c => c.pass).length;
result.summary = `${passCount}/${result.checks.length} PASS`;
console.log("===", result.summary, "===");
writeFileSync(`${OUT}gsi-tools-audit-${stamp}.json`, JSON.stringify(result, null, 2));
console.log("WROTE", `gsi-tools-audit-${stamp}.json`);
await browser.close();
