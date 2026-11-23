// QGIS Live 接続バッジ(shared/live-panel.js)
// live: 行でライブ連携が有効なとき、レイヤ一覧パネルの先頭へ
// 接続状態のバッジを出す。操縦(追従/選択表示/レイヤ追加)は
// QGIS 側 geo_webview パネルの Live タブへ集約済みで、
// ここでは状態表示のみ行う:
//   ・緑●=/live/state 応答あり / 灰●=未応答
//   ・QGIS 側制御フラグ(追従/選択)の現在値
//   ・直近のレイヤ追加結果(QGIS Live タブの「Add to Canvas」処理)
import { liveIsActive, liveStatus, onLiveStatus } from "./live.js";

let box = null;
let dotEl = null;
let statusEl = null;
let subscribed = false;

const tr = (key, fallback) => {
  try { return (typeof window !== "undefined" && window.t) ? t(key) : fallback; }
  catch (_) { return fallback; }
};

export function mountLivePanel(host, _hooks = {}) {
  host = host || document.querySelector("#layers-panel");
  if (!host || box) return;
  box = document.createElement("div");
  box.id = "live-panel";
  box.style.cssText =
    "margin:4px 0 6px;padding:5px 6px;border:1px solid #9cc3d8;" +
    "border-radius:6px;display:none;";

  const head = document.createElement("div");
  head.style.cssText =
    "font-weight:600;font-size:0.8em;margin-bottom:2px;color:#5a7d8f;" +
    "display:flex;align-items:center;gap:5px;";
  dotEl = document.createElement("span");
  dotEl.textContent = "●";
  dotEl.style.cssText = "font-size:0.9em;color:#999;";
  const label = document.createElement("span");
  label.textContent = "QGIS Live";
  head.append(dotEl, label);
  box.append(head);

  statusEl = document.createElement("p");
  statusEl.className = "hint";
  statusEl.style.cssText = "margin:2px 0 0;font-size:0.75em;";
  box.append(statusEl);

  host.prepend(box);
  if (!subscribed) { onLiveStatus(() => syncLivePanel()); subscribed = true; }
  syncLivePanel();
}

// live セッション状態に合わせて表示/非表示を切替える
// (configureLive 後に各エンジンが呼ぶ。onLiveStatus 経由でも更新される)
export function syncLivePanel() {
  if (!box) return;
  const st = liveStatus();
  const active = liveIsActive();
  box.style.display = active ? "" : "none";
  if (!active) return;
  if (dotEl) dotEl.style.color = st.connected ? "#3aa655" : "#999";
  const parts = [st.connected
    ? tr("live.connected", "接続中")
    : tr("live.disconnected", "未接続")];
  if (st.follow) parts.push(tr("live.following", "追従中"));
  if (st.lastAdd) {
    parts.push(st.lastAdd.ok
      ? `${tr("live.added", "レイヤーを追加しました")}: ${st.lastAdd.title}`
      : `${tr("live.addFailed", "レイヤー追加に失敗")}: ${st.lastAdd.title}`);
  }
  if (statusEl) statusEl.textContent = parts.join(" · ");
}
