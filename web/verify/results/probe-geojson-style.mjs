// GeoJSON スタイル仕様プローブ (simplestyle-spec 1.1.0 + popup 意味付け)
// skill: engine-geojson-style — 地物スタイル属性の実測台帳。スタイル関連コード変更の度に実行する
//  実行: node web/verify/results/probe-geojson-style.mjs
//  カバレッジ:
//   A) shared/kasc.js 解決層 (resolveDefault*Style/markerSymbolSpec/markerSymbolDivHtml/featurePopupMeta)
//   B) attr-widget の title/description ポップアップ意味付け (HTML サニタイズ含む)
//   C) leaflet 実機 (.kasc-ssym divIcon の DOM 実在)
//   D) maplibre 実機 (symbol レイヤ + kasc-ssym-* 画像登録)
//   E) openlayers 実機 (style fn が Text/Icon を返す)
//   F) cesium 実機 (GeoJsonDataSource ネイティブ marker-symbol billboard)
//  GAP = 仕様上正当だが未実装の項目(失敗ではなく実装候補として記録)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
const { chromium } = await import(
  "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs");

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL("./", import.meta.url));
mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".geojson": "application/geo+json",
  ".geojsonl": "application/x-ndjson", ".fgseq": "application/geo+json-seq",
  ".kasc": "text/plain", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    let q = p.endsWith("/") ? p + "index.html" : p;
    const fp = resolve(join(WEB, q));
    if (!fp.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(q)] || "application/octet-stream",
      "accept-ranges": "bytes" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, gap: false });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const gap = (id, supported, detail) => { results.push({ id, ok: true, gap: !supported });
  console.log(`${supported ? "PASS" : "GAP "} ${id} :: ${detail}`); };

let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
const ctx = browser;
const page = await ctx.newPage();
page.on("pageerror", e => console.log("PAGEERR:", String(e).slice(0, 200)));

