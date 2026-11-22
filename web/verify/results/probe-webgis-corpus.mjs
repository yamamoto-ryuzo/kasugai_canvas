// 実コーパス(.qgs 由来の .qml 群)に対する compileQmlStyle warnings 監査プローブ
// 副教師コーパスや実機エクスポートの canvas_data/*.qml を走査し、
// レンダラ種別・シンボルレイヤ・warnings をファイル別に行列化する
// (skill: qml-webgis-corpus)
//  実行: node web/verify/results/probe-webgis-corpus.mjs "<canvas_data dir>"
//  例:   node web/verify/results/probe-webgis-corpus.mjs "C:/.../demoqgis/canvas_data"
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");

const CORPUS = resolve(process.argv[2] || ".");
const WEB = fileURLToPath(new URL("../..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript",
  ".qml": "application/xml", ".json": "application/json" };

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    const root = p.startsWith("/corpus/") ? CORPUS : WEB;
    const rel = p.startsWith("/corpus/") ? p.slice(7) : p;
    const fp = resolve(join(root, rel));
    if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(rel)] || "application/octet-stream",
      "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const files = (await readdir(CORPUS)).filter(f => f.endsWith(".qml")).sort();
if (!files.length) { console.log("no .qml in corpus dir"); srv.close(); process.exit(1); }

let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
try {
  const page = await browser.newPage();
  await page.goto(`${base}/verify/rec-formats/blank.html`, { waitUntil: "domcontentloaded" });
  const rows = await page.evaluate(async ([b, list]) => {
    const m = await import(b + "/shared/qml-style.js");
    const out = [];
    for (const f of list) {
      let xml;
      const qmlUrl = b + "/corpus/" + encodeURIComponent(f);
      try { xml = await (await fetch(qmlUrl)).text(); }
      catch (e) { out.push({ f, err: "fetch:" + e }); continue; }
      // 実経路(loadQmlStyle)と同じ画像事前ロード込みでコンパイルする
      // (SVG 等の代替警告を発生させないため compileQmlStyle 直叩きは不可)
      let c;
      try {
        c = await m.loadQmlStyle(qmlUrl, async u => await (await fetch(u)).text());
      } catch (e) { out.push({ f, err: "compile:" + String(e).slice(0, 160) }); continue; }
      // レンダラ種別・シンボルレイヤ・ラベル有無は XML 側から採取(正確)
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const rends = [...doc.querySelectorAll("renderer-v2")].map(e => e.getAttribute("type"));
      const symLayers = [...doc.querySelectorAll("symbol > layer")].map(e =>
        (e.getAttribute("class") || "?") + (e.getAttribute("enabled") === "0" ? "(off)" : ""));
      const labeling = doc.querySelector("qgis")?.getAttribute("labelsEnabled");
      const fm = c.fields || {};
      out.push({
        f,
        renderers: [...new Set(rends)],
        symLayers: [...new Set(symLayers)],
        label: labeling === "1",
        meta: [fm.displayExpr && "dispExpr", fm.mapTip && "mapTip",
               Object.keys(fm.alias || {}).length && "alias", fm.hidden?.size && "hidden"].filter(Boolean),
        warnings: [...new Set(c.warnings || [])],
      });
    }
    return out;
  }, [base, files]);

  let warnFiles = 0, errFiles = 0;
  const warnKinds = new Map();
  for (const r of rows) {
    if (r.err) {
      errFiles++;
      console.log(`ERR  ${r.f}: ${r.err}`);
      continue;
    }
    const w = r.warnings.length;
    if (w) warnFiles++;
    for (const x of r.warnings) {
      const k = x.replace(/^.*?: /, "").slice(0, 90);
      warnKinds.set(k, (warnKinds.get(k) || 0) + 1);
    }
    console.log(`${w ? "WARN" : "OK  "} ${r.f}  ren=[${r.renderers.join(",")}]` +
      ` sym=[${r.symLayers.join(",")}] label=${r.label ? 1 : 0}` +
      ` meta=[${(r.meta || []).join(",")}] warnings=${w}`);
  }
  console.log("---- warnings 内訳 ----");
  for (const [k, n] of [...warnKinds.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}x ${k}`);
  }
  console.log(`==== ${files.length - warnFiles - errFiles}/${files.length} 完全対応,` +
    ` warn=${warnFiles}, err=${errFiles} ====`);
} finally {
  await browser?.close();
  srv.close();
}
