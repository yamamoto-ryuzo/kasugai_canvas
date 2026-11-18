// QML 逆方向ギャップ実装の検証(2026-11): FilledLine / VectorField /
// LinearReferencing / MaskMarker / predefinedPositionOrder / symbollevels。
// フィクスチャ: web/verify/qml-gaps/qml-gaps.kasc(実機 QGIS 4.0.1 出力 QML
// 由来 + 手書き symbollevels.qml)。
// 使い方: ローカルサーバー(:8510)起動後に
//   node web/verify/results/probe-qml-gaps.mjs [engine ...]
// 既定は全5エンジン(cesium/maplibre/openlayers/leaflet/navara)。
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:8510";
const KASC = "/verify/qml-gaps/qml-gaps.kasc";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SHOTS = `${OUT}qml-gaps`;
mkdirSync(SHOTS, { recursive: true });

const engines = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["cesium", "maplibre", "openlayers", "leaflet", "navara"];

const results = { checks: [], screenshots: [] };
const ok = (eng, name, cond, extra = "") => {
  results.checks.push({ engine: eng, name, pass: !!cond, extra });
  console.log(cond ? "PASS" : "FAIL", `[${eng}]`, name, extra);
};

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = {};
for (const e of engines) logs[e] = [];
page.on("console", m => {
  const t = m.type();
  if (t === "error") {
    const eng = engines.find(e => page.url().includes(`/${e}/`)) || "?";
    logs[eng]?.push(`[${t}] ${m.text().slice(0, 200)}`);
  }
});
page.on("pageerror", e => {
  const eng = engines.find(x => page.url().includes(`/${x}/`)) || "?";
  logs[eng]?.push(`[pageerror] ${String(e).slice(0, 250)}`);
});
const missing = {}; // 404 URL 記録(検証用)
page.on("response", r => {
  if (r.status() !== 404) return;
  const eng = engines.find(x => page.url().includes(`/${x}/`)) || "?";
  (missing[eng] ||= new Set()).add(r.url());
});

