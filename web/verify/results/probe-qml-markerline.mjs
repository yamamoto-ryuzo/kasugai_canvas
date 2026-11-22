// MarkerLine 配置サンプラー(qml-2d.js markerlineDecorSamples)の回帰検証プローブ
// QGIS C++ QgsTemplatedLineSymbolLayerBase
// (renderPolylineInterval/renderPolylineCentral/renderPolylineVertex/
//  renderOffsetVertexAlongLine/markerAngle/_averageAngle) 準拠の期待値を突合
//  実行: node web/verify/results/probe-qml-markerline.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".qml": "application/xml" };

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream" });
    res.end(await readFile(fp));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const D2 = Math.PI / 180;
const results = [];
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 200)));
  await page.goto(`${base}/verify/rec-formats/blank.html`, { waitUntil: "domcontentloaded" });
  const out = await page.evaluate(async (b) => {
    const m = await import(b + "/shared/qml-2d.js");
    const L = (...pts) => ({ getType: () => "LineString", getCoordinates: () => pts });
    const ML = (...parts) => ({ getType: () => "MultiLineString", getCoordinates: () => parts });
    const px = v => v; // テストはマップ単位=px
    const r = [];
    const push = (name, decor, geom) => r.push([name, m.markerlineDecorSamples(geom, decor, px)]);

    push("interval", { placement: "interval", intervalPx: 3 }, L([0, 0], [10, 0]));
    push("interval+offset", { placement: "interval", intervalPx: 3, offsetAlongPx: 2 }, L([0, 0], [10, 0]));
    push("central", { placement: "centralpoint" }, L([0, 0], [6, 0], [6, 8]));
    push("vertex", { placement: "Vertex" }, L([0, 0], [4, 4], [8, 0]));
    push("innervertex", { placement: "innervertices" }, L([0, 0], [4, 4], [8, 0]));
    push("segmentcenter", { placement: "segmentcenter" }, L([0, 0], [6, 0], [6, 8]));
    push("first", { placement: "firstvertex" }, L([0, 0], [10, 0]));
    push("last", { placement: "lastvertex" }, L([0, 0], [10, 0]));
    push("first+off", { placement: "firstvertex", offsetAlongPx: 2 }, L([0, 0], [10, 0]));
    push("last+off", { placement: "lastvertex", offsetAlongPx: 2 }, L([0, 0], [10, 0]));
    push("first+off_over", { placement: "firstvertex", offsetAlongPx: 99 }, L([0, 0], [10, 0]));
    push("ring_vertex", { placement: "Vertex" }, L([0, 0], [4, 0], [4, 4], [0, 4], [0, 0]));
    push("ring_first", { placement: "firstvertex" }, L([0, 0], [4, 0], [4, 4], [0, 4], [0, 0]));
    push("multi_first_every", { placement: "firstvertex", everyPart: true },
      ML([[0, 0], [10, 0]], [[0, 5], [10, 5]]));
    push("multi_first_only", { placement: "firstvertex", everyPart: false },
      ML([[0, 0], [10, 0]], [[0, 5], [10, 5]]));
    push("interval_ring_off", { placement: "interval", intervalPx: 7, offsetAlongPx: 14 },
      L([0, 0], [4, 0], [4, 4], [0, 4], [0, 0])); // total=16, off=14→fmod(14,16)=14

    // ArrowLine: C++ straightArrow/curvedArrow 準拠。
    // HL=2(head_length), HT=1.5(head_thickness=±半幅), W=1(arrow_width), SW=1
    const A = o => ({ kind: "arrowline", headLenPx: 2, headWidthPx: 1.5,
      tailWidthPx: 1, startWidthPx: 1, offsetPx: 0, ...o });
    const arrow = (name, decor, geom) =>
      r.push([name, m.arrowLinePolygonRings(
        geom.getType() === "LineString" ? [geom.getCoordinates()] : geom.getCoordinates(),
        decor, v => v)]);
    arrow("arrow_single", A({ headType: 0, arrowType: 0 }), L([0, 0], [10, 0]));
    arrow("arrow_reversed", A({ headType: 1, arrowType: 0 }), L([0, 0], [10, 0]));
    arrow("arrow_double", A({ headType: 2, arrowType: 0 }), L([0, 0], [10, 0]));
    arrow("arrow_righthalf", A({ headType: 0, arrowType: 2 }), L([0, 0], [10, 0]));
    arrow("arrow_repeated", A({ headType: 0, arrowType: 0, repeated: true }),
      L([0, 0], [10, 0], [10, 10]));
    arrow("arrow_curved", A({ headType: 0, arrowType: 0, curved: true }),
      L([0, 0], [5, 5], [10, 0]));
    arrow("arrow_short", A({ headType: 0, arrowType: 0 }), L([0, 0], [1, 0])); // len<HL
    return r;
  }, base);

  const chk = (name, cond, detail) => {
    results.push([name, cond]);
    if (!cond) console.log(`FAIL ${name} ${detail ?? ""}`);
  };
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
  const pt = (s, x, y) => near(s.x, x) && near(s.y, y);
  const an = (s, deg, eps = 1e-6) => {
    let d = Math.abs(s.angle - deg * D2) % (2 * Math.PI);
    return Math.min(d, 2 * Math.PI - d) < eps;
  };
  const by = n => out.find(o => o[0] === n)?.[1] || [];

  const iv = by("interval");
  chk("interval count", iv.length === 4, `n=${iv.length}`); // d=0,3,6,9
  chk("interval pos", iv.every((s, i) => pt(s, i * 3, 0) && an(s, 0)));

  const io = by("interval+offset");
  chk("interval+offset count", io.length === 3, `n=${io.length}`); // d=2,5,8
  chk("interval+offset pos", io.every((s, i) => pt(s, 2 + i * 3, 0) && an(s, 0)));

  const ce = by("central");
  chk("central count", ce.length === 1); // total=14 → d=7 → (6,1) angle=90°
  chk("central pos+ang", pt(ce[0], 6, 1) && an(ce[0], 90), JSON.stringify(ce));

  const vx = by("vertex");
  chk("vertex count", vx.length === 3, `n=${vx.length}`);
  chk("vertex endpoints ang", an(vx[0], 45) && an(vx[2], -45));
  chk("vertex inner avg ang", an(vx[1], 0, 1e-6) ||
    an(vx[1], 360, 1e-6), `ang=${vx[1]?.angle}`); // ±45°の平均→0°

  const inn = by("innervertex");
  chk("innervertex count", inn.length === 1, `n=${inn.length}`);
  chk("innervertex pos", pt(inn[0], 4, 4));

  const sc = by("segmentcenter");
  chk("segmentcenter count", sc.length === 2, `n=${sc.length}`);
  chk("segmentcenter pos", pt(sc[0], 3, 0) && an(sc[0], 0) && pt(sc[1], 6, 4) && an(sc[1], 90));

  const fv = by("first"), lv = by("last");
  chk("first count+pos", fv.length === 1 && pt(fv[0], 0, 0) && an(fv[0], 0));
  chk("last count+pos", lv.length === 1 && pt(lv[0], 10, 0) && an(lv[0], 0));

  const fo = by("first+off"), lo = by("last+off");
  chk("first+off pos", fo.length === 1 && pt(fo[0], 2, 0) && an(fo[0], 0), JSON.stringify(fo));
  chk("last+off pos", lo.length === 1 && pt(lo[0], 8, 0) && an(lo[0], 0), JSON.stringify(lo));

  const over = by("first+off_over");
  chk("first+off over → none (C++)", over.length === 0, `n=${over.length}`);

  const rv = by("ring_vertex");
  chk("ring vertex count (no dup)", rv.length === 4, `n=${rv.length}`);
  // リング端点 i=0: prev=c[3]=(0,4)→pt, next=c[1]=(4,0) → a1=-90°(上から来る),a2=0°
  chk("ring vertex0 avg ang", rv.length === 4 && an(rv[0], -45), `ang=${rv[0]?.angle}`);

  const rf = by("ring_first");
  chk("ring first count", rf.length === 1 && an(rf[0], -45), JSON.stringify(rf));

  const me = by("multi_first_every"), mo = by("multi_first_only");
  chk("everyPart → 2 parts", me.length === 2, `n=${me.length}`);
  chk("!everyPart → first only", mo.length === 1 && pt(mo[0], 0, 0), `n=${mo.length}`);

  const iro = by("interval_ring_off");
  chk("ring interval off fmod", iro.length === 1 && pt(iro[0], 0, 2) && an(iro[0], -90),
    JSON.stringify(iro)); // d=14 → (0,2) 下降セグメント(次は 21>16 で終了)

  // ---- ArrowLine(C++ straightArrow/curvedArrow/renderPolyline 準拠)
  // straight single: ring = [ (0,.5) (8,.5) (8,1.5) (10,0) (8,-1.5) (8,-.5) (0,-.5) ]
  const as = by("arrow_single")[0] || [];
  chk("arrow single ring", as.length === 7 &&
    pt({ x: as[0][0], y: as[0][1] }, 0, 0.5) && pt({ x: as[1][0], y: as[1][1] }, 8, 0.5) &&
    pt({ x: as[2][0], y: as[2][1] }, 8, 1.5) && pt({ x: as[3][0], y: as[3][1] }, 10, 0) &&
    pt({ x: as[4][0], y: as[4][1] }, 8, -1.5) && pt({ x: as[5][0], y: as[5][1] }, 8, -0.5) &&
    pt({ x: as[6][0], y: as[6][1] }, 0, -0.5), JSON.stringify(as));
  // reversed: [ (0,0) (2,1.5) (2,.5) (10,.5) (10,-.5) (2,-.5) (2,-1.5) ]
  const ar = by("arrow_reversed")[0] || [];
  chk("arrow reversed ring", ar.length === 7 &&
    pt({ x: ar[0][0], y: ar[0][1] }, 0, 0) && pt({ x: ar[1][0], y: ar[1][1] }, 2, 1.5) &&
    pt({ x: ar[2][0], y: ar[2][1] }, 2, 0.5) && pt({ x: ar[3][0], y: ar[3][1] }, 10, 0.5) &&
    pt({ x: ar[4][0], y: ar[4][1] }, 10, -0.5) && pt({ x: ar[5][0], y: ar[5][1] }, 2, -0.5) &&
    pt({ x: ar[6][0], y: ar[6][1] }, 2, -1.5), JSON.stringify(ar));
  // double: [ (0,0) (2,1.5) (2,.5) (8,.5) (8,1.5) (10,0) (8,-1.5) (8,-.5) (2,-.5) (2,-1.5) ]
  const ad = by("arrow_double")[0] || [];
  chk("arrow double ring", ad.length === 10 &&
    pt({ x: ad[0][0], y: ad[0][1] }, 0, 0) && pt({ x: ad[1][0], y: ad[1][1] }, 2, 1.5) &&
    pt({ x: ad[4][0], y: ad[4][1] }, 8, 1.5) && pt({ x: ad[5][0], y: ad[5][1] }, 10, 0) &&
    pt({ x: ad[9][0], y: ad[9][1] }, 2, -1.5), JSON.stringify(ad));
  // righthalf(arrow_type=2): 右半のみ → [ (0,.5) (8,.5) (8,1.5) (10,0) (0,0) ]
  const ah = by("arrow_righthalf")[0] || [];
  chk("arrow right half", ah.length === 5 &&
    pt({ x: ah[0][0], y: ah[0][1] }, 0, 0.5) && pt({ x: ah[3][0], y: ah[3][1] }, 10, 0) &&
    pt({ x: ah[4][0], y: ah[4][1] }, 0, 0), JSON.stringify(ah));
  // repeated straight: 2 セグメント → 2 ポリゴン
  const arp = by("arrow_repeated");
  chk("arrow repeated count", arp.length === 2, `n=${arp.length}`);
  chk("arrow repeated seg2 tip", arp.length === 2 &&
    pt({ x: arp[1][3][0], y: arp[1][3][1] }, 10, 10), JSON.stringify(arp[1]));
  // curved: 3点外接円弧。非共線 → 弧上リング(点数>直線の7)
  const ac = by("arrow_curved")[0] || [];
  chk("arrow curved arc ring", ac.length > 10, `n=${ac.length}`);
  // curved tip は pd=(10,0) を含む
  chk("arrow curved tip", ac.some(p => pt({ x: p[0], y: p[1] }, 10, 0)), JSON.stringify(ac.slice(-6)));
  // len<HL → C++ は po を延長(body=0)して矢頭のみ: pd=(1,0)・po=(-1,0)
  // ring=[(-1,.5),(-1,.5),(-1,1.5),(1,0),(-1,-1.5),(-1,-.5),(-1,-.5)] (7点・重複あり)
  const ash = by("arrow_short")[0] || [];
  chk("arrow short → head only", ash.length === 7 &&
    pt({ x: ash[3][0], y: ash[3][1] }, 1, 0) && pt({ x: ash[0][0], y: ash[0][1] }, -1, 0.5) &&
    pt({ x: ash[2][0], y: ash[2][1] }, -1, 1.5), JSON.stringify(ash));
} finally {
  await browser?.close();
  srv.close();
}
const pass = results.filter(r => r[1]).length;
console.log(`${pass}/${results.length} PASS`);
if (pass !== results.length) process.exit(1);
console.log(`==== ${pass}/${results.length} PASS ====`);
