// canvas+webview+import 連携プローブ (verify-webview-import)
// geo_webview の GET /kasugai → KASUGAI Canvas 登録+switchProject →
// 各エンジン再生までの「取り込み」経路全体と、Canvas 側 qgis-import
// プラグインボタン経路を検証する。
// usage: node probe-webview-import.mjs [engine,...] [canvasBase] [qgisBase]
//   既定: cesium http://127.0.0.1:8510 http://127.0.0.1:8089
//   実機不在時は exit 2 (未検証(要実機))
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");

const engines = (process.argv[2] || "cesium").split(",");
const CANVAS = process.argv[3] || "http://127.0.0.1:8510";
const QGIS = process.argv[4] || "http://127.0.0.1:8089";
const FIXTURE = "C:/devin/kasugai_canvas/web/verify/webview-import/plugin_fixture.kasc";

let pass = 0, fail = 0, total = 0;
const ok = (cond, name, extra = "") => {
  total++;
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const note = msg => console.log(`  NOTE ${msg}`);
// 既知の環境ノイズ(検証対象外)
const NOISE = /favicon|ui\.config\.json|:8585|\/api\/mcp|net::ERR_CONNECTION_REFUSED/;
// .kasc 上で「表示状態を持たない」非レイヤ行タイプ
// base: はレイヤ一覧(listLayers)に出ずベースマップ選択側へ行くため
// | off 突合の対象外とする
const NON_LAYER = new Set(["cam", "background", "info", "legend", "theme",
  "base", "bookmark", "cloud", "plugin", "yahooappid", "title", "group",
  "terrain", "scene3d", "light", "fly_geojson", "live", "view", "html",
  "portal", "link", "dash", "form", "news", "search", "legendnode",
  "default_style", "defaultstyle"]);

async function getJson(url, timeoutMs = 180000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
    const text = await res.text();
    try { return { http: res.status, json: JSON.parse(text) }; }
    catch { return { http: res.status, json: null, text: text.slice(0, 300) }; }
  } catch (e) {
    return { http: 0, json: null, error: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

// エクスポートされた .kasc を読み、行タイプ集計・レイヤ行・| off タイトルを取る。
// geojson: 行は canvas_data/ の実ファイル地物数も数えて Canvas 側との突合に使う
function readKasc(dir) {
  try {
    const f = fs.readdirSync(dir).find(x => x.toLowerCase().endsWith(".kasc"));
    if (!f) return null;
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const types = {}, offTitles = [], layerRows = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const sep = line.indexOf(":");
      if (sep < 0) continue;
      const type = line.slice(0, sep).trim().toLowerCase();
      const fields = line.slice(sep + 1).split("|").map(s => s.trim());
      types[type] = (types[type] || 0) + 1;
      if (NON_LAYER.has(type)) continue;
      const title = fields[0] || "";
      const leaf = title.split("/").pop().trim();
      const off = fields.slice(2).some(p => /^(off|false)$/i.test(p));
      if (off) offTitles.push(leaf);
      const row = { type, title, leaf, url: fields[1] || "", off };
      // geojson: 行はエクスポート済みファイルの地物数を正本として数える
      if (type === "geojson" && row.url && !/^https?:/i.test(row.url)) {
        try {
          const gj = JSON.parse(
            fs.readFileSync(path.join(dir, row.url), "utf8"));
          row.fileFeatures = Array.isArray(gj.features) ? gj.features.length : 0;
        } catch { row.fileFeatures = null; }
      }
      layerRows.push(row);
    }
    return { file: path.join(dir, f), text, types, offTitles, layerRows };
  } catch { return null; }
}

// ---------- P0: 前提 ----------
console.log("== P0 前提 ==");
const live = await getJson(`${QGIS}/live/state`, 10000);
if (!live.json?.ok) {
  console.log(`QGIS geo_webview (:8089) 未検出 — 未検証(要実機) ${live.error || live.http}`);
  process.exit(2);
}
const caps = await getJson(`${CANVAS}/api/capabilities`, 10000);
if (!caps.json) {
  console.log(`KASUGAI Canvas (:8510) 未検出 — 未検証(要実機) ${caps.error || caps.http}`);
  process.exit(2);
}
console.log("  QGIS geo_webview :8089 / KASUGAI Canvas :8510 稼働中");

const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(
  () => chromium.launch({ channel: "msedge", headless: true }));

// ---------- W1-W3: /kasugai エンドポイント × エンジン ----------
const exported = {}; // engine -> {res, kasc}
for (const eng of engines) {
  console.log(`== E ${eng}: GET /kasugai?engine=${eng}&route=kasugai ==`);
  const r = await getJson(`${QGIS}/kasugai?engine=${eng}&route=kasugai`);
  const j = r.json || {};
  ok(j.ok === true, "export 成功 (ok:true)", JSON.stringify(j).slice(0, 200));
  ok(j.via === "kasugai", "via=kasugai (Canvas登録)", `via=${j.via}`);
  ok(typeof j.url === "string" && j.url.includes(`/${eng}/?project=`),
    "url が /<engine>/?project= 形式", j.url || "(なし)");
  ok(j.engine === eng, "engine フィールドが指定値", `engine=${j.engine}`);
  ok((j.layers ?? 0) + (j.tiles ?? 0) > 0, "layers/tiles > 0",
    `layers=${j.layers} tiles=${j.tiles}`);
  const kasc = j.dir ? readKasc(j.dir) : null;
  if (kasc) console.log(`  kasc行: ${JSON.stringify(kasc.types)} off=${kasc.offTitles.length}`);
  else note(`.kasc を読めません: ${j.dir}`);
  exported[eng] = { j, kasc };
}

// ---------- W4-W7: 各エンジンで再生 ----------
for (const eng of engines) {
  const { j, kasc } = exported[eng] || {};
  if (!j?.url) { note(`${eng}: url 無しのため再生検証スキップ`); continue; }
  console.log(`== R ${eng}: ${j.url} ==`);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  try {
    await page.goto(j.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => window.kasugaiApi?.listLayers,
      undefined, { timeout: 30000 });
    await page.waitForFunction(
      () => window.kasugaiApi.listLayers().length > 0,
      undefined, { timeout: 60000 });
    const layers = await page.evaluate(() => window.kasugaiApi.listLayers().map(l => ({
      id: l.id, title: l.title, type: l.type, visible: l.visible })));
    ok(layers.length > 0, "kasc レイヤ行が列挙される", `got ${layers.length}`);
    // | off 行 → 非表示適用 (kasc のタイトルは site パス入りなので末端名で突合)
    if (kasc?.offTitles?.length) {
      const leafOf = t => String(t || "").split("/").pop().trim();
      const matched = kasc.offTitles
        .map(t => layers.find(l => leafOf(l.title || l.id) === t))
        .filter(Boolean);
      ok(matched.length > 0 && matched.every(l => l.visible === false),
        "`| off` 行が非表示として適用",
        `off=${kasc.offTitles.length} matched=${matched.length} ` +
        `bad=${matched.filter(l => l.visible !== false).map(l => l.title).join(",")}`);
    } else note("off 行なし(全レイヤ可視のプロジェクト)");
    // geojson: 行の実ファイル地物数を正本として Canvas 側と突合
    // (QGIS 側で空のレイヤは 0 件出力が正解 — 件数>0 の行だけを確認する。
    //  | off 行は非表示のため geojson を遅延ロードせず getLayerGeoJson が
    //  null を返す → 突合対象から除外する)
    const expectRows = (kasc?.layerRows || [])
      .filter(r => r.type === "geojson" && r.fileFeatures > 0 && !r.off);
    if (expectRows.length) {
      const ids = {};
      for (const r of expectRows) {
        const l = layers.find(x =>
          String(x.title || x.id).split("/").pop().trim() === r.leaf);
        if (l) ids[l.id] = { leaf: r.leaf, expect: r.fileFeatures };
      }
      // ロード収束開始の合図として「いずれか >0」まで待つ
      // (live 連携の再ロードで全レイヤ同時 >0 にならない瞬間があるため、
      // 最終判定は後続のリトライ内蔵 evaluate に任せる)
      await page.waitForFunction(async want => {
        for (const id of Object.keys(want)) {
          try {
            const gj = await window.kasugaiApi.getLayerGeoJson(id);
            if ((gj?.features?.length ?? 0) > 0) return true;
          } catch { /* retry */ }
        }
        return false;
      }, ids, { timeout: 60000, polling: 1500 }).catch(() => {});
      // live: 行のポーリング連携で geojsonSource が再ロード中に一時 null を
      // 返す瞬間があるため、最終採取もリトライ内蔵にする(最大値を採用)
      const counts = await page.evaluate(async want => {
        const out = {};
        for (const id of Object.keys(want)) {
          let best = -1;
          for (let i = 0; i < 30 && best <= 0; i++) {
            try {
              const gj = await window.kasugaiApi.getLayerGeoJson(id);
              const n = gj?.features?.length;
              if (typeof n === "number" && n > best) best = n;
            } catch { /* retry */ }
            if (best <= 0) await new Promise(r => setTimeout(r, 1000));
          }
          out[want[id].leaf] = best;
        }
        return out;
      }, ids);
      console.log("  feature counts(geojson行,期待>0):", JSON.stringify(counts).slice(0, 400));
      const entries = Object.entries(counts);
      ok(entries.length > 0 && entries.every(([, c]) => typeof c === "number" && c > 0),
        "地物あり geojson 行が Canvas でも地物を持つ", JSON.stringify(counts).slice(0, 200));
    } else note("地物>0 の geojson 行なし(空レイヤのみのプロジェクト)");
    // R5-R8: 状態系行の Canvas UI 適用(存在する面のみ。無い面は NOTE)
    if (kasc) {
      // mount ループ完了まで待つ。テーマ選択肢・カメラ/ブックマークプリセットは
      // レイヤ mount 完了後にまとめて描画される(gsimaps は mountEntry が
      // iframe 経由で重く、#cams と別に常設の .cam-btn(保存/読込)が3個ある
      // ため「cam-btn が有る」では収束判定できない)。#load-progress の
      // 「一度表示→再び hidden」または期待値の充足で打ち切る
      const expectTheme = (kasc.types.theme || 0) > 0
        ? (kasc.types.theme || 0) + 1 : null;
      const expectBm = (kasc.types.bookmark || 0) > 0;
      let lpSeenVisible = false;
      for (let i = 0; i < 90; i++) {
        const st = await page.evaluate(() => {
          const lp = document.querySelector("#load-progress");
          return {
            lpHidden: lp ? !!lp.hidden : true,
            themeOpts: document.querySelectorAll("#theme-select option").length,
            bms: document.querySelectorAll(".bm-btn").length,
          };
        }).catch(() => null);
        if (!st) { await new Promise(r => setTimeout(r, 1000)); continue; }
        if (!st.lpHidden) lpSeenVisible = true;
        const themeOk = expectTheme == null || st.themeOpts === expectTheme;
        const bmOk = !expectBm || st.bms > 0;
        if ((themeOk && bmOk) || (lpSeenVisible && st.lpHidden)) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      const ui = await page.evaluate(async () => {
        // カメラプリセットは遅延レンダリング(タブを開いて初めて描画)の
        // エンジンがあるため、カメラタブがあれば開いてから数える
        const camTab = [...document.querySelectorAll(".panel-tab, .tab")]
          .find(t => /camera|カメラ/i.test(
            `${t.dataset.panel || ""} ${t.dataset.pane || ""} ${t.textContent}`));
        if (camTab) {
          camTab.click();
          // 遅延レンダリングのエンジンがあるため出現までポーリング
          for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (document.querySelectorAll(".cam-btn, .preset-button").length) break;
          }
        }
        // gsimaps の #cams とは別に常設の .cam-btn(cams-save-*/cams-load 等の
        // 保存/読込ユーティリティ)があるため、id^=cams- のボタンは数えない
        const isPreset = el => !/^cams-/.test(el.id || "");
        return {
          themeOpts: document.querySelectorAll("#theme-select option").length,
          groups: document.querySelectorAll(".layer-group").length,
          cams: [...document.querySelectorAll(".cam-btn, .preset-button")]
            .filter(isPreset).length,
          bms: [...document.querySelectorAll(".bm-btn")].filter(isPreset).length,
          panels: window.kasugaiApi.listPanels?.().map(
            p => `${p.owner}/${p.title}/${p.id}/${p.key}`) || null,
        };
      });
      if ((kasc.types.theme || 0) > 0)
        ok(ui.themeOpts === (kasc.types.theme || 0) + 1,
          "theme: が #theme-select へ反映",
          `options=${ui.themeOpts} expect=${(kasc.types.theme || 0) + 1}`);
      if ((kasc.types.group || 0) > 0)
        ok(ui.groups > 0, "group: がレイヤグループへ反映", `groups=${ui.groups}`);
      if ((kasc.types.cam || 0) + (kasc.types.bookmark || 0) > 0) {
        if (ui.cams === 0) note("カメラプリセット UI を持たない/未描画エンジン");
        else {
          ok(ui.cams >= (kasc.types.cam || 0), "cam: がカメラプリセットへ反映",
            `${ui.cams}/${kasc.types.cam || 0}`);
          if ((kasc.types.bookmark || 0) > 0)
            ok(ui.bms > 0, "bookmark: XML がプリセットへ展開", `bm=${ui.bms}`);
        }
      }
      if ((kasc.types.plugin || 0) > 0) {
        if (ui.panels === null)
          note("パネル API を持たないエンジン(plugin: パネル系は対象外)");
        else {
          // 既取得の ui.panels を先見る(登録済みなら即 PASS)。
          // plugin: 行のロードはレイヤ適用後に非同期で走るため未検出時は
          // page.evaluate でポーリング(waitForFunction は live 再読込の
          // コンテキスト破棄で落ちることがあるため使わない)
          const match = list => (list || []).some(s => /custom-layer|レイヤ/.test(s));
          let seen = match(ui.panels);
          for (let i = 0; i < 30 && !seen; i++) {
            await new Promise(r => setTimeout(r, 2000));
            seen = await page.evaluate(() =>
              (window.kasugaiApi.listPanels?.() || []).some(p =>
                /custom-layer|レイヤ/.test(
                  `${p.owner}/${p.title}/${p.id}/${p.key}`)))
              .catch(() => false);
          }
          ok(seen, "plugin: custom-layer がパネル登録される",
            JSON.stringify(ui.panels).slice(0, 300));
        }
      }
    }
    const real = errors.filter(e => !NOISE.test(e));
    ok(real.length === 0, "重大なJSエラーなし", real.slice(0, 3).join("; "));
  } catch (e) {
    ok(false, `${eng} 再生`, e.message.slice(0, 200));
  }
  await page.close();
}

// ---------- W8-W12: /kasugai パラメータ (cesium) ----------
console.log("== P fmt/route パラメータ ==");
{
  const r = await getJson(`${QGIS}/kasugai?engine=cesium&fmt=geojson&route=kasugai`);
  const j = r.json || {};
  ok(j.ok === true && j.vector_format === "geojson",
    "fmt=geojson が vector_format へ反映", `vf=${j.vector_format}`);
  const kasc = j.dir ? readKasc(j.dir) : null;
  if (kasc) ok((kasc.types.geojson || 0) > 0, "fmt=geojson で geojson: 行が出力",
    JSON.stringify(kasc.types));
}
{
  const r = await getJson(`${QGIS}/kasugai?engine=cesium&fmt=recommended&route=kasugai`);
  const j = r.json || {};
  ok(j.ok === true && j.vector_format === "recommended",
    "fmt=recommended が vector_format へ反映", `vf=${j.vector_format}`);
  const kasc = j.dir ? readKasc(j.dir) : null;
  if (kasc) {
    const rec = ["flatgeobuf", "fgb", "geoparquet", "parquet", "gpkg", "geopackage", "duckdb"]
      .reduce((n, t) => n + (kasc.types[t] || 0), 0);
    if (rec === 0) note(`recommended でも推奨形式行なし: ${JSON.stringify(kasc.types)}`);
  }
}
let localUrl = null, hostedUrl = null;
{
  const r = await getJson(`${QGIS}/kasugai?engine=cesium&route=local`);
  const j = r.json || {};
  if (j.ok && j.via === "qgis-http" && /:\d+\//.test(j.url || "")) {
    ok(true, "route=local → via=qgis-http フォールバック");
    localUrl = j.url;
  } else if (j.ok && j.via === null)
    note("route=local: Canvas web/ 未検出で url 無し(インストール未検出環境)");
  else ok(false, "route=local → via=qgis-http", JSON.stringify(j).slice(0, 200));
}
{
  const r = await getJson(`${QGIS}/kasugai?engine=cesium&route=hosted`);
  const j = r.json || {};
  if (j.ok && j.via === "hosted" && /^https?:\/\//.test(j.url || "")) {
    ok(true, "route=hosted → via=hosted フォールバック");
    hostedUrl = j.url;
  } else if (j.ok && j.via === null)
    note("route=hosted: ホスト版 URL 組立不可(オフライン等)");
  else ok(false, "route=hosted → via=hosted", JSON.stringify(j).slice(0, 200));
}
{
  const r = await getJson(`${QGIS}/kasugai?engine=bogus&route=kasugai`);
  const j = r.json || {};
  ok(j.ok === true && j.engine === "cesium",
    "未知 engine は既定(cesium)へ正規化", `engine=${j.engine}`);
}

// ---------- P6/P7: フォールバック経路の実再生 ----------
if (localUrl) {
  console.log(`== P6 route=local URL 実再生: ${localUrl} ==`);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  try {
    await page.goto(localUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(
      () => window.kasugaiApi?.listLayers?.().length > 0,
      undefined, { timeout: 60000 });
    ok(true, "qgis-http 静的配信(:8089)でレイヤ再生");
    const real = errors.filter(e => !NOISE.test(e));
    ok(real.length === 0, "qgis-http 経路で重大なJSエラーなし",
      real.slice(0, 3).join("; "));
  } catch (e) {
    ok(false, "route=local URL 実再生", e.message.slice(0, 200));
  }
  await page.close();
}
if (hostedUrl) {
  console.log(`== P7 route=hosted URL 実再生: ${hostedUrl.slice(0, 120)} ==`);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  try {
    await page.goto(hostedUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction(
      () => window.kasugaiApi?.listLayers?.().length > 0,
      undefined, { timeout: 90000 });
    ok(true, "hosted(CDN+export-data)でレイヤ再生");
  } catch (e) {
    note(`hosted 実再生は外部依存(GitHub Pages/loopback)で未達: ${e.message.slice(0, 120)}`);
  }
  await page.close();
}

// ---------- W13-W15: qgis-import プラグインボタン経路 (cesium) ----------
console.log("== Q qgis-import プラグインボタン ==");
{
  const reg = await fetch(`${CANVAS}/api/projects/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: FIXTURE }),
  }).then(r => r.json()).catch(e => ({ error: String(e) }));
  const fid = reg.id;
  ok(!!fid, "フィクスチャ .kasc の外部登録", JSON.stringify(reg).slice(0, 200));
  if (fid) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on("pageerror", e => errors.push("pageerror: " + e.message));
    try {
      await page.goto(`${CANVAS}/cesium/?project=${fid}`,
        { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForFunction(() => window.kasugaiApi?.listLayers,
        undefined, { timeout: 30000 });
      await page.waitForSelector("#qgis-import-btn", { timeout: 30000 });
      ok(true, "plugin: qgis-import でボタンが出る");
      await page.click("#qgis-import-btn");
      // QGIS 側で全量エクスポート→登録→switchProject まで待つ。
      // 「取り込み完了」表示の直後に switchProject がプラグインを dispose し
      // #qgis-import-status 自体が消えるため DOM の文字列は観測不能。
      // 完了の確実な証跡は ?project= がフィクスチャIDから切替わること。
      const outcome = await page.waitForFunction(
        fid2 => {
          const t = document.querySelector("#qgis-import-status")?.textContent || "";
          const p = new URLSearchParams(location.search).get("project");
          if (/取り込み失敗|接続できません/.test(t)) return `fail: ${t}`;
          if (p && p !== fid2) return `switched:${p}`;
          return false;
        }, fid, { timeout: 240000, polling: 1000 })
        .then(h => h.jsonValue()).catch(() => null);
      const proj = typeof outcome === "string" && outcome.startsWith("switched:")
        ? outcome.slice(9) : null;
      ok(!!proj, "ボタン→ /kasugai 取り込み完了+switchProject で project 切替",
        `${String(outcome)} url=${page.url()}`);
      await page.waitForFunction(
        () => window.kasugaiApi?.listLayers?.().length > 0,
        undefined, { timeout: 60000 });
      ok(true, "切替後プロジェクトのレイヤ列挙");
      const real = errors.filter(e => !NOISE.test(e));
      ok(real.length === 0, "プラグイン経路で重大なJSエラーなし",
        real.slice(0, 3).join("; "));
    } catch (e) {
      ok(false, "qgis-import ボタン経路", e.message.slice(0, 200));
    }
    await page.close();
  }
}

// ---------- Q5: kascInspect(逆方向 dry run)ラウンドトリップ ----------
// geo_driver レジストリから live 接続を発見し bridge_call でエクスポートした
// .kasc を QGIS 側へ再解析させる(プロジェクト非変更。kascImport 本体は
// プロジェクト改変のため対象外)
{
  console.log("== Q5 kascInspect(逆方向) ==");
  let drv = null;
  try {
    for (const f of fs.readdirSync(path.join(os.homedir(), ".qgis-live"))
      .filter(x => x.endsWith("-geo_driver.json"))) {
      try {
        const info = JSON.parse(
          fs.readFileSync(path.join(os.homedir(), ".qgis-live", f), "utf8"));
        const h = await getJson(
          `http://127.0.0.1:${info.http_port}/api/health`, 3000);
        if (h.json?.ok) { drv = info; break; }
      } catch { /* next registry */ }
    }
  } catch { /* no registry dir */ }
  const kascPath = Object.values(exported)
    .map(e => e?.kasc?.file).find(Boolean);
  if (!drv) note("geo_driver 未検出 — kascInspect スキップ");
  else if (!kascPath) note("エクスポート .kasc 不明 — kascInspect スキップ");
  else {
    const rep = await fetch(`http://127.0.0.1:${drv.http_port}/api/cmd`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${drv.token}`,
      },
      body: JSON.stringify({
        type: "bridge_call", plugin_id: "geo_webview",
        method: "kascInspect", args: [kascPath],
      }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }));
    // bridge の戻り result は既に JSON 化済みオブジェクト(文字列なら parse)
    let parsed = rep?.result ?? rep;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    ok(parsed?.ok === true,
      "bridge kascInspect が .kasc を解析", JSON.stringify(rep).slice(0, 200));
    if (parsed?.ok) {
      const counts = parsed.counts || {};
      const expect = exported.cesium?.kasc?.types || {};
      const mism = Object.keys(expect).filter(
        t => counts[t] !== undefined && counts[t] !== expect[t]);
      ok(mism.length === 0 && Object.keys(counts).length > 0,
        "kascInspect の行タイプ集計がエクスポートと一致",
        `mismatch=${JSON.stringify(mism)}`);
    }
  }
}

await browser.close();
console.log(`\n==== ${pass}/${total} PASS ====`);
process.exit(fail ? 1 : 0);
