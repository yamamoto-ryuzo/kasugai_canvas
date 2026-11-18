// ベースマップ透過後の下地が全エンジンで白になるかの検証 (2026-11-18)
//  - base:|transparent → 下敷きが白
//  - base:|none → ベースマップなしの下地が白(3D 系は地表色=白)
//  - 透過度スライダを 0 にすると下地が白(cesium/maplibre/openlayers/leaflet)
//  - background: 行指定時はその色が下敷きになる(白以外も選べることの回帰確認)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright-core/index.mjs");
const WEB = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL("./", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain",
  ".wasm": "application/wasm", ".terrain": "application/octet-stream" };

const KASC = {
  // 地表透明: 全面白のはず
  "t-transparent.kasc": "title:透過テスト\nbase: ベースマップ透明 | transparent\n",
  // ベースマップなし: 2D 系は白、Cesium は白地表、Navara は素地表(非白・参考)
  "t-none.kasc": "title:なしテスト\nbase: ベースマップなし | none\n",
  // 実ベースマップ(地理院標準): スライダ 0 → 白、1 → 地図描画
  "t-base.kasc": "title:透過スライダ\nbase: 地理院標準 | https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png\n",
  // background: 行で下敷き色を上書きできることの確認(赤)
  "t-background.kasc": "title:背景色\nbackground: #ff0000\nbase: ベースマップ透明 | transparent\n",
};

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname.startsWith("/__test__/")) {
      const name = decodeURIComponent(u.pathname.slice("/__test__/".length));
      if (KASC[name]) { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); return res.end(KASC[name]); }
      res.writeHead(404); return res.end("not found");
    }
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = resolve(join(WEB, p));
    if (!file.startsWith(resolve(WEB))) { res.writeHead(403); return res.end("forbidden"); }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end(String(e));
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// 画面中央ピクセル(厳密中心だと UI が重なる恐れがあるため中央やや下)
async function centerPixel(page, frac = 0.55) {
  const shot = await page.screenshot();
  return await page.evaluate(async ([b64, f]) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const x = (img.width / 2) | 0, y = (img.height * f) | 0;
    const d = ctx.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [shot.toString("base64"), frac]);
}
const isWhite = rgb => rgb.every(v => v >= 235);
const fmt = rgb => `#${rgb.map(v => v.toString(16).padStart(2, "0")).join("")}`;

const ENGINES = ["cesium", "maplibre", "openlayers", "leaflet", "navara", "gsimaps"];
const VIEW = "&latitude=35.68&longitude=139.76&zoom=11&height=800000";
const results = [];

// vendor SW 経由で上流から vendor を取得するエンジン(navara/gsimaps)は
// 初回起動が遅いため準備完了をポーリングで待つ
async function waitEngineReady(page, engine) {
  if (engine === "navara") {
    await page.waitForFunction(() => window.kascView && document.querySelector("#map canvas"), { timeout: 60000 }).catch(() => {});
    // 空メッシュ/レンダーパスは engine 初期化よりさらに後から来るため長めに待つ
    await page.waitForTimeout(10000);
  } else if (engine === "gsimaps") {
    await page.waitForTimeout(25000);
  } else {
    await page.waitForTimeout(engine === "cesium" ? 9000 : 5000);
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true })).catch(() => chromium.launch({ headless: true }));
try {
  for (const engine of ENGINES) {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const errors = [];
    page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
    try {
      // 1) transparent → 白
      await page.goto(`${base}/${engine}/?kasc=${base}/__test__/t-transparent.kasc${VIEW}`, { waitUntil: "load", timeout: 60000 });
      await waitEngineReady(page, engine);
      const pxT = await centerPixel(page);
      await page.screenshot({ path: join(OUT, `base-white-${engine}-transparent.png`) });
      results.push({ engine, case: "transparent", pixel: fmt(pxT), white: isWhite(pxT) });

      // 2) none → 白(2D/Cesium)。Navara は素地表のため参考記録
      await page.goto(`${base}/${engine}/?kasc=${base}/__test__/t-none.kasc${VIEW}`, { waitUntil: "load", timeout: 60000 });
      await waitEngineReady(page, engine);
      const pxN = await centerPixel(page);
      await page.screenshot({ path: join(OUT, `base-white-${engine}-none.png`) });
      results.push({ engine, case: "none", pixel: fmt(pxN), white: isWhite(pxN) });

      // 3) 透過度スライダ 0 → 白。対象外エンジン(スライダ無し)はスキップ
      const sliderSel = engine === "cesium" ? "#display-basemap-opacity" : "#display-opacity";
      const hasSlider = await page.$(sliderSel);
      if (hasSlider) {
        await page.goto(`${base}/${engine}/?kasc=${base}/__test__/t-base.kasc${VIEW}`, { waitUntil: "load", timeout: 60000 });
        await waitEngineReady(page, engine);
        await page.evaluate(sel => {
          const el = document.querySelector(sel);
          el.value = "0";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, sliderSel);
        await page.waitForTimeout(2000);
        const px0 = await centerPixel(page);
        await page.screenshot({ path: join(OUT, `base-white-${engine}-opacity0.png`) });
        results.push({ engine, case: "opacity0", pixel: fmt(px0), white: isWhite(px0) });
      } else {
        results.push({ engine, case: "opacity0", pixel: null, white: null, note: "スライダなし" });
      }

      // 4) background: 行の回帰(赤が下敷きになる)
      await page.goto(`${base}/${engine}/?kasc=${base}/__test__/t-background.kasc${VIEW}`, { waitUntil: "load", timeout: 60000 });
      await waitEngineReady(page, engine);
      const pxB = await centerPixel(page);
      await page.screenshot({ path: join(OUT, `base-white-${engine}-background.png`) });
      results.push({ engine, case: "background:red", pixel: fmt(pxB), white: false, expectRed: pxB[0] >= 235 && pxB[1] <= 60 && pxB[2] <= 60 });
    } catch (e) {
      results.push({ engine, case: "ERROR", pixel: null, white: false, note: String(e).slice(0, 200) });
    }
    if (errors.length) results.push({ engine, case: "pageerror", pixel: null, white: false, note: errors.slice(0, 3).join(" | ").slice(0, 300) });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

writeFileSync(join(OUT, "basemap-white-2026-11-18.json"), JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`${(r.engine ?? "").padEnd(10)} ${(r.case ?? "").padEnd(14)} ${(r.pixel ?? "-").padEnd(8)} white=${r.white}${r.expectRed !== undefined ? " red=" + r.expectRed : ""}${r.note ? "  " + r.note : ""}`);
}
