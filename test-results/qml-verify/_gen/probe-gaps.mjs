// QML ギャップ実装の実機検証: 5 エンジンで gaps.kasc を読み込み、
// コンソールエラー/警告・レイヤ状態・スクリーンショットを取得する
import { chromium } from "../../../tools/hub-test/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

const engines = ["openlayers", "leaflet", "maplibre", "navara", "cesium"];
const base = "http://127.0.0.1:8510";
const outDir = "C:/devin/kasugai_canvas/test-results/qml-verify/shots-gaps";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = {};
for (const eng of engines) logs[eng] = [];

page.on("console", m => {
  const t = m.type();
  if (t === "error" || t === "warning") {
    const eng = page.url().split("/")[3] || "?";
    logs[eng]?.push(`[${t}] ${m.text().slice(0, 180)}`);
  }
});
page.on("pageerror", e => {
  const eng = page.url().split("/")[3] || "?";
  logs[eng]?.push(`[pageerror] ${String(e).slice(0, 250)}`);
});

for (const eng of engines) {
  const url = `${base}/${eng}/?kasc=/projects/qml-verify/gaps.kasc`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(eng === "cesium" ? 12000 : eng === "navara" ? 10000 : 8000);
    await page.screenshot({ path: `${outDir}/${eng}.png` });
    console.log(eng, "shot OK");
  } catch (e) {
    console.log(eng, "ERR", String(e).slice(0, 200));
  }
}
console.log("===== console logs =====");
for (const eng of engines) {
  const uniq = [...new Set(logs[eng])];
  console.log(`--- ${eng} (${uniq.length})`);
  for (const l of uniq.slice(0, 25)) console.log("   ", l);
}
await browser.close();
