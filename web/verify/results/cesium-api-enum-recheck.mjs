// Cesium API 実行時再列挙(engine-cesium 監査 Phase B 再検査)
// 前回 cesium-api-enum-2026-11.json との差分を出力する
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 160)));
await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
const result = await page.evaluate(() => {
  const keys = Object.keys(Cesium);
  const props = k => { try { return Object.getOwnPropertyNames(Cesium[k].prototype).filter(n => !n.startsWith("_") && n !== "constructor"); } catch { return []; } };
  const graphics = {};
  for (const k of keys.filter(k => k.endsWith("Graphics"))) graphics[k] = props(k);
  return {
    version: Cesium.VERSION,
    exportCount: keys.length,
    exports: keys,
    graphics,
    camera: props("Camera"),
    viewer: props("Viewer"),
    scene: props("Scene"),
    globe: props("Globe"),
    tileset: props("Cesium3DTileset"),
    tileStyle: props("Cesium3DTileStyle"),
    dataSources: keys.filter(k => k.includes("DataSource")),
    imageryProviders: keys.filter(k => k.includes("ImageryProvider")),
    postProcess: (() => { try { return Object.keys(Cesium.PostProcessStageLibrary); } catch { return []; } })(),
    postProcessStage: props("PostProcessStage"),
    postProcessComposite: props("PostProcessStageComposite"),
    materials: (() => { try { return Object.keys(Cesium.Material).filter(k => k.endsWith("Type")).map(k => k.slice(0, -4)); } catch { return []; } })(),
    entityCluster: props("EntityCluster"),
    clippingPlanes: props("ClippingPlaneCollection"),
    screenSpaceCameraController: props("ScreenSpaceCameraController"),
    shadowMap: props("ShadowMap"),
    clock: props("Clock"),
    sampledProps: keys.filter(k => k.startsWith("Sampled") || k.includes("TimeInterval")),
  };
});
console.log("Cesium", result.version, "-", result.exportCount, "exports");
const prev = JSON.parse(readFileSync(`${OUT}cesium-api-enum-2026-11.json`, "utf8"));
const diff = { prevVersion: prev.version, newVersion: result.version, prevCount: prev.exportCount, newCount: result.exportCount };
const setDiff = (a, b) => ({ added: b.filter(x => !a.includes(x)), removed: a.filter(x => !b.includes(x)) });
diff.exports = setDiff(prev.exports, result.exports);
diff.graphics = {};
for (const k of new Set([...Object.keys(prev.graphics), ...Object.keys(result.graphics)])) {
  const d = setDiff(prev.graphics[k] || [], result.graphics[k] || []);
  if (d.added.length || d.removed.length) diff.graphics[k] = d;
}
diff.dataSources = setDiff(prev.dataSources, result.dataSources);
diff.imageryProviders = setDiff(prev.imageryProviders, result.imageryProviders);
diff.postProcess = setDiff(prev.postProcess, result.postProcess);
diff.materials = setDiff(prev.materials, result.materials);
diff.camera = setDiff(prev.camera, result.camera);
diff.viewer = setDiff(prev.viewer, result.viewer);
diff.scene = setDiff(prev.scene, result.scene);
diff.globe = setDiff(prev.globe, result.globe);
diff.tileset = setDiff(prev.tileset, result.tileset);
diff.screenSpaceCameraController = setDiff(prev.screenSpaceCameraController, result.screenSpaceCameraController);
diff.sampledProps = setDiff(prev.sampledProps, result.sampledProps);
writeFileSync(`${OUT}cesium-api-enum-recheck.json`, JSON.stringify({ diff, current: result }, null, 2));
console.log(JSON.stringify(diff, null, 2));
await browser.close();
