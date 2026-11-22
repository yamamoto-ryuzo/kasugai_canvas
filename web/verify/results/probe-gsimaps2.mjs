const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const b = await chromium.launch({ channel: "chrome", headless: true });
const pg = await b.newPage({ viewport: { width: 1514, height: 913 } });
await pg.goto("http://127.0.0.1:8510/gsimaps/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(12000);
const r = await pg.evaluate(() => {
  const api = window.kasugaiApi;
  const L = api.listLayers().find(l => String(l.title || l.id).includes("FilledMarker"));
  const out = { id: L?.id, title: L?.title, visible: L?.visible };
  // 内部の sakuzu / gmap を探す
  const w = document.querySelector("iframe")?.contentWindow;
  out.iframeG = !!w?.G;
  out.iframeL = !!w?.L;
  try {
    const gmap = w?.CONFIG?.mapObject || w?.G?.map || null;
    out.gmapFound = !!gmap;
    if (gmap?._layers) {
      const kinds = {};
      let geojsonLayers = 0;
      for (const k in gmap._layers) {
        const ly = gmap._layers[k];
        const n = ly.constructor?.name || "?";
        kinds[n] = (kinds[n] || 0) + 1;
        if (/geojson/i.test(n)) geojsonLayers++;
      }
      out.kinds = kinds; out.geojsonLayers = geojsonLayers;
    }
  } catch (e) { out.err = String(e); }
  // 対象を off→on して実体が地図へ戻るか
  api.setLayerVisible(L.id, false);
  return new Promise(res => setTimeout(() => {
    api.setLayerVisible(L.id, true);
    setTimeout(() => {
      try {
        const gmap = w?.CONFIG?.mapObject || w?.G?.map;
        let geo = 0;
        if (gmap?._layers) for (const k in gmap._layers) if (/geojson/i.test(gmap._layers[k].constructor?.name || "")) geo++;
        out.afterToggleGeo = geo;
      } catch (e) { out.err2 = String(e); }
      res(out);
    }, 1500);
  }, 800));
});
console.log(JSON.stringify(r, null, 1).slice(0, 3000));
await pg.screenshot({ path: "probe-gsimaps2.png" });
await b.close();
