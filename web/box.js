// Box リモート MCP (https://mcp.box.com) 接続。
// OAuth 2.0 + PKCE をブラウザ内で完結し、アクセストークンを BYO として
// mcp.js の "box" 用 authProvider に供給する。
// Client ID は public client 扱いで client secret 不要。トークンは
// localStorage にのみ保存し、共有 .kasc やコードには書き込まない。
//
// 事前準備（利用者側）: Box Developer Console で Custom App (OAuth 2.0) を
// 作成し、redirect URI にこのアプリの URL（例: https://<host>/index.html）を
// 登録する。Enterprise 契約では Admin Console 側で MCP の有効化も必要。

import {
  mcpFetch,
  upsertMcpServer,
  getMcpServer,
  connectMcpServer,
  disconnectMcpServer,
  registerMcpAuthProvider,
} from "./mcp.js";

const BOX_MCP_URL = "https://mcp.box.com";
const BOX_AUTHORIZE_URL = "https://account.box.com/api/oauth2/authorize";
const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";
const BOX_SERVER_KEY = "box";

const KEY_CLIENT_ID = "boxClientId";
const KEY_ACCESS = "boxAccessToken";
const KEY_REFRESH = "boxRefreshToken";
const KEY_EXPIRES = "boxTokenExpiresAt";
// リダイレクト往復の間だけ保持する値は sessionStorage（タブ内限定・遷移後に残らない）
const KEY_VERIFIER = "boxPkceVerifier";
const KEY_STATE = "boxAuthState";
const KEY_RETURN = "boxReturnUrl";

let refreshPromise = null;

export function getBoxClientId() {
  try { return (localStorage.getItem(KEY_CLIENT_ID) || "").trim(); } catch (e) { return ""; }
}

export function setBoxClientId(value) {
  try { localStorage.setItem(KEY_CLIENT_ID, String(value || "").trim()); } catch (e) {}
}

export function boxConnected() {
  try { return !!localStorage.getItem(KEY_ACCESS); } catch (e) { return false; }
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function redirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

// Box 側の認可画面へ遷移する。戻り先は handleBoxRedirect() が処理する
export async function startBoxAuth() {
  const clientId = getBoxClientId();
  if (!clientId) throw new Error("Box Client ID が未設定です");
  const verifier = randomToken(48);
  const state = randomToken(24);
  try {
    sessionStorage.setItem(KEY_VERIFIER, verifier);
    sessionStorage.setItem(KEY_STATE, state);
    sessionStorage.setItem(KEY_RETURN, window.location.search + window.location.hash);
  } catch (e) {}
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri(),
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  window.location.assign(`${BOX_AUTHORIZE_URL}?${params}`);
}

async function tokenRequest(params) {
  const response = await mcpFetch(BOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error_description || data?.error || `HTTP ${response.status}`);
  }
  if (!data?.access_token) throw new Error("アクセストークンを取得できませんでした");
  storeTokens(data);
}

function storeTokens(data) {
  try {
    localStorage.setItem(KEY_ACCESS, data.access_token);
    if (data.refresh_token) localStorage.setItem(KEY_REFRESH, data.refresh_token);
    // 期限は実効値より60秒早めに切れたものとして扱う
    const margin = Math.max(Number(data.expires_in || 3600) - 60, 60);
    localStorage.setItem(KEY_EXPIRES, String(Date.now() + margin * 1000));
  } catch (e) {}
}

function clearTokens() {
  try {
    localStorage.removeItem(KEY_ACCESS);
    localStorage.removeItem(KEY_REFRESH);
    localStorage.removeItem(KEY_EXPIRES);
  } catch (e) {}
}

// 有効なアクセストークンを返す。期限切れ/forceRefresh 時は refresh_token で更新。
// 更新に失敗したらトークンを破棄して null を返す（再接続が必要）
export async function ensureBoxToken(forceRefresh = false) {
  let access = "";
  let refresh = "";
  let expiresAt = 0;
  try {
    access = localStorage.getItem(KEY_ACCESS) || "";
    refresh = localStorage.getItem(KEY_REFRESH) || "";
    expiresAt = Number(localStorage.getItem(KEY_EXPIRES) || "0");
  } catch (e) {}
  if (access && !forceRefresh && Date.now() < expiresAt) return access;
  if (!refresh) return access || null;
  // 同時リフレッシュを1本に束ねる
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        await tokenRequest({
          grant_type: "refresh_token",
          client_id: getBoxClientId(),
          refresh_token: refresh,
        });
      } catch (e) {
        clearTokens();
      } finally {
        refreshPromise = null;
      }
    })();
  }
  await refreshPromise;
  try { return localStorage.getItem(KEY_ACCESS) || null; } catch (e) { return null; }
}

// "box" サーバーをレジストリへ登録し authProvider を配線する（起動時に1回呼ぶ）
export function initBoxAuth() {
  registerMcpAuthProvider(BOX_SERVER_KEY, { getToken: ensureBoxToken });
}

// Box からのリダイレクト戻り（?code&state）を処理する。
// 戻り値: "none"（対象外）/ "done" / "error"
export async function handleBoxRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const errorParam = params.get("error");
  if (!code && !errorParam) return "none";

  const expectedState = sessionStorage.getItem(KEY_STATE) || "";
  const verifier = sessionStorage.getItem(KEY_VERIFIER) || "";
  const returnUrl = sessionStorage.getItem(KEY_RETURN) || "";
  sessionStorage.removeItem(KEY_STATE);
  sessionStorage.removeItem(KEY_VERIFIER);
  sessionStorage.removeItem(KEY_RETURN);

  // 認可パラメータは必ず履歴から消す（code の漏洩・再実行防止）
  const restore = returnUrl && !returnUrl.includes("code=") ? returnUrl : "";
  history.replaceState(null, "", `${window.location.pathname}${restore}`);

  try {
    if (errorParam) throw new Error(params.get("error_description") || errorParam);
    if (!state || state !== expectedState) throw new Error("OAuth state が一致しません");
    if (!verifier) throw new Error("PKCE verifier が見つかりません（再試行してください）");
    await tokenRequest({
      grant_type: "authorization_code",
      client_id: getBoxClientId(),
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    });
    upsertMcpServer({
      key: BOX_SERVER_KEY,
      name: "Box",
      url: BOX_MCP_URL,
      enabled: true,
    });
    await connectMcpServer(BOX_SERVER_KEY);
    return "done";
  } catch (error) {
    console.error("[box] OAuth 失敗:", error);
    return "error";
  }
}

export function disconnectBox() {
  clearTokens();
  disconnectMcpServer(BOX_SERVER_KEY);
  const server = getMcpServer(BOX_SERVER_KEY);
  if (server) upsertMcpServer({ ...server, enabled: false });
}
