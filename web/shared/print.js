// KASUGAI Canvas — 印刷・帳票出力(共有モジュール)
//
// 全エンジン共通の印刷ダイアログ。地図を画像化してタイトル・凡例・縮尺バー・
// 方位・出典・日付を付加した帳票を canvas2d で合成し、window.print() /
// PNGダウンロードで出力する。
// QGIS(geo_webview 内蔵HTTPサーバ :8089)が検出できた場合のみ、
// QGISの印刷レイアウトをそのままPDF出力するセクションを表示する。
//
// 使い方(各エンジン app.js):
//   initPrint({
//     button: document.querySelector("#print-open"),
//     captureMap: async () => dataURL,     // 地図→dataURL
//     getScaleDenominator: () => 25000,    // 縮尺分母(省略可)
//     getNorthAngleDeg: () => -bearing,    // 方位記号の回転角(省略時0)
//     t,                                   // i18n関数(省略時は日本語固定)
//   });

const JA = {
  "print.open": "印刷",
  "print.dialogTitle": "印刷",
  "print.fieldTitle": "タイトル",
  "print.fieldPaper": "用紙",
  "print.paperA4L": "A4 横",
  "print.paperA4P": "A4 縦",
  "print.paperA3L": "A3 横",
  "print.paperA3P": "A3 縦",
  "print.fieldDpi": "解像度",
  "print.dpiStandard": "標準 (150dpi)",
  "print.dpiHigh": "高精細 (300dpi)",
  "print.optLegend": "凡例",
  "print.optScale": "縮尺バー",
  "print.optNorth": "方位",
  "print.optAttr": "出典",
  "print.optDate": "日付",
  "print.doPrint": "印刷",
  "print.doPng": "PNG保存",
  "print.close": "閉じる",
  "print.qgisSection": "QGIS レイアウトPDF",
  "print.qgisLayout": "レイアウト",
  "print.qgisPdf": "選択レイアウトをPDF出力",
  "print.qgisEmpty": "QGISプロジェクトにレイアウトがありません",
  "print.capturing": "地図を取得中…",
  "print.captureFailed": "地図画像を取得できませんでした(地図なしで出力)",
  "print.pdfExporting": "QGISでPDF出力中…",
  "print.pdfFailed": "PDF出力に失敗しました",
  "print.scalePrefix": "縮尺 1:",
};

// 用紙サイズ[mm]
const PAPERS = {
  a4l: { w: 297, h: 210 },
  a4p: { w: 210, h: 297 },
  a3l: { w: 420, h: 297 },
  a3p: { w: 297, h: 420 },
};

// geo_webview の優先ポートは8089。占有時は連番フォールバックするため
// 検出は8089-8091を順に試す
const QGIS_PORTS = [8089, 8090, 8091];

const mm2px = (mm, dpi) => Math.round(mm / 25.4 * dpi);

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// コンテナ内の全 canvas 要素をDOM順に合成して1枚の canvas を返す。
// 各 canvas は getBoundingClientRect() の表示位置に描画するため、
// transform や deck.gl 等のオーバーレイ canvas も正しく重なる。
export function compositeCanvases(container) {
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  // 基準canvas(最大面積)のピクセル密度に合わせる
  const els = [...container.querySelectorAll("canvas")].filter(c => c.width > 0 && c.height > 0 && c.getBoundingClientRect().width > 0);
  if (!els.length) return null;
  const base = els.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const baseRect = base.getBoundingClientRect();
  const scale = base.width / baseRect.width;
  const out = document.createElement("canvas");
  out.width = Math.round(rect.width * scale);
  out.height = Math.round(rect.height * scale);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const alpha = parseFloat(getComputedStyle(el).opacity || "1");
    ctx.globalAlpha = Number.isFinite(alpha) ? alpha : 1;
    ctx.drawImage(
      el,
      (r.left - rect.left) * scale, (r.top - rect.top) * scale,
      r.width * scale, r.height * scale);
  }
  ctx.globalAlpha = 1;
  return out;
}

