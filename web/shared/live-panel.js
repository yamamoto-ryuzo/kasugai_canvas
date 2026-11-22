// QGIS Live 操縦パネル(shared/live-panel.js)
// live: 行でライブ連携が有効なとき、レイヤ一覧パネルの先頭へ
// 小さな操縦 UI を出す:
//   ・QGIS キャンバスへのカメラ追従(live: url|follow 相当の実行時トグル)
//   ・QGIS 側選択のハイライト表示 ON/OFF
//   ・QGIS 描画オーバーレイ(/live/render 画像をビュー追従で重ねる。
//     メッシュ等 Canvas が描けないレイヤも QGIS レンダリングで見える)
//   ・「QGIS からレイヤー追加」(GET /live/features で bbox 追従の
//     オンデマンド読み込み。対応フックを渡したエンジンのみ表示)
//
// hooks:
//   setRender(on)   QGIS 描画オーバーレイの切替実装(省略時は行を出さない)
//   addLayer(title) カタログ title のレイヤーをオンデマンド読み込みで追加
//   host            パネルを差し込む要素(既定 #layers-panel の先頭)
import {
  liveIsActive, liveIsFollowing, liveSetFollow, liveFollowAvailable,
  liveSelectionVisible, liveSetSelectionVisible, liveQueryLayers,
} from "./live.js";

let box = null;
let hooks = {};
let selEl = null;
let statusEl = null;
let followEl = null;
let selVisEl = null;
let layersLoaded = false;

const tr = (key, fallback) => {
  try { return (typeof window !== "undefined" && window.t) ? t(key) : fallback; }
  catch (_) { return fallback; }
};

// レイヤ一覧の .layer-row と同じ 1 行・省略表示のコンパクト行
function row(label, input) {
  const el = document.createElement("label");
  el.style.cssText =
    "display:flex;gap:5px;align-items:center;margin:2px 0;" +
    "font-size:0.8em;line-height:1.2;min-height:16px;";
  // .control-panel input{width:100%;min-height:30px;padding:5px 7px}
  // の包括ルールがチェックボックスを巨大化させるため個別に打ち消す
  input.style.cssText = "margin:0;flex:none;width:15px;min-height:15px;padding:0;";
  const span = document.createElement("span");
  span.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  span.textContent = label;
  el.append(input, span);
  return el;
}

export function mountLivePanel(host, h = {}) {
  hooks = h || {};
  host = host || document.querySelector("#layers-panel");
  if (!host || box) return;
  box = document.createElement("div");
  box.id = "live-panel";
  box.style.cssText =
    "margin:4px 0 6px;padding:5px 6px;border:1px solid #9cc3d8;" +
    "border-radius:6px;display:none;";

  const head = document.createElement("div");
  head.style.cssText =
    "font-weight:600;font-size:0.8em;margin-bottom:2px;color:#5a7d8f;";
  head.textContent = "QGIS Live";
  box.append(head);

  // QGIS キャンバスへのカメラ追従(エンジンが follow apply を持つ場合)
  if (liveFollowAvailable()) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "live-follow";
    cb.checked = liveIsFollowing();
    cb.addEventListener("change", () => liveSetFollow(cb.checked));
    followEl = cb;
    box.append(row(tr("live.follow", "QGISキャンバスへ追従"), cb));
  }

  // QGIS 側選択ハイライト
  {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "live-sel-visible";
    cb.checked = liveSelectionVisible();
    cb.addEventListener("change", () => liveSetSelectionVisible(cb.checked));
    selVisEl = cb;
    box.append(row(tr("live.showSelection", "QGISの選択を表示"), cb));
  }

  // QGIS 描画オーバーレイ(エンジンが setRender を供給する場合のみ)
  if (typeof hooks.setRender === "function") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "live-render";
    cb.checked = false;
    cb.addEventListener("change", () => hooks.setRender(cb.checked));
    box.append(row(tr("live.qgisRender", "QGIS描画で表示"), cb));
  }

  // QGIS レイヤーのオンデマンド追加(addLayer フックがある場合のみ)
  if (typeof hooks.addLayer === "function") {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:4px;margin-top:4px;align-items:center;";
    selEl = document.createElement("select");
    selEl.id = "live-layer-select";
    // select も control-panel 包括ルール(min-height:30px)を受けるため打ち消す
    selEl.style.cssText = "flex:1;min-width:0;font-size:0.8em;height:22px;min-height:22px;padding:1px 4px;";
    const btn = document.createElement("button");
    btn.id = "live-layer-add";
    btn.type = "button";
    btn.textContent = tr("live.addLayer", "追加");
    btn.style.cssText = "white-space:nowrap;font-size:0.8em;padding:2px 8px;";
    btn.addEventListener("click", async () => {
      const title = selEl?.value || "";
      if (!title) return;
      btn.disabled = true;
      setStatus(tr("live.loading", "読み込み中…"));
      try {
        const res = await hooks.addLayer(title);
        setStatus(`${tr("live.added", "追加しました")}${res?.added != null ? `: ${res.added}` : ""}`);
      } catch (e) {
        setStatus(`${tr("live.addFailed", "追加失敗")}: ${e?.message || e}`);
      } finally {
        btn.disabled = false;
      }
    });
    wrap.append(selEl, btn);
    box.append(wrap);
  }

  statusEl = document.createElement("p");
  statusEl.className = "hint";
  statusEl.style.cssText = "margin:2px 0 0;font-size:0.75em;";
  box.append(statusEl);

  host.prepend(box);
  syncLivePanel();
}

function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ""; }

// レイヤーカタログの取得(初回のみ・失敗時は次回表示で再試行)
async function populateLayers() {
  if (!selEl || layersLoaded) return;
  const data = await liveQueryLayers();
  if (!data?.ok) return;
  const items = (data.layers || []).filter(l => l.type === "vector");
  selEl.innerHTML = "";
  for (const l of items) {
    const opt = document.createElement("option");
    opt.value = l.title;
    opt.textContent = `${l.title}${Number.isFinite(l.count) ? ` (${l.count})` : ""}`;
    selEl.append(opt);
  }
  layersLoaded = true;
}

// live セッション状態に合わせて表示/非表示を切替える
// (configureLive 後に各エンジンが呼ぶ)
export function syncLivePanel() {
  if (!box) return;
  const active = liveIsActive();
  box.style.display = active ? "" : "none";
  // チェック状態はマウント時ではなくセッション確立のたびに実値へ同期する
  // (mount は kasc 適用前に走るため、| follow 読込後の liveIsFollowing()
  // とずれたまま表示される問題があった)
  if (followEl) followEl.checked = liveIsFollowing();
  if (selVisEl) selVisEl.checked = liveSelectionVisible();
  if (active && !layersLoaded) void populateLayers();
}
