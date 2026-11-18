// QML 縮尺連動 回帰検証プローブ navara 版 (qml-scale スキル準拠)
// scale_test: 広域(分母>8000)=ポリゴン青(60,100,220)・点1.2mm・ラベル非表示
//             詳細(分母<5000)=ポリゴン緑(40,180,60)・点5mm・ラベル表示
// FeatureEvaluator.evaluate をフックして地物別の評価値(color/size/show/text)を採取。
// Navara はレイヤ単位マテリアルのため縮尺変化時はレイヤ再マウント(moveend 400ms後)で再評価。
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:8510";
const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KASC = encodeURIComponent(`${BASE}/projects/scale_test/kasugai_canvas.kasc`);
const results = { checks: [] };
const ok = (name, cond, extra = "") => { results.checks.push({ name, pass: !!cond, extra }); console.log(cond ? "PASS" : "FAIL", name, extra); };

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 200)));
page.on("console", m => { const t = m.text(); if (/error|warn|fail/i.test(t)) console.log("[console]", t.slice(0, 160)); });

await page.addInitScript(() => {
  window.__cap = [];
  window.__capReady = false;
  (async () => {
    for (let i = 0; i < 600 && !window.__capReady; i++) {
      try {
        const mod = await import("/vendor/navara/@navaramap/three/dist/index.js");
        const orig = mod.FeatureEvaluator.prototype.evaluate;
        mod.FeatureEvaluator.prototype.evaluate = function (f, opts) {
          return orig.call(this, info => {
            const v = f(info) || {};
            try {
              const plain = {};
              for (const [k, x] of Object.entries(v)) {
                const hexOf = c => typeof c?.toHex === "function" ? c.toHex()
                  : typeof c?.getHex === "function" ? c.getHex() : null;
                plain[k] = hexOf(x) != null ? "#" + hexOf(x).toString(16).padStart(6, "0")
                  : (x instanceof Float32Array ? [...x]
                  : (typeof x === "string" && x.startsWith("data:") ? `data:len${x.length}` : x));
              }
              window.__cap.push({ gt: info?.meshGeomType, props: info?.properties, v: plain });
            } catch (_) {}
            return v;
          }, opts);
        };
        window.__capReady = true;
      } catch (e) { await new Promise(r => setTimeout(r, 500)); }
    }
  })();
});

