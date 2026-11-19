// issue #121 検証: cesium 起動時に autoConnectQgis() が走り
// /api/qgis-live/discover が発火するか確認する（QGIS 未起動でも discover は飛ぶ）
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = "http://127.0.0.1:8510";
const prof = join(os.tmpdir(), "kasc-probe-profile-cesium-autoconnect");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
const liveReqs = [];
page.on("request", r => { const u = r.url();
  if (u.includes("qgis-live")) liveReqs.push(r.method() + " " + u); });
page.on("pageerror", e => console.log("PAGEERR", String(e).slice(0, 160)));
try {
  await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const deadline = Date.now() + 40000;
  let hit = false;
  while (Date.now() < deadline && !hit) {
    hit = liveReqs.some(u => u.includes("/api/qgis-live/discover"));
    if (!hit) await page.waitForTimeout(2000);
  }
  console.log("LIVE_REQS", JSON.stringify(liveReqs.slice(0, 12)));
  console.log(hit ? "PASS cesium.auto_connect_discover"
                  : "FAIL cesium.auto_connect_discover");
  await page.screenshot({ path: join(OUT, "probe-2026-11-15-cesium-autoconnect.png") });
  process.exitCode = hit ? 0 : 1;
} catch (e) {
  console.log("FAIL fatal", String(e).slice(0, 300));
  process.exitCode = 1;
}
await ctx.close().catch(() => {});
