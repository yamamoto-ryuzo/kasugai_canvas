import { chromium } from "../../tools/hub-test/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const logs = [];
page.on("console", m => logs.push(m.type() + ":" + m.text().slice(0,200)));
await page.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(18000);
const r = await page.evaluate(async () => {
  const out = { ents: 0, labelEnts: 0, nonempty: [], empty: 0, spec: null, flag: null };
  const m = await import("/shared/qml-style.js");
  for (const ds of window._viewer?.dataSources?.dataSources || []) {
    for (const e of ds.entities.values) {
      out.ents++;
      if (e.label) {
        out.labelEnts++;
        const t = e.label.text?.getValue?.();
        if (t) out.nonempty.push(String(t).slice(0,30)); else out.empty++;
      }
    }
  }
  // 行政区域の QML を直接コンパイルして labelFor を試す
  try {
    const res = await fetch("http://127.0.0.1:8089/export-data/ProjectFiles/canvas_data/layer.qml");
    out.fetchOk = res.ok;
    if (res.ok) {
      const xml = await res.text();
      const c = m.compileQmlStyle(xml, "http://127.0.0.1:8089/export-data/ProjectFiles/");
      out.flag = c.usesLayerVisibility;
      const spec = c.labelFor?.({ N03_001: "東京都", N03_004: "世田谷区" });
      out.spec = spec ? { text: spec.text, sizePx: spec.sizePx } : null;
    }
  } catch (e) { out.err = String(e); }
  return out;
});
console.log(JSON.stringify(r, null, 1));
console.log("WARN:", logs.filter(l => l.startsWith("warn") || l.startsWith("error")).slice(0,10));
await browser.close();
