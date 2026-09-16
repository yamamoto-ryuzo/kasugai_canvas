import { showLoginForm } from "../../auth-login-form.js";

function normalizeProjectId(id) {
  return String(id).toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function extractProjectId(url) {
  const m = /\/projects\/([^/]+)\/[^/?#]*\.kasc(?:[?#].*)?$/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

function patchFetch(kascMap) {
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
      return new Response(kascMap[key], { status: 200, headers: { "Content-Type": "text/plain" } });
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
        patchFetch(data.kasc);
      }
      return {
        token: data.token || "cloudflare",
        user: { name: user, role: "cloudflare" },
        updateKasc: (projectId, text) => {
          if (data.kasc) data.kasc[normalizeProjectId(projectId)] = text;
        }
      };
    }
  });
}
