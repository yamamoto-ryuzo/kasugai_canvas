// 配布チャンネル・起動経路検証プローブ (skill: verify-channels)
//  実行: node web/verify/results/probe-channels.mjs [--no-cdn]
//  C1 ローカル登録  C2 QGIS内蔵サーバ  C3/C4 CDN stable/unstable ?kasc=
//  C5 kasc=local  C6 ZIP取込
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const skip = (id, detail) => { results.push({ id, ok: null });
  console.log(`SKIP ${id} :: ${detail}`); };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

const DATA_KASC = "https://yamamoto-ryuzo.github.io/kasugai_canvas_webGIS/default/kasugai_canvas.kasc";
const CDN = "https://yamamoto-ryuzo.github.io/kasugai-canvas-web";

// ---- C1: ローカルアプリ登録(register → id 返却 → unregister) ----
try {
  const reg = await j(await fetch("http://127.0.0.1:8510/api/projects/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "C:/devin/kasugai_canvas/web/verify/kasc-state/kasc-state.kasc" }) }));
  const ok = reg.ok === true && !!reg.id;
  if (reg.id) await fetch(`http://127.0.0.1:8510/api/projects/${reg.id}`, { method: "DELETE" }).catch(() => {});
  rec("C1", ok, `register → id=${reg.id || "-"} registered=${(reg.registered || []).join(",")}`);
} catch (e) { rec("C1", false, `register 失敗: ${String(e).slice(0, 140)}`); }

// ---- C2: QGIS 内蔵サーバ(:8089) ----
try {
  const st = await (await fetch("http://127.0.0.1:8089/live/state", { signal: AbortSignal.timeout(4000) })).json();
  const exp = await fetch("http://127.0.0.1:8089/export-data/", { signal: AbortSignal.timeout(4000) });
  rec("C2", !!st && (exp.status === 200 || exp.status === 404 || exp.status === 403),
    `/live/state ok export-data=${exp.status}`);
} catch (e) { skip("C2", `:8089 未応答(要実機): ${String(e).slice(0, 100)}`); }

// ---- C3/C4: CDN ?kasc= 実再生(Playwright・外部ネットワーク) ----
if (!process.argv.includes("--no-cdn")) {
  const { chromium } = await import(
    "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
  let browser;
  try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
  catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
  for (const ch of ["stable", "unstable"]) {
    const page = await browser.newPage();
    try {
      const url = `${CDN}/${ch}/maplibre/?kasc=${encodeURIComponent(DATA_KASC)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction(
        () => window.kasugaiApi && window.kasugaiApi.listLayers?.().length > 0,
        null, { timeout: 120000, polling: 1500 });
      const n = await page.evaluate(() => window.kasugaiApi.listLayers().length);
      rec(`C3[${ch}]`, n > 0, `CDN ${ch} maplibre → layers=${n}`);
    } catch (e) { rec(`C3[${ch}]`, false, `CDN ${ch} 読込失敗: ${String(e).slice(0, 140)}`); }
    await page.close();
  }
  await browser.close();
} else { skip("C3", "--no-cdn 指定"); skip("C4", "--no-cdn 指定"); }

skip("C5", "?kasc=local は File System Access picker が必要 → headless 不可(要実機)");
skip("C6", "ZIP/Re:Earth 取込はアップロード UI の実操作が必要(要実機)");

const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
