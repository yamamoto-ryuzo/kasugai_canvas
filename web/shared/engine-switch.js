// KASUGAI Canvas — エンジン切り替え共通UI
// 各エンジンの index.html に置いたコンテナ(既定 #engines)へエンジンリンクを描画する。
// リンクは親階層の index.html(?engine= リダイレクト)経由で遷移し、現在のクエリ
// (project=/kasc= 等)とハッシュ(ビュー状態)を引き継ぐため、プロジェクトとカメラ
// 位置を保ったままエンジンを切り替えられる。
// 各エンジンは <webroot>/<name>/ に同居するため、ルートは絶対パスではなく
// "../" で解決する(GitHub Pages 等のパスプレフィックス配信でも動く)。

export const ENGINE_IDS = ["cesium", "maplibre", "openlayers", "leaflet", "gsimaps"];

// ---- 切替時のレイヤ状態引継ぎ ----
// 切替元の表示状態(インスペクタの .kasc テキスト・テーマ選択・各レイヤの可視性)を
// localStorage へ一時保存し、切替先エンジンが起動時に一度だけ消費する。
// 同一オリジンの別タブ遷移にも効くよう sessionStorage ではなく localStorage とし、
// プロジェクト一致 + 鮮度(TTL) のときだけ適用して誤爆を防ぐ。
const SWITCH_STATE_KEY = "kasugai:engine-switch-state";
const SWITCH_STATE_TTL = 120000;

// 現在のエンジン状態を保存する。リンクが使われる直前に呼ぶ
export function storeEngineSwitchState() {
  try {
    const params = new URLSearchParams(window.location.search);
    const layers = window.kasugaiApi?.listLayers?.() || null;
    const state = {
      at: Date.now(),
      project: params.get("project") || null,
      kasc: params.get("kasc") || null,
      inspector: document.querySelector("#inspector-input")?.value ?? null,
      theme: document.querySelector("#theme-select")?.value || null,
      // 個別トグルは .kasc テキストへ書き戻されないため、実可視性を別途持つ
      vis: Array.isArray(layers) ? layers.map(l => ({ t: l.title, v: !!l.visible })) : null,
    };
    localStorage.setItem(SWITCH_STATE_KEY, JSON.stringify(state));
  } catch (_) { /* 保存失敗は切替自体を妨げない */ }
}

// 保存済み状態を取り出す。URL のプロジェクト指定が一致し鮮度内なら
// 状態を返して消去し、それ以外は null（読み取った時点で消去する）
export function consumeEngineSwitchState() {
  try {
    const raw = localStorage.getItem(SWITCH_STATE_KEY);
    if (!raw) return null;
    localStorage.removeItem(SWITCH_STATE_KEY);
    const st = JSON.parse(raw);
    if (!st || Date.now() - Number(st.at || 0) > SWITCH_STATE_TTL) return null;
    const params = new URLSearchParams(window.location.search);
    if ((st.kasc || null) !== (params.get("kasc") || null)) return null;
    if ((st.project || null) !== (params.get("project") || null)) return null;
    return st;
  } catch (_) { return null; }
}

// 現在のクエリとハッシュを引き継いだ切替先URL(相対)
export function engineSwitchUrl(engine, loc = window.location) {
  const params = new URLSearchParams(loc.search);
  params.set("engine", engine);
  return `../?${params.toString()}${loc.hash}`;
}

// コンテナへエンジンリンクを描画する。現在のエンジンは <b> で表示する
export function mountEngineSwitcher(container, currentEngine, engines = ENGINE_IDS) {
  const el = container || document.querySelector("#engines");
  if (!el) return null;
  const links = [];
  el.replaceChildren("engine: ");
  for (const name of engines) {
    if (name === currentEngine) {
      const b = document.createElement("b");
      b.textContent = name;
      el.append(b);
      continue;
    }
    const a = document.createElement("a");
    a.dataset.engine = name;
    a.href = engineSwitchUrl(name);
    a.textContent = name;
    links.push(a);
    el.append(a);
  }
  // ビュー状態のハッシュは移動ごとに replaceState で書き替わる(hashchange は
  // 発火しない)ため、リンク使用直前に最新のURLへ張り替える。
  // 同時にレイヤ状態を保存して切替先へ引き継ぐ
  const refresh = () => {
    storeEngineSwitchState();
    for (const a of links) a.href = engineSwitchUrl(a.dataset.engine);
  };
  for (const ev of ["pointerdown", "contextmenu", "keydown", "click"]) {
    el.addEventListener(ev, refresh, { capture: true });
  }
  return el;
}
