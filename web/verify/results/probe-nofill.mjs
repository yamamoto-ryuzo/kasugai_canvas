// probe-nofill: QML style="no"(fill)/outline_style="no"(stroke) が
// 各エンジンで既定青フォールバックせず「非表示」になるか検証(commit 86a92e6)。
//   対象プロジェクト: web/projects/_nofill_verify
//     nofill   : SimpleFill style=no  + outline solid  → 縁のみ(中は透明)
//     nostroke : SimpleFill style=solid + outline no    → 塗りのみ(縁なし)
//     neither  : 両方 no                                 → 完全に非表示
// 判定: スクショ全域の色票でフォールバック青(#3a7bd5/#2c5ea8)が0、
//       緑縁(nofill)・赤塗り(nostroke)が存在 = QML 通りに描画。
// 使い方:
//   node web/verify/results/probe-nofill.mjs [engine ...] [--host 8510]
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SHOTS = `${OUT}nofill`;
mkdirSync(SHOTS, { recursive: true });

const args = process.argv.slice(2);
let host = 8510;
const hi = args.indexOf("--host");
if (hi >= 0) { host = args[hi + 1]; args.splice(hi, 2); }
const BASE = /^https?:/.test(String(host))
  ? String(host).replace(/\/+$/, "")
  : `http://127.0.0.1:${host}`;
const engines = args.length ? args
  : ["leaflet", "gsimaps", "navara", "cesium", "maplibre", "openlayers"];

const checks = [];
const ok = (eng, name, cond, extra = "") => {
  checks.push({ engine: eng, name, pass: !!cond, extra });
  console.log(cond ? "PASS" : "FAIL", `[${eng}]`, name, extra ? `:: ${extra}` : "");
};

let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ headless: true }); }

for (const eng of engines) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  try {
    await page.goto(`${BASE}/${eng}/?project=_nofill_verify`,
      { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.kasugaiApi?.isReady,
      { timeout: 90000 }).catch(() => {});
    // 描画安定待ち(WebGL/タイル反映)
    const wait = { cesium: 15000, gsimaps: 12000, navara: 12000 }[eng] ?? 8000;
    await page.waitForTimeout(wait);
    // AI チャットパネル等のオーバレイを隠して地物領域を露出させる
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".chat-panel, .acp-panel, [class*=chat]"))
        el.style.display = "none";
    });
    await page.waitForTimeout(800);
    const buf = await page.screenshot({ path: `${SHOTS}/${eng}.png` });
    const b64 = buf.toString("base64");
    const census = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const g = cv.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let blueFill = 0, blueStroke = 0, green = 0, red = 0, other = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        // フォールバック青の検出(±12 許容)
        if (Math.abs(r - 0x3a) < 13 && Math.abs(gg - 0x7b) < 13 && Math.abs(b - 0xd5) < 13) { blueFill++; continue; }
        if (Math.abs(r - 0x2c) < 13 && Math.abs(gg - 0x5e) < 13 && Math.abs(b - 0xa8) < 13) { blueStroke++; continue; }
        if (gg > 140 && r < 110 && b < 110) { green++; continue; }      // 緑縁(0,200,0)
        if (r > 170 && gg < 110 && b < 110) { red++; continue; }        // 赤塗り(255,0,0)
        if (!(r > 235 && gg > 235 && b > 235)) other++;                 // 白以外
      }
      return { blueFill, blueStroke, green, red, other };
    }, b64);
    // 既定青のフォールバックが地物に出ていないこと(最重要)。
    // 凡例スウォッチ/エンジンリンク等の UI 青は ~100px 程度まで出るため
    // ポリゴン辺(千px 級)と区別する閾値 300 を設ける
    ok(eng, "no-fallback-blue",
      census.blueFill < 300 && census.blueStroke < 300,
      `fillBlue=${census.blueFill} strokeBlue=${census.blueStroke}`);
    // nofill の緑縁が描かれている(面塗りでなく線分程度の画素数)
    ok(eng, "nofill-green-outline", census.green > 200,
      `green=${census.green}`);
    // nostroke の赤塗りが描かれている(大面積)
    ok(eng, "nostroke-red-fill", census.red > 5000,
      `red=${census.red}`);
    console.log(`   census[${eng}]`, JSON.stringify(census));
  } catch (e) {
    ok(eng, "load", false, String(e).slice(0, 160));
  }
  await page.close().catch(() => {});
}
await browser.close();

writeFileSync(`${SHOTS}/results.json`, JSON.stringify({ checks }, null, 1));
const pass = checks.filter(c => c.pass).length;
console.log(`==== ${pass}/${checks.length} PASS ====`);
process.exit(pass === checks.length ? 0 : 1);
