// 行政区域ポリゴンの N03_004 ラベルが縮尺連動するか検証
// if(@map_scale>=50000,6, if(@map_scale>=10000,10,14)) pt → 8/13.3/18.7px 期待
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/sample_qgis/kasugai_canvas.kasc`);
const ADACHI = { lat: 35.775, lng: 139.805 };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));

const labelAt = async (zoom, h) => await page.evaluate(async ([lat, lng, z, h]) => {
  if (window.kasugaiApi?.getViewer) {
    const v = window.kasugaiApi.getViewer();
    v.camera.cancelFlight();
    v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(lng, lat, h), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 } });
    v.scene.requestRender();
  } else window.kasugaiApi?.flyTo({ latitude: lat, longitude: lng, zoom: z, instant: true });
  await new Promise(r => setTimeout(r, 1800));
  const m = await import("/shared/qml-style.js");
  const qml = await (await fetch("/projects/sample_qgis/canvas_data/layer_cat.qml")).text();
  const c = m.compileQmlStyle(qml);
  const spec = c.labelFor?.({ N03_004: "足立区" });
  return { scale: Math.round(m.evalQgisExpression("@map_scale")), text: spec?.text, sizePx: spec?.sizePx, fontCss: spec?.fontCss };
}, [ADACHI.lat, ADACHI.lng, zoom, h]);

for (const eng of ["maplibre", "leaflet", "cesium"]) {
  try {
    await page.goto(`${BASE}/${eng}/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, { timeout: 60000 });
    await page.waitForTimeout(6000); // GPKG レイヤ読込待ち
    const wide = await labelAt(11, 15000);
    await page.screenshot({ path: `${OUT}adachi-${eng}-wide.png` });
    const mid = await labelAt(13.5, 5000);
    await page.screenshot({ path: `${OUT}adachi-${eng}-mid.png` });
    const detail = await labelAt(16.5, 800);
    await page.screenshot({ path: `${OUT}adachi-${eng}-detail.png` });
    console.log(`${eng}:`, JSON.stringify({ wide, mid, detail }));
  } catch (e) { console.log(`${eng}: FAILED`, String(e).slice(0, 250)); }
}
await browser.close();
console.log("done");
