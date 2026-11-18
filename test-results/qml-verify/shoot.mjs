import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";

const engines = ["openlayers", "leaflet", "maplibre", "cesium"];
const base = "http://127.0.0.1:8510";
const out = "C:/devin/kasugai_canvas/test-results/qml-verify/shots";

const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") console.log("[console]", m.type(), m.text().slice(0, 200)); });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 300)));

for (const eng of engines) {
  const url = `${base}/${eng}/?project=qml-verify`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // レイヤロード+描画待ち(エンジン別にidle待ち)
    await page.waitForTimeout(eng === "cesium" ? 12000 : 8000);
    await page.screenshot({ path: `${out}/${eng}.png` });
    console.log(eng, "shot OK");
  } catch (e) {
    console.log(eng, "ERR", String(e).slice(0, 200));
  }
}
await browser.close();
