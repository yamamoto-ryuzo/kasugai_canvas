// CKAN データカタログ検索 → レイヤ追加プラグイン（geo_import 相当）。
// CKAN Action API (package_search) はブラウザから直接呼べるため CDN 配信のみで動く。
// 検索実行時のみ package_search、レイヤ化はリソース選択時に api.addLayer で行う。
const PRESETS = [
  { name: "data.go.jp", base: "https://catalog.data.go.jp" },
  { name: "G空間情報センター", base: "https://www.geospatial.jp" },
  { name: "東京都オープンデータ", base: "https://catalog.data.metro.tokyo.lg.jp" },
  { name: "カスタム…", base: "" },
];
const ROWS = 20;

// CKAN リソース → Canvas 行タイプ。未対応は {disabled: 理由}
function resourceKind(r) {
  const f = (r.format || "").toLowerCase();
  const u = (r.url || "").split("?")[0].toLowerCase();
  const has = (...xs) => f === xs[0] || xs.some(x => u.endsWith("." + x));
  if (/\{[zxy]\}/.test(r.url || "") || has("xyz")) return { type: "xyz" };
  if (has("geojson", "geojson", "json")) return { type: "geojson" };
  if (has("fgb", "flatgeobuf")) return { type: "flatgeobuf" };
  if (has("csv")) return { type: "duckdb", options: "format=csv" };
  if (has("tsv")) return { type: "duckdb", options: "format=tsv" };
  if (has("gpkg")) return { type: "gpkg", hub: true };
  if (has("parquet", "geoparquet")) return { type: "geoparquet", hub: true };
  if (has("zip", "shp")) return { disabled: "ZIP/SHP は展開が必要なため未対応" };
  if (has("wms")) return { disabled: "WMS は現バージョン未対応" };
  return { disabled: `未対応形式 (${r.format || "不明"})` };
}

const css = document.createElement("style");
css.textContent = `
#ckan-cat-btn{position:fixed;right:12px;bottom:12px;z-index:9500;padding:6px 10px;border-radius:6px;border:1px solid #9db8c0;background:#fff;cursor:pointer;}
#ckan-cat{position:fixed;right:12px;bottom:52px;width:380px;max-height:70vh;overflow:auto;z-index:9501;background:#fff;border:1px solid #9db8c0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);padding:10px;font-size:13px;display:none;}
#ckan-cat select,#ckan-cat input[type=text]{width:100%;box-sizing:border-box;padding:4px;margin:2px 0;border:1px solid #cbd9de;border-radius:4px;}
#ckan-cat .row{display:flex;gap:6px;align-items:center;}
#ckan-cat .ds{border-top:1px solid #e3eaec;padding:6px 0;}
#ckan-cat .ds h4{margin:0 0 4px;font-size:13px;}
#ckan-cat .res{display:flex;justify-content:space-between;gap:6px;font-size:12px;padding:2px 0;}
#ckan-cat .res button{white-space:nowrap;padding:2px 8px;border:1px solid #9db8c0;border-radius:4px;background:#eef6f8;cursor:pointer;}
#ckan-cat .res button:disabled{background:#f0f0f0;color:#999;cursor:not-allowed;}
#ckan-cat .pager{display:flex;justify-content:space-between;margin-top:6px;}
#ckan-cat .hint{color:#666;font-size:11px;}`;
document.head.appendChild(css);

