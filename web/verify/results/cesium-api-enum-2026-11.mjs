// Cesium 1.147.0 API 実行時列挙(engine-cesium 監査 Phase B)
// 出力: cesium-api-enum-2026-11.json
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
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
    tilesetStyle: props("Cesium3DTileStyle"),
    clippingPlanes: props("ClippingPlaneCollection"),
    screenSpaceCameraController: props("ScreenSpaceCameraController"),
    shadowMap: props("ShadowMap"),
    clock: props("Clock"),
    sampledProps: keys.filter(k => k.startsWith("Sampled") || k.includes("TimeInterval")),
  };
});
console.log("Cesium", result.version, "-", result.exportCount, "exports");
writeFileSync(`${OUT}cesium-api-enum-2026-11.json`, JSON.stringify(result, null, 2));
console.log("WROTE cesium-api-enum-2026-11.json");
await browser.close();
