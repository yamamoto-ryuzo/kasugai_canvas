// 帳票テンプレート出力（geo_report 相当、#72）
// 地物属性を {{field}} で差し込んだ定型帳票をブラウザ完結で生成し、
// window.print() 経由で印刷/PDF 出力する。テンプレートは JSON で
// 定義し localStorage へ保存/一覧/適用できる。1地物1帳票・一括出力は
// CSS の page-break で複数ページ連続出力する。
//
// createReportTool({
//   host:         帳票セクションを注入する要素,
//   captureMap:   async () => dataURL,          // 地図画像（出力時のみ取得）
//   listLayers:   () => [{ id, title }],        // 帳票対象レイヤ
//   getFeatures:  (id) => Feature[],            // GeoJSON features
//   t:            (key) => string,              // 任意 i18n
// }) → { open() }

const LS_KEY = "kasc.report.templates";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const propText = v => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

// {{field}} / {{displayExpression}} 差し込み。displayExpression は
// 「"属性A" || ' ' || "属性B"」式を属性名参照つき連結として評価する
function fillTemplate(str, props, layerTitle, date) {
  return String(str ?? "")
    .replace(/\{\{\s*displayExpression\s*\}\}/g, () => evalDisplayExpr(props))
    .replace(/\{\{\s*date\s*\}\}/g, date)
    .replace(/\{\{\s*layer\s*\}\}/g, layerTitle || "")
    .replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_, k) => propText(props?.[k]));
}
function evalDisplayExpr(props) {
  const d = props?.__displayExpression || props?.displayExpression;
  if (!d) return "";
  const out = String(d).replace(/"([\w.$-]+)"|'([^']*)'/g, (m, a, b) =>
    a ? propText(props[a]) : (b ?? ""));
  return out.replace(/\|\||&&/g, "");
}

const BUILTIN = {
  id: "__default__",
  name: "標準帳票",
  json: {
    title: "地物調査票 — {{layer}}",
    showMap: true, mapHeight: 300,
    fields: [],            // 空 = 全属性
    footer: "出力日: {{date}}　レイヤ: {{layer}}",
  },
};
function loadTemplates() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch (e) { return []; }
}
function saveTemplates(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
}

