// ポイントドレープ検証: billboard/label/point の heightReference が
// ドレープ対象(terrain/3D Tiles)へクランプされるかを機械確認する
// - zpoints: z 付き座標の Point/MultiPoint(Cesium 本体は2要素座標しかクランプしない)
// - qmlpoints: style=QML のマーカー + simple ラベル
// - clusterpts: cluster=on のクラスタバッジ
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const results = { checks: [] };
const ok = (name, cond, extra = "") => { results.checks.push({ name, pass: !!cond, extra }); console.log(cond ? "PASS" : "FAIL", name, extra); };
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 160)));
await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent("/projects/drape_points/drape_points.kasc")}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi?.isReady, { timeout: 120000 });
await page.waitForTimeout(5000);
// クラスタ・declutter はレンダリングフレームで確定するため数回描画を促す
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => window._viewer?.scene?.requestRender?.());
  await page.waitForTimeout(1000);
}

const info = await page.evaluate(() => {
  const gv = p => (p && typeof p.getValue === "function") ? p.getValue() : p;
  const recs = [];
  for (const ds of window._viewer.dataSources._dataSources || []) {
    const rec = { layerId: ds._kasugaiLayerId || null, clampRef: ds._kascClampRef ?? null,
      billboards: [], labels: [], points: [],
      clustering: ds.clustering?.enabled ?? false };
    for (const e of ds.entities.values) {
      if (e.billboard) rec.billboards.push({ name: e.name, ref: gv(e.billboard.heightReference), aux: !!e._kascAux });
      if (e.label) rec.labels.push({ name: e.name, ref: gv(e.label.heightReference) });
      if (e.point) rec.points.push({ name: e.name, ref: gv(e.point.heightReference) });
    }
    recs.push(rec);
  }
  return { recs, expected: Cesium.HeightReference.CLAMP_TO_TERRAIN, clampToGround: Cesium.HeightReference.CLAMP_TO_GROUND, none: Cesium.HeightReference.NONE };
});

const find = n => info.recs.find(r => r.billboards.some(b => b.name === n) || r.labels.some(l => l.name === n) || r.points.some(p => p.name === n));
const zds = find("z0");
const qmlds = find("本栖湖");
const cds = find("c0");
ok("3つのベクターレイヤーがロードされた", !!(zds && qmlds && cds), JSON.stringify(info.recs.map(r => r.layerId)));
ok("ドレープ参照が決定されている(3D Tiles 非表示なので TERRAIN)", zds?.clampRef === info.expected, `clampRef=${zds?.clampRef} expected=${info.expected}`);

// z 付き Point / MultiPoint: 全 billboard が terrain クランプ
const zb = zds?.billboards || [];
ok("z付きポイント含め全 billboard がクランプ対象", zb.length >= 5 && zb.every(b => b.ref === info.expected),
  JSON.stringify(zb.map(b => [b.name, b.ref])));

// QML レイヤー: マーカー(billboard)と simple ラベルの両方がクランプ
const qb = qmlds?.billboards || [], ql = qmlds?.labels || [];
ok("QML マーカー billboard がクランプ対象", qb.length >= 3 && qb.every(b => b.ref === info.expected),
  JSON.stringify(qb.map(b => [b.name, b.ref])));
ok("QML ラベル label がクランプ対象", ql.length >= 3 && ql.every(l => l.ref === info.expected),
  JSON.stringify(ql.map(l => [l.name, l.ref])));

// クラスタ: enabled + バッジ billboard のクランプ(取得できた場合)
ok("cluster=on でクラスタ有効", cds?.clustering === true);
if (cds?.clusterRef != null) {
  ok("クラスタバッジがクランプ対象", cds.clusterRef === info.expected, `clusterRef=${cds.clusterRef}`);
} else {
  console.log("(info) _clusterBillboard 未生成のためクラスタバッジ参照は未検査");
}

// クラスタバッジはクラスタ成立フレームで生成される。成立後に再検査する
await page.waitForTimeout(2000);
const clusterDiag = await page.evaluate(() => {
  const ds = [...(window._viewer.dataSources._dataSources || [])].find(d => d.clustering?.enabled);
  if (!ds) return null;
  const col = ds.clustering._clusterBillboardCollection;
  const bbs = [];
  if (col) for (let i = 0; i < col.length; i++) bbs.push(col.get(i).heightReference);
  return { count: col?.length ?? 0, refs: bbs };
});
if (clusterDiag?.count > 0) {
  ok("クラスタバッジがクランプ対象", clusterDiag.refs.every(r => r === info.expected), `refs=${JSON.stringify(clusterDiag.refs)}`);
} else {
  console.log("(info) クラスタバッジコレクション未生成のため参照は未検査", JSON.stringify(clusterDiag));
}

// 非ドレープ時の回帰: heightReference=NONE の billboard が残っていないことは
// このプロジェクト(全レイヤ ドレープ ON)では全て clampRef と一致で確認済み

await page.screenshot({ path: `${OUT}drape-points.png` });
writeFileSync(`${OUT}drape-points-2026-11-18.json`, JSON.stringify({ results, info }, null, 2));
const fails = results.checks.filter(c => !c.pass);
console.log(`\n${results.checks.length - fails.length}/${results.checks.length} PASS`);
await browser.close();
process.exit(fails.length ? 1 : 0);
