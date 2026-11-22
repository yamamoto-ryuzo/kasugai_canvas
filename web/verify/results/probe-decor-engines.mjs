// decor QML(MarkerLine/ArrowLine等)を全エンジンで読み、フォールバック描画・
// クラッシュ無し・QML 評価が通ることを確認するスモーク検証
//  実行: node web/verify/results/probe-decor-engines.mjs  (dev :8520 前提)
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";

const BASE = process.env.KASC_BASE || "http://localhost:8520";
const KASC = `${BASE}/projects/_primtest/kasugai_canvas.kasc`;
const ENGINES = ["maplibre", "openlayers", "leaflet", "gsimaps", "navara"];
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const browser = await chromium.launch();
for (const eng of ENGINES) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  try {
    await page.goto(`${BASE}/${eng}/?kasc=${encodeURIComponent(KASC)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.kasugaiApi?.isReady === true || window.kascMap || window._viewer || ((window.kascLayerEntries?.length ?? 0) >= 16 && window.kasugaiApi), { timeout: eng === "navara" ? 180000 : 60000, polling: 800 }).catch(() => {});
    await page.waitForTimeout(8000);
    const info = await page.evaluate(() => {
      const api = window.kasugaiApi;
      const layers = api?.listLayers?.() || [];
      const out = { n: layers.length, titles: layers.map(l => String(l.title ?? l.name ?? l.id)) };
      // maplibre: style 内のレイヤー数
      const m = window.kascMap || window.map || window._map;
      if (m?.getStyle) {
        try { out.styleLayers = m.getStyle().layers.filter(l => !/^gl-|background|fill-extrusion/.test(l.id)).length; } catch {}
      }
      // OL: ソース地物総数
      if (m?.getLayers) {
        try {
          let feats = 0;
          m.getLayers().forEach(l => { const s = l.getSource?.(); const c = s?.getFeatures?.() || s?.getSource?.()?.getFeatures?.(); if (c) feats += c.length; });
          out.olFeats = feats;
        } catch {}
      }
      return out;
    });
    console.log(`${eng}:`, JSON.stringify(info).slice(0, 300));
    check(`${eng}: レイヤー読込`, info.n >= 12, `n=${info.n}`);
    check(`${eng}: pageerror なし`, errors.length === 0, errors.slice(0, 2).join("|").slice(0, 160));
  } catch (e) {
    check(`${eng}: ロード`, false, String(e).slice(0, 120));
  }
  await page.close();
}
console.log(`== ${pass} PASS / ${fail} FAIL ==`);
await browser.close();
process.exit(fail ? 1 : 0);
