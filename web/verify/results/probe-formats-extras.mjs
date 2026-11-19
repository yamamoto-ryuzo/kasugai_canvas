// 検証: フォローアップ10項目
//   csv RFC4180 / BOM 除去 / esrijson 非WGS84 警告 / wkb SRID 警告+曲線 /
//   shp .prj 欠落警告 / wfs パラメータ / cms ページ回収 / gpx time / igc 高度
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const CD = `${BASE}/projects/format_test/canvas_data`;
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + String(detail).slice(0, 160) : ""}`);
};

try {
  await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
  const r = await page.evaluate(async (CD) => {
    const vl = await import("../shared/vector-load.js");
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(" ")); origWarn.apply(console, a); };
    const load = async (it) => {
      try {
        const r = await vl.loadVectorItem(it, "", null);
        return { n: r.geojson.features.length, fc: r.geojson };
      } catch (e) { return { error: String(e) }; }
    };
    const out = {};
    // 2. CSV クォート
    out.csv = await load({ type: "csv", title: "csv", url: `${CD}/quoted.csv` });
    // 3. BOM
    out.bomCsv = await load({ type: "csv", title: "bcsv", url: `${CD}/bom.csv` });
    out.bomL = await load({ type: "geojsonl", title: "bl", url: `${CD}/bom.geojsonl` });
    out.bomW = await load({ type: "wkt", title: "bw", url: `${CD}/bom.wkt` });
    // 1. esrijson 非WGS84
    warns.length = 0;
    out.esri = await load({ type: "esrijson", title: "e", url: `${CD}/field3857.esrijson` });
    out.esriWarns = warns.slice();
    // 4. wkb SRID
    warns.length = 0;
    out.wkb = await load({ type: "wkb", title: "w", url: `${CD}/pt3857.wkb` });
    out.wkbWarns = warns.slice();
    // 5. shp .prj 欠落/あり
    warns.length = 0;
    out.shpNoPrj = await load({ type: "shp", title: "s", url: `${CD}/nopj_shp.zip` });
    out.shpNoPrjWarns = warns.slice();
    warns.length = 0;
    out.shpPrj = await load({ type: "shp", title: "s", url: `${CD}/withprj_shp.zip` });
    out.shpPrjWarns = warns.slice();
    // 7. wfs (静的サーバ=クエリ無視。count>全件なら1頁打ち止め)
    out.wfs = await load({ type: "wfs", title: "w", url: `${CD}/fake_wfs.geojson`, opts: { typename: "t", bbox: "139,35,140,36", propertyname: "id,name", count: "100", paging: "auto" } });
    // 8. cms (item.cms 直接指定。page= 無視サーバ → 重複検出で停止・重複なし)
    out.cms = await load({ type: "geojson", title: "c", url: `${CD}/fake_wfs.geojson`, cms: true });
    // 9. gpx time
    out.gpx = await load({ type: "gpx", title: "g", url: `${CD}/track_time.gpx` });
    // 10. igc 高度
    out.igc = await load({ type: "igc", title: "i", url: `${CD}/flight.igc` });
    return out;
  }, CD);

  const f = k => r[k]?.fc?.features || [];
  // CSV
  check("csv.quote.count", f("csv").length === 3, `n=${r.csv.n}`);
  const p0 = f("csv")[0]?.properties || {};
  check("csv.quote.comma", p0.name === "comma, inc.", `name=${p0.name}`);
  check("csv.quote.escq", p0.desc === 'says "hi"', `desc=${p0.desc}`);
  check("csv.quote.lonlat", f("csv")[0]?.geometry?.coordinates?.[0] === 139.767, JSON.stringify(f("csv")[0]?.geometry));
  const p2 = f("csv")[2]?.properties || {};
  check("csv.quote.multiline", p2.name === "multi\nline", `name=${JSON.stringify(p2.name)}`);
  // BOM
  check("bom.csv", f("bomCsv").length === 2 && f("bomCsv")[0]?.properties?.name === "A", `n=${r.bomCsv.n}`);
  check("bom.geojsonl", f("bomL").length === 2, `n=${r.bomL.n}`);
  check("bom.wkt", f("bomW").length === 2, `n=${r.bomW.n}`);
  // esrijson
  check("esrijson.warn", r.esriWarns.some(w => /非 WGS84|wkid=3857/.test(w)), r.esriWarns.join(" | "));
  check("esrijson.convert", f("esri").length === 1, `n=${r.esri.n}`);
  // wkb
  check("wkb.srid.warn", r.wkbWarns.some(w => /SRID=3857/.test(w)), r.wkbWarns.join(" | "));
  check("wkb.geom", f("wkb")[0]?.geometry?.type === "Point", JSON.stringify(f("wkb")[0]?.geometry));
  // shp
  check("shp.noprj.warn", r.shpNoPrjWarns.some(w => /\.prj/.test(w)), r.shpNoPrjWarns.join(" | "));
  check("shp.noprj.load", f("shpNoPrj").length >= 1, `n=${r.shpNoPrj.n} err=${r.shpNoPrj.error || "-"}`);
  check("shp.prj.nowarn", !r.shpPrjWarns.some(w => /\.prj/.test(w)), r.shpPrjWarns.join(" | "));
  check("shp.prj.load", f("shpPrj").length >= 1, `n=${r.shpPrj.n} err=${r.shpPrj.error || "-"}`);
  // wfs
  check("wfs.load", f("wfs").length === 3, `n=${r.wfs.n} err=${r.wfs.error || "-"}`);
  // cms
  check("cms.nodup", f("cms").length === 3, `n=${r.cms.n} (重複回収なら >3)`);
  // gpx time
  const track = f("gpx").find(g => g.geometry?.type === "LineString");
  check("gpx.time", !!track?.properties?.time, `time=${track?.properties?.time}`);
  // igc
  const line = f("igc").find(g => g.geometry?.type === "LineString");
  const hasZ = line && line.geometry.coordinates.some(c => c.length >= 3 && typeof c[2] === "number");
  check("igc.z", !!hasZ, `first3=${JSON.stringify(line?.geometry?.coordinates?.slice(0, 3))}`);
  check("igc.alt.prop", Array.isArray(line?.properties?.alt) && line.properties.alt.some(a => a != null), `alt=${JSON.stringify(line?.properties?.alt?.slice(0, 4))}`);
} catch (e) {
  console.log("PROBE FAILED", String(e).slice(0, 300));
}
const nPass = results.filter(x => x.ok).length;
console.log(`\n==== ${nPass}/${results.length} PASS ====`);
await browser.close();
process.exit(nPass === results.length ? 0 : 1);
