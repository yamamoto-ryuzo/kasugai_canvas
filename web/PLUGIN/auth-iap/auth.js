// Cloud IAP 版認証プラグイン（control=7）。
// IAP 配下では認証はインフラ側で完了しているためログイン画面は出さず、
// GET /api/auth でセッショントークンと .kasc を受け取る。
import { t } from "../../i18n.js";

function normalizeProjectId(id) {
  return String(id).toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function extractProjectId(url) {
  const m = /\/projects\/([^/]+)\/[^/?#]*\.kasc(?:[?#].*)?$/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

// .kasc 内の gs://<キー> / r2://<キー> を /api/data/<キー>?token=... に変換する
function rewriteKascText(text, token) {
  return text.replace(/(?:gs|r2):\/\/([^|\s]+)/g, (_, key) => {
    const path = key.split("/").map(encodeURIComponent).join("/");
    return `/api/data/${path}?token=${encodeURIComponent(token)}`;
  });
}

// 保存前の正規化: 書き換え後の URL を gs:// 形式に戻す
function restoreKascText(text) {
  return text.replace(/\/api\/data\/([^?\s|]+)\?token=[^|\s]*/g, (_, path) => {
    const key = path.split("/").map(decodeURIComponent).join("/");
    return `gs://${key}`;
  });
}

function patchFetch(kascMap, token) {
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    let url = input;
    if (typeof input !== "string") {
      if (input && typeof input.url === "string") url = input.url;
      else if (input && typeof input.href === "string") url = input.href;
      else url = String(input);
    }
    const projectId = typeof url === "string" ? extractProjectId(url) : null;
    if (projectId) {
      const key = normalizeProjectId(projectId);
      if (!Object.prototype.hasOwnProperty.call(kascMap, key)) {
        return new Response("", { status: 404, statusText: "Not in store" });
      }
      const text = token ? rewriteKascText(kascMap[key], token) : kascMap[key];
      return new Response(text, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return originalFetch(input, init);
  };
}

export async function authenticate() {
  // IAP 配下では /api/auth が IAP JWT を検証して kasugai トークンを発行する。
  // GCS バックエンドが無い場合は kasc が空で返り、静的 .kasc で起動する
  const res = await fetch("/api/auth", { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || t("auth.failed"));
  }
  const kasc = data.kasc && typeof data.kasc === "object" ? data.kasc : null;
  const hasStore = !!(kasc && data.token);
  if (hasStore) patchFetch(kasc, data.token);
  return {
    token: data.token || "",
    serverKasc: hasStore,
    user: { name: "iap", role: "cloudrun" },
    updateKasc: (projectId, text) => {
      if (kasc) kasc[normalizeProjectId(projectId)] = text;
    },
    restoreKasc: restoreKascText
  };
}
