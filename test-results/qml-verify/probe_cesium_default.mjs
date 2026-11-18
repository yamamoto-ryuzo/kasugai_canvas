import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://127.0.0.1:8510/cesium/?project=qml-verify-2", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(22000);
const out = await page.evaluate(() => {
  const v = window.kasugaiApi?.getViewer?.();
  const C = v ? window.Cesium : null;
  const res = { labels: [], camera: null };
  const wgs = v.camera.positionCartographic;
  res.camera = { lat: wgs.latitude * 180 / Math.PI, lng: wgs.longitude * 180 / Math.PI, h: wgs.height };
  v.dataSources?._dataSources?.forEach(ds => ds.entities.values.forEach(e => {
    const l = e.label;
    if (!l) return;
    const pos = e.position?.getValue?.(Cesium.JulianDate.now());
    let win = null;
    try { win = pos ? Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, pos) : null; } catch (_) {}
    res.labels.push({
      text: l.text?.getValue?.() ?? null,
      show: l.show?.getValue ? l.show.getValue() : l.show,
      ddc: l.distanceDisplayCondition?.getValue ? String(l.distanceDisplayCondition.getValue()) : null,
      win: win ? [Math.round(win.x), Math.round(win.y)] : null,
      disableDepth: l.disableDepthTestDistance?.getValue?.() ?? null,
    });
  }));
  return res;
});
console.log(JSON.stringify(out, null, 1));
await page.screenshot({ path: "shots/lbl_cesium_default.png" });
await browser.close();