// ============ Phase A+B: shared 解決層 + attr-widget ============
await page.goto(`${base}/cesium/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.Cesium, { timeout: 90000 });
const ab = await page.evaluate(async () => {
  const K = await import("../shared/kasc.js");
  const AW = await import("../shared/attr-widget.js");
  const p0 = { title: "テスト駅", description: "<b>B</b><script>alert(1)</script>",
    "marker-color": "#e45756", "marker-size": "medium", "marker-symbol": "a" };
  const out = {};
  const pt = K.resolveDefaultPointStyle(p0, null, { color: "#2c5ea8", size: 0, opacity: 1 });
  out.point = pt;
  const ln = K.resolveDefaultLineStyle({ stroke: "#ff8800", "stroke-width": 4, "stroke-opacity": 0.8 }, null, { color: "#2c5ea8", width: 1.5, opacity: 1 });
  out.line = ln;
  const poly = K.resolveDefaultPolygonStyle({ fill: "#00aa00", "fill-opacity": 0.5, stroke: "#006600", "stroke-width": 3, "stroke-opacity": 0.9 }, null, null, { fill: "#3a7bd5", fillOpacity: 0.4, stroke: "#2c5ea8", strokeWidth: 1.5, strokeOpacity: 1 });
  out.poly = poly;
  out.symText = K.markerSymbolSpec("a");
  out.symDigit = K.markerSymbolSpec("7");
  out.symMaki = K.markerSymbolSpec("rail");
  out.symUrl = K.markerSymbolSpec("https://x.example/i.png");
  out.symEmpty = K.markerSymbolSpec("");
  out.divText = K.markerSymbolDivHtml(K.markerSymbolSpec("a"), "#e45756", 26);
  out.divMaki = K.markerSymbolDivHtml(K.markerSymbolSpec("rail"), "#1b7fbd", 20);
  out.meta = K.featurePopupMeta(p0);
  // togeojson(KML) icon-* 方言: icon URL + icon-scale/opacity/heading/offset/color(aabbggrr)
  out.tgIcon = K.togeojsonIconSpec({ icon: "https://x.example/pin.png",
    "icon-scale": 2, "icon-opacity": 0.5, heading: 90,
    "icon-offset": [4, -8], "icon-color": "FF0000FF" });
  out.tgIconPlain = K.togeojsonIconSpec({ icon: "https://x.example/pin.png" });
  out.tgIconNone = K.togeojsonIconSpec({ "marker-symbol": "a" });
  // B: renderAttrContent — title/description が意味付きブロックになること
  const host = document.createElement("div");
  document.body.append(host);
  AW.renderAttrContent(host, [{
    title: "layer-title",
    entries: [["title", p0.title], ["description", p0.description], ["marker-color", "#e45756"]],
    feature: { type: "Feature", properties: p0, geometry: { type: "Point", coordinates: [0, 0] } },
  }]);
  const ptEl = host.querySelector(".attr-feature-ptitle");
  const deEl = host.querySelector(".attr-feature-desc");
  out.popup = {
    ptitle: ptEl?.textContent ?? null,
    descHtml: deEl?.innerHTML ?? null,
    hasScript: !!deEl?.querySelector("script"),
    descText: deEl?.textContent ?? null,
  };
  host.remove();
  return out;
});
rec("A.point", ab.point?.color === "#e45756" && ab.point?.size === 48 && ab.point?.symbol === "a",
  `marker-color/size/symbol → ${JSON.stringify(ab.point)}`);
rec("A.line", ab.line?.color === "#ff8800" && ab.line?.width === 4 && Math.abs(ab.line?.opacity - 0.8) < 1e-9,
  `stroke/stroke-width/stroke-opacity → ${JSON.stringify(ab.line)}`);
rec("A.poly", ab.poly?.fill === "#00aa00" && ab.poly?.fillOpacity === 0.5 && ab.poly?.stroke === "#006600"
  && ab.poly?.strokeWidth === 3 && Math.abs(ab.poly?.strokeOpacity - 0.9) < 1e-9,
  `fill/fill-opacity/stroke* → ${JSON.stringify(ab.poly)}`);
rec("A.sym.text", ab.symText?.kind === "text" && ab.symText?.char === "A" && ab.symDigit?.kind === "text" && ab.symDigit?.char === "7",
  `1文字シンボル(大文字化) → ${JSON.stringify(ab.symText)}`);
rec("A.sym.maki", ab.symMaki?.kind === "maki" && ab.symMaki?.url.endsWith("/rail.svg"),
  `Maki id → ${JSON.stringify(ab.symMaki)}`);
rec("A.sym.url", ab.symUrl?.kind === "url" && ab.symUrl?.url === "https://x.example/i.png",
  `URL形式 → ${JSON.stringify(ab.symUrl)}`);
rec("A.sym.empty", ab.symEmpty === null, `空値 → null`);
rec("A.div.html", ab.divText?.includes(">A<") && ab.divMaki?.includes("rail.svg") && ab.divMaki?.includes("invert"),
  `divHtml text=${ab.divText?.slice(0, 60)}…`);
rec("A.meta", ab.meta?.title === "テスト駅" && ab.meta?.description?.includes("<b>"),
  `featurePopupMeta → title=${ab.meta?.title}`);
rec("A.tgIcon", ab.tgIcon?.url === "https://x.example/pin.png" && ab.tgIcon?.scale === 2
  && ab.tgIcon?.opacity === 0.5 && ab.tgIcon?.heading === 90
  && ab.tgIcon?.anchor?.[0] === 0.125 && ab.tgIcon?.anchor?.[1] === 1
  && /^#ff0000ff$/i.test(ab.tgIcon?.color || ""),
  `togeojson icon-* → ${JSON.stringify(ab.tgIcon)}`);
rec("A.tgIcon.plain", ab.tgIconPlain?.scale === 1 && ab.tgIconPlain?.opacity === 1
  && ab.tgIconPlain?.color === null && ab.tgIconNone === null,
  `icon 単体既定値 / icon 無し→null → ${JSON.stringify(ab.tgIconPlain)}`);
rec("B.popup.title", ab.popup?.ptitle === "テスト駅",
  `title → 見出しブロック ptitle=${ab.popup?.ptitle}`);
rec("B.popup.desc", ab.popup?.descHtml?.includes("<b>B</b>") && !ab.popup?.hasScript,
  `description → サニタイズ済HTML(script除去) desc=${ab.popup?.descHtml}`);

const KASC = encodeURIComponent(`${base}/verify/geojson-spec/geojson-spec.kasc`);

// ============ Phase C: leaflet 実機 ============
try {
  await page.goto(`${base}/leaflet/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap && window.kasugaiApi, { timeout: 120000 });
  await page.waitForTimeout(8000);
  const c = await page.evaluate(() => {
    const icons = [...document.querySelectorAll(".kasc-ssym")];
    return {
      n: icons.length,
      texts: icons.filter(i => i.querySelector("span")).map(i => i.textContent.trim()),
      imgs: icons.filter(i => i.querySelector("img")).map(i => i.querySelector("img").getAttribute("src")),
      // togeojson icon: 地物 icon URL の <img> マーカー(data: URI・scale2=64px)
      tgImgs: [...document.querySelectorAll("img.leaflet-marker-icon")]
        .filter(i => i.src.startsWith("data:image/png"))
        .map(i => ({ w: i.width || i.style.width, op: i.style.opacity })),
    };
  });
  rec("C.leaflet.icons", c.n === 3 && c.texts.includes("A") && c.texts.includes("7"),
    `.kasc-ssym 数=${c.n} 文字=${JSON.stringify(c.texts)}`);
  rec("C.leaflet.maki", c.imgs.some(u => /maki.*rail\.svg/.test(u)),
    `Maki アイコン img=${JSON.stringify(c.imgs)}`);
  rec("C.leaflet.tgIcon", c.tgImgs.length === 1 && parseInt(c.tgImgs[0].w) === 64
      && c.tgImgs[0].op === "0.5",
    `togeojson icon → img 数=${c.tgImgs.length} w=${c.tgImgs[0]?.w} opacity=${c.tgImgs[0]?.op}`);
} catch (e) { rec("C.leaflet", false, `leaflet FAILED ${String(e).slice(0, 150)}`); }

