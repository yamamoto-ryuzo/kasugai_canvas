// KASUGAI Canvas — バックエンド検出と API ベース解決（エンジン横断で共有）
// 同一オリジン(アプリ版・Cloud Run・Workers)を優先し、バックエンドを持たない
// 静的配信(CDN ホスト版・file://)では起動中のローカルアプリ(127.0.0.1:8510)を
// バックエンドとして検出する。ローカルアプリは /api/*・/health で ACAO:*、
// /projects/* で許可オリジン限定の CORS+PNA に応答するため、https の
// ホスト版ページからもそのまま読み書きできる

// ローカルアプリの既定待受。QGIS geo_webview 連携や .kasc 関連付けと同じく
// 127.0.0.1:8510 固定で探す
export const LOCAL_BACKEND_ORIGIN = "http://127.0.0.1:8510";

let capabilities = null;
let resolved = false;
// /health が応答したか（capabilities を返さないバックエンドも「生存」扱い）
let alive = false;
// "" = 同一オリジン（相対パスでよい）。静的配信でローカルアプリを検出した
// 場合はそのオリジン（例: http://127.0.0.1:8510）
let base = "";
let detectPromise = null;

// 検出済みバックエンドのオリジン。"" の場合は同一オリジン
export function backendBaseUrl() { return base; }
// "/api/x" 等のバックエンドパスを実 URL へ解決する
export function backendUrl(path) { return `${base}${path}`; }
export function getBackendCapabilities() { return capabilities; }
export function isBackendCapabilitiesResolved() { return resolved; }
export function isBackendAlive() { return alive; }
export function hasBackendFeature(name) {
  return !!capabilities?.features?.includes(name);
}

export function setBackendCapabilities(caps, done = true, baseUrl = base) {
  capabilities = caps && caps.tier ? caps : null;
  resolved = done;
  base = typeof baseUrl === "string" ? baseUrl : base;
}

// サーバー提供の Maps API キーは未保存時のみ自動登録（BYO キー優先）
function adoptServerMapsKey(caps) {
  try {
    const mapsKey = caps?.google?.mapsApiKey;
    if (mapsKey && !localStorage.getItem("googleMapsApiKey")) {
      localStorage.setItem("googleMapsApiKey", mapsKey);
    }
  } catch (e) {}
}

async function fetchCapabilities(origin) {
  const caps = await fetch(`${origin}/api/capabilities`, { cache: "no-store" })
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  return caps && caps.tier ? caps : null;
}

// Chrome の Local Network Access 権限状態。公開サイト→ローカルアプリの
// fetch はこの権限が必要で、未対応ブラウザ（権限名を知らない）は null を
// 返して通常経路で試す
async function localNetworkPermission() {
  try {
    return await navigator.permissions?.query?.({ name: "local-network-access" }) ?? null;
  } catch (e) {
    return null;
  }
}

// ローカルアプリの /health を疎通し、KASUGAI 確認できればバックエンドとして
// 登録する。name==="kasugai_canvas" のみ受け入れる（8510 に無関係なサービス
// が居てもバックエンドと誤認しない。ok:true の寛容判定は同一オリジン限定）
async function probeLocalBackend(timeoutMs) {
  try {
    const res = await fetch(`${LOCAL_BACKEND_ORIGIN}/health`,
      { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    if (data?.name !== "kasugai_canvas") return false;
    alive = true;
    setBackendCapabilities(await fetchCapabilities(LOCAL_BACKEND_ORIGIN),
      true, LOCAL_BACKEND_ORIGIN);
    adoptServerMapsKey(capabilities);
    return true;
  } catch (e) { /* ローカルアプリ未起動 */ }
  return false;
}

// 静的配信環境でのフォールバック検出
async function detectLocalBackend() {
  const perm = await localNetworkPermission();
  if (perm?.state === "prompt") {
    // 権限プロンプトはローカルへの実リクエストで発火し、応答はユーザーの
    // 判断を待って保留される。ページ読込を止めないよう検出とは別に長めの
    // 疎通を投げ、許可されてバックエンドが見つかった場合だけ再読込して
    // ローカル連携（ブリッジ・/projects/*）を有効化する
    void (async () => {
      if (await probeLocalBackend(60000)) window.location.reload();
    })();
    return;
  }
  if (perm?.state === "denied") return; // ユーザーが拒否済み（再プロンプトされない）
  await probeLocalBackend(1500);
}

// /health + /api/capabilities によるバックエンド検出。
// スケールトゥゼロ環境のコールドスタートに備え、応答自体が無い場合は
// 同一オリジンを最大3回までリトライする。404 等の HTTP 応答は得られ次第
// 確定し、静的配信とみなしてローカルアプリをフォールバック検出する。
// 2回目以降の呼び出しは初回の Promise を共有する
export function detectBackend() {
  if (detectPromise) return detectPromise;
  detectPromise = (async () => {
    // file:// 等では同一オリジンにバックエンドが存在し得ないため即フォールバック
    if (location.protocol !== "http:" && location.protocol !== "https:") {
      await detectLocalBackend();
      resolved = true;
      return capabilities;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);
        const response = await fetch("/health", { signal: controller.signal, cache: "no-store" });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          alive = data?.name === "kasugai_canvas";
          // ローカルRustサーバー以外（Cloud Run版エージェント等）でも /health が
          // {ok:true} を返せば capabilities を取得する
          if (alive || data?.ok === true) {
            setBackendCapabilities(await fetchCapabilities(""), true, "");
            adoptServerMapsKey(capabilities);
          }
          resolved = true;
          return capabilities;
        }
        break; // 404 等: 同一オリジンにバックエンドなし → ローカルアプリを試す
      } catch {
        if (attempt >= 2) break;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    await detectLocalBackend();
    resolved = true;
    return capabilities;
  })();
  return detectPromise;
}
