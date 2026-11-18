// 「レイヤー透過度」スライダで QML ラベルが消えないことの検証プローブ
//  1) declutter 管理ラベル(displayAll=0)が透過度変更後も表示判定を維持する
//  2) ラベル色アルファが係数に追従し、1 へ戻すと復元される
//  3) スライダ横の数値表示が更新される
// 実行: node web/verify/results/probe-label-opacity.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import os from "node:os";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/tools/hub-test/node_modules/playwright-core/index.mjs");

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL("./", import.meta.url));
mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".qml": "application/xml", ".kasc": "text/plain", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };

const prof = join(os.tmpdir(), "kasc-probe-profile-label-opacity");
const ctx = await chromium.launchPersistentContext(prof,
  { channel: "chrome", headless: true }).catch(() =>
  chromium.launchPersistentContext(prof, { channel: "msedge", headless: true }));
const page = await ctx.newPage();
// 既定1280x720 では label_test の地物が画面外へ投影され declutter が全件
// 非表示にしてしまうため、全地物が収まる広いビューポートにする
await page.setViewportSize({ width: 2400, height: 1600 });
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0, 200)));

// ds ごとのラベル entity 一覧: {id, kind, show, alpha}
// _kascLabelGfx は通常ラベル(label)と bufferNoFill(canvas=billboard)の両方を指す
const snap = () => page.evaluate(() => {
  const v = window._viewer;
  const now = window.Cesium.JulianDate.now();
  const out = [];
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    for (const e of ds.entities.values) {
      const gfx = e._kascLabelGfx || e.label;
      if (!gfx) continue;
      const isBB = gfx === e.billboard;
      const c = (isBB ? gfx.color : gfx.fillColor)?.getValue?.(now);
      out.push({ id: `${i}:${e.id}`, kind: isBB ? "billboard" : "label",
        show: gfx.show?.getValue?.() ?? null,
        alpha: c instanceof window.Cesium.Color ? c.alpha : null });
    }
  }
  return out;
});
const setSlider = v => page.evaluate(val => {
  const s = document.querySelector("#display-layer-opacity");
  s.value = String(val);
  s.dispatchEvent(new Event("input", { bubbles: true }));
}, v);
const sliderValueText = () => page.evaluate(() =>
  document.querySelector("#display-layer-opacity-value")?.textContent ?? null);
const entityCounts = () => page.evaluate(() => {
  const v = window._viewer;
  const out = [];
  for (let i = 0; i < v.dataSources.length; i++) out.push(v.dataSources.get(i).entities.values.length);
  return out;
});