// ============ Phase D: maplibre 実機 ============
try {
  await page.goto(`${base}/maplibre/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap?.loaded?.() && window.kasugaiApi, { timeout: 120000 });
  await page.waitForTimeout(8000);
  const d = await page.evaluate(async () => {
    const map = window.kascMap;
    const layers = map.getStyle().layers;
    const symLayers = layers.filter(l => l.type === "symbol" && /marker-symbol/.test(JSON.stringify(l.filter || "")));
    const textLayer = symLayers.find(l => JSON.stringify(l.layout?.["text-field"] || "").includes("upcase"));
    const iconLayer = symLayers.find(l => JSON.stringify(l.layout?.["icon-image"] || "").includes("kasc-ssym-"));
    // togeojson icon: icon プロパティを参照する symbol レイヤ + kasc-tgicon-* 画像登録
    const tgLayer = layers.find(l => l.type === "symbol" && /kasc-tgicon-/.test(JSON.stringify(l.layout?.["icon-image"] || "")));
    // 画像登録は非同期 — 最大10秒待機
    let hasRail = map.hasImage("kasc-ssym-rail");
    let hasTg = map.hasImage(`kasc-tgicon-data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`);
    for (let i = 0; i < 20 && !(hasRail && hasTg); i++) {
      await new Promise(r => setTimeout(r, 500));
      hasRail = hasRail || map.hasImage("kasc-ssym-rail");
      hasTg = hasTg || map.hasImage(`kasc-tgicon-data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`);
    }
    return { symN: symLayers.length, text: !!textLayer, icon: !!iconLayer, hasRail,
      tgLayer: !!tgLayer, tgRotate: /heading/.test(JSON.stringify(tgLayer?.layout || "")), hasTg };
  });
  rec("D.maplibre.layers", d.symN === 2 && d.text && d.icon,
    `symbol レイヤ text=${d.text} icon=${d.icon} n=${d.symN}`);
  rec("D.maplibre.maki", d.hasRail, `kasc-ssym-rail 画像登録=${d.hasRail}`);
  rec("D.maplibre.tgIcon", d.tgLayer && d.hasTg && d.tgRotate,
    `togeojson icon → layer=${d.tgLayer} image=${d.hasTg} rotate=${d.tgRotate}`);
} catch (e) { rec("D.maplibre", false, `maplibre FAILED ${String(e).slice(0, 150)}`); }

// ============ Phase E: openlayers 実機 ============
try {
  await page.goto(`${base}/openlayers/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kascMap && window.kasugaiApi, { timeout: 120000 });
  await page.waitForTimeout(8000);
  const e = await page.evaluate(() => {
    const map = window.kascMap;
    const out = { text: null, icon: null, tg: null };
    for (const layer of map.getLayers().getArray()) {
      const src = layer.getSource?.();
      if (!src?.getFeatures) continue;
      const feats = src.getFeatures();
      if (!feats.some(f => String(f.get?.("marker-symbol") || ""))) continue;
      const fn = layer.getStyleFunction();
      for (const f of feats) {
        // togeojson icon: 地物 icon URL → Icon スタイル(scale/opacity/rotation)
        if (String(f.get?.("icon") || "").startsWith("data:image")) {
          const st = fn(f, 1);
          const arr = Array.isArray(st) ? st : [st];
          const img = arr.map(s => s?.getImage?.()).find(i => i && typeof i.getSrc === "function");
          if (img && !out.tg) out.tg = { src: String(img.getSrc()).slice(0, 30),
            w: img.getWidth?.(), opacity: img.getOpacity?.(), rotation: img.getRotation?.() };
          continue;
        }
        const sym = String(f.get?.("marker-symbol") || "");
        if (!sym) continue;
        const st = fn(f, 1);
        const arr = Array.isArray(st) ? st : [st];
        if (sym.length === 1) {
          const txt = arr.map(s => s?.getText?.()).find(Boolean);
          if (txt && !out.text) out.text = { value: txt.getText(), styles: arr.length };
        } else {
          const icon = arr.map(s => s?.getImage?.()).find(i => i && typeof i.getSrc === "function");
          if (icon && !out.icon) out.icon = { src: icon.getSrc(), styles: arr.length };
        }
      }
    }
    return out;
  });
  rec("E.openlayers.text", e.text?.value === "A" || e.text?.value === "7",
    `1文字 → Text style value=${e.text?.value} styles=${e.text?.styles}`);
  rec("E.openlayers.maki", /maki.*rail\.svg/.test(e.icon?.src || ""),
    `Maki → Icon style src=${e.icon?.src}`);
  rec("E.openlayers.tgIcon", /data:image/.test(e.tg?.src || "") && (!e.tg?.w || e.tg?.w === 64)
      && e.tg?.opacity === 0.5 && Math.abs(e.tg?.rotation - Math.PI / 2) < 1e-6,
    `togeojson icon → Icon src=${e.tg?.src}… w=${e.tg?.w} op=${e.tg?.opacity} rot=${e.tg?.rotation}`);
} catch (e) { rec("E.openlayers", false, `openlayers FAILED ${String(e).slice(0, 150)}`); }

