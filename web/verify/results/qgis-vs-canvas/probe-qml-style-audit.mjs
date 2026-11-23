// probe-qml-style-audit.mjs — /live/kasc の全 style= URL を dev Canvas で
// compileQmlStyle し、warnings を全収集する(実ロード経路・監査用)
// usage: node probe-qml-style-audit.mjs [engine] [canvasPort]
const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const ENGINE = process.argv[2] || "cesium";
const PORT = process.argv[3] || "8520";
const KASC = process.env.KASC_URL || "http://127.0.0.1:8089/live/kasc";

const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage();
await pg.goto(`http://127.0.0.1:${PORT}/${ENGINE}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
const kasc = await (await fetch(KASC)).text();
const styleUrls = [...kasc.matchAll(/style=(\S+)/g)].map(m => m[1]);
const layers = [...kasc.matchAll(/^([a-z0-9_]+): ([^|]+)\|/gmi)].map(m => ({ kind: m[1], title: m[2].trim() }));
const out = await pg.evaluate(async ({ styleUrls, layers }) => {
  const qs = await import("/shared/qml-style.js");
  const res = [];
  for (let i = 0; i < styleUrls.length; i++) {
    const url = styleUrls[i];
    const title = layers.filter(l => url.includes(encodeURIComponent(l.title))).map(l => l.title).pop() || url;
    try {
      const xml = await (await fetch(url)).text();
      const st = qs.compileQmlStyle(xml);
      // 構造情報: レンダラ種別・シンボルクラス・DD有無・ラベル有無
      const rtype = /renderer-v2[^>]*type="([^"]+)"/.exec(xml)?.[1] || null;
      const classes = [...xml.matchAll(/class="([^"]+)"/g)].map(m => m[1]).filter(c => !/^(pal|labeling|layertree|simplify|rendering|customproperties|dualview|preview|codeeditor|blendMode|featureBlendMode|GeometryOptions|renderer|effects|legend|saveOnly|edittypes|attributetableconfig|annotation|aliases|defaults|fieldConfiguration|policy|editable|splitmultiparts|geometryOptions|constraints|fieldEditable|OnUpdate|Default)$/.test(c));
      const ddActive = (xml.match(/"active"[^>]*value="true"/g) || []).length + (xml.match(/name="active" value="1"/g) || []).length;
      const hasLabel = /labelsEnabled="1"|<labeling[^>]+type="pal"/.test(xml);
      res.push({
        title, rtype, classes: [...new Set(classes)], ddActive, hasLabel,
        warnings: st.warnings || [],
        ok: !!st,
      });
    } catch (e) {
      res.push({ title, error: String(e).slice(0, 200) });
    }
  }
  return res;
}, { styleUrls, layers });
let warns = 0;
for (const r of out) {
  if (r.error) { console.log(`ERR  ${r.title}: ${r.error}`); continue; }
  const w = r.warnings?.length || 0;
  warns += w;
  console.log(`${r.error ? "ERR " : "OK  "}${r.title}`);
  console.log(`     renderer=${r.rtype} classes=[${(r.classes || []).join(",")}] dd=${r.ddActive} label=${r.hasLabel} warns=${w}`);
  for (const x of r.warnings || []) console.log(`       ! ${x}`);
}
console.log(`==== layers=${out.length} warnings=${warns} ====`);
await browser.close();
