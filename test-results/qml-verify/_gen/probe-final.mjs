import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
const base = "http://127.0.0.1:8510";
const outDir = "C:/devin/kasugai_canvas/test-results/qml-verify/shots-gaps";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 250)));

// 1. Navara DM_1 SvgMarker → billboard.url (寄り)
await page.goto(`${base}/navara/?project=_qml_verify`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(14000);
await page.evaluate(() => window.kascView.setCamera({ lng: 139.7358, lat: 35.6410, height: 1200, pitch: -50, heading: 0 }));
await page.waitForTimeout(3500);
await page.screenshot({ path: `${outDir}/navara-dm1-close.png` });
console.log("navara dm1 close OK");

// 2. MapLibre rasterline line-pattern 寄り
await page.goto(`${base}/maplibre/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
await page.evaluate(() => {
  window.kascMap.jumpTo({ center: [139.62, 35.572], zoom: 13.5 });
});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outDir}/maplibre-rasterline.png` });
// pattern 画像が登録されているか
const imgs = await page.evaluate(() => window.kascMap.listImages());
console.log("ml images:", JSON.stringify(imgs));

// 3. MapLibre DM_3 HashLine 装飾レイヤ確認
await page.goto(`${base}/maplibre/?project=_qml_verify`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);
const hl = await page.evaluate(() => {
  const st = window.kascMap.getStyle();
  const decor = st.layers.filter(l => /decor/i.test(l.id));
  const syms = st.layers.filter(l => l.type === "symbol" && l.layout?.["symbol-placement"] === "line");
  return { decor: decor.map(l => l.id), lineSyms: syms.map(l => ({ id: l.id, icon: l.layout?.["icon-image"] })) };
});
console.log("ml hashline layers:", JSON.stringify(hl).slice(0, 1500));
await page.evaluate(() => { window.kascMap.jumpTo({ center: [139.7358, 35.6435], zoom: 14 }); });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outDir}/maplibre-dm3.png` });
console.log("ml dm3 OK");
await browser.close();
