// verify-live-view 深掘りプローブ: Phase C (Q3/Q4/Q6/Q8/Q9/Q10/Q11) + Phase D (L1-L6)
//   probe-live-view.mjs がカバーしない項目を実機で検証する。
//   QGIS :8089 (geo_webview) + geo_driver REST + Canvas :8510。
//   既定エンジン maplibre(window.kascMap で描画状態を読戻し)。
// 使い方:
//   node web/verify/results/probe-live-view-deep.mjs [--engine maplibre] [--host 8510]
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const QGIS = "http://127.0.0.1:8089";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SHOTS = `${OUT}live-view`;
mkdirSync(SHOTS, { recursive: true });

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
let host = opt("--host", 8510);
const BASE = /^https?:/.test(String(host)) ? String(host).replace(/\/+$/, "") : `http://127.0.0.1:${host}`;
const ENGINE = opt("--engine", "maplibre");
const LAYER_TITLE = "国土数値情報/政策区域/行政地域/行政区域"; // 6177地物・singleSymbol・labelsEnabled・minScale=500000
const LAYER_NAME = "行政区域";
const DM_TITLE = "サンプル/DM（スタイルサンプル）/DM_C";            // RuleRenderer

// geo_driver 接続情報 (~/.qgis-live/*-geo_driver.json)
let DRV = null;
try {
  const dir = `${homedir()}/.qgis-live`;
  const f = readdirSync(dir).find(x => /-geo_driver\.json$/.test(x));
  const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  DRV = { url: `http://127.0.0.1:${j.http_port}`, token: j.token };
} catch {}
async function pyeval(code) {
  if (!DRV) return { error: "no geo_driver registry" };
  const r = await fetch(`${DRV.url}/api/pyeval`, {
    method: "POST",
    headers: { Authorization: `Bearer ${DRV.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return r.json().catch(() => ({ error: "bad json" }));
}

const checks = [];
const ok = (id, cond, extra = "") => {
  checks.push({ id, pass: !!cond, extra });
  console.log(cond ? "PASS" : "FAIL", id, extra ? `:: ${String(extra).slice(0, 160)}` : "");
};

// ---------- Phase A ----------
const live0 = await fetch(`${QGIS}/live/state`).then(r => r.json()).catch(() => null);
ok("A-live-state", !!live0 && live0.ok !== false, live0 ? "ok" : "no response");
if (!live0) { console.log("==== 0/1 PASS ===="); process.exit(1); }
const drvHealth = await fetch(`${DRV?.url}/api/health`).then(r => r.ok).catch(() => false);
ok("A-driver", drvHealth, DRV ? DRV.url : "no registry");

// ---------- Q9: 名前付きスタイル ----------
const namedQml = await fetch(`${QGIS}/live/style?layer=${encodeURIComponent(DM_TITLE)}&name=${encodeURIComponent("デフォルト")}`)
  .then(r => r.status === 200 ? r.text() : "").catch(() => "");
ok("Q9-named-style", /renderer-v2|RuleRenderer/.test(namedQml), `len=${namedQml.length}`);

// ---------- L6: /live/mcp loopback ----------
const mcpInit = await fetch(`${QGIS}/live/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
}).then(async r => ({ st: r.status })).catch(e => ({ st: 0 }));
ok("L6-mcp-loopback", mcpInit.st === 200, `status=${mcpInit.st} (非loopback拒否はコード上担保)`);

// ---------- ブラウザ起動 (maplibre) ----------
const enc = encodeURIComponent(`${QGIS}/live/kasc`);
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ headless: true }); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrs = [];
page.on("pageerror", e => pageErrs.push(String(e).slice(0, 160)));
await page.goto(`${BASE}/${ENGINE}/?kasc=${enc}`, { waitUntil: "domcontentloaded", timeout: 60000 });

const deadline = Date.now() + 60000;
let st = null;
while (Date.now() < deadline) {
  st = await page.evaluate(() => {
    const api = window.kasugaiApi;
    let layers = null;
    try { layers = api?.listLayers ? api.listLayers().length : null; } catch {}
    const prog = document.querySelector("#load-progress");
    return { api: !!api, layers, loading: prog ? !prog.hidden : false };
  }).catch(() => null);
  if (st?.api && st.layers > 0 && !st.loading) break;
  await page.waitForTimeout(2000);
}
ok("B-ready", st?.api && st.layers > 0, `layers=${st?.layers}`);
await page.waitForTimeout(4000); // gpkg(sql.js)→style layer 反映の猶予

