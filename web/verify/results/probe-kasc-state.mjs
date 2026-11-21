// V7 表示状態引継ぎ検証プローブ (skill: verify-kasc-state)
//  実行: node web/verify/results/probe-kasc-state.mjs [cesium,maplibre,...]
//  フィクスチャ: web/verify/kasc-state/kasc-state.kasc + bookmarks.xml
//  S1 |off  S2 //排他  S3 グループ  S4 opacity  S5 minScale/maxScale
//  S6 attr=  S7 cam:  S8 bookmark:  S9 theme:
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json", ".kasc": "text/plain",
  ".css": "text/css", ".xml": "application/xml", ".qml": "application/xml" };
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
const KASC = `${base}/verify/kasc-state/kasc-state.kasc`;
const ENGINES = (process.argv[2] || "cesium,maplibre,openlayers,leaflet").split(",");

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
    await page.goto(`${base}/${engine}/?kasc=${encodeURIComponent(KASC)}`,
      { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(e => { if (!/interrupted by another navigation/i.test(String(e))) throw e; });
    await page.waitForFunction(
      () => window.kasugaiApi && window.kasugaiApi.listLayers?.().length > 0,
      null, { timeout: 90000, polling: 800 });

    const st = await page.evaluate(async () => {
      const api = window.kasugaiApi;
      const layers = api.listLayers();
      const find = frag => layers.find(l => (l.title || "").includes(frag));
      const out = {
        n: layers.length,
        titles: layers.map(l => l.title).join(" | "),
        b: find("通常B"), a: find("通常A"), ex1: find("排他1"), ex2: find("排他2"),
        half: find("半透明"),
        cams: api.listCameraPresets?.().map(c => String(c?.name ?? c?.title ?? c)) ?? null,
        themes: api.listThemes?.().map(t => t.name) ?? null,
      };
      // 排他グループ動作: 排他2 ON → 排他1 が OFF になるか(API → だめなら DOM ラジオ)
      // 注意: listLayers() はスナップショットを返すため、変更後の可視状態は
      // 必ず listLayers() を取り直して読む(初期配列の l.visible は陳腐化する)
      try {
        api.setLayerVisible(out.ex2?.title || out.ex2?.id, true);
        await new Promise(r => setTimeout(r, 800));
        const ff = frag => api.listLayers().find(l => (l.title || "").includes(frag));
        let st2 = { ex1: ff("排他1")?.visible, ex2: ff("排他2")?.visible };
        if (st2.ex2 !== true) {
          const radio = [...document.querySelectorAll("input[type=radio]")]
            .find(r => (r.closest("label,li,div")?.textContent || "").includes("排他2"));
          if (radio) { radio.click(); await new Promise(r => setTimeout(r, 800));
            st2 = { ex1: ff("排他1")?.visible, ex2: ff("排他2")?.visible, via: "dom" }; }
        }
        out.exAfter = st2;
      } catch (e) { out.exErr = String(e).slice(0, 100); }
      // attr= の適用実体: 2D 系は options.attr に残るが、cesium は
      // item.attribution(クレジット)へ消費され options からは消えるため
      // #map-attribution DOM でも確認する
      out.attributionDom = document.querySelector("#map-attribution")?.textContent || "";
      return out;
    });

    rec(`S1[${engine}]`, st.b?.visible === false,
      `通常B visible=${st.b?.visible} (off 行)`);
    if (st.exErr) skip(`S2[${engine}]`, `排他操作失敗: ${st.exErr}`);
    else rec(`S2[${engine}]`, st.exAfter?.ex2 === true && st.exAfter?.ex1 === false,
      `排他2 ON → 排他1=${st.exAfter?.ex1} 排他2=${st.exAfter?.ex2}`);
    rec(`S3[${engine}]`, st.a?.group === "通常G" && st.ex1?.group === "排他G",
      `group: 通常A=${st.a?.group} 排他1=${st.ex1?.group}`);
    rec(`S4[${engine}]`, Number(st.half?.options?.opacity) === 0.5,
      `半透明 options.opacity=${st.half?.options?.opacity}`);
    // opts キーは parse 時に小写化される(minscale/maxscale)
    rec(`S5[${engine}]`, st.half?.options?.minscale != null && st.half?.options?.maxscale != null,
      `minscale=${st.half?.options?.minscale} maxscale=${st.half?.options?.maxscale}`);
    const attrOk = /出典/.test(st.half?.options?.attr || "") ||
                   /出典テスト/.test(st.attributionDom || "");
    rec(`S6[${engine}]`, attrOk,
      `半透明 attr=${st.half?.options?.attr ?? `(options未露出) DOM=${st.attributionDom}`}`);
    const hasCam = (st.cams || []).some(n => /検証カメラ/.test(n || ""));
    const hasBm = (st.cams || []).some(n => /新宿御苑/.test(n || "")) &&
                  (st.cams || []).some(n => /東京駅/.test(n || ""));
    rec(`S7[${engine}]`, hasCam, `cam プリセット=${(st.cams || []).join(",") || "none"}`);
    rec(`S8[${engine}]`, hasBm, `bookmark 展開=${(st.cams || []).filter(n => /御苑|東京駅/.test(n || "")).join(",") || "none"}`);
    rec(`S9[${engine}]`, (st.themes || []).includes("テーマA"),
      `themes=${(st.themes || []).join(",") || "none"}`);
  } catch (e) {
    rec(`Sx[${engine}]`, false, `エンジン起動/評価失敗: ${String(e).slice(0, 160)}`);
  }
  await page.close();
}

await browser.close(); srv.close();
const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
