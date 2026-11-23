import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const [layer, engine] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
const pg = await browser.newPage();
await pg.goto(`http://127.0.0.1:8520/leaflet/`, { waitUntil: "domcontentloaded" });
const r = await pg.evaluate(async ({ layer, engine }) => {
  const m = await import("/shared/qml-style.js");
  const c = await m.loadQmlStyle(`/projects/_qml_verify/canvas_data/${layer}.qml`, async u => (await fetch(u)).text(), engine || "leaflet");
  const spec = c.evaluate({});
  return { lines: spec.lines?.map(l => ({ c: l.color, k: l.decor?.kind, dc: l.decor?.color })), line: spec.line, warn: c.warnings };
}, { layer, engine });
console.log(JSON.stringify(r, null, 1));
await browser.close();
