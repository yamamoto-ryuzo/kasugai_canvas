// @map_scale 依存の装飾(decor)が縮尺変化で再評価されるか検証
// scaleline.qml: MarkerLine/Interval配置 + DD interval=if(@map_scale>100000,60,6)
//  遠距離(縮尺>100k)=60mm間隔=疎 / 近距離(<100k)=6mm間隔=密
//  実行: node web/verify/results/probe-scale-decor.mjs  (dev :8520 前提)
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
  return n >= 11;
}, { timeout: 120000, polling: 800 }).catch(() => {});
await page.waitForTimeout(4000);

const countDecor = async () => await page.evaluate(() => {
  const api = window.kasugaiApi, v = window._viewer;
  const layers = api.listLayers();
  const prim = layers.find(l => String(l.title) === "ScaleLine-prim");
  const ent = layers.find(l => String(l.title) === "ScaleLine-ent");
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

// 遠距離(高高度) → 縮尺>100000 → interval=60mm → 疎
await page.evaluate(() => {
  const c = window._viewer.camera;
  c.setView({ destination: Cesium.Cartesian3.fromDegrees(139.76, 35.71, 260000) });
});
await page.waitForTimeout(2500);
const far = await countDecor();
console.log("far:", JSON.stringify(far));

// 近距離(低高度) → 縮尺<100000 → interval=6mm → 密
await page.evaluate(() => {
  const c = window._viewer.camera;
  c.setView({ destination: Cesium.Cartesian3.fromDegrees(139.76, 35.71, 9000) });
});
await page.waitForTimeout(2500);
const near = await countDecor();
console.log("near:", JSON.stringify(near));

check("prim: 遠距離で装飾生成", far.prim > 0, `count=${far.prim}`);
check("prim: 近距離で装飾が増加", near.prim > far.prim * 2, `far=${far.prim} near=${near.prim}`);
check("ent: 遠距離で装飾生成", far.ent > 0, `count=${far.ent}`);
check("ent: 近距離で装飾が増加", near.ent > far.ent * 2, `far=${far.ent} near=${near.ent}`);
check("pageerror なし", errors.length === 0, errors.slice(0, 2).join("|"));

console.log(`== ${pass} PASS / ${fail} FAIL ==`);
await browser.close();
process.exit(fail ? 1 : 0);
