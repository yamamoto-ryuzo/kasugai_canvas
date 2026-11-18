// Navara QML 検証: DM_1(SvgMarker)で billboard url が効くか、
// d25 で extrudedHeight が設定されるか、layer 構造を調べる
import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

const base = "http://127.0.0.1:8510";
const outDir = "C:/devin/kasugai_canvas/test-results/qml-verify/shots-gaps";
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") console.log("[navara]", m.type(), m.text().slice(0, 160)); });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 250)));

// gaps.kasc: d25 extrude 確認のため斜め視点
await page.goto(`${base}/navara/?kasc=/projects/qml-verify/gaps.kasc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);
const layers = await page.evaluate(() => {
  const view = window.kascView;
  const out = [];
  const L = view?.layers ?? view?.getLayers?.() ?? [];
  const list = Array.isArray(L) ? L : (L?.values ? [...L.values()] : Object.values(L || {}));
  for (const l of list) {
    const mats = {};
    for (const k of ["polygon", "polyline", "point", "billboard", "text"]) {
      const m = l.material?.[k] ?? l[k + "Material"] ?? (l.materials ? l.materials[k] : null);
      if (m) mats[k] = { url: m.url ?? null, sizeInMeters: m.sizeInMeters ?? null,
        height: m.height ?? null, extrudedHeight: m.extrudedHeight ?? null, opacity: m.opacity ?? null };
    }
    out.push({ id: l.id ?? l.name, mats: Object.keys(mats).length ? mats : "n/a" });
  }
  return out.slice(0, 15);
});
console.log("=== navara layers ===");
console.log(JSON.stringify(layers, null, 1).slice(0, 3500));
// 斜め視点で d25 押出し確認
await page.evaluate(() => {
  const view = window.kascView;
  try { view?.setCamera?.({ latitude: 35.585, longitude: 139.615, height: 2500, pitch: -45 }); }
  catch (_) { try { view?.camera?.flyTo?.({ latitude: 35.585, longitude: 139.615, height: 2500, pitch: -45 }); } catch (_) {} }
});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outDir}/navara-tilt.png` });
console.log("navara tilt shot OK");

// DM_1: SvgMarker → billboard url
await page.goto(`${base}/navara/?project=_qml_verify`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
const dm = await page.evaluate(() => {
  const view = window.kascView;
  const out = [];
  const L = view?.layers ?? view?.getLayers?.() ?? [];
  const list = Array.isArray(L) ? L : (L?.values ? [...L.values()] : Object.values(L || {}));
  for (const l of list) {
    for (const k of ["billboard", "point"]) {
      const m = l.material?.[k] ?? l[k + "Material"] ?? (l.materials ? l.materials[k] : null);
      if (m?.url) out.push({ id: l.id ?? l.name, k, url: String(m.url).slice(-60) });
    }
  }
  return out.slice(0, 10);
});
console.log("=== navara DM_1 billboard urls ===");
console.log(JSON.stringify(dm, null, 1).slice(0, 2500));
await page.screenshot({ path: `${outDir}/navara-dm1.png` });
await browser.close();
