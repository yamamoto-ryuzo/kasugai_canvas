const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const b = await chromium.launch({ channel: "chrome", headless: true });
const pg = await b.newPage({ viewport: { width: 1514, height: 913 } });
await pg.goto("http://127.0.0.1:8510/gsimaps/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(12000);
const r = await pg.evaluate(() => {
  const api = window.kasugaiApi;
  const w = document.querySelector("iframe")?.contentWindow;
  const doc = w.document;
  const gmap = w?.GSI?.GLOBALS?.gsimaps?._mainMap?.getMap?.();
  const out = {};
  // solo FilledMarker
  for (const l of api.listLayers()) api.setLayerVisible(l.id, /FilledMarker/i.test(String(l.title || l.id)));
  const sakuzu = w.GSI.GLOBALS.gsimaps._sakuzuList;
  const sk = sakuzu._list.find(s => /FilledMarker/i.test(s?._title || ""));
  const inner = sk?._layer?.layer || sk?._layer;
  out.innerCtor = inner?.constructor?.name;
  out.innerOnMap = inner ? gmap.hasLayer(inner) : null;
  // inner の構造: G.GeoJSON ラッパー内部の L.GeoJSON
  out.innerKeys = inner ? Object.keys(inner).slice(0, 20) : [];
  const lgeo = inner?.layer || inner;
  out.lgeoCtor = lgeo?.constructor?.name;
  // SVG path / canvas / marker DOM
  out.svgPaths = doc.querySelectorAll("svg path").length;
  out.leafletMarkers = doc.querySelectorAll(".leaflet-marker-icon").length;
  out.canvasEls = doc.querySelectorAll("canvas").length;
  // inner 配下のサブレイヤ
  try {
    let subs = 0;
    lgeo.eachLayer?.(() => subs++);
    out.subLayers = subs;
  } catch (e) { out.subErr = String(e); }
  // sakuzu リストの表示状態
  out.sakuzuVisible = sakuzu._list.filter(s => s._visible !== false).map(s => s._title || s.title).slice(0, 10);
  // GSI sakuzu 描画ペイン
  out.panes = Object.keys(gmap?._panes || {});
  return out;
});
console.log(JSON.stringify(r, null, 1).slice(0, 3500));
await b.close();
