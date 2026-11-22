// is_layer_visible() 依存の装飾(decor)が参照レイヤーの表示切替で再評価されるか検証
// visline.qml: MarkerLine/Interval配置 + DD interval=if(is_layer_visible('MarkerLine-prim'),6,60)
//  参照層表示=6mm間隔=密 / 参照層非表示=60mm間隔=疎
//  実行: node web/verify/results/probe-visline.mjs  (dev :8520 前提)
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
await page.waitForFunction(() => {
  const v = window._viewer; if (!v) return false;
  let n = 0;
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p instanceof Cesium.GeoJsonPrimitive) n++;
  }
  return n >= 12;
}, { timeout: 120000, polling: 800 }).catch(() => {});
await page.waitForTimeout(4000);

// 固定高度で評価(縮尺変化の混入を防ぐ)
await page.evaluate(() => {
  window._viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139.76, 35.71, 20000) });
});
await page.waitForTimeout(2000);

const countDecor = async () => await page.evaluate(() => {
  const api = window.kasugaiApi, v = window._viewer;
  const layers = api.listLayers();
  const prim = layers.find(l => String(l.title) === "VisLine-prim");
  const ent = layers.find(l => String(l.title) === "VisLine-ent");
  const out = {};
  if (prim) {
    const id = prim.id ?? prim.name;
    for (let i = 0; i < v.scene.primitives.length; i++) {
      const p = v.scene.primitives.get(i);
      if (p._kasugaiLayerId === id && p._decorDs) {
        out.prim = p._decorDs.entities.values.filter(e => e.billboard).length;
      }
    }
  }
  if (ent) {
    const id = ent.id ?? ent.name;
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      if (ds._kasugaiLayerId === id) {
        out.ent = ds.entities.values.filter(e => e._kascAux && e.billboard).length;
      }
    }
  }
  return out;
});

const on = await countDecor();
console.log("ref visible:", JSON.stringify(on));

// 参照層を非表示 → is_layer_visible→false → interval=60mm → 疎
await page.evaluate(() => window.kasugaiApi.setLayerVisible("MarkerLine-prim", false));
await page.waitForTimeout(4000);
const off = await countDecor();
console.log("ref hidden:", JSON.stringify(off));

// 復帰
await page.evaluate(() => window.kasugaiApi.setLayerVisible("MarkerLine-prim", true));
await page.waitForTimeout(4000);
const back = await countDecor();
console.log("ref back:", JSON.stringify(back));

check("prim: 参照表示で密", on.prim > 100, `count=${on.prim}`);
check("prim: 参照非表示で疎化", off.prim < on.prim / 2, `on=${on.prim} off=${off.prim}`);
check("prim: 参照復帰で復元", back.prim > off.prim * 2, `back=${back.prim}`);
check("ent: 参照表示で密", on.ent > 100, `count=${on.ent}`);
check("ent: 参照非表示で疎化", off.ent < on.ent / 2, `on=${on.ent} off=${off.ent}`);
check("ent: 参照復帰で復元", back.ent > off.ent * 2, `back=${back.ent}`);
check("pageerror なし", errors.length === 0, errors.slice(0, 2).join("|"));

console.log(`== ${pass} PASS / ${fail} FAIL ==`);
await browser.close();
process.exit(fail ? 1 : 0);