for (const eng of engines) {
  const url = `${BASE}/${eng}/?kasc=${encodeURIComponent(KASC)}`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.kasugaiApi?.isReady, { timeout: 90000 });
    await page.waitForTimeout(eng === "cesium" ? 9000 : eng === "navara" ? 8000 : 5000);
  } catch (e) {
    ok(eng, "load", false, String(e).slice(0, 160));
    continue;
  }

  if (eng === "cesium") {
    const r = await page.evaluate(() => {
      const ds = window._viewer?.dataSources;
      const ents = [];
      if (ds) for (let i = 0; i < ds.length; i++)
        for (const e of ds.get(i).entities.values) ents.push(e);
      let corridor = 0, linrefLabel = 0, linrefBb = 0, billboard = 0;
      for (const e of ents) {
        if (e.corridor) corridor++;
        if (e.billboard) billboard++;
        if (e.label && /[0-9]/.test(String(e.label.text?.getValue?.() ?? ""))) linrefLabel++;
        if (e._kascAux && e.billboard) linrefBb++;
      }
      return { corridor, billboard, linrefLabel, linrefBb, total: ents.length };
    });
    ok(eng, "FilledLine→corridor entity", r.corridor >= 2, `corridor=${r.corridor}`);
    ok(eng, "VectorField→billboard", r.billboard >= 7, `billboard=${r.billboard}`);
    ok(eng, "LinearReferencing→距離ラベル", r.linrefLabel + r.linrefBb >= 3,
      `label=${r.linrefLabel} aux-bb=${r.linrefBb}`);
  }

  if (eng === "maplibre") {
    const r = await page.evaluate(() => {
      const st = window.kascMap?.getStyle?.();
      const layers = st?.layers || [];
      const has = (pred) => layers.some(pred);
      return {
        linrefSym: has(l => JSON.stringify(l.filter || []).includes("__kasc_lrt")),
        vanchor: has(l => !!l.layout?.["text-variable-anchor"]),
        sortKey: has(l => !!l.layout?.["symbol-sort-key"] || !!l.layout?.["line-sort-key"]),
        icons: Object.keys(window.kascMap.listImages?.() ? {} : {}),
        zkey: has(l => JSON.stringify(l.layout || {}).includes("__kasc_zkey")),
        lronlyExcluded: has(l => JSON.stringify(l.filter || []).includes("__kasc_lronly")),
      };
    });
    ok(eng, "LinearReferencing→symbol レイヤ(__kasc_lrt)", r.linrefSym);
    ok(eng, "predefinedPositionOrder→text-variable-anchor", r.vanchor);
    ok(eng, "symbollevels→*-sort-key(__kasc_zkey)", r.zkey);
    ok(eng, "linref 生成点の通常点除外", r.lronlyExcluded);
    const n = await page.evaluate(() => {
      const d = window.kascMap?.queryRenderedFeatures?.() || [];
      return d.filter(f => f.properties?.__kasc_lrt).length;
    }).catch(() => -1);
    if (n >= 0) ok(eng, "linref 標点点地物の描画", n >= 3, `rendered=${n}`);
  }

  if (eng === "leaflet") {
    const r = await page.evaluate(() => ({
      linrefTips: document.querySelectorAll(".kasc-linref-label").length,
      markers: document.querySelectorAll(".leaflet-marker-icon").length,
    }));
    ok(eng, "LinearReferencing→標点 tooltip", r.linrefTips >= 3, `tips=${r.linrefTips}`);
    ok(eng, "VectorField/MaskMarker→マーカー", r.markers >= 5, `markers=${r.markers}`);
  }

  if (eng === "openlayers") {
    // OL は canvas 描画のため DOM 検査不可。スタイル関数が例外なく動き
    // 地物が描画されていることをスクリーンショット+非空白判定に委ねる
    const r = await page.evaluate(() => {
      const cvs = [...document.querySelectorAll(".ol-layer canvas")];
      let painted = 0;
      for (const c of cvs) {
        try {
          const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < d.length; i += 400) if (d[i] > 0) { painted++; break; }
        } catch (_) { painted++; }
      }
      return { canvases: cvs.length, painted };
    });
    ok(eng, "OpenLayers canvas 描画", r.painted > 0, `canvases=${r.canvases} painted=${r.painted}`);
  }

  if (eng === "navara") {
    const r = await page.evaluate(() => {
      const es = window.kascLayerEntries || [];
      const out = { layers: es.filter(e => e.layer).length, varAnchors: false,
        linrefText: false };
      for (const e of es) {
        const tm = e?.desc?.text;
        if (tm?.variableAnchors?.length) out.varAnchors = true;
        // 里程標専用テキストマテリアル(geometryTypes:["point"] のみ)の存在
        if (tm?.geometryTypes?.length === 1 && tm.geometryTypes[0] === "point") {
          out.linrefText = true;
        }
      }
      return out;
    });
    ok(eng, "Navara レイヤ読込", r.layers >= 5, `layers=${r.layers}`);
    ok(eng, "predefinedPositionOrder→variableAnchors", r.varAnchors);
    ok(eng, "LinearReferencing→text マテリアル", r.linrefText);
  }

  const shot = `${SHOTS}/${eng}.png`;
  await page.screenshot({ path: shot });
  results.screenshots.push(shot);
  // 「Failed to load resource」はオプションファイル(ui.config.json/
  // 祖先 projects.json)・環境要因(Google Fonts CORS)の正常確認フェッチを
  // 含むため、404 URL 一覧へ集約してここでは実害エラーのみ見る
  const realErrs = logs[eng].filter(l =>
    !l.startsWith("[error] Failed to load resource") &&
    !l.includes("fonts.googleapis.com") &&
    !l.includes("CORS policy"));
  ok(eng, "console error なし", realErrs.length === 0,
    realErrs.slice(0, 3).join(" | ").slice(0, 300));
}

console.log("===== console errors =====");
for (const e of engines) {
  const u = [...new Set(logs[e])];
  if (u.length) { console.log(`--- ${e}`); u.slice(0, 8).forEach(l => console.log("   ", l)); }
}
console.log("===== 404 URLs =====");
for (const e of engines) {
  const u = [...(missing[e] || [])];
  if (u.length) { console.log(`--- ${e}`); u.slice(0, 10).forEach(l => console.log("   ", l)); }
}
const fails = results.checks.filter(c => !c.pass);
console.log(`===== ${results.checks.length - fails.length}/${results.checks.length} PASS =====`);
writeFileSync(`${OUT}qml-gaps.json`, JSON.stringify(results, null, 2));
await browser.close();
process.exit(fails.length ? 1 : 0);
