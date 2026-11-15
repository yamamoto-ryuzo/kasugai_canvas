// 凡例タブ共通UI: legend: 行の画像とレイヤ凡例(QML/既定スタイル)を
// 1つのセレクタで切替表示する。
//   images: [{title, url}]                          … legend: 行の画像
//   layers: [{ref, title, entries:[{label, spec, hidden?}]}] … ベクター凡例
// swatchUrl(spec) → dataURL を各エンジンが渡す
// (Cesium は desc→canvas、2D 系は qmlLegendSwatchDataUrl)。
// state.selected に選択中を保持するため、レイヤ一覧の再描画・
// 遅延ロード完了・テーマ切替での再呼出しでも選択が維持される
// (画像は "img:<index>"、レイヤは ref 参照で照合)
export function renderLayerLegendPicker(container, { images = [], layers = [] } = {}, { swatchUrl, state = {}, ariaLabel = "", imageGroupLabel = "", layerGroupLabel = "" } = {}) {
  if (!container) return;
  container.replaceChildren();
  const items = [];
  images.forEach((im, i) => items.push({ kind: "image", key: `img:${i}`, title: im.title || "", url: im.url }));
  for (const l of layers || []) {
    if (l.entries?.length) items.push({ kind: "layer", key: l.ref, title: l.title || "", entries: l.entries });
  }
  if (!items.length) return;
  const selected = items.find(it => it.key === state.selected) || items[0];
  const sel = document.createElement("select");
  sel.className = "legend-layer-select";
  sel.style.cssText = "width:100%;margin:4px 0";
  if (ariaLabel) sel.setAttribute("aria-label", ariaLabel);
  const addOption = (parent, it) => {
    const opt = document.createElement("option");
    opt.textContent = it.title || "凡例";
    opt._legendItem = it;
    parent.append(opt);
  };
  const imageItems = items.filter(it => it.kind === "image");
  const layerItems = items.filter(it => it.kind === "layer");
  if (imageItems.length && layerItems.length) {
    const gImg = document.createElement("optgroup");
    gImg.label = imageGroupLabel;
    for (const it of imageItems) addOption(gImg, it);
    const gLay = document.createElement("optgroup");
    gLay.label = layerGroupLabel;
    for (const it of layerItems) addOption(gLay, it);
    sel.append(gImg, gLay);
  } else {
    for (const it of items) addOption(sel, it);
  }
  sel.selectedIndex = items.indexOf(selected);
  const body = document.createElement("div");
  body.className = "legend-layer-entries";
  const draw = () => {
    const it = sel.options[sel.selectedIndex]?._legendItem;
    if (!it) return;
    state.selected = it.key;
    body.replaceChildren();
    // 選択中の凡例が何由来か見出しで明示する
    // (レイヤ凡例はレイヤ一覧と同じタイトル、legend: 画像は行のタイトル)
    if (it.title) {
      const head = document.createElement("div");
      head.className = "legend-layer-title";
      head.style.cssText = "font-weight:600;margin:4px 0 2px";
      head.textContent = it.title;
      body.append(head);
    }
    if (it.kind === "image") {
      const img = document.createElement("img");
      img.className = "legend-image";
      img.src = it.url;
      img.alt = it.title;
      body.append(img);
      return;
    }
    for (const e of it.entries || []) {
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
