// ツールドック(#tools-dock)の UX 補助レイヤー。
// 地図対話モード中はドロップダウン(#tools-panel)を畳み、1行チップ(#tools-chip)
// だけを残して画面中央を開ける。チップはツール名＋ライブ結果(対応する
// .tool-result を MutationObserver でミラー)＋[パネルを開く][閉じる]。
// モード終了後も結果テキストが残っていれば「結果チップ」として維持し、
// 地図を見ながら数値を確認できる。ドック自体の開閉はレイヤパネルの
// #tools-open ボタンが担う(最小化時は画面上部に何も残らない)。
//
// cesium 版は app.js が、2D 版は geo-tools-2d.js の injectDock が
// initToolsDockUX(dock) を呼ぶ。対話モードの開始/終了は両エンジンの
// updateModeButtons() から notifyToolMode(mode) で通知する。

import { t } from "./i18n.js";

// mode → { label: ラベル i18n キー, result: ライブ結果要素セレクタ(null=結果表示なし) }
const MODE_INFO = {
  distance: { label: "tools.distance", result: "#tools-measure-result" },
  area: { label: "tools.area", result: "#tools-measure-result" },
  bearing: { label: "tools.bearing", result: "#tools-measure-result" },
  profile: { label: "tools.profile", result: "#tools-measure-result" },
  los: { label: "tools.los", result: "#tools-los-result" },
  vs: { label: "tools.viewshed", result: "#tools-los-result" },
  "sel-rect": { label: "tools.selRect", result: "#tools-sel-result" },
  "sel-poly": { label: "tools.selPoly", result: "#tools-sel-result" },
  "sel-circle": { label: "tools.selCircle", result: "#tools-sel-result" },
  "draw-point": { label: "tools.drawPoint", result: null },
  "draw-line": { label: "tools.drawLine", result: null },
  "draw-poly": { label: "tools.drawPoly", result: null },
  "draw-label": { label: "tools.drawLabel", result: null },
};

let resultObserver = null;
let dismissOnce = false; // チップの ✕ で終了した直後の結果維持を抑止

const getDock = () => document.getElementById("tools-dock");
const getDrop = dock => dock?.querySelector("#tools-panel") || null;

// ドックの折りたたみ状態を一元管理する。
// collapsed=true で #tools-bar 全体が消え(=最小化時は画面上部に何も残らない)。
// 開閉はレイヤパネルの #tools-open ボタンから行う。
export function setToolsDockCollapsed(dock, collapsed) {
  if (!dock) return;
  dock.classList.toggle("collapsed", collapsed);
  if (collapsed) {
    const drop = getDrop(dock);
    if (drop) drop.hidden = true;
  }
  // レイヤパネル側の起動ボタンも状態を反映(開=active)
  const openBtn = document.getElementById("tools-open");
  if (openBtn) openBtn.classList.toggle("active", !collapsed);
}

function mirrorResult(dock, sel) {
  resultObserver?.disconnect();
  resultObserver = null;
  const out = dock.querySelector("#tools-chip-result");
  const src = sel ? dock.querySelector(sel) : null;
  if (!out) return;
  if (!src) { out.textContent = ""; return; }
  const copy = () => {
    out.textContent = src.textContent || "";
    // 結果表示中に結果が空へクリアされたらチップも畳む
    const chip = out.closest("#tools-chip");
    if (chip && !chip.classList.contains("running") && !out.textContent.trim()) {
      chip.hidden = true;
      resultObserver?.disconnect();
      resultObserver = null;
    }
  };
  copy();
  resultObserver = new MutationObserver(copy);
  resultObserver.observe(src, { childList: true, characterData: true, subtree: true });
}

// 対話モードの開始/終了通知。mode=null で終了。
// 終了時に結果テキストが残っていればチップを結果表示として維持する。
export function notifyToolMode(mode) {
  const dock = getDock();
  const chip = dock?.querySelector("#tools-chip");
  if (!chip) return;
  if (mode) {
    dismissOnce = false;
    const info = MODE_INFO[mode] || {};
    const label = chip.querySelector("#tools-chip-label");
    label.dataset.i18n = info.label || "tools.measure";
    label.textContent = t(label.dataset.i18n);
    mirrorResult(dock, info.result);
    chip.classList.add("running");
    chip.hidden = false;
    const drop = getDrop(dock);
    if (drop) drop.hidden = true;
    return;
  }
  chip.classList.remove("running");
  const res = chip.querySelector("#tools-chip-result");
  if (dismissOnce || !res || !res.textContent.trim()) {
    chip.hidden = true;
    resultObserver?.disconnect();
    resultObserver = null;
  }
  dismissOnce = false;
}

// ドックへチップとバー最小化トグルを注入する（冪等）。
export function initToolsDockUX(dock) {
  if (!dock || dock.querySelector("#tools-chip")) return;
  const bar = dock.querySelector("#tools-bar");
  if (!bar) return;

  const chip = document.createElement("div");
  chip.id = "tools-chip";
  chip.hidden = true;
  chip.innerHTML =
    `<span class="chip-dot" aria-hidden="true"></span>` +
    `<span id="tools-chip-label"></span>` +
    `<span id="tools-chip-result" aria-live="polite"></span>` +
    `<button id="tools-chip-open" type="button" data-i18n-attr="title:tools.chipOpen;aria-label:tools.chipOpen" title="${t("tools.chipOpen")}" aria-label="${t("tools.chipOpen")}">⚙</button>` +
    `<button id="tools-chip-close" type="button" data-i18n-attr="title:tools.chipClose;aria-label:tools.chipClose" title="${t("tools.chipClose")}" aria-label="${t("tools.chipClose")}">✕</button>`;
  bar.insertAdjacentElement("afterend", chip);

  // ⚙: ドロップダウンを再展開（チップは残す＝結果を見ながら設定できる）
  chip.querySelector("#tools-chip-open").addEventListener("click", () => {
    const drop = getDrop(dock);
    if (drop) drop.hidden = false;
  });
  // ✕: モード中なら .tool-on ボタンの再クリックでモード解除→結果維持は抑止。
  // 結果表示状態ならそのままチップを畳む。
  chip.querySelector("#tools-chip-close").addEventListener("click", () => {
    dismissOnce = true;
    dock.querySelector(".tool-on")?.click();
    chip.hidden = true;
    resultObserver?.disconnect();
    resultObserver = null;
  });

  // レイヤパネルの起動ボタン(#tools-open): ドックの開閉をトグルする。
  // dock が初期 collapsed でもここでボタン状態が同期される。
  const openBtn = document.getElementById("tools-open");
  if (openBtn && !openBtn.dataset.toolsBound) {
    openBtn.dataset.toolsBound = "1";
    openBtn.addEventListener("click", () => {
      setToolsDockCollapsed(dock, !dock.classList.contains("collapsed"));
    });
  }
  setToolsDockCollapsed(dock, dock.classList.contains("collapsed"));
}
