// if(@map_scale>=5000,1.2,5.0) の実効サイズ検証:
// 両国(139.793,35.678)中心で denom~6000(小:1.2mm)と~2500(大:5mm)をクリップ比較
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/scale_test/kasugai_canvas.kasc`);
const LAT = 35.678, LNG = 139.793;
const browser = await chromium.launch();
for (const eng of ["cesium", "maplibre", "openlayers", "leaflet"]) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", e => console.log(`[${eng} err]`, String(e).slice(0, 200)));
  try {
    await page.goto(`${BASE}/${eng}/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, { timeout: 40000 });
    await page.waitForTimeout(4000);
    const setView = (z, h) => page.evaluate(([lat, lng, z, h]) => {
      if (window.kasugaiApi?.getViewer) {
        const v = window.kasugaiApi.getViewer();
        v.camera.cancelFlight();
        v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(lng, lat, h), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 } });
        v.scene.requestRender();
      } else window.kasugaiApi?.flyTo({ latitude: lat, longitude: lng, zoom: z, instant: true });
    }, [LAT, LNG, z, h]);
    // ラベルがマーカーを隠さないよう、点を画面中央やや下にずらす=中心を点の北へ
    const shift = 0.0018;
    await setView(eng === "cesium" ? null : 16.2, eng === "cesium" ? 1200 : null).then(() =>
      page.evaluate(([d]) => {
        if (window.kasugaiApi?.getViewer) { const v = window.kasugaiApi.getViewer(); v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139.793, 35.678 + d, 1200), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 } }); }
        else window.kasugaiApi?.flyTo({ latitude: 35.678 + d, longitude: 139.793, zoom: 16.2, instant: true });
      }, [shift]));
    await page.waitForTimeout(2200);
    const s1 = await page.evaluate(async () => (await import("/shared/qml-style.js")).evalQgisExpression("@map_scale"));
    await page.screenshot({ path: `${OUT}ptsize-${eng}-small.png`, clip: { x: 400, y: 350, width: 300, height: 250 } });
    await page.evaluate(([d]) => {
      if (window.kasugaiApi?.getViewer) { const v = window.kasugaiApi.getViewer(); v.camera.cancelFlight(); v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139.793, 35.678 + d, 500), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 } }); v.scene.requestRender(); }
      else window.kasugaiApi?.flyTo({ latitude: 35.678 + d, longitude: 139.793, zoom: 17.5, instant: true });
    }, [shift]);
    await page.waitForTimeout(2200);
    const s2 = await page.evaluate(async () => (await import("/shared/qml-style.js")).evalQgisExpression("@map_scale"));
    await page.screenshot({ path: `${OUT}ptsize-${eng}-big.png`, clip: { x: 400, y: 350, width: 300, height: 250 } });
    console.log(`${eng}: small@scale=${Math.round(s1)} big@scale=${Math.round(s2)}`);
  } catch (e) { console.log(`${eng}: FAILED`, String(e).slice(0, 250)); }
  await page.close();
}
await browser.close();
console.log("done");
