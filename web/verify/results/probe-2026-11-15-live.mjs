// shared/ 差分検証 (2026-11-15)
//  - 3d8a191: QGIS Live 検出を shared/qgis-ogr.js へ統合 + 起動時自動接続
//  - 5b6f614: Live パネルのコンパクト行レイアウト(.layer-row同等)
// 対象: 起動中のローカルアプリ http://127.0.0.1:8510/cesium/
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");
const OUT = fileURLToPath(new URL("./", import.meta.url));
const BASE = "http://127.0.0.1:8510";
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const prof = join(os.tmpdir(), "kasc-probe-profile-live-diff");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
page.setDefaultTimeout(90000);
const liveReqs = [];
page.on("request", r => { const u = r.url();
  if (u.includes("qgis-live") || u.includes("/mcp")) liveReqs.push(r.method() + " " + u); });
page.on("pageerror", e => console.log("PAGEERR", String(e).slice(0, 160)));

try {
  await page.goto(`${BASE}/maplibre/`, { waitUntil: "domcontentloaded", timeout: 120000 });
  // 起動シーケンス完了 + autoConnectQgis の初回試行(discover→mcp)を待つ
  const deadline = Date.now() + 120000;
  let st = null;
  while (Date.now() < deadline) {
    st = await page.evaluate(() => ({
      title: document.title,
      livePanel: !!document.querySelector("#live-panel"),
      rows: [...document.querySelectorAll("#live-panel label")].map(el => ({
        display: getComputedStyle(el).display,
        spanNowrap: getComputedStyle(el.querySelector("span") || el).whiteSpace,
        cbW: el.querySelector("input")?.style.width,
        cbMinH: el.querySelector("input")?.style.minHeight,
      })),
      qgisStatus: document.querySelector("#qgis-status")?.textContent || null,
    })).catch(() => null);
    const hitMcp = liveReqs.some(u => u.includes("/api/qgis-live/mcp") ||
      u.includes("/api/qgis-live/discover"));
    if (st && st.livePanel && hitMcp) break;
    await page.waitForTimeout(4000);
  }
  console.log("LIVE_REQS", JSON.stringify(liveReqs.slice(0, 12)));
  console.log("STATE", JSON.stringify(st, null, 1));
  rec("cesium.boot", !!st && !!st.title, `title=${st?.title}`);

  // live panel コンパクト行
  const rowsOk = st?.rows?.length > 0 &&
    st.rows.every(r => r.display === "flex" &&
      r.spanNowrap === "nowrap" && r.cbW === "15px");
  rec("web.shared.live-panel.compact_rows", !!rowsOk,
    `rows=${st?.rows?.length} detail=${JSON.stringify(st?.rows?.[0])}`);

  // 起動時自動接続: discover 呼出 + mcp リレー呼出(initialize/tools/list)
  const dHit = liveReqs.some(u => u.includes("/api/qgis-live/discover"));
  const mHit = liveReqs.some(u => u.includes("/api/qgis-live/mcp"));
  rec("web.shared.ai-chat.auto_connect_discover", dHit,
    `discover=${dHit} reqs=${liveReqs.length}`);
  rec("web.shared.ai-chat.auto_connect_mcp", mHit,
    `mcp=${mHit}`);
} catch (e) {
  rec("fatal", false, String(e).slice(0, 400));
}
writeFileSync(join(OUT, "probe-2026-11-15-live-results.json"),
  JSON.stringify({ results, liveReqs }, null, 1));
await ctx.close().catch(() => {});
const fails = results.filter(r => !r.ok).length;
console.log(`DONE ${results.length - fails}/${results.length} pass`);
process.exit(fails ? 1 : 0);
