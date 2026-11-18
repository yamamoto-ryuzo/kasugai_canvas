// @map_scale / 式変数の実ブラウザ検証プローブ
// scale_test プロジェクトを各エンジンで開き、広域(分母>8000)・詳細(分母<5000)の
// 2縮尺でスクリーンショットと @map_scale 実測値を取る。
// 期待値: 広域=ポリゴン青・点1.2mm・ラベル非表示 / 詳細=ポリゴン緑・点5mm・ラベル表示
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ENGINES = process.argv[2] ? [process.argv[2]] : ["cesium", "maplibre", "openlayers", "leaflet"];
const KASC = encodeURIComponent(`${BASE}/projects/scale_test/kasugai_canvas.kasc`);
const LAT = 35.682, LNG = 139.762;
// 詳細側はポイント「両国」直上へ(ポリゴンは全点の外にあるため別中心)
const DLAT = 35.678, DLNG = 139.793;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 300)));

// 式評価の単体確認(どのエンジンでも同じ共有モジュール)
await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const exprCheck = await page.evaluate(async () => {
  const m = await import("/shared/qml-style.js");
  m.setMapScaleGetter(() => 2500);
  return {
    ifscale: m.evalQgisExpression("if(@map_scale>=5000, 1.2, 5.0)"),
    varfn: m.evalQgisExpression("var('map_scale')"),
    atvar: m.evalQgisExpression("@map_scale"),
    andor: m.evalQgisExpression("true AND NOT false OR false"),
    casewhen: m.evalQgisExpression("CASE WHEN 1>2 THEN 'a' ELSE 'b' END"),
    formatd: m.evalQgisExpression("format_date(to_date('2024-03-05'),'yyyy/MM/dd')"),
    arr: m.evalQgisExpression("array_to_string(array_distinct(array(1,2,2,3)),'-')"),
    scaleexp: m.evalQgisExpression("scale_exp(5,0,10,0,100,2)"),
  };
});
console.log("EXPR:", JSON.stringify(exprCheck));

const readScale = () => page.evaluate(async () => {
  const m = await import("/shared/qml-style.js");
  return m.evalQgisExpression("@map_scale");
});

const setWide = async () => {
  await page.evaluate(([lat, lng]) => {
    if (window.kasugaiApi?.getViewer) {
      const v = window.kasugaiApi.getViewer();
      v.camera.cancelFlight();
      v.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lng, lat, 3000),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });
      v.scene.requestRender();
    } else {
      window.kasugaiApi?.flyTo({ latitude: lat, longitude: lng, zoom: 15, instant: true });
    }
  }, [LAT, LNG]);
  await page.waitForTimeout(2200);
};

const setDetail = async () => {
  await page.evaluate(([lat, lng]) => {
    if (window.kasugaiApi?.getViewer) {
      const v = window.kasugaiApi.getViewer();
      v.camera.cancelFlight();
      v.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lng, lat, 500),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });
      v.scene.requestRender();
    } else {
      window.kasugaiApi?.flyTo({ latitude: lat, longitude: lng, zoom: 17.5, instant: true });
    }
  }, [LAT, LNG]);
  await page.waitForTimeout(2200);
};

for (const eng of ENGINES) {
  try {
    await page.goto(`${BASE}/${eng}/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, { timeout: 40000 });
    await page.waitForTimeout(4500); // レイヤ読込 + 初期フライト待ち
    await setWide();
    const wideScale = await readScale();
    await page.screenshot({ path: `${OUT}mapscale-${eng}-wide.png` });
    await setDetail();
    // 詳細はポイント直上へ移し直してから評価
    await page.evaluate(([lat, lng]) => {
      if (window.kasugaiApi?.getViewer) {
        const v = window.kasugaiApi.getViewer();
        v.camera.cancelFlight();
        v.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(lng, lat, 500),
          orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
        });
        v.scene.requestRender();
      } else {
        window.kasugaiApi?.flyTo({ latitude: lat, longitude: lng, zoom: 17.5, instant: true });
      }
    }, [DLAT, DLNG]);
    await page.waitForTimeout(2200);
    const detailScale = await readScale();
    await page.screenshot({ path: `${OUT}mapscale-${eng}-detail.png` });
    console.log(`${eng}: done wide=${Math.round(wideScale)} detail=${Math.round(detailScale)}`);
  } catch (e) {
    console.log(`${eng}: FAILED`, String(e).slice(0, 300));
  }
}
await browser.close();
console.log("probe complete");
