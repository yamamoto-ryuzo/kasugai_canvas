// ---- ダッシュボード(dash: 行で構成する地図連動の集計ビュー #123) ----
// 全エンジン共通のダッシュボードUIモジュール。`.kasc` の `dash:` 行で宣言した
// レイヤー属性をクライアント側で集計(DuckDB 等は使わない。追加サーバ不要)し、
// KPI カード・棒グラフ・クロス集計・地物一覧を地図フィルタ(where=)と連動させる。
//
//   dash:名前 | layer=レイヤー名 | kpi=count,sum:列,avg:列,distinct:列,pct:列:値 |
//     chart=列[,列…] | matrix=行,列 | filters=列[,列…] | detail=on|off
//
// - kpi: count=件数 / sum:列=合計 / avg:列=平均 / distinct:列=種類数 /
//        pct:列:値=「列=値」の割合(%)。未指定時は件数+chart先頭列の種類数
// - chart: 指定列の件数棒グラフ。クリックで地図の where= と一覧を絞り込み
//          (もう一度クリックで解除。「遅延のみ表示」等の地図連動フィルタ)
// - matrix: 行×列の件数クロス集計(健全度ランク×施設種別、補修優先度等)
// - filters: 指定列の値ドロップダウンで期間・路線・担当等の絞り込み
// - detail=off: 一覧(明細)を非表示にし統計のみ表示(公開用の権限別表示)
// - CSV: 絞り込み後の明細を出力 / 印刷: パネル内容をレポート印刷
//
// DOM/CSS は本モジュールが注入する(attr-widget と同方式)。各エンジンの
// app.js は dash: 行をパースして保持し、下記アダプタを渡すだけでよい。
//
// createKascDashboard({
//   t?: (key, vars?) => string           — i18n 関数(dash.* キー。無くても動く)
//   getDashSpecs: () => DashSpec[]       — dash: 行の宣言配列
//   listLayers:   () => [{id,title}]     — 属性対象ベクターレイヤ
//   getFeatures:  (idOrTitle) => Feature[] — GeoJSON 地物(properties 集計対象)
//   getLayerWhere?: (idOrTitle) => string|null — 現在の where= (解除判定用)
//   setLayerWhere: (idOrTitle, where|null) => Promise|void — 地図フィルタ適用
//   focusFeature?: (feature) => void     — 一覧行クリック時の地図移動
// }) → { open, close, isOpen, update, updateButton }
// window.kasugaiDashboard = { open, close } も公開する

import { computeGroupStats } from "./attr-stats.js";

const LABELS = {
  open: "ダッシュボード",
  openTitle: "ダッシュボードを開く(📊)",
  close: "閉じる",
  count: "件数",
  sum: "合計",
  avg: "平均",
  distinct: "種類数",
  ratio: "割合",
  filterAll: "（すべて）",
  filter: "絞り込み",
  mapFilterClear: "地図フィルタを解除",
  list: "一覧",
  matched: ({ matched, total }) => `${matched} 件 / 全 ${total} 件`,
  exportCsv: "CSV出力",
  print: "印刷",
  noLayer: "対象レイヤーが見つかりません",
  noFeatures: "該当する地物がありません",
  listLimit: n => `（先頭 ${n} 件のみ表示）`,
};

// GeoJSON Feature の代表点(ジオメトリ頂点の重心)を [lon,lat] で返す。
// focusFeature アダプタが無いエンジンでも一覧クリックを機能させるための共用部品
export function featureCentroid(feature) {
  let sx = 0, sy = 0, n = 0;
  const walk = coords => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      sx += coords[0]; sy += coords[1]; n++;
      return;
    }
    for (const c of coords) walk(c);
  };
  walk(feature?.geometry?.coordinates);
  return n ? [sx / n, sy / n] : null;
}

// 値を where=(OGR SQL)のリテラル・識別子としてクォートする
const quoteIdent = name => `"${String(name).replace(/"/g, '""')}"`;
const quoteStr = value => `'${String(value).replace(/'/g, "''")}'`;

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

