// KASUGAI Canvas — プラグインパネル用レイヤ一覧ビュー（エンジン非依存）
//
// 別タブ式ユーザーパネル内で「自由なレイヤ表示」を作るための最小レンダラ。
// api.listLayers() の一覧を、グループ分け・チェック切替・フォーカス・行装飾
// フックつきで描画する。表示構造をまるごと差し替えたいプラグインは
// このモジュールを使わず独自描画してよい（listLayers/setLayerVisible/
// focusLayer/layers-changed イベントを直接利用）。
//
// 使い方（プラグイン内）:
//   const view = api.bindLayerView(panel, {
//     groupBy: l => l.group || "",            // 既定。非グループ化は ()=>""
//     sort: ls => [...ls].sort(...),          // 行の並べ替え
//     filter: l => l.type !== "tile",         // 表示する行の絞り込み
//     decorateRow: (row, l) => { ... },       // 行へのバッジ/ボタン追加
//     decorateGroup: (head, key, ls) => {},   // グループ見出しへの追加
//   });
//   // 解除は view.unbind()
//
// Blob URL で読み込むストレージプラグインからも使えるよう、
// api.bindLayerView / api.renderLayerView 経由で公開する。

import { splitKascTitle } from "./kasc.js";

const CSS_ID = "kasugai-layer-view-css";

// 最小限の既定スタイル。エンジン CSS に依存しないようこのモジュールが持つ
function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.lv-group { margin: 0 0 2px; }
.lv-group-title { display: flex; align-items: center; gap: 4px; font-weight: 600; font-size: 0.9em; padding: 2px 0; }
.lv-group-toggle { border: 0; background: transparent; cursor: pointer; padding: 0 2px; font-size: 0.9em; }
.lv-rows { margin-left: 8px; }
.lv-row { display: flex; align-items: center; gap: 5px; padding: 2px 2px; font-size: 0.9em; min-height: 24px; }
.lv-row:hover { background: rgba(0,0,0,.05); }
.lv-row input[type="checkbox"], .lv-row input[type="radio"] { flex: 0 0 auto; margin: 0; }
.lv-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-type { flex: 0 0 auto; font-size: 0.78em; color: #6a7d87; }
.lv-focus { flex: 0 0 auto; border: 0; background: transparent; cursor: pointer; padding: 0 3px; font-size: 1em; }
.lv-row.lv-off .lv-title { opacity: .55; }
.lv-empty { padding: 6px 4px; font-size: 0.85em; color: #6a7d87; }
`;
  document.head.append(style);
}

// layers: api.listLayers() の返り値（{id,title,group,exclusiveGroup,visible,type,...}）
export function renderLayerView(container, layers, opts = {}) {
  ensureCss();
  const api = opts.api || window.kasugaiApi || {};
  const groupBy = opts.groupBy || (l => l.group || "");
  let rows = [...(layers || [])];
  if (opts.filter) rows = rows.filter(opts.filter);
  if (opts.sort) rows = opts.sort(rows);

  const groups = new Map();
  for (const l of rows) {
    const key = String(groupBy(l) ?? "");
    if (!groups.has(key)) groups.set(key, { key, layers: [], exclusive: false });
    const g = groups.get(key);
    g.layers.push(l);
    if (l.exclusiveGroup) g.exclusive = true;
  }

  container.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "lv-empty";
    empty.textContent = opts.emptyText || "レイヤーがありません";
    container.append(empty);
    return;
  }

  const collapsed = opts.collapsed || new Set();

  for (const { key, layers: gl, exclusive } of groups.values()) {
    const section = document.createElement("section");
    section.className = "lv-group";
    const rowsBox = document.createElement("div");
    rowsBox.className = "lv-rows";

    if (key) {
      const head = document.createElement("div");
      head.className = "lv-group-title";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "lv-group-toggle";
      const isCollapsed = collapsed.has(key);
      toggle.textContent = isCollapsed ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!isCollapsed));
      toggle.addEventListener("click", () => {
        const nowCollapsed = !rowsBox.hidden;
        rowsBox.hidden = nowCollapsed;
        toggle.textContent = nowCollapsed ? "▸" : "▾";
        toggle.setAttribute("aria-expanded", String(!nowCollapsed));
        if (nowCollapsed) collapsed.add(key); else collapsed.delete(key);
      });
      const gcb = document.createElement("input");
      gcb.type = exclusive ? "radio" : "checkbox";
      gcb.name = `lv-grp-${key}`;
      gcb.checked = gl.some(l => l.visible);
      gcb.title = key;
      gcb.addEventListener("change", () => {
        if (exclusive) {
          const target = gcb.checked ? (gl.find(l => l.visible) || gl[0]) : null;
          for (const l of gl) api.setLayerVisible?.(l.id, l === target);
        } else {
          for (const l of gl) api.setLayerVisible?.(l.id, gcb.checked);
        }
      });
      const gname = document.createElement("span");
      gname.className = "lv-title";
      gname.textContent = key;
      head.append(toggle, gcb, gname);
      try { opts.decorateGroup?.(head, key, gl); } catch (e) { console.error("[layer-view] decorateGroup 失敗", e); }
      section.append(head);
      rowsBox.hidden = isCollapsed;
    }

    for (const l of gl) {
      const row = document.createElement("div");
      row.className = `lv-row${l.visible ? "" : " lv-off"}`;
      row.dataset.layerId = l.id || "";
      const cb = document.createElement("input");
      cb.type = exclusive ? "radio" : "checkbox";
      cb.name = `lv-excl-${key}`;
      cb.checked = !!l.visible;
      cb.addEventListener("change", () => {
        api.setLayerVisible?.(l.id, cb.checked);
        // 排他の OFF 戻し（radio は自動で外れない）
        if (exclusive && !cb.checked) { cb.checked = true; return; }
      });
      const title = document.createElement("span");
      title.className = "lv-title";
      title.textContent = splitKascTitle(l.title || "").title || l.title || l.id || "";
      title.title = l.title || "";
      row.append(cb, title);
      if (l.type) {
        const badge = document.createElement("small");
        badge.className = "lv-type";
        badge.textContent = l.type;
        row.append(badge);
      }
      try { opts.decorateRow?.(row, l); } catch (e) { console.error("[layer-view] decorateRow 失敗", e); }
      if (api.focusLayer) {
        const focus = document.createElement("button");
        focus.type = "button";
        focus.className = "lv-focus";
        focus.title = "フォーカス";
        focus.textContent = "◎";
        focus.addEventListener("click", () => void api.focusLayer(l.id));
        row.append(focus);
      }
      rowsBox.append(row);
    }
    section.append(rowsBox);
    container.append(section);
  }
}

// listLayers + layers-changed で自動再描画するバインド版。
// render は rAF で合流させる（layers-changed は描画系の再描画のたびに来る）
export function bindLayerView(container, api, opts = {}) {
  ensureCss();
  const collapsed = new Set();
  let scheduled = false;
  const render = () => {
    scheduled = false;
    renderLayerView(container, api.listLayers?.() || [], { api, collapsed, ...opts });
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  };
  render();
  api.on?.("layers-changed", schedule);
  api.on?.("project-changed", schedule);
  return {
    render,
    unbind() {
      api.off?.("layers-changed", schedule);
      api.off?.("project-changed", schedule);
    },
  };
}
