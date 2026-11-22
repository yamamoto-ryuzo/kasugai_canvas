// probe-qml-replay.mjs — 既に登録済みの .kasc プロジェクトを各エンジンで
// リプレイ検証(QGIS 再エクスポート不要)。qmltest_* レイヤの列挙・地物ロード・
// QML 警告収集・重大JSエラー有無を確認する。
// usage: node probe-qml-replay.mjs [engine,...] [canvasBase] [project]
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const engines = (process.argv[2] || "cesium").split(",");
const CANVAS = process.argv[3] || "http://127.0.0.1:8510";
const PROJECT = process.argv[4] || "ProjectFiles";

let pass = 0, fail = 0;
const ok = (c, n, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${n} ${x}`); };
const note = m => console.log(`  NOTE ${m}`);

const browser = await chromium.launch({ channel: "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }))
  .catch(() => chromium.launch({ headless: true }));

for (const eng of engines) {
  console.log(`== R ${eng}: ${CANVAS}/${eng}/?project=${PROJECT} ==`);
  const page = await browser.newPage();
  const errors = [], qmlWarns = [];
  page.on("pageerror", e => errors.push(String(e).slice(0, 200)));
  page.on("console", m => {
    const t = m.text();
    if (/QML スタイル/.test(t)) qmlWarns.push(t.slice(0, 220));
    else if (m.type() === "error" && !/favicon|ui\.config|net::ERR|404|403/.test(t)) errors.push(t.slice(0, 200));
  });
  try {
    await page.goto(`${CANVAS}/${eng}/?project=${PROJECT}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction(() => window.kasugaiApi?.listLayers,
      undefined, { timeout: 30000 });
    await page.waitForFunction(() => window.kasugaiApi.listLayers().length > 0,
      undefined, { timeout: 60000 });
    await page.waitForTimeout(15000);
    const layers = await page.evaluate(() => window.kasugaiApi.listLayers().map(l => ({
      id: l.id, title: l.title, type: l.type, visible: l.visible })));
    ok(layers.length > 0, "レイヤ列挙", `${layers.length}件`);
    const qmltest = layers.filter(l => /qmltest_/.test(l.title || l.id));
    ok(qmltest.length >= 25, "qmltest_* レイヤが列挙", `${qmltest.length}件`);
    // 表示中 qmltest レイヤの地物ロード(リトライ内蔵)
    const counts = await page.evaluate(async () => {
      const out = {};
      const leafOf = t => String(t || "").split("/").pop().trim();
      for (const l of window.kasugaiApi.listLayers()) {
        const leaf = leafOf(l.title || l.id);
        if (!/qmltest_/.test(leaf) || l.visible === false) continue;
        // xyz: タイル行はベクタ地物を持たないため対象外(QGIS焼き付け画像)
        if (l.type === "tile" || l.type === "xyz") { out[leaf] = -2; continue; }
        let best = -1;
        for (let i = 0; i < 20 && best <= 0; i++) {
          try {
            const gj = await window.kasugaiApi.getLayerGeoJson(l.id);
            const n = gj?.features?.length;
            if (typeof n === "number" && n > best) best = n;
          } catch { /* retry */ }
          if (best <= 0) await new Promise(r => setTimeout(r, 800));
        }
        out[leaf] = best;
      }
      return out;
    });
    // -2 = xyz タイル行(ベクタ地物を持たない正常)、-1 = ロード失敗/未取得
    const zeros = Object.entries(counts).filter(([, v]) => !(v > 0) && v !== -2);
    ok(zeros.length === 0, "表示 qmltest レイヤが地物を持つ",
      zeros.map(([k, v]) => `${k}=${v}`).join(","));
    note(`feature counts: ${JSON.stringify(counts).slice(0, 500)}`);
    ok(errors.length === 0, "重大なJSエラーなし", errors.slice(0, 3).join(" / "));
    note(`QML warnings: ${qmlWarns.length}件`);
    for (const w of qmlWarns.slice(0, 30)) console.log(`    WARN ${w.replace(/^.*qml\//, "")}`);
  } catch (e) {
    fail++; console.log(`  FAIL ページロード ${String(e).slice(0, 200)}`);
  }
  await page.close();
}
await browser.close();
console.log(`==== ${pass}/${pass + fail} PASS ====`);
process.exit(fail ? 1 : 0);
