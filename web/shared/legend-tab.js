// 凡例タブ共通UI: legend: 行の画像とレイヤ凡例(QML/既定スタイル)を
// チェックボックスの複数選択で切替表示する。
//   images: [{title, url}]                          … legend: 行の画像
//   layers: [{ref, title, entries:[{label, spec, hidden?, symbolName?}]}] … ベクター凡例
// swatchUrl(spec) → dataURL を各エンジンが渡す
// (Cesium は desc→canvas、2D 系は qmlLegendSwatchDataUrl)。
// state.selectedKeys(Set) に選択中を保持するため、レイヤ一覧の再描画・
// 遅延ロード完了・テーマ切替での再呼出しでも選択が維持される
// (画像は "img:<index>"、レイヤは ref 参照で照合)
// onToggleSymbol(ref, symbolName, visible) … 行チェックボックスで
// シンボル単位の表示切替。onToggleAll(ref, visible) … 全表示/全非表示。
// entries に symbolName を持つ行がある場合のみインタラクティブになる
// state.mode = "vertical"(選択凡例を縦積み) / "tabs"(タブ切替で1件表示)。
// タブ表示時の開いているタブは state.activeTab に保持する

// 全表示/全非表示の1ボタン用アイコン(目/目+斜線のインラインSVG)
const eyeIcon = visible =>
  `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${visible
    ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
    : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'}</svg>`;

