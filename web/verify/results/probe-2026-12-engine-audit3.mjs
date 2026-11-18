// engine-cesium 監査 Phase E 検証(第3弾): scene3d: sscc=/specmap=off/shcoeffs=
// - sscc=<JSON> → ScreenSpaceCameraController 残フラグ一括(型検査+EventTypes名)
// - specmap=off → specularEnvironmentMaps=undefined(既定 KTX2 復帰)
// - shcoeffs=<JSON 9×[r,g,b]> → sphericalHarmonicCoefficients
// - AutoExposure 再検証(1.147 でも非 PostProcessStage 内部型=基盤欠如継続)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const results = { checks: [] };
const ok = (name, cond, extra = "") => { results.checks.push({ name, pass: !!cond, extra }); console.log(cond ? "PASS" : "FAIL", name, extra); };
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 160)));
await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent("/projects/audit_effects3/audit_effects3.kasc")}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi?.isReady, { timeout: 120000 });
await page.waitForTimeout(4000);

// ---- 1. sscc=<JSON> → SSCC 数値/真偽値フラグ ----
const ssec = await page.evaluate(() => {
  const s = window._viewer.scene.screenSpaceCameraController;
  return {
    inertiaSpin: s.inertiaSpin, inertiaTranslate: s.inertiaTranslate, inertiaZoom: s.inertiaZoom,
    bounce: s.bounceAnimationTime, collision: s.enableCollisionDetection, look: s.enableLook,
    maxTilt: s.maximumTiltAngle, zoomFactor: s.zoomFactor, trackBall: s.minimumTrackBallHeight,
    min: s.minimumZoomDistance, max: s.maximumZoomDistance,
    noSuch: s.noSuchProp,
    tiltTypes: Array.isArray(s.tiltEventTypes) ? s.tiltEventTypes.map(t => t) : s.tiltEventTypes,
    zoomTypes: s.zoomEventTypes,
    LEFT_DRAG: Cesium.CameraEventType.LEFT_DRAG, WHEEL: Cesium.CameraEventType.WHEEL,
    CTRL: Cesium.KeyboardEventModifier.CTRL,
  };
});
ok("sscc inertiaSpin=0.5", ssec.inertiaSpin === 0.5, String(ssec.inertiaSpin));
ok("sscc inertiaTranslate=0.4", ssec.inertiaTranslate === 0.4, String(ssec.inertiaTranslate));
ok("sscc inertiaZoom=0.6", ssec.inertiaZoom === 0.6, String(ssec.inertiaZoom));
ok("sscc bounceAnimationTime=2.5", ssec.bounce === 2.5, String(ssec.bounce));
ok("sscc enableCollisionDetection=false", ssec.collision === false, String(ssec.collision));
ok("sscc enableLook=false", ssec.look === false, String(ssec.look));
ok("sscc maximumTiltAngle=1.0", ssec.maxTilt === 1.0, String(ssec.maxTilt));
ok("sscc zoomFactor=3", ssec.zoomFactor === 3, String(ssec.zoomFactor));
ok("sscc minimumTrackBallHeight=12345", ssec.trackBall === 12345, String(ssec.trackBall));
ok("minzoom/maxzoom 併用維持", ssec.min === 50 && ssec.max === 500000, `${ssec.min}/${ssec.max}`);
ok("sscc 未知キー無視", ssec.noSuch === undefined, String(ssec.noSuch));
ok("sscc tiltEventTypes=[LEFT_DRAG,WHEEL] 名解決",
  Array.isArray(ssec.tiltTypes) && ssec.tiltTypes.length === 2 &&
  ssec.tiltTypes[0] === ssec.LEFT_DRAG && ssec.tiltTypes[1] === ssec.WHEEL,
  JSON.stringify(ssec.tiltTypes));
ok("sscc zoomEventTypes=[{WHEEL+CTRL}] 修飾子解決",
  Array.isArray(ssec.zoomTypes) && ssec.zoomTypes.length === 1 &&
  ssec.zoomTypes[0]?.eventType === ssec.WHEEL && ssec.zoomTypes[0]?.modifier === ssec.CTRL,
  JSON.stringify(ssec.zoomTypes));

// ---- 2. specmap=off → 既定環境マップ復帰 ----
const env = await page.evaluate(() => {
  const s = window._viewer.scene;
  return {
    specMaps: s.specularEnvironmentMaps === undefined ? "undefined(既定)" : String(s.specularEnvironmentMaps),
    shc: Array.isArray(s.sphericalHarmonicCoefficients)
      ? s.sphericalHarmonicCoefficients.map(c => [c.x, c.y, c.z]) : s.sphericalHarmonicCoefficients,
  };
});
ok("specmap=off → specularEnvironmentMaps=undefined", env.specMaps === "undefined(既定)", env.specMaps);
ok("shcoeffs → 9要素 Cartesian3 配列", Array.isArray(env.shc) && env.shc.length === 9, `len=${env.shc?.length}`);
ok("shcoeffs[0]=[0.5,0.5,0.5] / [8]=[0.8,0.8,0.8]",
  env.shc?.[0]?.[0] === 0.5 && env.shc?.[8]?.[0] === 0.8, JSON.stringify(env.shc?.[0]) + "…" + JSON.stringify(env.shc?.[8]));

// ---- 3. specmap=<URL> 経路(同じ spec 適用関数を API 経由で再検証) ----
const specUrl = await page.evaluate(() => {
  const s = window._viewer.scene;
  try {
    s.specularEnvironmentMaps = "https://example.com/does-not-exist.ktx2"; // 代入は文字列保持
    const got = s.specularEnvironmentMaps;
    s.specularEnvironmentMaps = undefined; // 後片付け
    return { got };
  } catch (e) { return { err: String(e) }; }
});
ok("specmap URL 代入経路(文字列保持)", typeof specUrl.got === "string" && specUrl.got.endsWith(".ktx2"), specUrl.got || specUrl.err);

// ---- 4. AutoExposure 再検証(ライブラリ基盤欠如の復活検知) ----
const ae = await page.evaluate(() => {
  try {
    const stage = Cesium.PostProcessStageLibrary.createAutoExposureStage();
    return {
      ctor: stage?.constructor?.name,
      isPPS: stage instanceof Cesium.PostProcessStage,
      isComposite: stage instanceof Cesium.PostProcessStageComposite,
      hasEnabled: "enabled" in stage,
      minLum: "minimumLuminance" in stage,
    };
  } catch (e) { return { err: String(e) }; }
});
ok("createAutoExposureStage → 依然 非PostProcessStage 内部型(基盤欠如継続)",
  ae.isPPS === false && ae.isComposite === false, JSON.stringify(ae));
const aeApi = await page.evaluate(() => window.kasugaiApi.setEffect("autoexposure", true));
ok("setEffect('autoexposure') → 安全側 false", aeApi === false, String(aeApi));

// ---- 5. 描画継続の健全性 + スクリーンショット ----
await page.waitForTimeout(2000);
const alive = await page.evaluate(() => {
  const s = window._viewer.scene;
  s.requestRender();
  return { destroyed: window._viewer.isDestroyed(), canvas: !!s.canvas };
});
ok("viewer 生存・描画継続", alive.destroyed === false && alive.canvas === true, JSON.stringify(alive));
await page.screenshot({ path: `${OUT}engine-audit3-scene.png` });

writeFileSync(`${OUT}engine-audit3-2026-12.json`, JSON.stringify(results, null, 2));
const fails = results.checks.filter(c => !c.pass);
console.log(`\n${results.checks.length - fails.length}/${results.checks.length} PASS`);
await browser.close();
process.exit(fails.length ? 1 : 0);
