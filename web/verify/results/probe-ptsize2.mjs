// if(@map_scale>=5000,1.2,5.0) の実効値を compiled.evaluate() で直接検証
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/scale_test/kasugai_canvas.kasc`);
const browser = await chromium.launch();
for (const eng of ["cesium", "maplibre", "openlayers", "leaflet"]) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", e => console.log(`[${eng} err]`, String(e).slice(0, 200)));
  try {
    await page.goto(`${BASE}/${eng}/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, { timeout: 40000 });
    await page.waitForTimeout(4000);
    const run = (zoom, h) => page.evaluate(async ([z, h]) => {
      if (window.kasugaiApi?.getViewer) {
        const v = window.kasugaiApi.getViewer();
        v.camera.cancelFlight();
        v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139.793, 35.678, h), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 } });
        v.scene.requestRender();
      } else window.kasugaiApi?.flyTo({ latitude: 35.678, longitude: 139.793, zoom: z, instant: true });
      await new Promise(r => setTimeout(r, 1800));
      const m = await import("/shared/qml-style.js");
      const qml = await (await fetch("/projects/scale_test/canvas_data/pts_scaled.qml")).text();
      const c = m.compileQmlStyle(qml);
      const spec = c.evaluate({ name: "両国" });
      return { scale: Math.round(m.evalQgisExpression("@map_scale")), sizePx: spec?.markers?.[0]?.sizePx ?? null };
    }, [zoom, h]);
    const wide = await run(15, 3000);
    const detail = await run(17.5, 500);
    console.log(`${eng}: wide(scale=${wide.scale})→sizePx=${wide.sizePx} | detail(scale=${detail.scale})→sizePx=${detail.sizePx}`);
  } catch (e) { console.log(`${eng}: FAILED`, String(e).slice(0, 250)); }
  await page.close();
}
await browser.close();
console.log("done");
