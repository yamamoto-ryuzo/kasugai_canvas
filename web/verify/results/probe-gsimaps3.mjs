const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const b = await chromium.launch({ channel: "chrome", headless: true });
const pg = await b.newPage({ viewport: { width: 1514, height: 913 } });
await pg.goto("http://127.0.0.1:8510/gsimaps/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(12000);
const r = await pg.evaluate(() => new Promise(res => {
  const api = window.kasugaiApi;
  const w = document.querySelector("iframe")?.contentWindow;
  const gm = w?.GSI?.GLOBALS?.gsimaps;
  const gmap = gm?._mainMap?.getMap?.();
  const countGeo = () => {
    let geo = 0, other = {};
    if (gmap?._layers) for (const k in gmap._layers) {
      const n = gmap._layers[k].constructor?.name || "?";
      other[n] = (other[n] || 0) + 1;
      if (/geojson|sakuzu/i.test(n)) geo++;
    }
    return { geo, other };
  };
  const out = { gm: !!gm, gmap: !!gmap, zoom: gmap?.getZoom?.(), center: gmap?.getCenter?.() };
  out.before = countGeo();
  const sakuzu = gm?._sakuzuList;
  out.sakuzuItems = sakuzu?._list?.length;
  const sk = sakuzu?._list?.find(s => /FilledMarker/i.test(s?._title || s?.title || ""));
  out.skFound = !!sk;
  if (sk) {
    out.skVisBefore = sk._visible;
    // 実レイヤが地図に載っているか
    const inner = sk._layer?.layer || sk._layer;
    out.skOnMapBefore = inner ? gmap.hasLayer(inner) : "no-inner";
    try { sk.setVisible(false); } catch (e) { out.e1 = String(e); }
    setTimeout(() => {
      out.skOnMapAfterOff = inner ? gmap.hasLayer(inner) : "no-inner";
      try { sk.setVisible(true); } catch (e) { out.e2 = String(e); }
      setTimeout(() => {
        out.skOnMapAfterOn = inner ? gmap.hasLayer(inner) : "no-inner";
        out.after = countGeo();
        res(out);
      }, 800);
    }, 400);
  } else res(out);
}));
console.log(JSON.stringify(r, null, 1).slice(0, 3000));
await pg.screenshot({ path: "probe-gsimaps3.png" });
await b.close();
