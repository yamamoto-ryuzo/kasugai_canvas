const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(()=>chromium.launch({headless:true}));
const page = await browser.newPage();
const reqs = [];
page.on("requestfinished", r => { const u=r.url(); if(/geojson|embedded|canvas_data/.test(u)) reqs.push(`${r.response().then?.call? '' : ''}${u}`); });
page.on("request", r => { const u=r.url(); if(/\.geojson|embedded/.test(u)) reqs.push(`REQ ${u}`); });
await page.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles", { waitUntil:"domcontentloaded", timeout:45000 });
await page.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0, undefined, { timeout:60000 });
await page.waitForTimeout(15000);
const info = await page.evaluate(async () => {
  const l = window.kasugaiApi.listLayers().find(l => /embedded/i.test(l.title||l.id));
  const gj = await window.kasugaiApi.getLayerGeoJson(l.id).catch(e=>({err:String(e)}));
  return { layer: l, gjKeys: gj ? Object.keys(gj) : null, n: gj?.features?.length, item: Object.keys(gj||{}).length? null : gj };
});
console.log(JSON.stringify(info, null, 1).slice(0, 2000));
console.log("REQS:", reqs.slice(0,40).join("\n"));
await browser.close();
