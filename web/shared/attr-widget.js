// Cesium 版属性テーブル(#vector-attr-widget) のエンジン非依存版。
// 画面下部へドッキングする属性テーブル: レイヤ選択・全文検索・列ソート・
// 行クリックでの地物移動を提供する。DOM/CSS は本モジュールが注入するため、
// 各エンジンの app.js はアダプタを渡すだけで利用できる。
//
// createAttrWidget({
//   listLayers:   () => [{ id, title, entry }]   // 属性対象レイヤ(未読込含む・表示順)
//   getFeatures:  async (entry) => Feature[] | { features, partial? }
//   focusFeature: (feature) => void              // 行クリック時の地物移動
//   onCellEdit?:  ({ layer, feature, attr, value }) => void // セル編集時の任意フック
// }) → { open(layerId?), close(), refresh(), isOpen() }
// window.vectorAttrWidget = { open, close } も公開する(Cesium 版と同じ公開面)

import { computeGroupStats } from "./attr-stats.js";
import { rowsToXlsx, geometryToWKT } from "./export-formats.js";
import { filterGeoJsonByWhere } from "./where-eval.js";
import { t } from "./i18n.js";

const LABELS = {
  title: "属性テーブル",
  resizer: "上下にドラッグして高さを変更",
  close: "閉じる",
  layerTitle: "レイヤを選択",
  search: "属性または値で検索",
  selectLayer: "レイヤを選択してください",
  sort: "クリックで並び替え",
  noFeatures: "該当する地物がありません",
  loadFailed: "レイヤの読み込みに失敗しました",
  loading: "読み込み中…",
  clickToMove: "クリックで移動",
  viewportOnly: "（表示範囲内のみ）",
  exportCsv: "表示中の行をCSVで出力",
  exportTsv: "表示中の行をTSVで出力",
  exportXlsx: "表示中の行をExcel(xlsx)で出力",
  editHint: "セルをダブルクリックで編集（メモリ内のみ・再読込で元に戻ります）",
  count: (matched, attrs) => `${matched} 件 / ${attrs} 属性`,
  limitSuffix: count => ` （表示上限 ${count} 件）`,
  stats: "属性を集計（GROUP BY）",
  statsGroup: "集計キー",
  statsValue: "集計する数値属性",
  statsCountOnly: "（件数のみ）",
  statsGroups: (groups, rows) => `${groups} グループ / ${rows} 件`,
  colFilterField: "絞り込む属性",
  colFilterNone: "（属性フィルタなし）",
  colFilterValue: "条件値",
  colFilterContains: "含む",
  colFilterClear: "フィルタを解除",
  mapFilterBtn: "フィルター反映",
  mapFilter: "絞り込み条件を地図表示に適用/解除（表示のみ・データは変えません）",
  exportWkt: "ジオメトリをWKT列として出力（QGIS GEOMETRY=AS_WKT 相当）",
  sqlTitle: "SQL で絞り込み・レイヤフィルタ・新規レイヤ",
  statsCount: "count",
  sqlDlgTitle: "SQL フィルター",
  sqlDlgHint: "WHERE 式または SELECT 文(OGR SQL)。FROM にはレイヤー名・canvas_data/ パスが使えます",
  sqlDlgTest: "テスト",
  sqlDlgClear: "解除",
  sqlDlgView: "一覧を絞る",
  sqlDlgLayerFilter: "レイヤフィルタ",
  sqlDlgAddLayer: "新規レイヤ",
  sqlDlgPhWhere: "例: N03_003 LIKE '%市%' AND Shape_Area > 1000(SELECT 文も可)",
  sqlDlgPhQuery: "SELECT 文を入力",
  sqlDlgTesting: "実行中…",
  sqlDlgCount: count => `${count} 件`,
  sqlDlgNoSource: "レイヤーのデータを取得できません",
  sqlDlgNeedSelect: "sql:/ogrsql: レイヤーには SELECT 文を入力してください",
  sqlDlgSelectNeedsLayer: "SELECT 文はレイヤフィルタに使えません。「新規レイヤ」で追加してください",
  sqlDlgFailed: "適用に失敗しました",
};

// i18n 辞書が初期化済みなら訳文を使い、未初期化(キーがそのまま返る)場合は
// LABELS の既定文を使う。i18n を持たないエンジンでも壊れないための二段構え
const tr = (key, fallback, params) => {
  const v = t(key, params);
  return v === key ? fallback : v;
};

const MAX_ROWS = 1000;
// __kasc_* は QML スタイル/ラベルの描画用に properties へ焼き込んだ内部値のため属性表からは除外する
const INTERNAL_PROP_RE = /^__kasc/;

// 属性タブ(クリックした地物の属性表示)用の文言。Cesium 版 attr-panel と同じ
const ATTR_LABELS = {
  empty: "地物を選択すると属性を表示します。",
  noAttrs: "選択した地物に属性情報がありません。",
  pickedCount: count => `重なった地物 ${count} 件`,
  otherFeature: "その他の地物",
};

