import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") errs.push(m.text().slice(0,250)); });
page.on("pageerror", e => errs.push("PAGEERR " + String(e).slice(0,300)));
await page.goto("http://127.0.0.1:8510/cesium/?project=qml-verify-2", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
const out = await page.evaluate(async () => {
  try {
    const vl = await import("/shared/vector-load.js");
    const r = await vl.loadVectorItem(
      { type: "flatgeobuf", title: "t", url: "canvas_data/trim_line.fgb" },
      "http://127.0.0.1:8510/projects/qml-verify-2/", null);
    return { ok: true, feats: r.geojson?.features?.length,
             keys: Object.keys(vl) };
  } catch (e) { return { ok: false, err: String(e).slice(0,300) }; }
});
console.log("loadVectorItem fgb:", JSON.stringify(out).slice(0,500));
console.log("console:", errs.slice(0,20));
await browser.close();
