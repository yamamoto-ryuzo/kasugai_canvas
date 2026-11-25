// diag-invisible.mjs — ents>0 なのに画面が空白の層(GeomGen_line / Lineburst)の
// エンティティ中身を調べる。usage: node diag-invisible.mjs [layer[,layer...]]
const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage({ viewport: { width: 1400, height: 800 } });
pg.on("console", m => { const t = m.text(); if (/QML|error|warn/i.test(t)) console.log("[pg]", t.slice(0, 300)); });
await pg.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles", { waitUntil: "domcontentloaded", timeout: 45000 });
await pg.waitForFunction(() => window._viewer && window.kasugaiApi && window.kasugaiApi.listLayers().length > 0, null, { timeout: 120000 });
await pg.waitForTimeout(8000);

const wants = process.argv.slice(2);
const list = wants.length ? wants : ["qmltest_GeomGen_line", "qmltest_Lineburst"];
for (const want of list) {
  const info = await pg.evaluate((want) => {
    const v = window._viewer;
    const items = window.kasugaiApi.listLayers();
    const idTitle = new Map(items.map(l => [l.id, l.title]));
    const out = { want, found: [] };
    for (let i = 0; i < v.dataSources.length; i++) {
      const d = v.dataSources.get(i);
      const title = idTitle.get(d._kasugaiLayerId);
      if (title !== want) continue;
      const rec = { dsShow: d.show, ents: [] };
      for (const e of d.entities.values) {
        const g = {};
        for (const k of ["polyline", "polygon", "billboard", "label", "point", "model", "ellipse", "corridor", "rectangle", "box", "path", "polylineVolume"]) {
          const gr = e[k];
          if (!gr) continue;
          const gg = { show: gr.show?.getValue?.() };
          try {
            if (k === "polyline") {
              const pos = gr.positions?.getValue?.() || [];
              gg.npos = pos.length;
              gg.first = pos[0] ? [pos[0].x, pos[0].y, pos[0].z].map(n => +(+n).toFixed(2)) : null;
              gg.width = gr.width?.getValue?.();
              gg.clamp = gr.clampToGround?.getValue?.();
              gg.arcType = gr.arcType?.getValue?.();
              const m = gr.material;
              gg.material = m?.color?.getValue?.() ? String(m.color.getValue()) : String(m?.getValue?.() || m?.constructor?.name);
            } else if (k === "polygon") {
              const h = gr.hierarchy?.getValue?.();
              gg.npos = h?.positions?.length ?? -1;
              gg.first = h?.positions?.[0] ? [h.positions[0].x, h.positions[0].y, h.positions[0].z].map(n => +(+n).toFixed(2)) : null;
              const m = gr.material;
              gg.material = m?.color?.getValue?.() ? String(m.color.getValue()) : String(m?.constructor?.name);
              gg.outline = gr.outline?.getValue?.();
              gg.outlineColor = String(gr.outlineColor?.getValue?.() || "");
              gg.height = gr.height?.getValue?.();
            } else if (k === "billboard" || k === "point" || k === "label") {
              gg.pos = e.position?.getValue?.() ? [e.position.getValue().x, e.position.getValue().y, e.position.getValue().z].map(n => +(+n).toFixed(2)) : null;
              if (k === "point") gg.color = String(gr.color?.getValue?.() || "");
              if (k === "billboard") { gg.image = String(gr.image?.getValue?.() || "").slice(0, 120); gg.scale = gr.scale?.getValue?.(); }
            } else {
              gg.pos = e.position?.getValue?.() ? String(e.position.getValue()).slice(0, 80) : null;
            }
          } catch (err) { gg.err = String(err).slice(0, 120); }
          g[k] = gg;
        }
        rec.ents.push({ id: e.id, show: e.show, graphics: g });
      }
      out.found.push(rec);
    }
    return out;
  }, want);
  console.log("=== " + want + " ===");
  for (const rec of info.found) {
    console.log(` dsShow=${rec.dsShow} ents=${rec.ents.length}`);
    for (const e of rec.ents.slice(0, 6)) console.log("  " + JSON.stringify(e).slice(0, 600));
    if (rec.ents.length > 6) console.log(`  ... +${rec.ents.length - 6} more`);
  }
  if (!info.found.length) console.log("  (no datasource)");
}
await browser.close();