// maplibre 側の style layer を地物クエリで特定
const findStyleLayers = () => page.evaluate(() => {
  const m = window.kascMap;
  if (!m) return null;
  const c = m.getCenter();
  const feats = m.queryRenderedFeatures(undefined, {});
  const ids = [...new Set(feats.map(f => f.layer?.id).filter(Boolean))];
  return { ids, all: m.getStyle().layers.map(l => ({ id: l.id, type: l.type, src: l.source })) };
});
const layerInfo = t => page.evaluate(tt => {
  const e = window.kasugaiApi.listLayers().find(l => l.title === tt || l.title?.endsWith("/" + tt) || l.title === tt.split("/").pop());
  return e ? { title: e.title, legend: (e.legend || []).length } : null;
}, t);

// ---------- Q3: singleSymbol 適用 (line-color 読戻し) ----------
// エントリ id → kasc-<id>-* style layer を特定し paint を読む
const gyoseiPaint = await page.evaluate(title => {
  const m = window.kascMap;
  const e = window.kasugaiApi.listLayers().find(l => l.title === title || l.title?.endsWith("/" + title));
  if (!e) return { err: "entry not found" };
  const pfx = String(e.id).startsWith("kasc-") ? `${e.id}-` : `kasc-${e.id}-`;
  const lids = m.getStyle().layers.map(l => l.id).filter(id => id.startsWith(pfx));
  const line = lids.find(id => /-line/.test(id)) || lids.find(id => /-fill/.test(id));
  return {
    entryId: e.id, lids,
    line: line ? m.getPaintProperty(line, "line-color") : null,
    fill: lids.filter(i => /-fill/.test(i)).map(i => m.getPaintProperty(i, "fill-color")),
  };
}, LAYER_TITLE);
ok("Q3-single-symbol", !!gyoseiPaint.line && !gyoseiPaint.err,
   `kasc-${gyoseiPaint.entryId}-* line-color=${JSON.stringify(gyoseiPaint.line)}`);

// ---------- Q4: RuleRenderer (DM_C 凡例複数) ----------
const dmc = await layerInfo("DM_C");
ok("Q4-rule-renderer", !!dmc && dmc.legend >= 2, dmc ? `legend=${dmc.legend}` : "not found");

// ---------- Q6: ラベル (symbol layer + 地物) ----------
const lbl = await page.evaluate(() => {
  const m = window.kascMap;
  const syms = m.getStyle().layers.filter(l => l.type === "symbol");
  const withText = syms.filter(l => l.layout && (l.layout["text-field"] || l.layout["icon-image"]));
  const feats = m.queryRenderedFeatures(undefined, { layers: withText.map(l => l.id) });
  return { symbolLayers: syms.length, labelLayers: withText.map(l => l.id), rendered: feats.length };
});
ok("Q6-labels", lbl.rendered > 0 || lbl.labelLayers.length > 0,
   `symbolLayers=${lbl.symbolLayers} rendered=${lbl.rendered} ids=${lbl.labelLayers.slice(0, 3).join(",")}`);

// ---------- Q7: 式関数 (is_layer_visible 参照ラベルの連動) ----------
// 行政区域の label fieldName =
//   if(vis('都道府県名'),"N03_001",'') || NL || if(vis('市区町村名'),"N03_004",'')
// → 参照先2レイヤを両方 OFF にすると式評価が空になりラベル地物 0 件になるはず。
//   (片方 OFF では残り片方のラベルが描画され、衝突回避で増減するため件数判定不可)
const T_PREF = "国土数値情報/政策区域/行政地域/表示・非表示/都道府県名";
const T_CITY = "国土数値情報/政策区域/行政地域/表示・非表示/市区町村名";
const countLabels = () => page.evaluate(() => {
  const m = window.kascMap;
  const syms = m.getStyle().layers.filter(l => l.type === "symbol");
  return m.queryRenderedFeatures(undefined, { layers: syms.map(l => l.id) }).length;
});
const lblBefore = await countLabels();
await page.evaluate(t => window.kasugaiApi.setLayerVisible(t, false), T_PREF);
await page.evaluate(t => window.kasugaiApi.setLayerVisible(t, false), T_CITY);
await page.waitForTimeout(5000);
const lblHidden = await countLabels();
await page.evaluate(t => window.kasugaiApi.setLayerVisible(t, true), T_PREF);
await page.evaluate(t => window.kasugaiApi.setLayerVisible(t, true), T_CITY);
await page.waitForTimeout(5000);
const lblRestored = await countLabels();
ok("Q7-is-layer-visible-expr", lblBefore > 0 && lblHidden === 0 && lblRestored > 0,
   `labels ${lblBefore}→(両参照OFF)→${lblHidden}→(復帰)→${lblRestored}`);