// ============ Phase F: cesium 実機 (entity 経路 = GeoJsonDataSource ネイティブ) ============
try {
  await page.goto(`${base}/cesium/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window._viewer && window.kasugaiApi, { timeout: 90000 });
  await page.waitForTimeout(8000);
  const f = await page.evaluate(() => {
    const out = { layerN: 0, bb: 0, imgKinds: [], tg: null };
    for (const l of window.kasugaiApi.listLayers()) {
      if (!(l.title || "").includes("simplestyle")) continue;
      const n = window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? -1;
      out.layerN = n;
    }
    for (let i = 0; i < window._viewer.dataSources.length; i++) {
      const ds = window._viewer.dataSources.get(i);
      for (const en of ds.entities.values) {
        const props = en.properties ? Object.fromEntries(
          Object.entries(en.properties.getValue(Cesium.JulianDate.now()) || {})) : {};
        if ("marker-symbol" in props && en.billboard) { out.bb++; out.imgKinds.push(typeof en.billboard.image?.getValue?.() ?? "?"); }
        // togeojson icon → billboard.image を icon URL へ差し替え(scale/rotation/color)
        if (String(props.icon || "").startsWith("data:image") && en.billboard) {
          const img = en.billboard.image?.getValue?.();
          out.tg = { img: typeof img === "string" ? img.slice(0, 30) : String(img),
            scale: en.billboard.scale?.getValue?.(),
            rotation: en.billboard.rotation?.getValue?.() };
        }
      }
    }
    return out;
  });
  rec("F.cesium.layer", f.layerN === 7, `simplestyle 層地物数=${f.layerN}`);
  // GeoJsonDataSource は marker-color/size/symbol を PinBuilder で billboard 化する
  rec("F.cesium.pin", f.bb >= 3 && f.imgKinds.every(k => /canvas|image|object/i.test(k)),
    `marker-symbol billboard 数=${f.bb} kinds=${JSON.stringify(f.imgKinds)}`);
  rec("F.cesium.tgIcon", /data:image/.test(f.tg?.img || "") && f.tg?.scale === 2
      && Math.abs(f.tg?.rotation - (-Math.PI / 2)) < 1e-6,
    `togeojson icon → billboard img=${f.tg?.img}… scale=${f.tg?.scale} rot=${f.tg?.rotation}`);
} catch (e) { rec("F.cesium", false, `cesium FAILED ${String(e).slice(0, 150)}`); }

// ============ Phase G: navara 実機 (billboard 地物別 canvas バッジ) ============
try {
  await page.goto(`${base}/navara/?kasc=${KASC}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.kasugaiApi, { timeout: 90000 });
  await page.waitForTimeout(10000);
  const g = await page.evaluate(() => {
    const out = { n: -1, style: null };
    for (const l of window.kasugaiApi.listLayers()) {
      if (!(l.title || "").includes("simplestyle")) continue;
      out.n = window.kasugaiApi.getLayerGeoJson?.(l.id)?.features?.length ?? -1;
      out.style = window.kasugaiApi.getLayerStyle?.(l.id) || null;
    }
    return out;
  });
  rec("G.navara.layer", g.n === 7, `simplestyle 層地物数=${g.n}`);
  // marker-symbol 地物を含むと point ではなく billboard マテリアルが使われる
  rec("G.navara.billboard", g.style?.billboard === true,
    `marker-symbol → billboard マテリアル style=${JSON.stringify(g.style)}`);
} catch (e) { rec("G.navara", false, `navara FAILED ${String(e).slice(0, 150)}`); }

await page.screenshot({ path: `${OUT}geojson-style-cesium.png` });
srv.close();
await ctx.close();
const fails = results.filter(r => !r.ok).length;
const gaps = results.filter(r => r.gap).length;
console.log(`\n${results.length - fails - gaps}/${results.length - gaps} PASS (適合項目) / GAP ${gaps} 件 (未実装仕様)`);
process.exit(fails ? 1 : 0);