const CSS = `
.vector-attr-widget { display: none; position: fixed; left: 0; bottom: 0; width: 100%; height: 35%; min-width: 240px; max-width: 100vw; min-height: 120px; max-height: 90vh; z-index: 2200; overflow: hidden; box-shadow: 0 -4px 20px rgba(0,0,0,.2); font-family: system-ui, "Segoe UI", "Yu Gothic", sans-serif; }
.vector-attr-widget.visible { display: block; }
.vector-attr-widget-inner { width: 100%; height: 100%; display: flex; flex-direction: column; background: #fff; border-radius: 8px 8px 0 0; overflow: hidden; position: relative; }
.vector-attr-widget-resizer { position: absolute; top: -4px; left: 0; right: 0; height: 8px; cursor: ns-resize; z-index: 10; }
.vector-attr-widget-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #e4ecef; background: #f6f9fb; }
.vector-attr-widget-title { font-weight: 700; font-size: 15px; }
.vector-attr-widget-close { min-width: 28px; min-height: 28px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: #52636d; cursor: pointer; font-size: 20px; line-height: 1; }
.vector-attr-widget-close:hover { background: #e4ecef; }
.vector-attr-widget-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid #e4ecef; }
.vector-attr-group { display: inline-flex; align-items: center; gap: 4px; padding: 3px 5px; border-radius: 6px; }
.vector-attr-group.group-search { background: #a9d0f5; flex: 1 1 0; min-width: 200px; }
.vector-attr-group.group-filter { background: #f1d083; flex: 1 1 0; min-width: 300px; flex-wrap: wrap; }
.vector-attr-widget-filter button { flex: 0 0 auto; min-height: 26px; padding: 2px 8px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; color: #31564f; cursor: pointer; font-size: 12px; font-weight: 600; }
.vector-attr-widget-filter button:hover:not(:disabled) { background: #e7f3f0; }
.vector-attr-widget-filter button:disabled { opacity: .45; cursor: default; }
#vector-attr-sql.active { background: #d9ecf3; border-color: #7fb7cc; }
#vector-attr-map-filter.active { background: #d9f0df; border-color: #6fb887; }
.vector-attr-widget-wkt { display: inline-flex; align-items: center; gap: 3px; flex: 0 0 auto; font-size: 12px; color: #31564f; white-space: nowrap; }
#vector-attr-widget-layer { flex: 0 1 140px; min-width: 110px; min-height: 26px; padding: 2px 6px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 12px; background: #fff; }
#vector-attr-widget-search { flex: 2 1 160px; min-width: 100px; min-height: 26px; padding: 2px 8px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 13px; }
#vector-attr-widget-colfilter-field { flex: 0 1 150px; min-width: 100px; min-height: 26px; padding: 2px 6px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 12px; background: #fff; }
#vector-attr-widget-colfilter-op { flex: 0 0 64px; min-height: 26px; padding: 2px 6px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 12px; background: #fff; }
#vector-attr-widget-colfilter-value { flex: 1 1 100px; min-width: 70px; min-height: 26px; padding: 2px 6px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 12px; }
#vector-attr-widget-colfilter-clear { flex: 0 0 auto; min-height: 26px; padding: 0 8px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px; color: #52636d; }
#vector-attr-widget-colfilter-clear:hover { background: #eef5f7; }
#vector-attr-widget-group, #vector-attr-widget-value { flex: 0 1 120px; min-width: 90px; min-height: 26px; padding: 2px 6px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 12px; background: #fff; }
.vector-attr-widget-table-wrap { flex: 1; overflow: auto; }
.vector-attr-widget-table { width: auto; min-width: 100%; border-collapse: collapse; font-size: 13px; table-layout: auto; white-space: nowrap; }
.vector-attr-widget-thead th { position: sticky; top: 0; padding: 8px 14px; text-align: left; border-bottom: 1px solid #e4ecef; background: #f6f9fb; color: #52636d; font-weight: 700; font-size: 12px; cursor: pointer; user-select: none; white-space: nowrap; }
.vector-attr-widget-thead th:hover { background: #eef5f7; }
.vector-attr-widget-thead th.sorted { background: #e7f3f0; color: #31564f; }
#vector-attr-widget-list tr { border-bottom: 1px solid #e4ecef; }
#vector-attr-widget-list tr:hover { background: #f6f9fb; }
#vector-attr-widget-list td { padding: 7px 14px; vertical-align: top; }
.vector-attr-widget-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
#vector-attr-widget-list td.editing { padding: 2px 6px; }
.vector-attr-widget-edit { width: 100%; min-width: 80px; font: inherit; padding: 4px 6px; border: 1px solid #4a90a4; border-radius: 3px; box-sizing: border-box; }
#vector-attr-widget-list td.edited { background: #fff4d6; }
.vector-attr-widget-edit-hint { color: #9aabb5; font-size: 11px; margin-left: 4px; }
.vector-attr-widget-footer { padding: 8px 14px; border-top: 1px solid #e4ecef; color: #71818d; font-size: 12px; text-align: right; display: flex; align-items: center; gap: 6px; }
.vector-attr-widget-footer .vector-attr-widget-export { flex: 0 0 auto; min-height: 26px; padding: 2px 8px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; color: #31564f; font-size: 12px; cursor: pointer; }
.vector-attr-widget-footer .vector-attr-widget-export:hover { background: #eef5f7; }
.vector-attr-widget-footer #vector-attr-widget-count { margin-left: auto; }
.sql-dialog { position: fixed; inset: 0; z-index: 9600; display: flex; align-items: center; justify-content: center; background: rgba(20,32,40,.35); }
.sql-dialog[hidden] { display: none; }
.sql-dialog-inner { width: min(560px, 92vw); display: flex; flex-direction: column; background: #fff; border: 1px solid #cbd9de; border-radius: 10px; box-shadow: 0 16px 48px rgba(10,20,40,.35); overflow: hidden; }
.sql-dialog-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #e4ecef; background: #f6f9fb; font-weight: 700; font-size: 14px; }
#sql-dialog-layer { flex: 1; min-width: 0; margin-left: auto; min-height: 26px; padding: 2px 6px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 12px; background: #fff; }
#sql-dialog-close { min-width: 28px; min-height: 28px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: #52636d; cursor: pointer; font-size: 20px; line-height: 1; }
#sql-dialog-input { margin: 10px 14px 0; min-height: 72px; padding: 8px; border: 1px solid #cbd9de; border-radius: 6px; font-family: ui-monospace, Consolas, monospace; font-size: 13px; resize: vertical; }
.sql-dialog-hint { padding: 6px 14px 0; font-size: 11px; color: #71818d; }
.sql-dialog-status { min-height: 1.2em; padding: 4px 14px 0; font-size: 12px; color: #31564f; }
.sql-dialog-status.error { color: #b03030; }
.sql-dialog-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px 12px; }
.sql-dialog-actions-spacer { flex: 1; }
.sql-dialog-actions button { min-height: 28px; padding: 4px 12px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; color: #31564f; cursor: pointer; font-size: 12px; font-weight: 600; }
.sql-dialog-actions button:hover:not(:disabled) { background: #e7f3f0; }
.sql-dialog-actions button:disabled { opacity: .45; cursor: default; }
`;

let styleInjected = false;
function ensureStyle() {
  if (styleInjected || document.querySelector("#kasc-attr-widget-style")) return;
  styleInjected = true;
  const el = document.createElement("style");
  el.id = "kasc-attr-widget-style";
  el.textContent = CSS;
  document.head.append(el);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function propText(raw) {
  if (raw == null) return "";
  if (typeof raw === "object") {
    try { return JSON.stringify(raw); } catch (_) { return String(raw); }
  }
  return String(raw);
}

// 列フィルタの1セル判定(#110)。contains は大小文字を無視した部分一致。
// =/≠/</≦/>/≧ は両辺が数値に解釈できる時は数値比較、それ以外は文字列比較。
// Cesium 版(app.js 内蔵ウィジェット)もこの関数を共有する
export function matchAttrCellFilter(cellText, op, input) {
  const needle = String(input ?? "").trim();
  if (!needle) return true;
  const text = String(cellText ?? "");
  if (!op || op === "contains") return text.toLowerCase().includes(needle.toLowerCase());
  const num = Number(needle);
  const val = Number(text.trim());
  const numeric = text.trim() !== "" && !Number.isNaN(num) && !Number.isNaN(val);
  const cmp = numeric ? Math.sign(val - num) : text.localeCompare(needle, undefined, { numeric: true, sensitivity: "base" });
  switch (op) {
    case "eq": return cmp === 0;
    case "ne": return cmp !== 0;
    case "lt": return cmp < 0;
    case "le": return cmp <= 0;
    case "gt": return cmp > 0;
    case "ge": return cmp >= 0;
    default: return true;
  }
}

// ---- 属性タブ(クリックした地物の属性表示。Cesium 版 attr-panel 相当) ----

// 地物 properties → 属性テーブル行 [key, value] の配列。__kasc_* 内部値は除外。
// fieldMeta(.qml の <aliases>/<attributetableconfig>)があれば、非表示フィールド
// の除外・QML 定義順・別名表示を適用する(#56)
export function attrEntriesFromProps(props, fieldMeta = null) {
  let entries = Object.entries(props || {}).filter(([key]) => !INTERNAL_PROP_RE.test(key));
  if (!fieldMeta) return entries;
  if (fieldMeta.hidden?.size) entries = entries.filter(([k]) => !fieldMeta.hidden.has(k));
  if (fieldMeta.order?.length) {
    const idx = new Map(fieldMeta.order.map((n, i) => [n, i]));
    entries = entries.slice().sort((a, b) =>
      (idx.get(a[0]) ?? fieldMeta.order.length) - (idx.get(b[0]) ?? fieldMeta.order.length));
  }
  if (fieldMeta.alias) entries = entries.map(([k, v]) => [fieldMeta.alias[k] || k, v]);
  return entries;
}

function buildAttrTable(entries) {
  const table = document.createElement("table");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";
  table.style.fontSize = "12px";
  entries.forEach(([key, value]) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = key;
    th.style.textAlign = "left";
    th.style.padding = "3px 6px";
    th.style.borderBottom = "1px solid #cbd9de";
    const td = document.createElement("td");
    td.textContent = propText(value);
    td.style.padding = "3px 6px";
    td.style.borderBottom = "1px solid #cbd9de";
    tr.append(th, td);
    table.append(tr);
  });
  return table;
}

