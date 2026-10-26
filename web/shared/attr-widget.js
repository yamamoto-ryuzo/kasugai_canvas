// Cesium 版「属性・値一覧」(#vector-attr-widget) のエンジン非依存版。
// 画面下部へドッキングする属性テーブル: レイヤ選択・全文検索・列ソート・
// 行クリックでの地物移動を提供する。DOM/CSS は本モジュールが注入するため、
// 各エンジンの app.js はアダプタを渡すだけで利用できる。
//
// createAttrWidget({
//   listLayers:   () => [{ id, title, entry }]   // 属性対象レイヤ(未読込含む・表示順)
//   getFeatures:  async (entry) => Feature[] | { features, partial? }
//   focusFeature: (feature) => void              // 行クリック時の地物移動
// }) → { open(layerId?), close(), refresh(), isOpen() }
// window.vectorAttrWidget = { open, close } も公開する(Cesium 版と同じ公開面)

const LABELS = {
  title: "属性・値一覧",
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
  count: (matched, attrs) => `${matched} 件 / ${attrs} 属性`,
  limitSuffix: count => ` （表示上限 ${count} 件）`,
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
.vector-attr-widget-filter { display: flex; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #e4ecef; }
#vector-attr-widget-layer { flex: 0 0 160px; min-width: 120px; min-height: 34px; padding: 6px 8px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 14px; background: #fff; }
#vector-attr-widget-search { flex: 1; min-width: 0; min-height: 34px; padding: 6px 8px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 14px; }
.vector-attr-widget-table-wrap { flex: 1; overflow: auto; }
.vector-attr-widget-table { width: auto; min-width: 100%; border-collapse: collapse; font-size: 13px; table-layout: auto; white-space: nowrap; }
.vector-attr-widget-thead th { position: sticky; top: 0; padding: 8px 14px; text-align: left; border-bottom: 1px solid #e4ecef; background: #f6f9fb; color: #52636d; font-weight: 700; font-size: 12px; cursor: pointer; user-select: none; white-space: nowrap; }
.vector-attr-widget-thead th:hover { background: #eef5f7; }
.vector-attr-widget-thead th.sorted { background: #e7f3f0; color: #31564f; }
#vector-attr-widget-list tr { border-bottom: 1px solid #e4ecef; }
#vector-attr-widget-list tr:hover { background: #f6f9fb; }
#vector-attr-widget-list td { padding: 7px 14px; vertical-align: top; }
.vector-attr-widget-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.vector-attr-widget-footer { padding: 8px 14px; border-top: 1px solid #e4ecef; color: #71818d; font-size: 12px; text-align: right; }
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

// ---- 属性タブ(クリックした地物の属性表示。Cesium 版 attr-panel 相当) ----

// 地物 properties → 属性テーブル行 [key, value] の配列。__kasc_* 内部値は除外
export function attrEntriesFromProps(props) {
  return Object.entries(props || {}).filter(([key]) => !INTERNAL_PROP_RE.test(key));
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
    // 属性行クリックでその地物へ移動(属性・値一覧の行クリックと同じ挙動)
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

export function createAttrWidget({ listLayers, getFeatures, focusFeature }) {
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
        <select id="vector-attr-widget-layer" class="vector-attr-widget-layer" title="${escapeHtml(LABELS.layerTitle)}"></select>
        <input id="vector-attr-widget-search" type="text" placeholder="${escapeHtml(LABELS.search)}" />
      </div>
      <div class="vector-attr-widget-table-wrap">
        <table class="vector-attr-widget-table">
          <thead id="vector-attr-widget-head" class="vector-attr-widget-thead"></thead>
          <tbody id="vector-attr-widget-list"></tbody>
        </table>
      </div>
      <div class="vector-attr-widget-footer">
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

  let rows = [];
  let attributes = [];
  let sort = { column: -1, order: 1 };
  let loading = false;
  let loadError = false;
  let partial = false;
  // 非同期の行構築が遅れて解決したときに新しい選択の結果を上書きしないための世代番号
  let requestSeq = 0;

  function currentLayerId() {
    return layerSelect.value || "";
  }

  function findLayer(id) {
    return (listLayers() || []).find(o => String(o.id) === String(id)) || null;
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
    const layer = findLayer(currentLayerId());
    if (!layer) return;
    loading = true;
    render(searchInput ? searchInput.value : "");
    try {
      const result = await getFeatures(layer.entry);
      if (!isCurrent()) return;
      const features = Array.isArray(result) ? result : (result?.features || []);
      partial = !Array.isArray(result) && !!result?.partial;
      const attrSet = new Set();
      for (const f of features) {
        for (const key of Object.keys(f?.properties || {})) {
          if (!INTERNAL_PROP_RE.test(key)) attrSet.add(key);
        }
      }
      attributes = [...attrSet].sort((a, b) => a.localeCompare(b));
      const seenRows = new Set();
      for (const f of features) {
        const props = f?.properties || {};
        const values = attributes.map(attr => propText(props[attr]));
        const rowKey = JSON.stringify(values);
        if (seenRows.has(rowKey)) continue;
        seenRows.add(rowKey);
        rows.push({ values, feature: f, flyable: !!f?.geometry });
      }
    } catch (e) {
      if (!isCurrent()) return;
      loadError = true;
      console.warn("属性一覧の読み込みに失敗しました:", e);
    } finally {
      if (isCurrent()) loading = false;
    }
  }

  function render(filter = "") {
    try {
      if (!list || !countEl || !titleEl) return;
      const query = String(filter).toLowerCase().trim();
      let matched = query ? rows.filter(row => row.values.some(val => String(val).toLowerCase().includes(query))) : [...rows];
      if (sort.column >= 0 && sort.column < attributes.length) {
        const col = sort.column;
        const order = sort.order;
        matched.sort((a, b) => {
          const cmp = String(a.values[col] || "").localeCompare(String(b.values[col] || ""), undefined, { numeric: true, sensitivity: "base" });
          return cmp * order;
        });
      }
      const displayRows = matched.slice(0, MAX_ROWS);
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
        countEl.textContent = LABELS.count(query ? 0 : rows.length, attributes.length) + (partial ? LABELS.viewportOnly : "");
        return;
      }
      list.innerHTML = displayRows.map(row => {
        const dataAttrs = row.flyable ? 'data-row="' + rows.indexOf(row) + '"' : '';
        const style = row.flyable ? 'style="cursor:pointer;"' : '';
        return '<tr class="vector-attr-widget-row" ' + dataAttrs + ' ' + style + ' title="' + (row.flyable ? escapeHtml(LABELS.clickToMove) : '') + '">' +
          row.values.map(val => '<td class="vector-attr-widget-cell" title="' + escapeHtml(val) + '">' + escapeHtml(val) + '</td>').join("") +
          '</tr>';
      }).join("");
      const suffix = (matched.length > displayRows.length) ? LABELS.limitSuffix(displayRows.length) : "";
      countEl.textContent = LABELS.count(matched.length, attributes.length) + suffix + (partial ? LABELS.viewportOnly : "");
    } catch (e) { console.error("vector attr widget render error", e); }
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

  closeBtn.addEventListener("click", close);
  searchInput.addEventListener("input", () => render(searchInput.value));
  searchInput.addEventListener("keydown", ev => { if (ev.key === "Enter") render(searchInput.value); });
  layerSelect.addEventListener("change", () => {
    try { void open(layerSelect.value); } catch (e) { console.error("vector attr layer change error", e); }
  });

  list.addEventListener("click", ev => {
    try {
      const tr = ev.target.closest("tr");
      if (!tr || !tr.hasAttribute("data-row")) return;
      const row = rows[Number(tr.getAttribute("data-row"))];
      if (row?.feature) focusFeature(row.feature);
    } catch (e) { console.error("vector attr row click error", e); }
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
