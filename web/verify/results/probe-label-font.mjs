import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const KASC = encodeURIComponent(`${BASE}/projects/sample_qgis/kasugai_canvas.kasc`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`${BASE}/leaflet/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi && window.kasugaiApi.isReady !== false, { timeout: 90000 });
await page.waitForTimeout(6000);
await page.evaluate(() => window.kasugaiApi.setBasemap("ベースマップなし"));
for (const [name, zoom] of [["wide", 11], ["mid", 13.5], ["detail", 16.5]]) {
  await page.evaluate(z => window.kasugaiApi.flyTo({ latitude: 35.775, longitude: 139.805, zoom: z, instant: true }), zoom);
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".leaflet-tooltip")].find(x => /足立区/.test(x.textContent || ""));
    if (!t) return null;
    const leaf = t.querySelector("*") || t;
    return {
      outerFont: getComputedStyle(t).font,
      innerTag: leaf.tagName, innerFont: getComputedStyle(leaf).font,
      innerStyle: leaf.getAttribute("style")?.slice(0, 200),
      cls: t.className,
    };
  });
  console.log(name, JSON.stringify(info, null, 1));
}
await browser.close();