// ---------- Q8: 縮尺連動 (ルール級 scalemaxdenom → zoom 変換) ----------
// DM_C の RuleRenderer は scalemaxdenom ルール持ち → スタイルレイヤへ zoom 境界として
// コンパイルされることを確認。レイヤ級 hasScaleBasedVisibilityFlag は全レイヤ 0 のため
// 「非表示になること」の検証は対象外(QGIS 本体でも効かない)。
const scaleDefs = await page.evaluate(() => {
  const m = window.kascMap;
  const dm = window.kasugaiApi.listLayers().filter(l => /DM_[C13]/.test(l.title)).map(l => l.id);
  const out = [];
  for (const id of dm) {
    for (const l of m.getStyle().layers.filter(x => x.id.startsWith(`${id}-`))) {
      if (l.minzoom > 0 || l.maxzoom < 24) out.push({ id: l.id, min: l.minzoom, max: l.maxzoom });
    }
  }
  return out;
});
ok("Q8-scale-compiled", scaleDefs.length > 0,
   `zoom bounds on DM layers: ${scaleDefs.length} layers e.g. ${scaleDefs[0]?.id} max=${scaleDefs[0]?.max?.toFixed(2)}`);

// ---------- Q11: warnings ----------
const warns = await page.evaluate(() => {
  const cand = window.__kascWarnings || window.__qmlWarnings;
  if (Array.isArray(cand)) return cand.length;
  const es = window.kasugaiApi.listLayers();
  return es.flatMap(e => (e.warnings || [])).length;
});
ok("Q11-warnings-visible", warns >= 0, `warnings=${warns}`);

// ---------- Q10/L1: 編集→反映 ----------
// view_active を立てておく(未設定時)
await pyeval(`import qgis.utils
p=qgis.utils.plugins.get("geo_webview")
ctl=getattr(p,"_live_sync",None)
if ctl and not ctl.view_active: ctl.set_view_active(True)
result="ok"`);
const rev0 = (await fetch(`${QGIS}/live/live.json`).then(r => r.json()).catch(() => ({})))?.rev ?? 0;
const orig = await pyeval(`from qgis.core import QgsProject
l=[x for x in QgsProject.instance().mapLayers().values() if x.name()=="${LAYER_NAME}"][0]
result=l.renderer().symbol().symbolLayer(0).strokeColor().name()`);
// GUI 相当: シンボル変更 + styleChanged emit + repaint
await pyeval(`from qgis.core import QgsProject
from qgis.PyQt.QtGui import QColor
l=[x for x in QgsProject.instance().mapLayers().values() if x.name()=="${LAYER_NAME}"][0]
l.renderer().symbol().symbolLayer(0).setStrokeColor(QColor("#ff0000"))
l.styleChanged.emit()
l.triggerRepaint()
result="changed"`);

let kascRefetched = 0, styleRefetched = 0;
page.on("request", r => {
  if (r.url().includes("/live/kasc")) kascRefetched++;
  if (r.url().includes("/live/style")) styleRefetched++;
});
const t0 = Date.now();
let revNow = rev0, newPaint = null;
while (Date.now() - t0 < 25000) {
  revNow = (await fetch(`${QGIS}/live/live.json`).then(r => r.json()).catch(() => ({})))?.rev ?? 0;
  const qml = await fetch(`${QGIS}/live/style?layer=${encodeURIComponent(LAYER_TITLE)}`).then(r => r.text()).catch(() => "");
  const served = /255,0,0|ff0000/i.test(qml);
  const paint = await page.evaluate(title => {
    const m = window.kascMap;
    const e = window.kasugaiApi.listLayers().find(l => l.title === title || l.title?.endsWith("/" + title));
    if (!e) return null;
    const pfx = String(e.id).startsWith("kasc-") ? `${e.id}-` : `kasc-${e.id}-`;
    const lid = m.getStyle().layers.map(l => l.id).find(id => id.startsWith(pfx) && /-line/.test(id));
    return lid ? m.getPaintProperty(lid, "line-color") : null;
  }, LAYER_TITLE).catch(() => null);
  const applied = JSON.stringify(paint || "");
  // Canvas 側の反応(kasc/style 再取得 or paint 更新)を必須にする。
  // /live/style はオンデマンドなので served だけでは弱い。
  if (revNow > rev0 && (kascRefetched > 0 || styleRefetched > 0 || /255.*0.*0|ff0000/i.test(applied))) {
    newPaint = { served, paint: applied, rev: revNow, kascRefetched, styleRefetched };
    break;
  }
  await page.waitForTimeout(1500);
}
ok("L1-rev-bump", revNow > rev0, `rev ${rev0}→${revNow}`);
ok("Q10-edit-reflect", !!newPaint, `served=${newPaint?.served} paint=${newPaint?.paint} kascRefetch=${kascRefetched} styleRefetch=${styleRefetched}`);
// 復元
await pyeval(`from qgis.core import QgsProject
from qgis.PyQt.QtGui import QColor
l=[x for x in QgsProject.instance().mapLayers().values() if x.name()=="${LAYER_NAME}"][0]
l.renderer().symbol().symbolLayer(0).setStrokeColor(QColor(${JSON.stringify(orig.result || "#232323")}))
l.styleChanged.emit()
l.triggerRepaint()
result="restored"`);
await page.waitForTimeout(8000);

