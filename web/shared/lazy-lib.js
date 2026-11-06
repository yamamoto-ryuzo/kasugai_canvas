// CDN ライブラリの遅延ロード（script/link タグ方式・ESM 非対応ライブラリ用）
// ESM 対応ライブラリは import() を直接使うこと。ここは UMD/グローバル登録型専用。
// 例: ensureScript("https://cdn.../leaflet-heat.js") → window.L.heatLayer

const _scriptPromises = new Map();
const _cssPromises = new Map();

export function loadScriptOnce(url) {
  if (!_scriptPromises.has(url)) {
    _scriptPromises.set(url, new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = url;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => { _scriptPromises.delete(url); reject(new Error(`script 読み込み失敗: ${url}`)); };
      document.head.append(el);
    }));
  }
  return _scriptPromises.get(url);
}

export function loadCssOnce(url) {
  if (!_cssPromises.has(url)) {
    _cssPromises.set(url, new Promise((resolve, reject) => {
      const el = document.createElement("link");
      el.rel = "stylesheet";
      el.href = url;
      el.onload = () => resolve();
      el.onerror = () => { _cssPromises.delete(url); reject(new Error(`css 読み込み失敗: ${url}`)); };
      document.head.append(el);
    }));
  }
  return _cssPromises.get(url);
}
