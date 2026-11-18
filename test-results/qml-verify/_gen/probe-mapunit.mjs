// MapUnit スケーラの動的検証: カメラ距離を変えて billboard.scale が追従するか
import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";

const base = "http://127.0.0.1:8510";
const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${base}/cesium/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);

const r = await page.evaluate(async () => {
  const viewer = window._viewer;
  const Cesium = window.Cesium;
  let e0 = null;
  for (let i = 0; i < viewer.dataSources.length; i++) {
    for (const e of viewer.dataSources.get(i).entities.values) {
      if (e._qmlMapUnits?.billboard != null && e.billboard) { e0 = e; break; }
    }
    if (e0) break;
  }
  if (!e0) return { err: "no entity" };
  const cam = viewer.camera;
  const c0 = cam.positionCartographic.clone();
  const getScale = () => e0.billboard.scale?.getValue?.(Cesium.JulianDate.now()) ?? e0.billboard.scale;
  const snap = async (h, waitMs) => {
    cam.setView({ destination: Cesium.Cartesian3.fromRadians(c0.longitude, c0.latitude, h) });
    await new Promise(r => setTimeout(r, waitMs));
    return { h: Math.round(cam.positionCartographic.height), s: +getScale().toFixed(4) };
  };
  const out = [];
  out.push({ h: Math.round(cam.positionCartographic.height), s: +getScale().toFixed(4), at: "init" });
  out.push(await snap(c0.height / 4, 1200));
  out.push(await snap(c0.height * 4, 1200));
  out.push(await snap(c0.height / 8, 1200));
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
