const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await pg.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles", { waitUntil: "domcontentloaded", timeout: 45000 });
await pg.waitForFunction(() => window._viewer && window.kasugaiApi && window.kasugaiApi.listLayers().length > 0, null, { timeout: 120000 });
await pg.waitForTimeout(8000);
const want = process.argv[2] || "qmltest_Lineburst";
// proper solo via item.visible + ds.show (same as compare.mjs)
await pg.evaluate((want) => {
  const v = window._viewer;
  const items = window.kasugaiApi.listLayers();
  const visById = new Map();
  for (const l of items) { const w = String(l.title||l.id) === want; l.visible = w; visById.set(l.id, w); }
  for (let i = 0; i < v.dataSources.length; i++) {
    const d = v.dataSources.get(i);
    const w = visById.get(d._kasugaiLayerId);
    if (w !== undefined) d.show = w;
  }
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    const w = p && visById.get(p._kasugaiLayerId);
    if (w !== undefined) p.show = w;
  }
  for (let i = 0; i < v.imageryLayers.length; i++) v.imageryLayers.get(i).show = false;
  v.scene.backgroundColor = Cesium.Color.WHITE;
}, want);
// flyTo target ds
await pg.evaluate((want) => {
  const v = window._viewer;
  const items = window.kasugaiApi.listLayers();
  const idTitle = new Map(items.map(l => [l.id, l.title]));
  for (let i = 0; i < v.dataSources.length; i++) {
    const d = v.dataSources.get(i);
    if (idTitle.get(d._kasugaiLayerId) === want) { v.flyTo(d, {duration:0}); return; }
  }
}, want);
await pg.waitForTimeout(5000);
await pg.screenshot({ path: `diag-${want}-clamped.png` });
// dump aux graphics flags + flip clamp off
const st = await pg.evaluate((want) => {
  const v = window._viewer;
  const items = window.kasugaiApi.listLayers();
  const idTitle = new Map(items.map(l => [l.id, l.title]));
  let flipped = 0, flags = null;
  for (let i = 0; i < v.dataSources.length; i++) {
    const d = v.dataSources.get(i);
    if (idTitle.get(d._kasugaiLayerId) !== want) continue;
    for (const e of d.entities.values) {
      const gr = e.polyline; if (!gr) continue;
      if (gr.show?.getValue?.() === false) continue;
      if (!flags) flags = {
        clamp: gr.clampToGround?.getValue?.(),
        arcType: gr.arcType?.getValue?.(),
        ddc: String(gr.distanceDisplayCondition?.getValue?.() ?? "none"),
        clsType: String(gr.classificationType?.getValue?.()),
        zIndex: gr.zIndex?.getValue?.(),
        matType: gr.material?.constructor?.name,
        width: gr.width?.getValue?.(),
      };
      gr.clampToGround = new Cesium.ConstantProperty(false);
      flipped++;
    }
  }
  v.scene.requestRender?.();
  return { flipped, flags };
}, want);
console.log(JSON.stringify(st));
await pg.waitForTimeout(3000);
await pg.screenshot({ path: `diag-${want}-unclamped.png` });
await browser.close();