export function renderLayerLegendPicker(container, { images = [], layers = [] } = {}, { swatchUrl, state = {}, ariaLabel = "", imageGroupLabel = "", layerGroupLabel = "", onToggleSymbol, onToggleAll, showAllLabel = "全表示", hideAllLabel = "全非表示", verticalLabel = "縦表示", tabsLabel = "タブ表示" } = {}) {
  if (!container) return;
  container.replaceChildren();
  const items = [];
  images.forEach((im, i) => items.push({ kind: "image", key: `img:${i}`, title: im.title || "", url: im.url }));
  for (const l of layers || []) {
    if (l.entries?.length) items.push({ kind: "layer", key: l.ref, ref: l.ref, title: l.title || "", entries: l.entries });
  }
  if (!items.length) return;
  // 複数選択の保持(旧 state.selected 単一キーからも移行)
  if (!(state.selectedKeys instanceof Set)) {
    state.selectedKeys = new Set();
    const first = state.selected != null && items.some(it => it.key === state.selected) ? state.selected : items[0].key;
    state.selectedKeys.add(first);
  }
  // 選択UIは details ドロップダウンに格納し、普段は選択中タイトルの
  // 1行バーのみ表示する(開閉状態は state.sourceOpen で保持)
  const dd = document.createElement("details");
  dd.className = "legend-source-dd";
  dd.open = !!state.sourceOpen;
  dd.addEventListener("toggle", () => { state.sourceOpen = dd.open; });
  const summary = document.createElement("summary");
  summary.className = "legend-source-summary";
  summary.style.cssText = "cursor:pointer;user-select:none;padding:2px 6px;border:1px solid #8884;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:4px 0";
  const list = document.createElement("div");
  list.className = "legend-source-list";
  list.style.cssText = "border:1px solid #8884;border-top:none;border-radius:0 0 4px 4px;max-height:11em;overflow:auto";
  list.setAttribute("role", "group");
  if (ariaLabel) list.setAttribute("aria-label", ariaLabel);
  const addItemRow = it => {
    // レイヤ一覧と同じ左詰めのシンプル行(チェック+1行テキスト)
    const lab = document.createElement("label");
    lab.className = "legend-source-row";
    lab.style.cssText = "display:flex;align-items:center;justify-content:flex-start;gap:6px;padding:1px 6px;cursor:pointer";
    // 地図で非表示(visible=false)のレイヤはグレーアウト
    if (it.ref?.visible === false) lab.style.opacity = ".45";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "legend-source-check";
    // .control-panel input{width:100%;min-height:30px} 等の波及を防ぎ
    // レイヤ行と同じネイティブサイズに固定する
    cb.style.cssText = "flex:none;margin:0;width:auto;height:auto;min-height:0";
    cb.checked = state.selectedKeys.has(it.key);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedKeys.add(it.key);
      else state.selectedKeys.delete(it.key);
      draw();
    });
    const span = document.createElement("span");
    span.style.cssText = "flex:1;min-width:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    span.textContent = it.title || "凡例";
    lab.append(cb, span);
    list.append(lab);
  };
  const imageItems = items.filter(it => it.kind === "image");
  const layerItems = items.filter(it => it.kind === "layer");
  const addGroup = (labelText, arr) => {
    if (!arr.length) return;
    // 画像とレイヤの両方があるときだけグループ見出しを出す
    if (labelText && imageItems.length && layerItems.length) {
      const g = document.createElement("div");
      g.className = "legend-source-group";
      g.style.cssText = "font-size:.85em;font-weight:600;padding:2px 6px 0;opacity:.75";
      g.textContent = labelText;
      list.append(g);
    }
    for (const it of arr) addItemRow(it);
  };
  addGroup(imageGroupLabel, imageItems);
  addGroup(layerGroupLabel, layerItems);
  dd.append(summary, list);
  // 表示モード切替(縦積み / タブ)。選択は state.mode に保持
  if (state.mode !== "tabs") state.mode = "vertical";
  const modeBar = document.createElement("div");
  modeBar.className = "legend-view-mode";
  modeBar.style.cssText = "display:flex;gap:6px;margin:2px 0 4px";
  const modeBtns = [];
  for (const [mode, txt] of [["vertical", verticalLabel], ["tabs", tabsLabel]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `legend-mode legend-mode-${mode}`;
    // .control-panel button{min-height:30px} 等の波及を防ぐコンパクト指定
    b.style.cssText = "min-height:0;padding:1px 8px;font-size:.85em;line-height:1.4";
    b.textContent = txt;
    b.addEventListener("click", () => { state.mode = mode; syncModeBtns(); draw(); });
    modeBtns.push([b, mode]);
    modeBar.append(b);
  }
  const syncModeBtns = () => {
    for (const [b, mode] of modeBtns) {
      const on = state.mode === mode;
      b.style.fontWeight = on ? "600" : "400";
      b.style.opacity = on ? "1" : ".65";
    }
  };
  syncModeBtns();
  const body = document.createElement("div");
  body.className = "legend-layer-entries";
  const drawItem = (block, it) => {
    const interactive = it.kind === "layer" && (it.entries || []).some(e => e.symbolName);
    // 各凡例が何由来か見出しで明示する
    // (レイヤ凡例はレイヤ一覧と同じタイトル、legend: 画像は行のタイトル)
    // シンボル切替可能なレイヤは見出し右端にON/OFFの1ボタンを並べる
    if (it.title || (interactive && onToggleAll)) {
      const head = document.createElement("div");
      head.className = "legend-layer-title";
      head.style.cssText = `display:flex;align-items:center;gap:6px;font-weight:600;margin:4px 0 2px;color:${it.ref?.visible === false ? "#888" : "#000"}`;
      const t = document.createElement("span");
      t.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      t.textContent = it.title;
      head.append(t);
      if (interactive && onToggleAll) {
        // 目アイコンのON/OFF1ボタン: 全表示中=目(押すと全非表示)、
        // 1つでも非表示=目+斜線(押すと全表示)。ラベルは title/aria で保持
        const anyHidden = (it.entries || []).some(e => e.symbolName && e.hidden);
        const b = document.createElement("button");
        b.type = "button";
        // エンジン側のボタン装飾(暗い背景等)を無効化しタブと同じ透過ボタンに
        b.style.cssText = "flex:none;min-height:0;padding:2px 4px;line-height:0;color:#333;background:transparent;border:1px solid #8884;border-radius:3px;cursor:pointer";
        b.innerHTML = eyeIcon(!anyHidden);
        const lbl = anyHidden ? showAllLabel : hideAllLabel;
        b.title = lbl;
        b.setAttribute("aria-label", lbl);
        b.addEventListener("click", () => onToggleAll(it.ref, anyHidden));
        head.append(b);
      }
      block.append(head);
    }
    if (it.kind === "image") {
      const img = document.createElement("img");
      img.className = "legend-image";
      img.src = it.url;
      img.alt = it.title;
      block.append(img);
      return;
    }
    const showChecks = interactive && !!onToggleSymbol;
    // 凡例タブは専用領域のため凡例行(スウォッチ+属性名)のみ 1.5 倍表示する
    // (見出し・タブ・ボタン・選択UIは通常サイズのまま)
    const rowsBox = document.createElement("div");
    rowsBox.className = "legend-rows";
    rowsBox.style.zoom = "1.5";
    for (const e of it.entries || []) {
      const row = document.createElement("div");
      row.className = "legend-row";
      if (e.hidden) row.style.opacity = ".45";
      if (showChecks) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "legend-row-check";
        // 行ボックスの 1.5 倍拡大を相殺しチェックだけ通常サイズに戻す
        cb.style.cssText = "flex:none;margin:0;width:auto;height:auto;min-height:0;zoom:.6667";
        cb.checked = !e.hidden;
        cb.disabled = !e.symbolName;
        cb.addEventListener("change", () => onToggleSymbol(it.ref, e.symbolName, cb.checked));
        row.append(cb);
      }
      let sw;
      if (e.spec) {
        sw = document.createElement("img");
        sw.alt = "";
        sw.src = swatchUrl(e.spec);
      } else {
        sw = document.createElement("span");
      }
      sw.className = `legend-swatch${e.spec ? "" : " legend-swatch-empty"}`;
      const lbl = document.createElement("span");
      lbl.className = "legend-label";
      lbl.textContent = e.label || "";
      row.append(sw, lbl);
      rowsBox.append(row);
    }
    block.append(rowsBox);
  };
  const draw = () => {
    body.replaceChildren();
    const sel = items.filter(it => state.selectedKeys.has(it.key));
    // ドロップダウンの見出しは固定ラベル(選択一覧は表示しない)
    summary.textContent = ariaLabel || "凡例";
    if (state.mode === "tabs") {
      if (!sel.length) return;
      if (!sel.some(it => it.key === state.activeTab)) state.activeTab = sel[0].key;
      const tabs = document.createElement("div");
      tabs.className = "legend-tabs";
      tabs.style.cssText = "display:flex;flex-wrap:wrap;gap:2px;border-bottom:1px solid #8884;margin-bottom:4px";
      for (const it of sel) {
        const tb = document.createElement("button");
        tb.type = "button";
        tb.className = "legend-tab";
        const active = it.key === state.activeTab;
        tb.style.cssText = `min-height:0;padding:1px 8px;font-size:.85em;line-height:1.4;border:1px solid #8884;border-bottom:none;border-radius:4px 4px 0 0;cursor:pointer;background:${active ? "#8882" : "transparent"};font-weight:${active ? "600" : "400"};color:${it.ref?.visible === false ? "#888" : "#000"}`;
        tb.textContent = it.title || "凡例";
        tb.addEventListener("click", () => { state.activeTab = it.key; draw(); });
        tabs.append(tb);
      }
      body.append(tabs);
      const block = document.createElement("div");
      block.className = "legend-block";
      drawItem(block, sel.find(it => it.key === state.activeTab));
      body.append(block);
      return;
    }
    // 縦表示: 選択済みソースを一覧の並び順で全て表示する
    for (const it of sel) {
      const block = document.createElement("div");
      block.className = "legend-block";
      drawItem(block, it);
      body.append(block);
    }
  };
  container.append(dd, modeBar, body);
  draw();
}
