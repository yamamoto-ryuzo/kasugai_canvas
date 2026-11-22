// 単発プローブ: どの描画コレクションに矩形が残っているか洗い出す
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const CANVAS = "http://127.0.0.1:8510";
const SOLO = process.argv[2] || "qmltest_InterpolatedLine";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 1514, height: 913 } });
await pg.route("**/api/command**", r => r.fulfill({ status: 200, contentType: "application/json", body: '{"commands":[],"latest":0,"ok":true,"results":[]}' }));
await pg.addInitScript(() => {
  window.__rebuildLog = [];
  window.__fetchLog = [];
  const hook = () => {
    const v = window._viewer;
    const ils = v && v.imageryLayers;
    if (ils && !ils.__wrapped) {
      ils.__wrapped = true;
      const orig = ils.removeAll.bind(ils);
      ils.removeAll = function (...a) {
        try { window.__rebuildLog.push([Date.now(), (new Error().stack || "").split("\n").slice(1, 14).join(" | ").slice(0, 1200)]); } catch (_) {}
        return orig(...a);
      };
    }
    const api = window.kasugaiApi;
    if (api && !api.__wrapped) {
      api.__wrapped = true;
      for (const k of Object.keys(api)) {
        const fn = api[k];
        if (typeof fn !== "function" || k.startsWith("_") || k === "on" || k === "emit" || k === "once") continue;
        api[k] = function (...args) {
          try { window.__rebuildLog.push([Date.now(), `API ${k}(${String(args[0] ?? "").slice(0, 30)}) ← ${(new Error().stack || "").split("\n").slice(2, 6).join(" | ").slice(0, 400)}`]); } catch (_) {}
          return fn.apply(this, args);
        };
      }
    }
  };
  setInterval(hook, 50);
  const of = window.fetch;
  window.fetch = function (...a) {
    try {
      const u = String(a[0]?.url || a[0]);
      if (!/\.(js|css|png|jpg|svg|woff)/.test(u) && !/google|gstatic|gsi\.go|cyberjapan|openstreetmap|tile/.test(u))
        window.__fetchLog.push([Date.now(), u.slice(0, 160)]);
    } catch (_) {}
    return of.apply(this, a);
  };
});
await pg.goto(`${CANVAS}/cesium/?project=ProjectFiles`, { waitUntil: "domcontentloaded", timeout: 45000 });
await pg.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0, undefined, { timeout: 60000 });
await pg.waitForFunction(() => window.kasugaiApi.isReady === true, undefined, { timeout: 120000, polling: 1000 }).catch(() => {});
await pg.waitForTimeout(45000); // ロード概算待ち
// solo 適用(compare.mjs と同じ item.visible 方式)
await pg.evaluate((only) => {
  const items = window.kasugaiApi.listLayers();
  const visById = new Map();
  for (const l of items) { const want = String(l.title || l.id) === only; l.visible = want; visById.set(l.id, want); }
  const v = window._viewer;
  for (let i = 0; i < v.dataSources.length; i++) { const d = v.dataSources.get(i); const w = visById.get(d._kasugaiLayerId); if (w !== undefined) d.show = w; }
  for (let i = 0; i < v.scene.primitives.length; i++) { const p = v.scene.primitives.get(i); const w = p && visById.get(p._kasugaiLayerId); if (w !== undefined) p.show = w; }
  for (let i = 1; i < v.imageryLayers.length; i++) { const il = v.imageryLayers.get(i); const w = il && visById.get(il._kasugaiLayerId); if (w !== undefined) il.show = w; }
}, SOLO);
await pg.waitForTimeout(3000);
const dump = await pg.evaluate(() => {
  const v = window._viewer;
  const idTitle = new Map();
  for (const l of window.kasugaiApi.listLayers()) idTitle.set(l.id, String(l.title || l.id));
  const out = { ds: [], prims: [], imgs: [], viewerEnts: 0, groundPrims: 0, ents: [] };
  for (let i = 0; i < v.dataSources.length; i++) {
    const d = v.dataSources.get(i);
    const shown = d.entities.values.filter(e => e.show !== false).length;
    out.ds.push(`${idTitle.get(d._kasugaiLayerId) || d.name || "?"}(id=${d._kasugaiLayerId}) show=${d.show} ents=${d.entities.values.length} shown=${shown}`);
  }
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    out.prims.push(`${idTitle.get(p?._kasugaiLayerId) || "?"}(id=${p?._kasugaiLayerId}) show=${p?.show} cls=${p?.constructor?.name}`);
  }
  for (let i = 0; i < v.imageryLayers.length; i++) {
    const il = v.imageryLayers.get(i);
    out.imgs.push(`[${i}] ${idTitle.get(il?._kasugaiLayerId) || "?"}(id=${il?._kasugaiLayerId}) show=${il?.show} prov=${il?.imageryProvider?.constructor?.name}`);
  }
  out.viewerEnts = v.entities.values.length;
  for (const e of v.entities.values) {
    out.ents.push(`vEnt ${e.id} show=${e.show} poly=${!!e.polygon} rect=${!!e.rectangle}`);
  }
  try { out.groundPrims = v.scene.groundPrimitives?.length ?? -1; } catch (_) { out.groundPrims = -1; }
  return out;
});
console.log(JSON.stringify(dump, null, 1));
const rb = await pg.evaluate(() => (window.__rebuildLog || []).map(([t, s]) => `${new Date(t).toISOString().slice(11, 19)} ${s}`));
const fl = await pg.evaluate(() => (window.__fetchLog || []).map(([t, u]) => `${new Date(t).toISOString().slice(11, 19)} ${u}`));
console.log("rebuilds:\n" + rb.join("\n\n"));
console.log("fetches:\n" + fl.join("\n"));
await pg.screenshot({ path: "probe-solo.png", timeout: 20000 }).catch(() => {});
await browser.close();
