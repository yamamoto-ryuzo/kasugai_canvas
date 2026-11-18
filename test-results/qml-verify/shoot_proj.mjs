import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const proj = process.argv[2] || "qml-verify";
const tag = process.argv[3] || proj;
const engines = ["openlayers", "leaflet", "maplibre", "cesium"];
const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text().slice(0, 180)); });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 250)));
for (const eng of engines) {
  try {
    await page.goto(`http://127.0.0.1:8510/${eng}/?project=${proj}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(eng === "cesium" ? 12000 : 8000);
    await page.screenshot({ path: `shots/${tag}_${eng}.png` });
    console.log(eng, "OK");
  } catch (e) { console.log(eng, "ERR", String(e).slice(0, 150)); }
}
await browser.close();