await page.goto(`${BASE}/navara/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.kascView && window.__capReady, { timeout: 120000 });
await page.waitForTimeout(15000); // WASM起動・レイヤ読込・初期カメラ移動の安定待ち

const readScale = () => page.evaluate(async () =>
  (await import("/shared/qml-style.js")).evalQgisExpression("@map_scale"));
const capSlice = (from) => page.evaluate(i => (window.__cap || []).slice(i), from);
const capLen = () => page.evaluate(() => (window.__cap || []).length);

// まず setCamera で moveend→再マウントが発火するか試し、駄目なら flyTo に切替
let camMethod = "setCamera";
const setView = async (height, label) => {
  const before = await capLen();
  await page.evaluate(([h]) => {
    const v = window.kascView;
    v.setCamera({ lng: 139.79, lat: 35.678, height: h, heading: 0, pitch: -90 });
  }, [height]);
  await page.waitForTimeout(6000); // 400msデバウンス+再マウント+featureCreated
  if (await capLen() === before) {
    camMethod = "flyTo";
    console.log(`[info] setCamera では再評価が走らない → flyTo へ切替 (${label})`);
    await page.evaluate(([h]) => {
      window.kascView.flyTo({ lng: 139.79, lat: 35.678, height: h, heading: 0, pitch: -90 }, { duration: 300 });
    }, [height]);
    await page.waitForTimeout(7000);
  }
  await page.waitForTimeout(2000);
};

// 初期状態: kasc cam h=3000 → 分母 ≈ 13742 (広域)
await page.waitForTimeout(3000);
const cap0 = await capSlice(0);
const sc0 = Math.round(await readScale() || -1);
console.log(`initial: scale=${sc0} cap=${cap0.length}`);

// 詳細側へ (h=1000 → 分母≈4581 <5000)
await setView(1000, "detail");
const cap1 = await capSlice(cap0.length);
const sc1 = Math.round(await readScale() || -1);
console.log(`detail: scale=${sc1} newcap=${cap1.length} (via ${camMethod})`);

// 広域へ戻す (h=6000 → 分母≈27488 >8000)
await setView(6000, "wide");
const cap2 = await capSlice(cap0.length + cap1.length);
const sc2 = Math.round(await readScale() || -1);
console.log(`wide: scale=${sc2} newcap=${cap2.length} (via ${camMethod})`);

await page.screenshot({ path: OUT + "navara-scale-wide.png" });
writeFileSync(OUT + "navara-scale-captured.json", JSON.stringify({ sc0, sc1, sc2, cap0, cap1, cap2 }, null, 2));

// ---- 機械検査 ----
// 採取値の集約: ポリゴン塗色 / 点マーカーサイズ / ラベル(text)の show
const summarize = (cap) => {
  const fills = new Set(), markSizes = new Set(), textShow = [];
  for (const c of cap) {
    if (c.gt === "polygon" && c.v.color) fills.add(c.v.color);
    if ((c.gt === "point" || c.gt === "billboard") && (c.v.size != null)) markSizes.add(c.v.size);
    if ((c.gt === "text" || c.gt === "sdfText")) textShow.push({ name: c.props?.name, show: c.v.show, text: c.v.text });
  }
  return { fills: [...fills], markSizes: [...markSizes], textShow };
};
const GREEN = "#28b43c", BLUE = "#3c64dc";
const s0 = summarize(cap0), s1 = summarize(cap1), s2 = summarize(cap2);
console.log("init :", JSON.stringify(s0));
console.log("det  :", JSON.stringify(s1));
console.log("wide :", JSON.stringify(s2));

ok("初期(広域) 縮尺が 8000 超", sc0 > 8000, `scale=${sc0}`);
ok("初期(広域) ポリゴンが青", s0.fills.includes(BLUE) && !s0.fills.includes(GREEN), s0.fills.join(","));
ok("初期(広域) ラベル非表示", s0.textShow.length === 0 || s0.textShow.every(t => t.show !== true), JSON.stringify(s0.textShow));

ok("詳細 縮尺が 5000 未満", sc1 > 0 && sc1 < 5000, `scale=${sc1}`);
ok("詳細で再評価が走った", cap1.length > 0, `cap1=${cap1.length}`);
ok("詳細 ポリゴンが緑", s1.fills.includes(GREEN) && !s1.fills.includes(BLUE), s1.fills.join(","));
const bigMark = [...s1.markSizes].some(s => s >= 15);
ok("詳細 マーカーが大(>=15px)", bigMark, s1.markSizes.join(","));
ok("詳細 ラベル表示", s1.textShow.some(t => t.show === true), JSON.stringify(s1.textShow));

ok("広域(往復) 縮尺が 8000 超", sc2 > 8000, `scale=${sc2}`);
ok("広域(往復) ポリゴンが青へ戻る", s2.fills.includes(BLUE) && !s2.fills.includes(GREEN), s2.fills.join(","));
const smallMark = s2.markSizes.length && [...s2.markSizes].every(s => s <= 14);
ok("広域(往復) マーカーが小(<=14px)", smallMark, s2.markSizes.join(","));
ok("広域(往復) ラベル非表示", s2.textShow.length === 0 || s2.textShow.every(t => t.show !== true), JSON.stringify(s2.textShow));

const fails = results.checks.filter(c => !c.pass);
console.log(`--- ${results.checks.length - fails.length}/${results.checks.length} PASS`);
writeFileSync(OUT + "navara-scale-results.json", JSON.stringify(results, null, 2));
await browser.close();
process.exit(fails.length ? 1 : 0);
