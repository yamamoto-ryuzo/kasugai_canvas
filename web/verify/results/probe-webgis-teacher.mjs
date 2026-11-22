// 副教師データ(QWC2 expr_grammar / Lizmap)由来の QML 式評価強化の回帰検証プローブ
// 機能追加・qml-style.js 式評価器変更の度に実行する(skill: qml-webgis-teacher)
//  実行: node web/verify/results/probe-webgis-teacher.mjs
//  期待値: 実機 QGIS 4.0.1 の QgsExpression 採取値(2026-11-22 採取・スキル添付 tmp_pyeval.py 由来)
//  カバレッジ:
//   A) 演算子: `//` 整数除算(床除算・負数含む) / `~` 正規表現 / 汎用 IS・IS NOT
//   B) 関数: array_* 18種 / map 系 / generate_series / regexp_matches /
//      attribute 2形態 / current_value / pow(superset)
//   C) レイヤー横断参照(get_feature系)のリゾルバ未注入時 null フォールバック
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
    const data = await readFile(fp);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m && (m[1] || m[2])) {
        const start = m[1] === "" ? Math.max(data.length - Number(m[2]), 0) : Number(m[1]);
        const end = m[1] === "" || !m[2] ? data.length - 1 : Number(m[2]);
        res.writeHead(206, { "content-type": MIME[extname(q)] || "application/octet-stream",
          "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${data.length}` });
        res.end(data.subarray(start, end + 1));
        return;
      }
    }
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream",
      "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

// [式, 期待値, props] — 期待値は実機 QGIS 採取値(JS 型に正規化)
const CASES = [
  ["7 // 2", 3], ["-7 // 2", -4], ["7 // -2", -4], ["-7 // -2", 3], ["7.5 // 2", 3],
  ["'abc' ~ 'b'", true], ["'abc' ~ '^b'", false], ["'abc' ~ 'B'", false],
  ["'abc' ~ 'a.c'", true],
  ["'a' IS 'a'", true], ["'a' IS NOT 'b'", true], ["'a' IS 'b'", false],
  ["array_count(array(1,2,2,3))", 4], // QGIS: array_count(array)=要素数(1引数)
  ["array_all(array(1,2,3),array(1,2))", true],
  ["array_all(array(1,2,3),array(1,4))", false],
  ["array_filter(array(1,2,3),@element>1)", [2, 3]],
  ["array_filter(array(1,2,3),@element%2=1)", [1, 3]],
  ["array_foreach(array(1,2,3),@element*10)", [10, 20, 30]],
  ["array_foreach(array('a','b'),@element||'_x')", ["a_x", "b_x"]],
  ["array_filter(array(1,2,3),@element>1 AND @element<3)", [2]],
  ["with_variable('n',3,generate_series(1,@n))", [1, 2, 3]],
  ["with_variable('x',5,@x*2)", 10],
  ["array_find(array('a','b','c'),'c')", 2],
  ["array_find(array('a','b','c'),'z')", -1],
  ["array_insert(array(1,2),1,9)", [1, 9, 2]],
  ["array_intersect(array(1,2),array(2,3))", true],
  ["array_intersect(array(1,2),array(4,5))", false],
  ["array_max(array(3,1,4))", 4], ["array_min(array(3,1,4))", 1],
  ["array_mean(array(3,1,4))", 8 / 3],
  ["array_median(array(3,1,4,2))", 2.5], ["array_median(array(3,1,4))", 3],
  ["array_sum(array(3,1,4))", 8],
  ["array_prioritize(array('a','b','c'),array('c','a'))", ["c", "a", "b"]],
  ["array_remove_all(array(1,2,1,3),1)", [2, 3]],
  ["array_remove_at(array(1,2,3),1)", [1, 3]],
  ["array_replace(array(1,2,1),1,9)", [9, 2, 9]],
  ["array_replace(array('a','b'),map('a','x'))", ["x", "b"]],
  ["generate_series(1,5)", [1, 2, 3, 4, 5]],
  ["generate_series(1,10,3)", [1, 4, 7, 10]],
  ["generate_series(5,1,-2)", [5, 3, 1]],
  ["map_get(map('a',1,'b',2),'b')", 2],
  ["map_akeys(map('a',1,'b',2))", ["a", "b"]],
  ["map_avals(map('a',1,'b',2))", [1, 2]],
  ["map_exist(map('a',1),'a')", true],
  ["map_get(map_insert(map('a',1),'c',3),'c')", 3],
  ["map_akeys(map_delete(map('a',1,'b',2),'b'))", ["a"]],
  ["map_get(map_concat(map('a',1),map('b',2)),'b')", 2],
  ["regexp_matches('hello','l+')", []],
  ["regexp_matches('hello','(l+)(o)')", ["ll", "o"]],
  ["pow(2,3)", 8], // superset: QGIS 4.0.1 は pow() 非実装(QWC2 独自関数)
  ["current_value('x')", 42, { x: 42 }],
  ["attribute('x')", 7, { x: 7 }],
  ["attribute(current_value('f'),'x')", null, { f: null }],
  ["get_feature('L','a',1)", null], // リゾルバ未注入 → null + 警告
  ["get_feature_by_id('L',1)", null],
  ["7 // 0", null], // ゼロ除算 → NULL
];

const results = [];
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 200)));
  // 同一オリジンの実ページ上で動的 import(about:blank は opaque origin で失敗する)
  await page.goto(`${base}/verify/rec-formats/blank.html`, { waitUntil: "domcontentloaded" });
  const got = await page.evaluate(async ([b, cases]) => {
    const m = await import(b + "/shared/qml-style.js");
    const eq = m.evalQgisExpression;
    const out = [];
    for (const [src, exp, props] of cases) {
      let v, err = null;
      try { v = eq(src, props ?? {}); } catch (e) { err = String(e); }
      out.push([src, err ?? (v === undefined ? null : v)]);
    }
    return out;
  }, [base, CASES]);
  const norm = v => (typeof v === "number" && Number.isFinite(v)) ? v
    : (Array.isArray(v) ? JSON.stringify(v) : (v && typeof v === "object" ? JSON.stringify(v) : v));
  for (let i = 0; i < CASES.length; i++) {
    const [src, expected] = CASES[i];
    const [, actual] = got[i];
    let ok;
    if (typeof expected === "number" && typeof actual === "number") {
      ok = Math.abs(actual - expected) < 1e-9;
    } else if (Array.isArray(expected)) {
      ok = JSON.stringify(actual) === JSON.stringify(expected);
    } else {
      ok = actual === expected;
    }
    results.push([src, expected, actual, ok]);
    if (!ok) console.log(`FAIL ${src}  expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
  }
} finally {
  await browser?.close();
  srv.close();
}
const pass = results.filter(r => r[3]).length;
console.log(`${pass}/${results.length} PASS`);
if (pass !== results.length) process.exit(1);
console.log(`==== ${pass}/${results.length} PASS ====`);
