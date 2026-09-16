import { showLoginForm } from "../../auth-login-form.js";

function normalizeProjectId(id) {
  return String(id).toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function extractProjectId(url) {
  const m = /\/projects\/([^/]+)\/[^/?#]*\.kasc(?:[?#].*)?$/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

// .kasc 内の r2://<キー> を /api/data/<キー>?token=... に変換する
// KV には r2:// 形式のまま保存し、配信時にだけ書き換える
function rewriteKascText(text, token) {
  return text.replace(/r2:\/\/([^|\s]+)/g, (_, key) => {
    const path = key.split("/").map(encodeURIComponent).join("/");
    return `/api/data/${path}?token=${encodeURIComponent(token)}`;
  });
}

// 保存前の正規化: 書き換え後の URL を r2:// 形式に戻す
function restoreKascText(text) {
  return text.replace(/\/api\/data\/([^?\s|]+)\?token=[^|\s]*/g, (_, path) => {
    const key = path.split("/").map(decodeURIComponent).join("/");
    return `r2://${key}`;
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
    const key = projectId ? normalizeProjectId(projectId) : null;
    if (key && Object.prototype.hasOwnProperty.call(kascMap, key)) {
      const text = token ? rewriteKascText(kascMap[key], token) : kascMap[key];
      return new Response(text, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return originalFetch(input, init);
  };
}

export async function authenticate() {
  return showLoginForm({
    onSubmit: async ({ user, pass }) => {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, pass })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "認証に失敗しました");
      }
      if (data.kasc && typeof data.kasc === "object") {
        patchFetch(data.kasc, data.token);
      }
      return {
        token: data.token || "cloudflare",
        user: { name: user, role: "cloudflare" },
        updateKasc: (projectId, text) => {
          if (data.kasc) data.kasc[normalizeProjectId(projectId)] = text;
        },
        restoreKasc: restoreKascText
      };
    }
  });
}