function buildReportHtml(tpl, entries, mapDataUrl) {
  const date = new Date().toLocaleDateString("ja-JP");
  const pages = entries.map(({ props, layerTitle }) => {
    const fields = tpl.json.fields?.length ? tpl.json.fields : Object.keys(props || {});
    const rows = fields.map(k =>
      `<tr><th>${esc(k)}</th><td>${esc(propText(props?.[k]))}</td></tr>`).join("");
    const map = tpl.json.showMap !== false && mapDataUrl
      ? `<div class="map"><img src="${mapDataUrl}" alt="map"></div>` : "";
    return `<div class="page">
      <h1>${esc(fillTemplate(tpl.json.title, props, layerTitle, date))}</h1>
      ${map}
      <table>${rows}</table>
      <footer>${esc(fillTemplate(tpl.json.footer, props, layerTitle, date))}</footer>
    </div>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>帳票</title><style>
    body { font-family: system-ui, "Yu Gothic", sans-serif; margin: 12mm; }
    .page { page-break-after: always; }
    .page:last-child { page-break-after: auto; }
    h1 { font-size: 18px; border-bottom: 2px solid #31564f; padding-bottom: 6px; }
    .map img { width: 100%; max-height: ${Number(tpl.json.mapHeight) || 300}px; object-fit: contain; border: 1px solid #ccc; }
    table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 12px; }
    th, td { border: 1px solid #999; padding: 5px 8px; text-align: left; vertical-align: top; }
    th { background: #f0f4f3; width: 32%; }
    footer { margin-top: 8px; font-size: 10px; color: #666; }
    @media print { body { margin: 8mm; } }
  </style></head><body>${pages}</body></html>`;
}

export function createReportTool({ host, captureMap, listLayers, getFeatures, t = k => k } = {}) {
  if (!host) return null;
  const det = document.createElement("details");
  det.id = "report-tool";
  det.innerHTML = `
    <summary style="cursor:pointer;font-weight:700;padding:6px 0;">帳票出力</summary>
    <div style="padding:4px 0 8px;font-size:0.9em;">
      <div style="display:flex;gap:6px;margin-bottom:4px;">
        <select id="report-tpl" style="flex:1;min-width:0;border:1px solid #cbd9de;border-radius:4px;padding:5px 6px;"></select>
        <button id="report-tpl-save" type="button" title="現在のテンプレートJSONを保存">保存</button>
      </div>
      <textarea id="report-tpl-json" rows="6" spellcheck="false" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:0.8em;border:1px solid #cbd9de;border-radius:4px;"></textarea>
      <div style="display:flex;gap:6px;margin-top:4px;">
        <select id="report-layer" style="flex:1;min-width:0;border:1px solid #cbd9de;border-radius:4px;padding:5px 6px;"></select>
        <select id="report-feature" style="flex:1;min-width:0;border:1px solid #cbd9de;border-radius:4px;padding:5px 6px;"></select>
      </div>
      <label style="display:flex;gap:4px;align-items:center;margin-top:4px;font-size:0.85em;">
        <input id="report-all" type="checkbox"> 選択レイヤの全地物を一括出力（1地物1ページ）
      </label>
      <label style="display:flex;gap:4px;align-items:center;font-size:0.85em;">
        <input id="report-map" type="checkbox" checked> 地図画像を含める（出力時にキャプチャ）
      </label>
      <button id="report-run" type="button" style="margin-top:6px;width:100%;">帳票を生成して印刷</button>
      <div id="report-status" style="font-size:0.8em;color:#666;margin-top:4px;"></div>
    </div>`;
  host.appendChild(det);

  const $ = id => det.querySelector(id);
  const tplSel = $("#report-tpl"), tplJson = $("#report-tpl-json");
  const layerSel = $("#report-layer"), featSel = $("#report-feature");
  const statusEl = $("#report-status");

  function refreshTplList() {
    const list = [BUILTIN, ...loadTemplates()];
    tplSel.innerHTML = list.map(t2 => `<option value="${esc(t2.id)}">${esc(t2.name)}</option>`).join("");
    tplJson.value = JSON.stringify(list[0].json, null, 2);
  }
  tplSel.addEventListener("change", () => {
    const t2 = [BUILTIN, ...loadTemplates()].find(x => String(x.id) === tplSel.value);
    if (t2) tplJson.value = JSON.stringify(t2.json, null, 2);
  });
  $("#report-tpl-save").addEventListener("click", () => {
    try {
      const json = JSON.parse(tplJson.value);
      const name = prompt("テンプレート名", json.title?.slice(0, 30) || "帳票");
      if (!name) return;
      const list = loadTemplates().filter(x => x.name !== name);
      list.push({ id: "u" + Date.now(), name, json });
      statusEl.textContent = saveTemplates(list) ? `「${name}」を保存しました` : "保存に失敗しました";
      refreshTplList();
    } catch (e) { statusEl.textContent = "テンプレートJSONが不正です: " + e.message; }
  });

  function refreshLayers() {
    const ls = (listLayers?.() || []);
    layerSel.innerHTML = ls.map(o => `<option value="${esc(o.id)}">${esc(o.title || o.id)}</option>`).join("");
    refreshFeatures();
  }
  function refreshFeatures() {
    const feats = featuresFor(layerSel.value);
    featSel.innerHTML = feats.map((f, i) => {
      const p = f?.properties || {};
      const label = propText(Object.values(p)[0]) || `feature ${i + 1}`;
      return `<option value="${i}">${esc(label)}</option>`;
    }).join("");
  }
  function featuresFor(layerId) {
    try { return getFeatures?.(layerId) || []; } catch (e) { return []; }
  }
  layerSel.addEventListener("change", refreshFeatures);

  $("#report-run").addEventListener("click", async () => {
    try {
      const tpl = { name: "custom", json: JSON.parse(tplJson.value) };
      const layer = (listLayers?.() || []).find(o => String(o.id) === layerSel.value);
      const feats = featuresFor(layerSel.value);
      if (!feats.length) { statusEl.textContent = "対象地物がありません"; return; }
      const picked = $("#report-all").checked ? feats : [feats[Number(featSel.value) || 0]];
      statusEl.textContent = "地図画像を取得中…";
      let mapUrl = "";
      if ($("#report-map").checked && captureMap) mapUrl = await captureMap().catch(() => "");
      const entries = picked.map(f => ({ props: f?.properties || {}, layerTitle: layer?.title || "" }));
      const html = buildReportHtml(tpl, entries, mapUrl);
      const w = window.open("", "_blank");
      if (!w) { statusEl.textContent = "ポップアップがブロックされました"; return; }
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => { try { w.print(); } catch (e) {} }, 400);
      statusEl.textContent = `${entries.length} 件の帳票を生成しました（印刷ダイアログでPDF保存可）`;
    } catch (e) {
      statusEl.textContent = "帳票生成に失敗: " + (e?.message || e);
    }
  });

  function open() {
    det.open = true;
    refreshTplList();
    refreshLayers();
  }
  refreshTplList();
  refreshLayers();
  return { open, refreshLayers };
}