export default async function init(api) {
  const btn = document.createElement("button");
  btn.id = "ckan-cat-btn"; btn.textContent = "カタログ検索";
  const panel = document.createElement("div");
  panel.id = "ckan-cat";
  panel.innerHTML = `
    <div class="row"><b style="flex:1">CKAN データカタログ検索</b>
      <button id="ckan-close" style="border:none;background:none;cursor:pointer;font-size:14px;">✕</button></div>
    <select id="ckan-server">${PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join("")}</select>
    <input id="ckan-base" type="text" placeholder="カタログ URL（カスタム時）" hidden>
    <input id="ckan-proxy" type="text" placeholder="プロキシ URL（任意・CORS非対応向け）">
    <div class="row"><input id="ckan-q" type="text" placeholder="キーワード">
      <button id="ckan-search">検索</button></div>
    <div id="ckan-status" class="hint"></div>
    <div id="ckan-results"></div>
    <div class="pager"><button id="ckan-prev">←前</button><span id="ckan-page" class="hint"></span><button id="ckan-next">次→</button></div>`;
  document.body.append(btn, panel);
  btn.onclick = () => { panel.style.display = panel.style.display === "none" ? "block" : "none"; };
  panel.querySelector("#ckan-close").onclick = () => { panel.style.display = "none"; };

  const $ = (id) => panel.querySelector(id);
  $("#ckan-server").onchange = () => {
    $("#ckan-base").hidden = PRESETS[+$("#ckan-server").value].base !== "";
  };
  let start = 0, total = 0;

  const apiBase = () => {
    const i = +$("#ckan-server").value;
    const base = (PRESETS[i].base || $("#ckan-base").value.trim()).replace(/\/+$/, "");
    return base ? base + "/api/3/action" : null;
  };
  const via = (url) => { const p = $("#ckan-proxy").value.trim(); return p ? p + url : url; };

  async function search() {
    const base = apiBase();
    if (!base) { $("#ckan-status").textContent = "カタログ URL を入力してください"; return; }
    $("#ckan-status").textContent = "検索中…";
    $("#ckan-results").innerHTML = "";
    try {
      const u = `${base}/package_search?q=${encodeURIComponent($("#ckan-q").value.trim())}&rows=${ROWS}&start=${start}`;
      const j = await (await fetch(u)).json();
      if (!j.success) throw new Error(j.error?.message || "package_search failed");
      total = j.result.count;
      $("#ckan-page").textContent = `${start + 1}-${Math.min(start + ROWS, total)} / ${total}`;
      $("#ckan-status").textContent = total ? "" : "該当なし";
      render(j.result.results);
    } catch (e) { $("#ckan-status").textContent = "検索失敗: " + e.message; }
  }

  function render(list) {
    const out = $("#ckan-results");
    for (const ds of list) {
      const d = document.createElement("div");
      d.className = "ds";
      d.innerHTML = `<h4>${ds.title || ds.name}</h4>` +
        (ds.resources || []).map((r, i) => {
          const k = resourceKind(r);
          const dis = k.disabled || (k.hub && !hasBackend() ? "ローカルアプリ（bridge-hub）が必要" : null);
          return `<div class="res"><span title="${r.url || ""}">${r.name || r.format || "resource"} [${r.format || "?"}]</span>` +
            `<button data-ds="${ds.id}" data-i="${i}" ${dis ? `disabled title="${dis}"` : ""}>${dis ? "未対応" : "追加"}</button></div>`;
        }).join("");
      d._ds = ds;
      d.querySelectorAll("button[data-i]").forEach(b => {
        b.onclick = () => addResource(ds, ds.resources[+b.dataset.i]);
      });
      out.appendChild(d);
    }
  }

  function hasBackend() {
    try { return !!(api.backendAlive?.() ?? window.kasugaiApi?.capabilities?.backend); }
    catch { return false; }
  }

  async function addResource(ds, r) {
    const k = resourceKind(r);
    if (k.disabled) return;
    const st = $("#ckan-status");
    try {
      st.textContent = `追加中: ${r.name || ds.title}`;
      const title = `${ds.title || ds.name} — ${r.name || r.format || ""}`;
      await api.addLayer(title, via(r.url), { type: k.type, options: k.options || "" });
      st.textContent = `追加しました: ${title}`;
    } catch (e) { st.textContent = "追加失敗: " + e.message; }
  }

  $("#ckan-search").onclick = () => { start = 0; void search(); };
  $("#ckan-prev").onclick = () => { start = Math.max(0, start - ROWS); void search(); };
  $("#ckan-next").onclick = () => { if (start + ROWS < total) { start += ROWS; void search(); } };
  $("#ckan-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { start = 0; void search(); } });

  api.registerPlugin({
    id: "ckan-catalog", name: "CKAN カタログ検索", version: "1.0.0",
    dispose() { btn.remove(); panel.remove(); css.remove(); },
  });
}
