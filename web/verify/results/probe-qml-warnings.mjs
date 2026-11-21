// QML compile warnings 収集プローブ: 指定プロジェクトを各エンジンで開き
// console の QML 警告を収集する。
// usage: node probe-qml-warnings.mjs [engine,...] [canvasBase] [project]
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const engines = (process.argv[2] || "cesium").split(",");
const CANVAS = process.argv[3] || "http://127.0.0.1:8510";
const PROJECT = process.argv[4] || "ProjectFiles";
const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const eng of engines) {
  const page = await browser.newPage();
  const qml = [], errs = [];
  page.on("console", m => {
    const t = m.text();
    if (/QML|qml/i.test(t)) qml.push(`[${m.type()}] ${t.slice(0, 400)}`);
    if (m.type() === "error") errs.push(t.slice(0, 200));
  });
  try {
    await page.goto(`${CANVAS}/${eng}/?project=${PROJECT}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(20000);
  } catch (e) { console.log(`${eng}: nav err ${e.message}`); }
  console.log(`== ${eng} ==`);
  console.log(`  qml console msgs: ${qml.length}`);
  for (const q of [...new Set(qml)].slice(0, 40)) console.log("   ", q);
  const sig = errs.filter(t => !/favicon|ui\.config|net::ERR|mcp/i.test(t));
  console.log(`  js errors(sig): ${sig.length}`);
  for (const e of [...new Set(sig)].slice(0, 10)) console.log("   ", e);
  await page.close();
}
await browser.close();
