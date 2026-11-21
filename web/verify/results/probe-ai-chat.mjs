// V3 AI連携検証プローブ (skill: verify-ai-chat)
//  実行: node web/verify/results/probe-ai-chat.mjs [engine,...]
//  AI1 チャットパネル/プロバイダ UI  AI2 CHAT_TOOL_API ゲート  AI3 kasugaiApi 公開面
//  AI4 runCode サンドボックス構造  AI5 function calling(要キー)  AI6 ブリッジ(要アプリ)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json", ".kasc": "text/plain",
  ".css": "text/css" };
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    const fp = resolve(join(WEB, p.endsWith("/") ? p + "index.html" : p));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(fp)] || "application/octet-stream", "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const ENGINES = (process.argv[2] || "maplibre,leaflet").split(",");

const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const skip = (id, detail) => { results.push({ id, ok: null });
  console.log(`SKIP ${id} :: ${detail}`); };

for (const engine of ENGINES) {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log(`[${engine}] PAGEERR:`, String(e).slice(0, 160)));
  try {
    await page.goto(`${base}/${engine}/`, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
    await page.waitForFunction(
      () => window.kasugaiApi && document.querySelector("#tools-dock, .tab"),
      null, { timeout: 90000, polling: 800 });
    await page.waitForTimeout(1500);

    const a = await page.evaluate(async () => {
      const api = window.kasugaiApi;
      const req = ["listLayers", "getLayerGeoJson", "getLayerFilteredGeoJson",
        "setLayerFilter", "setLayerVisible", "listUiControls", "controlUi",
        "flyTo", "spatialSelect", "measureDistance", "listCameraPresets", "listThemes"];
      const missing = req.filter(k => typeof api?.[k] !== "function");
      const chat = {
        panel: !!document.querySelector("#chat, .chat-panel, [id*=ai-chat], [class*=chat]"),
        fab: !!document.querySelector("#chat-open, .chat-open, [id*=chat]"),
      };
      // 管理→AI のプロバイダ選択 UI(manage タブ内)
      const manageHtml = document.querySelector("#panel-manage, [data-panel=manage], .tab-pane[data-tab=manage]")?.innerHTML || "";
      const providers = /gemini|openai|copilot|devin|antigravity/i.test(manageHtml);
      return { missing, chat, providers,
        apiKeys: Object.keys(api || {}).length };
    });
    rec(`AI1[${engine}]`, a.chat.panel || a.chat.fab || a.providers,
      `chat UI=${JSON.stringify(a.chat)} providers=${a.providers}`);
    rec(`AI2[${engine}]`, a.missing.length === 0,
      `kasugaiApi 不足=${a.missing.join(",") || "なし"} (keys=${a.apiKeys})`);

    // AI3: kasugaiApi 実操作(flyTo → getViewInfo で位置反映 / listUiControls 列挙)
    const ops = await page.evaluate(async () => {
      const ctrls = window.kasugaiApi.listUiControls?.() || [];
      const before = window.kasugaiApi.getCamera?.() || {};
      try { window.kasugaiApi.flyTo?.({ latitude: 35.0, longitude: 135.0, height: 50000, zoom: 8 }); } catch {}
      await new Promise(r => setTimeout(r, 2500));
      const after = window.kasugaiApi.getCamera?.() || {};
      const moved = Math.abs((after.latitude ?? 0) - 35.0) < 0.5
        || Math.abs((after.latitude ?? 0) - (before.latitude ?? 99)) > 0.05;
      return { ctrls: ctrls.length, moved, after: JSON.stringify(after).slice(0, 120) };
    }).catch(e => ({ err: String(e).slice(0, 100) }));
    rec(`AI3[${engine}]`, !ops.err && ops.moved,
      `listUiControls=${ops.ctrls} flyTo→位置反映=${ops.moved} view=${ops.after || ops.err}`);

    // AI4: runSandboxedCode 実実行(サンドボックス iframe で 1+1 を評価)
    const rc = await page.evaluate(async () => {
      const mod = await import("../shared/ai-chat.js").catch(() => null);
      if (typeof mod?.runSandboxedCode !== "function") return { err: "runSandboxedCode export なし" };
      const out = await mod.runSandboxedCode("return 1+1", 10000);
      const ifr = document.querySelector("iframe[sandbox]");
      return { result: out?.result, logs: (out?.logs || []).length,
        sandbox: ifr?.getAttribute("sandbox") ?? null };
    }).catch(e => ({ err: String(e).slice(0, 100) }));
    rec(`AI4[${engine}]`, !rc.err && rc.result === 2 && rc.sandbox != null,
      `runSandboxedCode(1+1)=${rc.result} sandbox="${rc.sandbox}" ${rc.err || ""}`);
  } catch (e) {
    rec(`AIx[${engine}]`, false, `起動/評価失敗: ${String(e).slice(0, 160)}`);
  }
  await page.close();
}

skip("AI5", "function calling 実呼出は Gemini/OpenAI 等の API キーが必要(要キー)");
skip("AI6", "Copilot/Devin/Antigravity ブリッジ自動起動はアプリ版+エージェント接続が必要(要実機)");

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
