import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/navara/?kasc=${encodeURIComponent("/verify/navara-qml/plain.kasc")}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kascView, { timeout: 120000 });
await page.waitForTimeout(20000);
const info = await page.evaluate(() => {
  const v = window.kascView, s = v._scenes || {};
  const desc = sc => sc ? sc.children.map(c => `${c.type}#${c.name || "-"} vis=${c.visible} kids=${c.children.length}`) : null;
  return {
    keys: Object.keys(s),
    globe: desc(s.globe),
    draped: desc(s.draped),
    opaque: desc(s.opaque)?.slice(0, 10),
    transparent: desc(s.transparent),
    globeOpt: { transparent: v.globe.transparent, opacity: v.globe.opacity },
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
