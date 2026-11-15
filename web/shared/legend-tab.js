// 凡例タブ共通UI: legend: 行の画像とは別に「レイヤを選んで凡例を表示」する
// セレクタ。layers は [{ref, title, entries:[{label, spec, hidden?}]}] の
// 正規化済み配列、swatchUrl(spec) → dataURL を各エンジンが渡す
// (Cesium は desc→canvas、2D 系は qmlLegendSwatchDataUrl)。
// state.selected に選択中の ref を保持するため、レイヤ一覧の再描画・
// 遅延ロード完了・テーマ切替での再呼出しでも選択が維持される
export function renderLayerLegendPicker(container, layers, { swatchUrl, state = {}, ariaLabel = "" } = {}) {
  if (!container) return;
  container.replaceChildren();
  const eligible = (layers || []).filter(l => l.entries?.length);
  if (!eligible.length) return;
  const selected = eligible.find(l => l.ref === state.selected) || eligible[0];
  const sel = document.createElement("select");
  sel.className = "legend-layer-select";
  sel.style.cssText = "width:100%;margin:4px 0";
  if (ariaLabel) sel.setAttribute("aria-label", ariaLabel);
  for (const l of eligible) {
    const opt = document.createElement("option");
    opt.textContent = l.title;
    sel.append(opt);
  }
  sel.selectedIndex = eligible.indexOf(selected);
  const body = document.createElement("div");
  body.className = "legend-layer-entries";
  const draw = () => {
    const layer = eligible[sel.selectedIndex];
    state.selected = layer?.ref;
    body.replaceChildren();
    for (const e of layer?.entries || []) {
      const row = document.createElement("div");
      row.className = "legend-row";
      if (e.hidden) row.style.opacity = ".45";
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
      body.append(row);
    }
  };
  sel.addEventListener("change", draw);
  container.append(sel, body);
  draw();
}
