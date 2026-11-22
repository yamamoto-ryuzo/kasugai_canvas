// GeoJsonPrimitive 経路の QML 装飾(decor)補助 DataSource 回帰検証プローブ
// render=primitive のベクターレイヤーで decor 補助 entity が生成され、
// 本体 primitive と同じ可視条件(表示/縮尺/凡例)へ追従することを確認する
//  実行: node web/verify/results/probe-prim-decor.mjs  (dev サーバ :8520 前提)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";

const BASE = process.env.KASC_BASE || "http://localhost:8520";
const KASC = `${BASE}/projects/_primtest/kasugai_canvas.kasc`;
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
await page.goto(`${BASE}/cesium/?kasc=${encodeURIComponent(KASC)}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kasugaiApi && window._viewer, { timeout: 30000 });
// primitive 10件以上が登録されるまで待機(fromGeoJson は非同期)
await page.waitForFunction(() => {
  const pr = window._viewer.scene.primitives; let n = 0;
  for (let i = 0; i < pr.length; i++) if (pr.get(i)?._kasugaiLayerId) n++;
  return n >= 12;
}, null, { timeout: 180000 });
await page.waitForTimeout(2500); // decor ds 生成・QML 適用の確定待ち

const layers = await page.evaluate(() => window.kasugaiApi.listLayers().map(l => ({ id: l.id, title: l.title, visible: l.visible })));
const findId = t => layers.find(l => l.title === t)?.id;
const ids = Object.fromEntries(["ArrowLine-prim","ArrowLine-entity","MarkerLine-prim","MarkerLine-entity",
  "InterpLine-prim","LinRef-prim","FilledLine-prim","HashLine-prim","Multi-prim","Cat-prim","MarkerLine-scale"]
  .map(t => [t, findId(t)]));

const primInfo = await page.evaluate(() => {
  const v = window._viewer, out = {};
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p?._kasugaiLayerId) out[p._kasugaiLayerId] = { show: p.show, decorCount: p._decorDs?.entities?.values?.length ?? null };
  }
  return out;
});
console.log("primitives:", JSON.stringify(primInfo));

for (const t of ["ArrowLine-prim","MarkerLine-prim","InterpLine-prim","LinRef-prim","FilledLine-prim","HashLine-prim","Multi-prim","Cat-prim","MarkerLine-scale"])
  check(`${t} decor 補助 ds 生成`, primInfo[ids[t]]?.decorCount > 0, `n=${primInfo[ids[t]]?.decorCount}`);

// decor 種別ごとの entity gfx 種類を検証(polygon=billboard=corridor 等)
const gfxKinds = await page.evaluate(idMap => {
  const v = window._viewer, out = {};
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (!p?._kasugaiLayerId || !p._decorDs) continue;
    const kinds = new Set();
    for (const e of p._decorDs.entities.values) {
      if (e.billboard) kinds.add("billboard");
      if (e.polygon) kinds.add("polygon");
      if (e.polyline) kinds.add("polyline");
      if (e.corridor) kinds.add("corridor");
      if (e.label) kinds.add("label");
      if (e.point) kinds.add("point");
    }
    const t = Object.keys(idMap).find(k => idMap[k] === p._kasugaiLayerId);
    out[t || p._kasugaiLayerId] = [...kinds].sort();
  }
  return out;
}, ids);
console.log("gfx:", JSON.stringify(gfxKinds));
check("MarkerLine → billboard", gfxKinds["MarkerLine-prim"]?.includes("billboard"));
check("ArrowLine → polygon", gfxKinds["ArrowLine-prim"]?.includes("polygon"));
check("InterpolatedLine → polyline", gfxKinds["InterpLine-prim"]?.includes("polyline"));
check("LinearReferencing → label or billboard", gfxKinds["LinRef-prim"]?.some(k => k === "label" || k === "billboard"), JSON.stringify(gfxKinds["LinRef-prim"]));
check("FilledLine → corridor", gfxKinds["FilledLine-prim"]?.includes("corridor"), JSON.stringify(gfxKinds["FilledLine-prim"]));
check("HashLine → polyline", gfxKinds["HashLine-prim"]?.includes("polyline"), JSON.stringify(gfxKinds["HashLine-prim"]));

// decor ds が dataSources にありタグ無し(removeOtherLayerDataSources 非対象)
const dsInfo = await page.evaluate(() => {
  const v = window._viewer, out = [];
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    if (ds?.name?.startsWith?.("qml-decor:"))
      out.push({ name: ds.name, tagged: !!ds._kasugaiLayerId, show: ds.show, n: ds.entities.values.length });
  }
  return out;
});
check("decor ds が dataSources に登録", dsInfo.length >= 9, `n=${dsInfo.length}`);
check("decor ds に _kasugaiLayerId タグ無し", dsInfo.every(d => !d.tagged));

// MultiLineString: 2パート両方にマーカーが出ること(billboard 数 > 単一パートの頂点数)
check("MultiLineString 各パートに decor", primInfo[ids["Multi-prim"]]?.decorCount >= 6, `n=${primInfo[ids["Multi-prim"]]?.decorCount}`);

// decor-only シンボルのベース線は primitive 側で透明化されていること
const baseHidden = await page.evaluate(idList => {
  const v = window._viewer, out = {};
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p?._kasugaiLayerId && idList.includes(p._kasugaiLayerId) && p.polylines) {
      const scratch = new Cesium.BufferPolyline();
      let opaque = 0;
      for (let j = 0; j < p.polylines.primitiveCount; j++) {
        p.polylines.get(j, scratch);
        if (scratch.material?.color?.alpha > 0.01) opaque++;
      }
      out[p._kasugaiLayerId] = { count: p.polylines.primitiveCount, opaque };
    }
  }
  return out;
}, [ids["ArrowLine-prim"], ids["MarkerLine-prim"], ids["HashLine-prim"], ids["LinRef-prim"], ids["FilledLine-prim"]]);
check("decor-only ベース線は透明", Object.values(baseHidden).every(b => b.opaque === 0), JSON.stringify(baseHidden));

// 凡例非表示伝播: Cat-prim の MarkerLine カテゴリ(CatA=symbol "0")を隠す → decor ds 再生成で空になる
const catLegend = await page.evaluate(t => window.kasugaiApi.listLayers().find(l => l.title === t)?.legend, "Cat-prim");
console.log("Cat-prim legend:", JSON.stringify(catLegend));
const catAName = catLegend?.find(e => /a/i.test(e.label))?.label || catLegend?.[0]?.label;
await page.evaluate(({ t, label }) => window.kasugaiApi.setLayerLegendVisible(t, label, false), { t: "Cat-prim", label: catAName });
await page.waitForTimeout(3000);
const legendCheck = await page.evaluate(id => {
  const v = window._viewer;
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p?._kasugaiLayerId === id) return { decorN: p._decorDs?.entities?.values?.length ?? null, primExists: true };
  }
  return { primExists: false };
}, ids["Cat-prim"]);
check("凡例非表示で decor ds 除去/空化", legendCheck.primExists && (legendCheck.decorN === 0 || legendCheck.decorN === null), JSON.stringify(legendCheck));
// 戻す
await page.evaluate(({ t, label }) => window.kasugaiApi.setLayerLegendVisible(t, label, true), { t: "Cat-prim", label: catAName });
await page.waitForTimeout(3000);
const legendBack = await page.evaluate(id => {
  const v = window._viewer;
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p?._kasugaiLayerId === id) return p._decorDs?.entities?.values?.length ?? null;
  }
  return null;
}, ids["Cat-prim"]);
check("凡例復帰で decor 復元", legendBack > 0, `n=${legendBack}`);

// 縮尺伝播: MarkerLine-scale(minscale=50000 → far≈10.9km)を高高度へ → prim+decor 両方 hide
await page.evaluate(() => {
  window._viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139.84, 35.72, 60000) });
});
await page.waitForTimeout(2500);
const scaleHidden = await page.evaluate(id => {
  const v = window._viewer;
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p?._kasugaiLayerId === id) return { prim: p.show, decor: p._decorDs?.show };
  }
  return null;
}, ids["MarkerLine-scale"]);
check("縮尺外で primitive+decor とも非表示", scaleHidden && scaleHidden.prim === false && scaleHidden.decor === false, JSON.stringify(scaleHidden));
// 近付けて復帰
await page.evaluate(() => {
  window._viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139.84, 35.72, 6000) });
});
await page.waitForTimeout(2500);
const scaleBack = await page.evaluate(id => {
  const v = window._viewer;
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p?._kasugaiLayerId === id) return { prim: p.show, decor: p._decorDs?.show };
  }
  return null;
}, ids["MarkerLine-scale"]);
check("縮尺内で primitive+decor とも表示", scaleBack && scaleBack.prim === true && scaleBack.decor === true, JSON.stringify(scaleBack));

// 地物範囲へズームして実描画確認
await page.evaluate(() => {
  const v = window._viewer;
  v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139.79, 35.70, 30000) });
});
await page.waitForTimeout(2000);
try { await page.screenshot({ path: "verify/results/prim-decor-all.png", timeout: 15000 }); }
catch (e) { console.log("  (screenshot skip:", String(e).slice(0, 60), ")"); }

// 可視性伝播: レイヤー非表示 → rebuild 後に primitive+decor ds が除去される
await page.evaluate(t => window.kasugaiApi.setLayerVisible(t, false), "MarkerLine-prim");
await page.waitForTimeout(6000);
const visCheck = await page.evaluate(id => {
  const v = window._viewer;
  let prim = null, decorLeft = null;
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p?._kasugaiLayerId === id) prim = p;
  }
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    if (ds?.name === `qml-decor:${id}`) decorLeft = ds;
  }
  return { primExists: !!prim, decorExists: !!decorLeft };
}, ids["MarkerLine-prim"]);
check("非表示レイヤーの primitive+decor ds が除去", !visCheck.primExists && !visCheck.decorExists, JSON.stringify(visCheck));

// entity 経路の対照層が従来どおり decor を持つこと(回帰)
const entCheck = await page.evaluate(id => {
  const v = window._viewer;
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    if (ds?._kasugaiLayerId === id) {
      let aux = 0;
      for (const e of ds.entities.values) if (e.polygon || e.billboard) aux++;
      return { aux };
    }
  }
  return null;
}, ids["ArrowLine-entity"]);
check("entity 経路 ArrowLine の decor 残存", !!entCheck && entCheck.aux > 0, JSON.stringify(entCheck));

check("ページエラーなし", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\n== ${pass} PASS / ${fail} FAIL ==`);
await browser.close();
process.exit(fail ? 1 : 0);