try {
  const errsBefore = pageErrors.length;
  await page.goto(`${base}/cesium/?project=label_test`);
  await page.waitForFunction(() => window._viewer && window._viewer.dataSources.length >= 1,
    null, { timeout: 120000 });
  // ラベル entity 生成待ち
  for (let i = 0; i < 30; i++) {
    const n = await page.evaluate(() => {
      const v = window._viewer; let n = 0;
      for (let i = 0; i < (v?.dataSources.length || 0); i++)
        for (const e of v.dataSources.get(i).entities.values)
          if (e._kascLabelGfx || e.label) n++;
      return n;
    });
    if (n > 0) break;
    await page.waitForTimeout(1000);
  }
  // 全ラベル地物がビューポート内へ収まるようカメラを引く
  // (投影位置が画面外のラベルは declutter が正しく非表示にしてしまうため)
  await page.evaluate(() => {
    const v = window._viewer, C = window.Cesium;
    const pts = [];
    for (let i = 0; i < v.dataSources.length; i++) {
      for (const e of v.dataSources.get(i).entities.values) {
        const g = e._kascLabelGfx || e.label;
        if (!g) continue;
        const p = e.position?.getValue?.(C.JulianDate.now());
        if (p) pts.push(p);
      }
    }
    if (pts.length) {
      const bs = C.BoundingSphere.fromPoints(pts);
      bs.radius *= 2.2; // ラベル矩形分の余白
      v.camera.viewBoundingSphere(bs, new C.HeadingPitchRoll(0, -Math.PI / 2, 0));
    }
    // requestRenderMode: プログラム的カメラ移動は描画を要求しない。
    // declutter の画面投影は最終描画の行列を使うため、明示的に描画させる
    v.scene.requestRender();
  });
  await page.waitForTimeout(500); // 描画→moveEnd→declutter 再評価待ち
  // declutter 完了待ち(表示判定が true のラベルが出るまで)
  // billboard ラベル(bufferNoFill)もあるため _kascLabelGfx 経由で見る。
  // requestRenderMode では raf が止まるため waitForTimeout ポーリングにする
  let bootOk = false;
  for (let i = 0; i < 60 && !bootOk; i++) {
    await page.waitForTimeout(1000);
    bootOk = await page.evaluate(() => {
      const v = window._viewer;
      if (!v?.dataSources) return false;
      for (let i = 0; i < v.dataSources.length; i++) {
        for (const e of v.dataSources.get(i).entities.values) {
          const g = e._kascLabelGfx || e.label;
          if (g?.show?.getValue?.() === true) return true;
        }
      }
      return false;
    });
  }
  if (!bootOk) {
    const st = await page.evaluate(() => {
      const v = window._viewer; const out = [];
      for (let i = 0; v && i < v.dataSources.length; i++) {
        const ds = v.dataSources.get(i); let n = 0, lg = 0;
        for (const e of ds.entities.values) { n++; if (e._kascLabelGfx || e.label) lg++; }
        out.push(`${i}:${ds._kasugaiLayerId || ds.name} e=${n} lg=${lg}`);
      }
      return out.join(" / ") || "no viewer";
    });
    throw new Error(`label boot timeout: ${st}`);
  }
  await page.waitForTimeout(1000);

  const before = await snap();
  const shownBefore = before.filter(l => l.show === true);
  rec("boot.labels", before.length > 0 && shownBefore.length > 0,
    `labels=${before.length} shown=${shownBefore.length} alpha=${before[0]?.alpha}`);
  const countsBefore = await entityCounts();

  // ---- 0.5 へ(ラベルが消えない・アルファ半減) ----
  await setSlider(0.5);
  // declutter 再評価(150ms)の前に即時確認:
  // billboard 共有ラベルの show がマーカー処理で潰されるとここで false になる
  await page.waitForTimeout(80);
  const quick = await snap();
  const quickShownKept = quick.filter(l =>
    new Map(before.map(b => [b.id, b])).get(l.id)?.show === true && l.show === true).length;
  rec("fade.shown_immediate", quickShownKept === shownBefore.length && shownBefore.length > 0,
    `shown before=${shownBefore.length} kept@80ms=${quickShownKept}`);
  await page.waitForTimeout(1200); // 再適用 + declutter 再評価(150ms)待ち
  const faded = await snap();
  const mapBefore = new Map(before.map(l => [l.id, l]));
  const mapFaded = new Map(faded.map(l => [l.id, l]));
  let shownKept = 0, alphaOk = 0, compared = 0;
  for (const [id, b] of mapBefore) {
    const f = mapFaded.get(id);
    if (!f || b.alpha === null) continue;
    compared++;
    if (b.show === true && f.show === true) shownKept++;
    if (Math.abs(f.alpha - b.alpha * 0.5) <= 0.03) alphaOk++;
  }
  rec("fade.shown_kept", shownKept === shownBefore.length && compared > 0,
    `shown before=${shownBefore.length} kept=${shownKept} total=${faded.length}`);
  rec("fade.alpha", alphaOk === compared && compared > 0,
    `alpha*0.5 ok=${alphaOk}/${compared} sample=${faded[0]?.alpha}`);
  rec("fade.value_display", (await sliderValueText()) === "50%",
    `display=${await sliderValueText()}`);

  // ---- 0 へ(全消し) ----
  await setSlider(0);
  await page.waitForTimeout(1200);
  const zero = await snap();
  const zeroAlphaOk = zero.filter(l => l.alpha !== null).every(l => l.alpha <= 0.01);
  rec("zero.alpha", zero.length > 0 && zeroAlphaOk,
    `alpha@0 sample=${zero[0]?.alpha}`);
  rec("zero.value_display", (await sliderValueText()) === "0%",
    `display=${await sliderValueText()}`);

  // ---- 1.0 へ戻す(表示判定も復元) ----
  await setSlider(1.0);
  await page.waitForTimeout(1200);
  const restored = await snap();
  const mapRestored = new Map(restored.map(l => [l.id, l]));
  let shownRestored = 0, alphaRestored = 0, cmp2 = 0;
  for (const [id, b] of mapBefore) {
    const r = mapRestored.get(id);
    if (!r || b.alpha === null) continue;
    cmp2++;
    if (b.show === true && r.show === true) shownRestored++;
    if (Math.abs(r.alpha - b.alpha) <= 0.03) alphaRestored++;
  }
  rec("restore.shown", shownRestored === shownBefore.length && cmp2 > 0,
    `shown before=${shownBefore.length} restored=${shownRestored}`);
  rec("restore.alpha", alphaRestored === cmp2 && cmp2 > 0,
    `alpha restored=${alphaRestored}/${cmp2} sample=${restored[0]?.alpha}`);

  // ---- 繰り返し変更で補助 entity が増殖しないこと ----
  for (const v of [0.8, 0.6, 0.4, 1.0]) { await setSlider(v); await page.waitForTimeout(150); }
  await page.waitForTimeout(800);
  const countsAfter = await entityCounts();
  rec("no_entity_growth", JSON.stringify(countsAfter) === JSON.stringify(countsBefore),
    `before=${countsBefore} after=${countsAfter}`);

  rec("no_pageerror", pageErrors.length === errsBefore,
    `errors=${pageErrors.slice(errsBefore).join(" | ") || "none"}`);
  await page.screenshot({ path: join(OUT, "label-opacity.png") });
} catch (e) { rec("probe.run", false, String(e).slice(0, 400)); }

console.log(JSON.stringify({ pass: results.filter(r => r.ok).length, total: results.length }));
await ctx.close();
srv.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