// 属性タブ(el)へクリックした地物の属性を描画する。
// records = [{ title?, entries: [[key, value], ...], layerId?, flyable?, feature? }]
//   layerId のある最初のレコードを el.dataset.layerId に記録し、
//   「選択中のレイヤ属性一覧」ボタンが開くウィジェットの対象レイヤとする。
//   複数件時はヘッダのみ表示し、クリックで属性を開閉する(Cesium 版と同じ挙動)。
// opts.onRecordClick(record) — flyable な地物の属性行クリック時(地物移動)
export function renderAttrContent(el, records, opts = {}) {
  if (!el) return;
  el.replaceChildren();
  if (!records || !records.length) {
    delete el.dataset.layerId;
    el.textContent = ATTR_LABELS.empty;
    return;
  }
  const list = records.filter(r => r && r.entries && r.entries.length);
  if (!list.length) {
    delete el.dataset.layerId;
    el.textContent = ATTR_LABELS.noAttrs;
    return;
  }
  const ctx = list.find(r => r.layerId != null);
  if (ctx) el.dataset.layerId = String(ctx.layerId);
  else delete el.dataset.layerId;

  const multiple = list.length > 1;
  if (multiple) {
    const count = document.createElement("div");
    count.className = "attr-picked-count";
    count.style.cssText = "margin:2px 0 6px;color:#71818d;font-size:12px;";
    count.textContent = ATTR_LABELS.pickedCount(list.length);
    el.append(count);
  }
  list.forEach((rec, index) => {
    const block = document.createElement("div");
    block.className = "attr-feature";
    const label = (multiple ? `${index + 1}. ` : "") + (rec.title || ATTR_LABELS.otherFeature);
    const header = document.createElement("div");
    header.className = "attr-feature-header";
    header.style.cssText = "display:flex;align-items:center;gap:4px;font-weight:600;font-size:12px;margin:6px 0 2px;" + (multiple ? "cursor:pointer;" : "");
    const marker = document.createElement("span");
    marker.className = "attr-feature-marker";
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    header.append(marker, labelEl);
    const table = buildAttrTable(rec.entries);
    // 属性行クリックでその地物へ移動(属性テーブルの行クリックと同じ挙動)
    if (rec.flyable && opts.onRecordClick) {
      table.querySelectorAll("tr").forEach(tr => {
        tr.style.cursor = "pointer";
        tr.title = LABELS.clickToMove;
        tr.addEventListener("click", () => opts.onRecordClick(rec));
      });
    }
    const setOpen = open => {
      table.hidden = !open;
      marker.textContent = open ? "▾" : "▸";
      header.setAttribute("aria-expanded", String(open));
    };
    if (multiple) {
      header.addEventListener("click", () => {
        const open = table.hidden;
        setOpen(open);
        // 展開した地物のレイヤーを属性一覧ボタンの対象にする
        if (open && rec.layerId != null) el.dataset.layerId = String(rec.layerId);
      });
    }
    setOpen(!multiple);
    block.append(header, table);
    el.append(block);
  });
}

