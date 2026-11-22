const { chromium } = await import("file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(()=>chromium.launch({headless:true}));
const page = await browser.newPage();
page.on("console", m => { if(m.type()==="error"||m.type()==="warning") { const t=m.text(); if(/embedded|geojson|fail/i.test(t)) console.log("CONSOLE:", t.slice(0,200)); }});
await page.goto("http://127.0.0.1:8510/cesium/?project=ProjectFiles", { waitUntil:"domcontentloaded", timeout:45000 });
await page.waitForFunction(() => window.kasugaiApi?.listLayers?.().length > 0, undefined, { timeout:60000 });
await page.waitForTimeout(20000);
const info = await page.evaluate(async () => {
  const l = window.kasugaiApi.listLayers().find(l => /embedded/i.test(l.title||l.id));
  if (!l) return {found:false};
  let gj=null, err=null;
  try { gj = await window.kasugaiApi.getLayerGeoJson(l.id); } catch(e){ err=String(e); }
  // tenta forçar visibilidade
  try { await window.kasugaiApi.setLayerVisible(l.id, true); } catch(e){}
  await new Promise(r=>setTimeout(r,4000));
  let gj2=null;
  try { gj2 = await window.kasugaiApi.getLayerGeoJson(l.id); } catch(e){}
  return { found:true, layer:{id:l.id,type:l.type,visible:l.visible,title:l.title}, n1:gj?.features?.length??null, n2:gj2?.features?.length??null, err };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
