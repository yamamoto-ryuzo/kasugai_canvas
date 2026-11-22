const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const b = await chromium.launch({ channel: "chrome", headless: true });
const pg = await b.newPage({ viewport: { width: 1514, height: 913 } });
pg.on("console", m => { if (m.type() === "error") console.log("PAGE_ERR:", m.text().slice(0, 200)); });
pg.on("pageerror", e => console.log("PAGE_EXC:", String(e).slice(0, 300)));
await pg.goto("http://127.0.0.1:8510/gsimaps/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(12000);
const solo = await pg.evaluate(() => {
  const api = window.kasugaiApi;
  for (const l of api.listLayers()) api.setLayerVisible(l.id, /FilledMarker/i.test(String(l.title || l.id)));
  return { fb: typeof api.fitBoundsView, fb2: typeof api.fitBounds };
});
console.log("solo done", JSON.stringify(solo));
await pg.waitForTimeout(800);
const fit = await pg.evaluate(() => {
  try {
    const api = window.kasugaiApi;
    const r = api.fitBoundsView ? api.fitBoundsView(139.70, 35.63402961107414, 139.99, 35.77591509758373)
      : api.fitBounds([139.70, 35.63402961107414, 139.99, 35.77591509758373]);
    return { ok: true, r: String(r) };
  } catch (e) { return { err: String(e), stack: String(e.stack || "").slice(0, 500) }; }
});
console.log("fit", JSON.stringify(fit));
await pg.waitForTimeout(3000);
const st = await pg.evaluate(() => {
  const w = document.querySelector("iframe")?.contentWindow;
  const gmap = w?.GSI?.GLOBALS?.gsimaps?._mainMap?.getMap?.();
  const sk = w?.GSI?.GLOBALS?.gsimaps?._sakuzuList?._list?.find(s => /FilledMarker/i.test(s?._title || ""));
  const inner = sk?._layer?.layer || sk?._layer;
  return {
    zoom: gmap?.getZoom?.(), bounds: gmap?.getBounds?.()?.toBBoxString?.(),
    skOnMap: inner ? gmap.hasLayer(inner) : "no-inner", skVisible: sk?._visible,
  };
});
console.log(JSON.stringify(st, null, 1));
await pg.screenshot({ path: "probe-gsimaps4.png" });
await b.close();