// フィルタ行の補助ボタン(SQL・地図フィルタ)とエクスポートの拡張フック。
//   setMapFilter?:     async (layer, predicate|null) => void
//     「フィルター反映」。現在の絞り込み(列フィルタ AND 全文検索)を
//     地物単位で判定する述語 feature=>bool を渡す。null=解除。
//     未指定ならボタンを出さない
//   applyLayerFilter?: async (layer, value) => bool
//     SQL ダイアログの「レイヤフィルタ」。非クエリ系は where= 値、
//     sql:/ogrsql: は SELECT 文を渡す。未指定なら同ボタンを無効化
//   resolveLayer?:     async (name) => GeoJSON FC | null
//     SELECT 実行時の FROM 名 → 読み込み済みレイヤーの解決フック
//     (vectorHooks.resolveLayer と同じ)。未指定でも canvas_data/ パス解決は効く
//   getBaseUrl?:       () => string  SELECT 内の相対パス解決用
//   addLayer?:         async (title, query, {type}) => bool
//     「新規レイヤ」の追加経路。既定は window.kasugaiApi.addLayer
export function createAttrWidget({ listLayers, getFeatures, focusFeature, onCellEdit,
  setMapFilter = null, applyLayerFilter = null, resolveLayer = null,
  getBaseUrl = null, addLayer = null }) {
  ensureStyle();
  const widget = document.createElement("div");
  widget.id = "vector-attr-widget";
  widget.className = "vector-attr-widget";
  widget.innerHTML = `
    <div class="vector-attr-widget-inner">
      <div class="vector-attr-widget-resizer" title="${escapeHtml(LABELS.resizer)}"></div>
      <div class="vector-attr-widget-header">
        <span class="vector-attr-widget-title">${escapeHtml(LABELS.title)}</span>
        <button class="vector-attr-widget-close" type="button" aria-label="${escapeHtml(LABELS.close)}">×</button>
      </div>
      <div class="vector-attr-widget-filter">
        <span class="vector-attr-group group-search">
          <select id="vector-attr-widget-layer" class="vector-attr-widget-layer" title="${escapeHtml(LABELS.layerTitle)}"></select>
          <input id="vector-attr-widget-search" type="text" placeholder="${escapeHtml(LABELS.search)}" />
        </span>
        <span class="vector-attr-group group-filter">
          <button id="vector-attr-map-filter" type="button" title="${escapeHtml(tr("vattr.mapFilter", LABELS.mapFilter))}"${setMapFilter ? "" : " hidden"}>${escapeHtml(tr("vattr.mapFilterBtn", LABELS.mapFilterBtn))}</button>
          <select id="vector-attr-widget-colfilter-field" title="${escapeHtml(tr("vattr.colFilterField", LABELS.colFilterField))}">
            <option value="">${escapeHtml(tr("vattr.colFilterNone", LABELS.colFilterNone))}</option>
          </select>
          <select id="vector-attr-widget-colfilter-op">
            <option value="contains">${escapeHtml(tr("vattr.colFilterContains", LABELS.colFilterContains))}</option>
            <option value="eq">=</option>
            <option value="ne">≠</option>
            <option value="lt">&lt;</option>
            <option value="le">≦</option>
            <option value="gt">&gt;</option>
            <option value="ge">≧</option>
          </select>
          <input id="vector-attr-widget-colfilter-value" type="text" placeholder="${escapeHtml(tr("vattr.colFilterValue", LABELS.colFilterValue))}" />
          <button id="vector-attr-widget-colfilter-clear" type="button" title="${escapeHtml(tr("vattr.colFilterClear", LABELS.colFilterClear))}">×</button>
          <button id="vector-attr-widget-stats" type="button" title="${escapeHtml(LABELS.stats)}">Σ</button>
          <select id="vector-attr-widget-group" title="${escapeHtml(LABELS.statsGroup)}" hidden></select>
          <select id="vector-attr-widget-value" title="${escapeHtml(LABELS.statsValue)}" hidden></select>
          <button id="vector-attr-sql" type="button" title="${escapeHtml(tr("vattr.sqlTitle", LABELS.sqlTitle))}">SQL</button>
        </span>
      </div>
      <div class="vector-attr-widget-table-wrap">
        <table class="vector-attr-widget-table">
          <thead id="vector-attr-widget-head" class="vector-attr-widget-thead"></thead>
          <tbody id="vector-attr-widget-list"></tbody>
        </table>
      </div>
      <div class="vector-attr-widget-footer">
        <label class="vector-attr-widget-wkt" title="${escapeHtml(tr("vattr.exportWkt", LABELS.exportWkt))}"><input id="vector-attr-export-wkt" type="checkbox" />WKT</label>
        <button id="vector-attr-export-csv" class="vector-attr-widget-export" type="button" title="${escapeHtml(LABELS.exportCsv)}">CSV</button>
        <button id="vector-attr-export-tsv" class="vector-attr-widget-export" type="button" title="${escapeHtml(LABELS.exportTsv)}">TSV</button>
        <button id="vector-attr-export-xlsx" class="vector-attr-widget-export" type="button" title="${escapeHtml(LABELS.exportXlsx)}">XLSX</button>
        <span class="vector-attr-widget-edit-hint">${escapeHtml(LABELS.editHint)}</span>
        <span id="vector-attr-widget-count"></span>
      </div>
    </div>`;
  document.body.append(widget);

  const closeBtn = widget.querySelector(".vector-attr-widget-close");
  const resizer = widget.querySelector(".vector-attr-widget-resizer");
  const searchInput = widget.querySelector("#vector-attr-widget-search");
  const layerSelect = widget.querySelector("#vector-attr-widget-layer");
  const head = widget.querySelector("#vector-attr-widget-head");
  const list = widget.querySelector("#vector-attr-widget-list");
  const countEl = widget.querySelector("#vector-attr-widget-count");
  const titleEl = widget.querySelector(".vector-attr-widget-title");
  const colFilterField = widget.querySelector("#vector-attr-widget-colfilter-field");
  const colFilterOp = widget.querySelector("#vector-attr-widget-colfilter-op");
  const colFilterValue = widget.querySelector("#vector-attr-widget-colfilter-value");
  const colFilterClear = widget.querySelector("#vector-attr-widget-colfilter-clear");
  const exportWkt = widget.querySelector("#vector-attr-export-wkt");
  const sqlBtn = widget.querySelector("#vector-attr-sql");
  // SQL ダイアログの「一覧を絞る」適用状態。{layerId} — 別レイヤー選択・行再構築で解除
  let sqlView = null;
  // 列フィルタで選択中の属性表示名。レイヤ切替で同名属性が残れば条件を維持し、
  // 消えた場合は自動解除する(インデックスは列構成で変わるため名前で保持)
  let colFilterAttr = "";
  let colFilterAttrSig = null;

  let rows = [];
  let attributes = [];
  let attrKeys = [];
  let sort = { column: -1, order: 1 };
  let loading = false;
  let loadError = false;
  let partial = false;
  // Σ 集計モード: 集計キー/数値列の選択状態
  const statsBtn = widget.querySelector("#vector-attr-widget-stats");
  const statsGroup = widget.querySelector("#vector-attr-widget-group");
  const statsValue = widget.querySelector("#vector-attr-widget-value");
  let statsMode = false;
  function syncStatsControls() {
    if (statsGroup) statsGroup.hidden = !statsMode;
    if (statsValue) statsValue.hidden = !statsMode;
    if (statsBtn) statsBtn.classList.toggle("active", statsMode);
    if (!statsMode) return;
    if (statsGroup) {
      const prev = statsGroup.value;
      statsGroup.innerHTML = attributes.map(a => '<option>' + escapeHtml(a) + '</option>').join("");
      if (attributes.includes(prev)) statsGroup.value = prev;
    }
    if (statsValue) {
      const prev = statsValue.value;
      statsValue.innerHTML = '<option value="">' + escapeHtml(LABELS.statsCountOnly) + '</option>'
        + attributes.map(a => '<option>' + escapeHtml(a) + '</option>').join("");
      if (attributes.includes(prev)) statsValue.value = prev;
    }
  }
  // 非同期の行構築が遅れて解決したときに新しい選択の結果を上書きしないための世代番号
  let requestSeq = 0;

  function currentLayerId() {
    return layerSelect.value || "";
  }

  function findLayer(id) {
    return (listLayers() || []).find(o => String(o.id) === String(id)) || null;
  }

  // features → 行セット。fieldMeta(.qml の <aliases>/<attributetableconfig>)が
  // あれば、非表示列の除外・定義順・別名表示を適用する(#56)。
  // 属性値が完全一致する行は1行にまとめる(GeoJsonDataSource の
  // Multi 分割・重複地物対策)が、地図フィルタ/WKT 用に全地物を features[] へ保持する
  function rowsFromFeatures(features, meta = null) {
    const metaOrder = meta?.order || [];
    const metaOrderIdx = new Map(metaOrder.map((n, i) => [n, i]));
    const attrSet = new Set();
    for (const f of features) {
      for (const key of Object.keys(f?.properties || {})) {
        if (!INTERNAL_PROP_RE.test(key) && !meta?.hidden?.has(key)) attrSet.add(key);
      }
    }
    const rawAttrs = [...attrSet].sort((a, b) => {
      const ia = metaOrderIdx.get(a), ib = metaOrderIdx.get(b);
      if (ia != null || ib != null) return (ia ?? metaOrder.length) - (ib ?? metaOrder.length);
      return a.localeCompare(b);
    });
    // 表示名(別名)と実名を対応付けて保持する
    const out = { attrKeys: rawAttrs, attributes: rawAttrs.map(a => meta?.alias?.[a] || a), rows: [] };
    const seenRows = new Map();
    for (const f of features) {
      const props = f?.properties || {};
      const values = rawAttrs.map(attr => propText(props[attr]));
      const rowKey = JSON.stringify(values);
      const prev = seenRows.get(rowKey);
      if (prev) { prev.features.push(f); continue; }
      const rec = { values, feature: f, features: [f], flyable: !!f?.geometry };
      seenRows.set(rowKey, rec);
      out.rows.push(rec);
    }
    return out;
  }

  // レイヤの属性表示メタ。entry 直下 / entry.item(Cesium 規則) /
  // 読み込み済み QML(.fields)の順に探す
  function layerFieldMeta(layer) {
    const entry = layer?.entry;
    return entry?.fieldMeta || entry?.item?.fieldMeta || entry?.item?._qml?.fields || null;
  }

  async function buildRows() {
    const seq = ++requestSeq;
    const isCurrent = () => seq === requestSeq;
    rows = [];
    attributes = [];
    partial = false;
    sort = { column: -1, order: 1 };
    loading = false;
    loadError = false;
    attrKeys = [];
    // SQL ダイアログの「一覧を絞る」で置き換えた行は再構築で解除される
    sqlView = null;
    const layer = findLayer(currentLayerId());
    if (!layer) return;
    loading = true;
    render(searchInput ? searchInput.value : "");
    try {
      const result = await getFeatures(layer.entry);
      if (!isCurrent()) return;
      const features = Array.isArray(result) ? result : (result?.features || []);
      partial = !Array.isArray(result) && !!result?.partial;
      const built = rowsFromFeatures(features, layerFieldMeta(layer));
      attrKeys = built.attrKeys;
      attributes = built.attributes;
      rows = built.rows;
    } catch (e) {
      if (!isCurrent()) return;
      loadError = true;
      console.warn("属性一覧の読み込みに失敗しました:", e);
    } finally {
      if (isCurrent()) loading = false;
    }
  }

  // ---- 地図表示フィルタ(フィルター反映) ----
  // 一覧の絞り込み条件を地図上の表示にだけ適用する。where= とは別物で
  // .kasc・データを書き換えず、解除/再適用で即座に戻せる。
  // ON の間は render() 経由で条件変更のたびに再適用される(Cesium 版と同じ挙動)
  const mapFilterBtn = widget.querySelector("#vector-attr-map-filter");
  let mapFilterOn = false;
  let mapFilterLayer = null; // 現在フィルタを掛けているレイヤ(listLayers の選択肢)

  // 現在の絞り込み(列フィルタ AND 全文検索・ソート前)を地物単位で判定する
  // 述語を返す。行オブジェクトではなく地物の属性値から再評価するため、
  // 属性一致で1行にまとめられた地物や SQL「一覧を絞る」適用中も正しく効く
  // (Cesium 版が entity の properties を再評価するのと同じ方式)
  function viewFilterPredicate() {
    const query = String(searchInput ? searchInput.value : "").toLowerCase().trim();
    const colIdx = colFilterField && colFilterField.value !== "" ? Number(colFilterField.value) : -1;
    const op = colFilterOp ? colFilterOp.value : "contains";
    const input = colFilterValue ? colFilterValue.value : "";
    const needVal = colIdx >= 0 && String(input).trim();
    return f => {
      const props = f?.properties || {};
      if (needVal && !matchAttrCellFilter(propText(props[attrKeys[colIdx]]), op, input)) return false;
      if (query && !attrKeys.some(k => propText(props[k]).toLowerCase().includes(query))) return false;
      return true;
    };
  }

  async function applyMapFilterNow() {
    if (!setMapFilter) return;
    const layer = findLayer(currentLayerId());
    if (mapFilterLayer && mapFilterLayer !== layer) {
      try { await setMapFilter(mapFilterLayer, null); } catch (_) {}
      mapFilterLayer = null;
    }
    if (!layer) return;
    mapFilterLayer = layer;
    try { await setMapFilter(layer, viewFilterPredicate()); }
    catch (e) { console.warn("地図フィルタの適用に失敗しました:", e); }
  }

  async function restoreMapFilter() {
    if (mapFilterLayer && setMapFilter) {
      try { await setMapFilter(mapFilterLayer, null); } catch (_) {}
    }
    mapFilterLayer = null;
  }

  function setMapFilterOn(on) {
    mapFilterOn = !!on;
    if (mapFilterOn) void applyMapFilterNow();
    else void restoreMapFilter();
    syncMapFilterButton();
  }

  function syncMapFilterButton() {
    if (!mapFilterBtn || mapFilterBtn.hidden) return;
    const layer = findLayer(currentLayerId());
    mapFilterBtn.disabled = !layer || !attributes.length;
    mapFilterBtn.classList.toggle("active", mapFilterOn && !mapFilterBtn.disabled);
  }

  // ---- SQL ダイアログ: 属性一覧の高度なフィルター ----
  // QGIS 属性テーブルの「条件式でフィルタ」相当(Cesium 版の共有化)。
  // WHERE 式(OGR SQL)または SELECT 文を受け付け、3経路で適用する:
  //   一覧を絞る     … この一覧の行だけを絞る(表示のみ・地図は変えない)
  //   レイヤフィルタ … where= / クエリ書換え(描画も絞る・applyLayerFilter 経由)
  //   新規レイヤ     … ogrsql: レイヤーとして追加
  const sqlDialog = document.createElement("div");
  sqlDialog.id = "sql-dialog";
  sqlDialog.className = "sql-dialog";
  sqlDialog.hidden = true;
  sqlDialog.innerHTML = `
    <div class="sql-dialog-inner" role="dialog" aria-modal="true">
      <div class="sql-dialog-head">
        <span id="sql-dialog-title">${escapeHtml(tr("sqldlg.title", LABELS.sqlDlgTitle))}</span>
        <select id="sql-dialog-layer"></select>
        <button id="sql-dialog-close" type="button" aria-label="${escapeHtml(LABELS.close)}">×</button>
      </div>
      <textarea id="sql-dialog-input" rows="4" spellcheck="false"></textarea>
      <div class="sql-dialog-hint">${escapeHtml(tr("sqldlg.hint", LABELS.sqlDlgHint))}</div>
      <div id="sql-dialog-status" class="sql-dialog-status"></div>
      <div class="sql-dialog-actions">
        <button id="sql-dialog-test" type="button">${escapeHtml(tr("sqldlg.test", LABELS.sqlDlgTest))}</button>
        <span class="sql-dialog-actions-spacer"></span>
        <button id="sql-dialog-clear" type="button">${escapeHtml(tr("sqldlg.clear", LABELS.sqlDlgClear))}</button>
        <button id="sql-dialog-view" type="button">${escapeHtml(tr("sqldlg.view", LABELS.sqlDlgView))}</button>
        <button id="sql-dialog-layerfilter" type="button">${escapeHtml(tr("sqldlg.layerfilter", LABELS.sqlDlgLayerFilter))}</button>
        <button id="sql-dialog-addlayer" type="button">${escapeHtml(tr("sqldlg.addlayer", LABELS.sqlDlgAddLayer))}</button>
      </div>
    </div>`;
  document.body.append(sqlDialog);
  const sqlDialogLayer = sqlDialog.querySelector("#sql-dialog-layer");
  const sqlDialogInput = sqlDialog.querySelector("#sql-dialog-input");
  const sqlDialogStatus = sqlDialog.querySelector("#sql-dialog-status");
  const sqlDialogTestBtn = sqlDialog.querySelector("#sql-dialog-test");
  const sqlDialogClearBtn = sqlDialog.querySelector("#sql-dialog-clear");
  const sqlDialogViewBtn = sqlDialog.querySelector("#sql-dialog-view");
  const sqlDialogLayerFilterBtn = sqlDialog.querySelector("#sql-dialog-layerfilter");
  const sqlDialogAddLayerBtn = sqlDialog.querySelector("#sql-dialog-addlayer");

  // レイヤ選択肢 → .kasc アイテム(エンジン側 entry.item または entry 自体)
  const itemOf = layer => layer?.entry?.item || layer?.entry || null;
  const isSqlQueryItem = item => item && (item.type === "sql" || item.type === "ogrsql");
  const sqlDialogItem = () => itemOf(findLayer(sqlDialogLayer ? sqlDialogLayer.value : ""));

  function sqlDialogParsed() {
    const text = sqlDialogInput ? sqlDialogInput.value.trim().replace(/;+\s*$/, "") : "";
    if (!text) return { mode: "empty" };
    return /^\(?\s*select\b/i.test(text) ? { mode: "select", query: text } : { mode: "where", where: text };
  }
  function setSqlDialogStatus(text, isError = false) {
    if (!sqlDialogStatus) return;
    sqlDialogStatus.textContent = text || "";
    sqlDialogStatus.classList.toggle("error", !!isError);
  }
  function syncSqlDialogButtons() {
    const item = sqlDialogItem();
    const parsed = sqlDialogParsed();
    if (sqlDialogLayerFilterBtn) {
      // sql:/ogrsql: は SELECT 文のみ可(クエリ全文の置き換え)。それ以外は
      // WHERE 式を where= へ書く(空=フィルタ解除可)。SELECT 文は where= にできない
      sqlDialogLayerFilterBtn.disabled = !applyLayerFilter || !item
        || (isSqlQueryItem(item) ? parsed.mode !== "select" : parsed.mode === "select");
    }
    if (sqlDialogViewBtn) sqlDialogViewBtn.disabled = parsed.mode === "empty";
    if (sqlDialogAddLayerBtn) sqlDialogAddLayerBtn.disabled = parsed.mode === "empty";
    if (sqlDialogClearBtn) sqlDialogClearBtn.disabled = !sqlView;
  }
  function syncSqlButton() {
    if (sqlBtn) {
      sqlBtn.classList.toggle("active", !!(sqlView && sqlView.layerId === (layerSelect ? layerSelect.value : "")));
    }
  }
  function prefillSqlDialogInput() {
    const item = sqlDialogItem();
    const isSql = isSqlQueryItem(item);
    if (sqlDialogInput) {
      sqlDialogInput.value = isSql ? (item.url || item.query || "") : (item.opts?.where ?? item.where ?? "");
      sqlDialogInput.placeholder = tr(isSql ? "sqldlg.phQuery" : "sqldlg.phWhere", isSql ? LABELS.sqlDlgPhQuery : LABELS.sqlDlgPhWhere);
    }
    setSqlDialogStatus("");
    syncSqlDialogButtons();
  }
  function openSqlDialog(layerId) {
    const opts = listLayers() || [];
    if (sqlDialogLayer) {
      sqlDialogLayer.innerHTML = opts.map(o => '<option value="' + escapeHtml(String(o.id)) + '">' + escapeHtml(o.title || o.id) + '</option>').join("");
      sqlDialogLayer.value = opts.some(o => String(o.id) === String(layerId)) ? String(layerId) : (opts[0] ? String(opts[0].id) : "");
    }
    prefillSqlDialogInput();
    sqlDialog.hidden = false;
    if (sqlDialogInput) sqlDialogInput.focus();
  }
  function closeSqlDialog() { sqlDialog.hidden = true; }

  // 「一覧を絞る」用の評価ソース。描画用の保持データがあればそれを使い、
  // 無ければ getFeatures 経由(クエリ系は再クエリ、geojson: 等は読込)で取得
  async function sqlSourceFc(layer) {
    if (itemOf(layer)?._geojson?.features) return itemOf(layer)._geojson;
    const res = await getFeatures(layer.entry);
    const features = Array.isArray(res) ? res : (res?.features || []);
    return { type: "FeatureCollection", features };
  }
  // SELECT 文の実行。ogrsql: レイヤーと同じ解決経路(ブラウザ内 JS →
  // QGIS Live フォールバック)を shared/vector-load.js 経由で使う
  async function runSelectQuery(query) {
    const { loadVectorItem } = await import("./vector-load.js");
    const { geojson } = await loadVectorItem(
      { type: "ogrsql", title: "sqldialog", url: query, opts: {} },
      (getBaseUrl && getBaseUrl()) || "", null, { resolveLayer });
    return geojson;
  }
  async function runSqlDialogQuery(layer, parsed) {
    if (parsed.mode === "select") return runSelectQuery(parsed.query);
    const src = await sqlSourceFc(layer);
    if (!src) throw new Error(tr("sqldlg.noSource", LABELS.sqlDlgNoSource));
    return filterGeoJsonByWhere(src, parsed.where);
  }
  const addOgrSqlLayer = async (title, query) => {
    if (addLayer) return addLayer(title, query, { type: "ogrsql" });
    return window.kasugaiApi?.addLayer?.(title, query, { type: "ogrsql" });
  };

  sqlDialogTestBtn?.addEventListener("click", async () => {
    const layer = findLayer(sqlDialogLayer ? sqlDialogLayer.value : "");
    const parsed = sqlDialogParsed();
    if (!layer || parsed.mode === "empty") return;
    setSqlDialogStatus(tr("sqldlg.testing", LABELS.sqlDlgTesting));
    try {
      const fc = await runSqlDialogQuery(layer, parsed);
      const n = fc?.features?.length ?? 0;
      setSqlDialogStatus(tr("sqldlg.count", LABELS.sqlDlgCount(n), { count: n }));
    } catch (e) {
      setSqlDialogStatus(String(e?.message || e), true);
    }
  });
  sqlDialogViewBtn?.addEventListener("click", async () => {
    const layer = findLayer(sqlDialogLayer ? sqlDialogLayer.value : "");
    const parsed = sqlDialogParsed();
    if (!layer || parsed.mode === "empty") return;
    setSqlDialogStatus(tr("sqldlg.testing", LABELS.sqlDlgTesting));
    try {
      const fc = await runSqlDialogQuery(layer, parsed);
      const built = rowsFromFeatures(fc?.features || [], layerFieldMeta(layer));
      attrKeys = built.attrKeys;
      attributes = built.attributes;
      rows = built.rows;
      sort = { column: -1, order: 1 };
      sqlView = { layerId: String(layer.id) };
      if (layerSelect) layerSelect.value = String(layer.id);
      // 一覧が閉じていても結果を見せるため表示する
      widget.classList.add("visible");
      render(searchInput ? searchInput.value : "");
      syncSqlButton();
      closeSqlDialog();
    } catch (e) {
      setSqlDialogStatus(String(e?.message || e), true);
    }
  });
  sqlDialogLayerFilterBtn?.addEventListener("click", async () => {
    const layer = findLayer(sqlDialogLayer ? sqlDialogLayer.value : "");
    const item = itemOf(layer);
    const parsed = sqlDialogParsed();
    if (!layer || !item || !applyLayerFilter) return;
    if (isSqlQueryItem(item)) {
      if (parsed.mode === "where") { setSqlDialogStatus(tr("sqldlg.needSelect", LABELS.sqlDlgNeedSelect), true); return; }
      if (parsed.mode === "empty") return;
    } else if (parsed.mode === "select") {
      setSqlDialogStatus(tr("sqldlg.selectNeedsLayer", LABELS.sqlDlgSelectNeedsLayer), true);
      return;
    }
    const value = isSqlQueryItem(item) ? parsed.query : (parsed.where || "");
    try {
      if (await applyLayerFilter(layer, value)) closeSqlDialog();
      else setSqlDialogStatus(tr("sqldlg.failed", LABELS.sqlDlgFailed, { error: "" }));
    } catch (e) {
      setSqlDialogStatus(tr("sqldlg.failed", LABELS.sqlDlgFailed, { error: e?.message || e }), true);
    }
  });
  sqlDialogAddLayerBtn?.addEventListener("click", async () => {
    const layer = findLayer(sqlDialogLayer ? sqlDialogLayer.value : "");
    const item = itemOf(layer);
    const parsed = sqlDialogParsed();
    if (!item || parsed.mode === "empty") return;
    // WHERE 式のみの場合は選択中レイヤーを FROM にした SELECT 文を組み立てる
    const query = parsed.mode === "select" ? parsed.query
      : `SELECT * FROM "${String(item.title || layer?.title || "").replace(/"/g, '""')}" WHERE ${parsed.where}`;
    const title = `${String(item.title || layer?.title || "query").replace(/[|\r\n]+/g, "/")} (SQL)`;
    try {
      if (await addOgrSqlLayer(title, query)) closeSqlDialog();
      else setSqlDialogStatus(tr("sqldlg.failed", LABELS.sqlDlgFailed, { error: "" }));
    } catch (e) {
      setSqlDialogStatus(tr("sqldlg.failed", LABELS.sqlDlgFailed, { error: e?.message || e }), true);
    }
  });
  sqlDialogClearBtn?.addEventListener("click", async () => {
    sqlView = null;
    syncSqlButton();
    await buildRows();
    render(searchInput ? searchInput.value : "");
    syncSqlDialogButtons();
  });
  sqlDialogLayer?.addEventListener("change", prefillSqlDialogInput);
  sqlDialogInput?.addEventListener("input", syncSqlDialogButtons);
  sqlDialogInput?.addEventListener("keydown", ev => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); sqlDialogViewBtn?.click(); }
  });
  sqlDialog.querySelector("#sql-dialog-close")?.addEventListener("click", closeSqlDialog);
  sqlDialog.addEventListener("click", ev => { if (ev.target === sqlDialog) closeSqlDialog(); });
  sqlBtn?.addEventListener("click", () => openSqlDialog(layerSelect ? layerSelect.value : null));

  // 列フィルタの属性選択肢を現在の列構成に合わせて再構築する。
  // 選択中の属性が新しい列に無い場合はフィルタを自動解除する
  function syncColFilterOptions() {
    if (!colFilterField) return;
    // 再構築前の選択状態を引き継ぐ(change 未発火のプログラム的選択も拾う)
    const cur = (colFilterField.value !== "" && colFilterField.selectedOptions[0]?.textContent) || colFilterAttr;
    colFilterField.innerHTML = '<option value="">' + escapeHtml(tr("vattr.colFilterNone", LABELS.colFilterNone)) + '</option>'
      + attributes.map((a, i) => '<option value="' + i + '">' + escapeHtml(a) + '</option>').join("");
    const idx = cur ? attributes.indexOf(cur) : -1;
    if (idx >= 0) {
      colFilterField.value = String(idx);
      colFilterAttr = cur;
    } else {
      colFilterField.value = "";
      // 行再構築中(loading)は列が一時的に空になるだけなので選択を保持し、
      // 列構成が確定した時点で対象属性が無い場合のみ解除する
      if (attributes.length || !loading) colFilterAttr = "";
    }
  }

  // 列フィルタ適用時の行判定。属性未選択または値空なら無条件通過
  function rowPassesColFilter(row) {
    if (!colFilterField || colFilterField.value === "" || !colFilterValue || !colFilterValue.value.trim()) return true;
    return matchAttrCellFilter(row.values[Number(colFilterField.value)], colFilterOp ? colFilterOp.value : "contains", colFilterValue.value);
  }

  function render(filter = "") {
    try {
      if (!list || !countEl || !titleEl) return;
      const query = String(filter).toLowerCase().trim();
      // 列構成が変わった時だけ列フィルタの選択肢を再構築する
      // (毎回再構築すると描画と選択変更の競合で選択が失われ得る)
      const attrSig = attributes.join("");
      if (attrSig !== colFilterAttrSig) { colFilterAttrSig = attrSig; syncColFilterOptions(); }
      // 列フィルタ適用後に全文検索を AND でかける
      let matched = rows.filter(rowPassesColFilter);
      if (query) matched = matched.filter(row => row.values.some(val => String(val).toLowerCase().includes(query)));
      if (sort.column >= 0 && sort.column < attributes.length) {
        const col = sort.column;
        const order = sort.order;
        matched.sort((a, b) => {
          const cmp = String(a.values[col] || "").localeCompare(String(b.values[col] || ""), undefined, { numeric: true, sensitivity: "base" });
          return cmp * order;
        });
      }
      const displayRows = matched.slice(0, MAX_ROWS);
      syncMapFilterButton();
      syncSqlButton();
      // 地図表示フィルタが ON の間は、検索・列フィルタの変更をそのつど地図へ再適用する
      // (行再構築中は不一致状態で一時的に全消しになるのを避けて適用しない)
      if (mapFilterOn && !loading) void applyMapFilterNow();
      // Σ 集計モード: 集計キーで GROUP BY した行に差し替える(通常表は作らない)
      if (statsMode) {
        syncStatsControls();
        const groupField = statsGroup?.value || "";
        const valueField = statsValue?.value || "";
        const features = rows.map(row => ({
          properties: Object.fromEntries(attributes.map((a, i) => [a, row.values[i]])),
        }));
        const stats = groupField ? computeGroupStats(features, groupField, valueField) : [];
        const cols = [groupField || "?", "count", ...(valueField ? ["sum", "avg", "min", "max"] : [])];
        if (head) head.innerHTML = '<tr>' + cols.map(c => '<th>' + escapeHtml(c) + '</th>').join("") + '</tr>';
        const fmt = v => v == null ? "" : String(Math.round(v * 1000) / 1000);
        list.innerHTML = stats.length
          ? stats.map(g => '<tr>' + [g.key, g.count, ...(valueField ? [fmt(g.sum), fmt(g.avg), fmt(g.min), fmt(g.max)] : [])]
              .map(v => '<td class="vector-attr-widget-cell">' + escapeHtml(String(v)) + '</td>').join("") + '</tr>').join("")
          : '<tr><td style="padding:12px 14px;color:#71818d;">' + escapeHtml(LABELS.noFeatures) + '</td></tr>';
        countEl.textContent = LABELS.statsGroups(stats.length, rows.length);
        return;
      }
      const layer = findLayer(currentLayerId());
      titleEl.textContent = LABELS.title + (layer?.title ? " — " + layer.title : "");
      if (!attributes.length) {
        if (head) head.innerHTML = "";
        const msg = loading ? LABELS.loading : loadError ? LABELS.loadFailed : LABELS.selectLayer;
        list.innerHTML = '<tr><td style="padding:12px 14px;color:#71818d;">' + escapeHtml(msg) + '</td></tr>';
        countEl.textContent = LABELS.count(0, 0);
        return;
      }
      if (head) {
        head.innerHTML = '<tr>' + attributes.map((attr, idx) => {
          const active = sort.column === idx;
          const marker = active ? (sort.order > 0 ? ' ▲' : ' ▼') : '';
          return '<th data-idx="' + idx + '" title="' + escapeHtml(LABELS.sort) + '"' + (active ? ' class="sorted"' : '') + '>' + escapeHtml(attr) + '<span class="sort-marker">' + marker + '</span></th>';
        }).join("") + '</tr>';
      }
      if (!displayRows.length) {
        list.innerHTML = '<tr><td colspan="' + attributes.length + '" style="padding:12px 14px;color:#71818d;">' + escapeHtml(loading ? LABELS.loading : LABELS.noFeatures) + '</td></tr>';
        countEl.textContent = LABELS.count(matched.length, attributes.length) + (partial ? LABELS.viewportOnly : "");
        return;
      }
      list.innerHTML = displayRows.map(row => {
        const ri = rows.indexOf(row);
      const dataAttrs = 'data-ri="' + ri + '"' + (row.flyable ? ' data-row="' + ri + '"' : '');
        const style = row.flyable ? 'style="cursor:pointer;"' : '';
        return '<tr class="vector-attr-widget-row" ' + dataAttrs + ' ' + style + ' title="' + (row.flyable ? escapeHtml(LABELS.clickToMove) : '') + '">' +
          row.values.map(val => '<td class="vector-attr-widget-cell" title="' + escapeHtml(val) + '">' + escapeHtml(val) + '</td>').join("") +
          '</tr>';
      }).join("");
      const suffix = (matched.length > displayRows.length) ? LABELS.limitSuffix(displayRows.length) : "";
      countEl.textContent = LABELS.count(matched.length, attributes.length) + suffix + (partial ? LABELS.viewportOnly : "");
    } catch (e) { console.error("vector attr widget render error", e); }
  }

  // セル編集: ダブルクリックで input に差し替え、Enter/blur で確定・Esc で取消。
  // 書き込み先は feature.properties（全件読み込み系レイヤーはメモリ GeoJSON の
  // 実参照なので地物クリックの属性タブ等にも反映）と行キャッシュ values
  // （表の再描画と CSV/TSV 出力に反映）。クエリ系レイヤーの feature は実体
  // コピーのため編集はこの表と出力にのみ残る。ファイルへの書き戻しは行わない
  // （Canvas は .kasc 再生プレイヤー。編集・保存は QGIS 側の役割）。
  function beginCellEdit(td, row, ci, attr, feature) {
    const oldText = row.values[ci] == null ? "" : String(row.values[ci]);
    td.classList.add("editing");
    td.textContent = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "vector-attr-widget-edit";
    input.value = oldText;
    td.append(input);
    input.focus();
    input.select();
    let settled = false;
    const settle = commit => {
      if (settled) return;
      settled = true;
      td.classList.remove("editing");
      const text = commit ? input.value : oldText;
      td.textContent = text;
      td.title = text;
      if (!commit || text === oldText) return;
      row.values[ci] = text;
      // 数値だった属性は数値のまま書き戻す（型を壊さない最小限の変換）
      const prev = feature.properties[attr];
      feature.properties[attr] =
        typeof prev === "number" && text !== "" && !Number.isNaN(Number(text)) ? Number(text) : text;
      td.classList.add("edited");
      try { onCellEdit?.({ layer: findLayer(currentLayerId()), feature, attr, value: feature.properties[attr] }); }
      catch (e) { console.warn("vector attr onCellEdit hook failed", e); }
    };
    input.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Enter") settle(true);
      else if (ev.key === "Escape") settle(false);
    });
    input.addEventListener("blur", () => settle(true));
  }

  // 地物の代表点（属性一覧のエクスポート用。ジオメトリ包絡の中心）
  function featureCenter(f) {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    const walk = c => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === "number" && typeof c[1] === "number") {
        if (c[0] < west) west = c[0];
        if (c[0] > east) east = c[0];
        if (c[1] < south) south = c[1];
        if (c[1] > north) north = c[1];
        return;
      }
      for (const p of c) walk(p);
    };
    walk(f?.geometry?.coordinates);
    if (!Number.isFinite(west)) return { lng: null, lat: null };
    return { lng: (west + east) / 2, lat: (south + north) / 2 };
  }

  // 表示中の行セット（検索フィルタ＋ソート適用後・全件。表示上限では切らない）を返す
  function matchedRows() {
    const query = String(searchInput ? searchInput.value : "").toLowerCase().trim();
    let matched = rows.filter(rowPassesColFilter);
    if (query) matched = matched.filter(row => row.values.some(val => String(val).toLowerCase().includes(query)));
    if (sort.column >= 0 && sort.column < attributes.length) {
      const col = sort.column;
      const order = sort.order;
      matched.sort((a, b) => {
        const cmp = String(a.values[col] || "").localeCompare(String(b.values[col] || ""), undefined, { numeric: true, sensitivity: "base" });
        return cmp * order;
      });
    }
    return matched;
  }

  // 行のジオメトリを WKT 文字列にする(QGIS の CSV エクスポート GEOMETRY=AS_WKT 相当)。
  // 属性値一致でまとめられた複数地物は GeometryCollection として出力する
  function rowWkt(row) {
    const geoms = (row.features || []).map(f => f?.geometry).filter(Boolean);
    if (!geoms.length) return "";
    return geometryToWKT(geoms.length === 1 ? geoms[0] : { type: "GeometryCollection", geometries: geoms });
  }

  // エクスポート対象の表を現在の表示モードで返す。通常=検索・列フィルタ・ソート
  // 適用後の全行＋代表点 lon/lat、Σ 集計=表示中の GROUP BY 表。
  // WKT チェック ON 時のみ先頭へ QGIS 互換の WKT 列を付ける
  async function exportData() {
    const layer = findLayer(currentLayerId());
    const base = String(layer?.title || "attributes").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    if (statsMode) {
      const groupField = statsGroup?.value || "";
      const valueField = statsValue?.value || "";
      const features = rows.map(row => ({
        properties: Object.fromEntries(attributes.map((a, i) => [a, row.values[i]])),
      }));
      const stats = groupField ? computeGroupStats(features, groupField, valueField) : [];
      if (!stats.length) return null;
      const header = [groupField, tr("vattr.statsCount", LABELS.statsCount), ...(valueField ? ["sum", "avg", "min", "max"] : [])];
      const outRows = stats.map(g => [g.key, g.count, ...(valueField ? [g.sum, g.avg, g.min, g.max].map(v => v == null ? "" : v) : [])]);
      return { header, rows: outRows, base, suffix: "_stats" };
    }
    const matched = matchedRows();
    if (!attributes.length || !matched.length) return null;
    const wantWkt = !!exportWkt?.checked;
    const wkts = wantWkt ? matched.map(rowWkt) : [];
    const hasWkt = wkts.some(Boolean);
    const header = [...(hasWkt ? ["WKT"] : []), ...attributes, "lon", "lat"];
    const outRows = matched.map((row, i) => {
      const c = featureCenter(row.feature);
      return [...(hasWkt ? [wkts[i]] : []), ...row.values, c.lng ?? "", c.lat ?? ""];
    });
    return { header, rows: outRows, base, suffix: "" };
  }

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // 属性一覧のエクスポート（CSV/TSV・UTF-8 BOM 付きで Excel 文字化け対策）
  async function exportTable(delim) {
    const table = await exportData();
    if (!table) return;
    const esc = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const ext = delim === "\t" ? "tsv" : "csv";
    const lines = [table.header.map(esc).join(delim), ...table.rows.map(r => r.map(esc).join(delim))];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: `text/${ext};charset=utf-8` });
    downloadBlob(blob, `${table.base}${table.suffix}.${ext}`);
  }

  // 表示中の行を xlsx で出力（SheetJS は初回のみ CDN 遅延ロード #73）。
  // 生成中は件数表示を進行表示に流用して UI ブロックを可視化する
  async function exportXlsx() {
    const table = await exportData();
    if (!table) return;
    const cnt = widget.querySelector("#vector-attr-widget-count");
    const prevText = cnt ? cnt.textContent : "";
    try {
      if (cnt) cnt.textContent = "xlsx 生成中…";
      const { data, skipped } = await rowsToXlsx([{ name: table.base || "attributes", rows: [table.header, ...table.rows] }]);
      const blob = new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      downloadBlob(blob, `${table.base}${table.suffix}.xlsx`);
      if (skipped) alert(`${skipped} 行は上限超過のため出力されませんでした`);
    } catch (e) {
      alert("xlsx の生成に失敗しました: " + (e?.message || e));
    } finally {
      if (cnt) cnt.textContent = prevText;
    }
  }

  function updateLayerOptions(selectedId) {
    if (!layerSelect) return;
    const opts = listLayers() || [];
    let html = '<option value="">' + escapeHtml(LABELS.layerTitle) + '</option>';
    for (const o of opts) {
      html += '<option value="' + escapeHtml(String(o.id)) + '">' + escapeHtml(o.title || o.id) + '</option>';
    }
    layerSelect.innerHTML = html;
    const hasLayer = selectedId && opts.some(o => String(o.id) === String(selectedId));
    layerSelect.value = hasLayer ? String(selectedId) : "";
  }

  function isOpen() {
    return widget.classList.contains("visible");
  }

  async function open(layerId = null) {
    updateLayerOptions(layerId != null ? layerId : currentLayerId());
    await buildRows();
    render(searchInput ? searchInput.value : "");
    widget.classList.add("visible");
    if (searchInput) searchInput.focus();
  }

  function close() {
    widget.classList.remove("visible");
  }

  // レイヤ一覧・データの更新に追従させる。選択肢は常に再構築し、
  // 開いている時だけ行を再取得する
  function refresh() {
    updateLayerOptions(currentLayerId());
    if (!isOpen()) return;
    void buildRows().then(() => render(searchInput ? searchInput.value : ""));
  }

  widget.querySelector("#vector-attr-export-csv")?.addEventListener("click", () => { void exportTable(","); });
  widget.querySelector("#vector-attr-export-tsv")?.addEventListener("click", () => { void exportTable("\t"); });
  widget.querySelector("#vector-attr-export-xlsx")?.addEventListener("click", () => { void exportXlsx(); });
  mapFilterBtn?.addEventListener("click", () => setMapFilterOn(!mapFilterOn));

  closeBtn.addEventListener("click", close);
  searchInput.addEventListener("input", () => render(searchInput.value));
  searchInput.addEventListener("keydown", ev => { if (ev.key === "Enter") render(searchInput.value); });
  layerSelect.addEventListener("change", () => {
    try { void open(layerSelect.value); } catch (e) { console.error("vector attr layer change error", e); }
  });
  statsBtn?.addEventListener("click", () => {
    statsMode = !statsMode;
    syncStatsControls();
    render(searchInput ? searchInput.value : "");
  });
  statsGroup?.addEventListener("change", () => render(searchInput ? searchInput.value : ""));
  statsValue?.addEventListener("change", () => render(searchInput ? searchInput.value : ""));

  const rerender = () => render(searchInput ? searchInput.value : "");
  colFilterField?.addEventListener("change", () => {
    colFilterAttr = colFilterField.value === "" ? "" : (colFilterField.selectedOptions[0]?.textContent || "");
    rerender();
  });
  colFilterOp?.addEventListener("change", rerender);
  colFilterValue?.addEventListener("input", rerender);
  colFilterClear?.addEventListener("click", () => {
    if (colFilterField) colFilterField.value = "";
    colFilterAttr = "";
    if (colFilterValue) colFilterValue.value = "";
    rerender();
  });

  list.addEventListener("click", ev => {
    try {
      if (ev.detail > 1) return; // ダブルクリック(セル編集)の2回目クリックで移動しない
      const tr = ev.target.closest("tr");
      if (!tr || !tr.hasAttribute("data-row")) return;
      const row = rows[Number(tr.getAttribute("data-row"))];
      if (row?.feature) focusFeature(row.feature);
    } catch (e) { console.error("vector attr row click error", e); }
  });

  list.addEventListener("dblclick", ev => {
    try {
      const td = ev.target.closest("td.vector-attr-widget-cell");
      if (!td || statsMode || td.querySelector("input")) return;
      const tr = td.closest("tr");
      const row = rows[Number(tr?.getAttribute("data-ri"))];
      const ci = td.cellIndex;
      const attr = attrKeys[ci] ?? attributes[ci];
      const feature = row?.feature;
      if (attr == null || !feature?.properties || INTERNAL_PROP_RE.test(attr)) return;
      beginCellEdit(td, row, ci, attr, feature);
    } catch (e) { console.error("vector attr cell edit error", e); }
  });

  head.addEventListener("click", ev => {
    try {
      const th = ev.target.closest("th");
      if (!th || !th.hasAttribute("data-idx")) return;
      const idx = Number(th.getAttribute("data-idx"));
      if (sort.column === idx) sort.order *= -1;
      else sort = { column: idx, order: 1 };
      render(searchInput ? searchInput.value : "");
    } catch (e) { console.error("vector attr head click error", e); }
  });

  if (resizer) {
    let startY = 0;
    let startHeight = 0;
    let isResizing = false;
    const onMouseMove = ev => {
      if (!isResizing) return;
      ev.preventDefault();
      const nextHeight = startHeight + (startY - ev.clientY);
      const maxHeight = Math.min(window.innerHeight * 0.9, 1200);
      widget.style.height = Math.max(120, Math.min(maxHeight, nextHeight)) + "px";
    };
    const onMouseUp = () => {
      isResizing = false;
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (window.getSelection) window.getSelection().removeAllRanges();
    };
    resizer.addEventListener("mousedown", ev => {
      ev.preventDefault();
      isResizing = true;
      startY = ev.clientY;
      startHeight = widget.offsetHeight;
      document.body.style.cursor = "ns-resize";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });
  }

  const api = { open, close, refresh, isOpen };
  window.vectorAttrWidget = { open, close };
  return api;
}
