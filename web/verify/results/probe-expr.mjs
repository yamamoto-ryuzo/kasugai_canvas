// 式関数・演算子の回帰スモーク(ブラウザ内)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const BASE = "http://127.0.0.1:8510";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", e => console.log("[err]", String(e).slice(0, 200)));
await page.goto(`${BASE}/cesium/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const cases = [
  // @変数・if・論理
  ["if(@map_scale>=5000, 1.2, 5.0)", null, 2500],
  ["@map_scale", null, 2500],
  ["var('map_scale')", null, 2500],
  ['"A" = \'x\' AND NOT "B" IS NULL', { A: "x", B: 1 }],
  ["1=1 OR 1=2", null],
  ["NOT (1=2)", null],
  // 非クオート識別子 + 比較(クラス修正の回帰)
  ["foo>=5", { foo: 7 }],
  ["foo-3", { foo: 10 }],
  ["foo,bar", null], // 構文崩れでなく null
  // 数値
  ["abs(-3)", null], ["ceil(1.2)", null], ["sign(-5)", null], ["log2(8)", null],
  ["clamp(0,7,10)", null], ["min(3,1,2)", null], ["max(3,1,2)", null],
  ["scale_exp(5,0,10,0,100,2)", null],
  // 文字列
  ["lower('AbC')", null], ["upper('ab')", null], ["title('a b')", null],
  ["length('abc')", null], ["substr('abcdef',2,3)", null],
  ["strpos('abcdef','cd')", null], ["replace('a-b-c','-','+')", null],
  ["trim('  x  ')", null], ["lpad('5',3,'0')", null], ["rpad('5',3,'0')", null],
  ["concat('a',1,'b')", null], ["format('%1-%2','x',9)", null],
  ["format_number(12345.678,2)", null], ["char(65)", null], ["unicode('A')", null],
  ["wordwrap('aa bb cc', 4)", null],
  // 変換
  ["to_int('42')", null], ["to_real('3.5')", null], ["to_string(42)", null],
  ["toint('7')", null],
  // 日付
  ["year('2024-03-05')", null], ["month('2024-03-05')", null],
  ["day_of_week('2024-03-05')", null], ["week('2024-03-05')", null],
  ["format_date(to_date('2024-03-05'),'yyyy/MM/dd')", null],
  ["make_date(2024,3,5) IS NOT NULL", null],
  // null/条件
  ["coalesce(null,null,'x')", null], ["nullif(1,1)", null], ["nullif(1,2)", null],
  // 正規表現
  ["regexp_match('abc123','[0-9]+')", null],
  ["regexp_substr('abc123','[0-9]+')", null],
  ["regexp_replace('abc123','[0-9]+','#')", null],
  ["regexp_replace('a1b2','([a-z])([0-9])','\\2\\1')", null],
  // 配列
  ["array_to_string(array(1,2,3),'|')", null],
  ["array_last(array(1,2,3))", null], ["array_first(array(1,2,3))", null],
  ["array_length(array(1,2,3))", null], ["array_get(array(1,2,3),1)", null],
  ["array_contains(array(1,2,3),2)", null],
  ["array_to_string(array_distinct(array(1,1,2)),'-')", null],
  ["array_to_string(string_to_array('a,b'),'+')", null],
  // IN / BETWEEN / CASE
  ["3 IN (1,2,3)", null], ["4 NOT IN (1,2,3)", null],
  ["5 BETWEEN 1 AND 10", null],
  ["CASE WHEN 1>2 THEN 'a' WHEN 2>1 THEN 'b' ELSE 'c' END", null],
];
const results = await page.evaluate(async ([cases]) => {
  const m = await import("/shared/qml-style.js");
  m.setMapScaleGetter(() => window.__testScale ?? null);
  return cases.map(([expr, props, scale]) => {
    window.__testScale = scale ?? null;
    let v;
    try { v = m.evalQgisExpression(expr, props || {}); } catch (e) { v = "ERR:" + e.message; }
    return { expr, v };
  });
}, [cases]);
for (const r of results) console.log(`${JSON.stringify(r.v)}  <-  ${r.expr}`);
await browser.close();