const fmt = v => {
  if (v == null || Number.isNaN(v)) return "-";
  return Number.isInteger(v) ? v.toLocaleString() : (Math.round(v * 100) / 100).toLocaleString();
};

// 選択状態 → where= 式を構築する。値は同一列で IN 集合、列間は AND
function buildWhere(sel) {
  const parts = [];
  for (const [field, values] of sel) {
    if (!values.size) continue;
    const vs = [...values].map(quoteStr).join(", ");
    parts.push(values.size === 1 ? `${quoteIdent(field)} = ${vs}` : `${quoteIdent(field)} IN (${vs})`);
  }
  return parts.length ? parts.join(" AND ") : null;
}

export function createKascDashboard(cfg) {
  const {
    t, getDashSpecs = () => [], listLayers = () => [], getFeatures = () => [],
    getLayerWhere = () => null, setLayerWhere, focusFeature,
  } = cfg;
  const tr = (key, vars) => {
    const fallback = LABELS[key];
    const text = t ? t(`dash.${key}`, vars) : null;
    if (text && !text.startsWith("dash.")) return text;
    return typeof fallback === "function" ? fallback(vars) : (fallback ?? key);
  };

  let ui = null;
  let specIndex = 0;
  const sel = new Map(); // field -> Set(value) （ドロップダウン+グラフ+マトリクス共通の絞り込み状態）

  function ensureDom() {
    if (ui) return ui;
    const style = document.createElement("style");
    style.textContent = `
.dash-open{vertical-align:middle}
.dash-overlay{position:fixed;inset:0;z-index:10000;background:rgba(20,24,30,.55);display:flex;align-items:center;justify-content:center}
.dash-overlay[hidden]{display:none}
.dash-dialog{background:#fff;color:#222;width:min(960px,94vw);max-height:88vh;display:flex;flex-direction:column;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.4);overflow:hidden}
.dash-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #ddd;background:#f5f6f8}
.dash-title{font-size:1.05rem;margin:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-tabs{display:flex;gap:4px}
.dash-tab{border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 10px;cursor:pointer;font-size:.85rem}
.dash-tab.active{background:#2b6cb0;color:#fff;border-color:#2b6cb0}
.dash-btn{border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 10px;cursor:pointer;font-size:.85rem}
.dash-btn:hover{background:#eef2f7}
.dash-body{padding:12px 16px;overflow:auto}
.dash-kpis{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.dash-kpi{background:#f5f8fc;border:1px solid #d8e2ef;border-radius:6px;padding:8px 14px;min-width:110px}
.dash-kpi .dash-kpi-label{font-size:.75rem;color:#567;display:block}
.dash-kpi .dash-kpi-value{font-size:1.3rem;font-weight:600}
.dash-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.dash-filters select{font-size:.85rem;padding:2px 4px;max-width:160px}
.dash-clear-map{font-size:.8rem;color:#a33;background:#fdecec;border-color:#e0a8a8}
.dash-chart{margin-bottom:14px}
.dash-chart h4{margin:0 0 6px;font-size:.9rem}
.dash-bar{display:flex;align-items:center;gap:6px;cursor:pointer;padding:1px 4px;border-radius:4px}
.dash-bar:hover{background:#eef4fb}
.dash-bar.active{background:#dcebfb;outline:1px solid #2b6cb0}
.dash-bar .dash-bar-label{width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.8rem;text-align:right;flex:none}
.dash-bar .dash-bar-track{flex:1;background:#eee;border-radius:3px;height:14px}
.dash-bar .dash-bar-fill{background:#4a90d9;height:100%;border-radius:3px;min-width:1px}
.dash-bar.active .dash-bar-fill{background:#2b6cb0}
.dash-bar .dash-bar-count{font-size:.78rem;color:#456;flex:none;width:4em}
.dash-matrix{overflow-x:auto;margin-bottom:14px}
.dash-matrix table{border-collapse:collapse;font-size:.8rem}
.dash-matrix th,.dash-matrix td{border:1px solid #ccc;padding:3px 8px;text-align:right}
.dash-matrix th{background:#f0f2f5;font-weight:600}
.dash-matrix td[data-f]{cursor:pointer}
.dash-matrix td[data-f]:hover{background:#dcebfb}
.dash-matrix td.active{background:#2b6cb0;color:#fff}
.dash-list table{border-collapse:collapse;width:100%;font-size:.8rem}
.dash-list th,.dash-list td{border:1px solid #ddd;padding:3px 6px;text-align:left;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dash-list th{background:#f0f2f5;position:sticky;top:0}
.dash-list tr[data-i]{cursor:pointer}
.dash-list tr[data-i]:hover{background:#eef4fb}
.dash-meta{font-size:.78rem;color:#678;margin:4px 0 8px}
.dash-error{color:#a33;padding:16px}
@media print{body>*:not(.dash-overlay){display:none!important}.dash-overlay{position:static;background:none}.dash-dialog{max-height:none;width:auto;box-shadow:none}.dash-head .dash-btn,.dash-filters select{display:none}}
`;
    document.head.append(style);

    const btn = document.createElement("button");
    btn.id = "dash-open";
    btn.className = "dash-open";
    btn.type = "button";
    btn.hidden = true;
    btn.textContent = "📊";
    btn.addEventListener("click", open);
    const portalBtn = document.querySelector("#portal-open");
    if (portalBtn?.parentElement) portalBtn.insertAdjacentElement("afterend", btn);
    else {
      btn.style.cssText = "position:fixed;top:8px;right:8px;z-index:9999";
      document.body.append(btn);
    }

    const overlay = document.createElement("div");
    overlay.className = "dash-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="dash-dialog" role="dialog" aria-modal="true">
        <div class="dash-head">
          <h2 class="dash-title"></h2>
          <div class="dash-tabs"></div>
          <button class="dash-btn dash-csv" type="button"></button>
          <button class="dash-btn dash-print" type="button"></button>
          <button class="dash-btn dash-close" type="button"></button>
        </div>
        <div class="dash-body"></div>
      </div>`;
    document.body.append(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector(".dash-close").addEventListener("click", close);
    overlay.querySelector(".dash-csv").addEventListener("click", exportCsv);
    overlay.querySelector(".dash-print").addEventListener("click", () => window.print());
    document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });

    ui = {
      btn, overlay,
      title: overlay.querySelector(".dash-title"),
      tabs: overlay.querySelector(".dash-tabs"),
      body: overlay.querySelector(".dash-body"),
      csv: overlay.querySelector(".dash-csv"),
      print: overlay.querySelector(".dash-print"),
    };
    ui.csv.textContent = tr("exportCsv");
    ui.print.textContent = tr("print");
    ui.btn.title = tr("openTitle");
    ui.overlay.querySelector(".dash-close").textContent = tr("close");
    return ui;
  }

  const specs = () => getDashSpecs() || [];
  const currentSpec = () => specs()[specIndex] || specs()[0] || null;

  // layer= に対応するレイヤー id(タイトル完全一致 → 前方一致 → id一致)
  function resolveLayerId(spec) {
    const layers = listLayers();
    const want = String(spec?.layer || "");
    return layers.find(l => l.title === want)?.id
      ?? layers.find(l => l.title?.startsWith(want) && want)?.id
      ?? layers.find(l => l.id === want)?.id
      ?? want;
  }

  // 選択状態(sel)を地物へ適用する述語。値比較は文字列化して行う
  function matches(feature) {
    const props = feature?.properties || {};
    for (const [field, values] of sel) {
      if (!values.size) continue;
      const v = props[field];
      if (!values.has(v == null ? "" : String(v))) return false;
    }
    return true;
  }

  function filtered(features) { return (features || []).filter(matches); }

  // 絞り込み状態を地図の where= へ反映する(空なら解除)
  async function applyMapFilter(spec) {
    if (!setLayerWhere || !spec) return;
    try {
      await setLayerWhere(resolveLayerId(spec), buildWhere(sel));
    } catch (e) {
      console.warn("dashboard: 地図フィルタの適用に失敗しました", e);
    }
  }

  function toggleSel(field, value, exclusive = false) {
    let set = sel.get(field);
    if (!set) { set = new Set(); sel.set(field, set); }
    if (exclusive && !set.has(value)) set.clear();
    if (set.has(value)) set.delete(value);
    else set.add(value);
    if (!set.size) sel.delete(field);
  }

  function kpiCards(spec, rows) {
    const wrap = document.createElement("div");
    wrap.className = "dash-kpis";
    const defs = spec.kpis?.length ? spec.kpis : (spec.charts?.[0] ? ["count", `distinct:${spec.charts[0]}`] : ["count"]);
    for (const def of defs) {
      const [op, field, value] = String(def).split(":");
      let label = tr("count"), text = fmt(rows.length);
      if (op === "sum" && field) {
        label = `${field} ${tr("sum")}`;
        text = fmt(rows.reduce((a, f) => a + (num(f.properties?.[field]) ?? 0), 0));
      } else if (op === "avg" && field) {
        label = `${field} ${tr("avg")}`;
        const vals = rows.map(f => num(f.properties?.[field])).filter(v => v !== null);
        text = vals.length ? fmt(vals.reduce((a, b) => a + b, 0) / vals.length) : "-";
      } else if (op === "distinct" && field) {
        label = `${field} ${tr("distinct")}`;
        text = fmt(new Set(rows.map(f => String(f.properties?.[field] ?? ""))).size);
      } else if (op === "pct" && field) {
        label = `${field}=${value ?? ""} ${tr("ratio")}`;
        const hit = rows.filter(f => String(f.properties?.[field] ?? "") === String(value ?? "")).length;
        text = rows.length ? `${Math.round(hit / rows.length * 1000) / 10}%` : "-";
      }
      const card = document.createElement("div");
      card.className = "dash-kpi";
      const l = document.createElement("span"); l.className = "dash-kpi-label"; l.textContent = label;
      const v = document.createElement("span"); v.className = "dash-kpi-value"; v.textContent = text;
      card.append(l, v);
      wrap.append(card);
    }
    return wrap;
  }

  function filterBar(spec, allFeatures) {
    const bar = document.createElement("div");
    bar.className = "dash-filters";
    const label = document.createElement("span");
    label.textContent = `${tr("filter")}:`;
    label.style.fontSize = ".85rem";
    bar.append(label);
    for (const field of spec.filters || []) {
      const select = document.createElement("select");
      select.title = field;
      const distinct = [...new Set(allFeatures.map(f => String(f.properties?.[field] ?? "")))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const all = document.createElement("option");
      all.value = ""; all.textContent = `${field}: ${tr("filterAll")}`;
      select.append(all);
      for (const v of distinct) {
        const o = document.createElement("option");
        o.value = v; o.textContent = v === "" ? "（空）" : v;
        select.append(o);
      }
      select.addEventListener("change", () => {
        const set = sel.get(field);
        if (set) set.clear();
        if (select.value !== "") {
          if (!set) sel.set(field, new Set());
          sel.get(field).add(select.value);
        } else sel.delete(field);
        void applyMapFilter(currentSpec());
        renderBody();
      });
      if (sel.has(field)) select.value = [...sel.get(field)][0] ?? "";
      bar.append(select);
    }
    if (getLayerWhere(resolveLayerId(spec))) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "dash-btn dash-clear-map";
      clear.textContent = tr("mapFilterClear");
      clear.addEventListener("click", () => {
        sel.clear();
        void applyMapFilter(spec);
        renderBody();
      });
      bar.append(clear);
    }
    return bar;
  }

  function chartSection(spec, allFeatures, field) {
    const sec = document.createElement("div");
    sec.className = "dash-chart";
    const h = document.createElement("h4");
    h.textContent = field;
    sec.append(h);
    // 集計はドロップダウン等の他条件を含む絞り込み後の行で行い、
    // 自列の選択だけは除外する(選択中値以外の棒が消えないようにする)
    const saved = sel.get(field);
    sel.delete(field);
    const rows = filtered(allFeatures);
    if (saved) sel.set(field, saved);
    const stats = computeGroupStats(rows, field, null);
    const max = Math.max(1, ...stats.map(s => s.count));
    const active = sel.get(field);
    for (const s of stats) {
      const row = document.createElement("div");
      row.className = "dash-bar";
      if (active?.has(s.key)) row.classList.add("active");
      row.title = `${s.key === "" ? "（空）" : s.key}: ${s.count}`;
      const l = document.createElement("span"); l.className = "dash-bar-label"; l.textContent = s.key === "" ? "（空）" : s.key;
      const track = document.createElement("span"); track.className = "dash-bar-track";
      const fill = document.createElement("span"); fill.className = "dash-bar-fill"; fill.style.width = `${s.count / max * 100}%`;
      track.append(fill);
      const c = document.createElement("span"); c.className = "dash-bar-count"; c.textContent = s.count.toLocaleString();
      row.append(l, track, c);
      row.addEventListener("click", () => {
        toggleSel(field, s.key, true);
        void applyMapFilter(currentSpec());
        renderBody();
      });
      sec.append(row);
    }
    if (!stats.length) {
      const none = document.createElement("div");
      none.className = "dash-meta";
      none.textContent = tr("noFeatures");
      sec.append(none);
    }
    return sec;
  }

  function matrixSection(spec, allFeatures) {
    const { row: rField, col: cField } = spec.matrix || {};
    if (!rField || !cField) return null;
    const rows = filtered(allFeatures);
    const rSaved = sel.get(rField), cSaved = sel.get(cField);
    sel.delete(rField); sel.delete(cField);
    const base = filtered(allFeatures);
    if (rSaved) sel.set(rField, rSaved);
    if (cSaved) sel.set(cField, cSaved);
    void rows;
    const rKeys = new Map(), cKeys = new Map(), counts = new Map();
    for (const f of base) {
      const r = String(f.properties?.[rField] ?? ""), c = String(f.properties?.[cField] ?? "");
      rKeys.set(r, true); cKeys.set(c, true);
      counts.set(`${r}${c}`, (counts.get(`${r}${c}`) || 0) + 1);
    }
    const sortKeys = m => [...m.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const sec = document.createElement("div");
    sec.className = "dash-matrix";
    const table = document.createElement("table");
    const head = document.createElement("tr");
    const th0 = document.createElement("th"); th0.textContent = `${rField}＼${cField}`;
    head.append(th0);
    for (const c of sortKeys(cKeys)) { const th = document.createElement("th"); th.textContent = c === "" ? "（空）" : c; head.append(th); }
    table.append(head);
    const max = Math.max(1, ...counts.values());
    for (const r of sortKeys(rKeys)) {
      const trEl = document.createElement("tr");
      const th = document.createElement("th"); th.textContent = r === "" ? "（空）" : r;
      trEl.append(th);
      for (const c of sortKeys(cKeys)) {
        const td = document.createElement("td");
        const n = counts.get(`${r}${c}`) || 0;
        td.textContent = n || "";
        td.dataset.f = "1";
        td.style.background = n ? `rgba(74,144,217,${0.15 + 0.55 * n / max})` : "";
        if (sel.get(rField)?.has(r) && sel.get(cField)?.has(c)) td.classList.add("active");
        td.addEventListener("click", () => {
          toggleSel(rField, r, true);
          toggleSel(cField, c, true);
          void applyMapFilter(currentSpec());
          renderBody();
        });
        trEl.append(td);
      }
      table.append(trEl);
    }
    sec.append(table);
    return sec;
  }

  function listSection(spec, rows) {
    const sec = document.createElement("div");
    sec.className = "dash-list";
    const meta = document.createElement("div");
    meta.className = "dash-meta";
    const LIMIT = 300;
    meta.textContent = `${tr("list")}: ${rows.length.toLocaleString()} 件${rows.length > LIMIT ? " " + tr("listLimit", LIMIT) : ""}`;
    sec.append(meta);
    const attrs = [...new Set(rows.slice(0, LIMIT).flatMap(f => Object.keys(f.properties || {})))].filter(k => !/^__kasc/.test(k)).slice(0, 10);
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const a of attrs) { const th = document.createElement("th"); th.textContent = a; head.append(th); }
    table.append(head);
    rows.slice(0, LIMIT).forEach((f, i) => {
      const trEl = document.createElement("tr");
      trEl.dataset.i = String(i);
      for (const a of attrs) {
        const td = document.createElement("td");
        td.textContent = f.properties?.[a] ?? "";
        trEl.append(td);
      }
      if (focusFeature) trEl.addEventListener("click", () => focusFeature(f));
      table.append(trEl);
    });
    sec.append(table);
    return sec;
  }

  function renderBody() {
    if (!ui) return;
    const spec = currentSpec();
    ui.body.replaceChildren();
    if (!spec) return;
    const features = getFeatures(resolveLayerId(spec)) || [];
    if (!features.length && !listLayers().some(l => l.id === resolveLayerId(spec) || l.title === spec.layer)) {
      const err = document.createElement("div");
      err.className = "dash-error";
      err.textContent = `${tr("noLayer")}: ${spec.layer || "?"}`;
      ui.body.append(err);
      return;
    }
    const rows = filtered(features);
    ui.body.append(kpiCards(spec, rows));
    if (spec.filters?.length || getLayerWhere(resolveLayerId(spec))) ui.body.append(filterBar(spec, features));
    for (const field of spec.charts || []) ui.body.append(chartSection(spec, features, field));
    const mx = matrixSection(spec, features);
    if (mx) ui.body.append(mx);
    if (spec.detail !== false) ui.body.append(listSection(spec, rows));
    else {
      const meta = document.createElement("div");
      meta.className = "dash-meta";
      meta.textContent = tr("matched", { matched: rows.length, total: features.length });
      ui.body.insertBefore(meta, ui.body.firstChild);
    }
  }

  function update() {
    const el = ensureDom();
    const list = specs();
    el.btn.hidden = !list.length;
    el.btn.title = tr("openTitle");
    el.tabs.replaceChildren();
    if (specIndex >= list.length) specIndex = 0;
    if (list.length > 1) {
      list.forEach((s, i) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "dash-tab" + (i === specIndex ? " active" : "");
        tab.textContent = s.name || `${tr("open")} ${i + 1}`;
        tab.addEventListener("click", () => { specIndex = i; sel.clear(); update(); renderBody(); });
        el.tabs.append(tab);
      });
    }
    const spec = currentSpec();
    el.title.textContent = spec?.name || tr("open");
    el.csv.hidden = spec?.detail === false;
  }

  function open() {
    const el = ensureDom();
    if (!specs().length) return;
    update();
    renderBody();
    el.overlay.hidden = false;
  }

  function close() { if (ui) ui.overlay.hidden = true; }
  function isOpen() { return !!ui && !ui.overlay.hidden; }
  function updateButton() { ensureDom().btn.hidden = !specs().length; }

  function exportCsv() {
    const spec = currentSpec();
    if (!spec || spec.detail === false) return;
    const rows = filtered(getFeatures(resolveLayerId(spec)) || []);
    const attrs = [...new Set(rows.flatMap(f => Object.keys(f.properties || {})))].filter(k => !/^__kasc/.test(k));
    const esc = v => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [attrs.map(esc).join(","), ...rows.map(f => attrs.map(a => esc(f.properties?.[a])).join(","))];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${spec.name || "dashboard"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const api = { open, close, isOpen, update, updateButton };
  if (typeof window !== "undefined") window.kasugaiDashboard = { open, close, isOpen };
  return api;
}