// Leaflet 用: img/canvas/svg をDOM順に合成する(タイル・SVGオーバーレイ・
// マーカー画像を含む)。{ canvas, partial } を返す。CORS未対応で汚染される
// 要素がある場合はそれらを除いた部分合成(partial=true)にフォールバックする。
export async function compositeDomMap(container) {
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pane = container.querySelector(".leaflet-map-pane");
  const root = pane || container;
  const els = [...root.querySelectorAll("img, canvas, svg")];

  // 読み込み中のタイルimgはデコード完了を待つ(上限8s)
  const pending = els.filter(el => el.tagName === "IMG" && !el.complete);
  if (pending.length) {
    await Promise.race([
      Promise.allSettled(pending.map(el =>
        (el.decode ? el.decode() : Promise.resolve()).catch(() => {}))),
      new Promise(r => setTimeout(r, 8000)),
    ]);
  }

  const build = async (skipTainting) => {
    const out = document.createElement("canvas");
    out.width = Math.round(rect.width * dpr);
    out.height = Math.round(rect.height * dpr);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // 汚染源になり得るimg: クロスオリジンで crossOrigin 属性なし
      if (skipTainting && el.tagName === "IMG" && !el.crossOrigin &&
          el.src && !el.src.startsWith(location.origin) &&
          !el.src.startsWith("data:") && !el.src.startsWith("blob:")) continue;
      const x = (r.left - rect.left) * dpr;
      const y = (r.top - rect.top) * dpr;
      const w = r.width * dpr;
      const h = r.height * dpr;
      const alpha = parseFloat(getComputedStyle(el).opacity || "1");
      ctx.globalAlpha = Number.isFinite(alpha) ? alpha : 1;
      try {
        if (el instanceof SVGElement) {
          const svg = el.cloneNode(true);
          svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
          svg.setAttribute("width", String(Math.ceil(r.width)));
          svg.setAttribute("height", String(Math.ceil(r.height)));
          const url = "data:image/svg+xml;charset=utf-8," +
            encodeURIComponent(new XMLSerializer().serializeToString(svg));
          const img = await loadImage(url);
          if (img) ctx.drawImage(img, x, y, w, h);
        } else {
          ctx.drawImage(el, x, y, w, h);
        }
      } catch { /* 取得不可要素はスキップ */ }
    }
    ctx.globalAlpha = 1;
    return out;
  };

  const full = await build(false);
  try {
    full.getContext("2d").getImageData(0, 0, 1, 1);
    return { canvas: full, partial: false };
  } catch {
    // 汚染要素を除いて再合成(該当タイルは抜けるが全体は出力できる)
    return { canvas: await build(true), partial: true };
  }
}

// 凡例パネルの DOM から凡例行を収集する(全エンジン .legend-row 共通)
function scrapeLegendEntries() {
  const out = [];
  for (const row of document.querySelectorAll(".legend-row")) {
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) continue;
    const label = row.querySelector(".legend-label")?.textContent?.trim();
    const sw = row.querySelector("img.legend-swatch")?.src || null;
    if (label) out.push({ label, sw });
    if (out.length >= 40) break;
  }
  return out;
}

function scrapeAttribution() {
  const el = document.querySelector("#map-attribution");
  const text = el?.textContent?.replace(/\s+/g, " ").trim();
  return text || "";
}