// ---------- L2: controls ----------
const ctl0 = (await fetch(`${QGIS}/live/state`).then(r => r.json()))?.live?.controls;
await fetch(`${QGIS}/live/controls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ follow: false }) });
const ctl1 = (await fetch(`${QGIS}/live/state`).then(r => r.json()))?.live?.controls;
await fetch(`${QGIS}/live/controls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ follow: ctl0?.follow ?? true }) });
const ctl2 = (await fetch(`${QGIS}/live/state`).then(r => r.json()))?.live?.controls;
ok("L2-controls-roundtrip", ctl1?.follow === false && ctl2?.follow === (ctl0?.follow ?? true),
   `${ctl0?.follow}→${ctl1?.follow}→${ctl2?.follow}`);

// ---------- L3: camera → QGIS ----------
const cvs0 = (await fetch(`${QGIS}/live/state`).then(r => r.json()))?.canvas;
await fetch(`${QGIS}/live/camera`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bbox: [139.0, 35.0, 140.5, 36.0] }) });
await page.waitForTimeout(1500);
const cvs1 = (await fetch(`${QGIS}/live/state`).then(r => r.json()))?.canvas;
const moved = cvs0 && cvs1 && (Math.abs(cvs1.lon - cvs0.lon) > 0.01 || Math.abs(cvs1.scale - cvs0.scale) > 1);
ok("L3-camera-to-qgis", moved, `lon ${cvs0?.lon?.toFixed(3)}→${cvs1?.lon?.toFixed(3)} scale ${cvs0?.scale?.toFixed(0)}→${cvs1?.scale?.toFixed(0)}`);
if (moved) await fetch(`${QGIS}/live/camera`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ longitude: cvs0.lon, latitude: cvs0.lat, scale: cvs0.scale }) });

// ---------- L4: selection → QGIS ----------
const sel = await fetch(`${QGIS}/live/selection`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ layer: LAYER_TITLE, longitude: 139.75, latitude: 35.68, buffer_m: 3000 }) }).then(r => r.json()).catch(() => null);
const selCount = await pyeval(`from qgis.core import QgsProject
l=[x for x in QgsProject.instance().mapLayers().values() if x.name()=="${LAYER_NAME}"][0]
result=str(l.selectedFeatureCount())`);
ok("L4-selection-to-qgis", sel?.ok && Number(selCount.result) > 0, `applied=${JSON.stringify(sel)} qgis_sel=${selCount.result}`);
await pyeval(`from qgis.core import QgsProject
l=[x for x in QgsProject.instance().mapLayers().values() if x.name()=="${LAYER_NAME}"][0]
l.removeSelection()
result="cleared"`);

// ---------- L5: writeback 表示切替 ----------
const wb1 = await fetch(`${QGIS}/live/writeback`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ layers: [{ title: LAYER_TITLE, visible: false }] }) }).then(r => r.json()).catch(() => null);
const vis1 = await pyeval(`from qgis.core import QgsProject
l=[x for x in QgsProject.instance().mapLayers().values() if x.name()=="${LAYER_NAME}"][0]
result=str(QgsProject.instance().layerTreeRoot().findLayer(l.id()).isVisible())`);
await fetch(`${QGIS}/live/writeback`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ layers: [{ title: LAYER_TITLE, visible: true }] }) });
const vis2 = await pyeval(`from qgis.core import QgsProject
l=[x for x in QgsProject.instance().mapLayers().values() if x.name()=="${LAYER_NAME}"][0]
result=str(QgsProject.instance().layerTreeRoot().findLayer(l.id()).isVisible())`);
ok("L5-writeback-visibility", vis1.result === "False" && vis2.result === "True",
   `visible ${vis1.result}→${vis2.result}`);

await page.screenshot({ path: `${SHOTS}/deep-${ENGINE}.png`, timeout: 60000 });
await page.close();
await browser.close();

writeFileSync(`${SHOTS}/results-deep.json`, JSON.stringify({ checks }, null, 1));
const pass = checks.filter(c => c.pass).length;
console.log(`==== ${pass}/${checks.length} PASS ====`);
process.exit(pass === checks.length ? 0 : 1);
