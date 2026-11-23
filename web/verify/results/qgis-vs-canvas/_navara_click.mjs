// navara inverted 層のクリック検証: 地物位置(穴)とマスク領域で featureClick/click の発火と挙動を確認
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 900, height: 700 } });
const logs = [];
pg.on("console", m => { const t = m.text(); if (t.includes("[verify-")) logs.push(t); });
pg.on("pageerror", e => logs.push("PAGEERROR " + e));
await pg.goto("http://127.0.0.1:8520/navara/?project=_qml_verify", { waitUntil: "domcontentloaded", timeout: 30000 });
await pg.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0, undefined, { timeout: 90000, polling: 800 }).catch(() => {});
await pg.waitForTimeout(6000);
await pg.evaluate(async () => {
  const api = window.kasugaiApi;
  for (const l of api.listLayers()) {
    const t = String(l.title || l.id || "");
    if (t !== "qmltest_ren_inverted") api.setLayerVisible(t, false);
  }
  api.setLayerVisible("qmltest_ren_inverted", true);
});
await pg.waitForTimeout(1000);
const clickAt = async (lng, lat, label) => {
  await pg.evaluate(async ({ lng, lat }) => {
    try { window.kasugaiApi.flyTo?.({ latitude: lat, longitude: lng, height: 15000 }); } catch (_) {}
  }, { lng, lat });
  await pg.waitForTimeout(4500);
  logs.push(`--- CLICK ${label} (${lng},${lat}) ---`);
  await pg.mouse.click(450, 350);
  await pg.waitForTimeout(1500);
  const attr = await pg.evaluate(() => document.querySelector("#attr-content")?.innerText?.slice(0, 200) || "(empty)");
  logs.push(`attr: ${attr.replace(/\n+/g, " | ")}`);
};
await clickAt(139.725, 35.705, "hole/feature");
await clickAt(139.845, 35.756, "mask-region");
console.log(logs.join("\n"));
await browser.close();