function defaultTitle() {
  const el = document.querySelector(".panel-title-text");
  if (el) {
    const node = [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    const text = (node ? node.textContent : el.textContent).trim();
    if (text) return text;
  }
  return (document.title || "").trim();
}

// "きれいな"縮尺バー長(m)を選ぶ。barPx <= maxPx になる最大の 1/2/5×10^n
function niceScaleBar(denominator, maxPx) {
  if (!(denominator > 0)) return null;
  const mpp = denominator * 0.00028;
  let best = null;
  for (let e = -2; e <= 7; e++) {
    for (const m of [1, 2, 5]) {
      const meters = m * Math.pow(10, e);
      const px = meters / mpp;
      if (px <= maxPx && (!best || px > best.px)) best = { meters, px };
    }
  }
  return best;
}

const fmtScaleLen = m => (m >= 1000 ? `${m / 1000} km` : `${m} m`);

export function initPrint(opts) {
  const t = typeof opts.t === "function" ? opts.t : (k) => JA[k] ?? k;
  const tr = (k) => { const v = t(k); return v === k ? (JA[k] ?? k) : v; };
  const btn = opts.button;
  if (!btn) return;

  // --- ダイアログDOM(初回のみ生成) ---
  const dlg = document.createElement("div");
  dlg.id = "print-dialog";
  dlg.hidden = true;
  dlg.style.cssText =
    "position:fixed;top:60px;right:16px;z-index:10000;width:300px;" +
    "background:rgba(255,255,255,.97);border:1px solid #d9e4e9;border-radius:8px;" +
    "box-shadow:0 12px 36px rgba(10,20,40,.25);font-size:13px;color:#1d2b35;";
  dlg.innerHTML = `
    <div style="display:flex;align-items:center;padding:7px 10px;border-bottom:1px solid #e4ecef;background:rgba(49,86,79,.1);border-radius:8px 8px 0 0;">
      <span style="flex:1;font-weight:700;color:#31564f;">${tr("print.dialogTitle")}</span>
      <button id="print-close" type="button" style="border:0;border-radius:4px;background:rgba(49,86,79,.16);color:#31564f;width:24px;height:24px;cursor:pointer;">×</button>
    </div>
    <div style="padding:10px 12px;display:flex;flex-direction:column;gap:7px;">
      <label style="display:flex;flex-direction:column;gap:3px;">${tr("print.fieldTitle")}
        <input id="print-title-input" type="text" style="padding:4px 6px;border:1px solid #cbd9de;border-radius:4px;">
      </label>
      <div style="display:flex;gap:8px;">
        <label style="flex:1;display:flex;flex-direction:column;gap:3px;">${tr("print.fieldPaper")}
          <select id="print-paper" style="padding:4px;border:1px solid #cbd9de;border-radius:4px;">
            <option value="a4l" selected>${tr("print.paperA4L")}</option>
            <option value="a4p">${tr("print.paperA4P")}</option>
            <option value="a3l">${tr("print.paperA3L")}</option>
            <option value="a3p">${tr("print.paperA3P")}</option>
          </select>
        </label>
        <label style="flex:1;display:flex;flex-direction:column;gap:3px;">${tr("print.fieldDpi")}
          <select id="print-dpi" style="padding:4px;border:1px solid #cbd9de;border-radius:4px;">
            <option value="150" selected>${tr("print.dpiStandard")}</option>
            <option value="300">${tr("print.dpiHigh")}</option>
          </select>
        </label>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px 12px;">
        <label><input id="print-opt-legend" type="checkbox" checked> ${tr("print.optLegend")}</label>
        <label><input id="print-opt-scale" type="checkbox" checked> ${tr("print.optScale")}</label>
        <label><input id="print-opt-north" type="checkbox" checked> ${tr("print.optNorth")}</label>
        <label><input id="print-opt-attr" type="checkbox" checked> ${tr("print.optAttr")}</label>
        <label><input id="print-opt-date" type="checkbox" checked> ${tr("print.optDate")}</label>
      </div>
      <div id="print-qgis-section" hidden style="border-top:1px solid #e4ecef;padding-top:7px;">
        <div style="font-weight:600;margin-bottom:4px;">${tr("print.qgisSection")}</div>
        <label style="display:flex;flex-direction:column;gap:3px;">${tr("print.qgisLayout")}
          <select id="print-qgis-layout" style="padding:4px;border:1px solid #cbd9de;border-radius:4px;"></select>
        </label>
        <button id="print-qgis-pdf" type="button" style="margin-top:6px;width:100%;padding:5px;border:1px solid #31564f;border-radius:4px;background:#fff;color:#31564f;cursor:pointer;">${tr("print.qgisPdf")}</button>
        <p id="print-qgis-status" style="margin:4px 0 0;font-size:0.85em;color:#666;"></p>
      </div>
      <div style="display:flex;gap:8px;margin-top:2px;">
        <button id="print-do" type="button" style="flex:1;padding:6px;border:1px solid #31564f;border-radius:4px;background:#31564f;color:#fff;cursor:pointer;">${tr("print.doPrint")}</button>
        <button id="print-png" type="button" style="flex:1;padding:6px;border:1px solid #31564f;border-radius:4px;background:#fff;color:#31564f;cursor:pointer;">${tr("print.doPng")}</button>
      </div>
      <p id="print-status" aria-live="polite" style="margin:0;font-size:0.85em;color:#666;min-height:1em;"></p>
    </div>`;
  document.body.appendChild(dlg);

  // 印刷用スタイル(@page は用紙選択に合わせて都度書き換える)
  const style = document.createElement("style");
  style.id = "print-sheet-style";
  document.head.appendChild(style);

  const $ = (id) => dlg.querySelector(id);
  const status = (msg, isError = false) => {
    $("#print-status").textContent = msg;
    $("#print-status").style.color = isError ? "#a82020" : "#666";
  };

  let qgis = null; // { base, layouts }
  btn.addEventListener("click", async () => {
    dlg.hidden = !dlg.hidden;
    if (dlg.hidden) return;
    $("#print-title-input").value = (opts.getTitle?.() ?? defaultTitle());
    // QGIS(geo_webview)検出: ページ自体が :8089 配信なら同一オリジン優先
    const sec = $("#print-qgis-section");
    sec.hidden = true;
    $("#print-qgis-status").textContent = "";
    const bases = location.port === "8089"
      ? [location.origin]
      : QGIS_PORTS.map(p => `http://localhost:${p}`);
    for (const base of bases) {
      try {
        const res = await fetch(`${base}/layouts`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
        if (!res.ok) continue;
        const data = await res.json();
        if (data?.ok && !dlg.hidden) {
          qgis = { base, layouts: data.layouts || [] };
          const sel = $("#print-qgis-layout");
          sel.replaceChildren();
          for (const l of qgis.layouts) {
            const o = document.createElement("option");
            o.value = l.name;
            o.textContent = l.w_mm ? `${l.name} (${l.w_mm}×${l.h_mm}mm)` : l.name;
            sel.appendChild(o);
          }
          $("#print-qgis-status").textContent = qgis.layouts.length ? "" : tr("print.qgisEmpty");
          $("#print-qgis-pdf").disabled = !qgis.layouts.length;
          sec.hidden = false;
          break;
        }
      } catch { /* QGIS未起動 */ }
    }
  });
  $("#print-close").addEventListener("click", () => { dlg.hidden = true; });

  // --- 帳票合成 ---
  async function compose() {
    const paper = PAPERS[$("#print-paper").value] || PAPERS.a4l;
    const dpi = Number($("#print-dpi").value) || 150;
    const W = mm2px(paper.w, dpi), H = mm2px(paper.h, dpi);
    const m = mm2px(12, dpi);                 // 余白
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#1d2b35";
    ctx.strokeStyle = "#1d2b35";

    const u = dpi / 25.4;                     // 1mmあたりpx
    let y = m;
    const title = $("#print-title-input").value.trim();
    if (title) {
      ctx.font = `700 ${Math.round(6 * u)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(title, W / 2, y + 3 * u);
      y += 8 * u;
    }

    const on = (id) => $(id).checked;
    const legend = on("#print-opt-legend") ? scrapeLegendEntries() : [];
    const legendH = legend.length
      ? Math.min(Math.ceil(legend.length / 2), 12) * 4.5 * u + 6 * u : 0;
    const footH = (on("#print-opt-attr") || on("#print-opt-date")) ? 6 * u : 0;
    const mapRect = { x: m, y, w: W - 2 * m, h: H - m - y - legendH - footH };

    // 地図画像
    status(tr("print.capturing"));
    let mapImg = null;
    try {
      const dataUrl = await opts.captureMap?.();
      mapImg = dataUrl ? await loadImage(dataUrl) : null;
    } catch { mapImg = null; }
    if (mapImg) {
      const s = Math.min(mapRect.w / mapImg.width, mapRect.h / mapImg.height);
      const dw = mapImg.width * s, dh = mapImg.height * s;
      const dx = mapRect.x + (mapRect.w - dw) / 2, dy = mapRect.y + (mapRect.h - dh) / 2;
      ctx.drawImage(mapImg, dx, dy, dw, dh);
      ctx.lineWidth = Math.max(1, 0.3 * u);
      ctx.strokeRect(dx, dy, dw, dh);
    } else {
      ctx.fillStyle = "#f4f6f8";
      ctx.fillRect(mapRect.x, mapRect.y, mapRect.w, mapRect.h);
      ctx.fillStyle = "#1d2b35";
      ctx.strokeRect(mapRect.x, mapRect.y, mapRect.w, mapRect.h);
      ctx.font = `${Math.round(3.5 * u)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tr("print.captureFailed"), mapRect.x + mapRect.w / 2, mapRect.y + mapRect.h / 2);
    }

    // 方位記号(地図右上)
    if (on("#print-opt-north")) {
      const ang = (opts.getNorthAngleDeg?.() || 0) * Math.PI / 180;
      const cx = mapRect.x + mapRect.w - 8 * u, cy = mapRect.y + 8 * u;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.fillStyle = "#1d2b35";
      ctx.beginPath();
      ctx.moveTo(0, -5 * u);
      ctx.lineTo(2.2 * u, 2 * u);
      ctx.lineTo(0, 0.8 * u);
      ctx.lineTo(-2.2 * u, 2 * u);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(-ang);
      ctx.font = `700 ${Math.round(4 * u)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("N", 0, 5 * u);
      ctx.restore();
    }

    // 縮尺バー + 縮尺表記(地図左下)
    if (on("#print-opt-scale")) {
      const denom = opts.getScaleDenominator?.();
      ctx.font = `${Math.round(3.2 * u)}px sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      let by = mapRect.y + mapRect.h - 4 * u;
      const bar = denom ? niceScaleBar(denom, mapRect.w * 0.3) : null;
      if (bar) {
        const bx = mapRect.x + 4 * u;
        const bw = 1.2 * u;
        ctx.fillStyle = "#1d2b35";
        ctx.fillRect(bx, by - 2 * u, bar.px / 2, bw);
        ctx.fillRect(bx + bar.px / 2, by - bw, bar.px / 2, bw);
        ctx.strokeStyle = "#1d2b35";
        ctx.lineWidth = Math.max(1, 0.2 * u);
        ctx.strokeRect(bx, by - 2 * u, bar.px, 2 * u);
        ctx.fillText(fmtScaleLen(bar.meters), bx + bar.px + 2 * u, by);
        by -= 4 * u;
      }
      if (denom) ctx.fillText(`${tr("print.scalePrefix")}${Math.round(denom).toLocaleString()}`, mapRect.x + 4 * u, by - 1 * u);
    }

    // 凡例(地図下・2列組)
    let ly = mapRect.y + mapRect.h;
    if (legend.length) {
      ly += 2 * u;
      ctx.font = `700 ${Math.round(3.5 * u)}px sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(tr("print.optLegend"), m, ly + 2 * u);
      ly += 5 * u;
      const sw = 3.5 * u;
      const colW = (W - 2 * m) / 2;
      const rowsPerCol = Math.ceil(legend.length / 2);
      const swImgs = await Promise.all(legend.map(e => loadImage(e.sw)));
      ctx.font = `${Math.round(3.2 * u)}px sans-serif`;
      for (let i = 0; i < Math.min(legend.length, 24); i++) {
        const col = Math.floor(i / rowsPerCol), row = i % rowsPerCol;
        const lx = m + col * colW, lyy = ly + row * 4.5 * u;
        const img = swImgs[i];
        if (img) ctx.drawImage(img, lx, lyy, sw, sw);
        ctx.fillText(legend[i].label, lx + sw + 1.5 * u, lyy + sw / 2, colW - sw - 3 * u);
      }
    }

    // フッタ(日付・出典)
    const fy = H - m + 2 * u;
    ctx.font = `${Math.round(2.8 * u)}px sans-serif`;
    ctx.textBaseline = "alphabetic";
    if (on("#print-opt-date")) {
      ctx.textAlign = "left";
      ctx.fillText(new Date().toLocaleDateString(), m, fy);
    }
    if (on("#print-opt-attr")) {
      ctx.textAlign = "right";
      ctx.fillText(scrapeAttribution(), W - m, fy, W - 2 * m - 60 * u);
    }
    return c;
  }

  // ブラウザ印刷: 合成画像を print-only のシートに入れて window.print()
  let printing = false;
  $("#print-do").addEventListener("click", async () => {
    if (printing) return;
    printing = true;
    $("#print-do").disabled = true;
    try {
      const c = await compose();
      const paper = PAPERS[$("#print-paper").value] || PAPERS.a4l;
      style.textContent =
        `@page { size: ${paper.w}mm ${paper.h}mm; margin: 0; }` +
        `@media print { body > *:not(#kasc-print-sheet) { display: none !important; }` +
        `#kasc-print-sheet { position: fixed; inset: 0; background: #fff; }` +
        `#kasc-print-sheet img { width: 100%; height: 100%; } }`;
      let sheet = document.querySelector("#kasc-print-sheet");
      if (!sheet) {
        sheet = document.createElement("div");
        sheet.id = "kasc-print-sheet";
        sheet.style.cssText = "position:fixed;left:-10000px;top:0;";
        document.body.appendChild(sheet);
      }
      sheet.innerHTML = "";
      const img = document.createElement("img");
      img.addEventListener("load", () => {
        window.print();
        $("#print-do").disabled = false;
        printing = false;
        status("");
      }, { once: true });
      sheet.appendChild(img);
      img.src = c.toDataURL("image/png");
    } catch (e) {
      $("#print-do").disabled = false;
      printing = false;
      status(String(e), true);
    }
  });

  // PNG 保存
  let saving = false;
  $("#print-png").addEventListener("click", async () => {
    if (saving) return;
    saving = true;
    $("#print-png").disabled = true;
    try {
      const c = await compose();
      const a = document.createElement("a");
      a.href = c.toDataURL("image/png");
      a.download = `${($("#print-title-input").value.trim() || "map").replace(/[\\/:*?"<>|]/g, "_")}.png`;
      a.click();
      status("");
    } catch (e) {
      status(String(e), true);
    } finally {
      $("#print-png").disabled = false;
      saving = false;
    }
  });

  // QGISレイアウトPDF出力(geo_webview /layout-pdf)
  $("#print-qgis-pdf").addEventListener("click", async () => {
    if (!qgis) return;
    const name = $("#print-qgis-layout").value;
    const qs = $("#print-qgis-status");
    $("#print-qgis-pdf").disabled = true;
    qs.textContent = tr("print.pdfExporting");
    qs.style.color = "#666";
    try {
      const res = await fetch(`${qgis.base}/layout-pdf?layout=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
      qs.textContent = "";
    } catch (e) {
      qs.textContent = `${tr("print.pdfFailed")}: ${e.message}`;
      qs.style.color = "#a82020";
    } finally {
      $("#print-qgis-pdf").disabled = false;
    }
  });

  return { dialog: dlg };
}
