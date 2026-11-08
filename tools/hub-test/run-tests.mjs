// issue #89: bridge-hub 依存パス回帰検証 (mock hub + Playwright)
//   npm install && node run-tests.mjs     : モック(8511)+Playwright スイート
//   node run-tests.mjs --smoke [exe path] : 実 bridge-hub.exe --serve スモーク
// 成果物: %TEMP%/kasugai-hub-test。8511 占有は AGENTS.md ルールで一時停止。
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path"; import fs from "node:fs"; import os from "node:os";
const D = path.dirname(fileURLToPath(import.meta.url)), R = path.resolve(D, "../..");
const H = "http://127.0.0.1:8511", W = 8521, OUT = path.join(os.tmpdir(), "kasugai-hub-test");
const sl = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u, ms = 1500) => { try { return await fetch(u, { signal: AbortSignal.timeout(ms) }); } catch { return null; } };
const free = () => { try { const o = execSync("netstat -ano | findstr :8511 | findstr LISTENING", { encoding: "utf8" }); for (const p of new Set(o.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()))) if (p && p !== "0") try { execSync(`taskkill /F /PID ${p}`); } catch {} } catch {} };
const up = async (ms) => { const e = Date.now() + ms; while (Date.now() < e) { const r = await get(H + "/health", 900); if (r && r.ok) return r.json(); await sl(300); } return null; };
if (process.argv.includes("--smoke")) {
  const i = process.argv.indexOf("--smoke"), L = process.env.LOCALAPPDATA || "";
  const exe = [process.argv[i + 1], process.env.BRIDGE_HUB_EXE, path.join(L, "kasugai/bridge-hub/bridge-hub.exe"), path.join(R, "web/download/bridge-hub.exe")].find((p) => p && p.endsWith(".exe") && fs.existsSync(p));
  if (!exe) { console.error("bridge-hub.exe not found"); process.exit(2); }
  console.log("exe:", exe); free();
  const c = spawn(exe, ["--serve"], { stdio: "ignore", windowsHide: true });
  const h = await up(20000);
  let ok = !!h && h.hub === true;
  console.log("/health:", JSON.stringify(h));
  const r = await get(H + "/vector/status", 3000);
  ok = ok && !!r && r.ok;
  console.log("/vector/status:", r && r.status);
  try { c.kill(); } catch {}
  console.log(ok ? "SMOKE PASS" : "SMOKE FAIL"); process.exit(ok ? 0 : 1);
}
const { chromium } = await import("playwright-core");
fs.mkdirSync(OUT, { recursive: true });
const res = [], ck = (n, ok, i = "") => { res.push({ n, ok, i }); console.log(`${ok ? "PASS" : "FAIL"} ${n} ${i}`); };
let mock = null;
const mstart = async () => { mock = spawn(process.execPath, [path.join(D, "mock-hub.mjs")], { stdio: "ignore" }); if (!(await up(9000))) throw new Error("mock start failed"); };
const mstop = async () => { if (mock) { mock.kill(); mock = null; } await sl(400); };
const scen = async (s) => { const r = await fetch(H + "/__scenario", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: s }) }); if (!r.ok) throw new Error("scen " + s); };
const M = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".zip": "application/zip", ".svg": "image/svg+xml" };
const web = http.createServer((q, s) => {
  const p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  const f = p.endsWith("/download/bridge-hub.zip") ? path.join(R, "web/download/bridge-hub.zip") : path.normalize(path.join(R, p));
  if (!f.startsWith(R) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { "content-type": M[path.extname(f).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => web.listen(W, "127.0.0.1", r));
let b = null;
for (const c of ["chrome", "msedge"]) { try { b = await chromium.launch({ channel: c, headless: true }); break; } catch {} }
if (!b) b = await chromium.launch({ headless: true });
const pg = await (await b.newContext({ acceptDownloads: true })).newPage();
pg.on("pageerror", (e) => console.log("[pageerror]", e.message));
const PG = `http://127.0.0.1:${W}/tools/hub-test/harness.html`, LU = H + "/vector/geojson/mock_points";
const load = async () => { await pg.goto(PG); await pg.waitForFunction("window.__ready===true"); };
const diag = async (n, u, x) => { const m = await pg.evaluate(async (y) => (await window.__hubDiag({ url: y }, new Error("boom"))).message, u); ck("diag:" + n, m.includes(x), m.slice(0, 90)); };
const prb = async (n, t, f) => { const r = await pg.evaluate(async (y) => (await window.__aiChat(y)).probeWebgisHub(), t); ck("probe:" + n, f(r), r ? JSON.stringify({ v: r.version, hv: r.hasVector }) : "null"); };
const ui = async (n, t, x, o) => {
  await load();
  const e = await pg.evaluate(async (y) => { try { (await window.__aiChat(y)).setupAiSettings(); } catch (z) { return String(z); } const s = document.querySelector("#chat-provider"); s.value = "copilot"; s.dispatchEvent(new Event("change", { bubbles: true })); return null; }, t);
  if (e) ck(`ui:${n}:setup`, false, e.slice(0, 110));
  try { await pg.waitForFunction((z) => document.querySelector("#copilot-endpoint-status")?.textContent.includes(z), x, { timeout: 15000 }); ck(`ui:${n}:status`, true); }
  catch { const t2 = await pg.evaluate("document.querySelector('#copilot-endpoint-status')?.textContent||''"); ck(`ui:${n}:status`, false, `got "${t2.slice(0, 100)}"`); }
  const h = await pg.evaluate("document.querySelector('#bridge-hub-note')?.hidden");
  ck(`ui:${n}:note`, o.note ? h === false : h !== false, "hidden=" + h);
  if (o.dl) { const p = pg.waitForEvent("download", { timeout: 6000 }).catch(() => null); await pg.click("#bridge-hub-install"); const d = await p; ck(`ui:${n}:download`, !!d && d.suggestedFilename() === "bridge-hub.zip", d ? d.suggestedFilename() : "no event"); }
  await pg.screenshot({ path: path.join(OUT, o.shot) });
};
try {
  free(); await mstart(); await load();
  await scen("normal");
  await prb("normal", 1, (r) => !!r && r.hasVector === true && typeof r.version === "string");
  await diag("normal", LU, "boom");
  await scen("old");
  await prb("old", 2, (r) => !!r && r.version === null && r.hasVector === false);
  await diag("old", LU, "outdated");
  await scen("noduckdb"); await diag("noduckdb", LU, "duckdb");
  await scen("nosource"); await diag("nosource", H + "/vector/geojson/mock_missing", "mock_missing");
  await scen("nothub");
  await prb("nothub", 3, (r) => r === null);
  await diag("nothub", LU, "occupied");
  await mstop();
  await prb("down", 4, (r) => r === null);
  await diag("down", LU, "not running");
  await mstart(); await scen("normal");
  await ui("normal", 11, "Bridge connected", { note: false, shot: "ui-normal.png" });
  await scen("old");
  await ui("old", 12, "outdated", { note: true, dl: true, shot: "ui-old.png" });
  await scen("nothub");
  await ui("nothub", 13, "Cannot reach", { note: true, shot: "ui-nothub.png" });
  await mstop();
  await ui("down", 14, "Cannot reach", { note: true, shot: "ui-down.png" });
} finally { await mstop().catch(() => {}); await b.close().catch(() => {}); web.close(); }
const f = res.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ at: new Date().toISOString(), res }, null, 2));
console.log(`${res.length - f.length}/${res.length} passed. artifacts: ${OUT}`);
process.exit(f.length ? 1 : 0);
